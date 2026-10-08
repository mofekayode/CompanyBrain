// A knowledge view: what the Brain knew by a given date. Like access, it's enforced at the gates
// every answer passes through (search, fact lookups, file lookups), so nothing slips around it.
//
//   cutoff  only evidence available on or before this day counts
//   today   the "now" of the question (what "current" means)
//
// When a file became available comes from the landing manifest: a source delivered in a dated
// batch ("2026-10-10-handoff") arrived that day; otherwise each file has its own date (the date in
// its name, else its recording time, else its modified time). Facts survive only if some of their
// evidence was available; a fact replaced later by something not yet known counts as current
// again, and its history stops where the knowledge does.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { timelineText } from '../ontology/timeline'
import { normalize } from '../search/linker'
import type { Sql } from '../storage/raw'

export interface KnowledgeView {
  cutoff: string
  today: string
  /** Files (source objects) not yet available. */
  hiddenObjects: Set<string>
  /** Search documents not yet knowable (passages of hidden files, facts with no available evidence, records known only from them). */
  hiddenDocs: Set<string>
  /** Nicknames and jargon (normalized) that nothing available by the cutoff uses: not known yet. */
  hiddenAliases: Set<string>
  /** For surviving facts: whether each is current on `today`, and its history as far as it was known. */
  facts: Map<string, { is_current: boolean; timeline: string | null; mixed: boolean }>
}

interface ManifestSource {
  name: string
  root: string
  batch?: string
}

/** The landing manifest for a tenant (config/tenants/<slug>/sources.json). */
const manifestFile = (slug: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../../../config/tenants', slug, 'sources.json'), 'utf8')) as { corpus_root?: string; sources: ManifestSource[] }
export const manifest = (slug: string): ManifestSource[] => manifestFile(slug).sources
const corpusRoot = (slug: string) => manifestFile(slug).corpus_root ?? `${slug}-data`

const DAY = /(20\d\d-\d\d-\d\d)/

/** When a file became available to the Brain (YYYY-MM-DD), or null if it isn't the client's evidence at all. */
export function availableOn(src: ManifestSource | undefined, file: { original_path: string; source_modified_at: string | null; captured_at: string | null }): string | null {
  if (!src) return null
  const batch = src.batch?.match(DAY)?.[1]
  if (batch) return batch
  return file.original_path.match(DAY)?.[1] ?? file.captured_at?.slice(0, 10) ?? file.source_modified_at?.slice(0, 10) ?? null
}

/** A file's path as delivered, relative to the corpus root ("company-as-found/Phone uploads/IMG_6418.MOV"). */
export function deliveredPath(src: ManifestSource | undefined, originalPath: string): string | null {
  if (!src) return null
  return /\.[a-z0-9]{2,5}$/i.test(src.root) && !originalPath.includes('/') && src.root.endsWith(originalPath) ? src.root : `${src.root}/${originalPath}`
}

export interface FileInfo {
  id: string
  source: string
  path: string | null
  available: string | null
}

const filesCache = new Map<string, { at: number; files: Map<string, FileInfo> }>()

/** Every file of a tenant with its delivered path and availability date (children inherit their top-level file's). */
export async function tenantFiles(sql: Sql, tenantId: string, slug: string): Promise<Map<string, FileInfo>> {
  const hit = filesCache.get(tenantId)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.files
  const bySource = new Map(manifest(slug).map((s) => [s.name, s]))
  const rows = (
    await sql.query<{ id: string; parent_id: string | null; source: string; original_path: string; source_modified_at: string | null; captured_at: string | null }>(
      `select so.id, so.parent_id, s.name source, so.original_path, so.source_modified_at::text,
              so.metadata #>> '{profile,media,captured_at}' captured_at
       from public.source_objects so join public.sources s on s.id = so.source_id where so.tenant_id = $1`,
      [tenantId],
    )
  ).rows
  const byId = new Map(rows.map((r) => [r.id, r]))
  const top = (r: (typeof rows)[number]) => {
    let cur = r
    for (let i = 0; i < 10 && cur.parent_id && byId.has(cur.parent_id); i++) cur = byId.get(cur.parent_id)!
    return cur
  }
  // Where the delivered corpus is on disk, a file that isn't in it (a test upload) isn't evidence.
  const corpus = join(import.meta.dirname, '../../../..', corpusRoot(slug))
  const onDisk = existsSync(corpus)
  const files = new Map<string, FileInfo>()
  for (const r of rows) {
    const root = top(r)
    const src = bySource.get(r.source)
    const path = deliveredPath(src, root.original_path)
    const real = !onDisk || (!!path && existsSync(join(corpus, path)))
    files.set(r.id, { id: r.id, source: r.source, path, available: real ? availableOn(src, root) : null })
  }
  filesCache.set(tenantId, { at: Date.now(), files })
  return files
}

interface FactDoc {
  id: string
  title: string
  content: string
  valid_from: string | null
  valid_to: string | null
  status: string | null
}
/** Everything that depends only on the cutoff (the slow part, computed once per cutoff). */
interface Base {
  hiddenObjects: Set<string>
  hiddenDocs: Set<string>
  hiddenAliases: Set<string>
  mixed: Set<string>
  groups: FactDoc[][]
}

const baseCache = new Map<string, Promise<Base>>()
const viewCache = new Map<string, KnowledgeView>()

async function base(sql: Sql, tenantId: string, slug: string, cutoff: string): Promise<Base> {
  const files = await tenantFiles(sql, tenantId, slug)
  const hiddenObjects = new Set([...files.values()].filter((f) => !f.available || f.available > cutoff).map((f) => f.id))
  const hidden = [...hiddenObjects]

  const [docs, aliases, facts] = await Promise.all([
    // Passages of hidden files; facts whose evidence is all in hidden files.
    sql
      .query<{ id: string }>(
        `select d.id from public.search_documents d
         where d.tenant_id = $1 and (
           (d.doc_type = 'passage' and d.source_object_id = any($2::uuid[]))
           or (d.doc_type = 'fact' and d.kind <> 'timeline' and cardinality(d.evidence_ids) > 0 and not exists (
                 select 1 from public.evidence e join public.document_versions dv on dv.id = e.document_version_id
                 where e.id = any(d.evidence_ids) and not (dv.source_object_id = any($2::uuid[])))))`,
        [tenantId, hidden],
      )
      .then((r) => r.rows.map((x) => x.id)),
    // Nicknames learned from prose don't say where they came from: one counts as known only if
    // some available evidence actually uses it.
    sql
      .query<{ a: string }>(
        `select distinct a.alias a from public.entity_aliases a
         where a.tenant_id = $1 and a.status <> 'rejected' and a.kind in ('jargon', 'nickname') and length(a.normalized_alias) >= 2
           and not exists (select 1 from public.evidence e join public.document_versions dv on dv.id = e.document_version_id
                             where e.tenant_id = $1 and e.search_tsv @@ phraseto_tsquery('english', a.alias)
                               and not (dv.source_object_id = any($2::uuid[])) and e.content ilike '%' || a.alias || '%')`,
        [tenantId, hidden],
      )
      .then((r) => r.rows.map((x) => normalize(x.a))),
    sql
      .query<FactDoc & { kind: string; citation: Record<string, unknown>; touched: boolean }>(
        `select d.id, d.title, d.content, d.valid_from::text, d.valid_to::text, d.citation ->> 'status' status, d.kind, d.citation,
                exists (select 1 from public.evidence e join public.document_versions dv on dv.id = e.document_version_id
                        where e.id = any(d.evidence_ids) and dv.source_object_id = any($2::uuid[])) touched
         from public.search_documents d where d.tenant_id = $1 and d.doc_type = 'fact'`,
        [tenantId, hidden],
      )
      .then((r) => r.rows),
  ])
  const hiddenDocs = new Set(docs)

  // Records known only from hidden evidence: found in prose (not system data) or from a hidden
  // file, and not mentioned by any passage or fact that survives.
  const ents = (
    await sql.query<{ id: string }>(
      `select 'e:' || e.id id from public.entities e
       where e.tenant_id = $1 and e.status in ('candidate', 'active')
         and (e.metadata ->> 'origin' = 'prose' or (e.metadata #>> '{source,file_id}')::uuid = any($2::uuid[]))
         and not exists (select 1 from public.search_documents d where d.tenant_id = $1 and d.entity_ids @> array[e.id]
                           and d.doc_type in ('passage', 'fact') and not (d.id = any($3::text[])))`,
      [tenantId, hidden, docs],
    )
  ).rows.map((r) => r.id)
  for (const id of ents) hiddenDocs.add(id)

  // Topic timelines built from facts that weren't known yet are hidden too.
  for (const f of facts) if (f.kind === 'timeline' && ((f.citation.facts as string[] | undefined) ?? []).some((id) => hiddenDocs.has(`f:${id}`))) hiddenDocs.add(f.id)
  // Facts backed by both available and not-yet-available evidence: the fact stands, but quotes
  // and summaries may come from what wasn't known yet, so only the statement is shown.
  const mixed = new Set(facts.filter((f) => f.touched && !hiddenDocs.has(f.id)).map((f) => f.id))
  // Fact versions that survive, grouped by what they're about ("Subject: predicate").
  const byTitle = new Map<string, FactDoc[]>()
  for (const f of facts) if (f.kind !== 'timeline' && !hiddenDocs.has(f.id)) byTitle.set(f.title, [...(byTitle.get(f.title) ?? []), f])
  return { hiddenObjects, hiddenDocs, hiddenAliases: new Set(aliases), mixed, groups: [...byTitle.values()] }
}

export async function knowledgeView(sql: Sql, tenantId: string, slug: string, cutoff: string, today: string): Promise<KnowledgeView> {
  const key = `${tenantId}:${cutoff}:${today}`
  const hit = viewCache.get(key)
  if (hit) return hit
  const bk = `${tenantId}:${cutoff}`
  if (!baseCache.has(bk)) baseCache.set(bk, base(sql, tenantId, slug, cutoff).catch((e) => (baseCache.delete(bk), Promise.reject(e))))
  const b = await baseCache.get(bk)!
  // Which version was current on `today`, and its history as far as it was known.
  const out: KnowledgeView['facts'] = new Map()
  for (const g of b.groups) {
    const dated = g.filter((f) => f.valid_from && f.valid_from <= today).sort((x, y) => x.valid_from!.localeCompare(y.valid_from!))
    const latest = dated.at(-1)
    const steps = dated.map((f) => ({ fact_id: f.id, subject: '', predicate: '', authority: null, value: f.content.split('\n')[0].split(': ').slice(1).join(': '), valid_from: f.valid_from, valid_to: f.valid_to, status: f === latest ? 'accepted' : 'superseded' }))
    const timeline = steps.length >= 2 ? timelineText(steps) : null
    for (const f of g) {
      const ended = !!f.valid_to && f.valid_to <= today
      const started = !f.valid_from || f.valid_from <= today
      // Current on `today`: started, not ended, and not replaced by a later version that was known.
      const replaced = !!f.valid_from && dated.some((o) => o !== f && o.valid_from! > f.valid_from!)
      out.set(f.id, { is_current: started && !ended && !replaced && f.status !== 'rejected', timeline: f.valid_from ? timeline : null, mixed: b.mixed.has(f.id) })
    }
  }
  const view = { cutoff, today, hiddenObjects: b.hiddenObjects, hiddenDocs: b.hiddenDocs, hiddenAliases: b.hiddenAliases, facts: out }
  viewCache.set(key, view)
  return view
}

/** Builds the slow part for a cutoff ahead of time (so the first question isn't charged for it). */
export const prepareView = (sql: Sql, tenantId: string, slug: string, cutoff: string) => knowledgeView(sql, tenantId, slug, cutoff, cutoff).then(() => undefined)

/** Rewrites a fact document's history line to what the view knew. */
export function viewContent(view: KnowledgeView, id: string, content: string): string {
  const f = view.facts.get(id)
  if (!f) return content
  const all = content.split('\n')
  // Mixed evidence: keep the statement, its dates and status; drop quotes, summary and notes.
  const lines = f.mixed ? all.filter((l, i) => i === 0 || /^(Valid |Status: )/.test(l)) : all.filter((l) => !l.startsWith('Timeline: '))
  if (f.timeline) lines.push(`Timeline: ${f.timeline}`)
  return lines.join('\n')
}

/** Drops not-yet-known nicknames from a record's "Also known as" line. */
export function viewAliases(view: KnowledgeView, content: string): string {
  return content.replace(/^Also known as: (.*)$/m, (_m, list: string) => {
    const keep = list.split(', ').filter((a) => !view.hiddenAliases.has(normalize(a)))
    return keep.length ? `Also known as: ${keep.join(', ')}` : ''
  })
}
