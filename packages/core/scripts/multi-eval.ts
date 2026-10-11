// Dev tool: questions that ask for two things. Pairs of phrasing-robustness questions (gold files from
// evidence) joined two ways: casual "Q1? And Q2?" and situation-style "Q1, and Q2". A
// question passes when a file for each half is in the top 10. Compared: one search (off), split by
// clauses only (rules), and clauses plus the model for the rest (model; paid, about $0.0002 a split).
//
// Usage: npx tsx scripts/multi-eval.ts <slug> [--model]

import { readFileSync } from 'node:fs'
import { search, type SearchHit } from '../src/search/search'
import { pool } from '../src/workbench/server'

const [slug] = process.argv.slice(2)
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const set = JSON.parse(readFileSync(`../../evals/${slug}/robustness-dev-v1.json`, 'utf8')) as { targets: { gold: string[]; q: Record<string, string> }[] }

const filesCache = new Map<string, string[]>()
async function filesOf(h: SearchHit): Promise<string[]> {
  if (h.path) return [h.path]
  if (!filesCache.has(h.id))
    filesCache.set(
      h.id,
      (
        await db.query<{ path: string }>(
          `select distinct so.original_path path from public.search_documents d join public.evidence e on e.id = any(d.evidence_ids)
           join public.document_versions dv on dv.id = e.document_version_id join public.source_objects so on so.id = dv.source_object_id where d.tenant_id = $1 and d.id = $2`,
          [t, h.id],
        )
      ).rows.map((r) => r.path),
    )
  return filesCache.get(h.id)!
}
const found = async (hits: SearchHit[], gold: string[]) => {
  for (const h of hits.slice(0, 10)) if ((await filesOf(h)).some((p) => gold.some((g) => p.includes(g)))) return true
  return false
}

const lower = (q: string) => q.charAt(0).toLowerCase() + q.slice(1)
const pairs = set.targets.slice(0, 24).flatMap((a, i, all) => (i % 2 === 0 && all[i + 1] ? [[a, all[i + 1]] as const] : []))
const modes: [string, { decompose: boolean; rewrite: boolean }][] = [
  ['off', { decompose: false, rewrite: false }],
  ['rules', { decompose: true, rewrite: false }],
  ...(process.argv.includes('--model')
    ? ([
        ['rewrite only', { decompose: false, rewrite: true }],
        ['model', { decompose: true, rewrite: true }],
      ] as [string, { decompose: boolean; rewrite: boolean }][])
    : []),
]
for (const [name, mode] of modes) {
  let both = 0
  let n = 0
  for (const [a, b] of pairs)
    for (const q of [`${a.q.casual.replace(/\?$/, '')}? And ${lower(b.q.casual).replace(/\?$/, '')}?`, `${a.q.indirect.replace(/\?$/, '')}, and ${lower(b.q.indirect)}`]) {
      const r = await search(db, t, q, { limit: 10, rerank: true, ...mode })
      n++
      if ((await found(r.hits, a.gold)) && (await found(r.hits, b.gold))) both++
    }
  console.log(`${name.padEnd(12)} both halves in the top 10: ${both}/${n}`)
}
await db.end()
