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
}
interface AccessConfig {
  scopes: ScopeConfig[]
  file_moves: { path: string; scope_key: string; note: string }[]
  memberships?: { group: string; member: string; why: string }[]
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
  const audience = s.audience.map(pid)
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
  await db.query<{ id: string; source: string; path: string; scope: string | null; origin: string | null }>(
    `select so.id, s.name source, so.original_path path, sc.key scope, fa.origin
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

if (!dry) {
  console.log('applied', await applyAccess(db, t))
  // Search documents carry their readers in the index: re-index those whose readers changed
  // (scopes with a new audience or status, and every file that moved).
  const acls = (await db.query<{ acl_id: string }>(`select acl_id from public.access_scopes where id = any($1::uuid[])`, [changedScopes])).rows.map((r) => r.acl_id)
  const movedIds = [...moved.values()].flat()
  const r = await db.query(
    `update public.search_documents set indexed_at = null
     where tenant_id = $1 and (acl_ids && $2::uuid[] or source_object_id = any($3::uuid[]))`,
    [t, acls, movedIds],
  )
  console.log(`search documents to re-index: ${r.rowCount} (run scripts/search-project.ts ${slug})`)
}
await db.end()
