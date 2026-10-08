// Shared pieces for skills: a cited report format and access-aware fact/evidence queries.
//
// A skill gathers what the company record says (facts with their timelines, events, money,
// evidence passages) through the same access rules as search, and returns a Report: sections
// of items, every item citing numbered sources. No AI is needed to build one; an LLM can
// later turn a Report into prose (gated like every other Claude call).

import { citeLabel, factLabel, type ToolCtx, visible } from '../answer/tools'
import { EVENT_DATE } from '../answer/tools'
import { fieldLabel, humanPeriod, tidy } from '../text'
import { search } from '../search/search'

export type Status = 'current' | 'outdated' | 'disputed' | 'unknown' | 'flag'

export interface Item {
  text: string
  status?: Status
  when?: string
  cites: number[]
  /** Optional extra line (e.g. a timeline "Net 30 → Net 60"). */
  detail?: string
}

export interface Section {
  heading: string
  hint?: string
  items: Item[]
  table?: { columns: string[]; rows: (string | number)[][] }
}

export interface Source {
  n: number
  id: string
  title: string
  where: string
  kind: string
}

export interface Report {
  skill: string
  title: string
  subject: string | null
  generated_at: string
  sections: Section[]
  /** What the record could not tell us, for the FDE to chase. */
  gaps: string[]
  sources: Source[]
}

/** Collects sources once and hands out their numbers. */
export class ReportBuilder {
  private sources = new Map<string, Source>()
  sections: Section[] = []
  gaps: string[] = []
  /** Facts already shown in an earlier section (a report states each thing once). */
  shown = new Set<string>()
  constructor(
    readonly ctx: ToolCtx,
    readonly skill: string,
    readonly title: string,
    readonly subject: string | null = null,
  ) {}

  async cite(docIds: string[]): Promise<number[]> {
    const missing = docIds.filter((d) => d && !this.sources.has(d))
    if (missing.length) {
      const rows = (
        await this.ctx.sql.query<{ id: string; title: string; kind: string; citation: Record<string, unknown>; valid_from: string | null; valid_to: string | null; authority: string | null }>(
          `select id, title, kind, citation, valid_from::text, valid_to::text, authority from public.search_documents where tenant_id = $1 and id = any($2::text[])`,
          [this.ctx.tenantId, missing],
        )
      ).rows
      for (const r of rows)
        this.sources.set(r.id, { n: this.sources.size + 1, id: r.id, title: r.title, where: r.citation.kind === 'fact' ? factLabel(r) : citeLabel((r.citation.path as string) ?? null, r.citation), kind: r.kind })
    }
    return docIds.map((d) => this.sources.get(d)?.n).filter((n): n is number => !!n)
  }

  section(s: Section) {
    if (s.items.length || s.table?.rows.length) this.sections.push(s)
  }

  build(): Report {
    return {
      skill: this.skill,
      title: this.title,
      subject: this.subject,
      generated_at: new Date().toISOString(),
      sections: this.sections,
      gaps: this.gaps,
      sources: [...this.sources.values()].sort((a, b) => a.n - b.n),
    }
  }
}

export interface FactRow {
  id: string
  subject_id: string
  subject: string
  subject_type: string
  predicate: string
  value: string
  summary: string | null
  kind: string | null
  status: string
  valid_from: string | null
  valid_to: string | null
  authority: string | null
  outdated_by: string | null
  timeline: string | null
}

/** Canonical facts matching a SQL condition (alias f = facts, s = subject), visible to the reader. */
export async function facts(ctx: ToolCtx, where: string, params: unknown[] = [], limit = 200): Promise<FactRow[]> {
  const rows = (
    await ctx.sql.query<FactRow>(
      `select f.id, s.id subject_id, s.canonical_name subject, st.name subject_type, f.predicate, f.value #>> '{}' value, f.metadata ->> 'summary' summary,
              f.metadata ->> 'kind' kind, f.status, f.valid_from::text, f.valid_to::text, f.authority, f.metadata ->> 'possibly_outdated_by' outdated_by,
              (select substring(d.content from 'Timeline: ([^\n]+)') from public.search_documents d where d.tenant_id = f.tenant_id and d.id = 'f:' || f.id) timeline
       from public.facts f join public.entities s on s.id = f.subject_entity_id join public.entity_types st on st.id = s.entity_type_id
       where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status <> 'rejected' and (${where})
       order by f.valid_from desc nulls last
       limit ${Number(limit)}`,
      [ctx.tenantId, ...params],
    )
  ).rows
  const ok = await visible(ctx, rows.map((r) => `f:${r.id}`))
  return rows.filter((r) => ok.has(`f:${r.id}`))
}

const today = () => new Date().toISOString().slice(0, 10)
export const isCurrent = (f: FactRow) => f.status !== 'superseded' && (!f.valid_to || f.valid_to >= today())
export const statusOf = (f: FactRow): Status =>
  f.status === 'disputed' ? 'disputed' : f.status === 'unknown' ? 'unknown' : f.outdated_by ? 'flag' : isCurrent(f) ? 'current' : 'outdated'
export const whenOf = (f: FactRow) => humanPeriod(f.valid_from, f.valid_to) || undefined
/** "pm_agreement_term" → "PM agreement term". */
export const human = fieldLabel


/** One item per fact: "payment terms: Net 60", with status, period, timeline and citation. */
export async function factItems(b: ReportBuilder, rows: FactRow[], opts: { withSubject?: boolean; repeat?: boolean } = {}): Promise<Item[]> {
  const out: Item[] = []
  for (const f of rows) {
    if (!opts.repeat && b.shown.has(f.id)) continue
    b.shown.add(f.id)
    out.push({
      text: tidy(`${opts.withSubject ? `${f.subject} · ` : ''}${human(f.predicate)}: ${f.value}`),
      status: statusOf(f),
      when: whenOf(f),
      detail: f.timeline ? tidy(f.timeline) : f.outdated_by ? 'A newer version of this rule exists elsewhere. Check it before relying on this one.' : undefined,
      cites: await b.cite([`f:${f.id}`]),
    })
  }
  return out
}

/** Evidence passages for a query (reader-filtered), as cited items. */
export async function evidenceItems(b: ReportBuilder, query: string, opts: { limit?: number; kinds?: string[]; entityIds?: string[] } = {}): Promise<Item[]> {
  const r = await search(b.ctx.sql, b.ctx.tenantId, query, { as: b.ctx.as, docTypes: ['passage'], kinds: opts.kinds, entityIds: opts.entityIds, limit: (opts.limit ?? 6) * 2, rerank: true })
  const out: Item[] = []
  // A scan and the executed PDF of the same page say the same thing: keep the first.
  const seen = new Set<string>()
  const sig = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120)
  for (const h of r.hits) {
    if (out.length >= (opts.limit ?? 6) || seen.has(sig(h.snippet)) || seen.has(h.id)) continue
    seen.add(sig(h.snippet)).add(h.id)
    const body = h.snippet.replace(/[«»]/g, '').replace(/[_=*]{3,}|-{4,}/g, ' ').replace(/(^|\s)#{1,6}\s/g, ' ').replace(/\s+/g, ' ').replace(/From: .*?Subject: .*?(?=(…|\s[A-Z][a-z]+[,:]?\s|$))/, '').trim()
    out.push({ text: `${h.title}: ${body.slice(0, 260)}`, cites: await b.cite([h.id]) })
  }
  return out
}

/** Events linked to an entity (work orders, invoices…) with normalised dates. */
export async function events(ctx: ToolCtx, entityId: string, types?: string[]) {
  return (
    await ctx.sql.query<{ id: string; name: string; type: string; day: string | null; properties: Record<string, unknown> }>(
      `select e.id, e.canonical_name name, t.name type, ${EVENT_DATE}::text as day, e.properties
       from public.relationships r join public.entities e on e.id = case when r.source_entity_id = $1 then r.target_entity_id else r.source_entity_id end
       join public.entity_types t on t.id = e.entity_type_id and t.metadata ->> 'kind' = 'event'
       where (r.source_entity_id = $1 or r.target_entity_id = $1) and r.status <> 'rejected' and e.status in ('candidate', 'active') and ($2::text[] is null or t.name = any($2::text[]))
       order by ${EVENT_DATE} nulls last`,
      [entityId, types?.length ? types : null],
    )
  ).rows
}

/** Can the reader see the system records behind an event type (finance exports etc.)? */
export async function canSeeRecords(ctx: ToolCtx, type: string): Promise<boolean> {
  if (!ctx.as) return true
  const { principalsOf } = await import('../search/search')
  const r = await ctx.sql.query(
    `select 1 from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = $2
     join public.source_objects so on so.id = (e.metadata -> 'source' ->> 'file_id')::uuid
     join public.acl_entries ae on ae.acl_id = so.acl_id and ae.principal_id = any($3::uuid[])
     where e.tenant_id = $1 limit 1`,
    [ctx.tenantId, type, await principalsOf(ctx.sql, ctx.tenantId, ctx.as)],
  )
  return r.rows.length > 0
}

/** Sum of an event amount by year for one entity (null entity = whole company). Empty when the reader can't see the records. */
export async function moneyByYear(ctx: ToolCtx, type: string, entityId: string | null) {
  if (!(await canSeeRecords(ctx, type))) return []
  return (
    await ctx.sql.query<{ year: string; total: string; n: number }>(
      `select to_char(${EVENT_DATE}, 'YYYY') as year, round(sum((e.properties ->> 'amount')::numeric), 0)::text total, count(*)::int n
       from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = $2
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and ${EVENT_DATE} is not null
         and ($3::uuid is null or exists (select 1 from public.relationships r where r.source_entity_id = e.id and r.target_entity_id = $3))
       group by 1 order by 1`,
      [ctx.tenantId, type, entityId],
    )
  ).rows
}

export const money = (v: string | number) => `$${Number(v).toLocaleString('en-US')}`
