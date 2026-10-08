// Dev tool: run a skill and print its report.
//
//   npx tsx scripts/skill.ts <slug> <skill_key> ["entity or topic"] [--as "Person Name"] [--json]

import { reportMarkdown, runSkill, SKILLS } from '../src/skills/skills'
import { pool } from '../src/workbench/server'

const args = process.argv.slice(2)
const flag = (k: string, takes = true) => {
  const i = args.indexOf(k)
  return i >= 0 ? (takes ? args.splice(i, 2)[1] : (args.splice(i, 1), true)) : undefined
}
const asName = flag('--as') as string | undefined
const json = !!flag('--json', false)
const [slug, key, arg] = args
const db = pool()
const tenantId = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const as = asName ? ((await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and lower(display_name) = lower($2) limit 1`, [tenantId, asName])).rows[0]?.id ?? null) : null
const spec = SKILLS.find((s) => s.key === key)
if (!spec) throw new Error(`skills: ${SKILLS.map((s) => s.key).join(', ')}`)
const t0 = Date.now()
const r = await runSkill({ sql: db, tenantId, as }, key, spec.input === 'topic' ? { topic: arg } : { entity: arg })
console.log(json ? JSON.stringify(r, null, 2) : reportMarkdown(r))
console.log(`\n(${Date.now() - t0} ms · ${r.sections.length} sections · ${r.sources.length} sources)`)
await db.end()
