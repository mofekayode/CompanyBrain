// Ingestion job handlers. Each handler is idempotent: running the same job
// again (retry, duplicate enqueue) produces the same state.

import JSZip from 'jszip'
import { detectFormat } from '../profiling/detect'
import { PROFILER_VERSION } from '../profiling/profile'
import { profileOne } from '../profiling/run'
import type { ObjectStore } from '../storage/object-store'
import { guessMimeType, landRawObject, type Sql } from '../storage/raw'
import { ACCESS_HANDLERS } from './access'
import { ONTOLOGY_HANDLERS } from './ontology'
import { EXTRACTION_HANDLERS } from './extraction'
import { SEARCH_HANDLERS } from './search'
import { enqueue, type Job } from './queue'

export interface JobContext {
  sql: Sql
  store: ObjectStore
}

const MAX_UNPACK_DEPTH = 3
const MAX_ARCHIVE_MEMBERS = 5000

type Handler = (job: Job, ctx: JobContext) => Promise<unknown>

/**
 * Incremental ingestion: once a tenant's files have been through extraction (the FDE has
 * started at least one extraction run), a newly uploaded file is extracted right after
 * profiling, then the search sync picks up its passages. Before that, extraction waits for
 * the FDE, so a first big upload can be reviewed (and sampled) before anything is spent.
 */
async function extractIfLive(sql: Parameters<Handler>[1]['sql'], tenantId: string, objectId: string, name: string) {
  const live = await sql.query(`select 1 from public.ingestion_jobs where tenant_id = $1 and job_type = 'run' and payload ->> 'kind' = 'extract' limit 1`, [tenantId])
  if (!live.rows.length) return 'waiting for the first extraction run'
  const { startExtraction } = await import('./extraction')
  const r = await startExtraction(sql, tenantId, { objectIds: [objectId], label: `New file: ${name}` })
  return r.queued ? 'queued' : 'nothing to extract'
}

export const HANDLERS: Record<string, Handler> = {
  /** Profile one raw object. Exact duplicates reuse the profile of an identical file. */
  profile_object: async (job, { sql, store }) => {
    const obj = (
      await sql.query<{ id: string; s3_key: string; original_filename: string; sha256: string; tenant_id: string }>(
        `select id, s3_key, original_filename, sha256, tenant_id from public.source_objects where id = $1`,
        [job.source_object_id],
      )
    ).rows[0]
    if (!obj) throw new Error(`source object ${job.source_object_id} not found`)

    // Checksum dedup: identical bytes already profiled by this profiler version → reuse that profile
    // (only when the extension matches, since extension checks depend on the filename).
    const twin = (
      await sql.query<{ profile: Record<string, unknown>; original_filename: string }>(
        `select metadata -> 'profile' as profile, original_filename from public.source_objects
         where tenant_id = $1 and sha256 = $2 and id <> $3 and metadata ? 'profile'
           and (metadata -> 'profile' ->> 'profiler_version')::int = $4
         limit 1`,
        [obj.tenant_id, obj.sha256, obj.id, PROFILER_VERSION],
      )
    ).rows[0]
    if (twin && twin.original_filename.split('.').pop()?.toLowerCase() === obj.original_filename.split('.').pop()?.toLowerCase()) {
      await sql.query(
        `update public.source_objects
         set metadata = jsonb_set(metadata, '{profile}', $2::jsonb), status = case when status = 'landed' then 'profiled' else status end
         where id = $1`,
        [obj.id, JSON.stringify({ ...twin.profile, profiled_at: new Date().toISOString(), deduplicated_from_sha256: obj.sha256 })],
      )
      return { deduplicated: true, extraction: await extractIfLive(sql, obj.tenant_id, obj.id, obj.original_filename) }
    }
    const profile = await profileOne(sql, store, obj)
    return { format: profile.format, ok: profile.integrity.ok, extraction: await extractIfLive(sql, obj.tenant_id, obj.id, obj.original_filename) }
  },

  /**
   * Unpack a zip into child raw objects (parent_id = the zip). The zip itself stays
   * untouched in raw/; members are landed as raw objects at "<zip path>/<member path>".
   */
  unpack_archive: async (job, { sql, store }) => {
    const obj = (
      await sql.query<{ id: string; tenant_id: string; source_id: string; s3_key: string; original_path: string; source_permissions: unknown; acl_id: string | null; depth: number }>(
        `with recursive chain as (
           select id, parent_id, 0 as depth from public.source_objects where id = $1
           union all select o.id, o.parent_id, c.depth + 1 from public.source_objects o join chain c on o.id = c.parent_id)
         select so.id, so.tenant_id, so.source_id, so.s3_key, so.original_path, so.source_permissions, so.acl_id,
                (select max(depth) from chain)::int as depth
         from public.source_objects so where so.id = $1`,
        [job.source_object_id],
      )
    ).rows[0]
    if (!obj) throw new Error(`source object ${job.source_object_id} not found`)
    if (obj.depth >= MAX_UNPACK_DEPTH) return { skipped: 'max nesting depth reached' }

    const source = (await sql.query<{ config: { slug?: string; batch?: string } }>(`select config from public.sources where id = $1`, [obj.source_id])).rows[0]
    const sourceSlug = source?.config?.slug
    // Raw key layout: {tenant}/raw/{source}/{batch}/{path}; reuse the parent's source and batch.
    const parts = obj.s3_key.split('/')
    const batch = parts[3]
    if (!sourceSlug || !batch) throw new Error('cannot derive source/batch for archive members')

    const bytes = await store.get(obj.s3_key)
    if (!bytes) throw new Error('raw object missing from S3')
    const zip = await JSZip.loadAsync(bytes)
    const members = Object.values(zip.files).filter((f) => !f.dir && !f.name.startsWith('__MACOSX/'))
    if (members.length > MAX_ARCHIVE_MEMBERS) throw new Error(`archive has ${members.length} members (limit ${MAX_ARCHIVE_MEMBERS})`)

    let landed = 0
    for (const m of members) {
      const content = await m.async('uint8array')
      const child = await landRawObject(
        {
          tenantId: obj.tenant_id,
          source: { id: obj.source_id, slug: sourceSlug },
          batch,
          originalPath: `${obj.original_path}/${m.name}`,
          bytes: content,
          parentId: obj.id,
          externalId: m.name,
          sourceModifiedAt: m.date && !Number.isNaN(m.date.getTime()) ? m.date : null,
          sourcePermissions: { inherited_from: obj.id, ...(obj.source_permissions as object) },
          mimeType: guessMimeType(m.name),
        },
        { store, sql },
      )
      // Permissions propagate from the archive to its members.
      if (obj.acl_id) await sql.query(`update public.source_objects set acl_id = coalesce(acl_id, $2) where id = $1`, [child.id, obj.acl_id])
      await enqueueIngest(sql, { tenantId: obj.tenant_id, sourceObjectId: child.id, sourceId: obj.source_id, bytes: content, filename: m.name, parentJobId: job.parent_job_id })
      landed++
    }
    return { members: landed }
  },
}

// Extraction stage handlers (explicitly started by an FDE; see extraction.ts).
Object.assign(HANDLERS, EXTRACTION_HANDLERS, ACCESS_HANDLERS, ONTOLOGY_HANDLERS, SEARCH_HANDLERS)

export const JOB_TYPES = Object.keys(HANDLERS)

/** The ingestion entry point for a newly landed raw object: unpack containers, profile everything. */
export async function enqueueIngest(
  sql: Sql,
  p: { tenantId: string; sourceObjectId: string; sourceId?: string | null; bytes?: Uint8Array; filename: string; parentJobId?: string | null },
): Promise<void> {
  const isZip = p.bytes ? detectFormat(p.bytes, p.filename) === 'zip' : /\.zip$/i.test(p.filename)
  await enqueue(sql, {
    tenantId: p.tenantId,
    jobType: 'profile_object',
    // Versioned key: a new profiler version re-profiles; the same version never runs twice.
    idempotencyKey: `${p.sourceObjectId}:profile:v${PROFILER_VERSION}`,
    sourceObjectId: p.sourceObjectId,
    sourceId: p.sourceId,
    parentJobId: p.parentJobId,
  })
  if (isZip) {
    await enqueue(sql, {
      tenantId: p.tenantId,
      jobType: 'unpack_archive',
      idempotencyKey: `${p.sourceObjectId}:unpack`,
      sourceObjectId: p.sourceObjectId,
      sourceId: p.sourceId,
      parentJobId: p.parentJobId,
      priority: 1,
    })
  }
}
