// Dev tool: drive the answering layer from a terminal (this is how a Claude Code
// session acts as the answering agent while the Claude API is off).
//
//   npx tsx scripts/ask.ts <slug> search  "<query>"            [--as "Person Name"] [--rerank]
//   npx tsx scripts/ask.ts <slug> context "<question>"         [--as "Person Name"]   → the RAG context pack
//   npx tsx scripts/ask.ts <slug> tool <tool_name> '<json>'    [--as "Person Name"]   → one agent tool call
//   npx tsx scripts/ask.ts <slug> answer  "<question>"         (Claude API on only)

import { answer, buildContext } from '../src/answer/answer'
import { runTool } from '../src/answer/tools'
import { search } from '../src/search/search'
import { pool } from '../src/workbench/server'

const args = process.argv.slice(2)
const flag = (k: string) => {
  const i = args.indexOf(k)
  return i >= 0 ? args.splice(i, k.startsWith('--rerank') ? 1 : 2)[1] ?? true : undefined
}
const asName = flag('--as') as string | undefined
const rerank = !!flag('--rerank')
const [slug, cmd, a, b] = args
const db = pool()
const tenantId = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const as = asName ? ((await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and lower(display_name) = lower($2) limit 1`, [tenantId, asName])).rows[0]?.id ?? null) : null
if (asName && !as) throw new Error(`unknown person ${asName}`)

if (cmd === 'search') {
  const r = await search(db, tenantId, a, { as, rerank, limit: 10 })
  console.log(`understood: ${r.understood.entities.map((e) => `${e.name} [${e.type}]`).join(', ') || '-'}${r.understood.asOf ? ` · as of ${r.understood.asOf}` : ''}`)
  console.log(`bm25 ${r.counts.bm25} · knn ${r.counts.knn} · fused ${r.counts.fused} · ${JSON.stringify(r.timings)}`)
  for (const [i, h] of r.hits.entries())
    console.log(`${String(i + 1).padStart(2)}. [${h.doc_type}/${h.kind}] ${h.title}  (bm25 #${h.ranks.bm25 ?? '–'}, knn #${h.ranks.knn ?? '–'}${h.ranks.rerank !== undefined ? `, rerank ${h.ranks.rerank.toFixed(2)}` : ''})\n      ${h.snippet.replace(/\s+/g, ' ').slice(0, 220)}`)
} else if (cmd === 'context') {
  const c = await buildContext(db, tenantId, a, { as })
  console.log(c.prompt.user)
  console.log(`\n(${c.ms} ms)`)
} else if (cmd === 'tool') {
  console.log(JSON.stringify(await runTool({ sql: db, tenantId, as }, a, b ? JSON.parse(b) : {}), null, 2))
} else if (cmd === 'answer') {
  console.log(JSON.stringify(await answer(db, tenantId, a, { as }), null, 2))
} else throw new Error('commands: search | context | tool | answer')
await db.end()
