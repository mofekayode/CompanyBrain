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
import { es, indexAlias } from './es'
import { type Dictionary, linkText, loadDictionary } from './linker'
import { timelines, timelineText } from '../ontology/timeline'

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
      while (
        j < rows.length &&
        rows[j].kind === 'transcript_segment' &&
        (rows[j].end_ms ?? 0) - (r.start_ms ?? 0) <= TRANSCRIPT_MS &&
        group.reduce((n, g) => n + g.content.length, 0) < TEXT_MAX
      )
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
  const out: SearchDoc[] = []
  for (const group of byDv.values())
    for (const p of cutPassages(group)) {
      if (p.source_object_id && twins.has(p.source_object_id)) p.acl_ids = [...new Set([...p.acl_ids, ...twins.get(p.source_object_id)!])]
      // A copy in someone's private mailbox keeps that mailbox's access, even when the message
      // went to a distribution list: the stricter of the source's permission and the sensitivity
      // label wins. (Recipients see it through their own copies.)
      out.push({ ...p, entity_ids: linkText(dict, `${p.title}\n${p.content}`).map((e) => e.id) })
    }
  return out
}

// ------------------------------------------------------------------------ entity cards

async function entityAcls(sql: Sql, tenantId: string, ids: string[] | null): Promise<Map<string, string[]>> {
  // An entity is visible to whoever can read a file it came from (its own or a merged
  // duplicate's). Entities without a source file (company map, link-created) are company-wide.
  const rows = (
    await sql.query<{ id: string; acls: string[] | null }>(
      `with ents as (select e.id from public.entities e where e.tenant_id = $1 and ($2::uuid[] is null or e.id = any($2::uuid[]))),
       src as (
         select coalesce(m.merged_into_id, m.id) id, (m.metadata -> 'source' ->> 'file_id')::uuid file_id
         from public.entities m where m.tenant_id = $1 and m.metadata -> 'source' ? 'file_id'
           and coalesce(m.merged_into_id, m.id) in (select id from ents))
       select ents.id, array_remove(array_agg(distinct so.acl_id), null) acls
       from ents left join src on src.id = ents.id left join public.source_objects so on so.id = src.file_id
       group by ents.id`,
      [tenantId, ids],
    )
  ).rows
  const companyWide = (await sql.query<{ acl_id: string }>(`select acl_id from public.access_scopes where tenant_id = $1 and key = 'company-wide'`, [tenantId])).rows[0]?.acl_id
  return new Map(rows.map((r) => [r.id, r.acls?.length ? r.acls : companyWide ? [companyWide] : []]))
}

async function entityCards(sql: Sql, tenantId: string, ids: string[] | null): Promise<SearchDoc[]> {
  const ents = (
    await sql.query<{ id: string; name: string; type: string; kind: string; properties: Record<string, unknown>; aliases: string[] | null; idents: string[] | null }>(
      `select e.id, e.canonical_name name, t.name type, coalesce(t.metadata ->> 'kind', 'thing') kind, e.properties,
              array(select distinct a.alias from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected' and lower(a.alias) <> lower(e.canonical_name)) aliases,
              array(select i.system || ': ' || i.value from public.entity_identifiers i where i.entity_id = e.id limit 6) idents
       from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and coalesce(t.metadata ->> 'kind', 'thing') <> 'event'
         and ($2::uuid[] is null or e.id = any($2::uuid[]))`,
      [tenantId, ids],
    )
  ).rows
  if (!ents.length) return []
  const rels = (
    await sql.query<{ id: string; rel: string; dir: string; other_type: string; okind: string; n: number; names: string[]; last: string | null }>(
      `with ents as (select unnest($2::uuid[]) id),
       r as (
         select r.source_entity_id eid, r.target_entity_id oid, r.relationship_type_id rt, 'out' dir from public.relationships r join ents on ents.id = r.source_entity_id where r.tenant_id = $1 and r.status <> 'rejected'
         union all
         select r.target_entity_id, r.source_entity_id, r.relationship_type_id, 'in' from public.relationships r join ents on ents.id = r.target_entity_id where r.tenant_id = $1 and r.status <> 'rejected')
       select r.eid id, rt.name rel, r.dir, ot.name other_type, coalesce(ot.metadata ->> 'kind', 'thing') okind, count(*)::int n,
              (array_agg(distinct o.canonical_name))[1:8] names, max(o.properties ->> 'date') last
       from r join public.relationship_types rt on rt.id = r.rt join public.entities o on o.id = r.oid and o.status in ('candidate', 'active')
       join public.entity_types ot on ot.id = o.entity_type_id
       where rt.name <> 'possibly_same_as'
       group by 1, 2, 3, 4, 5`,
      [tenantId, ents.map((e) => e.id)],
    )
  ).rows
  const relBy = new Map<string, typeof rels>()
  for (const r of rels) relBy.set(r.id, [...(relBy.get(r.id) ?? []), r])
  const acls = await entityAcls(sql, tenantId, ents.map((e) => e.id))
  return ents.map((e) => {
    const props = Object.entries(e.properties ?? {})
      .filter(([k, v]) => k !== 'source_system' && v !== null && v !== '' && typeof v !== 'object')
      .slice(0, 12)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`)
    const links = (relBy.get(e.id) ?? [])
      .sort((a, b) => b.n - a.n)
      .slice(0, 14)
      .map((r) =>
        r.okind === 'event'
          ? `${r.other_type}s (${r.rel.replaceAll('_', ' ')}): ${r.n}${r.last ? `, latest ${String(r.last).slice(0, 10)}` : ''}`
          : `${r.rel.replaceAll('_', ' ')} ${r.dir === 'out' ? '→' : '←'} ${r.other_type}: ${r.names.join(', ')}${r.n > r.names.length ? ` (+${r.n - r.names.length})` : ''}`,
      )
    const content = [
      `${e.type}: ${e.name}`,
      e.aliases?.length ? `Also known as: ${e.aliases.join(', ')}` : '',
      e.idents?.length ? `Identifiers: ${e.idents.join('; ')}` : '',
      props.length ? props.join('\n') : '',
      links.join('\n'),
    ]
      .filter(Boolean)
      .join('\n')
    return {
      id: `e:${e.id}`,
      doc_type: 'entity' as const,
      kind: e.type,
      title: `${e.name} (${e.type})`,
      content,
      source_object_id: null,
      document_version_id: null,
      evidence_ids: [],
      entity_ids: [e.id],
      acl_ids: acls.get(e.id) ?? [],
      observed_at: null,
      valid_from: null,
      valid_to: null,
      is_current: true,
      authority: 'system_of_record',
      dedupe_key: null,
      citation: { entity_id: e.id, entity_type: e.type, kind: 'entity' },
    }
  })
}

// -------------------------------------------------------------------------- fact cards

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
      quotes: { q: string; a: string }[] | null
      evidence: string[] | null
      acls: string[] | null
      files: string[] | null
    }>(
      `select f.id, s.id subject_id, s.canonical_name subject, t.name type, f.predicate, f.value #>> '{}' value, f.valid_from::text, f.valid_to::text, f.status, f.authority, f.note,
              f.metadata ->> 'summary' summary, f.metadata ->> 'kind' fkind,
              (select jsonb_agg(jsonb_build_object('q', left(coalesce(c.metadata ->> 'quote', c.value #>> '{}'), 240), 'a', c.authority)) from (
                  select c.* from public.fact_claims fc join public.facts c on c.id = fc.claim_id where fc.canonical_id = f.id limit 4) c) quotes,
              (select array_agg(distinct l.evidence_id) from public.evidence_links l
                where l.fact_id = f.id or l.fact_id in (select claim_id from public.fact_claims where canonical_id = f.id)) evidence,
              (select array_remove(array_agg(distinct e.acl_id), null) from public.evidence_links l join public.evidence e on e.id = l.evidence_id
                where l.fact_id = f.id or l.fact_id in (select claim_id from public.fact_claims where canonical_id = f.id)) acls,
              (select array_agg(distinct dv.source_object_id) from public.evidence_links l join public.evidence e on e.id = l.evidence_id
                 join public.document_versions dv on dv.id = e.document_version_id
                where l.fact_id = f.id or l.fact_id in (select claim_id from public.fact_claims where canonical_id = f.id)) files
       from public.facts f join public.entities s on s.id = f.subject_entity_id join public.entity_types t on t.id = s.entity_type_id
       where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status <> 'rejected' and ($2::uuid[] is null or f.id = any($2::uuid[]))`,
      [tenantId, ids],
    )
  ).rows
  if (!facts.length) return []
  // Readers of an identical copy of an evidence file may read what was read from it.
  const twins = await twinAcls(sql, tenantId, [...new Set(facts.flatMap((f) => f.files ?? []))])
  for (const f of facts) {
    const extra = (f.files ?? []).flatMap((so) => twins.get(so) ?? [])
    if (extra.length) f.acls = [...new Set([...(f.acls ?? []), ...extra])]
  }
  // Facts backed only by system fields inherit their subject's visibility.
  const subjAcl = await entityAcls(sql, tenantId, [...new Set(facts.filter((f) => !f.acls?.length).map((f) => f.subject_id))])
  const today = new Date().toISOString().slice(0, 10)
  // Every fact that changed carries its own history, so any hit can say "it was X before".
  const chains = new Map<string, string>()
  for (const tl of await timelines(sql, tenantId)) {
    if (!tl.key.startsWith('sp:')) continue
    const text = timelineText(tl.steps)
    for (const st of tl.steps) chains.set(st.fact_id, text)
  }
  return facts.map((f) => {
    const when = f.valid_from || f.valid_to ? `Valid ${f.valid_from ?? '…'} to ${f.valid_to ?? 'now'}.` : ''
    const content = [
      `${f.subject} (${f.type}) · ${f.predicate.replaceAll('_', ' ')}: ${f.value}`,
      f.summary ?? '',
      when,
      `Status: ${f.status}${f.authority ? ` · strongest source: ${f.authority}` : ''}`,
      chains.has(f.id) ? `Timeline: ${chains.get(f.id)}` : '',
      f.note ? `Review note: ${f.note}` : '',
      ...(f.quotes ?? []).map((q) => `“${q.q}” (${q.a})`),
    ]
      .filter(Boolean)
      .join('\n')
    return {
      id: `f:${f.id}`,
      doc_type: 'fact' as const,
      kind: f.fkind ?? 'fact',
      title: `${f.subject}: ${f.predicate.replaceAll('_', ' ')}`,
      content,
      source_object_id: null,
      document_version_id: null,
      evidence_ids: f.evidence ?? [],
      // The subject, plus everything the fact mentions: "Blue Ridge · p17 suction fix completed" is
      // also about TP-17, so a search for TP-17 (or its page) finds it.
      entity_ids: [...new Set([f.subject_id, ...(dict ? linkText(dict, `${f.predicate.replaceAll('_', ' ')}\n${f.value}\n${f.summary ?? ''}\n${(f.quotes ?? []).map((q) => q.q).join('\n')}`).filter((e) => e.type !== 'Term').map((e) => e.id) : [])])],
      acl_ids: f.acls?.length ? f.acls : (subjAcl.get(f.subject_id) ?? []),
      observed_at: null,
      valid_from: f.valid_from,
      valid_to: f.valid_to,
      is_current: f.status !== 'superseded' && (!f.valid_to || f.valid_to > today),
      authority: f.authority,
      dedupe_key: null,
      citation: { fact_id: f.id, kind: 'fact', status: f.status },
    }
  })
}

// ------------------------------------------------------------------------ timeline cards

/** One card per shared rule that changed over time across subjects (e.g. who may approve discounts). */
async function timelineCards(sql: Sql, tenantId: string): Promise<SearchDoc[]> {
  const rules = new Set(
    (await sql.query<{ topic: string }>(`select distinct metadata ->> 'topic' topic from public.facts where tenant_id = $1 and metadata ->> 'topic_kind' = 'rule' or (tenant_id = $1 and metadata ? 'topic' and not metadata ? 'topic_auto')`, [tenantId])).rows.map((r) => r.topic),
  )
  const out: SearchDoc[] = []
  for (const tl of await timelines(sql, tenantId)) {
    if (!tl.key.startsWith('topic:') || !rules.has(tl.key.slice(6))) continue
    const steps = tl.steps.filter((s) => s.valid_from || s.valid_to)
    if (steps.length < 2) continue
    const acl = (
      await sql.query<{ acls: string[] | null }>(`select array_agg(distinct a) acls from public.search_documents d, unnest(d.acl_ids) a where d.tenant_id = $1 and d.id = any($2::text[])`, [
        tenantId,
        tl.steps.map((s) => `f:${s.fact_id}`),
      ])
    ).rows[0].acls
    const lines = steps.map((s) => `${s.valid_from ?? '…'} → ${s.valid_to ?? 'now'} · ${s.subject}: ${s.value}${s.status === 'superseded' ? ' (replaced)' : ''}`)
    out.push({
      id: `t:${tl.key.slice(6)}`,
      doc_type: 'fact',
      kind: 'timeline',
      title: `How ${tl.label} changed over time`,
      content: [`${tl.label}: history across ${tl.subject_ids.length} records:`, ...lines].join('\n'),
      source_object_id: null,
      document_version_id: null,
      evidence_ids: [],
      entity_ids: tl.subject_ids,
      acl_ids: acl ?? [],
      observed_at: null,
      valid_from: steps[0].valid_from,
      valid_to: null,
      is_current: true,
      authority: null,
      dedupe_key: null,
      citation: { kind: 'timeline', topic: tl.key.slice(6), facts: tl.steps.map((s) => s.fact_id) },
    })
  }
  return out
}

// ------------------------------------------------------------------------------ store

const COLS = 'id, doc_type, kind, title, content, source_object_id, document_version_id, evidence_ids, entity_ids, acl_ids, observed_at, valid_from, valid_to, is_current, authority, dedupe_key, citation'

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
export async function indexPending(sql: Sql, tenantId: string, opts: { dict?: Dictionary; onProgress?: (n: number) => void } = {}): Promise<{ indexed: number; embedded: number }> {
  const slug = (await sql.query<{ slug: string }>(`select slug from public.tenants where id = $1`, [tenantId])).rows[0].slug
  const dict = opts.dict ?? (await loadDictionary(sql, tenantId))
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
    const vectors = fresh.length ? await embedPassages(fresh.map((r) => `${r.title}\n${r.content}`)) : []
    const vec = new Map(fresh.map((r, i) => [r.id, vectors[i]]))
    embedded += fresh.length
    const fields = (r: SearchDoc) => ({
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
      dedupe_key: r.dedupe_key,
      citation: r.citation,
    })
    const body: Record<string, unknown>[] = rows.flatMap((r): Record<string, unknown>[] =>
      vec.has(r.id)
        ? [{ index: { _index: indexAlias(slug), _id: r.id } }, { ...fields(r), embedding: vec.get(r.id) }]
        : [{ update: { _index: indexAlias(slug), _id: r.id } }, { doc: fields(r) }],
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
  for (let i = 0; i < ids.length; i += 1000)
    await es().bulk({ body: ids.slice(i, i + 1000).map((id) => ({ delete: { _index: indexAlias(slug), _id: id } })), refresh: false })
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
      ? (await sql.query<{ id: string }>(`select d.current_version_id id from public.documents d where d.tenant_id = $1 and d.deleted_at is null and d.current_version_id is not null`, [tenantId])).rows.map((r) => r.id)
      : (scope.documentVersionIds ?? [])
  for (let i = 0; i < dvIds.length; i += 150) {
    const chunk = dvIds.slice(i, i + 150)
    const docs = await passagesFor(sql, tenantId, dict, chunk)
    stats.passages += docs.length
    stats.changed += await saveDocs(sql, tenantId, docs)
    removed.push(...(await dropStale(sql, tenantId, `doc_type = 'passage' and document_version_id = any($2::uuid[])`, [chunk], docs.map((d) => d.id))))
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
    if (entityIds === null) removed.push(...(await dropStale(sql, tenantId, `doc_type = 'entity'`, [], cards.map((c) => c.id))))
    else removed.push(...(await dropStale(sql, tenantId, `doc_type = 'entity' and id = any($2::text[])`, [entityIds.map((e) => `e:${e}`)], cards.map((c) => c.id))))
    log(`entity cards: ${cards.length}`)
  }
  const factIds = scope === 'all' ? null : (scope.factIds ?? [])
  if (factIds === null || factIds.length) {
    const cards = await factCards(sql, tenantId, factIds, dict)
    stats.facts = cards.length
    stats.changed += await saveDocs(sql, tenantId, cards)
    if (factIds === null) removed.push(...(await dropStale(sql, tenantId, `doc_type = 'fact' and kind <> 'timeline'`, [], cards.map((c) => c.id))))
    else removed.push(...(await dropStale(sql, tenantId, `doc_type = 'fact' and id = any($2::text[])`, [factIds.map((f) => `f:${f}`)], cards.map((c) => c.id))))
    log(`fact cards: ${cards.length}`)
    const tcards = await timelineCards(sql, tenantId)
    stats.changed += await saveDocs(sql, tenantId, tcards)
    removed.push(...(await dropStale(sql, tenantId, `doc_type = 'fact' and kind = 'timeline'`, [], tcards.map((c) => c.id))))
    log(`timeline cards: ${tcards.length}`)
  }
  if (scope !== 'all' && scope.touchDocIds?.length)
    await sql.query(`update public.search_documents set indexed_at = null where tenant_id = $1 and id = any($2::text[])`, [tenantId, scope.touchDocIds])

  stats.deleted = removed.length
  await deleteFromIndex(sql, tenantId, removed)
  const idx = await indexPending(sql, tenantId, { dict, onProgress: (n) => n % 2560 === 0 && log(`indexed ${n}`) })
  stats.indexed = idx.indexed
  stats.embedded = idx.embedded
  return stats
}
