import { BUCKET, presignRawUpload } from '../aws'
import { enqueueIngest } from '../jobs/handlers'
import { closeRun } from '../jobs/queue'
import { normalizeOriginalPath, rawKey } from '../storage/layout'
import { guessMimeType, recordRawObject } from '../storage/raw'
import { pool, store } from './server'

// Client uploads: the browser hashes each file, asks for a signed write-once URL,
// PUTs the bytes straight to S3 raw/, then calls complete. The server verifies the
// object in S3 before recording provenance and queueing ingestion jobs.

export class UploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s.-]/g, '')
      .trim()
      .replace(/[\s_.]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'files'
  )
}

/** Starts an upload session: an open 'run' that every uploaded file's jobs attach to. */
export async function startUpload(tenantId: string, label?: string): Promise<{ runId: string; batch: string }> {
  const today = new Date().toISOString().slice(0, 10)
  const batch = `${today}-upload-${crypto.randomUUID().slice(0, 6)}`
  const runId = crypto.randomUUID()
  await pool().query(
    `insert into public.ingestion_jobs (id, tenant_id, job_type, idempotency_key, status, payload, started_at, locked_at)
     values ($1, $2, 'run', $3, 'running', $4, now(), now())`,
    [runId, tenantId, `upload:${runId}`, JSON.stringify({ kind: 'upload', open: true, batch, label: label ?? null })],
  )
  return { runId, batch }
}

async function openUploadRun(tenantId: string, runId: string): Promise<{ batch: string }> {
  const run = (
    await pool().query<{ batch: string; open: boolean }>(
      `select payload ->> 'batch' batch, coalesce((payload ->> 'open')::boolean, false) open
       from public.ingestion_jobs where id = $1 and tenant_id = $2 and job_type = 'run' and payload ->> 'kind' = 'upload'`,
      [runId, tenantId],
    )
  ).rows[0]
  if (!run) throw new UploadError('unknown upload session', 404)
  if (!run.open) throw new UploadError('upload session already finished', 409)
  return { batch: run.batch }
}

/** One source per top-level pile the client uploads (folder name, or "Uploads" for loose files). */
async function ensureSource(tenantId: string, name: string): Promise<{ id: string; slug: string }> {
  const db = pool()
  const existing = (await db.query<{ id: string; slug: string }>(`select id, config ->> 'slug' slug from public.sources where tenant_id = $1 and name = $2`, [tenantId, name])).rows[0]
  if (existing?.slug) return existing
  const base = slugify(name)
  const taken = new Set((await db.query<{ slug: string }>(`select config ->> 'slug' slug from public.sources where tenant_id = $1`, [tenantId])).rows.map((r) => r.slug))
  let slug = base
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`
  const row = (
    await db.query<{ id: string }>(
      `insert into public.sources (tenant_id, kind, name, description, connector, config)
       values ($1, 'upload', $2, 'Uploaded through the workbench', 'web-upload', $3)
       on conflict (tenant_id, name) do update set config = public.sources.config || excluded.config
       returning id`,
      [tenantId, name, JSON.stringify({ slug })],
    )
  ).rows[0]
  return { id: row.id, slug }
}

export interface FileDescriptor {
  sourceName: string
  relativePath: string
  size: number
  sha256: string
  contentType?: string
  lastModified?: number
}

function validate(f: FileDescriptor): { originalPath: string; contentType: string } {
  if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new UploadError('sha256 must be 64 lowercase hex characters')
  if (!Number.isFinite(f.size) || f.size < 0) throw new UploadError('bad size')
  if (f.size > 5 * 1024 ** 3) throw new UploadError('files over 5 GB need multipart upload (not supported yet)')
  if (!f.sourceName?.trim()) throw new UploadError('sourceName required')
  const originalPath = normalizeOriginalPath(f.relativePath)
  return { originalPath, contentType: f.contentType || guessMimeType(originalPath) || 'application/octet-stream' }
}

/** Returns a signed write-once URL, or `exists` when these exact bytes are already at that path. */
export async function signUpload(tenantId: string, runId: string, f: FileDescriptor) {
  const { batch } = await openUploadRun(tenantId, runId)
  const { originalPath, contentType } = validate(f)
  const source = await ensureSource(tenantId, f.sourceName.trim())
  const key = rawKey({ tenantId, sourceSlug: source.slug, batch, originalPath })
  const existing = (await pool().query<{ id: string; sha256: string }>(`select id, sha256 from public.source_objects where tenant_id = $1 and s3_key = $2`, [tenantId, key])).rows[0]
  if (existing) {
    if (existing.sha256 !== f.sha256) throw new UploadError(`${originalPath} was already uploaded with different content`, 409)
    return { status: 'exists' as const, id: existing.id, key }
  }
  const signed = await presignRawUpload(key, {
    sha256Hex: f.sha256,
    contentType,
    metadata: { 'tenant-id': tenantId, 'source-id': source.id, 'original-path': encodeURIComponent(originalPath) },
  })
  return { status: 'upload' as const, key, url: signed.url, headers: signed.headers }
}

/** Verifies the uploaded object in S3, records provenance and queues ingestion (unpack + profile). */
export async function completeUpload(tenantId: string, runId: string, f: FileDescriptor) {
  const { batch } = await openUploadRun(tenantId, runId)
  const { originalPath, contentType } = validate(f)
  const source = await ensureSource(tenantId, f.sourceName.trim())
  const key = rawKey({ tenantId, sourceSlug: source.slug, batch, originalPath })
  const head = await (await store()).head(key)
  if (!head) throw new UploadError(`${originalPath} is not in storage yet`, 409)
  if (head.sha256Hex !== f.sha256 || head.size !== f.size) throw new UploadError(`${originalPath}: stored object does not match (sha256/size)`, 409)

  const db = pool()
  const id = await recordRawObject(
    {
      tenantId,
      sourceId: source.id,
      originalPath,
      bucket: BUCKET,
      key,
      sha256: f.sha256,
      sizeBytes: f.size,
      mimeType: contentType,
      sourceModifiedAt: f.lastModified ? new Date(f.lastModified) : null,
      sourcePermissions: { observed_on: 'web upload' },
    },
    db,
  )
  await enqueueIngest(db, { tenantId, sourceObjectId: id, sourceId: source.id, filename: originalPath.split('/').pop()!, parentJobId: runId })
  return { id, key }
}

export async function finishUpload(tenantId: string, runId: string): Promise<void> {
  await openUploadRun(tenantId, runId)
  await closeRun(pool(), runId)
}
