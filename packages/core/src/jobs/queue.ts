// Postgres-backed job queue over public.ingestion_jobs.
//
// - enqueue is idempotent: (tenant_id, job_type, idempotency_key) is unique, so
//   enqueuing the same work twice is a no-op.
// - claim uses FOR UPDATE SKIP LOCKED, so any number of workers can pull jobs
//   without taking the same one.
// - failures retry with exponential backoff until max_attempts, then go 'dead'.
// - a job whose worker stopped heartbeating is put back in the queue.
// - a job that throws NotReadyError (waiting on another job) is put back without
//   using an attempt, for up to MAX_WAIT_HOURS.

import type { Sql } from '../storage/raw'

export interface Job {
  id: string
  tenant_id: string
  job_type: string
  idempotency_key: string
  status: string
  source_object_id: string | null
  parent_job_id: string | null
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
}

export interface EnqueueInput {
  tenantId: string
  jobType: string
  idempotencyKey: string
  payload?: Record<string, unknown>
  sourceObjectId?: string | null
  sourceId?: string | null
  parentJobId?: string | null
  priority?: number
  maxAttempts?: number
}

/**
 * Enqueues a job; returns its id, or null when an identical job already exists.
 * A job that died earlier is revived (attempts reset, joined to the new run), so
 * starting a stage again retries what failed.
 */
export async function enqueue(sql: Sql, j: EnqueueInput): Promise<string | null> {
  const { rows } = await sql.query<{ id: string }>(
    `insert into public.ingestion_jobs (tenant_id, job_type, idempotency_key, payload, source_object_id, source_id, parent_job_id, priority, max_attempts)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (tenant_id, job_type, idempotency_key) do update
       set status = 'queued', attempts = 0, last_error = null, run_after = now(), finished_at = null, locked_by = null,
           parent_job_id = coalesce(excluded.parent_job_id, ingestion_jobs.parent_job_id)
       where ingestion_jobs.status = 'dead'
     returning id`,
    [j.tenantId, j.jobType, j.idempotencyKey, JSON.stringify(j.payload ?? {}), j.sourceObjectId ?? null, j.sourceId ?? null, j.parentJobId ?? null, j.priority ?? 0, j.maxAttempts ?? 4],
  )
  return rows[0]?.id ?? null
}

/** Claims up to `limit` runnable jobs for this worker. */
export async function claim(sql: Sql, worker: string, limit: number, jobTypes: string[]): Promise<Job[]> {
  const { rows } = await sql.query<Job>(
    `update public.ingestion_jobs j
     set status = 'running', locked_by = $1, locked_at = now(), attempts = j.attempts + 1, started_at = coalesce(j.started_at, now())
     where j.id in (
       select id from public.ingestion_jobs
       where status = 'queued' and run_after <= now() and job_type = any($3)
       order by priority desc, run_after, created_at
       for update skip locked
       limit $2)
     returning j.id, j.tenant_id, j.job_type, j.idempotency_key, j.status, j.source_object_id, j.parent_job_id, j.payload, j.attempts, j.max_attempts`,
    [worker, limit, jobTypes],
  )
  return rows
}

export async function heartbeat(sql: Sql, jobId: string): Promise<void> {
  await sql.query(`update public.ingestion_jobs set locked_at = now() where id = $1 and status = 'running'`, [jobId])
}

export async function complete(sql: Sql, job: Job, result: unknown): Promise<void> {
  await sql.query(
    `update public.ingestion_jobs set status = 'succeeded', result = $2, finished_at = now(), last_error = null, locked_by = null where id = $1`,
    [job.id, JSON.stringify(result ?? null)],
  )
  if (job.parent_job_id) await settleParent(sql, job.parent_job_id)
}

/** Records a failure: retry later with backoff, or give up ('dead') after max_attempts. */
/** Thrown by a handler whose input is not ready yet (e.g. waiting for another job). Does not use an attempt. */
export class NotReadyError extends Error {
  constructor(
    message: string,
    readonly retryInSeconds = 30,
  ) {
    super(message)
    this.name = 'NotReadyError'
  }
}

const MAX_WAIT_HOURS = 6

export async function fail(sql: Sql, job: Job, error: unknown): Promise<'retry' | 'dead'> {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof NotReadyError) {
    const waited = await sql.query(
      `update public.ingestion_jobs
       set status = 'queued', attempts = greatest(attempts - 1, 0), last_error = $2, locked_by = null, run_after = now() + make_interval(secs => $3)
       where id = $1 and created_at > now() - make_interval(hours => $4)
       returning id`,
      [job.id, `waiting: ${message}`.slice(0, 2000), error.retryInSeconds, MAX_WAIT_HOURS],
    )
    if (waited.rows.length > 0) return 'retry'
    // Waited too long: fall through and count it as a real failure.
  }
  const dead = job.attempts >= job.max_attempts
  await sql.query(
    `update public.ingestion_jobs
     set status = $2, last_error = $3, locked_by = null,
         run_after = now() + make_interval(secs => $4), finished_at = case when $2 = 'dead' then now() end
     where id = $1`,
    [job.id, dead ? 'dead' : 'queued', message.slice(0, 2000), Math.min(600, 5 * 2 ** job.attempts)],
  )
  if (dead && job.parent_job_id) await settleParent(sql, job.parent_job_id)
  return dead ? 'dead' : 'retry'
}

/** Puts running jobs whose worker went silent back in the queue. */
export async function requeueStale(sql: Sql, olderThanSeconds = 120): Promise<number> {
  const r = await sql.query(
    `update public.ingestion_jobs set status = 'queued', locked_by = null, last_error = 'worker stopped heartbeating; requeued'
     where status = 'running' and job_type <> 'run' and locked_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  )
  return (r as unknown as { rowCount?: number }).rowCount ?? 0
}

/**
 * A 'run' groups child jobs (e.g. one upload or one "profile all"); it finishes when its children do.
 * An open run (payload.open = true, e.g. an upload still receiving files) waits for closeRun.
 */
export async function settleParent(sql: Sql, parentId: string): Promise<void> {
  await sql.query(
    `update public.ingestion_jobs p
     set status = case when c.dead > 0 then 'failed' else 'succeeded' end,
         finished_at = now(),
         result = jsonb_build_object('succeeded', c.ok, 'dead', c.dead),
         last_error = case when c.dead > 0 then c.dead || ' job(s) failed permanently' end
     from (
       select count(*) filter (where status = 'succeeded') ok,
              count(*) filter (where status = 'dead') dead,
              count(*) filter (where status in ('queued', 'running')) pending
       from public.ingestion_jobs where parent_job_id = $1) c
     where p.id = $1 and p.status = 'running' and c.pending = 0
       and not coalesce((p.payload ->> 'open')::boolean, false)`,
    [parentId],
  )
}

/** Starts a run (a parent job) that child jobs attach to. */
export async function startRun(sql: Sql, tenantId: string, kind: string, payload: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID()
  await sql.query(
    `insert into public.ingestion_jobs (id, tenant_id, job_type, idempotency_key, status, payload, started_at, locked_at)
     values ($1, $2, 'run', $3, 'running', $4, now(), now())`,
    [id, tenantId, `${kind}:${id}`, JSON.stringify({ kind, ...payload })],
  )
  return id
}

/** Closes an open run (no more children will be added) and settles it if its children are done. */
export async function closeRun(sql: Sql, runId: string): Promise<void> {
  await sql.query(`update public.ingestion_jobs set payload = payload || '{"open": false}' where id = $1 and job_type = 'run'`, [runId])
  await settleParent(sql, runId)
}
