// Search over extracted evidence, returning exact citations: file, page,
// section, sheet rows, email message, or audio/video timestamp.
//
// Postgres full-text search for now (evidence.search_tsv). All words must match
// first; if nothing does, any word may match.

import { pool } from './server'

/** Anything that can run a query: the service pool, or a connection acting as one person. */
export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>
}

export interface EvidenceHit {
  evidence_id: string
  kind: string
  citation: string
  snippet: string
  file_id: string
  file_path: string
  source: string
  document_kind: string
  page_number: number | null
  section: string | null
  start_ms: number | null
  end_ms: number | null
  speaker: string | null
  observed_at: string | null
  locator: Record<string, unknown>
  rank: number
}

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** "Safety/Manual.pdf, p. 12, § Lockout > Valves" · "rates.csv, rows 41–80" · "Interview 3.m4a, 4:05–4:31, Speaker 2" */
export function citation(r: {
  file_path: string
  page_number: number | null
  section_path: string[] | null
  start_ms: number | null
  end_ms: number | null
  speaker: string | null
  observed_at: string | Date | null
  kind: string
  locator: Record<string, unknown>
}): string {
  const parts = [r.file_path]
  if (r.page_number != null) parts.push(`p. ${r.page_number}`)
  const loc = r.locator ?? {}
  if (typeof loc.sheet === 'string' && loc.sheet !== 'CSV') parts.push(`sheet "${loc.sheet}"`)
  if (loc.row_start != null) parts.push(`rows ${loc.row_start}–${loc.row_end}`)
  if (r.section_path?.length) parts.push(`§ ${r.section_path.join(' > ')}`)
  if (r.start_ms != null) parts.push(r.end_ms != null ? `${mmss(r.start_ms)}–${mmss(r.end_ms)}` : mmss(r.start_ms))
  if (r.speaker) parts.push(r.speaker)
  if (r.kind === 'email_body' && r.observed_at) parts.push(`sent ${new Date(r.observed_at).toISOString().slice(0, 10)}`)
  if (loc.part === 'forwarded') parts.push('forwarded content')
  return parts.join(', ')
}

const KINDS = ['text', 'table', 'ocr', 'email_body', 'transcript_segment', 'video_segment', 'image'] as const
export type EvidenceKind = (typeof KINDS)[number]
export const EVIDENCE_KINDS = KINDS

export async function searchEvidence(
  tenantId: string,
  query: string,
  /** db: run as a specific person (RLS) by passing their connection; default is the service pool (FDE, sees all). */
  opts: { kinds?: EvidenceKind[]; fileId?: string; limit?: number; db?: Queryable } = {},
): Promise<{ query: string; matched: 'all_words' | 'any_word' | 'none'; total: number; hits: EvidenceHit[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30)
  const db = opts.db ?? pool()
  const run = async (tsquery: string) =>
    (
      await db.query(
        `with q as (select ${tsquery} as q)
         select e.id evidence_id, e.kind, e.page_number, e.section_path, e.start_ms, e.end_ms, e.speaker, e.observed_at, e.locator,
                so.id file_id, so.original_path file_path, s.name source, d.kind document_kind,
                ts_rank_cd(e.search_tsv, q.q) rank,
                ts_headline('english', e.content, q.q, 'MaxFragments=2, MinWords=8, MaxWords=40, StartSel=**, StopSel=**') snippet,
                count(*) over () total
         from q
         cross join public.evidence e
         join public.document_versions dv on dv.id = e.document_version_id
         join public.documents d on d.id = dv.document_id and d.current_version_id = dv.id
         join public.source_objects so on so.id = dv.source_object_id
         join public.sources s on s.id = so.source_id
         where e.tenant_id = $1 and e.search_tsv @@ q.q
           and ($3::text[] is null or e.kind = any($3::text[]))
           and ($4::uuid is null or so.id = $4::uuid)
         order by rank desc, so.original_path, e.ordinal
         limit $5`,
        [tenantId, query, opts.kinds?.length ? opts.kinds : null, opts.fileId ?? null, limit],
      )
    ).rows
  let rows = await run(`websearch_to_tsquery('english', $2)`)
  let matched: 'all_words' | 'any_word' | 'none' = 'all_words'
  if (rows.length === 0) {
    // Any word: OR the lexemes of the query.
    rows = await run(`nullif(replace(plainto_tsquery('english', $2)::text, ' & ', ' | '), '')::tsquery`)
    matched = rows.length ? 'any_word' : 'none'
  }
  return {
    query,
    matched,
    total: Number(rows[0]?.total ?? 0),
    hits: rows.map((r) => ({
      evidence_id: r.evidence_id,
      kind: r.kind,
      citation: citation(r),
      snippet: r.snippet.replace(/\s+/g, ' ').trim(),
      file_id: r.file_id,
      file_path: r.file_path,
      source: r.source,
      document_kind: r.document_kind,
      page_number: r.page_number,
      section: r.section_path?.join(' > ') ?? null,
      start_ms: r.start_ms,
      end_ms: r.end_ms,
      speaker: r.speaker,
      observed_at: r.observed_at,
      locator: r.locator,
      rank: Number(r.rank),
    })),
  }
}

/** One evidence unit in full, with its neighbours in the same document for context. */
export async function getEvidence(tenantId: string, evidenceId: string, context = 1) {
  const { rows } = await pool().query(
    `with target as (
       select e.document_version_id, e.ordinal from public.evidence e where e.tenant_id = $1 and e.id = $2)
     select e.id evidence_id, e.ordinal, e.kind, e.content, e.page_number, e.section_path, e.start_ms, e.end_ms, e.speaker, e.observed_at, e.locator,
            e.metadata, so.id file_id, so.original_path file_path, d.kind document_kind, d.title, e.id = $2 as is_target
     from target t
     join public.evidence e on e.document_version_id = t.document_version_id and e.ordinal between t.ordinal - $3 and t.ordinal + $3
     join public.document_versions dv on dv.id = e.document_version_id
     join public.documents d on d.id = dv.document_id
     join public.source_objects so on so.id = dv.source_object_id
     order by e.ordinal`,
    [tenantId, evidenceId, Math.min(Math.max(context, 0), 5)],
  )
  if (!rows.length) return null
  return rows.map((r) => ({ ...r, citation: citation(r) }))
}

/** A whole email conversation, in order, with what each message added. */
export async function getEmailThread(tenantId: string, ref: { documentId?: string; fileId?: string; threadId?: string }) {
  const db = pool()
  const thread = (
    await db.query(
      `select t.* from public.email_threads t
       where t.tenant_id = $1 and (
         t.id = $2::uuid
         or t.id = (select m.thread_id from public.email_thread_messages m where m.tenant_id = $1 and m.document_id = $3::uuid)
         or t.id = (select m.thread_id from public.email_thread_messages m join public.documents d on d.id = m.document_id
                    join public.document_versions dv on dv.id = d.current_version_id where m.tenant_id = $1 and dv.source_object_id = $4::uuid))
       limit 1`,
      [tenantId, ref.threadId ?? null, ref.documentId ?? null, ref.fileId ?? null],
    )
  ).rows[0]
  if (!thread) return null
  const messages = (
    await db.query(
      `select m.ordinal, m.depth, m.sent_at, so.id file_id, so.original_path file_path, dv.metadata -> 'from' as "from", dv.metadata -> 'to' as "to",
              dv.metadata ->> 'subject' subject, dv.metadata -> 'attachments' attachments, dv.metadata -> 'forwarded' forwarded,
              (select string_agg(substr(e.content, strpos(e.content, E'\\n\\n') + 2), E'\\n…\\n' order by e.ordinal) from public.evidence e where e.document_version_id = dv.id) body
       from public.email_thread_messages m
       join public.documents d on d.id = m.document_id
       join public.document_versions dv on dv.id = d.current_version_id
       join public.source_objects so on so.id = dv.source_object_id
       where m.thread_id = $1 order by m.ordinal`,
      [thread.id],
    )
  ).rows
  return { thread, messages: messages.map((m) => ({ ...m, body: (m.body ?? '').slice(0, 3000) })) }
}

/** What extraction produced for one file: its versions (newest first) and the current version's evidence. */
export async function fileExtraction(tenantId: string, fileId: string) {
  const db = pool()
  const versions = (
    await db.query(
      `select dv.id, dv.extractor, dv.extractor_version, dv.extraction_status status, dv.page_count, dv.created_at,
              d.current_version_id = dv.id as current, d.kind document_kind,
              dv.metadata ->> 'same_content_as' same_content_as, dv.metadata ->> 'reason' reason, dv.metadata ->> 'fallback_reason' fallback_reason,
              dv.metadata -> 'twelvelabs' twelvelabs,
              (select count(*)::int from public.evidence e where e.document_version_id = dv.id) evidence
       from public.document_versions dv join public.documents d on d.id = dv.document_id
       where dv.tenant_id = $1 and dv.source_object_id = $2
       order by dv.created_at desc`,
      [tenantId, fileId],
    )
  ).rows
  const current = versions.find((v) => v.current) ?? versions[0]
  // A duplicate's evidence lives on the version it points to.
  const evidenceVersion = current?.same_content_as ?? current?.id
  const evidence = evidenceVersion
    ? (
        await db.query(
          `select e.id evidence_id, e.ordinal, e.kind, e.content, e.page_number, e.section_path, e.start_ms, e.end_ms, e.speaker, e.observed_at, e.locator,
                  so.original_path file_path
           from public.evidence e
           join public.document_versions dv on dv.id = e.document_version_id
           join public.source_objects so on so.id = dv.source_object_id
           where e.document_version_id = $1 order by e.ordinal limit 500`,
          [evidenceVersion],
        )
      ).rows.map((r) => ({ ...r, citation: citation(r), content: String(r.content).slice(0, 8000) }))
    : []
  const children = (
    await db.query<{ n: number }>(`select count(*)::int n from public.source_objects where tenant_id = $1 and parent_id = $2`, [tenantId, fileId])
  ).rows[0].n
  return { versions, evidence, children }
}
