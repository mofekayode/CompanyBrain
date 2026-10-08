// The company model as an external scorer reads it: entities (with aliases and system ids),
// relationships and dated facts with their sources, translated into a neutral vocabulary. Under a
// knowledge view, only what was known by the cutoff is exported.

import { type KnowledgeView, tenantFiles } from '../access/knowledge-view'
import type { ToolCtx } from '../answer/tools'
import { normalize } from '../search/linker'
import { refsFor } from './contract'

/** Our entity types → the export's. Types not listed (events, vocabulary, accounts) aren't exported. */
const TYPE: Record<string, string> = {
  Customer: 'customer',
  Person: 'employee',
  Vendor: 'vendor',
  Branch: 'location',
  Site: 'site',
  Asset: 'asset',
  'Customer Contact': 'contact',
  'PM Agreement': 'contract',
}

/** System names → identifier keys (by the entity's export type where a system has one key per kind). */
function identKey(system: string, type: string): string {
  const s = system.toLowerCase()
  if (s.startsWith('quickbooks')) return type === 'customer' ? 'qbo_customer_id' : `qbo_${type}_id`
  if (s === 'fieldline') return type === 'customer' ? 'fieldline_customer_id' : type === 'asset' ? 'customer_tag' : `fieldline_${type}_id`
  if (s === 'hubspot') return type === 'customer' ? 'hubspot_company_id' : `hubspot_${type}_id`
  if (s === 'email') return 'email'
  if (s === 'serial') return 'serial_number'
  if (s === 'adp') return 'adp_file_number'
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** Our relationship types → the export's, with direction (flip = the export reads it the other way). */
const REL: Record<string, { rel: string; flip?: boolean }> = {
  reports_to: { rel: 'reports_to' },
  account_owner: { rel: 'account_manager_of', flip: true },
  located_at: { rel: 'located_at' },
  belongs_to: { rel: 'site_of' },
  works_at: { rel: 'works_at' },
  based_at: { rel: 'works_at' },
  agreement_with: { rel: 'contract_with' },
  contact_owned_by: { rel: 'holds_relationship_with', flip: true },
}

/** Our fact predicates → the export's keys (anything else is "other", with the predicate in the note). */
const KEYS: [RegExp, string][] = [
  [/^(job )?title$|^role$|^position$/, 'title'],
  [/legal name|renamed/, 'legal_name'],
  [/account (owner|manager)/, 'account_manager'],
  [/payment terms/, 'payment_terms'],
  [/standard labor rate|labor rate/, 'standard_labor_rate'],
  [/preferred vendor/, 'preferred_vendor'],
  [/discount approv/, 'discount_approval'],
  [/(hot job|dispatch) fee/, 'hot_job_dispatch_fee'],
  [/branch manager/, 'branch_manager'],
]
/** Keys where the system of record (CRM owner history, the rate table) is the authority. */
const SYSTEM_WINS = new Set(['account_manager', 'standard_labor_rate'])
const keyOf = (predicate: string) => KEYS.find(([re]) => re.test(predicate.replaceAll('_', ' ').toLowerCase()))?.[1] ?? 'other'

const day = (d: string | null) => (d ? d.slice(0, 10) : null)

export async function exportOntology(ctx: ToolCtx & { view: KnowledgeView }, slug: string) {
  const { sql, tenantId, view } = ctx
  const known = (id: string) => !view.hiddenDocs.has(`e:${id}`)
  const ents = (
    await sql.query<{ id: string; name: string; type: string; properties: Record<string, unknown> }>(
      `select e.id, e.canonical_name name, t.name type, e.properties from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and t.name = any($2::text[])`,
      [tenantId, Object.keys(TYPE)],
    )
  ).rows.filter((e) => known(e.id))
  const ids = ents.map((e) => e.id)
  const [aliases, idents, rels, facts] = await Promise.all([
    sql
      .query<{ entity_id: string; alias: string; is_ambiguous: boolean }>(
        `select entity_id, alias, coalesce(is_ambiguous, false) is_ambiguous from public.entity_aliases where tenant_id = $1 and status <> 'rejected' and entity_id = any($2::uuid[])`,
        [tenantId, ids],
      )
      .then((r) => r.rows),
    sql.query<{ entity_id: string; system: string; value: string }>(`select entity_id, system, value from public.entity_identifiers where entity_id = any($1::uuid[])`, [ids]).then((r) => r.rows),
    sql
      .query<{ rel: string; src: string; dst: string; valid_from: string | null; valid_to: string | null }>(
        `select rt.name rel, r.source_entity_id src, r.target_entity_id dst, r.valid_from::text, r.valid_to::text
         from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id
         where r.tenant_id = $1 and r.status not in ('rejected', 'superseded') and rt.name = any($2::text[])`,
        [tenantId, Object.keys(REL)],
      )
      .then((r) => r.rows),
    sql
      .query<{ id: string; subject: string; predicate: string; value: string; valid_from: string | null; valid_to: string | null; note: string | null; summary: string | null }>(
        `select f.id, f.subject_entity_id subject, f.predicate, f.value #>> '{}' value, f.valid_from::text, f.valid_to::text, f.note, f.metadata ->> 'summary' summary
         from public.facts f where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status <> 'rejected'`,
        [tenantId],
      )
      .then((r) => r.rows.filter((f) => !view.hiddenDocs.has(`f:${f.id}`))),
  ])
  // Facts about things outside those types (a fee, a labor rate, a company rule) still count:
  // their subjects are exported as policies so the knowledge isn't dropped.
  const missing = [...new Set(facts.map((f) => f.subject))].filter((id) => !ids.includes(id) && known(id))
  if (missing.length) {
    const extra = (
      await sql.query<{ id: string; name: string; type: string; properties: Record<string, unknown> }>(
        `select e.id, e.canonical_name name, t.name type, e.properties from public.entities e join public.entity_types t on t.id = e.entity_type_id
         where e.id = any($1::uuid[]) and e.status in ('candidate', 'active') and (t.metadata ->> 'kind') is distinct from 'event'`,
        [missing],
      )
    ).rows
    for (const e of extra) {
      ents.push({ ...e, type: '__policy' })
      ids.push(e.id)
    }
  }
  const exported = new Set(ids)
  const typeOf = new Map(ents.map((e) => [e.id, TYPE[e.type] ?? 'policy']))

  // A name on more than one exported thing is ambiguous: flag it rather than assert one owner.
  const owners = new Map<string, Set<string>>()
  for (const a of aliases) {
    const n = normalize(a.alias)
    if (!owners.has(n)) owners.set(n, new Set())
    owners.get(n)!.add(a.entity_id)
  }
  const aliasesOf = new Map<string, (string | { value: string; ambiguous: true })[]>()
  for (const a of aliases) {
    const n = normalize(a.alias)
    if (view.hiddenAliases.has(n)) continue
    const list = aliasesOf.get(a.entity_id) ?? []
    if (list.some((x) => normalize(typeof x === 'string' ? x : x.value) === n)) continue
    list.push(a.is_ambiguous || owners.get(n)!.size > 1 ? { value: a.alias, ambiguous: true } : a.alias)
    aliasesOf.set(a.entity_id, list)
  }
  const identsOf = new Map<string, Record<string, string>>()
  for (const i of idents) {
    const m = identsOf.get(i.entity_id) ?? {}
    let k = identKey(i.system, typeOf.get(i.entity_id) ?? 'entity')
    for (let n = 2; m[k] !== undefined && m[k] !== i.value; n++) k = `${identKey(i.system, typeOf.get(i.entity_id) ?? 'entity')}_${n}`
    m[k] = i.value
    identsOf.set(i.entity_id, m)
  }

  const files = await tenantFiles(sql, tenantId, slug)
  const factRefs = await refsFor(
    ctx,
    files,
    facts.map((f) => `f:${f.id}`),
    5,
  )
  const systemFacts = await systemOfRecordFacts(
    ctx,
    files,
    ents,
    facts.map((f) => ({ entity: f.subject, key: keyOf(f.predicate) })).filter((c) => !SYSTEM_WINS.has(c.key)),
  )
  // Where the system of record gives a dated series for a key, it is the value; reviewed facts on
  // that key stay as notes. A branch manager is a fact about a branch, not about the person.
  const periods = new Map<string, { from: string | null; to: string | null }[]>()
  for (const f of systemFacts) periods.set(`${f.entity}:${f.key}`, [...(periods.get(`${f.entity}:${f.key}`) ?? []), { from: f.valid_from, to: f.valid_to }])
  // Periods overlap unless one ends before the other starts (open ends run forever).
  const overlaps = (a: { from: string | null; to: string | null }, b: { from: string | null; to: string | null }) => !((a.to && b.from && a.to < b.from) || (b.to && a.from && b.to < a.from))
  const exportKey = (f: (typeof facts)[number]) => {
    const k = keyOf(f.predicate)
    // A reviewed fact that fills a gap in the system's series (an owner the CRM left blank) stays.
    if (SYSTEM_WINS.has(k) && (periods.get(`${f.subject}:${k}`) ?? []).some((p) => overlaps(p, { from: day(f.valid_from), to: day(f.valid_to) }))) return 'other'
    if (k === 'branch_manager' && typeOf.get(f.subject) !== 'location') return 'other'
    return k
  }
  return {
    as_of: view.cutoff,
    entities: ents.map((e) => {
      const { source_system: _s, ...attributes } = e.properties
      return { id: e.id, type: TYPE[e.type] ?? 'policy', name: e.name, aliases: aliasesOf.get(e.id) ?? [], identifiers: identsOf.get(e.id) ?? {}, attributes }
    }),
    relationships: rels
      .filter((r) => exported.has(r.src) && exported.has(r.dst) && (!r.valid_from || r.valid_from <= view.cutoff))
      .map((r) => {
        const m = REL[r.rel]
        return { src: m.flip ? r.dst : r.src, rel: m.rel, dst: m.flip ? r.src : r.dst, valid_from: day(r.valid_from), valid_to: day(r.valid_to) }
      }),
    facts: [
      ...facts
        .filter((f) => exported.has(f.subject))
        .map((f) => {
          const key = exportKey(f)
          const note = [key === 'other' ? `${f.predicate.replaceAll('_', ' ')}: ${f.value}` : null, f.summary, f.note].filter(Boolean).join(' · ') || undefined
          return {
            entity: f.subject,
            key,
            value: f.value,
            valid_from: day(f.valid_from),
            valid_to: day(f.valid_to),
            sources: [...new Set((factRefs.get(`f:${f.id}`) ?? []).map((r) => r.source))],
            note,
          }
        }),
      ...systemFacts.filter((f) => exported.has(f.entity)),
    ],
  }
}

interface ExportFact {
  entity: string
  key: string
  value: string
  valid_from: string | null
  valid_to: string | null
  sources: string[]
  note?: string
}

/**
 * Facts the systems of record state directly (account owners over time from the CRM's owner
 * changes, branch labor rates with their effective dates, terms, titles, branch managers), added
 * where the reviewed facts don't already cover that key for that thing.
 */
async function systemOfRecordFacts(
  ctx: ToolCtx & { view: KnowledgeView },
  files: Map<string, { path: string | null }>,
  ents: { id: string; name: string; type: string; properties: Record<string, unknown> }[],
  covered: { entity: string; key: string }[],
): Promise<ExportFact[]> {
  const { sql, tenantId, view } = ctx
  const have = new Set(covered.map((c) => `${c.entity}:${c.key}`))
  const out: ExportFact[] = []
  const add = (f: ExportFact) => {
    if (!have.has(`${f.entity}:${f.key}`)) out.push(f)
  }
  const fileOf = (id: string | null | undefined) => (id && !view.hiddenObjects.has(id) ? (files.get(id)?.path ?? null) : null)
  const srcOf = new Map(
    (await sql.query<{ id: string; file_id: string | null }>(`select id, metadata #>> '{source,file_id}' file_id from public.entities where id = any($1::uuid[])`, [ents.map((e) => e.id)])).rows.map(
      (r) => [r.id, fileOf(r.file_id)],
    ),
  )
  const sources = (id: string) => [srcOf.get(id)].filter((x): x is string => !!x)

  // Account owners over time: each CRM owner change starts an owner's period, which ends at the next one.
  const changes = (
    await sql.query<{ customer: string; owner: string; at: string; file_id: string | null }>(
      `select c.target_entity_id customer, o.canonical_name owner, left(ev.properties ->> 'date', 10) at, ev.metadata #>> '{source,file_id}' file_id
       from public.entities ev join public.entity_types t on t.id = ev.entity_type_id and t.name = 'Account Owner Change'
       join public.relationships c on c.source_entity_id = ev.id join public.relationship_types ct on ct.id = c.relationship_type_id and ct.name = 'owner_change_for'
       join public.relationships n on n.source_entity_id = ev.id join public.relationship_types nt on nt.id = n.relationship_type_id and nt.name = 'new_owner'
       join public.entities o on o.id = n.target_entity_id
       where ev.tenant_id = $1 and ev.properties ->> 'date' is not null and left(ev.properties ->> 'date', 10) <= $2
       order by 1, 3`,
      [tenantId, view.cutoff],
    )
  ).rows
  const byCustomer = new Map<string, typeof changes>()
  for (const ch of changes) byCustomer.set(ch.customer, [...(byCustomer.get(ch.customer) ?? []), ch])
  // "(No owner)" in the CRM is a gap, not an owner.
  const blank = (o: string) => /^\(?(no owner|none|unassigned)\)?$/i.test(o.trim())
  for (const [customer, list] of byCustomer)
    list.forEach((ch, i) =>
      blank(ch.owner)
        ? undefined
        : add({
            entity: customer,
            key: 'account_manager',
            value: ch.owner,
            valid_from: ch.at,
            valid_to: list[i + 1]?.at ?? null,
            sources: [fileOf(ch.file_id)].filter((x): x is string => !!x),
            note: 'CRM company owner change',
          }),
    )
  // Current owner where the CRM recorded no change.
  const owners = (
    await sql.query<{ customer: string; owner: string }>(
      `select r.source_entity_id customer, p.canonical_name owner from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id and rt.name = 'account_owner'
       join public.entities p on p.id = r.target_entity_id where r.tenant_id = $1 and r.status not in ('rejected', 'superseded')`,
      [tenantId],
    )
  ).rows
  for (const o of owners)
    if (!byCustomer.has(o.customer)) add({ entity: o.customer, key: 'account_manager', value: o.owner, valid_from: null, valid_to: null, sources: sources(o.customer), note: 'CRM company owner' })
  for (const k of [...byCustomer.keys(), ...owners.map((o) => o.customer)]) have.add(`${k}:account_manager`)

  // Branch labor rates with their effective dates (field-service rate table).
  const branches = ents.filter((e) => e.type === 'Branch')
  const rates = (
    await sql.query<{ name: string; rate: string; from: string | null; to: string | null; file_id: string | null }>(
      `select e.canonical_name name, e.properties ->> 'Rate' rate, e.properties ->> 'Effective From' "from", e.properties ->> 'Effective To' "to", e.metadata #>> '{source,file_id}' file_id
       from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = 'Labor Rate'
       where e.tenant_id = $1 and e.canonical_name ilike 'Standard · %' and e.properties ? 'Effective From'`,
      [tenantId],
    )
  ).rows
  for (const r of rates) {
    const where = r.name.split(' · ')[1]?.toLowerCase() ?? ''
    const branch = branches.find((b) => b.name.toLowerCase().includes(where))
    if (branch && r.from && r.from <= view.cutoff)
      add({
        entity: branch.id,
        key: 'standard_labor_rate',
        value: r.rate,
        valid_from: r.from,
        valid_to: r.to,
        sources: [fileOf(r.file_id)].filter((x): x is string => !!x),
        note: 'Field-service rate table',
      })
  }
  for (const b of branches) if (rates.some((r) => b.name.toLowerCase().includes(r.name.split(' · ')[1]?.toLowerCase() ?? '#'))) have.add(`${b.id}:standard_labor_rate`)

  // Terms and titles as the records state them today.
  for (const e of ents) {
    const terms = e.properties.Terms ?? e.properties.terms
    if ((e.type === 'Customer' || e.type === 'Vendor') && typeof terms === 'string' && terms.trim())
      add({ entity: e.id, key: 'payment_terms', value: terms.trim(), valid_from: null, valid_to: null, sources: sources(e.id), note: 'Terms on the system record' })
    const title = e.properties['Job Title'] ?? e.properties.title ?? e.properties.Title
    if (e.type === 'Person' && typeof title === 'string' && title.trim())
      add({ entity: e.id, key: 'title', value: title.trim(), valid_from: null, valid_to: null, sources: sources(e.id), note: 'Title on the directory record' })
  }
  // Branch managers: people whose title names the branch.
  for (const p of ents.filter((e) => e.type === 'Person' && /branch manager/i.test(String(e.properties.title ?? e.properties['Job Title'] ?? '')) && e.properties.status !== 'former')) {
    const place = String(p.properties.title ?? p.properties['Job Title'])
      .split(/[-–]/)
      .pop()!
      .trim()
      .toLowerCase()
    const branch = branches.find((b) => b.name.toLowerCase().includes(place))
    if (branch) add({ entity: branch.id, key: 'branch_manager', value: p.name, valid_from: null, valid_to: null, sources: sources(p.id), note: 'Directory title' })
  }
  return out
}
