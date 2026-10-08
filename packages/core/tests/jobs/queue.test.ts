import type { PGlite } from '@electric-sql/pglite'
import JSZip from 'jszip'
import { beforeAll, describe, expect, test } from 'vitest'
import { HANDLERS, enqueueIngest } from '../../src/jobs/handlers'
import { claim, complete, enqueue, fail, NotReadyError, requeueStale, startRun, settleParent } from '../../src/jobs/queue'
import { MemoryObjectStore } from '../../src/storage/object-store'
import { landRawObject } from '../../src/storage/raw'
import { createDb, one } from '../db/harness'

let db: PGlite
let tenantId: string
let source: { id: string; slug: string }
const store = new MemoryObjectStore('test-bucket')

beforeAll(async () => {
  db = await createDb()
  tenantId = (await one<{ id: string }>(db, `select public.create_tenant('acme', 'Acme', null) as id`)).id
  const id = (await one<{ id: string }>(db, `insert into sources (tenant_id, kind, name, config) values ($1, 'upload', 'Uploads', '{"slug":"uploads"}') returning id`, [tenantId])).id
  source = { id, slug: 'uploads' }
})

const jobs = (status?: string) =>
  db.query<{ job_type: string; status: string; attempts: number }>(`select job_type, status, attempts from ingestion_jobs where tenant_id = $1 ${status ? `and status = '${status}'` : ''} order by created_at`, [tenantId])

describe('queue', () => {
  test('enqueue is idempotent', async () => {
    expect(await enqueue(db, { tenantId, jobType: 'profile_object', idempotencyKey: 'k1' })).toBeTruthy()
    expect(await enqueue(db, { tenantId, jobType: 'profile_object', idempotencyKey: 'k1' })).toBeNull()
  })

  test('claim takes each job once and failures retry, then die', async () => {
    const a = await claim(db, 'w1', 10, ['profile_object'])
    const b = await claim(db, 'w2', 10, ['profile_object'])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
    const job = { ...a[0], max_attempts: 2 }
    expect(await fail(db, job, new Error('boom'))).toBe('retry')
    await db.query(`update ingestion_jobs set run_after = now() where id = $1`, [job.id])
    const again = await claim(db, 'w1', 10, ['profile_object'])
    expect(again[0].attempts).toBe(2)
    expect(await fail(db, { ...again[0], max_attempts: 2 }, new Error('boom'))).toBe('dead')
    // Enqueuing the same work again revives a dead job (starting a stage again retries failures).
    expect(await enqueue(db, { tenantId, jobType: 'profile_object', idempotencyKey: 'k1' })).toBe(job.id)
    expect((await one<{ status: string; attempts: number }>(db, `select status, attempts from ingestion_jobs where id = $1`, [job.id]))).toEqual({ status: 'queued', attempts: 0 })
    await db.query(`delete from ingestion_jobs where tenant_id = $1`, [tenantId])
  })

  test('a job waiting on another job is put back without using an attempt', async () => {
    await enqueue(db, { tenantId, jobType: 'profile_object', idempotencyKey: 'wait' })
    const [j] = await claim(db, 'w1', 1, ['profile_object'])
    expect(await fail(db, { ...j, max_attempts: 1 }, new NotReadyError('input not ready', 5))).toBe('retry')
    expect(await one<{ status: string; attempts: number }>(db, `select status, attempts from ingestion_jobs where id = $1`, [j.id])).toEqual({ status: 'queued', attempts: 0 })
    await db.query(`delete from ingestion_jobs where tenant_id = $1`, [tenantId])
  })

  test('stale running jobs are requeued', async () => {
    await enqueue(db, { tenantId, jobType: 'profile_object', idempotencyKey: 'k2' })
    const [j] = await claim(db, 'w1', 1, ['profile_object'])
    await db.query(`update ingestion_jobs set locked_at = now() - interval '10 minutes' where id = $1`, [j.id])
    expect(await requeueStale(db, 120)).toBe(1)
    expect((await one<{ status: string }>(db, `select status from ingestion_jobs where id = $1`, [j.id])).status).toBe('queued')
    await db.query(`delete from ingestion_jobs where tenant_id = $1`, [tenantId])
  })

  test('a run settles when its last child finishes', async () => {
    const run = await startRun(db, tenantId, 'test', {})
    await enqueue(db, { tenantId, jobType: 'profile_object', idempotencyKey: 'c1', parentJobId: run })
    await settleParent(db, run)
    expect((await one<{ status: string }>(db, `select status from ingestion_jobs where id = $1`, [run])).status).toBe('running')
    const [c] = await claim(db, 'w1', 1, ['profile_object'])
    await complete(db, c, { ok: true })
    expect((await one<{ status: string }>(db, `select status from ingestion_jobs where id = $1`, [run])).status).toBe('succeeded')
    await db.query(`delete from ingestion_jobs where tenant_id = $1`, [tenantId])
  })
})

describe('handlers', () => {
  test('a zip is profiled, unpacked into child raw objects, and its members are profiled; duplicates reuse profiles', async () => {
    const zip = new JSZip()
    zip.file('policies/discount.txt', 'Discounts over 10% need approval since 2021-03-04.\n')
    zip.file('copy of discount.txt', 'Discounts over 10% need approval since 2021-03-04.\n')
    zip.file('__MACOSX/._junk', 'x')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    const landed = await landRawObject({ tenantId, source, batch: '2026-10-06-upload', originalPath: 'Exports/archive.zip', bytes }, { store, sql: db })
    await enqueueIngest(db, { tenantId, sourceObjectId: landed.id, bytes, filename: 'archive.zip' })

    // Drain the queue like the worker does.
    for (let i = 0; i < 10; i++) {
      const batch = await claim(db, 'w', 10, Object.keys(HANDLERS))
      if (batch.length === 0) break
      for (const j of batch) await complete(db, j, await HANDLERS[j.job_type](j, { sql: db, store }))
    }

    const objects = await db.query<{ original_path: string; parent_id: string | null; status: string; format: string; dedup: string | null }>(
      `select original_path, parent_id, status, metadata -> 'profile' ->> 'format' as format, metadata -> 'profile' ->> 'deduplicated_from_sha256' as dedup
       from source_objects where tenant_id = $1 order by original_path`,
      [tenantId],
    )
    expect(objects.rows.map((r) => [r.original_path, r.status, r.format])).toEqual([
      ['Exports/archive.zip', 'profiled', 'zip'],
      ['Exports/archive.zip/copy of discount.txt', 'profiled', 'text'],
      ['Exports/archive.zip/policies/discount.txt', 'profiled', 'text'],
    ])
    expect(objects.rows.filter((r) => r.parent_id === landed.id)).toHaveLength(2)
    expect(objects.rows.filter((r) => r.dedup)).toHaveLength(1)
    expect((await jobs()).rows.every((j) => j.status === 'succeeded')).toBe(true)
  })

  test('re-running ingestion for the same archive changes nothing', async () => {
    const before = (await one<{ n: number }>(db, `select count(*)::int n from source_objects where tenant_id = $1`, [tenantId])).n
    const zipRow = await one<{ id: string }>(db, `select id from source_objects where original_path = 'Exports/archive.zip'`)
    await enqueueIngest(db, { tenantId, sourceObjectId: zipRow.id, filename: 'archive.zip' })
    expect((await claim(db, 'w', 10, Object.keys(HANDLERS))).length).toBe(0) // same idempotency keys → nothing new
    expect((await one<{ n: number }>(db, `select count(*)::int n from source_objects where tenant_id = $1`, [tenantId])).n).toBe(before)
  })
})
