import { type ExtractionOptions, sampleObjectIds, startExtraction } from '../jobs/extraction'
import { pool } from './server'

export interface ExtractionStatus {
  /** Files with something to extract vs. files done (succeeded, duplicate or skipped). */
  files: { total: number; extracted: number; skipped: number; failed: number }
  /** Files with no extraction result yet (neither extracted, skipped nor failed). */
  remaining: number
  /** Extraction jobs queued or running for this client, across runs. */
  pending_jobs: number
  evidence: number
  by_kind: { kind: string; documents: number; evidence: number }[]
  run: { id: string; status: string; progress: { total: number; done: number; failed: number; pending: number }; started_at: string; finished_at: string | null } | null
}

/** Only extraction work counts as "extracting" (not profiling, access or model runs). */
const EXTRACTION_JOB_TYPES = ['extract_document', 'extract_table', 'extract_text', 'unpack_mailbox', 'extract_email', 'describe_image', 'transcribe_audio', 'analyze_video', 'embed_video', 'index_email']

export async function extractionStatus(tenantId: string): Promise<ExtractionStatus> {
  const db = pool()
  const files = (
    await db.query<{ total: number; extracted: number; skipped: number; failed: number }>(
      `select count(*)::int total,
              count(*) filter (where exists (select 1 from public.document_versions dv where dv.source_object_id = so.id and dv.extraction_status = 'succeeded'))::int extracted,
              count(*) filter (where exists (select 1 from public.document_versions dv where dv.source_object_id = so.id and dv.extraction_status = 'skipped'))::int skipped,
              count(*) filter (where exists (select 1 from public.ingestion_jobs j where j.source_object_id = so.id and j.status = 'dead' and j.job_type not in ('profile_object', 'unpack_archive')))::int failed
       from public.source_objects so
       where so.tenant_id = $1
         and (so.metadata ? 'profile'
              -- mailbox messages are not profiled; they enter through their extraction job
              or exists (select 1 from public.ingestion_jobs j where j.source_object_id = so.id and j.job_type = 'extract_email'))`,
      [tenantId],
    )
  ).rows[0]
  const evidence = (await db.query<{ n: number }>(`select count(*)::int n from public.evidence where tenant_id = $1`, [tenantId])).rows[0].n
  const byKind = (
    await db.query<{ kind: string; documents: number; evidence: number }>(
      `select d.kind, count(distinct d.id)::int documents, count(e.id)::int evidence
       from public.documents d join public.document_versions dv on dv.id = d.current_version_id
       left join public.evidence e on e.document_version_id = dv.id
       where d.tenant_id = $1 and dv.extraction_status = 'succeeded' group by 1 order by 3 desc`,
      [tenantId],
    )
  ).rows
  const run = (
    await db.query(
      `select r.id, r.status, r.started_at, r.finished_at,
              json_build_object('total', count(c.id), 'done', count(c.id) filter (where c.status = 'succeeded'),
                                'failed', count(c.id) filter (where c.status = 'dead'), 'pending', count(c.id) filter (where c.status in ('queued', 'running'))) progress
       from public.ingestion_jobs r left join public.ingestion_jobs c on c.parent_job_id = r.id
       where r.tenant_id = $1 and r.job_type = 'run' and r.payload ->> 'kind' = 'extract'
       group by r.id order by r.created_at desc limit 1`,
      [tenantId],
    )
  ).rows[0]
  const pendingJobs = (
    await db.query<{ n: number }>(
      `select count(*)::int n from public.ingestion_jobs
       where tenant_id = $1 and status in ('queued', 'running') and job_type = any($2::text[])`,
      [tenantId, EXTRACTION_JOB_TYPES],
    )
  ).rows[0].n
  return {
    files,
    remaining: Math.max(0, files.total - files.extracted - files.skipped - files.failed),
    pending_jobs: pendingJobs,
    evidence,
    by_kind: byKind,
    run: run ?? null,
  }
}

/**
 * Starts extraction for a client.
 * - mode 'remaining' (default): every file without a current extraction (and retries failures)
 * - mode 'sample': a small representative set, extracted again even if done before (cheap preview of the pipeline)
 * - mode 'files': the given files, extracted again
 */
export async function startTenantExtraction(tenantId: string, opts: { mode?: 'remaining' | 'sample' | 'files'; fileIds?: string[] } = {}) {
  const db = pool()
  if (opts.mode === 'sample') {
    const ids = await sampleObjectIds(db, tenantId)
    return startExtraction(db, tenantId, { objectIds: ids, force: true, label: `Sample (${ids.length} files)` } satisfies ExtractionOptions)
  }
  if (opts.mode === 'files') {
    const ids = (opts.fileIds ?? []).slice(0, 200)
    if (!ids.length) throw new Error('no files given')
    return startExtraction(db, tenantId, { objectIds: ids, force: true, label: ids.length === 1 ? 'Re-extract 1 file' : `Re-extract ${ids.length} files` })
  }
  return startExtraction(db, tenantId, { label: 'All remaining files' })
}
