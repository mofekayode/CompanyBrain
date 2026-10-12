// Dev tool: load reviewed aliases (what people call things) into entity_aliases, each with where it
// came from. Input: a JSON list [{entity, type, alias, kind, source, ambiguous?, context?}]. Skips
// aliases already known (any status) for that entity, and reports entities it can't find.
//
// Usage: npx tsx scripts/load-aliases.ts <slug> <file.json> [--apply]

import { readFileSync } from 'node:fs'
import { pool } from '../src/workbench/server'

const [slug, file, flag] = process.argv.slice(2)
if (!slug || !file) throw new Error('usage: load-aliases.ts <slug> <file.json> [--apply]')
const apply = flag === '--apply'
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const items = JSON.parse(readFileSync(file, 'utf8')) as { entity: string; type: string; alias: string; kind: string; source: string; ambiguous?: boolean; context?: Record<string, unknown> }[]
const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ')
let added = 0
const missing: string[] = []
const touched = new Set<string>()
for (const it of items) {
  const e = (
    await db.query<{ id: string }>(
      `select e.id from public.entities e join public.entity_types ty on ty.id = e.entity_type_id
       where e.tenant_id = $1 and ty.name = $2 and e.merged_into_id is null and e.status in ('candidate', 'active')
         and (lower(e.canonical_name) = lower($3) or exists (select 1 from public.entity_aliases a where a.entity_id = e.id and a.normalized_alias = $4 and a.status <> 'rejected'))
       order by lower(e.canonical_name) = lower($3) desc limit 1`,
      [t, it.type, it.entity, norm(it.entity)],
    )
  ).rows[0]
  if (!e) {
    missing.push(`${it.type} ${it.entity}`)
    continue
  }
  const dup = (await db.query(`select 1 from public.entity_aliases where entity_id = $1 and normalized_alias = $2`, [e.id, norm(it.alias)])).rowCount
  if (dup) continue
  added++
  touched.add(e.id)
  console.log(`${it.type.padEnd(9)} ${it.entity} ← "${it.alias}" (${it.kind}${it.ambiguous ? ', ambiguous' : ''}) · ${it.source}`)
  if (apply)
    await db.query(
      `insert into public.entity_aliases (tenant_id, entity_id, alias, kind, status, origin, is_ambiguous, context) values ($1, $2, $3, $4, 'candidate', 'human', $5, $6)`,
      [t, e.id, it.alias, it.kind, !!it.ambiguous, JSON.stringify({ source: it.source, ...(it.context ?? {}) })],
    )
}
console.log(`${added} aliases ${apply ? 'added' : 'to add'} on ${touched.size} records; ${missing.length} entities not found${missing.length ? `: ${[...new Set(missing)].join(', ')}` : ''}`)
if (apply) console.log(`entity ids touched (re-project their cards): ${[...touched].join(',')}`)
await db.end()
