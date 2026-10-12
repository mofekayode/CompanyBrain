// Dev tool: load client-confirmed access (config/tenants/<slug>/client-access.json) as the access model,
// replacing what the scope rules inferred from folders. The file lists, per file (and per email
// message), the roles that may open it and any named people; per role, who holds it over time.
//
//   roles  → a group per role ("Role: ROLE-HR"), members = the people holding it on the given date
//   files  → one access list per distinct set of roles + people, set on the file and pushed down to its
//            passages (applyAccess); emails by message id; attachments and archive members follow their
//            parent; files the list doesn't name keep what they had (reported)
//
// Client-confirmed rows are marked (reasons kind "client"): the access sync and scope rules leave them
// alone. Re-index search afterwards (scripts/search-project.ts): cards depend on who may read what.
//
// Usage: npx tsx scripts/load-client-access.ts <slug> [--date YYYY-MM-DD] [--apply]

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyAccess } from '../src/access/scopes'
import { pool } from '../src/workbench/server'

interface Holder {
  name: string
  from: string | null
  to: string | null
}
interface ClientAccess {
  roles: Record<string, { person: string | null; holders: Holder[]; description?: string }>
  files: { path: string; message_id?: string; roles: string[]; people?: string[] }[]
}

const args = process.argv.slice(2)
const slug = args[0]
if (!slug) throw new Error('usage: load-client-access.ts <slug> [--date YYYY-MM-DD] [--apply]')
const apply = args.includes('--apply')
const date = args.includes('--date') ? args[args.indexOf('--date') + 1] : '2026-10-10'
const cfgDir = join(import.meta.dirname, '../../../config/tenants', slug)
const access = JSON.parse(readFileSync(join(cfgDir, 'client-access.json'), 'utf8')) as ClientAccess
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)

// ---- people by any name they go by
const people = (await db.query<{ id: string; name: string; names: string[] | null }>(`select id, display_name name, array(select jsonb_array_elements_text(coalesce(metadata -> 'names', '[]'))) names from public.principals where tenant_id = $1 and kind = 'user'`, [t])).rows
const personByName = new Map<string, string>()
for (const p of people) for (const n of [p.name, ...(p.names ?? [])]) if (!personByName.has(n.toLowerCase())) personByName.set(n.toLowerCase(), p.id)
const unknownPeople = new Set<string>()
const person = (name: string) => {
  const id = personByName.get(name.toLowerCase())
  if (!id) unknownPeople.add(name)
  return id
}

// ---- a group per role, with the people holding it on the date
const roleGroup = new Map<string, string>()
for (const [roleId, role] of Object.entries(access.roles)) {
  const name = `Role: ${roleId}`
  let id = (await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and external_ref = $2`, [t, `role:${roleId}`])).rows[0]?.id
  if (!id && apply)
    id = (
      await db.query<{ id: string }>(`insert into public.principals (tenant_id, kind, display_name, external_ref, metadata) values ($1, 'group', $2, $3, $4) returning id`, [
        t,
        name,
        `role:${roleId}`,
        JSON.stringify({ role: roleId, description: role.description ?? null, origin: 'client_access' }),
      ])
    ).rows[0].id
  const holders = role.holders.filter((h) => (!h.from || h.from <= date) && (!h.to || h.to >= date)).map((h) => person(h.name)).filter((x): x is string => !!x)
  console.log(`role    ${roleId}: ${holders.length} holder(s) on ${date}`)
  if (!id) continue
  roleGroup.set(roleId, id)
  await db.query(`delete from public.principal_members where tenant_id = $1 and group_id = $2 and not (member_id = any($3::uuid[]))`, [t, id, holders])
  for (const m of holders) await db.query(`insert into public.principal_members (tenant_id, group_id, member_id) values ($1, $2, $3) on conflict do nothing`, [t, id, m])
}

// ---- one access list per distinct set of roles + people
const aclFor = new Map<string, string>()
async function acl(roles: string[], names: string[]): Promise<string | null> {
  const key = `${[...roles].sort().join(',')}|${[...names].sort().join(',')}`
  if (aclFor.has(key)) return aclFor.get(key)!
  if (!apply) return null
  const name = `client:${sha(key)}`
  const id =
    (await db.query<{ id: string }>(`select id from public.acls where tenant_id = $1 and name = $2`, [t, name])).rows[0]?.id ??
    (await db.query<{ id: string }>(`insert into public.acls (tenant_id, name, origin) values ($1, $2, $3) returning id`, [t, name, JSON.stringify({ client_access: { roles, people: names } })])).rows[0].id
  const principals = [...roles.map((r) => roleGroup.get(r)), ...names.map(person)].filter((x): x is string => !!x)
  await db.query(`delete from public.acl_entries where acl_id = $1`, [id])
  for (const p of new Set(principals)) await db.query(`insert into public.acl_entries (tenant_id, acl_id, principal_id) values ($1, $2, $3) on conflict do nothing`, [t, id, p])
  aclFor.set(key, id)
  return id
}

// ---- files → entries
const byPath = new Map<string, { roles: string[]; people: string[] }>()
const byMessage = new Map<string, { roles: string[]; people: string[] }>()
for (const f of access.files) {
  const e = { roles: f.roles, people: f.people ?? [] }
  if (f.message_id) byMessage.set(`${f.path}|${f.message_id.replace(/^<|>$/g, '')}`, e)
  else byPath.set(f.path, e)
}
const files = (
  await db.query<{ id: string; source: string; path: string; mid: string | null }>(
    // An identical copy read once (same checksum) has no evidence of its own: its copy's message id.
    `select so.id, s.name source, so.original_path path,
            (select e.locator ->> 'message_id' from public.evidence e join public.document_versions dv on dv.id = e.document_version_id
               join public.source_objects c on c.id = dv.source_object_id
              where (c.id = so.id or (so.sha256 is not null and c.sha256 = so.sha256)) and e.kind = 'email_body' limit 1) mid
     from public.source_objects so join public.sources s on s.id = so.source_id where so.tenant_id = $1 and so.deleted_at is null`,
    [t],
  )
).rows
const fullPath = (source: string, path: string) =>
  source === 'FDE interview recordings' ? `fde-captures/audio/${path}` : source === 'FDE inbox' ? `fde-captures/inbox/${path}` : source === 'Northgate handoff README' ? `company-as-found/${path}` : `company-as-found/${source}/${path}`
const midOf = new Map(files.filter((f) => f.mid).map((f) => [`${f.source}|${f.path}`, f.mid!.replace(/^<|>$/g, '')]))
let byMsg = 0
let direct = 0
let inherited = 0
const unmatched: string[] = []
const assign = new Map<string, { roles: string[]; people: string[] }>()
for (const f of files) {
  const p = fullPath(f.source, f.path)
  // An email (or its attachment): its message's entry.
  const msgFile = f.path.match(/^(mail\/[^/]+)\/messages\/[^/]+\.eml/)
  if (msgFile) {
    const mid = midOf.get(`${f.source}|${msgFile[0]}`)
    const e = mid ? byMessage.get(`${fullPath(f.source, msgFile[1])}|${mid}`) : undefined
    if (e) {
      assign.set(f.id, e)
      byMsg++
      continue
    }
  }
  if (byPath.has(p)) {
    assign.set(f.id, byPath.get(p)!)
    direct++
    continue
  }
  // Archive members and anything else inside a listed file or folder: the nearest listed ancestor.
  const parts = p.split('/')
  let hit: { roles: string[]; people: string[] } | undefined
  for (let i = parts.length - 1; i > 1 && !hit; i--) hit = byPath.get(parts.slice(0, i).join('/'))
  if (hit) {
    assign.set(f.id, hit)
    inherited++
  } else unmatched.push(p)
}
console.log(`files: ${files.length} · by message ${byMsg} · by path ${direct} · from a listed parent ${inherited} · not in the list ${unmatched.length}`)
for (const u of unmatched.slice(0, 10)) console.log(`  not in the list: ${u}`)
if (unknownPeople.size) console.log(`names not matched to a person: ${[...unknownPeople].join(', ')}`)

if (apply) {
  for (const [soId, e] of assign) {
    const aclId = await acl(e.roles, e.people)
    const reasons = JSON.stringify([{ kind: 'client', text: `Client-confirmed access: ${e.roles.join(', ') || 'no role'}${e.people.length ? `; named: ${e.people.join(', ')}` : ''}` }])
    await db.query(
      `insert into public.file_access (tenant_id, source_object_id, scope_id, sensitivity, acl_id, origin, reasons, flagged)
       select $1, $2, coalesce((select scope_id from public.file_access where source_object_id = $2), (select id from public.access_scopes where tenant_id = $1 and key = 'unsorted-intake')), 'confidential', $3, 'human', $4::jsonb, false
       on conflict (source_object_id) do update set acl_id = excluded.acl_id, origin = 'human', reasons = excluded.reasons, flagged = false`,
      [t, soId, aclId, reasons],
    )
  }
  // The list already folds sensitivity labels into each file's roles: no separate sheet-level labels.
  await db.query(`update public.source_objects set metadata = metadata - 'label_units' where tenant_id = $1 and metadata ? 'label_units'`, [t])
  console.log('applied', await applyAccess(db, t))
  // Benchmark roles ask as the role itself: a profile holding only that role (a person holding several
  // roles, Sarah Okafor as Ops Manager and CEO, would otherwise bring the other role's access along).
  const rolesPath = join(cfgDir, 'eval-roles.json')
  const evalRoles = JSON.parse(readFileSync(rolesPath, 'utf8'))
  for (const [roleId, role] of Object.entries(access.roles)) evalRoles.roles[roleId] = { profile: [`Role: ${roleId}`], why: `Client-confirmed: exactly this role's access (${role.description ?? roleId})` }
  writeFileSync(rolesPath, `${JSON.stringify(evalRoles, null, 2)}\n`)
  console.log(`acls: ${aclFor.size}; eval roles updated (${rolesPath}). Re-index search: npx tsx scripts/search-project.ts ${slug}`)
} else console.log('dry run (--apply to load)')
await db.end()
