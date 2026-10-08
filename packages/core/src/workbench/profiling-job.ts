import { enqueue, settleParent, startRun } from '../jobs/queue'
import { PROFILER_VERSION } from '../profiling/profile'
import { pool } from './server'

export interface ProfilingStatus {
  objects: number
  profiled_current: number
  profiler_version: number
  last_profiled_at: string | null
  /** Jobs waiting or running for this client right now (uploads, unpacking, profiling). */
  queue: { queued: number; running: number; failed_recently: number }
  /** True when work is queued but no worker has picked anything up for a while. */
  worker_idle: boolean
  job: {
    id: string
    status: 'running' | 'succeeded' | 'failed'
    kind: string
    progress: { total: number; done: number; failed: number; pending: number }
    started_at: string
    finished_at: string | null
    last_error: string | null
  } | null
}

export async function profilingStatus(tenantId: string): Promise<ProfilingStatus> {
  const db = pool()
  const counts = (
    await db.query<{ objects: number; profiled_current: number; last_profiled_at: string | null }>(
      `select count(*)::int objects,
              count(*) filter (where coalesce((metadata -> 'profile' ->> 'profiler_version')::int, 0) >= $2)::int profiled_current,
              max(metadata -> 'profile' ->> 'profiled_at') last_profiled_at
       from public.source_objects where tenant_id = $1`,
      [tenantId, PROFILER_VERSION],
    )
  ).rows[0]
  const queue = (
    await db.query<{ queued: number; running: number; failed_recently: number; oldest_queued_s: number | null; last_claim_s: number | null }>(
      `select count(*) filter (where status = 'queued')::int queued,
              count(*) filter (where status = 'running')::int running,
              count(*) filter (where status = 'dead' and finished_at > now() - interval '1 day')::int failed_recently,
              extract(epoch from now() - min(created_at) filter (where status = 'queued'))::int oldest_queued_s,
              extract(epoch from now() - max(started_at))::int last_claim_s
       from public.ingestion_jobs where tenant_id = $1 and job_type in ('profile_object', 'unpack_archive')`,
      [tenantId],
    )
  ).rows[0]
  const run = (
    await db.query(
      `select r.id, r.status, r.payload ->> 'kind' kind, r.started_at, r.finished_at, r.last_error,
              json_build_object(
                'total', count(c.id),
                'done', count(c.id) filter (where c.status = 'succeeded'),
                'failed', count(c.id) filter (where c.status = 'dead'),
                'pending', count(c.id) filter (where c.status in ('queued', 'running'))) progress
       from public.ingestion_jobs r left join public.ingestion_jobs c on c.parent_job_id = r.id
       where r.tenant_id = $1 and r.job_type = 'run' and r.payload ->> 'kind' in ('profile', 'upload')
       group by r.id order by r.created_at desc limit 1`,
      [tenantId],
    )
  ).rows[0]
  const workerIdle = queue.queued > 0 && queue.running === 0 && (queue.oldest_queued_s ?? 0) > 15 && (queue.last_claim_s == null || queue.last_claim_s > 15)
  return {
    ...counts,
    profiler_version: PROFILER_VERSION,
    queue: { queued: queue.queued, running: queue.running, failed_recently: queue.failed_recently },
    worker_idle: workerIdle,
    job: run ?? null,
  }
}

/** Queues profiling for a client's files (new/outdated ones, or all with force). Returns the run id. */
export async function startProfiling(tenantId: string, force: boolean): Promise<{ id: string; queued: number }> {
  const db = pool()
  const runId = await startRun(db, tenantId, 'profile', { force, profiler_version: PROFILER_VERSION })
  const { rows } = await db.query<{ id: string; source_id: string }>(
    `select id, source_id from public.source_objects
     where tenant_id = $1 and ($2 or coalesce((metadata -> 'profile' ->> 'profiler_version')::int, 0) < $3)`,
    [tenantId, force, PROFILER_VERSION],
  )
  let queued = 0
  for (const o of rows) {
    const id = await enqueue(db, {
      tenantId,
      jobType: 'profile_object',
      // A forced re-profile is new work (keyed by run); otherwise one profile per object per profiler version.
      idempotencyKey: force ? `${o.id}:profile:run:${runId}` : `${o.id}:profile:v${PROFILER_VERSION}`,
      sourceObjectId: o.id,
      sourceId: o.source_id,
      parentJobId: runId,
    })
    if (id) queued++
  }
  // Archives that were never unpacked (e.g. landed from the command line) are unpacked now.
  const zips = (
    await db.query<{ id: string; source_id: string }>(
      `select so.id, so.source_id from public.source_objects so
       where so.tenant_id = $1 and so.metadata -> 'profile' ->> 'format' = 'zip'
         and not exists (select 1 from public.source_objects c where c.parent_id = so.id)`,
      [tenantId],
    )
  ).rows
  for (const z of zips) {
    const id = await enqueue(db, { tenantId, jobType: 'unpack_archive', idempotencyKey: `${z.id}:unpack`, sourceObjectId: z.id, sourceId: z.source_id, parentJobId: runId, priority: 1 })
    if (id) queued++
  }
  await settleParent(db, runId) // nothing to do → the run completes immediately
  return { id: runId, queued }
}
