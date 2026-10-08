// Dev tool: run the retrieval evals (questions + probes) against the search index.
// Usage: npx tsx scripts/search-eval.ts <slug> [hybrid|bm25|knn|hybrid+rerank|all] [--verbose] [--set "Temporal v1"]

import { runRetrievalEval, type Variant } from '../src/evals/retrieval'
import { pool } from '../src/workbench/server'

const args = process.argv.slice(2)
const setIdx = args.indexOf('--set')
const setName = setIdx >= 0 ? args.splice(setIdx, 2)[1] : null
const [slug, which = 'hybrid', flag] = args
const db = pool()
const tenant = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
const sets = (await db.query<{ id: string; name: string }>(`select id, name from public.eval_sets where tenant_id = $1 and ($2::text is null or name = $2)`, [tenant.id, setName])).rows
const variants: Variant[] = which === 'all' ? ['bm25', 'knn', 'hybrid', 'hybrid+rerank'] : [which as Variant]
for (const v of variants) {
  const { summary, results } = await runRetrievalEval(db, tenant.id, sets.map((s) => s.id), v)
  console.log(`\n=== ${v}: ${summary.passed}/${summary.total} pass · MRR ${summary.mrr.toFixed(2)} · recall@10 ${summary.recall_at_10?.toFixed(2)} · p50 ${summary.latency_p50_ms}ms p95 ${summary.latency_p95_ms}ms`)
  console.log(Object.entries(summary.by_category).map(([c, x]) => `${c} ${x.passed}/${x.total}`).join(' · '))
  for (const r of results.filter((r) => flag === '--verbose' || r.passed === false))
    console.log(`  ${r.passed === false ? 'FAIL' : r.passed ? 'ok  ' : 'n/a '} [${r.category}] ${r.question.slice(0, 70)}, ${r.note}${r.passed === false ? `\n         top: ${r.top.map((t) => t.title.slice(0, 50)).join(' | ')}` : ''}`)
}
await db.end()
