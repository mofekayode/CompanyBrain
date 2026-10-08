// Company map: one reconciled directory of the client's people and groups,
// built from whatever directory exports were handed over (M365 users, HR
// exports, field-service users, group memberships, guest lists) and the email
// address book.
//
// 1. Find table files that look like directories.
// 2. Claude maps each file's columns to directory fields (pay and other
//    sensitive columns are never sent with values, never mapped, never read).
// 3. A deterministic merge joins rows by email (then by exact name), records
//    conflicts (e.g. terminated in HR but account still enabled), and resolves
//    managers.
// 4. People and groups are written as principals (kind user/group) with
//    stable external_ref keys, so rebuilding is idempotent.

import { type CompiledRules, DEFAULTS, rulesFor, withContext } from '../config/tenant-config'
import { structured } from '../claude'
import { chooseDelimiter, parseDelimited } from '../profiling/profile'
import type { ObjectStore } from '../storage/object-store'
import type { Sql } from '../storage/raw'
import { readableTables } from '../workbench/read-file'

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

export const PERSON_FIELDS = [
  'email',
  'aliases',
  'name',
  'first_name',
  'last_name',
  'preferred_name',
  'title',
  'department',
  'location',
  'manager',
  'status',
  'enabled',
  'end_date',
  'external_id',
  'account_type',
] as const
export const MEMBERSHIP_FIELDS = ['group', 'member_name', 'member_email'] as const
type Field = (typeof PERSON_FIELDS)[number] | (typeof MEMBERSHIP_FIELDS)[number]

export interface DirectoryMapping {
  file_id: string
  role: 'people' | 'guests' | 'group_membership' | 'none'
  system: string // e.g. "Microsoft 365", "ADP", a field-service system
  authority: number // 1 = HR system of record, 2 = identity provider, 3 = other app
  columns: Partial<Record<Field, string>>
  notes: string
}

/** Column headers whose values must never leave the file (pay, identity numbers, bank details). */
export const SENSITIVE_COLUMN = DEFAULTS.rx.sensitiveColumn // tenant override: rules.people.sensitive_columns

const MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file_id', 'role', 'system', 'authority', 'columns', 'notes'],
        properties: {
          file_id: { type: 'string' },
          role: { type: 'string', enum: ['people', 'guests', 'group_membership', 'none'] },
          system: { type: 'string' },
          authority: { type: 'integer', enum: [1, 2, 3] },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['field', 'column'],
              properties: { field: { type: 'string', enum: [...PERSON_FIELDS, ...MEMBERSHIP_FIELDS] }, column: { type: 'string' } },
            },
          },
          notes: { type: 'string' },
        },
      },
    },
  },
}

export interface TableFile {
  file_id: string
  path: string
  sheets: { name: string; header: string[]; rows: string[][] }[]
}

/** Header row = first row with at least half as many filled cells as the widest row (skips report titles). */
function withHeader(rows: string[][]): { header: string[]; rows: string[][] } {
  const nonEmpty = rows.filter((r) => r.some((c) => c?.trim()))
  const filled = nonEmpty.slice(0, 30).map((r) => r.filter((c) => c?.trim()).length)
  const widest = Math.max(1, ...filled)
  const at = Math.max(0, filled.findIndex((n) => n > 1 && n >= widest * 0.5))
  return { header: (nonEmpty[at] ?? []).map((h) => h.trim()), rows: nonEmpty.slice(at + 1) }
}

export async function readTableFile(bytes: Uint8Array, format: string, fileId: string, path: string): Promise<TableFile> {
  if (format === 'csv') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '')
    return { file_id: fileId, path, sheets: [{ name: 'CSV', ...withHeader(parseDelimited(text, chooseDelimiter(text))) }] }
  }
  const tables = (await readableTables(bytes, format, 100_000)) ?? []
  return { file_id: fileId, path, sheets: tables.map((t) => ({ name: t.name, ...withHeader(t.rows) })) }
}

/** Asks Claude what each candidate file is and which columns hold which directory fields. */
export async function mapDirectoryFiles(files: TableFile[], rules: CompiledRules = DEFAULTS): Promise<DirectoryMapping[]> {
  if (!files.length) return []
  const described = files
    .map((f) => {
      const sheet = f.sheets[0]
      const sensitive = new Set(sheet.header.map((h, i) => (rules.rx.sensitiveColumn.test(h) ? i : -1)).filter((i) => i >= 0))
      const sample = sheet.rows.slice(0, 3).map((r) => r.map((c, i) => (sensitive.has(i) ? '[withheld]' : String(c ?? '').slice(0, 60))))
      return [`file_id: ${f.file_id}`, `path: ${f.path}`, `rows: ${sheet.rows.length}`, `columns: ${JSON.stringify(sheet.header)}`, `sample rows: ${JSON.stringify(sample)}`].join('\n')
    })
    .join('\n\n')
  const out = await structured<{ files: (Omit<DirectoryMapping, 'columns'> & { columns: { field: Field; column: string }[] })[] }>({
    system:
      'You map columns of exported company directory files to a standard schema. Only use column names that appear exactly in the file. Never map pay, rate, salary, bonus, tax, identity-number, birth-date or bank columns to anything.',
    prompt: `These table files came from a company's data handoff. For each, decide:
- role: "people" (one row per person/account: an HR export, identity-provider user list, app user list), "guests" (external guest users), "group_membership" (one row per group-member pair), or "none" (not a directory).
- system: the source system in a few words (e.g. "Microsoft 365", "ADP", "Google Workspace", the field-service or ERP system, a data-room export).
- authority: 1 if this is the HR system of record (employment status, titles, managers), 2 if it is the identity provider (accounts, emails), 3 otherwise.
- columns: a list of {field, column} pairs, one for each field the file has, with the exact column name. Fields: email (work email / UPN / login), aliases (other addresses), name (full display name), first_name, last_name, preferred_name, title, department, location (office/branch/site), manager (reports-to), status (active/terminated/inactive), enabled (account enabled true/false), end_date (termination/deactivated date), external_id (employee/user number), account_type (user vs shared mailbox/room/service); for group_membership: group, member_name, member_email.
- notes: one sentence on what the file is.

${described}`,
    schema: MAPPING_SCHEMA,
    effort: 'medium',
  })
  // Defence in depth: drop any mapping to a column that only exists in the model's imagination or looks sensitive.
  return out.files.map((m) => {
    const header = new Set(files.find((f) => f.file_id === m.file_id)?.sheets[0].header ?? [])
    const columns = Object.fromEntries(m.columns.filter((c) => c.column && header.has(c.column) && !rules.rx.sensitiveColumn.test(c.column)).map((c) => [c.field, c.column]))
    return { ...m, columns }
  })
}

// ---------------------------------------------------------------------------
// Merge (pure)
// ---------------------------------------------------------------------------

export interface SourceRow {
  file_id: string
  path: string
  system: string
  authority: number
  role: DirectoryMapping['role']
  row: number
  values: Partial<Record<Field, string>>
}

export interface Person {
  key: string
  display_name: string
  names: string[]
  emails: string[]
  title: string | null
  department: string | null
  location: string | null
  manager_name: string | null
  manager_key: string | null
  status: 'active' | 'former' | 'guest' | 'service'
  status_evidence: { system: string; value: string; date?: string }[]
  systems: string[]
  external_ids: Record<string, string>
  conflicts: string[]
  sources: { file_id: string; path: string; row: number; system: string }[]
}

export interface Group {
  key: string
  name: string
  group_type: 'department' | 'location' | 'system_group'
  system: string | null
  members: string[] // person keys
}

export interface CompanyMap {
  people: Person[]
  groups: Group[]
  unresolved: { kind: 'manager' | 'member'; value: string; where: string }[]
  /** Group memberships found in the exports but not copied: guests, service accounts and former staff never inherit access through groups. */
  excluded: { group: string; person: string; status: Person['status'] }[]
}

const normEmail = (e: string | undefined) => {
  const v = (e ?? '').trim().toLowerCase().replace(/^smtp:/, '')
  return v.includes('@') && !v.includes('#ext#') ? v : null
}
export const normName = (n: string) =>
  n
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
/** "Brennan, David" → "David Brennan" */
const naturalName = (n: string) => (/^[^,]+,\s*[^,]+$/.test(n.trim()) ? n.split(',').map((s) => s.trim()).reverse().join(' ') : n.trim())

// Status words, service-account names and non-person account types come from rules.people.
/** Account types that are not a person (only these; other values a mapping picks up are ignored). */

/** Joins directory rows into people and groups. Pure: no I/O. */
export function mergeDirectory(rows: SourceRow[], internalDomains: string[], rules: CompiledRules = DEFAULTS): CompanyMap {
  const INACTIVE = rules.rx.inactive
  const SERVICE = rules.rx.serviceAccount
  const NON_PERSON_ACCOUNT = rules.rx.nonPersonAccount
  const people = new Map<string, Person & { _titleAuth: number; _deptAuth: number; _locAuth: number; _mgrAuth: number }>()
  const byEmail = new Map<string, string>()
  const byName = new Map<string, string>()
  const unresolved: CompanyMap['unresolved'] = []

  const personRows = rows.filter((r) => r.role === 'people' || r.role === 'guests')
  // Rows with an email first, so name-only rows can attach to known people.
  personRows.sort((a, b) => Number(!normEmail(a.values.email)) - Number(!normEmail(b.values.email)) || a.authority - b.authority)

  for (const r of personRows) {
    const v = r.values
    const email = normEmail(v.email)
    const aliases = (v.aliases ?? '').split(/[;,\s]+/).map(normEmail).filter((x): x is string => !!x)
    const name = naturalName(v.name || [v.preferred_name || v.first_name, v.last_name].filter(Boolean).join(' '))
    if (!email && !name) continue
    let key = (email && byEmail.get(email)) || aliases.map((a) => byEmail.get(a)).find(Boolean) || (!email && name ? byName.get(normName(name)) : undefined)
    if (!key) {
      key = email ? `person:${email}` : `person:name:${normName(name)}`
      people.set(key, {
        key,
        display_name: name || email!,
        names: [],
        emails: [],
        title: null,
        department: null,
        location: null,
        manager_name: null,
        manager_key: null,
        status: 'active',
        status_evidence: [],
        systems: [],
        external_ids: {},
        conflicts: [],
        sources: [],
        _titleAuth: 9,
        _deptAuth: 9,
        _locAuth: 9,
        _mgrAuth: 9,
      })
    }
    const p = people.get(key)!
    for (const e of [email, ...aliases]) if (e && !p.emails.includes(e)) (p.emails.push(e), byEmail.set(e, key))
    if (name && !p.names.includes(name)) p.names.push(name)
    if (name) byName.set(normName(name), key)
    if (!p.systems.includes(r.system)) p.systems.push(r.system)
    if (v.external_id) p.external_ids[r.system] = v.external_id
    p.sources.push({ file_id: r.file_id, path: r.path, row: r.row, system: r.system })
    // Most authoritative source wins for each attribute (HR > identity provider > apps); disagreements are kept.
    const take = (field: 'title' | 'department' | 'location', authKey: '_titleAuth' | '_deptAuth' | '_locAuth') => {
      const val = v[field]?.trim()
      if (!val) return
      if (p[field] && p[field] !== val && field === 'title') p.conflicts.push(`title: "${p[field]}" vs "${val}" (${r.system})`)
      if (r.authority < p[authKey] || !p[field]) {
        p[field] = val
        p[authKey] = r.authority
      }
    }
    take('title', '_titleAuth')
    take('department', '_deptAuth')
    take('location', '_locAuth')
    if (v.manager?.trim() && (r.authority < p._mgrAuth || !p.manager_name)) {
      p.manager_name = naturalName(v.manager)
      p._mgrAuth = r.authority
    }
    if (r.authority === 1 && name) p.display_name = name
    else if (!p.display_name || p.display_name === email) p.display_name = name || p.display_name
    // Status signals.
    if (r.role === 'guests') p.status_evidence.push({ system: r.system, value: 'guest' })
    if (v.status?.trim()) p.status_evidence.push({ system: r.system, value: v.status.trim(), date: v.end_date?.trim() || undefined })
    if (v.enabled?.trim()) p.status_evidence.push({ system: r.system, value: /^(true|yes|1|enabled)$/i.test(v.enabled.trim()) ? 'enabled' : 'disabled' })
    if (v.end_date?.trim() && !v.status?.trim()) p.status_evidence.push({ system: r.system, value: 'ended', date: v.end_date.trim() })
    if (v.account_type && NON_PERSON_ACCOUNT.test(v.account_type)) p.status_evidence.push({ system: r.system, value: `account type: ${v.account_type.trim()}` })
  }

  // Status: HR decides employment; other systems only add conflicts.
  for (const p of people.values()) {
    const domain = p.emails[0]?.split('@')[1]
    const hr = p.status_evidence.filter((s) => rows.some((r) => r.system === s.system && r.authority === 1))
    const hrInactive = hr.find((s) => INACTIVE.test(s.value) || s.value === 'ended')
    const anyActive = p.status_evidence.some((s) => s.value === 'enabled' || /^active$/i.test(s.value))
    const allInactive = p.status_evidence.length > 0 && p.status_evidence.filter((s) => !s.value.startsWith('account type:')).every((s) => INACTIVE.test(s.value) || s.value === 'disabled' || s.value === 'ended')
    const nonPersonAccount = p.status_evidence.find((s) => s.value.startsWith('account type:'))
    const inHr = p.systems.some((s) => rows.some((r) => r.system === s && r.authority === 1))
    if (p.status_evidence.some((s) => s.value === 'guest') || (domain && internalDomains.length && !internalDomains.includes(domain))) p.status = 'guest'
    // Someone in the HR system is a person; their mailbox may have been converted to shared after they left.
    else if (!inHr && (nonPersonAccount || SERVICE.test(p.display_name))) p.status = 'service'
    else if (hrInactive || allInactive) p.status = 'former'
    if (inHr && nonPersonAccount) p.conflicts.push(`mailbox is now a ${nonPersonAccount.value.replace('account type: ', '')} (${nonPersonAccount.system})`)
    if (p.status === 'former' && anyActive) {
      const still = p.status_evidence.filter((s) => s.value === 'enabled' || /^active$/i.test(s.value)).map((s) => s.system)
      p.conflicts.push(`left (${hrInactive ? `${hrInactive.system}: ${hrInactive.value}${hrInactive.date ? ` ${hrInactive.date}` : ''}` : 'inactive'}) but still active in ${[...new Set(still)].join(', ')}`)
    }
  }

  // Managers by name (exact normalized full name, or unique last+first initial).
  for (const p of people.values()) {
    if (!p.manager_name) continue
    const n = normName(p.manager_name)
    let key = byName.get(n)
    if (!key) {
      const [first, ...rest] = n.split(' ')
      const last = rest.at(-1)
      const candidates = [...people.values()].filter((q) => q.names.some((x) => normName(x).endsWith(` ${last}`) && normName(x).startsWith(first?.[0] ?? '#')))
      if (candidates.length === 1) key = candidates[0].key
    }
    if (key && key !== p.key) p.manager_key = key
    else unresolved.push({ kind: 'manager', value: p.manager_name, where: p.display_name })
  }

  // Groups: department and location from each person's best source; system groups from membership files.
  const groups = new Map<string, Group>()
  const excluded: CompanyMap['excluded'] = []
  const add = (key: string, name: string, type: Group['group_type'], system: string | null, member: string) => {
    if (!groups.has(key)) groups.set(key, { key, name, group_type: type, system, members: [] })
    const g = groups.get(key)!
    if (!g.members.includes(member)) g.members.push(member)
  }
  for (const p of people.values()) {
    if (p.status !== 'active') continue
    if (p.department) add(`group:department:${normName(p.department)}`, p.department, 'department', null, p.key)
    if (p.location) add(`group:location:${normName(p.location)}`, p.location, 'location', null, p.key)
  }
  for (const r of rows.filter((x) => x.role === 'group_membership')) {
    const g = r.values.group?.trim()
    if (!g) continue
    const email = normEmail(r.values.member_email)
    const key = (email && byEmail.get(email)) || (r.values.member_name && byName.get(normName(naturalName(r.values.member_name))))
    if (!key) {
      unresolved.push({ kind: 'member', value: r.values.member_email || r.values.member_name || '?', where: g })
      continue
    }
    const member = people.get(key)!
    if (member.status !== 'active') {
      excluded.push({ group: g, person: member.display_name, status: member.status })
      continue
    }
    add(`group:system:${normName(r.system)}:${normName(g)}`, g, 'system_group', r.system, key)
  }

  return {
    people: [...people.values()].map(({ _titleAuth, _deptAuth, _locAuth, _mgrAuth, ...p }) => p).sort((a, b) => a.display_name.localeCompare(b.display_name)),
    groups: [...groups.values()].sort((a, b) => a.group_type.localeCompare(b.group_type) || a.name.localeCompare(b.name)),
    unresolved,
    excluded,
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const looksLikeDirectory = (cols: string[]) =>
  cols.some((c) => /(e-?mail|upn|user ?principal|login|member)/i.test(c)) && cols.some((c) => /(name|member|user)/i.test(c))

/** Table files whose columns look like a people or membership list. */
async function candidateFiles(sql: Sql, tenantId: string) {
  const { rows } = await sql.query<{ id: string; path: string; format: string; s3_key: string; columns: string[] | null }>(
    `select so.id, so.original_path path, so.metadata -> 'profile' ->> 'format' format, so.s3_key,
            array(select jsonb_array_elements_text(coalesce(so.metadata -> 'profile' -> 'table' -> 'columns', '[]'::jsonb))) columns
     from public.source_objects so
     where so.tenant_id = $1 and so.metadata -> 'profile' ->> 'format' in ('csv', 'xlsx')
       and so.original_path !~ '/(messages|attachments)/'
       and not exists (select 1 from public.source_objects d where d.tenant_id = so.tenant_id and d.sha256 = so.sha256 and d.id < so.id)`,
    [tenantId],
  )
  return rows.filter((r) => r.format === 'xlsx' || looksLikeDirectory(r.columns ?? []))
}

/** Builds the company map from the client's directory files and writes it as principals. */
export async function buildCompanyMap(sql: Sql, store: ObjectStore, tenantId: string, opts: { remap?: boolean } = {}): Promise<Record<string, unknown>> {
  const rules = await rulesFor(sql, tenantId)
  const candidates = await candidateFiles(sql, tenantId)
  const tables: TableFile[] = []
  for (const c of candidates) {
    const bytes = await store.get(c.s3_key)
    if (!bytes) continue
    const t = await readTableFile(bytes, c.format, c.id, c.path)
    if (t.sheets[0] && looksLikeDirectory(t.sheets[0].header)) tables.push(t)
  }
  // Mappings are saved on the file the first time and reused, so rebuilds are stable and an FDE can correct them.
  const saved = (
    await sql.query<{ id: string; m: DirectoryMapping | null }>(
      `select id, metadata -> 'directory_mapping' m from public.source_objects where id = any($1::uuid[])`,
      [tables.map((t) => t.file_id)],
    )
  ).rows
  const known = new Map(saved.filter((r) => r.m && !opts.remap).map((r) => [r.id, { ...r.m!, file_id: r.id }]))
  const fresh = await mapDirectoryFiles(tables.filter((t) => !known.has(t.file_id)), rules)
  for (const m of fresh) {
    await sql.query(`update public.source_objects set metadata = jsonb_set(metadata, '{directory_mapping}', $2::jsonb) where id = $1`, [
      m.file_id,
      JSON.stringify({ ...m, mapped_at: new Date().toISOString(), mapped_by: 'ai' }),
    ])
  }
  const mappings = [...known.values(), ...fresh].filter((m) => m.role !== 'none')

  const rows: SourceRow[] = []
  for (const m of mappings) {
    const t = tables.find((x) => x.file_id === m.file_id)
    if (!t) continue
    const sheet = t.sheets[0]
    const index = Object.fromEntries(Object.entries(m.columns).map(([field, col]) => [field, sheet.header.indexOf(col!)]))
    sheet.rows.forEach((r, i) => {
      const values = Object.fromEntries(Object.entries(index).filter(([, at]) => at >= 0).map(([field, at]) => [field, r[at] ?? ''])) as SourceRow['values']
      rows.push({ file_id: m.file_id, path: t.path, system: m.system, authority: m.authority, role: m.role, row: i + 2, values })
    })
  }

  // Internal domains: the domain most people's emails are on (plus anything named like the client).
  const tenant = (await sql.query<{ name: string }>(`select name from public.tenants where id = $1`, [tenantId])).rows[0]
  const domainCounts = new Map<string, number>()
  for (const r of rows) {
    const d = normEmail(r.values.email)?.split('@')[1]
    if (d && r.role === 'people') domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1)
  }
  const token = (tenant?.name ?? '').toLowerCase().split(/[^a-z0-9]+/).find((t) => t.length >= 4)
  const top = [...domainCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const internal = [...domainCounts.keys()].filter((d) => d === top || (token && d.includes(token)))

  const map = mergeDirectory(rows, internal, rules)

  // Old-domain aliases from the email index belong to the same person.
  const aliasRows = (
    await sql.query<{ address: string; same_person_as: string[] }>(
      `select address, same_person_as from public.email_addresses where tenant_id = $1 and array_length(same_person_as, 1) > 0`,
      [tenantId],
    )
  ).rows
  for (const a of aliasRows) {
    const p = map.people.find((x) => a.same_person_as.some((s) => x.emails.includes(s)))
    if (p && !p.emails.includes(a.address)) p.emails.push(a.address)
  }

  await writeCompanyMap(sql, tenantId, map, mappings)
  return {
    files: mappings.map((m) => ({ file_id: m.file_id, path: tables.find((t) => t.file_id === m.file_id)?.path, role: m.role, system: m.system, authority: m.authority, columns: m.columns, notes: m.notes })),
    people: map.people.length,
    by_status: Object.fromEntries(['active', 'former', 'guest', 'service'].map((s) => [s, map.people.filter((p) => p.status === s).length])),
    groups: Object.fromEntries(['department', 'location', 'system_group'].map((t) => [t, map.groups.filter((g) => g.group_type === t).length])),
    conflicts: map.people.filter((p) => p.conflicts.length).length,
    unresolved: map.unresolved.length,
    excluded_memberships: map.excluded,
  }
}

async function writeCompanyMap(sql: Sql, tenantId: string, map: CompanyMap, mappings: DirectoryMapping[]) {
  const buildAt = new Date().toISOString()
  const ids = new Map<string, string>()
  const upsert = async (ref: string, kind: 'user' | 'group', name: string, metadata: Record<string, unknown>) => {
    const { rows } = await sql.query<{ id: string }>(
      `insert into public.principals (tenant_id, kind, external_ref, display_name, metadata)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, external_ref) where external_ref is not null
       do update set display_name = excluded.display_name, metadata = principals.metadata - 'stale' || excluded.metadata
       returning id`,
      [tenantId, kind, ref, name, JSON.stringify({ ...metadata, origin: 'company_map', built_at: buildAt })],
    )
    ids.set(ref, rows[0].id)
  }
  for (const p of map.people) {
    await upsert(p.key, 'user', p.display_name, {
      person: true,
      emails: p.emails,
      names: p.names,
      title: p.title,
      department: p.department,
      location: p.location,
      manager_name: p.manager_name,
      status: p.status,
      status_evidence: p.status_evidence,
      systems: p.systems,
      external_ids: p.external_ids,
      conflicts: p.conflicts,
      sources: p.sources,
    })
  }
  for (const p of map.people) {
    if (p.manager_key && ids.get(p.manager_key)) {
      await sql.query(`update public.principals set metadata = metadata || jsonb_build_object('manager_id', $2::text) where id = $1`, [ids.get(p.key), ids.get(p.manager_key)])
    }
  }
  for (const g of map.groups) {
    await upsert(g.key, 'group', g.group_type === 'system_group' ? g.name : `${g.group_type === 'department' ? 'Dept' : 'Location'}: ${g.name}`, {
      group_type: g.group_type,
      system: g.system,
      name: g.name,
    })
    const groupId = ids.get(g.key)!
    const memberIds = g.members.map((m) => ids.get(m)).filter(Boolean) as string[]
    await sql.query(`delete from public.principal_members where group_id = $1 and not (member_id = any($2::uuid[]))`, [groupId, memberIds])
    await sql.query(
      `insert into public.principal_members (tenant_id, group_id, member_id) select $1, $2, unnest($3::uuid[]) on conflict do nothing`,
      [tenantId, groupId, memberIds],
    )
  }
  // Principals from an earlier build that no longer appear are kept (ACLs may name them) but marked stale.
  await sql.query(
    `update public.principals set metadata = metadata || '{"stale": true}'
     where tenant_id = $1 and metadata ->> 'origin' = 'company_map' and metadata ->> 'built_at' <> $2`,
    [tenantId, buildAt],
  )
  await sql.query(
    `insert into public.access_audit (tenant_id, action, target, detail) values ($1, 'company_map.built', '{}', $2)`,
    [tenantId, JSON.stringify({ people: map.people.length, groups: map.groups.length, sources: mappings.map((m) => ({ file_id: m.file_id, system: m.system, role: m.role })), unresolved: map.unresolved, excluded: map.excluded })],
  )
}
