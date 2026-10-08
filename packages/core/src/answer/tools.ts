// The company-question tools (Phase 19). An answering agent, the in-app model when
// the Claude API is on, or a Claude Code session driving `scripts/ask.ts`, investigates
// with these instead of free SQL:
//
//   search_company        hybrid search over passages, entity cards and fact cards
//   get_entity            what a thing is: type, aliases, identifiers, properties, counts
//   get_relationships     who/what it is connected to
//   get_current_facts     canonical facts in force (accepted or disputed)
//   get_fact_history      every version of its facts, oldest first (what changed, when)
//   get_timeline          its events (work orders, invoices, payments, deals) by date, with notes
//   query_business_metrics revenue, payments, work-order counts, hours, by month/customer/branch
//   open_source           the full text around a cited passage
//
// Every tool takes the reader (`as`): results are limited to what that person may open.

import type { KnowledgeView } from '../access/knowledge-view'
import { humanPeriod } from '../text'
import { search } from '../search/search'
import { principalsOf } from '../search/search'
import type { Sql } from '../storage/raw'

export interface ToolCtx {
  sql: Sql
  tenantId: string
  /** Principal id of the person asking; null = FDE (sees everything). */
  as: string | null
  /** Only what was known by a cutoff (see access/knowledge-view). */
  view?: KnowledgeView
  /** The question's "today" (YYYY-MM-DD); default: the real date. */
  today?: string
}

/** Event dates arrive as 2025-03-10, 03/10/2025 or 3/9/25 depending on the system. */
export const EVENT_DATE = `(case
  when e.properties ->> 'date' ~ '^\\d{4}-\\d{2}-\\d{2}' then left(e.properties ->> 'date', 10)::date
  when e.properties ->> 'date' ~ '^\\d{1,2}/\\d{1,2}/\\d{4}$' then to_date(e.properties ->> 'date', 'MM/DD/YYYY')
  when e.properties ->> 'date' ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$' then to_date(e.properties ->> 'date', 'MM/DD/YY')
end)`

/** Search documents (cards) this reader may see, by id. FDE: all. */
export async function visible(ctx: ToolCtx, docIds: string[]): Promise<Set<string>> {
  if (ctx.view) {
    // Not yet known by the view's cutoff: hidden like a restricted file.
    const view = ctx.view
    const objs = (await ctx.sql.query<{ id: string; so: string | null }>(`select id, source_object_id so from public.search_documents where tenant_id = $1 and id = any($2::text[])`, [ctx.tenantId, docIds])).rows
    const so = new Map(objs.map((r) => [r.id, r.so]))
    docIds = docIds.filter((id) => !view.hiddenDocs.has(id) && !(so.get(id) && view.hiddenObjects.has(so.get(id)!)))
  }
  if (!ctx.as) return new Set(docIds)
  const principals = await principalsOf(ctx.sql, ctx.tenantId, ctx.as)
  const rows = (
    await ctx.sql.query<{ id: string }>(
      `select d.id from public.search_documents d where d.tenant_id = $1 and d.id = any($2::text[])
         and exists (select 1 from public.acl_entries ae where ae.acl_id = any(d.acl_ids) and ae.principal_id = any($3::uuid[]))`,
      [ctx.tenantId, docIds, principals],
    )
  ).rows
  return new Set(rows.map((r) => r.id))
}

/** Resolves a name, alias or id to one live entity (best match), or null. */
export async function resolveEntity(ctx: ToolCtx, ref: string): Promise<{ id: string; name: string; type: string } | null> {
  const rows = (
    await ctx.sql.query<{ id: string; name: string; type: string }>(
      `select e.id, e.canonical_name name, t.name type from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and (
         e.id::text = $2 or lower(e.canonical_name) = lower($2)
         or exists (select 1 from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected' and a.normalized_alias = lower(btrim($2))))
       order by (t.name <> 'Term') desc, (lower(e.canonical_name) = lower($2)) desc, (select count(*) from public.relationships r where r.source_entity_id = e.id or r.target_entity_id = e.id) desc
       limit 1`,
      [ctx.tenantId, ref],
    )
  ).rows
  // Company vocabulary ("Pump 17", "the cage") stands for something: answer about that thing.
  if (rows[0]?.type === 'Term') {
    const target = (
      await ctx.sql.query<{ id: string; name: string; type: string }>(
        `select o.id, o.canonical_name name, t.name type from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id and rt.name = 'refers_to'
         join public.entities o on o.id = r.target_entity_id and o.status in ('candidate', 'active') join public.entity_types t on t.id = o.entity_type_id
         where r.source_entity_id = $1 and r.status <> 'rejected' limit 1`,
        [rows[0].id],
      )
    ).rows[0]
    if (target) return target
  }
  if (rows[0]) return rows[0]
  const fuzzy = (
    await ctx.sql.query<{ id: string; name: string; type: string }>(
      `select e.id, e.canonical_name name, t.name type from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and coalesce(t.metadata ->> 'kind', 'thing') <> 'event' and e.canonical_name % $2
       order by similarity(e.canonical_name, $2) desc limit 1`,
      [ctx.tenantId, ref],
    )
  ).rows
  return fuzzy[0] ?? null
}

async function entityOrError(ctx: ToolCtx, ref: string) {
  const e = await resolveEntity(ctx, ref)
  if (!e) return { error: `No entity matches "${ref}". Try search_company.` }
  if (!(await visible(ctx, [`e:${e.id}`])).has(`e:${e.id}`) && ctx.as) return { error: `"${ref}" is not visible to this person.` }
  return e
}

export async function searchCompany(ctx: ToolCtx, a: { query: string; kinds?: string[]; doc_types?: ('passage' | 'entity' | 'fact')[]; as_of?: string; entity?: string; limit?: number }) {
  const entity = a.entity ? await resolveEntity(ctx, a.entity) : null
  const r = await search(ctx.sql, ctx.tenantId, a.query, {
    view: ctx.view,
    today: ctx.today,
    as: ctx.as,
    kinds: a.kinds,
    docTypes: a.doc_types,
    asOf: a.as_of,
    entityIds: entity ? [entity.id] : undefined,
    limit: Math.min(a.limit ?? 8, 15),
  })
  return {
    understood: { entities: r.understood.entities.map((e) => `${e.name} (${e.type})`), as_of: r.understood.asOf },
    results: r.hits.map((h, i) => ({
      n: i + 1,
      id: h.id,
      type: h.doc_type,
      kind: h.kind,
      title: h.title,
      where: h.doc_type === 'fact' ? factLabel(h) : citeLabel(h.path, h.citation),
      status: h.doc_type === 'fact' ? (h.is_current ? String(h.citation.status ?? 'accepted') : 'outdated') : undefined,
      valid: humanPeriod(h.valid_from, h.valid_to) || undefined,
      text: h.content.slice(0, 700),
    })),
    ms: r.timings.total_ms,
  }
}

const AUTHORITY_LABEL: Record<string, string> = {
  system_of_record: 'from company systems',
  document: 'from documents',
  official_document: 'from signed documents',
  email: 'from email',
  interview: 'from interviews',
  video: 'from video',
  photo: 'from photos',
}

/** A fact as a person reads it: "Fact on record · since Oct 19, 2026 · from interviews". */
export function factLabel(h: { valid_from?: string | null; valid_to?: string | null; authority?: string | null; citation?: Record<string, unknown> }): string {
  const status = h.citation?.status === 'disputed' ? 'Disputed fact' : 'Fact on record'
  return [status, humanPeriod(h.valid_from, h.valid_to), h.authority ? (AUTHORITY_LABEL[h.authority] ?? `from ${h.authority.replace(/_/g, ' ')}`) : ''].filter(Boolean).join(' · ')
}

/** "Pricing Policy v3.pdf, p. 1" / "Dave 3.m4a, 3:07–3:25" / "export.csv, rows 13–24" */
export function citeLabel(path: string | null, c: Record<string, unknown>): string {
  const base = path?.split('/').pop() ?? (c.kind === 'fact' ? 'Fact on record' : c.kind === 'entity' ? 'company model' : 'source')
  const t = (ms: unknown) => {
    const s = Math.floor(Number(ms) / 1000)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  if (c.start_ms != null) return `${base}, ${t(c.start_ms)}–${t(c.end_ms ?? c.start_ms)}`
  if (c.page_start) return `${base}, p. ${c.page_start}${c.page_end && c.page_end !== c.page_start ? `–${c.page_end}` : ''}`
  if (c.row_start) return `${base}, rows ${c.row_start}–${c.row_end}`
  if (c.subject) return `email “${c.subject}”${c.date ? `, ${String(c.date).slice(0, 16)}` : ''}`
  return base
}

export async function getEntity(ctx: ToolCtx, a: { entity: string }) {
  const e = await entityOrError(ctx, a.entity)
  if ('error' in e) return e
  const row = (
    await ctx.sql.query<{ properties: Record<string, unknown>; aliases: string[]; idents: string[]; merged: number }>(
      `select e.properties,
              array(select a.alias || ' (' || a.kind || ')' from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected' order by a.kind, a.alias limit 30) aliases,
              array(select i.system || ': ' || i.value from public.entity_identifiers i where i.entity_id = e.id limit 10) idents,
              (select count(*)::int from public.entities m where m.merged_into_id = e.id) merged
       from public.entities e where e.id = $1`,
      [e.id],
    )
  ).rows[0]
  const counts = (
    await ctx.sql.query<{ type: string; n: number }>(
      `select t.name type, count(*)::int n from public.relationships r
       join public.entities o on o.id = case when r.source_entity_id = $1 then r.target_entity_id else r.source_entity_id end
       join public.entity_types t on t.id = o.entity_type_id
       where (r.source_entity_id = $1 or r.target_entity_id = $1) and r.status <> 'rejected' group by 1 order by 2 desc`,
      [e.id],
    )
  ).rows
  return { ...e, aliases: row.aliases, identifiers: row.idents, merged_records: row.merged, properties: row.properties, connected: counts }
}

export async function getRelationships(ctx: ToolCtx, a: { entity: string; relationship?: string; other_type?: string; limit?: number }) {
  const e = await entityOrError(ctx, a.entity)
  if ('error' in e) return e
  const rows = (
    await ctx.sql.query<{ rel: string; dir: string; other: string; other_id: string; other_type: string; date: string | null }>(
      `select rt.name rel, case when r.source_entity_id = $1 then 'out' else 'in' end dir, o.canonical_name other, o.id other_id, t.name other_type, o.properties ->> 'date' date
       from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id
       join public.entities o on o.id = case when r.source_entity_id = $1 then r.target_entity_id else r.source_entity_id end and o.status in ('candidate', 'active')
       join public.entity_types t on t.id = o.entity_type_id
       where (r.source_entity_id = $1 or r.target_entity_id = $1) and r.status <> 'rejected' and rt.name <> 'possibly_same_as'
         and ($2::text is null or rt.name = $2) and ($3::text is null or lower(t.name) = lower($3))
       order by coalesce(t.metadata ->> 'kind', 'thing') = 'event', t.name, o.canonical_name limit $4`,
      [e.id, a.relationship ?? null, a.other_type ?? null, Math.min(a.limit ?? 40, 100)],
    )
  ).rows
  return { entity: e, links: rows.map((r) => `${r.dir === 'out' ? `${e.name} -${r.rel}→` : `← ${r.rel}-`} ${r.other} (${r.other_type}${r.date ? `, ${r.date}` : ''})`) }
}

async function facts(ctx: ToolCtx, entityId: string, where: string, params: unknown[] = []) {
  const rows = (
    await ctx.sql.query<{ id: string; predicate: string; value: string; valid_from: string | null; valid_to: string | null; status: string; authority: string | null; note: string | null }>(
      `select f.id, f.predicate, f.value #>> '{}' value, f.valid_from::text, f.valid_to::text, f.status, f.authority, f.note
       from public.facts f where f.tenant_id = $1 and f.subject_entity_id = $2 and f.metadata ->> 'layer' = 'canonical' and ${where}
       order by f.predicate, f.valid_from nulls first`,
      [ctx.tenantId, entityId, ...params],
    )
  ).rows
  const ok = await visible(ctx, rows.map((r) => `f:${r.id}`))
  return rows.filter((r) => ok.has(`f:${r.id}`))
}

export async function getCurrentFacts(ctx: ToolCtx, a: { entity: string }) {
  const e = await entityOrError(ctx, a.entity)
  if ('error' in e) return e
  const today = ctx.today ?? new Date().toISOString().slice(0, 10)
  // With a knowledge view, "current" is as known then (a later replacement may not be known yet).
  const rows = ctx.view
    ? (await facts(ctx, e.id, `f.status <> 'rejected'`)).filter((f) => ctx.view!.facts.get(`f:${f.id}`)?.is_current)
    : await facts(ctx, e.id, `f.status in ('accepted', 'disputed') and (f.valid_to is null or f.valid_to > $3::date)`, [today])
  return {
    entity: e,
    facts: rows.map((f) => ({ id: f.id, fact: `${f.predicate.replaceAll('_', ' ')}: ${f.value}`, since: f.valid_from, status: f.status, source: f.authority, note: f.note ?? undefined })),
  }
}

export async function getFactHistory(ctx: ToolCtx, a: { entity: string; topic?: string }) {
  const e = await entityOrError(ctx, a.entity)
  if ('error' in e) return e
  const rows = await facts(ctx, e.id, `f.status <> 'rejected' and ($3::text is null or f.predicate ilike '%' || $3 || '%' or f.value::text ilike '%' || $3 || '%')`, [a.topic ?? null])
  return {
    entity: e,
    history: rows.map((f) => ({ id: f.id, fact: `${f.predicate.replaceAll('_', ' ')}: ${f.value}`, from: f.valid_from, to: f.valid_to, status: f.status, source: f.authority })),
  }
}

export async function getTimeline(ctx: ToolCtx, a: { entity: string; event_types?: string[]; from?: string; to?: string; limit?: number }) {
  const e = await entityOrError(ctx, a.entity)
  if ('error' in e) return e
  const rows = (
    await ctx.sql.query<{ id: string; name: string; type: string; on_day: string | null; properties: Record<string, unknown> }>(
      `select e.id, e.canonical_name name, t.name type, ${EVENT_DATE}::text as on_day, e.properties
       from public.relationships r join public.entities e on e.id = case when r.source_entity_id = $1 then r.target_entity_id else r.source_entity_id end
       join public.entity_types t on t.id = e.entity_type_id and t.metadata ->> 'kind' = 'event'
       where (r.source_entity_id = $1 or r.target_entity_id = $1) and r.status <> 'rejected' and e.status in ('candidate', 'active')
         and ($2::text[] is null or t.name = any($2::text[]))
         and ($3::date is null or ${EVENT_DATE} >= $3::date) and ($4::date is null or ${EVENT_DATE} <= $4::date)
       order by ${EVENT_DATE} desc nulls last limit $5`,
      [e.id, a.event_types?.length ? a.event_types : null, a.from ?? null, a.to ?? null, Math.min(a.limit ?? 40, 200)],
    )
  ).rows
  const keep = (p: Record<string, unknown>) =>
    Object.entries(p)
      .filter(([k, v]) => !['source_system', 'date', 'lines'].includes(k) && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${String(v).slice(0, 220)}`)
      .join(' · ')
  return { entity: e, events: rows.map((r) => `${r.on_day ?? "?"} · ${r.type} ${r.name} · ${keep(r.properties)}`) }
}

const METRICS = {
  revenue: { type: 'Invoice', value: `sum((e.properties ->> 'amount')::numeric)`, label: 'invoiced $' },
  payments: { type: 'Payment', value: `sum((e.properties ->> 'amount')::numeric)`, label: 'received $' },
  bills: { type: 'Bill', value: `sum((e.properties ->> 'amount')::numeric)`, label: 'billed to us $' },
  work_orders: { type: 'Work Order', value: 'count(*)', label: 'work orders' },
  invoices: { type: 'Invoice', value: 'count(*)', label: 'invoices' },
} as const

/** Pre-defined, safe business metrics over the event records (no free SQL). */
export async function queryBusinessMetrics(ctx: ToolCtx, a: { metric: keyof typeof METRICS; entity?: string; from?: string; to?: string; group_by?: 'month' | 'year' | 'customer' | 'branch' | 'type' }) {
  const m = METRICS[a.metric]
  if (!m) return { error: `Unknown metric. Use one of: ${Object.keys(METRICS).join(', ')}` }
  if (ctx.as) {
    // Money and volume across the company come from finance/dispatch systems: only for people who can open those files.
    const ok = await ctx.sql.query(
      `select 1 from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = $2
       join public.source_objects so on so.id = (e.metadata -> 'source' ->> 'file_id')::uuid
       join public.acl_entries ae on ae.acl_id = so.acl_id and ae.principal_id = any($3::uuid[])
       where e.tenant_id = $1 limit 1`,
      [ctx.tenantId, m.type, await principalsOf(ctx.sql, ctx.tenantId, ctx.as)],
    )
    if (!ok.rows.length) return { error: 'This person cannot see the records behind this metric.' }
  }
  const ent = a.entity ? await resolveEntity(ctx, a.entity) : null
  if (a.entity && !ent) return { error: `No entity matches "${a.entity}".` }
  const group =
    a.group_by === 'month'
      ? `to_char(${EVENT_DATE}, 'YYYY-MM')`
      : a.group_by === 'year'
        ? `to_char(${EVENT_DATE}, 'YYYY')`
        : a.group_by === 'customer' || a.group_by === 'branch'
          ? `(select o.canonical_name from public.relationships r2 join public.entities o on o.id = r2.target_entity_id join public.entity_types ot on ot.id = o.entity_type_id
               where r2.source_entity_id = e.id and ot.name = '${a.group_by === 'customer' ? 'Customer' : 'Branch'}' limit 1)`
          : a.group_by === 'type'
            ? `coalesce(e.properties ->> 'Type', e.properties ->> 'Job Type', e.properties ->> 'Transaction type')`
            : `'all'`
  const rows = (
    await ctx.sql.query<{ g: string | null; v: string; n: number }>(
      `select ${group} g, round(${m.value}::numeric, 2)::text v, count(*)::int n
       from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = $2
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and ${EVENT_DATE} is not null
         and ($3::uuid is null or exists (select 1 from public.relationships r where r.source_entity_id = e.id and r.target_entity_id = $3))
         and ($4::date is null or ${EVENT_DATE} >= $4::date) and ($5::date is null or ${EVENT_DATE} <= $5::date)
       group by 1 order by 1 nulls last limit 120`,
      [ctx.tenantId, m.type, ent?.id ?? null, a.from ?? null, a.to ?? null],
    )
  ).rows
  return { metric: m.label, entity: ent?.name, from: a.from, to: a.to, rows: rows.map((r) => ({ group: r.g, value: Number(r.v), records: r.n })) }
}

export async function openSource(ctx: ToolCtx, a: { id: string; around?: number }) {
  // A search result id (p:…, f:…, e:…): return its full text plus neighbouring passages.
  const doc = (
    await ctx.sql.query<{ id: string; title: string; content: string; document_version_id: string | null; citation: Record<string, unknown>; acl_ids: string[] }>(
      `select id, title, content, document_version_id, citation, acl_ids from public.search_documents where tenant_id = $1 and id = $2`,
      [ctx.tenantId, a.id],
    )
  ).rows[0]
  if (!doc) return { error: `No source ${a.id}` }
  if (!(await visible(ctx, [doc.id])).has(doc.id)) return { error: 'This person cannot open that source.' }
  let neighbours: { id: string; title: string; content: string }[] = []
  if (doc.document_version_id) {
    const n = Number(doc.id.split(':').pop())
    const span = Math.min(a.around ?? 1, 3)
    const ids = Array.from({ length: span * 2 + 1 }, (_, i) => `p:${doc.document_version_id}:${n - span + i}`).filter((x) => x !== doc.id)
    neighbours = (await ctx.sql.query<{ id: string; title: string; content: string }>(`select id, title, content from public.search_documents where tenant_id = $1 and id = any($2::text[]) order by id`, [ctx.tenantId, ids])).rows
  }
  return { id: doc.id, title: doc.title, where: citeLabel((doc.citation.path as string) ?? null, doc.citation), text: doc.content, neighbours }
}

export const TOOL_SPECS = [
  { name: 'search_company', description: 'Hybrid search across the company record (documents, email, interviews, video, photos, tables) plus entity and fact cards. Understands nicknames and jargon. Start here.', input_schema: { type: 'object', properties: { query: { type: 'string' }, kinds: { type: 'array', items: { type: 'string' }, description: 'transcript_segment, video_segment, email_body, table, text, ocr, image' }, doc_types: { type: 'array', items: { type: 'string', enum: ['passage', 'entity', 'fact'] } }, as_of: { type: 'string', description: 'YYYY-MM-DD: facts valid then' }, entity: { type: 'string', description: 'only results mentioning this entity' }, limit: { type: 'integer' } }, required: ['query'] } },
  { name: 'get_entity', description: 'What a customer/person/site/asset/vendor is: aliases, identifiers, properties, what it is connected to.', input_schema: { type: 'object', properties: { entity: { type: 'string', description: 'name, nickname or id' } }, required: ['entity'] } },
  { name: 'get_relationships', description: 'Links of an entity (sites, owners, contacts, assets, branch…), optionally one relationship or other type.', input_schema: { type: 'object', properties: { entity: { type: 'string' }, relationship: { type: 'string' }, other_type: { type: 'string' }, limit: { type: 'integer' } }, required: ['entity'] } },
  { name: 'get_current_facts', description: 'Canonical facts about an entity that are in force now (accepted or disputed), with their strongest source.', input_schema: { type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'] } },
  { name: 'get_fact_history', description: 'Every version of an entity’s facts over time (what changed and when), optionally about one topic.', input_schema: { type: 'object', properties: { entity: { type: 'string' }, topic: { type: 'string' } }, required: ['entity'] } },
  { name: 'get_timeline', description: 'Events linked to an entity (work orders with tech notes, invoices, payments, deals) newest first.', input_schema: { type: 'object', properties: { entity: { type: 'string' }, event_types: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'integer' } }, required: ['entity'] } },
  { name: 'query_business_metrics', description: 'Totals from the business records: revenue, payments, bills, work_orders, invoices; by month, year, customer, branch or type; optionally for one entity and date range.', input_schema: { type: 'object', properties: { metric: { type: 'string', enum: Object.keys(METRICS) }, entity: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, group_by: { type: 'string', enum: ['month', 'year', 'customer', 'branch', 'type'] } }, required: ['metric'] } },
  { name: 'open_source', description: 'Full text of a search result (by its id) and the passages around it.', input_schema: { type: 'object', properties: { id: { type: 'string' }, around: { type: 'integer' } }, required: ['id'] } },
] as const

export async function runTool(ctx: ToolCtx, name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_company':
      return searchCompany(ctx, input as Parameters<typeof searchCompany>[1])
    case 'get_entity':
      return getEntity(ctx, input as { entity: string })
    case 'get_relationships':
      return getRelationships(ctx, input as Parameters<typeof getRelationships>[1])
    case 'get_current_facts':
      return getCurrentFacts(ctx, input as { entity: string })
    case 'get_fact_history':
      return getFactHistory(ctx, input as Parameters<typeof getFactHistory>[1])
    case 'get_timeline':
      return getTimeline(ctx, input as Parameters<typeof getTimeline>[1])
    case 'query_business_metrics':
      return queryBusinessMetrics(ctx, input as Parameters<typeof queryBusinessMetrics>[1])
    case 'open_source':
      return openSource(ctx, input as { id: string; around?: number })
    default:
      return { error: `unknown tool ${name}` }
  }
}
