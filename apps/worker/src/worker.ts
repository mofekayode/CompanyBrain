// Ingestion worker: pulls jobs from public.ingestion_jobs and runs them.
// Runs as its own service (apps/worker). Locally it starts with `npm run dev`.
// Any number of workers can run; claims use FOR UPDATE SKIP LOCKED.

import { hostname } from 'node:os'
import { companyBrainStore } from '@companybrain/core/aws'
import { createServicePool } from '@companybrain/core/db'
import { EXTRACTION_CONCURRENCY } from '@companybrain/core/jobs/extraction'
import { HANDLERS, JOB_TYPES } from '@companybrain/core/jobs/handlers'
import { claim, complete, fail, heartbeat, NotReadyError, requeueStale, type Job } from '@companybrain/core/jobs/queue'
import { scheduleSearchSync } from '@companybrain/core/jobs/search'

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 6)
const IDLE_MS = 1000
const worker = `${hostname()}:${process.pid}`

async function main(): Promise<void> {
  const store = await companyBrainStore() // refuses any AWS account but Company Brain's
  const sql = createServicePool(CONCURRENCY + 2)
  let running = 0
  const runningByType = new Map<string, number>()
  let stopping = false
  process.on('SIGINT', () => (stopping = true))
  process.on('SIGTERM', () => (stopping = true))
  console.log(`worker ${worker} started (concurrency ${CONCURRENCY}, job types: ${JOB_TYPES.join(', ')})`)

  let lastStaleCheck = 0
  let lastSearchSync = 0
  while (!stopping) {
    // Changes to evidence, entities, facts or access → one search sync job per client.
    if (Date.now() - lastSearchSync > 10_000) {
      lastSearchSync = Date.now()
      await scheduleSearchSync(sql).catch((e) => console.error('search sync schedule failed:', e.message))
    }
    if (Date.now() - lastStaleCheck > 30_000) {
      lastStaleCheck = Date.now()
      const n = await requeueStale(sql).catch(() => 0)
      if (n) console.log(`requeued ${n} stale job(s)`)
    }
    const free = CONCURRENCY - running
    // Respect per-type limits for heavy/external-API jobs (Docling, video, speech, vision).
    const allowed = JOB_TYPES.filter((t) => (runningByType.get(t) ?? 0) < (EXTRACTION_CONCURRENCY[t] ?? Infinity))
    const jobs: Job[] = []
    if (free > 0 && allowed.length > 0) {
      const claimed = await claim(sql, worker, free, allowed).catch((e) => (console.error('claim failed:', e.message), [] as Job[]))
      const taken = new Map<string, number>()
      for (const j of claimed) {
        const limit = EXTRACTION_CONCURRENCY[j.job_type] ?? Infinity
        const n = (runningByType.get(j.job_type) ?? 0) + (taken.get(j.job_type) ?? 0)
        if (n < limit) {
          taken.set(j.job_type, (taken.get(j.job_type) ?? 0) + 1)
          jobs.push(j)
        } else {
          // Over the type limit: hand it straight back to the queue.
          await sql.query(`update public.ingestion_jobs set status = 'queued', attempts = attempts - 1, locked_by = null where id = $1`, [j.id])
        }
      }
    }
    if (jobs.length === 0) {
      await new Promise((r) => setTimeout(r, IDLE_MS))
      continue
    }
    for (const job of jobs) {
      running++
      runningByType.set(job.job_type, (runningByType.get(job.job_type) ?? 0) + 1)
      void run(job).finally(() => {
        running--
        runningByType.set(job.job_type, (runningByType.get(job.job_type) ?? 1) - 1)
      })
    }
  }
  while (running > 0) await new Promise((r) => setTimeout(r, 200))
  await sql.end()
  console.log('worker stopped')

  async function run(job: Job): Promise<void> {
    const beat = setInterval(() => heartbeat(sql, job.id).catch(() => {}), 20_000)
    const started = Date.now()
    try {
      const result = await HANDLERS[job.job_type](job, { sql, store })
      await complete(sql, job, result)
      console.log(`✓ ${job.job_type} ${job.source_object_id ?? ''} ${Date.now() - started}ms`)
    } catch (error) {
      const outcome = await fail(sql, job, error)
      if (error instanceof NotReadyError && outcome === 'retry') return console.log(`… ${job.job_type} ${job.source_object_id ?? ''} waiting: ${error.message}`)
      console.error(`✗ ${job.job_type} ${job.source_object_id ?? ''} (${outcome}): ${(error as Error).message}`)
    } finally {
      clearInterval(beat)
    }
  }
}

await main()
