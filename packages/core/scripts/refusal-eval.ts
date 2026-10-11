// Dev tool: when should an answer say "part of this was withheld for permissions" (the eval contract's
// `refused`: true if all or part was withheld)? Brain-side questions built from the permission exports:
// ones a role can't fully answer (the material sits in files closed to them) and ones it can. No
// answer is written; each candidate rule for the flag is judged on the same searches.
//
// Usage: npx tsx scripts/refusal-eval.ts <slug>

import { visible } from '../src/answer/tools'
import { search, type SearchHit } from '../src/search/search'
import { baseId } from '../src/search/readers'
import { pool } from '../src/workbench/server'

const [slug] = process.argv.slice(2)
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const person = async (name: string) => (await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and display_name = $2`, [t, name])).rows[0].id

// [asked as, question, withheld?]
const cases: [string, string, boolean][] = [
  ['Jamal Whitaker', 'What raises are planned in the 2026 comp review?', true],
  ['Jamal Whitaker', 'What are the salaries of the branch managers?', true],
  ['Jamal Whitaker', 'Who has access to the data room?', true],
  ['Jamal Whitaker', 'What did Linda say about collections in her emails?', true],
  ['Jamal Whitaker', 'What is in the retention plan for key employees?', true],
  ['Jamal Whitaker', 'What is the payroll register total for 2025?', true],
  ['Erin Haddad', 'What did we propose to Bluegrass Distilling?', true],
  ['Tyler Branham', 'What is in the 2026 comp review?', true],
  ['Tyler Branham', 'What did the quality of earnings report find?', true],
  ['Jamal Whitaker', 'How do I lock out a pump before working on it?', false],
  ['Jamal Whitaker', 'What are the site rules at Kemper Plastics?', false],
  ['Jamal Whitaker', 'How do I code an after-hours hot job?', false],
  ['Jamal Whitaker', 'What PPE do I need at Midwest Galvanizing?', true], // the site safety sheet is Louisville's
  ['Jamal Whitaker', 'Who do I report a near miss to?', false],
  ['Priya Shah', 'What is the T&M labor rate in the 2026 Blue Book?', false],
  ['Priya Shah', 'Who owns the Kroll Logistics account?', false],
  ['Mike Hargrove', 'What did we propose to Bluegrass Distilling?', false],
  ['Marcus Bell', 'Who is on call in Louisville this week?', false],
  ['Tyler Branham', 'What is the payment term for Kemper Plastics?', false],
]

type Rule = (b: { hit: SearchHit; rank: number }[], full: SearchHit[], mine: SearchHit[]) => boolean
const top = (mine: SearchHit[]) => Math.max(-99, ...mine.slice(0, 5).map((h) => h.ranks.rerank ?? -99))
const rules: Record<string, Rule> = {
  'best overall is locked': (b) => b.some((x) => x.rank === 0),
  'locked in top 3': (b) => b.some((x) => x.rank < 3),
  'locked in top 3, relevant (rerank ≥ 0)': (b) => b.some((x) => x.rank < 3 && (x.hit.ranks.rerank ?? -99) >= 0),
  'locked in top 5, beats what they can open': (b, _f, mine) => b.some((x) => x.rank < 5 && (x.hit.ranks.rerank ?? -99) >= Math.max(0, top(mine))),
  'locked in top 5 beats theirs by 1': (b, _f, mine) => b.some((x) => x.rank < 5 && (x.hit.ranks.rerank ?? -99) >= top(mine) + 1),
  'locked in top 3, relevant, beats theirs - 2': (b, _f, mine) => b.some((x) => x.rank < 3 && (x.hit.ranks.rerank ?? -99) >= Math.max(0, top(mine) - 2)),
}
const score = Object.fromEntries(Object.keys(rules).map((k) => [k, { tp: 0, fp: 0, fn: 0, tn: 0 }]))
for (const [who, q, want] of cases) {
  const as = await person(who)
  const [mine, full] = await Promise.all([search(db, t, q, { as, limit: 50, rerank: true }), search(db, t, q, { limit: 12, rerank: true })])
  const hidden = full.hits.map((hit, rank) => ({ hit, rank })).filter((x) => !mine.hits.some((m) => baseId(m.id) === baseId(x.hit.id)))
  const ok = await visible({ sql: db, tenantId: t, as }, hidden.map((x) => x.hit.id))
  const blocked = hidden.filter((x) => !ok.has(x.hit.id))
  const marks: string[] = []
  for (const [name, rule] of Object.entries(rules)) {
    const got = rule(blocked, full.hits, mine.hits)
    const s = score[name]
    if (got && want) s.tp++
    else if (got && !want) s.fp++
    else if (!got && want) s.fn++
    else s.tn++
    marks.push(got === want ? '·' : got ? '+' : '-')
  }
  console.log(`${marks.join('')}  ${want ? 'withheld' : 'open    '}  ${who}: ${q}  (locked: ${blocked.slice(0, 3).map((x) => `#${x.rank + 1} ${(x.hit.path ?? x.hit.title).split('/').pop()!.slice(0, 30)} ${x.hit.ranks.rerank?.toFixed(1)}`).join(', ') || 'none'}; theirs best ${top(mine.hits).toFixed(1)})`)
}
console.log('\n(· right, + flagged but open, - missed)')
for (const [name, s] of Object.entries(score)) console.log(`${name.padEnd(44)} right ${s.tp + s.tn}/${cases.length} · missed ${s.fn} · false alarms ${s.fp}`)
await db.end()
