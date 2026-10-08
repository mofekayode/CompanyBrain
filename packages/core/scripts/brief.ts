// Dev tool: the brief (no-LLM) answer the client app shows.
//   npx tsx scripts/brief.ts <slug> "<question>" [--as "Person Name"]
import { briefAnswer } from '../src/answer/brief'
import { pool } from '../src/workbench/server'

const args = process.argv.slice(2)
const i = args.indexOf('--as')
const asName = i >= 0 ? args.splice(i, 2)[1] : undefined
const [slug, q] = args
const db = pool()
const tenantId = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const as = asName ? ((await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and lower(display_name) = lower($2) limit 1`, [tenantId, asName])).rows[0]?.id ?? null) : null
const a = await briefAnswer({ sql: db, tenantId, as }, q)
console.log(`Q: ${a.question}   [${a.time?.mode ?? '-'} ${a.time?.reading ?? ''}] ${a.ms} ms`)
console.log(`→ ${a.headline ?? '(no fact)'}\n  ${a.detail ?? ''}`)
if (a.timeline) console.log('  timeline:', a.timeline.map((s) => `${s.current ? '*' : ''}${s.value} (${s.when})`).join(' → '))
if (a.changed) console.log('  ', a.changed)
for (const x of a.also) console.log(`  + [${x.status}] ${x.text} ${x.cites.join(',')}`)
for (const s of a.sources) console.log(`  ${s.n}. [${s.status}/${s.kind}] ${s.title.slice(0, 90)}, ${s.where}`)
if (a.restricted) console.log('  restricted:', a.restricted)
await db.end()
