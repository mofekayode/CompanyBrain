// Search projection: turns the company record into search documents.
//
//   evidence  ──cut into passages──┐
//   entities  ──entity cards───────┼──► search_documents (Postgres) ──embed──► Elasticsearch
//   facts     ──fact cards─────────┘
//
// Chunking policy (from the Phase 13 audit of 7.7k evidence rows):
// - tables: windows of 12 rows with the header repeated (a 40-row, 6.5k-char chunk is
//   too coarse to rank and too long to embed)
// - transcripts: consecutive segments merged into ~90 s windows (median segment was 90 chars)
// - short text / OCR pieces: merged with neighbours up to ~1,000 chars; long ones split
// - email: one passage per message; copies of the same message in several mailboxes stay
//   separate (they have different access) and are de-duplicated at query time (dedupe_key)
// - images and video scenes: one passage each
// Every document carries the access lists of its sources (acl_ids) and the entities it mentions.

import { createHash } from 'node:crypto'
import type { Sql } from '../storage/raw'
import { embedPassages } from './embed'
import { activeVersion, createVersion, es, indexAlias } from './es'
import { type Dictionary, linkText, loadDictionary, normalize } from './linker'
import { loadReaders, type Readers, splitByReaders } from './readers'
import { saysValue } from './search'
import { type TimelineStep, timelines, timelineText } from '../ontology/timeline'

export interface SearchDoc {
  id: string
  doc_type: 'passage' | 'entity' | 'fact'
  kind: string
  title: string
  content: string
  source_object_id: string | null
  document_version_id: string | null
  evidence_ids: string[]
  entity_ids: string[]
  acl_ids: string[]
  observed_at: string | null
  valid_from: string | null
  valid_to: string | null
  is_current: boolean
  authority: string | null
  dedupe_key: string | null
  citation: Record<string, unknown>
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex')
const base = (p: string) => p.split('/').pop() ?? p
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`
}
const AUTHORITY: Record<string, string> = { transcript_segment: 'interview', video_segment: 'video', email_body: 'email', image: 'photo' }

export interface EvRow {
  id: string
  dv: string
  ordinal: number
  kind: string
  content: string
  page_number: number | null
  start_ms: number | null
  end_ms: number | null
  speaker: string | null
  observed_at: string | null
  locator: Record<string, unknown>
  acl_id: string | null
  so_id: string
  path: string
  source_name: string | null
}

// ---------------------------------------------------------------------------- passages

const TABLE_ROWS = 12
const CHAT_ROWS = 6

/** For a table whose columns are a message log, a row → "2026-08-10 08:10 Josh Hensley: so we got sold". */
export function messageLog(header: string): ((row: string) => string) | null {
  const cols = header.split(' | ').map((c) => c.trim().toLowerCase())
  const text = cols.findIndex((c) => /^(text|message|body|content|message text)$/.test(c))
  const who = cols.findIndex((c) => /^(sender_name|sender|from|author|sender name|name)$/.test(c))
  const when = cols.findIndex((c) => /(date|time|timestamp|sent)/.test(c))
  if (text < 0 || who < 0 || when < 0) return null
  return (row) => {
    const v = row.split(' | ')
    return `${(v[when] ?? '').trim().slice(0, 16)} ${(v[who] ?? '').trim()}: ${(v[text] ?? '').trim()}`.trim()
  }
}
const TRANSCRIPT_MS = 90_000
const TEXT_TARGET = 1000
const TEXT_MAX = 1600

/** Cuts one document version's evidence into passages. Pure. */
export function cutPassages(rows: EvRow[]): Omit<SearchDoc, 'entity_ids'>[] {
  const out: Omit<SearchDoc, 'entity_ids'>[] = []
  if (!rows.length) return out
  const dv = rows[0].dv
  const path = rows[0].path
  const common = (r: EvRow[], extra: Partial<SearchDoc> & { title: string; content: string; citation: Record<string, unknown> }) => {
    out.push({
      id: `p:${dv}:${out.length}`,
      doc_type: 'passage',
      kind: r[0].kind,
      source_object_id: r[0].so_id,
      document_version_id: dv,
      evidence_ids: [...new Set(r.map((x) => x.id))],
      acl_ids: [...new Set(r.map((x) => x.acl_id).filter((x): x is string => !!x))],
      observed_at: r.find((x) => x.observed_at)?.observed_at ?? null,
      valid_from: null,
      valid_to: null,
      is_current: true,
      authority: AUTHORITY[r[0].kind] ?? 'document',
      dedupe_key: null,
      ...extra,
      citation: { path, source: r[0].source_name, kind: r[0].kind, ...extra.citation },
    })
  }

  let i = 0
  while (i < rows.length) {
    const r = rows[i]
    if (r.kind === 'table') {
      const lines = r.content.split('\n')
      let start = 0
      const prefix: string[] = []
      while (start < lines.length && /^(#|Sheet:)/.test(lines[start])) prefix.push(lines[start++])
      const header = lines[start] ?? ''
      const rawBody = lines.slice(start + 1).filter((l) => l.trim())
      // A message log (a text column plus sender and date): one readable line per message, in
      // small windows, so a single message isn't drowned in IDs and unrelated chatter.
      const chat = messageLog(header)
      const body = chat ? rawBody.map(chat) : rawBody
      const per = chat ? CHAT_ROWS : TABLE_ROWS
      const rowStart = Number(r.locator.row_start ?? 1)
      const sheet = (r.locator.sheet as string | undefined) ?? null
      for (let k = 0; k < Math.max(body.length, 1); k += per) {
        const win = body.slice(k, k + per)
        const a = rowStart + k
        const b = a + Math.max(win.length, 1) - 1
        common([r], {
          title: `${base(path)}${sheet && sheet !== 'CSV' ? ` · ${sheet}` : ''} · rows ${a}–${b}`,
          content: [...prefix, ...(chat ? [] : [header]), ...win].join('\n'),
          citation: { sheet, row_start: a, row_end: b },
        })
      }
      i++
    } else if (r.kind === 'transcript_segment') {
      const group = [r]
      let j = i + 1
      while (j < rows.length && rows[j].kind === 'transcript_segment' && (rows[j].end_ms ?? 0) - (r.start_ms ?? 0) <= TRANSCRIPT_MS && group.reduce((n, g) => n + g.content.length, 0) < TEXT_MAX)
        group.push(rows[j++])
      const s = group[0].start_ms ?? 0
      const e = group.at(-1)!.end_ms ?? s
      common(group, {
        title: `${base(path)} · ${clock(s)}–${clock(e)}`,
        content: group.map((g) => g.content).join('\n'),
        citation: { start_ms: s, end_ms: e, speakers: [...new Set(group.map((g) => g.speaker).filter(Boolean))] },
      })
      i = j
    } else if (r.kind === 'email_body') {
      const head = (k: string) => r.content.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi'))?.[1]?.trim() ?? null
      const subject = head('Subject')
      const messageId = (r.locator.message_id as string | undefined) ?? null
      common([r], {
        title: subject ? `${subject} · ${head('From')?.replace(/<.*?>/, '').trim() ?? ''}` : base(path),
        content: r.content,
        dedupe_key: messageId ? `msg:${messageId}` : null,
        citation: { message_id: messageId, subject, from: head('From'), date: head('Date') },
      })
      i++
    } else if (r.kind === 'text' || r.kind === 'ocr') {
      if (r.content.length > TEXT_MAX) {
        // Split long pieces on paragraph boundaries.
        let buf = ''
        for (const para of r.content.split(/\n{2,}/)) {
          if (buf && buf.length + para.length > TEXT_TARGET) {
            common([r], { title: `${base(path)}${r.page_number ? ` · p. ${r.page_number}` : ''}`, content: buf, citation: { page_start: r.page_number, page_end: r.page_number } })
            buf = ''
          }
          buf += (buf ? '\n\n' : '') + para
        }
        if (buf) common([r], { title: `${base(path)}${r.page_number ? ` · p. ${r.page_number}` : ''}`, content: buf, citation: { page_start: r.page_number, page_end: r.page_number } })
        i++
        continue
      }
      const group = [r]
      let len = r.content.length
      let j = i + 1
      while (j < rows.length && rows[j].kind === r.kind && len + rows[j].content.length <= TEXT_TARGET && rows[j].content.length <= TEXT_MAX) {
        len += rows[j].content.length
        group.push(rows[j++])
      }
      const p0 = group[0].page_number
      const p1 = group.at(-1)!.page_number
      common(group, {
        title: `${base(path)}${p0 ? ` · p. ${p0}${p1 && p1 !== p0 ? `–${p1}` : ''}` : ''}`,
        content: group.map((g) => g.content).join('\n\n'),
        citation: { page_start: p0, page_end: p1 },
      })
      i = j
    } else {
      // image, video_segment, anything else: one passage each.
      const t = r.start_ms != null ? ` · ${clock(r.start_ms)}–${clock(r.end_ms ?? r.start_ms)}` : ''
      common([r], { title: `${base(path)}${t}`, content: r.content, citation: { start_ms: r.start_ms, end_ms: r.end_ms } })
      i++
    }
  }
  return out
}

/** For each file: the access lists of its identical copies (same checksum, not deleted), its own included. */
export async function twinAcls(sql: Sql, tenantId: string, soIds: string[]): Promise<Map<string, string[]>> {
  if (!soIds.length) return new Map()
  const rows = (
    await sql.query<{ id: string; acls: string[] }>(
      `select a.id, array_agg(distinct b.acl_id) filter (where b.acl_id is not null) acls
       from public.source_objects a join public.source_objects b on b.tenant_id = a.tenant_id and b.sha256 = a.sha256 and b.deleted_at is null
       where a.tenant_id = $1 and a.id = any($2::uuid[]) and a.sha256 is not null
       group by a.id having count(*) > 1`,
      [tenantId, soIds],
    )
  ).rows
  return new Map(rows.map((r) => [r.id, r.acls ?? []]))
}

async function passagesFor(sql: Sql, tenantId: string, dict: Dictionary, dvIds: string[]): Promise<SearchDoc[]> {
  const rows = (
    await sql.query<EvRow>(
      `select e.id, e.document_version_id dv, e.ordinal, e.kind, e.content, e.page_number, e.start_ms, e.end_ms, e.speaker, e.observed_at::text,
              coalesce(e.locator, '{}') locator, e.acl_id, so.id so_id, so.original_path path, s.name source_name
       from public.evidence e
       join public.document_versions dv on dv.id = e.document_version_id
       join public.documents d on d.current_version_id = dv.id and d.deleted_at is null
       join public.source_objects so on so.id = dv.source_object_id
       left join public.sources s on s.id = so.source_id
       where e.tenant_id = $1 and e.document_version_id = any($2::uuid[])
       order by e.document_version_id, e.ordinal`,
      [tenantId, dvIds],
    )
  ).rows
  const byDv = new Map<string, EvRow[]>()
  for (const r of rows) byDv.set(r.dv, [...(byDv.get(r.dv) ?? []), r])
  // An identical copy of a file is read once; its content is readable by anyone who may open any copy.
  const twins = await twinAcls(sql, tenantId, [...new Set(rows.map((r) => r.so_id))])
  // ...except a sheet marked with a sensitivity label: it keeps only its own (narrower) readers.
  const labelled = new Map(
    (
      await sql.query<{ id: string; sheets: string[] }>(
        `select id, array(select u ->> 'sheet' from jsonb_array_elements(metadata -> 'label_units') u) sheets from public.source_objects where id = any($1::uuid[]) and metadata ? 'label_units'`,
        [[...new Set(rows.map((r) => r.so_id))]],
      )
    ).rows.map((r) => [r.id, new Set(r.sheets)]),
  )
  const out: SearchDoc[] = []
  for (const group of byDv.values())
    for (const p of cutPassages(group)) {
      const sheetLabelled = !!p.source_object_id && !!labelled.get(p.source_object_id)?.has(String(p.citation.sheet ?? ''))
      if (p.source_object_id && twins.has(p.source_object_id) && !sheetLabelled) p.acl_ids = [...new Set([...p.acl_ids, ...twins.get(p.source_object_id)!])]
      // A copy in someone's private mailbox keeps that mailbox's access, even when the message
      // went to a distribution list: the stricter of the source's permission and the sensitivity
      // label wins. (Recipients see it through their own copies.)
      out.push({ ...p, entity_ids: linkText(dict, `${p.title}\n${p.content}`).map((e) => e.id) })
    }
  return out
}

// ------------------------------------------------------------------------ card access
//
// A card (record, fact, timeline) combines content from several files. It is split by reader group
// (readers.ts): each variant carries only lines that every one of its readers may open. Who may open
// a file or a piece of evidence is read from its passages, which already apply identical copies and
// sensitivity labels; a file whose passages differ in access (a labelled sheet) counts as readable
// only by those who may read all of it.

interface CardAccess {
  readers: Readers
  companyWide: string | null
  /** May readers of `acl` open this file (all of it)? Unknown files: no. */
  fileOK(acl: string, file: string): boolean
  /** The access lists through which a file can be read. */
  fileClasses(file: string): string[]
  /** The access lists of the passages holding this evidence (empty: no one). */
  evidence(id: string): string[]
}

async function cardAccess(sql: Sql, tenantId: string, files: string[], evidenceIds: string[]): Promise<CardAccess> {
  const readers = await loadReaders(sql, tenantId)
  const companyWide = (await sql.query<{ acl_id: string }>(`select acl_id from public.access_scopes where tenant_id = $1 and key = 'company-wide'`, [tenantId])).rows[0]?.acl_id ?? null
  const groups = new Map<string, string[][]>()
  const uniqFiles = [...new Set(files)]
  for (let i = 0; i < uniqFiles.length; i += 2000)
    for (const r of (
      await sql.query<{ so: string; acl_ids: string[] }>(
        `select distinct source_object_id::text so, acl_ids from public.search_documents where tenant_id = $1 and doc_type = 'passage' and source_object_id = any($2::uuid[])`,
        [tenantId, uniqFiles.slice(i, i + 2000)],
      )
    ).rows)
      groups.set(r.so, [...(groups.get(r.so) ?? []), r.acl_ids])
  const ev = new Map<string, string[]>()
  const uniqEv = [...new Set(evidenceIds)]
  for (let i = 0; i < uniqEv.length; i += 5000)
    for (const r of (
      await sql.query<{ e: string; acls: string[] }>(
        `select e::text, array_agg(distinct a) acls from public.search_documents d, unnest(d.evidence_ids) e, unnest(d.acl_ids) a
         where d.tenant_id = $1 and d.doc_type = 'passage' and d.evidence_ids && $2::uuid[] and e = any($2::uuid[]) group by 1`,
        [tenantId, uniqEv.slice(i, i + 5000)],
      )
    ).rows)
      ev.set(r.e, r.acls)
  return {
    readers,
    companyWide,
    fileOK: (acl, file) => !!groups.get(file)?.length && groups.get(file)!.every((g) => readers.covers([acl], g)),
    fileClasses: (file) => [...new Set((groups.get(file) ?? []).flat())],
    evidence: (id) => ev.get(id) ?? [],
  }
}

// ------------------------------------------------------------------------ entity cards

async function entityCards(sql: Sql, tenantId: string, ids: string[] | null): Promise<SearchDoc[]> {
  const ents = (
    await sql.query<{ id: string; name: string; type: string; kind: string; properties: Record<string, unknown>; aliases: string[] | null; idents: string[] | null }>(
      `select e.id, e.canonical_name name, t.name type, coalesce(t.metadata ->> 'kind', 'thing') kind, e.properties,
              array(select distinct a.alias from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected' and lower(a.alias) <> lower(e.canonical_name)) aliases,
              array(select i.system || ': ' || i.value from public.entity_identifiers i where i.entity_id = e.id and i.status <> 'rejected' limit 6) idents
       from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and coalesce(t.metadata ->> 'kind', 'thing') <> 'event'
         and ($2::uuid[] is null or e.id = any($2::uuid[]))`,
      [tenantId, ids],
    )
  ).rows
  if (!ents.length) return []
  // Links, per file of the row they were read from: a link from another record's row (a work order
  // "for customer") comes from that record's file; a link out of this record came from one of its
  // own rows ('self').
  const rels = (
    await sql.query<{ id: string; rel: string; dir: string; other_type: string; okind: string; file: string | null; n: number; names: string[]; last: string | null }>(
      `with ents as (select unnest($2::uuid[]) id),
       r as (
         select r.source_entity_id eid, r.target_entity_id oid, r.relationship_type_id rt, 'out' dir from public.relationships r join ents on ents.id = r.source_entity_id where r.tenant_id = $1 and r.status <> 'rejected'
         union all
         select r.target_entity_id, r.source_entity_id, r.relationship_type_id, 'in' from public.relationships r join ents on ents.id = r.target_entity_id where r.tenant_id = $1 and r.status <> 'rejected')
       select r.eid id, rt.name rel, r.dir, ot.name other_type, coalesce(ot.metadata ->> 'kind', 'thing') okind,
              case when r.dir = 'out' then 'self' else o.metadata #>> '{source,file_id}' end file, count(*)::int n,
              (array_agg(distinct o.canonical_name))[1:8] names, max(o.properties ->> 'date') last
       from r join public.relationship_types rt on rt.id = r.rt join public.entities o on o.id = r.oid and o.status in ('candidate', 'active')
       join public.entity_types ot on ot.id = o.entity_type_id
       where rt.name <> 'possibly_same_as'
       group by 1, 2, 3, 4, 5, 6`,
      [tenantId, ents.map((e) => e.id)],
    )
  ).rows
  const relBy = new Map<string, typeof rels>()
  for (const r of rels) relBy.set(r.id, [...(relBy.get(r.id) ?? []), r])
  // The rows a record was made from: its own and those of duplicates merged into it, each with the
  // properties it said.
  const records = (
    await sql.query<{ eid: string; name: string; properties: Record<string, unknown>; file: string | null; survivor: boolean }>(
      `select coalesce(m.merged_into_id, m.id) eid, m.canonical_name name, m.properties, m.metadata #>> '{source,file_id}' file, m.merged_into_id is null survivor
       from public.entities m where m.tenant_id = $1 and coalesce(m.merged_into_id, m.id) = any($2::uuid[])`,
      [tenantId, ents.map((e) => e.id)],
    )
  ).rows
  const recBy = new Map<string, typeof records>()
  for (const r of records) recBy.set(r.eid, [...(recBy.get(r.eid) ?? []), r])
  const access = await cardAccess(sql, tenantId, [...records.map((r) => r.file), ...rels.map((r) => r.file)].filter((f): f is string => !!f && f !== 'self'), [])
  const acls = (await sql.query<{ id: string }>(`select id from public.acls where tenant_id = $1 order by 1`, [tenantId])).rows.map((r) => r.id)

  return ents.flatMap((e) => {
    const recs = recBy.get(e.id) ?? []
    const ownFiles = [...new Set(recs.map((r) => r.file).filter((f): f is string => !!f))]
    // Readable by readers of `acl` when they may open one of `files` (no files: company-wide, e.g. the company map).
    const anyOf = (acl: string, files: string[]) => !files.length || files.some((f) => access.fileOK(acl, f))
    const allOf = (acl: string, files: string[]) => files.every((f) => access.fileOK(acl, f))
    // Who may see the record at all: readers of a file it came from, or of a file whose rows link to
    // it. Every access list is a candidate group (as for facts), so a group that may open all of
    // those files, such as full access, gets the whole record.
    const rowFiles = [...new Set((relBy.get(e.id) ?? []).map((r) => r.file).filter((f): f is string => !!f && f !== 'self'))]
    const classes = acls.filter((a) =>
      ownFiles.length ? ownFiles.some((f) => access.fileOK(a, f)) || rowFiles.some((f) => access.fileOK(a, f)) : !!access.companyWide && access.readers.covers([a], [access.companyWide]),
    )
    // A property was said by the merged rows that hold the same value; otherwise by the record's own row.
    const merged = recs.filter((r) => !r.survivor)
    const survivorFiles = recs.filter((r) => r.survivor && r.file).map((r) => r.file!)
    const saidBy = (k: string, v: unknown) => {
      const m = merged.filter((r) => r.file && String(r.properties?.[k] ?? '') === String(v)).map((r) => r.file!)
      return m.length ? m : survivorFiles
    }
    const nameFiles = (alias: string) => recs.filter((r) => r.file && normalize(r.name) === normalize(alias)).map((r) => r.file!)
    const props = Object.entries(e.properties ?? {})
      .filter(([k, v]) => k !== 'source_system' && v !== null && v !== '' && typeof v !== 'object')
      .slice(0, 12)
      .map(([k, v]) => ({ text: `${k}: ${String(v).slice(0, 120)}`, files: saidBy(k, v) }))

    const build = (acl: string): string => {
      const aliases = (e.aliases ?? []).filter((a) => anyOf(acl, nameFiles(a)))
      // Identifiers don't say which row gave them: shown only to readers of every row.
      const idents = allOf(acl, ownFiles) ? (e.idents ?? []) : []
      const seenProps = props.filter((p) => anyOf(acl, p.files)).map((p) => p.text)
      const groups = new Map<string, { rel: string; dir: string; other_type: string; okind: string; n: number; names: Set<string>; last: string | null }>()
      for (const r of relBy.get(e.id) ?? []) {
        const ok = r.file === 'self' ? allOf(acl, ownFiles) : !r.file || access.fileOK(acl, r.file)
        if (!ok) continue
        const k = `${r.rel}|${r.dir}|${r.other_type}`
        const g = groups.get(k) ?? { rel: r.rel, dir: r.dir, other_type: r.other_type, okind: r.okind, n: 0, names: new Set<string>(), last: null }
        g.n += r.n
        for (const nm of r.names) g.names.add(nm)
        if (r.last && (!g.last || r.last > g.last)) g.last = r.last
        groups.set(k, g)
      }
      const links = [...groups.values()]
        .sort((a, b) => b.n - a.n)
        .slice(0, 14)
        .map((r) => {
          const names = [...r.names].sort().slice(0, 8)
          return r.okind === 'event'
            ? `${r.other_type}s (${r.rel.replaceAll('_', ' ')}): ${r.n}${r.last ? `, latest ${String(r.last).slice(0, 10)}` : ''}`
            : `${r.rel.replaceAll('_', ' ')} ${r.dir === 'out' ? '→' : '←'} ${r.other_type}: ${names.join(', ')}${r.n > names.length ? ` (+${r.n - names.length})` : ''}`
        })
      return [
        `${e.type}: ${e.name}`,
        aliases.length ? `Also known as: ${aliases.join(', ')}` : '',
        idents.length ? `Identifiers: ${idents.join('; ')}` : '',
        seenProps.join('\n'),
        links.join('\n'),
      ]
        .filter(Boolean)
        .join('\n')
    }
    const card: SearchDoc = {
      id: `e:${e.id}`,
      doc_type: 'entity' as const,
      kind: e.type,
      title: `${e.name} (${e.type})`,
      content: '',
      source_object_id: null,
      document_version_id: null,
      evidence_ids: [],
      entity_ids: [e.id],
      acl_ids: [],
      observed_at: null,
      valid_from: null,
      valid_to: null,
      is_current: true,
      authority: 'system_of_record',
      dedupe_key: null,
      citation: { entity_id: e.id, entity_type: e.type, kind: 'entity' },
    }
    return splitByReaders(card, classes, access.readers, build, sha)
  })
}

// -------------------------------------------------------------------------- fact cards

/** Who may read each fact: through any of its evidence; facts from system fields alone, through every row of their subject. */
async function factAccess(sql: Sql, tenantId: string) {
  const all = (
    await sql.query<{ id: string; subject: string; ev: string[] | null; files: string[] | null }>(
      `select f.id, f.subject_entity_id subject,
              (select array_agg(distinct l.evidence_id) from public.evidence_links l
                where l.fact_id = f.id or l.fact_id in (select claim_id from public.fact_claims where canonical_id = f.id)) ev
       from public.facts f where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status <> 'rejected'`,
      [tenantId],
    )
  ).rows
  // The rows a subject was made from (its own and merged duplicates').
  const subjects = [...new Set(all.filter((r) => !r.ev?.length).map((r) => r.subject))]
  const subjectFiles = new Map<string, string[]>()
  if (subjects.length)
    for (const r of (
      await sql.query<{ eid: string; file: string }>(
        `select m.id eid, m.metadata #>> '{source,file_id}' file from public.entities m where m.id = any($1::uuid[]) and m.metadata #>> '{source,file_id}' is not null
         union select m.merged_into_id, m.metadata #>> '{source,file_id}' from public.entities m where m.merged_into_id = any($1::uuid[]) and m.metadata #>> '{source,file_id}' is not null`,
        [subjects],
      )
    ).rows)
      subjectFiles.set(r.eid, [...(subjectFiles.get(r.eid) ?? []), r.file])
  for (const r of all) r.files = r.ev?.length ? null : (subjectFiles.get(r.subject) ?? [])
  const byId = new Map(all.map((r) => [r.id, r]))
  const access = await cardAccess(
    sql,
    tenantId,
    all.flatMap((r) => r.files ?? []),
    all.flatMap((r) => r.ev ?? []),
  )
  const covers = (acl: string, e: string) => access.readers.covers([acl], access.evidence(e))
  // Every access list is a candidate reader group, not only those of the evidence: a fact read from
  // two files with different readers is still seen in full by a group whose people may open both.
  const acls = (await sql.query<{ id: string }>(`select id from public.acls where tenant_id = $1 order by 1`, [tenantId])).rows.map((r) => r.id)
  return {
    readers: access.readers,
    ev: access.evidence,
    /** The access lists through which a fact may be seen. */
    classes(id: string): string[] {
      const f = byId.get(id)
      if (!f?.ev?.length && !f?.files?.length) return access.companyWide ? [access.companyWide] : []
      return acls.filter((a) => this.factOK(a, id))
    },
    /** May readers of `acl` see this fact (some evidence that says it)? */
    factOK(acl: string, id: string): boolean {
      const f = byId.get(id)
      if (!f) return false
      if (f.ev?.length) return f.ev.some((e) => covers(acl, e))
      return (f.files ?? []).every((x) => access.fileOK(acl, x))
    },
    /** May readers of `acl` read all of this fact's evidence? */
    allEvidence(acl: string, id: string): boolean {
      const f = byId.get(id)
      if (!f) return false
      if (f.ev?.length) return f.ev.every((e) => covers(acl, e))
      return (f.files ?? []).every((x) => access.fileOK(acl, x))
    },
  }
}

async function factCards(sql: Sql, tenantId: string, ids: string[] | null, dict?: Dictionary): Promise<SearchDoc[]> {
  const facts = (
    await sql.query<{
      id: string
      subject_id: string
      subject: string
      type: string
      predicate: string
      value: string
      valid_from: string | null
      valid_to: string | null
      status: string
      authority: string | null
      note: string | null
      summary: string | null
      fkind: string | null
      evidence: string[] | null
    }>(
      `select f.id, s.id subject_id, s.canonical_name subject, t.name type, f.predicate, f.value #>> '{}' value, f.valid_from::text, f.valid_to::text, f.status, f.authority, f.note,
              f.metadata ->> 'summary' summary, f.metadata ->> 'kind' fkind,
              (select array_agg(distinct l.evidence_id) from public.evidence_links l
                where l.fact_id = f.id or l.fact_id in (select claim_id from public.fact_claims where canonical_id = f.id)) evidence
       from public.facts f join public.entities s on s.id = f.subject_entity_id join public.entity_types t on t.id = s.entity_type_id
       where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status <> 'rejected' and ($2::uuid[] is null or f.id = any($2::uuid[]))`,
      [tenantId, ids],
    )
  ).rows
  if (!facts.length) return []
  const access = await factAccess(sql, tenantId)
  // What each source said, with the evidence it was read from.
  const claims = (
    await sql.query<{ canonical_id: string; q: string; a: string | null; ev: string[] }>(
      `select fc.canonical_id, left(coalesce(c.metadata ->> 'quote', c.value #>> '{}'), 240) q, c.authority a,
              array(select l.evidence_id from public.evidence_links l where l.fact_id = c.id) ev
       from public.fact_claims fc join public.facts c on c.id = fc.claim_id
       where fc.canonical_id = any($1::uuid[]) order by fc.canonical_id, c.id`,
      [facts.map((f) => f.id)],
    )
  ).rows
  const claimsBy = new Map<string, typeof claims>()
  for (const c of claims) claimsBy.set(c.canonical_id, [...(claimsBy.get(c.canonical_id) ?? []), c])
  // What the evidence says, to check that what a reader group may open actually says the value.
  const evText = new Map(
    (await sql.query<{ id: string; content: string }>(`select id, lower(content) content from public.evidence where id = any($1::uuid[])`, [[...new Set(facts.flatMap((f) => f.evidence ?? []))]])).rows.map((r) => [
      r.id,
      r.content,
    ]),
  )
  const today = new Date().toISOString().slice(0, 10)
  // Every fact that changed carries its own history, so any hit can say "it was X before" (as far
  // as its readers may see the other versions).
  const chains = new Map<string, TimelineStep[]>()
  for (const tl of await timelines(sql, tenantId)) {
    if (!tl.key.startsWith('sp:')) continue
    for (const st of tl.steps) chains.set(st.fact_id, tl.steps)
  }
  return facts.flatMap((f) => {
    const when = f.valid_from || f.valid_to ? `Valid ${f.valid_from ?? '…'} to ${f.valid_to ?? 'now'}.` : ''
    const build = (acl: string): string | null => {
      // Summaries and review notes were written from all the evidence: only for readers of all of it.
      const all = access.allEvidence(acl, f.id)
      // Readers of part of the evidence see the fact only if that part says the value ("bonus: $30k"
      // may come from the restricted part alone).
      if (!all && f.evidence?.length) {
        const open = f.evidence.filter((e) => access.readers.covers([acl], access.ev(e))).map((e) => evText.get(e) ?? '')
        if (!saysValue(f.value, open.join('\n'))) return null
      }
      const quotes = (claimsBy.get(f.id) ?? []).filter((c) => (c.ev.length ? c.ev.some((e) => access.readers.covers([acl], access.ev(e))) : all)).slice(0, 4)
      const steps = (chains.get(f.id) ?? []).filter((s) => access.factOK(acl, s.fact_id))
      return [
        `${f.subject} (${f.type}) · ${f.predicate.replaceAll('_', ' ')}: ${f.value}`,
        all ? (f.summary ?? '') : '',
        when,
        `Status: ${f.status}${f.authority ? ` · strongest source: ${f.authority}` : ''}`,
        steps.length >= 2 ? `Timeline: ${timelineText(steps)}` : '',
        all && f.note ? `Review note: ${f.note}` : '',
        ...quotes.map((q) => `“${q.q}” (${q.a})`),
      ]
        .filter(Boolean)
        .join('\n')
    }
    const card: SearchDoc = {
      id: `f:${f.id}`,
      doc_type: 'fact' as const,
      kind: f.fkind ?? 'fact',
      title: `${f.subject}: ${f.predicate.replaceAll('_', ' ')}`,
      content: '',
      source_object_id: null,
      document_version_id: null,
      evidence_ids: f.evidence ?? [],
      // The subject, plus everything the fact mentions: "Blue Ridge · p17 suction fix completed" is
      // also about TP-17, so a search for TP-17 (or its page) finds it.
      entity_ids: [
        ...new Set([
          f.subject_id,
          ...(dict
            ? linkText(dict, `${f.predicate.replaceAll('_', ' ')}\n${f.value}\n${f.summary ?? ''}\n${(claimsBy.get(f.id) ?? []).map((q) => q.q).join('\n')}`)
                .filter((e) => e.type !== 'Term')
                .map((e) => e.id)
            : []),
        ]),
      ],
      acl_ids: [],
      observed_at: null,
      valid_from: f.valid_from,
      valid_to: f.valid_to,
      is_current: f.status !== 'superseded' && (!f.valid_to || f.valid_to > today),
      authority: f.authority,
      dedupe_key: null,
      citation: { fact_id: f.id, kind: 'fact', status: f.status },
    }
    return splitByReaders(card, access.classes(f.id), access.readers, build, sha)
  })
}

// ------------------------------------------------------------------------ timeline cards

/** One card per shared rule that changed over time across subjects (e.g. who may approve discounts). */
async function timelineCards(sql: Sql, tenantId: string): Promise<SearchDoc[]> {
  const rules = new Set(
    (
      await sql.query<{ topic: string }>(
        `select distinct metadata ->> 'topic' topic from public.facts where tenant_id = $1 and metadata ->> 'topic_kind' = 'rule' or (tenant_id = $1 and metadata ? 'topic' and not metadata ? 'topic_auto')`,
        [tenantId],
      )
    ).rows.map((r) => r.topic),
  )
  const access = await factAccess(sql, tenantId)
  const out: SearchDoc[] = []
  for (const tl of await timelines(sql, tenantId)) {
    if (!tl.key.startsWith('topic:') || !rules.has(tl.key.slice(6))) continue
    const dated = tl.steps.filter((s) => s.valid_from || s.valid_to)
    if (dated.length < 2) continue
    // Each reader group sees the steps it may see; fewer than two is no history.
    const build = (acl: string): string | null => {
      const steps = dated.filter((s) => access.factOK(acl, s.fact_id))
      if (steps.length < 2) return null
      const subjects = new Set(steps.map((s) => s.subject))
      return [`${tl.label}: history across ${subjects.size} records:`, ...steps.map((s) => `${s.valid_from ?? '…'} → ${s.valid_to ?? 'now'} · ${s.subject}: ${s.value}${s.status === 'superseded' ? ' (replaced)' : ''}`)].join('\n')
    }
    const card: SearchDoc = {
      id: `t:${tl.key.slice(6)}`,
      doc_type: 'fact',
      kind: 'timeline',
      title: `How ${tl.label} changed over time`,
      content: '',
      source_object_id: null,
      document_version_id: null,
      evidence_ids: [],
      entity_ids: tl.subject_ids,
      acl_ids: [],
      observed_at: null,
      valid_from: dated[0].valid_from,
      valid_to: null,
      is_current: true,
      authority: null,
      dedupe_key: null,
      citation: { kind: 'timeline', topic: tl.key.slice(6), facts: tl.steps.map((s) => s.fact_id) },
    }
    out.push(...splitByReaders(card, [...new Set(dated.flatMap((s) => access.classes(s.fact_id)))], access.readers, build, sha))
  }
  return out
}

// ------------------------------------------------------------------------------ store

const COLS =
  'id, doc_type, kind, title, content, source_object_id, document_version_id, evidence_ids, entity_ids, acl_ids, observed_at, valid_from, valid_to, is_current, authority, dedupe_key, citation'

/** Upserts documents; any change clears indexed_at so the indexer picks it up. */
export async function saveDocs(sql: Sql, tenantId: string, docs: SearchDoc[]): Promise<number> {
  let changed = 0
  for (let i = 0; i < docs.length; i += 500) {
    const chunk = docs.slice(i, i + 500).map((d) => ({ ...d, content_hash: sha(`${d.title}\n${d.content}`), row_hash: sha(JSON.stringify(d)) }))
    const r = await sql.query<{ id: string }>(
      `insert into public.search_documents (tenant_id, ${COLS}, content_hash, updated_at)
       select $1, x.id, x.doc_type, x.kind, x.title, x.content, x.source_object_id, x.document_version_id, x.evidence_ids, x.entity_ids, x.acl_ids,
              x.observed_at, x.valid_from, x.valid_to, x.is_current, x.authority, x.dedupe_key, coalesce(x.citation, '{}') || jsonb_build_object('row_hash', x.row_hash), x.content_hash, now()
       from jsonb_to_recordset($2::jsonb) as x(id text, doc_type text, kind text, title text, content text, source_object_id uuid, document_version_id uuid, evidence_ids uuid[], entity_ids uuid[],
            acl_ids uuid[], observed_at timestamptz, valid_from date, valid_to date, is_current boolean, authority text, dedupe_key text, citation jsonb, content_hash text, row_hash text)
       on conflict (tenant_id, id) do update set doc_type = excluded.doc_type, kind = excluded.kind, title = excluded.title, content = excluded.content,
         source_object_id = excluded.source_object_id, document_version_id = excluded.document_version_id, evidence_ids = excluded.evidence_ids, entity_ids = excluded.entity_ids,
         acl_ids = excluded.acl_ids, observed_at = excluded.observed_at, valid_from = excluded.valid_from, valid_to = excluded.valid_to, is_current = excluded.is_current,
         authority = excluded.authority, dedupe_key = excluded.dedupe_key, citation = excluded.citation, content_hash = excluded.content_hash, updated_at = now(), indexed_at = null
       where search_documents.citation ->> 'row_hash' is distinct from excluded.citation ->> 'row_hash'
       returning id`,
      [tenantId, JSON.stringify(chunk)],
    )
    changed += r.rows.length
  }
  return changed
}

/** Removes documents of a scope that the rebuild no longer produced; returns their ids. */
async function dropStale(sql: Sql, tenantId: string, where: string, params: unknown[], keep: string[]): Promise<string[]> {
  return (
    await sql.query<{ id: string }>(`delete from public.search_documents where tenant_id = $1 and ${where} and not (id = any($${params.length + 2}::text[])) returning id`, [tenantId, ...params, keep])
  ).rows.map((r) => r.id)
}

/** Access list → principals (users and groups) that can read it. */
async function aclPrincipals(sql: Sql, tenantId: string): Promise<Map<string, string[]>> {
  const rows = (await sql.query<{ acl_id: string; ps: string[] }>(`select acl_id, array_agg(principal_id::text) ps from public.acl_entries where tenant_id = $1 group by 1`, [tenantId])).rows
  return new Map(rows.map((r) => [r.acl_id, r.ps]))
}

/**
 * Pushes every document whose indexed_at is null to Elasticsearch. Text that changed
 * (or was never indexed) is embedded and indexed in full; documents whose text is the
 * same (new readers, renamed entity) get a partial update without touching the vector.
 * Vectors live only in Elasticsearch: re-embedding everything takes ~5 minutes locally.
 */
/** A search document as Elasticsearch stores it (everything but the vector). */
function esFields(tenantId: string, dict: Dictionary, acl: Map<string, string[]>, paths: Map<string, { path: string; source: string | null }>) {
  return (r: SearchDoc) => ({
    tenant_id: tenantId,
    doc_type: r.doc_type,
    kind: r.kind,
    title: r.title,
    content: r.content,
    entity_ids: r.entity_ids,
    entity_terms: r.entity_ids.flatMap((id) => dict.entities.get(id)?.terms ?? []).join(' · '),
    acl_principals: [...new Set(r.acl_ids.flatMap((a) => acl.get(a) ?? []))],
    source_object_id: r.source_object_id,
    document_version_id: r.document_version_id,
    path: r.source_object_id ? (paths.get(r.source_object_id)?.path ?? null) : null,
    source_name: r.source_object_id ? (paths.get(r.source_object_id)?.source ?? null) : null,
    observed_at: r.observed_at,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    is_current: r.is_current,
    authority: r.authority,
    // Every document has a key (its own id when nothing shares it): searches collapse on it.
    dedupe_key: r.dedupe_key ?? r.id,
    citation: r.citation,
  })
}

export async function indexPending(sql: Sql, tenantId: string, opts: { dict?: Dictionary; onProgress?: (n: number) => void } = {}): Promise<{ indexed: number; embedded: number }> {
  const slug = (await sql.query<{ slug: string }>(`select slug from public.tenants where id = $1`, [tenantId])).rows[0].slug
  const dict = opts.dict ?? (await loadDictionary(sql, tenantId))
  // Vectors must come from the model of the index version the alias points to.
  const version = await activeVersion(slug)
  // Re-read who may read each list per batch: access can change while a long run is going.
  let acl = await aclPrincipals(sql, tenantId)
  const paths = new Map<string, { path: string; source: string | null }>()
  let n = 0
  let embedded = 0
  for (;;) {
    const rows = (
      await sql.query<SearchDoc & { content_hash: string; embedded_hash: string | null }>(
        `select ${COLS}, content_hash, embedded_hash from public.search_documents where tenant_id = $1 and indexed_at is null order by id limit 256`,
        [tenantId],
      )
    ).rows
    if (!rows.length) return { indexed: n, embedded }
    if (n) acl = await aclPrincipals(sql, tenantId)
    const missing = [...new Set(rows.map((r) => r.source_object_id).filter((x): x is string => !!x && !paths.has(x)))]
    if (missing.length)
      for (const p of (
        await sql.query<{ id: string; path: string; source: string | null }>(
          `select so.id, so.original_path path, s.name source from public.source_objects so left join public.sources s on s.id = so.source_id where so.id = any($1::uuid[])`,
          [missing],
        )
      ).rows)
        paths.set(p.id, { path: p.path, source: p.source })
    const fresh = rows.filter((r) => r.embedded_hash !== r.content_hash)
    const vectors = fresh.length
      ? await embedPassages(
          fresh.map((r) => `${r.title}\n${r.content}`),
          32,
          version,
        )
      : []
    const vec = new Map(fresh.map((r, i) => [r.id, vectors[i]]))
    embedded += fresh.length
    const fields = esFields(tenantId, dict, acl, paths)
    const body: Record<string, unknown>[] = rows.flatMap((r): Record<string, unknown>[] =>
      vec.has(r.id) ? [{ index: { _index: indexAlias(slug), _id: r.id } }, { ...fields(r), embedding: vec.get(r.id) }] : [{ update: { _index: indexAlias(slug), _id: r.id } }, { doc: fields(r) }],
    )
    const res = await es().bulk({ body, refresh: false })
    if (res.errors) {
      const bad = res.items.find((it) => (it.index ?? it.update)?.error)
      const err = (bad?.index ?? bad?.update)?.error
      // A partial update of a document the index doesn't have: embed and index it in full next round.
      if (err?.type === 'document_missing_exception') {
        const missingIds = res.items.filter((it) => it.update?.error?.type === 'document_missing_exception').map((it) => it.update!._id!)
        await sql.query(`update public.search_documents set embedded_hash = null where tenant_id = $1 and id = any($2::text[])`, [tenantId, missingIds])
      } else throw new Error(`bulk index failed: ${JSON.stringify(err).slice(0, 400)}`)
    }
    const failed = new Set(res.items.filter((it) => (it.index ?? it.update)?.error).map((it) => (it.index ?? it.update)!._id!))
    const done = rows.filter((r) => !failed.has(r.id))
    await sql.query(
      `update public.search_documents d set indexed_at = now(), embedded_hash = case when x.embedded then d.content_hash else d.embedded_hash end
       from jsonb_to_recordset($2::jsonb) as x(id text, embedded boolean) where d.tenant_id = $1 and d.id = x.id`,
      [tenantId, JSON.stringify(done.map((r) => ({ id: r.id, embedded: vec.has(r.id) })))],
    )
    n += done.length
    opts.onProgress?.(n)
  }
}

async function deleteFromIndex(sql: Sql, tenantId: string, ids: string[]) {
  if (!ids.length) return
  const slug = (await sql.query<{ slug: string }>(`select slug from public.tenants where id = $1`, [tenantId])).rows[0].slug
  for (let i = 0; i < ids.length; i += 1000) await es().bulk({ body: ids.slice(i, i + 1000).map((id) => ({ delete: { _index: indexAlias(slug), _id: id } })), refresh: false })
}

// ----------------------------------------------------------------------- entry points

export interface ProjectScope {
  documentVersionIds?: string[]
  entityIds?: string[]
  factIds?: string[]
  /** Re-push documents whose principals or entity names changed (no re-cut needed). */
  touchDocIds?: string[]
}

/** Rebuilds the given scope (or everything when `all`), embeds what changed and indexes it. */
export async function project(sql: Sql, tenantId: string, scope: ProjectScope | 'all', log: (m: string) => void = () => {}) {
  const dict = await loadDictionary(sql, tenantId)
  const stats = { passages: 0, entities: 0, facts: 0, changed: 0, deleted: 0, embedded: 0, indexed: 0 }
  const removed: string[] = []

  const dvIds =
    scope === 'all'
      ? (
          await sql.query<{ id: string }>(`select d.current_version_id id from public.documents d where d.tenant_id = $1 and d.deleted_at is null and d.current_version_id is not null`, [tenantId])
        ).rows.map((r) => r.id)
      : (scope.documentVersionIds ?? [])
  for (let i = 0; i < dvIds.length; i += 150) {
    const chunk = dvIds.slice(i, i + 150)
    const docs = await passagesFor(sql, tenantId, dict, chunk)
    stats.passages += docs.length
    stats.changed += await saveDocs(sql, tenantId, docs)
    removed.push(
      ...(await dropStale(
        sql,
        tenantId,
        `doc_type = 'passage' and document_version_id = any($2::uuid[])`,
        [chunk],
        docs.map((d) => d.id),
      )),
    )
    if (i % 1500 === 0) log(`passages: ${Math.min(i + 150, dvIds.length)}/${dvIds.length} documents`)
  }
  if (scope === 'all') {
    // Passages of documents that no longer exist (deleted, superseded versions).
    removed.push(...(await dropStale(sql, tenantId, `doc_type = 'passage' and not (document_version_id = any($2::uuid[]))`, [dvIds], [])))
  }

  const entityIds = scope === 'all' ? null : (scope.entityIds ?? [])
  if (entityIds === null || entityIds.length) {
    const cards = await entityCards(sql, tenantId, entityIds)
    stats.entities = cards.length
    stats.changed += await saveDocs(sql, tenantId, cards)
    if (entityIds === null)
      removed.push(
        ...(await dropStale(
          sql,
          tenantId,
          `doc_type = 'entity'`,
          [],
          cards.map((c) => c.id),
        )),
      )
    else
      removed.push(
        ...(await dropStale(
          sql,
          tenantId,
          `doc_type = 'entity' and split_part(id, '~', 1) = any($2::text[])`,
          [entityIds.map((e) => `e:${e}`)],
          cards.map((c) => c.id),
        )),
      )
    log(`entity cards: ${cards.length}`)
  }
  const factIds = scope === 'all' ? null : (scope.factIds ?? [])
  if (factIds === null || factIds.length) {
    const cards = await factCards(sql, tenantId, factIds, dict)
    stats.facts = cards.length
    stats.changed += await saveDocs(sql, tenantId, cards)
    if (factIds === null)
      removed.push(
        ...(await dropStale(
          sql,
          tenantId,
          `doc_type = 'fact' and kind <> 'timeline'`,
          [],
          cards.map((c) => c.id),
        )),
      )
    else
      removed.push(
        ...(await dropStale(
          sql,
          tenantId,
          `doc_type = 'fact' and split_part(id, '~', 1) = any($2::text[])`,
          [factIds.map((f) => `f:${f}`)],
          cards.map((c) => c.id),
        )),
      )
    log(`fact cards: ${cards.length}`)
    const tcards = await timelineCards(sql, tenantId)
    stats.changed += await saveDocs(sql, tenantId, tcards)
    removed.push(
      ...(await dropStale(
        sql,
        tenantId,
        `doc_type = 'fact' and kind = 'timeline'`,
        [],
        tcards.map((c) => c.id),
      )),
    )
    log(`timeline cards: ${tcards.length}`)
  }
  if (scope !== 'all' && scope.touchDocIds?.length) await sql.query(`update public.search_documents set indexed_at = null where tenant_id = $1 and id = any($2::text[])`, [tenantId, scope.touchDocIds])

  stats.deleted = removed.length
  await deleteFromIndex(sql, tenantId, removed)
  const idx = await indexPending(sql, tenantId, { dict, onProgress: (n) => n % 2560 === 0 && log(`indexed ${n}`) })
  stats.indexed = idx.indexed
  stats.embedded = idx.embedded
  return stats
}

/**
 * Builds a new index version alongside the live one: every document, embedded with that version's
 * model, written straight to the new index. Nothing changes for searches until swapAlias().
 */
export async function buildVersion(sql: Sql, tenantId: string, version: number, onProgress?: (n: number, total: number) => void): Promise<{ indexed: number; index: string }> {
  const slug = (await sql.query<{ slug: string }>(`select slug from public.tenants where id = $1`, [tenantId])).rows[0].slug
  const index = await createVersion(slug, version)
  const dict = await loadDictionary(sql, tenantId)
  const total = (await sql.query<{ n: number }>(`select count(*)::int n from public.search_documents where tenant_id = $1`, [tenantId])).rows[0].n
  const paths = new Map<string, { path: string; source: string | null }>()
  let n = 0
  let after = ''
  for (;;) {
    const acl = await aclPrincipals(sql, tenantId)
    const rows = (await sql.query<SearchDoc>(`select ${COLS} from public.search_documents where tenant_id = $1 and id > $2 order by id limit 256`, [tenantId, after])).rows
    if (!rows.length) break
    after = rows.at(-1)!.id
    const missing = [...new Set(rows.map((r) => r.source_object_id).filter((x): x is string => !!x && !paths.has(x)))]
    if (missing.length)
      for (const p of (
        await sql.query<{ id: string; path: string; source: string | null }>(
          `select so.id, so.original_path path, s.name source from public.source_objects so left join public.sources s on s.id = so.source_id where so.id = any($1::uuid[])`,
          [missing],
        )
      ).rows)
        paths.set(p.id, { path: p.path, source: p.source })
    const vectors = await embedPassages(
      rows.map((r) => `${r.title}\n${r.content}`),
      32,
      version,
    )
    const fields = esFields(tenantId, dict, acl, paths)
    const res = await es().bulk({ body: rows.flatMap((r, i) => [{ index: { _index: index, _id: r.id } }, { ...fields(r), embedding: vectors[i] }]), refresh: false })
    if (res.errors) throw new Error(`bulk index failed: ${JSON.stringify(res.items.find((it) => it.index?.error)?.index?.error).slice(0, 400)}`)
    n += rows.length
    onProgress?.(n, total)
  }
  await es().indices.refresh({ index })
  return { indexed: n, index }
}
