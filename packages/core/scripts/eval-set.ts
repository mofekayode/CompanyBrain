// Dev tool: load a hand-written eval set from JSON and run its data checks.
// No Claude API calls, the set is written by an FDE / Claude Code session.
//
// Usage: npx tsx scripts/eval-set.ts <tenant-slug> <path/to/set.json> [--run-only]

import { readFile } from 'node:fs/promises'
import { type EvalSpec, loadEvalSet } from '../src/evals/load'
import { runDataChecks } from '../src/evals/run'
import { pool } from '../src/workbench/server'

const [slug, file, flag] = process.argv.slice(2)
if (!slug || !file) throw new Error('usage: eval-set.ts <tenant-slug> <set.json> [--run-only]')
const db = pool()
const tenant = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
if (!tenant) throw new Error(`unknown tenant ${slug}`)
const spec = JSON.parse(await readFile(file, 'utf8')) as EvalSpec

let setId: string
if (flag === '--run-only') {
  setId = (await db.query<{ id: string }>(`select id from public.eval_sets where tenant_id = $1 and name = $2`, [tenant.id, spec.name])).rows[0].id
} else {
  const loaded = await loadEvalSet(db, tenant.id, spec)
  setId = loaded.set_id
  console.log(`loaded ${loaded.items} items`, loaded.by_category)
  for (const w of loaded.warnings) console.log('  warn:', w)
}

const run = await runDataChecks(db, tenant.id, setId)
console.log(`\ndata checks: ${run.passed}/${run.total}`, run.by_category)
const failed = (
  await db.query<{ category: string; question: string; detail: string }>(
    `select i.category, i.question, r.output ->> 'detail' detail from public.eval_results r join public.eval_items i on i.id = r.item_id where r.run_id = $1 and not r.passed order by i.category`,
    [run.run_id],
  )
).rows
for (const f of failed) console.log(`  FAIL [${f.category}] ${f.question}\n       ${f.detail}`)
await db.end()
