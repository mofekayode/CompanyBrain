// Dev tool: merges customer records that are typo'd variants of a real customer, typed freehand into
// work orders or asset lists ("LUNKN" → Lunken Aerospace Components). Two signals are required:
//   1. the variant's letters appear in order in the real name, missing at most a letter or two
//      of its first word ("lunkn" in "lunken", "keper" in "kemper"), and
//   2. they share a site or asset, or the whole multi-word name matches that way
//      ("Haron DC Obetz" in "Harmon Auto Parts DC (Obetz)").
// Look-alikes with different addresses ("Stull & Sons" vs "Stull") are never touched: only records
// created from links (no record of their own) are merged, into a real record.
//
// Usage: npx tsx scripts/merge-variants.ts <slug> [--apply]

import { mergeInto } from '../src/ontology/resolve'
import { pool } from '../src/workbench/server'

const [slug, flag] = process.argv.slice(2)
if (!slug) throw new Error('usage: merge-variants.ts <slug> [--apply]')
const apply = flag === '--apply'
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const squash = (s: string) => norm(s).replace(/ /g, '')
/** a's letters appear in order in b. */
const subseq = (a: string, b: string) => {
  let i = 0
  for (const ch of b) if (ch === a[i]) i++
  return i === a.length
}

const customers = (
  await db.query<{ id: string; name: string; origin: string | null }>(
    `select e.id, e.canonical_name name, e.metadata ->> 'origin' origin from public.entities e join public.entity_types ty on ty.id = e.entity_type_id and ty.name = 'Customer'
     where e.tenant_id = $1 and e.status in ('candidate', 'active')`,
    [t],
  )
).rows
// Places each customer touches: its assets and sites, and the sites of its assets and work.
const places = new Map<string, Set<string>>()
for (const r of (
  await db.query<{ cust: string; place: string }>(
    `select c.id cust, coalesce(s.id, o.id) place
     from public.entities c join public.relationships r on r.source_entity_id = c.id or r.target_entity_id = c.id
     join public.entities o on o.id = case when r.source_entity_id = c.id then r.target_entity_id else r.source_entity_id end
     join public.entity_types ot on ot.id = o.entity_type_id and ot.name in ('Site', 'Asset', 'Work Order')
     left join public.relationships r2 on r2.source_entity_id = o.id and r2.relationship_type_id in (select id from public.relationship_types where name in ('located_at', 'at_site', 'for_site'))
     left join public.entities s on s.id = r2.target_entity_id
     where c.id = any($1::uuid[])`,
    [customers.map((c) => c.id)],
  )
).rows)
  (places.get(r.cust) ?? places.set(r.cust, new Set()).get(r.cust)!).add(r.place)

const real = customers.filter((c) => c.origin !== 'link')
const plan: { variant: (typeof customers)[number]; into: (typeof customers)[number]; why: string }[] = []
for (const v of customers.filter((c) => c.origin === 'link')) {
  const vFirst = norm(v.name).split(' ')[0]
  const matches = real
    .map((c) => {
      const cFirst = norm(c.name).split(' ')[0]
      const firstOk = vFirst.length >= 3 && vFirst[0] === cFirst[0] && subseq(vFirst, cFirst) && vFirst.length >= cFirst.length - 2
      if (!firstOk) return null
      const shared = [...(places.get(v.id) ?? [])].filter((p) => places.get(c.id)?.has(p)).length
      const whole = norm(v.name).includes(' ') && subseq(squash(v.name), squash(c.name))
      return shared || whole ? { c, why: [shared ? `${shared} shared site/asset` : null, whole ? 'whole name matches' : null].filter(Boolean).join(', ') } : null
    })
    .filter((x): x is { c: (typeof customers)[number]; why: string } => !!x)
  if (matches.length === 1) plan.push({ variant: v, into: matches[0].c, why: matches[0].why })
  else if (matches.length > 1) console.log(`skip    ${v.name}: ambiguous (${matches.map((m) => m.c.name).join(' / ')})`)
}
for (const p of plan) {
  console.log(`merge   ${p.variant.name} → ${p.into.name}  (${p.why})`)
  if (apply) await mergeInto(db, t, p.into.id, [p.variant.id], `typo'd variant of ${p.into.name}: ${p.why}`)
}
console.log(apply ? `merged ${plan.length}` : `${plan.length} merges planned (dry run; --apply to merge)`)
await db.end()
