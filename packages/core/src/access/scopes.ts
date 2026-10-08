// Access scopes: which files go in which bucket, who each bucket is for, and how
// sensitive it is.
//
// 1. Claude proposes scopes and path rules from the evidence an FDE would use:
//    the handoff's folder tree, the source systems' permission exports
//    (SharePoint folders, sharing links, mailbox delegations, data-room access),
//    and the company map's groups. Every scope and rule says why.
// 2. A rules engine assigns every file (longest matching path prefix wins;
//    mailbox messages and archive members follow their container's path).
// 3. Content detectors escalate files that hold personal data (SSNs, bank
//    details, birth dates, people's pay) into a restricted scope and flag them.
// 4. applyAccess turns scopes into ACLs: held scopes have no entries (admins
//    only); released scopes hold their audience; per-file grants get their own
//    ACL. ACLs are pushed down to documents, passages and email threads.

import { structured } from '../claude'
import type { ObjectStore } from '../storage/object-store'
import type { Sql } from '../storage/raw'
import { type CompiledRules, DEFAULTS, rulesFor, withContext } from '../config/tenant-config'
import { readTableFile } from './directory'

export type Sensitivity = 'internal' | 'confidential' | 'restricted'
const RANK: Record<Sensitivity, number> = { internal: 0, confidential: 1, restricted: 2 }

export interface ScopeProposal {
  key: string
  name: string
  description: string
  sensitivity: Sensitivity
  hidden: boolean
  audience: { ref: string; why: string }[]
  evidence: string[]
}

export interface ScopeRule {
  source: string
  path_prefix: string
  scope_key: string
  why: string
}

export interface AccessProposal {
  scopes: ScopeProposal[]
  rules: ScopeRule[]
  default_scope_key: string
  personal_data_scope_key: string
  notes: string[]
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scopes', 'rules', 'default_scope_key', 'personal_data_scope_key', 'notes'],
  properties: {
    scopes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'name', 'description', 'sensitivity', 'hidden', 'audience', 'evidence'],
        properties: {
          key: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          sensitivity: { type: 'string', enum: ['internal', 'confidential', 'restricted'] },
          hidden: { type: 'boolean' },
          audience: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['ref', 'why'], properties: { ref: { type: 'string' }, why: { type: 'string' } } },
          },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'path_prefix', 'scope_key', 'why'],
        properties: { source: { type: 'string' }, path_prefix: { type: 'string' }, scope_key: { type: 'string' }, why: { type: 'string' } },
      },
    },
    default_scope_key: { type: 'string' },
    personal_data_scope_key: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

// ---------------------------------------------------------------------------
// Rules engine (pure)
// ---------------------------------------------------------------------------

export interface FileRow {
  id: string
  source: string
  path: string
}

/** Longest matching path prefix within the file's source wins; '' matches the whole source. */
export function matchRule(file: FileRow, rules: ScopeRule[]): ScopeRule | null {
  let best: ScopeRule | null = null
  for (const r of rules) {
    if (r.source !== file.source) continue
    const prefix = r.path_prefix.replace(/^\/+|\/+$/g, '')
    const ok = prefix === '' || file.path === prefix || file.path.startsWith(`${prefix}/`)
    if (ok && (!best || prefix.length > best.path_prefix.replace(/^\/+|\/+$/g, '').length)) best = r
  }
  return best
}

// ---------------------------------------------------------------------------
// Personal-data detectors (pure)
// ---------------------------------------------------------------------------

export interface DetectorHit {
  kind: 'ssn' | 'bank_account' | 'birth_date' | 'personal_pay'
  text: string
}

// Detector patterns come from the tenant's personal_data rules.

/** Finds personal data in a passage. Tables count as personal pay only when a person column sits next to a pay column. */
export function detectPersonalData(content: string, kind: string, rules: CompiledRules = DEFAULTS): DetectorHit[] {
  const { ssn: SSN, bank: BANK, dob: DOB, personColumn: PERSON_COLUMN, payColumn: PAY_COLUMN } = rules.rx
  const hits: DetectorHit[] = []
  const ssn = content.match(SSN)
  if (ssn) hits.push({ kind: 'ssn', text: `${ssn[0].slice(0, 3)}-**-****` })
  const bank = content.match(BANK)
  if (bank) hits.push({ kind: 'bank_account', text: bank[0].replace(/\d(?=\d{4})/g, '*') })
  const dob = content.match(DOB)
  if (dob) hits.push({ kind: 'birth_date', text: dob[0].replace(/\d/g, '#') })
  if (kind === 'table') {
    const header = (content.split('\n').find((l) => l.includes('|')) ?? '').split('|').map((h) => h.trim())
    const pay = header.find((h) => PAY_COLUMN.test(h))
    if (pay && header.some((h) => PERSON_COLUMN.test(h))) hits.push({ kind: 'personal_pay', text: `column "${pay}" next to people` })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Proposal (Claude)
// ---------------------------------------------------------------------------

async function proposalContext(sql: Sql, store: ObjectStore, tenantId: string) {
  const rules = await rulesFor(sql, tenantId)
  // Folder tree: two levels per source pile, with file counts.
  const tree = (
    await sql.query<{ source: string; top: string; sub: string | null; n: number }>(
      `select s.name source, split_part(so.original_path, '/', 1) top,
              case when so.original_path like '%/%/%' then split_part(so.original_path, '/', 2) end sub, count(*)::int n
       from public.source_objects so join public.sources s on s.id = so.source_id
       where so.tenant_id = $1 and so.parent_id is null group by 1, 2, 3 order by 1, 2, 3`,
      [tenantId],
    )
  ).rows
  const treeText = tree.reduce((acc, r, i) => {
    const head = i === 0 || tree[i - 1].source !== r.source ? `\n[${r.source}]\n` : ''
    return `${acc}${head}  ${r.top}${r.sub ? `/${r.sub}` : ''} (${r.n})\n`
  }, '')

  // Permission exports: table files whose columns talk about permissions, access, sharing or delegation.
  const permFiles = (
    await sql.query<{ id: string; path: string; source: string; s3_key: string; format: string }>(
      `select so.id, so.original_path path, s.name source, so.s3_key, so.metadata -> 'profile' ->> 'format' format
       from public.source_objects so join public.sources s on s.id = so.source_id
       where so.tenant_id = $1 and so.parent_id is null and so.metadata -> 'profile' ->> 'format' in ('csv', 'xlsx')
         and (so.original_path ~* '(permission|access|sharing|guest|admin_roles|delegat)'
              or exists (select 1 from jsonb_array_elements_text(coalesce(so.metadata -> 'profile' -> 'table' -> 'columns', '[]')) c
                         where c ~* '(permission|access rights|sharing|link type|inheritance)'))`,
      [tenantId],
    )
  ).rows
  let permText = ''
  for (const f of permFiles) {
    const bytes = await store.get(f.s3_key)
    if (!bytes) continue
    const t = await readTableFile(bytes, f.format, f.id, f.path)
    const sheet = t.sheets[0]
    if (!sheet) continue
    const keep = sheet.header.map((h, i) => (rules.rx.sensitiveColumn.test(h) ? -1 : i)).filter((i) => i >= 0)
    const lines = [keep.map((i) => sheet.header[i]).join(' | '), ...sheet.rows.slice(0, 300).map((r) => keep.map((i) => (r[i] ?? '').slice(0, 120)).join(' | '))]
    permText += `\n### ${f.source} / ${f.path} (file ${f.id}, ${sheet.rows.length} rows)\n${lines.join('\n')}\n`
  }

  // Company map: groups with sizes, and people with a title (for naming owners of personal piles).
  const groups = (
    await sql.query<{ name: string; type: string; n: number }>(
      `select p.display_name name, p.metadata ->> 'group_type' type, count(m.member_id)::int n
       from public.principals p left join public.principal_members m on m.group_id = p.id
       where p.tenant_id = $1 and p.kind = 'group' and p.metadata ->> 'origin' = 'company_map' and not p.metadata ? 'stale'
       group by 1, 2 order by 2, 1`,
      [tenantId],
    )
  ).rows
  const people = (
    await sql.query<{ name: string; email: string | null; title: string | null; department: string | null; status: string }>(
      `select display_name name, metadata -> 'emails' ->> 0 email, metadata ->> 'title' title, metadata ->> 'department' department, metadata ->> 'status' status
       from public.principals where tenant_id = $1 and kind = 'user' and metadata ->> 'origin' = 'company_map' and not metadata ? 'stale'
       order by 1`,
      [tenantId],
    )
  ).rows
  // Containers whose members each need an owner: mailboxes (and other per-person archives).
  const mailboxes = (
    await sql.query<{ source: string; path: string; messages: number; owner: string | null }>(
      `select s.name source, so.original_path path,
              (select count(*)::int from public.source_objects c where c.parent_id = so.id) messages,
              (select p.display_name || ' <' || e || '>' from public.principals p, jsonb_array_elements_text(coalesce(p.metadata -> 'emails', '[]')) e
               where p.tenant_id = so.tenant_id and p.kind = 'user' and split_part(e, '@', 1) = regexp_replace(so.original_filename, '\.mbox$', '') limit 1) owner
       from public.source_objects so join public.sources s on s.id = so.source_id
       where so.tenant_id = $1 and so.parent_id is null and so.metadata -> 'profile' ->> 'format' = 'mbox'
       order by so.original_path`,
      [tenantId],
    )
  ).rows
  const mailboxText = mailboxes.map((m) => `- [${m.source}] ${m.path} (${m.messages} messages) owner: ${m.owner ?? 'no person with this address (shared/role mailbox?)'}`).join('\n')
  return { treeText, permText, groups, people, mailboxText, sources: [...new Set(tree.map((r) => r.source))] }
}

export async function proposeAccess(sql: Sql, store: ObjectStore, tenantId: string): Promise<AccessProposal> {
  const rules = await rulesFor(sql, tenantId)
  const ctx = await proposalContext(sql, store, tenantId)
  const groupText = ctx.groups.map((g) => `- ${g.name} [${g.type}] (${g.n} members)`).join('\n')
  const peopleText = ctx.people.map((p) => `- ${p.name} <${p.email ?? '?'}>: ${p.title ?? '?'}, ${p.department ?? '?'} (${p.status})`).join('\n')
  return structured<AccessProposal>({
    system: `You are a forward-deployed engineer designing access control for a company's knowledge base, built from a messy data handoff. Copy the access the company INTENDED (from its permission exports), not accidental leaks: anonymous links, over-broad shares and stale grants are risks to note, not access to copy. Personal data (HR, pay, payroll, terminations, personal mailboxes) is restricted to the people who own it or whose job it is. When the exports say nothing about a pile, pick the narrowest sensible audience; admins can always widen it later. Handbooks and all-staff policies are for everyone, even when they sit in an HR folder.${withContext(rules)}`,
    prompt: `Design access scopes for this handoff.

## Source piles and folders (file counts)
${ctx.treeText}

## Permission exports from the source systems
${ctx.permText || '(none found)'}

## Mailboxes (each needs its own rule)
${ctx.mailboxText || '(none)'}

## Groups in the company map (use these exact names in audiences)
${groupText}

## People (use exact names or emails in audiences)
${peopleText}

## Output
- scopes: as many as needed (typically 10 to 40, including one per mailbox). Each: key (kebab-case), name, one-sentence description, sensitivity (internal = anyone at the company; confidential = a department, team or branch; restricted = named people: HR, pay, payroll, terminations, deal/board material, personal mailboxes, admin/permission exports), hidden (true for restricted scopes whose file names themselves are sensitive), audience (refs to the exact group names or people above, each with why), evidence (the export rows or folders this is based on, quoted briefly).
- rules: map EVERY source pile to a scope with path_prefix "" (whole pile), then add narrower rules for folders that differ. source must be the exact pile name in brackets above; path_prefix is a folder path inside it, as shown. Give EVERY mailbox listed above its own rule (path_prefix = the mailbox path) and a scope: a personal mailbox belongs to its owner plus delegates from the mailbox permissions export (a former employee's mailbox to whoever it was handed to); a shared/role mailbox (dispatch@, billing@, branch addresses) to the group that holds access to it. Personal OneDrives belong to their owner plus explicit shares (not anonymous links).
- default_scope_key: for files no rule covers.
- personal_data_scope_key: the restricted scope that files found to contain SSNs, bank details, birth dates or people's pay are moved into.
- notes: leaks and risks you deliberately did NOT copy (anonymous links, stale guest access, over-sharing, sensitive files in the wrong place), and anything the client should decide.`,
    schema: PROPOSAL_SCHEMA,
    effort: 'high',
    maxTokens: 48000,
  })
}

// ---------------------------------------------------------------------------
// Writing scopes and file assignments
// ---------------------------------------------------------------------------

/** Resolves an audience ref (group name, person name or email) to principal ids. */
async function resolveRefs(sql: Sql, tenantId: string, refs: string[]): Promise<Map<string, string | null>> {
  const { rows } = await sql.query<{ id: string; name: string; emails: string[] | null; group_name: string | null }>(
    `select id, display_name name, array(select jsonb_array_elements_text(coalesce(metadata -> 'emails', '[]'))) emails, metadata ->> 'name' group_name
     from public.principals where tenant_id = $1 and not metadata ? 'stale'`,
    [tenantId],
  )
  const norm = (s: string) => s.toLowerCase().replace(/^(dept|location|group):\s*/, '').replace(/\s+/g, ' ').trim()
  const out = new Map<string, string | null>()
  for (const ref of refs) {
    const r = norm(ref.replace(/<.*?>/, '').trim())
    const email = ref.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase()
    const hit =
      (email && rows.find((p) => p.emails?.includes(email))) ||
      rows.find((p) => norm(p.name) === r) ||
      rows.find((p) => p.group_name && norm(p.group_name) === r) ||
      rows.find((p) => norm(p.name).startsWith(r) || r.startsWith(norm(p.name)))
    out.set(ref, hit?.id ?? null)
  }
  return out
}

/**
 * Writes a proposal: scopes (new ones start held; existing ones keep their status),
 * audiences, and one file_access row per file. Human decisions are never overwritten.
 */
export async function writeProposal(sql: Sql, tenantId: string, proposal: AccessProposal): Promise<Record<string, unknown>> {
  const refs = await resolveRefs(sql, tenantId, proposal.scopes.flatMap((s) => s.audience.map((a) => a.ref)))
  const scopeIds = new Map<string, { id: string; acl_id: string; sensitivity: Sensitivity }>()
  for (const s of proposal.scopes) {
    const existing = (await sql.query<{ id: string; acl_id: string; origin: string }>(`select id, acl_id, origin from public.access_scopes where tenant_id = $1 and key = $2`, [tenantId, s.key])).rows[0]
    let id = existing?.id
    let aclId = existing?.acl_id
    if (!existing) {
      aclId = (await sql.query<{ id: string }>(`insert into public.acls (tenant_id, name, origin) values ($1, $2, $3) returning id`, [tenantId, `scope:${s.key}`, JSON.stringify({ scope: s.key })])).rows[0].id
      id = (
        await sql.query<{ id: string }>(
          `insert into public.access_scopes (tenant_id, key, name, description, sensitivity, hidden, acl_id, origin, rules, evidence)
           values ($1, $2, $3, $4, $5, $6, $7, 'ai', $8, $9) returning id`,
          [tenantId, s.key, s.name, s.description, s.sensitivity, s.hidden, aclId, JSON.stringify(proposal.rules.filter((r) => r.scope_key === s.key)), JSON.stringify(s.evidence)],
        )
      ).rows[0].id
    } else if (existing.origin === 'ai') {
      await sql.query(
        `update public.access_scopes set name = $2, description = $3, sensitivity = $4, hidden = $5, rules = $6, evidence = $7 where id = $1`,
        [id, s.name, s.description, s.sensitivity, s.hidden, JSON.stringify(proposal.rules.filter((r) => r.scope_key === s.key)), JSON.stringify(s.evidence)],
      )
    }
    scopeIds.set(s.key, { id: id!, acl_id: aclId!, sensitivity: s.sensitivity })
    if (!existing || existing.origin === 'ai') {
      const members = s.audience.map((a) => ({ id: refs.get(a.ref), why: a.why })).filter((a): a is { id: string; why: string } => !!a.id)
      await sql.query(`delete from public.access_scope_audience where scope_id = $1 and not (principal_id = any($2::uuid[]))`, [id, members.map((m) => m.id)])
      for (const m of members) {
        await sql.query(
          `insert into public.access_scope_audience (tenant_id, scope_id, principal_id, why) values ($1, $2, $3, $4)
           on conflict (scope_id, principal_id) do update set why = excluded.why`,
          [tenantId, id, m.id, m.why],
        )
      }
    }
  }

  // Assign every file.
  const files = (
    await sql.query<{ id: string; source: string; path: string }>(
      `select so.id, s.name source, so.original_path path from public.source_objects so join public.sources s on s.id = so.source_id where so.tenant_id = $1`,
      [tenantId],
    )
  ).rows
  const human = new Set(
    (await sql.query<{ id: string }>(`select source_object_id id from public.file_access where tenant_id = $1 and origin = 'human'`, [tenantId])).rows.map((r) => r.id),
  )
  const fallback = scopeIds.get(proposal.default_scope_key) ?? [...scopeIds.values()][0]
  const rows = files
    .filter((f) => !human.has(f.id))
    .map((f) => {
      const rule = matchRule(f, proposal.rules.filter((r) => scopeIds.has(r.scope_key)))
      const scope = rule ? scopeIds.get(rule.scope_key)! : fallback
      return {
        source_object_id: f.id,
        scope_id: scope.id,
        sensitivity: scope.sensitivity,
        acl_id: scope.acl_id,
        origin: 'rule',
        reasons: [rule ? { kind: 'rule', text: `${rule.source}${rule.path_prefix ? ` / ${rule.path_prefix}` : ''}: ${rule.why}` } : { kind: 'rule', text: 'no rule matched: default scope' }],
      }
    })
  for (let i = 0; i < rows.length; i += 500) {
    await sql.query(
      `insert into public.file_access (tenant_id, source_object_id, scope_id, sensitivity, acl_id, origin, reasons, flagged)
       select $1, x.source_object_id, x.scope_id, x.sensitivity, x.acl_id, x.origin, x.reasons, false
       from jsonb_to_recordset($2::jsonb) as x(source_object_id uuid, scope_id uuid, sensitivity text, acl_id uuid, origin text, reasons jsonb)
       on conflict (source_object_id) do update set scope_id = excluded.scope_id, sensitivity = excluded.sensitivity, acl_id = excluded.acl_id,
         origin = excluded.origin, reasons = excluded.reasons, flagged = false`,
      [tenantId, JSON.stringify(rows.slice(i, i + 500))],
    )
  }
  // AI scopes from an earlier proposal that are no longer proposed and hold nothing are removed.
  const stale = (
    await sql.query<{ id: string; acl_id: string }>(
      `select sc.id, sc.acl_id from public.access_scopes sc
       where sc.tenant_id = $1 and sc.origin = 'ai' and sc.status = 'held' and not (sc.key = any($2::text[]))
         and not exists (select 1 from public.file_access fa where fa.scope_id = sc.id)
         and not exists (select 1 from public.access_requests r where r.scope_id = sc.id)
         and not exists (select 1 from public.access_grants g where g.scope_id = sc.id)`,
      [tenantId, proposal.scopes.map((x) => x.key)],
    )
  ).rows
  // (Their ACL rows stay until applyAccess has repointed every file; unreferenced ACLs are harmless.)
  for (const st of stale) await sql.query(`delete from public.access_scopes where id = $1`, [st.id])
  const escalated = await escalatePersonalData(sql, tenantId, proposal.personal_data_scope_key)
  await sql.query(`insert into public.access_audit (tenant_id, action, target, detail) values ($1, 'scopes.proposed', '{}', $2)`, [
    tenantId,
    JSON.stringify({ scopes: proposal.scopes.length, rules: proposal.rules.length, notes: proposal.notes, escalated }),
  ])
  return {
    scopes: proposal.scopes.length,
    rules: proposal.rules.length,
    removed_stale_scopes: stale.length,
    files: rows.length,
    unresolved_audience: [...refs.entries()].filter(([, id]) => !id).map(([ref]) => ref),
    escalated,
    notes: proposal.notes,
  }
}

/** Moves files whose passages hold personal data into the restricted personal-data scope, flagged for review. */
export async function escalatePersonalData(sql: Sql, tenantId: string, scopeKey: string): Promise<number> {
  const rules = await rulesFor(sql, tenantId)
  const target = (await sql.query<{ id: string; acl_id: string; sensitivity: Sensitivity }>(`select id, acl_id, sensitivity from public.access_scopes where tenant_id = $1 and key = $2`, [tenantId, scopeKey])).rows[0]
  if (!target) return 0
  const passages = (
    await sql.query<{ source_object_id: string; kind: string; content: string; sensitivity: Sensitivity; origin: string }>(
      `select dv.source_object_id, e.kind, e.content, fa.sensitivity, fa.origin
       from public.evidence e
       join public.document_versions dv on dv.id = e.document_version_id
       join public.documents d on d.id = dv.document_id and d.current_version_id = dv.id
       join public.file_access fa on fa.source_object_id = dv.source_object_id
       where e.tenant_id = $1 and fa.scope_id <> $2 and fa.origin <> 'human' and fa.sensitivity <> 'restricted'
         and (e.content ~ '\\d{3}-\\d{2}-\\d{4}' or e.content ~* '(routing|account)\\s*(number|no|#)' or e.content ~* '(date of birth|dob|birth ?date)'
              or (e.kind = 'table' and e.content ~* '(rate|pay|salary|wage|bonus|comp)'))`,
      [tenantId, target.id],
    )
  ).rows
  const hits = new Map<string, DetectorHit[]>()
  for (const p of passages) {
    const found = detectPersonalData(p.content, p.kind, rules)
    if (found.length) hits.set(p.source_object_id, [...(hits.get(p.source_object_id) ?? []), ...found])
  }
  for (const [id, found] of hits) {
    const kinds = [...new Set(found.map((h) => h.kind))]
    await sql.query(
      `update public.file_access set scope_id = $2, acl_id = $3, sensitivity = 'restricted', origin = 'detector', flagged = true,
         reasons = reasons || $4::jsonb
       where source_object_id = $1`,
      [id, target.id, target.acl_id, JSON.stringify([{ kind: 'detector', text: `contains ${kinds.join(', ').replace(/_/g, ' ')} (${found.slice(0, 3).map((h) => h.text).join('; ')}): moved to restricted` }])],
    )
  }
  return hits.size
}

// ---------------------------------------------------------------------------
// Applying access: scopes → ACL entries → files → documents, passages, threads
// ---------------------------------------------------------------------------

/** Recomputes every ACL from scopes, audiences and grants, and pushes it down to everything extracted. */
export async function applyAccess(sql: Sql, tenantId: string): Promise<{ scopes: number; file_acls: number; files: number }> {
  const scopes = (await sql.query<{ id: string; acl_id: string; status: string }>(`select id, acl_id, status from public.access_scopes where tenant_id = $1`, [tenantId])).rows
  for (const s of scopes) {
    // Held: no entries (only acl.bypass roles see it). Released: audience + people granted the whole scope.
    await sql.query(`delete from public.acl_entries where acl_id = $1`, [s.acl_id])
    if (s.status === 'released') {
      await sql.query(
        `insert into public.acl_entries (tenant_id, acl_id, principal_id)
         select $1::uuid, $2::uuid, principal_id from public.access_scope_audience where scope_id = $3
         union select $1::uuid, $2::uuid, principal_id from public.access_grants where scope_id = $3
         on conflict do nothing`,
        [tenantId, s.acl_id, s.id],
      )
    } else {
      await sql.query(
        `insert into public.acl_entries (tenant_id, acl_id, principal_id)
         select $1::uuid, $2::uuid, principal_id from public.access_grants where scope_id = $3 on conflict do nothing`,
        [tenantId, s.acl_id, s.id],
      )
    }
  }

  // Files with individual grants get their own ACL: their scope's entries + grantees.
  const granted = (
    await sql.query<{ source_object_id: string; scope_id: string; scope_acl: string; file_acl: string | null }>(
      `select distinct g.source_object_id, fa.scope_id, sc.acl_id scope_acl,
              (select a.id from public.acls a where a.tenant_id = $1 and a.name = 'file:' || g.source_object_id) file_acl
       from public.access_grants g join public.file_access fa on fa.source_object_id = g.source_object_id
       join public.access_scopes sc on sc.id = fa.scope_id
       where g.tenant_id = $1 and g.source_object_id is not null`,
      [tenantId],
    )
  ).rows
  for (const g of granted) {
    const aclId =
      g.file_acl ??
      (await sql.query<{ id: string }>(`insert into public.acls (tenant_id, name, origin) values ($1, $2, $3) returning id`, [tenantId, `file:${g.source_object_id}`, JSON.stringify({ file: g.source_object_id, scope: g.scope_id })])).rows[0].id
    await sql.query(`delete from public.acl_entries where acl_id = $1`, [aclId])
    await sql.query(
      `insert into public.acl_entries (tenant_id, acl_id, principal_id)
       select $1::uuid, $2::uuid, principal_id from public.acl_entries where acl_id = $3
       union select $1::uuid, $2::uuid, principal_id from public.access_grants where source_object_id = $4
       on conflict do nothing`,
      [tenantId, aclId, g.scope_acl, g.source_object_id],
    )
    await sql.query(`update public.file_access set acl_id = $2 where source_object_id = $1`, [g.source_object_id, aclId])
  }
  // Files without grants use their scope's ACL.
  await sql.query(
    `update public.file_access fa set acl_id = sc.acl_id from public.access_scopes sc
     where fa.tenant_id = $1 and sc.id = fa.scope_id and fa.acl_id <> sc.acl_id
       and not exists (select 1 from public.access_grants g where g.source_object_id = fa.source_object_id)`,
    [tenantId],
  )

  // Push down: files → document versions → documents → passages; email threads from their messages.
  const files = await sql.query(
    `update public.source_objects so set acl_id = fa.acl_id from public.file_access fa
     where fa.source_object_id = so.id and so.tenant_id = $1 and so.acl_id is distinct from fa.acl_id returning so.id`,
    [tenantId],
  )
  await sql.query(
    `update public.document_versions dv set acl_id = so.acl_id from public.source_objects so
     where dv.source_object_id = so.id and dv.tenant_id = $1 and dv.acl_id is distinct from so.acl_id`,
    [tenantId],
  )
  await sql.query(
    `update public.documents d set acl_id = dv.acl_id from public.document_versions dv
     where d.current_version_id = dv.id and d.tenant_id = $1 and d.acl_id is distinct from dv.acl_id`,
    [tenantId],
  )
  await sql.query(
    `update public.evidence e set acl_id = dv.acl_id from public.document_versions dv
     where e.document_version_id = dv.id and e.tenant_id = $1 and e.acl_id is distinct from dv.acl_id`,
    [tenantId],
  )
  await sql.query(
    `update public.email_threads t set acl_id = x.acl_id, mixed_acl = x.mixed
     from (select m.thread_id, case when count(distinct d.acl_id) = 1 then min(d.acl_id::text)::uuid end acl_id, count(distinct d.acl_id) > 1 mixed
           from public.email_thread_messages m join public.documents d on d.id = m.document_id
           where m.tenant_id = $1 group by m.thread_id) x
     where t.id = x.thread_id and (t.acl_id is distinct from x.acl_id or t.mixed_acl <> x.mixed)`,
    [tenantId],
  )
  return { scopes: scopes.length, file_acls: granted.length, files: (files as unknown as { rows: unknown[] }).rows.length }
}
