// Dev tool: run a set of questions through the real answer path and record what every step did,
// so an evaluation (including the held-out ground-truth one) can say WHICH step failed:
//   understanding  things the question names (nicknames resolved), time reading
//   retrieval      the ranked results (fact / passage / record, file, scores)
//   lead fact      the instant answer's headline, evidence level, locked matches
//   writing        the written answer and its numbered sources (only with --write; uses the API)
//   timings        per step
//
// It never reads expected answers: it only records what the system did. Grading is a separate step.
// The first line of the output is a manifest (code fingerprint, index size, models) so a result
// can be tied to exactly the version that produced it. Freeze the code before a held-out run.
//
// Usage: npx tsx scripts/trace.ts <slug> <questions.json|.txt> <out.jsonl> [--write] [--as <principal id>]
//   questions.json: [{ "id"?: string, "q": string, "as"?: string }] or { "items": [...] }
//   questions.txt:  one question per line

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildContext } from '../src/answer/answer'
import { briefAnswer } from '../src/answer/brief'
import { answerModel, writeAnswer } from '../src/answer/write'
import { answersAllowed } from '../src/claude'
import { EMBEDDING_MODEL } from '../src/search/embed'
import type { SearchResult } from '../src/search/search'
import { pool } from '../src/workbench/server'

const args = process.argv.slice(2)
const [slug, input, out] = args
if (!slug || !input || !out) throw new Error('usage: trace.ts <slug> <questions.json|.txt> <out.jsonl> [--write] [--as <id>]')
const write = args.includes('--write')
const asAll = args.includes('--as') ? args[args.indexOf('--as') + 1] : null
if (write && !answersAllowed()) throw new Error('--write needs COMPANY_BRAIN_ALLOW_ANSWER_API=1')

const raw = readFileSync(input, 'utf8')
const parsed = input.endsWith('.json') ? (JSON.parse(raw) as unknown) : null
const items: { id: string; q: string; as: string | null }[] = (
  parsed ? ((Array.isArray(parsed) ? parsed : (parsed as { items: unknown[] }).items) as { id?: string; q?: string; question?: string; as?: string }[]) : raw.split('\n').filter((l) => l.trim()).map((q) => ({ q } as { id?: string; q?: string; question?: string; as?: string }))
).map((it, i) => ({ id: it.id ?? String(i + 1), q: (it.q ?? it.question ?? '').trim(), as: it.as ?? asAll }))

/** One hash over the code that decides answers, so two runs can be compared honestly. */
function fingerprint(): string {
  const h = createHash('sha256')
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|sql|json)$/.test(name)) h.update(p).update(readFileSync(p))
    }
  }
  for (const d of ['../src', '../../../apps/api/src', '../../../supabase/migrations']) walk(join(import.meta.dirname, d))
  return h.digest('hex').slice(0, 16)
}

const db = pool()
const tenant = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
if (!tenant) throw new Error(`unknown tenant ${slug}`)
const counts = (await db.query<{ doc_type: string; n: number }>(`select doc_type, count(*)::int n from public.search_documents where tenant_id = $1 group by 1`, [tenant.id])).rows

writeFileSync(
  out,
  `${JSON.stringify({
    manifest: {
      at: new Date().toISOString(),
      tenant: slug,
      code: fingerprint(),
      index: Object.fromEntries(counts.map((c) => [c.doc_type, c.n])),
      models: { embedding: EMBEDDING_MODEL, reranker: 'Xenova/ms-marco-MiniLM-L-6-v2', writer: write ? answerModel() : null },
      questions: items.length,
    },
  })}\n`,
)

let done = 0
for (const it of items) {
  const t0 = performance.now()
  const marks: Record<string, number> = {}
  let searched: SearchResult | undefined
  const brief = await briefAnswer({ sql: db, tenantId: tenant.id, as: it.as }, it.q, {
    onStep: (s) => s.status === 'done' && (marks[s.id] = Math.round(performance.now() - t0)),
    onSearch: (r) => (searched = r),
  })
  let written: { text: string; model: string; usage: unknown; ms: number; sources: unknown[] } | null = null
  if (write && !(!brief.headline && brief.evidence === 'weak')) {
    const pack = await buildContext(db, tenant.id, it.q, { as: it.as, prefetched: searched })
    const w = await writeAnswer(pack, () => {}, { restricted: !!brief.restricted?.best_is_locked })
    if (w) written = { ...w, sources: pack.sources.map((s) => ({ n: s.n, id: s.id, type: s.type, title: s.title, where: s.where, label: s.label })) }
  }
  const r = searched
  appendFileSync(
    out,
    `${JSON.stringify({
      id: it.id,
      q: it.q,
      as: it.as,
      understanding: r ? { entities: r.understood.entities.map((e) => ({ id: e.id, name: e.name, type: e.type, matched: e.matched })), time: r.understood.time ?? null, as_of: r.understood.asOf } : null,
      retrieval: r ? r.hits.map((h, i) => ({ rank: i + 1, id: h.id, doc_type: h.doc_type, kind: h.kind, title: h.title, path: h.path, is_current: h.is_current, valid_from: h.valid_from, valid_to: h.valid_to, ranks: h.ranks })) : [],
      lead: { headline: brief.headline, detail: brief.detail, evidence: brief.evidence, changed: brief.changed, conflicts: brief.conflicts, restricted: brief.restricted, sources: brief.sources.map((s) => ({ n: s.n, id: s.id, title: s.title, where: s.where, status: s.status })) },
      written,
      timings: { ...marks, total_ms: Math.round(performance.now() - t0), search_ms: r?.timings },
    })}\n`,
  )
  done++
  if (done % 10 === 0) console.log(`${done}/${items.length}`)
}
console.log(`traced ${done} questions → ${out}`)
await db.end()
