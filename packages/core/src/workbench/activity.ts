// What the worker is doing for a client, file by file: the activity panel.
// Reads ingestion_jobs; nothing here changes state.

import { pool } from './server'

export interface ActivityRun {
  id: string
  kind: string
  label: string | null
  status: string
  started_at: string
  finished_at: string | null
  total: number
  done: number
  failed: number
  running: number
  queued: number
  seconds: number
}

export interface ActivityJob {
  id: string
  job_type: string
  /** Plain-language step, e.g. "Reading PDF with Docling". */
  step: string
  status: 'queued' | 'running' | 'waiting' | 'retrying' | 'succeeded' | 'failed'
  file_id: string | null
  file_path: string | null
  format: string | null
  size_bytes: number | null
  attempts: number
  max_attempts: number
  started_at: string | null
  finished_at: string | null
  /** Seconds spent (so far, when running). */
  seconds: number | null
  /** One-line outcome, e.g. "42 passages · 12 pages". */
  outcome: string | null
  error: string | null
}

const STEP: Record<string, (format: string | null) => string> = {
  extract_document: (f) => (f === 'pdf' ? 'Reading PDF with Docling' : f === 'pptx' ? 'Reading slides with Docling' : 'Reading document with Docling'),
  extract_table: (f) => (f === 'xlsx' ? 'Reading spreadsheet' : 'Reading CSV table'),
  extract_text: () => 'Reading text',
  unpack_mailbox: () => 'Splitting mailbox into messages',
  extract_email: () => 'Reading email',
  describe_image: () => 'Describing photo (vision)',
  transcribe_audio: () => 'Transcribing audio (speakers + timestamps)',
  analyze_video: () => 'Watching video: scenes, on-screen text, speech',
  embed_video: () => 'Embedding video (Twelve Labs)',
  index_email: () => 'Rebuilding email threads and address book',
  profile_object: () => 'Profiling file',
  build_company_map: () => 'Building the company map from directory exports',
  propose_access: () => 'Proposing access scopes and assigning every file',
  propose_ontology: () => 'Proposing the company model: types, relationships, what each table is',
  project_search: () => 'Updating the search index with what changed',
  load_ontology: () => 'Loading entities, events and links from the tables',
  resolve_entities: () => 'Resolving duplicates across systems',
  extract_knowledge: () => 'Reading for vocabulary, exceptions and facts',
  canonicalize_facts: () => 'Grouping claims into canonical facts: authority, timelines, conflicts',
  unpack_archive: () => 'Unpacking archive',
}

function outcome(jobType: string, r: Record<string, unknown> | null): string | null {
  if (!r) return null
  if (r.already) return 'already extracted (no change)'
  if (r.duplicate_of) return 'same bytes as another file: reused its extraction'
  if (jobType === 'unpack_mailbox' && typeof r.messages === 'number') return `${r.messages} messages split out`
  if (jobType === 'index_email') return `${r.threads} threads from ${r.messages} messages · ${r.addresses} addresses`
  if (jobType === 'embed_video') return `${r.segments} segments × ${r.dimensions} dims`
  if (jobType === 'build_company_map') {
    const s = r.by_status as Record<string, number> | undefined
    return `${r.people} people (${s?.active ?? 0} active, ${s?.former ?? 0} former, ${s?.guest ?? 0} guests) · ${Array.isArray(r.files) ? r.files.length : 0} directory files`
  }
  if (jobType === 'propose_ontology') return `${(r.entity_types as unknown[])?.length ?? 0} types · ${(r.relationship_types as unknown[])?.length ?? 0} relationships · ${(r.tables as { kind: string }[])?.filter((t) => t.kind !== 'ignore').length ?? 0} tables used`
  if (jobType === 'canonicalize_facts') return `${r.canonical} facts from ${r.claims} claims · ${r.conflicts} conflicts · ${r.timelines} timeline steps`
  if (jobType === 'extract_knowledge') return `${r.facts} facts · ${r.vocabulary} terms from ${r.passages} passages`
  if (jobType === 'load_ontology') return `${Number(r.entities).toLocaleString()} entities · ${Number(r.relationships).toLocaleString()} links`
  if (jobType === 'resolve_entities') {
    const v = Object.values(r as Record<string, { certain?: number; ai_merged?: number; placeholders?: number; unsure?: number }>)
    const sum = (k: 'certain' | 'ai_merged' | 'placeholders' | 'unsure') => v.reduce((a, x) => a + (x?.[k] ?? 0), 0)
    return `${sum('certain') + sum('ai_merged')} merged (${sum('ai_merged')} by AI) · ${sum('placeholders')} placeholders · ${sum('unsure')} to review`
  }
  if (jobType === 'propose_access') return `${r.scopes} scopes · ${r.rules} rules · ${r.files} files assigned · ${r.escalated} escalated`
  if (jobType === 'profile_object' || jobType === 'unpack_archive') return null
  const parts: string[] = []
  if (typeof r.evidence === 'number') parts.push(`${r.evidence} passage${r.evidence === 1 ? '' : 's'}`)
  if (r.kinds && typeof r.kinds === 'object') {
    const k = r.kinds as Record<string, number>
    if (k.table) parts.push(`${k.table} table${k.table === 1 ? '' : 's'}`)
    if (k.ocr) parts.push('OCR')
  }
  if (typeof r.pages === 'number') parts.push(`${r.pages} page${r.pages === 1 ? '' : 's'}`)
  if (typeof r.seconds === 'number' && r.seconds > 0) parts.push(`${Math.floor(r.seconds / 60)}:${String(Math.round(r.seconds % 60)).padStart(2, '0')} of media`)
  if (typeof r.attachments === 'number' && r.attachments > 0) parts.push(`${r.attachments} attachment${r.attachments === 1 ? '' : 's'}`)
  if (typeof r.extractor === 'string') parts.push(r.extractor)
  return parts.join(' · ') || null
}

/** Recent extraction/profiling runs for a client (newest first). */
export async function listRuns(tenantId: string, limit = 10): Promise<ActivityRun[]> {
  const { rows } = await pool().query(
    `select r.id, r.payload ->> 'kind' kind, r.payload ->> 'label' label, r.status, r.started_at, r.finished_at,
            count(c.id)::int total,
            count(c.id) filter (where c.status = 'succeeded')::int done,
            count(c.id) filter (where c.status = 'dead')::int failed,
            count(c.id) filter (where c.status = 'running')::int running,
            count(c.id) filter (where c.status = 'queued')::int queued,
            extract(epoch from (coalesce(r.finished_at, now()) - r.started_at))::int seconds
     from public.ingestion_jobs r left join public.ingestion_jobs c on c.parent_job_id = r.id
     where r.tenant_id = $1 and r.job_type = 'run'
     group by r.id order by r.created_at desc limit $2`,
    [tenantId, limit],
  )
  return rows
}

/** The jobs of one run (default: the latest), running first, then finished (newest first), then queued. */
export async function runActivity(tenantId: string, runId?: string, limit = 150): Promise<{ run: ActivityRun | null; jobs: ActivityJob[]; queued_more: number }> {
  const runs = await listRuns(tenantId, 20)
  const run = runId ? (runs.find((r) => r.id === runId) ?? null) : (runs[0] ?? null)
  if (!run) return { run: null, jobs: [], queued_more: 0 }
  const { rows } = await pool().query(
    `select j.id, j.job_type, j.status, j.attempts, j.max_attempts, j.last_error, j.result,
            j.locked_at, j.started_at, j.finished_at,
            so.id file_id, so.original_path file_path, so.size_bytes, so.metadata -> 'profile' ->> 'format' format,
            extract(epoch from (coalesce(j.finished_at, now()) - j.locked_at))::float seconds
     from public.ingestion_jobs j
     left join public.source_objects so on so.id = j.source_object_id
     where j.tenant_id = $1 and j.parent_job_id = $2
     order by case j.status when 'running' then 0 when 'queued' then 2 else 1 end,
              coalesce(j.finished_at, j.locked_at, j.created_at) desc, so.original_path
     limit $3`,
    [tenantId, run.id, limit],
  )
  const jobs: ActivityJob[] = rows.map((r) => {
    const waiting = r.status === 'queued' && typeof r.last_error === 'string' && r.last_error.startsWith('waiting:')
    const retrying = r.status === 'queued' && r.attempts > 0 && !waiting
    const status: ActivityJob['status'] =
      r.status === 'dead' ? 'failed' : waiting ? 'waiting' : retrying ? 'retrying' : (r.status as ActivityJob['status'])
    return {
      id: r.id,
      job_type: r.job_type,
      step: (STEP[r.job_type] ?? (() => r.job_type))(r.format),
      status,
      file_id: r.file_id,
      file_path: r.file_path,
      format: r.format,
      size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
      attempts: r.attempts,
      max_attempts: r.max_attempts,
      started_at: r.locked_at,
      finished_at: r.finished_at,
      seconds: r.locked_at ? Math.max(0, Number(r.seconds)) : null,
      outcome: r.status === 'succeeded' ? outcome(r.job_type, r.result) : null,
      error: r.status === 'succeeded' ? null : waiting ? String(r.last_error).replace(/^waiting:\s*/, '') : r.last_error,
    }
  })
  return { run, jobs, queued_more: Math.max(0, run.queued - jobs.filter((j) => j.status === 'queued').length) }
}
