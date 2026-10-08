// Typeahead for the client app: as someone types, the things they might mean, grouped by kind, // customers, people, sites, assets… (by name, nickname or former name), files by name, and email
// by subject. Only what the reader can open. Built for speed (trigram indexes, no embeddings).

import type { ToolCtx } from '../answer/tools'
import { visible } from '../answer/tools'
import { principalsOf } from '../search/search'

export interface SuggestEntity {
  id: string
  name: string
  type: string
  /** "Big Blue · formerly Blue Ridge Mills", a job title, a customer… */
  detail: string | null
  /** The nickname or alias the query matched, when it wasn't the name. */
  matched: string | null
}
export interface SuggestFile {
  id: string
  name: string
  path: string
  kind: string
}
export interface SuggestEmail {
  id: string
  subject: string
  file_id: string | null
  date: string | null
}
export interface Suggestions {
  query: string
  entities: SuggestEntity[]
  files: SuggestFile[]
  emails: SuggestEmail[]
  ms: number
}

const JUNK = /^(thumbs\.db|desktop\.ini|\.ds_store|~\$.*)$/i
const like = (q: string) => `%${q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`
const KIND = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['mp4', 'mov', 'm4v'].includes(ext)) return 'video'
  if (['m4a', 'mp3', 'wav'].includes(ext)) return 'interview'
  if (['jpg', 'jpeg', 'png', 'heic'].includes(ext)) return 'photo'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'spreadsheet'
  if (ext === 'eml') return 'email'
  return 'document'
}

export async function suggest(ctx: ToolCtx, raw: string, opts: { skipEntities?: boolean } = {}): Promise<Suggestions> {
  const t0 = performance.now()
  const q = raw.trim()
  if (q.length < 2) return { query: q, entities: [], files: [], emails: [], ms: 0 }
  const principals = ctx.as ? await principalsOf(ctx.sql, ctx.tenantId, ctx.as) : null
  const pattern = like(q)
  const lower = q.toLowerCase()

  const none = { rows: [] as never[] }
  const [byName, byAlias, files, emails] = await Promise.all([
    opts.skipEntities ? none : ctx.sql.query<{ id: string; name: string; type: string; facts: number; props: Record<string, unknown> }>(
      `select e.id, e.canonical_name name, t.name type, e.properties props,
              (select count(*)::int from public.facts f where f.subject_entity_id = e.id and f.metadata ->> 'layer' = 'canonical' and f.status <> 'rejected') facts
       from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and lower(e.canonical_name) like $2
         and (t.metadata ->> 'kind') is distinct from 'event' and t.name <> 'Term'
       limit 60`,
      [ctx.tenantId, pattern],
    ),
    opts.skipEntities ? none : ctx.sql.query<{ id: string; name: string; type: string; alias: string; kind: string; facts: number; props: Record<string, unknown> }>(
      // A term ("Big Blue") stands for what it refers to; other aliases belong to their entity.
      `select coalesce(target.id, e.id) id, coalesce(target.canonical_name, e.canonical_name) name, coalesce(tt.name, t.name) type,
              a.alias, a.kind, coalesce(target.properties, e.properties) props,
              (select count(*)::int from public.facts f where f.subject_entity_id = coalesce(target.id, e.id) and f.metadata ->> 'layer' = 'canonical' and f.status <> 'rejected') facts
       from public.entity_aliases a join public.entities e on e.id = a.entity_id and e.status in ('candidate', 'active')
       join public.entity_types t on t.id = e.entity_type_id
       left join lateral (select o.* from public.relationships r join public.entities o on o.id = r.target_entity_id
                          where t.name = 'Term' and r.source_entity_id = e.id and r.status <> 'rejected' limit 1) target on true
       left join public.entity_types tt on tt.id = target.entity_type_id
       where a.tenant_id = $1 and a.status <> 'rejected' and lower(a.alias) like $2 and a.kind <> 'system_spelling'
         and (t.metadata ->> 'kind') is distinct from 'event'
       limit 40`,
      [ctx.tenantId, pattern],
    ),
    ctx.sql.query<{ id: string; name: string; path: string }>(
      `select so.id, so.original_filename name, so.original_path path
       from public.source_objects so left join public.file_access fa on fa.source_object_id = so.id
       where so.tenant_id = $1 and so.deleted_at is null and lower(so.original_filename) like $2 and so.original_filename !~* '\\.eml$'
         and ($3::uuid[] is null or exists (select 1 from public.acl_entries ae where ae.acl_id = coalesce(fa.acl_id, so.acl_id) and ae.principal_id = any($3::uuid[])))
       order by (lower(so.original_filename) like $4) desc, length(so.original_filename)
       limit 12`,
      [ctx.tenantId, pattern, principals, `${lower.replace(/[%_\\]/g, '\\$&')}%`],
    ),
    ctx.sql.query<{ id: string; title: string; source_object_id: string | null; observed_at: string | null }>(
      `select d.id, d.title, d.source_object_id, d.observed_at::text
       from public.search_documents d
       where d.tenant_id = $1 and d.doc_type = 'passage' and d.kind = 'email_body' and lower(d.title) like $2
         and ($3::uuid[] is null or exists (select 1 from public.acl_entries ae where ae.acl_id = any(d.acl_ids) and ae.principal_id = any($3::uuid[])))
       order by d.observed_at desc nulls last
       limit 12`,
      [ctx.tenantId, pattern, principals],
    ),
  ])

  // Rank: exact > starts with > a word starts with > contains; then how much the record knows about it.
  const score = (text: string) => {
    const t = text.toLowerCase()
    return t === lower ? 4 : t.startsWith(lower) ? 3 : new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t) ? 2 : 1
  }
  const best = new Map<string, SuggestEntity & { score: number }>()
  const detailOf = (type: string, props: Record<string, unknown>) =>
    type === 'Person' || type === 'Customer Contact' ? ((props['Job Title'] ?? props.title ?? props.Title ?? null) as string | null) : null
  for (const r of byName.rows) {
    const s = score(r.name) * 10 + Math.log1p(r.facts)
    const cur = best.get(r.id)
    if (!cur || cur.score < s) best.set(r.id, { id: r.id, name: r.name, type: r.type, detail: detailOf(r.type, r.props), matched: null, score: s })
  }
  for (const r of byAlias.rows) {
    const s = score(r.alias) * 10 + Math.log1p(r.facts) - 0.5
    const cur = best.get(r.id)
    const label = r.kind === 'former_name' ? `formerly ${r.alias}` : `“${r.alias}”`
    if (!cur || cur.score < s) best.set(r.id, { id: r.id, name: r.name, type: r.type, detail: detailOf(r.type, r.props) ?? label, matched: r.alias, score: s })
  }
  let entities = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 24)
  const ok = entities.length ? await visible(ctx, entities.map((e) => `e:${e.id}`)) : new Set<string>()
  entities = entities.filter((e) => ok.has(`e:${e.id}`)).slice(0, 10)

  // One row per email thread subject.
  const seen = new Set<string>()
  const mail: SuggestEmail[] = []
  for (const r of emails.rows) {
    const subject = r.title.split(/ [-·] /)[0].replace(/^(re|fwd?):\s*/gi, '').trim()
    if (seen.has(subject.toLowerCase())) continue
    seen.add(subject.toLowerCase())
    mail.push({ id: r.id, subject: r.title.split(/ [-·] /)[0], file_id: r.source_object_id, date: r.observed_at?.slice(0, 10) ?? null })
    if (mail.length >= 4) break
  }

  return {
    query: q,
    entities: entities.map(({ score: _s, ...e }) => e),
    files: files.rows.filter((f, i, all) => !JUNK.test(f.name) && all.findIndex((x) => x.name === f.name) === i).slice(0, 5).map((f) => ({ ...f, kind: KIND(f.name) })),
    emails: mail,
    ms: Math.round(performance.now() - t0),
  }
}

export interface DirectoryEntry {
  id: string
  name: string
  type: string
  detail: string | null
  /** Nicknames, jargon and former names (not system misspellings). */
  aliases: { alias: string; kind: string }[]
  /** How much the record knows about it (ranking tiebreak). */
  weight: number
}

/**
 * Everything this reader can look up by name (customers, people, sites, assets, vendors…), small
 * enough to send once so typeahead runs in the browser with no network. Vocabulary terms resolve
 * to what they mean ("Big Blue" → Blue Ridge).
 */
export async function directory(ctx: ToolCtx): Promise<DirectoryEntry[]> {
  const rows = (
    await ctx.sql.query<{ id: string; name: string; type: string; detail: string | null; aliases: { alias: string; kind: string }[] | null; weight: number }>(
      `with things as (
         select e.id, e.canonical_name name, t.name type, coalesce(e.properties ->> 'Job Title', e.properties ->> 'title') detail
         from public.entities e join public.entity_types t on t.id = e.entity_type_id
         where e.tenant_id = $1 and e.status in ('candidate', 'active') and (t.metadata ->> 'kind') is distinct from 'event' and t.name <> 'Term'),
       own as (
         select a.entity_id id, a.alias, a.kind from public.entity_aliases a
         where a.tenant_id = $1 and a.status <> 'rejected' and a.kind <> 'system_spelling'),
       via_terms as (
         select r.target_entity_id id, term.canonical_name alias, 'jargon' kind
         from public.entities term join public.entity_types tt on tt.id = term.entity_type_id and tt.name = 'Term'
         join public.relationships r on r.source_entity_id = term.id and r.status <> 'rejected'
         where term.tenant_id = $1 and term.status in ('candidate', 'active'))
       , named as (select id, jsonb_agg(distinct jsonb_build_object('alias', alias, 'kind', kind)) aliases from (select * from own union select * from via_terms) x group by id)
       , weights as (select subject_entity_id id, count(*)::int n from public.facts where tenant_id = $1 and metadata ->> 'layer' = 'canonical' and status <> 'rejected' group by 1)
       select th.id, th.name, th.type, th.detail, named.aliases, coalesce(weights.n, 0) weight
       from things th left join named using (id) left join weights using (id)`,
      [ctx.tenantId],
    )
  ).rows
  const ok = await visible(ctx, rows.map((r) => `e:${r.id}`))
  return rows.filter((r) => ok.has(`e:${r.id}`)).map((r) => ({ ...r, aliases: (r.aliases ?? []).filter((a) => a.alias.toLowerCase() !== r.name.toLowerCase()) }))
}
