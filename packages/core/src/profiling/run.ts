import type { ObjectStore } from '../storage/object-store'
import type { Sql } from '../storage/raw'
import { PROFILER_VERSION, profileObject } from './profile'

/** Profiles one raw object from the store and saves the profile. Used by the queue worker and by profileTenant. */
export async function profileOne(sql: Sql, store: ObjectStore, obj: { id: string; s3_key: string; original_filename: string }) {
  const bytes = await store.get(obj.s3_key)
  if (!bytes) throw new Error('raw object missing from S3')
  const profile = { ...(await profileObject(bytes, obj.original_filename)), profiled_at: new Date().toISOString() }
  await sql.query(
    `update public.source_objects
     set metadata = jsonb_set(metadata, '{profile}', $2::jsonb),
         mime_type = coalesce($3, mime_type),
         status = case when status = 'landed' then 'profiled' else status end
     where id = $1`,
    [obj.id, JSON.stringify(profile), profile.mime_type],
  )
  return profile
}

export interface ProfileProgress {
  total: number
  done: number
  failed: number
  failures: { s3_key: string; error: string }[]
}

/**
 * Profiles a tenant's raw objects, reading bytes from the object store and
 * writing the result to source_objects.metadata.profile. Skips objects already
 * profiled by the current PROFILER_VERSION unless `force`. Used by the web
 * (as a job) and by scripts/profile-raw.ts.
 */
export async function profileTenant(p: {
  sql: Sql
  store: ObjectStore
  tenantId: string
  force?: boolean
  concurrency?: number
  onProgress?: (progress: ProfileProgress) => void | Promise<void>
}): Promise<ProfileProgress> {
  const { rows: todo } = await p.sql.query<{ id: string; s3_key: string; original_filename: string }>(
    `select id, s3_key, original_filename from public.source_objects
     where tenant_id = $1
       and ($2 or coalesce((metadata -> 'profile' ->> 'profiler_version')::int, 0) < $3)
     order by original_path`,
    [p.tenantId, !!p.force, PROFILER_VERSION],
  )

  const progress: ProfileProgress = { total: todo.length, done: 0, failed: 0, failures: [] }
  await p.onProgress?.(progress)

  const queue = [...todo]
  const worker = async () => {
    for (let obj = queue.shift(); obj; obj = queue.shift()) {
      try {
        await profileOne(p.sql, p.store, obj)
        progress.done++
      } catch (error) {
        progress.failed++
        if (progress.failures.length < 50) progress.failures.push({ s3_key: obj.s3_key, error: (error as Error).message })
      }
      await p.onProgress?.(progress)
    }
  }
  await Promise.all(Array.from({ length: p.concurrency ?? 6 }, worker))
  return progress
}
