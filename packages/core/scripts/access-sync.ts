// Dev tool: make a client's access match its tenant config exactly (config/tenants/<slug>/tenant.json
// → access): every scope's status, audience and path rules; evidence-backed membership exceptions;
// FDE file moves; then every file is reassigned by the rules and ACLs are pushed down.
// Use after correcting access from the source systems' permission exports. Re-index search after.
//
// Usage: npx tsx scripts/access-sync.ts <slug> [--dry-run]

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { moveFiles } from '../src/access/overview'
import { applyAccess, matchRule, type ScopeRule } from '../src/access/scopes'
import { pool } from '../src/workbench/server'

interface ScopeConfig {
  key: string
  name: string
  description: string
  sensitivity: 'internal' | 'confidential' | 'restricted'
  hidden: boolean
  status: 'held' | 'released'
  rules: ScopeRule[]
  audience: string[]
  /** The sensitivity label the folder carries in the source system, if any. */
  label?: string
}
interface AccessConfig {
  scopes: ScopeConfig[]
  file_moves: { path: string; scope_key: string; note: string }[]
  memberships?: { group: string; member: string; why: string }[]
  /** Sensitivity labels found inside files: the stricter of the folder's access and the label's wins. */
  labels?: { label: string; audience: string[]; why: string }[]
}

const [slug, flag] = process.argv.slice(2)
if (!slug) throw new Error('usage: access-sync.ts <slug> [--dry-run]')
const dry = flag === '--dry-run'
const cfg = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../config/tenants', slug, 'tenant.json'), 'utf8')) as { access: AccessConfig }).access
const db = pool()
const tenant = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
if (!tenant) throw new Error(`unknown tenant ${slug}`)
const t = tenant.id

const principals = new Map(
  (await db.query<{ id: string; name: string }>(`select id, display_name name from public.principals where tenant_id = $1`, [t])).rows.map((p) => [p.name.toLowerCase(), p.id]),
)
const pid = (name: string) => {
  const id = principals.get(name.toLowerCase())
  if (!id) throw new Error(`no person or group named "${name}"`)
  return id
}

// Labelled areas keep content inside the organization: an external guest reads one only when named
// in its audience directly, never through a group they joined (a guest in "Mgmt Team" does not get the
// HR comp review). Groups in a labelled area's audience are expanded to their members for that reason;
// re-run this sync when memberships change.
const guests = new Set((await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and metadata ->> 'status' = 'guest'`, [t])).rows.map((r) => r.id))
async function withoutGuests(ids: string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const id of ids) {
    const members = (
      await db.query<{ id: string; kind: string }>(
        `with recursive m (id) as (select $2::uuid union select pm.member_id from public.principal_members pm join m on pm.group_id = m.id where pm.tenant_id = $1)
         select p.id, p.kind from m join public.principals p on p.id = m.id`,
        [t, id],
      )
    ).rows
    const isGroup = members.find((r) => r.id === id)?.kind === 'group'
    if (!isGroup) out.add(id)
    else for (const r of members) if (r.kind === 'user' && !guests.has(r.id)) out.add(r.id)
  }
  return [...out]
}

// 1. Membership exceptions the exports support (guests and former staff don't inherit by default).
for (const m of cfg.memberships ?? []) {
  console.log(`member  ${m.member} → ${m.group}  (${m.why})`)
  if (!dry) await db.query(`insert into public.principal_members (tenant_id, group_id, member_id) values ($1, $2, $3) on conflict do nothing`, [t, pid(m.group), pid(m.member)])
}

// 2. Scopes: status, description, rules and exactly the configured audience.
const scopeIds = new Map<string, string>()
const changedScopes: string[] = []
for (const s of cfg.scopes) {
  let row = (await db.query<{ id: string; status: string }>(`select id, status from public.access_scopes where tenant_id = $1 and key = $2`, [t, s.key])).rows[0]
  if (!row && !dry) {
    const acl = (await db.query<{ id: string }>(`insert into public.acls (tenant_id, name, origin) values ($1, $2, $3) returning id`, [t, `scope:${s.key}`, JSON.stringify({ scope: s.key })])).rows[0].id
    row = (
      await db.query<{ id: string; status: string }>(
        `insert into public.access_scopes (tenant_id, key, name, description, sensitivity, hidden, status, acl_id, origin, rules, evidence)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'human', $9, '[]') returning id, status`,
        [t, s.key, s.name, s.description, s.sensitivity, s.hidden, s.status, acl, JSON.stringify(s.rules)],
      )
    ).rows[0]
    console.log(`new     ${s.key}`)
  }
  if (!row) continue
  scopeIds.set(s.key, row.id)
  const audience = s.label ? await withoutGuests(s.audience.map(pid)) : s.audience.map(pid)
  if (row.status !== s.status) console.log(`status  ${s.key}: ${row.status} → ${s.status}`)
  const before = (await db.query<{ p: string }>(`select principal_id::text p from public.access_scope_audience where scope_id = $1`, [row.id])).rows.map((r) => r.p).sort().join()
  if (row.status !== s.status || before !== [...audience].sort().join()) changedScopes.push(row.id)
  if (dry) continue
  await db.query(`update public.access_scopes set name = $2, description = $3, sensitivity = $4, hidden = $5, status = $6, rules = $7 where id = $1`, [
    row.id,
    s.name,
    s.description,
    s.sensitivity,
    s.hidden,
    s.status,
    JSON.stringify(s.rules),
  ])
  await db.query(`delete from public.access_scope_audience where scope_id = $1 and not (principal_id = any($2::uuid[]))`, [row.id, audience])
  for (const a of audience)
    await db.query(`insert into public.access_scope_audience (tenant_id, scope_id, principal_id, why) values ($1, $2, $3, 'permission exports') on conflict (scope_id, principal_id) do nothing`, [t, row.id, a])
}

// 3. Every file not moved by hand goes where the rules say (longest path prefix in its source).
const rules = cfg.scopes.flatMap((s) => s.rules)
const fallback = 'unsorted-intake'
const files = (
  await db.query<{ id: string; source: string; path: string; scope: string | null; origin: string | null; client: boolean }>(
    `select so.id, s.name source, so.original_path path, sc.key scope, fa.origin, coalesce(fa.reasons @> '[{"kind":"client"}]', false) client
     from public.source_objects so join public.sources s on s.id = so.source_id
     left join public.file_access fa on fa.source_object_id = so.id left join public.access_scopes sc on sc.id = fa.scope_id
     where so.tenant_id = $1`,
    [t],
  )
).rows
const moved = new Map<string, string[]>()
// Hand moves stay only while the config still lists them; dropped moves go back to the rules.
const keptMoves = new Set(cfg.file_moves.map((m) => m.path))
for (const f of files) {
  if (f.origin === 'human' && keptMoves.has(f.path)) continue
  // Client-confirmed access (scripts/load-client-access.ts) is not re-derived from folders.
  if (f.client) continue
  const key = matchRule(f, rules)?.scope_key ?? fallback
  if (key !== f.scope) moved.set(key, [...(moved.get(key) ?? []), f.id])
}
for (const [key, ids] of moved) {
  console.log(`assign  ${ids.length} files → ${key}${ids.length <= 5 ? `: ${ids.map((id) => files.find((f) => f.id === id)!.path).join(' | ')}` : ''}`)
  if (dry) continue
  const scope = (await db.query<{ id: string; acl_id: string; sensitivity: string }>(`select id, acl_id, sensitivity from public.access_scopes where id = $1`, [scopeIds.get(key)])).rows[0]
  await db.query(
    `insert into public.file_access (tenant_id, source_object_id, scope_id, sensitivity, acl_id, origin, reasons, flagged)
     select $1, x, $2, $4, $3, 'rule', jsonb_build_array(jsonb_build_object('kind', 'rule', 'text', 'path rule from the permission exports')), false
     from unnest($5::uuid[]) x
     on conflict (source_object_id) do update set scope_id = excluded.scope_id, acl_id = excluded.acl_id, sensitivity = excluded.sensitivity,
       origin = 'rule', flagged = false, reasons = excluded.reasons`,
    [t, scope.id, scope.acl_id, scope.sensitivity, ids],
  )
}

// 4. FDE moves (a decision about one file the rules can't express).
for (const m of cfg.file_moves) {
  const ids = (await db.query<{ id: string }>(`select id from public.source_objects where tenant_id = $1 and original_path = $2`, [t, m.path])).rows.map((r) => r.id)
  console.log(`move    ${m.path} → ${m.scope_key} (${ids.length} file${ids.length === 1 ? '' : 's'})`)
  if (!dry && ids.length) await moveFiles(db, t, ids, scopeIds.get(m.scope_key)!, `FDE: ${m.note}`)
}

// 5. Sensitivity labels inside files: readers = people allowed by both the file's area and the label.
//    A label counts as a marking (a title or heading line), not as a value inside a table row (a
//    permissions export lists label names as data). In a spreadsheet it restricts the sheet it sits
//    on; elsewhere the whole file.
const labelled: string[] = []
const people = async (ids: string[]) =>
  new Set(
    (
      await db.query<{ id: string }>(
        `with recursive m (id) as (select unnest($2::uuid[]) union select pm.member_id from public.principal_members pm join m on pm.group_id = m.id where pm.tenant_id = $1)
         select m.id::text id from m join public.principals p on p.id = m.id where p.kind = 'user'`,
        [t, ids],
      )
    ).rows.map((r) => r.id),
  )
const units = new Map<string, { sheet: string; scope_key: string; acl_id: string }[]>()
for (const l of cfg.labels ?? []) {
  const rows = (
    await db.query<{ id: string; path: string; scope_id: string; scope: string; kind: string; sheet: string | null; content: string }>(
      `select so.id, so.original_path path, fa.scope_id, sc.key scope, e.kind, e.locator ->> 'sheet' sheet, e.content
       from public.evidence e join public.document_versions dv on dv.id = e.document_version_id join public.source_objects so on so.id = dv.source_object_id
       join public.file_access fa on fa.source_object_id = so.id join public.access_scopes sc on sc.id = fa.scope_id
       where e.tenant_id = $1 and e.content ilike '%' || $2 || '%'`,
      [t, l.label],
    )
  ).rows
  const marked = rows.filter((r) => r.content.split('\n').some((line) => line.toLowerCase().includes(l.label.toLowerCase()) && line.split(' | ').length <= 2))
  const labelPeople = await people(l.audience.map(pid))
  const seen = new Set<string>()
  for (const f of marked) {
    const sheet = f.kind === 'table' && f.sheet && f.sheet !== 'CSV' ? f.sheet : null
    if (seen.has(f.id + (sheet ?? ''))) continue
    seen.add(f.id + (sheet ?? ''))
    const area = f.scope.startsWith('label:') ? f.scope.split(':')[1] : f.scope
    const areaId = (await db.query<{ id: string }>(`select id from public.access_scopes where tenant_id = $1 and key = $2`, [t, area])).rows[0]?.id ?? f.scope_id
    const areaPeople = await people((await db.query<{ p: string }>(`select principal_id::text p from public.access_scope_audience where scope_id = $1`, [areaId])).rows.map((r) => r.p))
    const both = [...areaPeople].filter((p) => labelPeople.has(p))
    const key = `label:${area}:${l.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    console.log(`label   ${f.path}${sheet ? ` [sheet ${sheet}]` : ''} → ${key} (${both.length} people in both the area and the label)`)
    labelled.push(f.id)
    if (dry) continue
    let scope = (await db.query<{ id: string; acl_id: string }>(`select id, acl_id from public.access_scopes where tenant_id = $1 and key = $2`, [t, key])).rows[0]
    if (!scope) {
      const acl = (await db.query<{ id: string }>(`insert into public.acls (tenant_id, name, origin) values ($1, $2, $3) returning id`, [t, `scope:${key}`, JSON.stringify({ scope: key })])).rows[0].id
      scope = (
        await db.query<{ id: string; acl_id: string }>(
          `insert into public.access_scopes (tenant_id, key, name, description, sensitivity, hidden, status, acl_id, origin, rules, evidence)
           values ($1, $2, $3, $4, 'restricted', true, 'released', $5, 'human', '[]', '[]') returning id, acl_id`,
          [t, key, `${l.label} within ${area}`, `Marked "${l.label}": only people allowed by both the area and the label. ${l.why}`, acl],
        )
      ).rows[0]
    }
    await db.query(`delete from public.access_scope_audience where scope_id = $1 and not (principal_id = any($2::uuid[]))`, [scope.id, both])
    for (const p of both) await db.query(`insert into public.access_scope_audience (tenant_id, scope_id, principal_id, why) values ($1, $2, $3, 'area and label') on conflict (scope_id, principal_id) do nothing`, [t, scope.id, p])
    changedScopes.push(scope.id)
    if (sheet) units.set(f.id, [...(units.get(f.id) ?? []), { sheet, scope_key: key, acl_id: scope.acl_id }])
    else await db.query(`update public.file_access set scope_id = $2, acl_id = $3, sensitivity = 'restricted', origin = 'rule' where source_object_id = $1`, [f.id, scope.id, scope.acl_id])
  }
}
// Sheet-level labels are kept on the file and applied by applyAccess to that sheet's evidence.
if (!dry) {
  await db.query(`update public.source_objects set metadata = metadata - 'label_units' where tenant_id = $1 and metadata ? 'label_units'`, [t])
  for (const [id, u] of units) await db.query(`update public.source_objects set metadata = metadata || jsonb_build_object('label_units', $2::jsonb) where id = $1`, [id, JSON.stringify(u)])
}

if (!dry) {
  console.log('applied', await applyAccess(db, t))
  // Search documents carry their readers in the index: re-index those whose readers changed
  // (scopes with a new audience or status, and every file that moved).
  const acls = (await db.query<{ acl_id: string }>(`select acl_id from public.access_scopes where id = any($1::uuid[])`, [changedScopes])).rows.map((r) => r.acl_id)
  const movedIds = [...moved.values()].flat().concat(labelled)
  const r = await db.query(
    `update public.search_documents set indexed_at = null
     where tenant_id = $1 and (acl_ids && $2::uuid[] or source_object_id = any($3::uuid[]))`,
    [t, acls, movedIds],
  )
  console.log(`search documents to re-index: ${r.rowCount} (run scripts/search-project.ts ${slug})`)
}
await db.end()
