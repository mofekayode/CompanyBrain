// Dev tool: where does the right file land in the eval endpoint's `retrieved` list (search results
// expanded into their sources: a fact's evidence files, a record's own row and the rows that mention
// it)? Same search and expansion as the endpoint, no answer written. Compares ways of ordering that
// list, on the phrasing-robustness set (gold files from evidence): right file in the top 10 entries,
// and the mean reciprocal rank.
//
// --rewrite: the product path (question rewriting and splitting; needs COMPANY_BRAIN_ALLOW_ANSWER_API=1).
// Usage: npx tsx scripts/retrieved-eval.ts <slug> [--rewrite] [--sample N] [--concurrency C]

import { readFileSync } from 'node:fs'
import { tenantFiles } from '../src/access/knowledge-view'
import type { ToolCtx } from '../src/answer/tools'
import { orderRetrieved, type Ref, refsFor } from '../src/evals/contract'
import { mapLimit, runFlags, sampleOf } from '../src/evals/parallel'
import { rerankStats } from '../src/search/llm-rerank'
import { rewriteStats } from '../src/search/rewrite'
import { search, type SearchHit } from '../src/search/search'
import { pool } from '../src/workbench/server'

const [slug] = process.argv.slice(2)
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const set = JSON.parse(readFileSync(`../../evals/${slug}/robustness-dev-v1.json`, 'utf8')) as { targets: { gold: string[]; q: Record<string, string> }[] }
const files = await tenantFiles(db, t, slug)
const ctx: ToolCtx = { sql: db, tenantId: t, as: null }

type Order = (hits: SearchHit[], refs: Map<string, Ref[]>) => Ref[]
const uniq = (list: Ref[]) => {
  const seen = new Set<string>()
  return list.filter((r) => !seen.has(r.source + r.locator) && seen.add(r.source + r.locator))
}
const orders: Record<string, Order> = {
  // Today: each result's sources in turn.
  depth: (hits, refs) => uniq(hits.flatMap((h) => refs.get(h.id) ?? [])),
  // Each result's first source, then everyone's second, and so on.
  breadth: (hits, refs) => {
    const lists = hits.map((h) => refs.get(h.id) ?? [])
    const out: Ref[] = []
    for (let i = 0; lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i]) out.push(l[i])
    return uniq(out)
  },
  // Breadth, and a file already listed waits until every result has had a new file in.
  'new files first': (hits, refs) => {
    const lists = hits.map((h) => refs.get(h.id) ?? [])
    const all: Ref[] = []
    for (let i = 0; lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i]) all.push(l[i])
    const firsts: Ref[] = []
    const rest: Ref[] = []
    const fileSeen = new Set<string>()
    for (const r of uniq(all)) (fileSeen.has(r.source) ? rest : firsts).push(r), fileSeen.add(r.source)
    return [...firsts, ...rest]
  },
  // What the endpoint does (orderRetrieved).
  endpoint: (hits, refs) => orderRetrieved(hits.map((h) => h.id), refs),
}

const stats = Object.fromEntries(Object.keys(orders).map((k) => [k, { top10: 0, rr: 0 }]))
const { sample, concurrency } = runFlags(process.argv)
const tasks = sampleOf(
  set.targets.flatMap((target) => Object.values(target.q).map((q) => ({ target, q }))),
  sample,
)
const n = tasks.length
await mapLimit(tasks, concurrency, async ({ target, q }) => {
  const r = await search(db, t, q, { limit: 50, rerank: true, rewrite: process.argv.includes('--rewrite') })
  const refs = await refsFor(ctx, files, r.hits.map((h) => h.id))
  for (const [name, order] of Object.entries(orders)) {
    const list = order(r.hits, refs)
    const i = list.findIndex((x) => target.gold.some((g) => x.source.includes(g)))
    if (i >= 0 && i < 10) stats[name].top10++
    if (i >= 0) stats[name].rr += 1 / (i + 1)
  }
})
console.log(`model calls: rewrite ${rewriteStats.calls} (${rewriteStats.fallbacks} fell back), model rerank ${rerankStats.calls} (${rerankStats.fallbacks} fell back)`)
for (const [name, s] of Object.entries(stats)) console.log(`${name.padEnd(16)} right file in top 10 entries: ${s.top10}/${n} · MRR ${(s.rr / n).toFixed(2)}`)
await db.end()
