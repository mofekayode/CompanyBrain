// Dev tool: how robust is retrieval to the way people phrase things? For each target fact, five
// phrasings (doc, casual, typo, nickname, indirect). For every phrasing it reports whether a gold
// file reached the top 10, and if not, WHERE it was lost:
//   ranked low        it is in the final list, just below the top 10 (ordering: fusion/reranker)
//   dropped           a leg ranked it in its top 30 (so the reranker judged it) yet it fell out of
//                     the final 50 (the reranker or de-duplication threw it away)
//   found too deep    a leg only had it at 31-100 (retrieval too weak for this phrasing)
//   never found       neither keyword nor meaning search had it in their top 100 (vocabulary,
//                     chunking or embedding problem)
// A hit counts a passage from a gold file, or a fact/record whose evidence is in a gold file.
//
// Usage: npx tsx scripts/robustness-eval.ts <slug> [set.json] [--verbose] [--style casual] [--rewrite] [--no-rerank]
//   --rewrite uses the product path (needs COMPANY_BRAIN_ALLOW_ANSWER_API=1); --rewrite-claude/--rewrite-local are experiments

import { readFileSync } from 'node:fs'
import { search, type SearchHit } from '../src/search/search'
import { pool } from '../src/workbench/server'

const args = process.argv.slice(2)
const slug = args[0]
if (!slug) throw new Error('usage: robustness-eval.ts <slug> [set.json] [--verbose] [--style <s>]')
const file = args.find((a, i) => i > 0 && a.endsWith('.json')) ?? `../../evals/${slug}/robustness-dev-v1.json`
const verbose = args.includes('--verbose')
const only = args.includes('--style') ? args[args.indexOf('--style') + 1] : null
// Optional question rewriting with a local open model: search with the original plus the rewrite.
const rewriteModel = args.includes('--rewrite-local') ? args[args.indexOf('--rewrite-local') + 1] : null
const generator = rewriteModel ? await (await import('@huggingface/transformers')).pipeline('text-generation', rewriteModel, { dtype: 'q4' }) : null
let rewriteMs = 0
// Or with Claude (paid, through the approved answer API): reports tokens and cost.
const claudeModel = args.includes('--rewrite-claude') ? args[args.indexOf('--rewrite-claude') + 1] : null
const claude = claudeModel ? (await import('../src/claude')).claudeForAnswers() : null
const usage = { input: 0, output: 0 }
const REWRITE_SYSTEM =
  "You turn a question from someone at a company into a search query for that company's own documents (policies, contracts, procedures, emails, spreadsheets, insurance, vendor agreements). Use the company's own names for things you are given. Keep the question's specifics, and add the formal terms those documents would use for the situation described. Do not add the company's own name: every document has it. Never ask a question, never refuse, never explain: output only the query, under 20 words, no quotes."
// Grounding: the company's name and what the question's names mean, from our own name matcher.
const { loadDictionary, linkText } = await import('../src/search/linker')
let dict: Awaited<ReturnType<typeof loadDictionary>> | null = null
let company = ''
const grounding = async (q: string) => {
  dict ??= await loadDictionary(db, t)
  company ||= (await db.query<{ name: string }>(`select name from public.tenants where id = $1`, [t])).rows[0]?.name ?? slug
  const names = linkText(dict, q).map((e) => `"${e.matched}" = ${e.name} (${e.type})`)
  return `Company: ${company}.${names.length ? ` Names in the question: ${names.join('; ')}.` : ''}\nQuestion: ${q}`
}
async function rewrite(q: string): Promise<string> {
  if (claude) {
    const t0 = performance.now()
    const msg = await claude.messages.create({ model: claudeModel!, max_tokens: 60, system: REWRITE_SYSTEM, messages: [{ role: 'user', content: await grounding(q) }] })
    rewriteMs += performance.now() - t0
    usage.input += msg.usage.input_tokens
    usage.output += msg.usage.output_tokens
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
    if (verbose) console.log(`      rewrite: ${q} → ${text}`)
    return `${q}\n${text}`
  }
  if (!generator) return q
  const t0 = performance.now()
  const out = await generator(
    [
      { role: 'system', content: 'Rewrite the question as a short search query using the words a company document would use (policy, insurance, procedure, vendor, contract terms). Output only the query, under 12 words.' },
      { role: 'user', content: q },
    ],
    { max_new_tokens: 24, do_sample: false },
  )
  rewriteMs += performance.now() - t0
  return `${q}\n${(out[0] as { generated_text: { content: string }[] }).generated_text.at(-1)!.content.replace(/^"|"$/g, '')}`
}
const set = JSON.parse(readFileSync(file, 'utf8')) as { name: string; targets: { gold: string[]; fact: string; q: Record<string, string> }[] }

const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id

// Files behind a search hit: its own file, or the files of the evidence behind a fact / record.
const filesCache = new Map<string, string[]>()
async function filesOf(h: SearchHit): Promise<string[]> {
  if (h.path) return [h.path]
  if (filesCache.has(h.id)) return filesCache.get(h.id)!
  const rows = (
    await db.query<{ path: string }>(
      `select distinct so.original_path path from public.search_documents d
       join public.evidence e on e.id = any(d.evidence_ids) join public.document_versions dv on dv.id = e.document_version_id
       join public.source_objects so on so.id = dv.source_object_id where d.tenant_id = $1 and d.id = $2`,
      [t, h.id],
    )
  ).rows.map((r) => r.path)
  filesCache.set(h.id, rows)
  return rows
}
const isGold = async (h: SearchHit, gold: string[]) => (await filesOf(h)).some((p) => gold.some((g) => p.includes(g)))
const firstGold = async (hits: SearchHit[], gold: string[]) => {
  for (let i = 0; i < hits.length; i++) if (await isGold(hits[i], gold)) return i + 1
  return null
}

type Outcome = 'found' | 'ranked low' | 'dropped' | 'found too deep' | 'never found'
const tally = new Map<string, Map<Outcome, number>>()
const bump = (style: string, o: Outcome) => {
  const m = tally.get(style) ?? new Map<Outcome, number>()
  m.set(o, (m.get(o) ?? 0) + 1)
  tally.set(style, m)
}
const misses: string[] = []
let ms = 0
let n = 0

for (const target of set.targets)
  for (const [style, q] of Object.entries(target.q)) {
    if (only && style !== only) continue
    const asked = await rewrite(q)
    const t0 = performance.now()
    // --rewrite runs the product's own rewriting inside search (search/rewrite.ts).
    const r = await search(db, t, asked, { limit: 50, rerank: !args.includes('--no-rerank'), rewrite: args.includes('--rewrite') })
    ms += performance.now() - t0
    n++
    const final = await firstGold(r.hits, target.gold)
    let outcome: Outcome
    let detail = ''
    if (final && final <= 10) outcome = 'found'
    else {
      const [kw, mean] = await Promise.all([search(db, t, q, { limit: 100, only: 'bm25', perSource: 10 }), search(db, t, q, { limit: 100, only: 'knn', perSource: 10 })])
      const kwRank = await firstGold(kw.hits, target.gold)
      const meanRank = await firstGold(mean.hits, target.gold)
      const best = Math.min(kwRank ?? 999, meanRank ?? 999)
      outcome = final ? 'ranked low' : best <= 30 ? 'dropped' : best <= 100 ? 'found too deep' : 'never found'
      detail = `keyword #${kwRank ?? '-'} · meaning #${meanRank ?? '-'} · final #${final ?? '-'}`
      misses.push(`  ${outcome.padEnd(17)} [${style}] ${q}\n                    ${target.fact}: ${detail} · top: ${r.hits.slice(0, 3).map((h) => (h.path ?? h.title).split('/').pop()).join(' | ')}`)
    }
    bump(style, outcome)
    if (verbose) console.log(`${outcome.padEnd(17)} [${style}] ${q} ${detail}`)
  }

const order: Outcome[] = ['found', 'ranked low', 'dropped', 'found too deep', 'never found']
console.log(`=== ${set.name}: ${n} phrasings · ${Math.round(ms / n)} ms per search${generator || claude ? ` · ${Math.round(rewriteMs / n)} ms per rewrite (${rewriteModel ?? claudeModel})` : ''}`)
if (claude) console.log(`rewrite tokens: ${usage.input} in / ${usage.output} out`)
console.log(`style      ${order.map((o) => o.padStart(15)).join('')}`)
let total = new Map<Outcome, number>()
for (const [style, m] of tally) {
  console.log(`${style.padEnd(10)} ${order.map((o) => String(m.get(o) ?? 0).padStart(15)).join('')}`)
  for (const o of order) total.set(o, (total.get(o) ?? 0) + (m.get(o) ?? 0))
}
console.log(`${'all'.padEnd(10)} ${order.map((o) => String(total.get(o) ?? 0).padStart(15)).join('')}`)
console.log(`\nmisses:\n${misses.join('\n')}`)
await db.end()
