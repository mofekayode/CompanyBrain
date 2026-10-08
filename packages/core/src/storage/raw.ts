import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { normalizeOriginalPath, rawKey } from './layout'
import type { ObjectStore } from './object-store'

/** Anything that can run a parameterized query: pg Client/Pool, PGlite, a transaction. Must bypass RLS (service role). */
export interface Sql {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export interface RawFileInput {
  tenantId: string
  source: { id: string; slug: string }
  /** Delivery batch the file arrived in, e.g. "2026-10-02-ridgeline-vdr". */
  batch: string
  /** Path exactly as it was in the source system. */
  originalPath: string
  bytes: Uint8Array
  sourceCreatedAt?: Date | null
  sourceModifiedAt?: Date | null
  sourceOwner?: string | null
  /** Permissions exactly as found in the source system. */
  sourcePermissions?: Record<string, unknown>
  externalId?: string | null
  parentId?: string | null
  mimeType?: string | null
}

export interface LandedObject {
  id: string
  s3Key: string
  sha256: string
  sizeBytes: number
  /** false when this exact object had already been landed (idempotent re-run). */
  created: boolean
}

export class RawConflictError extends Error {}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.rtf': 'application/rtf',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.mbox': 'application/mbox',
  '.eml': 'message/rfc822',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
}

export function guessMimeType(path: string): string | null {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Lands one raw object: write-once to S3, then record its provenance in
 * source_objects. Safe to re-run: landing the same bytes at the same key
 * returns the existing row. Different bytes at an existing key is a conflict,
 * because raw evidence never changes.
 */
export async function landRawObject(input: RawFileInput, deps: { store: ObjectStore; sql: Sql }): Promise<LandedObject> {
  const originalPath = normalizeOriginalPath(input.originalPath)
  const key = rawKey({ tenantId: input.tenantId, sourceSlug: input.source.slug, batch: input.batch, originalPath })
  const sha256 = sha256Hex(input.bytes)
  const mimeType = input.mimeType ?? guessMimeType(originalPath)

  const outcome = await deps.store.putIfAbsent(key, input.bytes, {
    sha256Hex: sha256,
    contentType: mimeType ?? undefined,
    // S3 user metadata must be ASCII, so the original path is URI-encoded.
    metadata: {
      'tenant-id': input.tenantId,
      'source-id': input.source.id,
      'original-path': encodeURIComponent(originalPath),
      ...(input.sourceModifiedAt ? { 'source-modified-at': input.sourceModifiedAt.toISOString() } : {}),
    },
  })

  if (outcome === 'exists') {
    const existing = await deps.store.head(key)
    if (existing?.sha256Hex !== sha256) {
      throw new RawConflictError(`raw object ${key} already exists with different content; raw evidence is immutable`)
    }
  }

  const id = await recordRawObject(
    {
      tenantId: input.tenantId,
      sourceId: input.source.id,
      parentId: input.parentId,
      externalId: input.externalId,
      originalPath,
      bucket: deps.store.bucket,
      key,
      sha256,
      sizeBytes: input.bytes.byteLength,
      mimeType,
      sourceCreatedAt: input.sourceCreatedAt,
      sourceModifiedAt: input.sourceModifiedAt,
      sourceOwner: input.sourceOwner,
      sourcePermissions: input.sourcePermissions,
    },
    deps.sql,
  )

  return { id, s3Key: key, sha256, sizeBytes: input.bytes.byteLength, created: outcome === 'created' }
}

export interface RawObjectRecord {
  tenantId: string
  sourceId: string
  parentId?: string | null
  externalId?: string | null
  originalPath: string
  bucket: string
  key: string
  sha256: string
  sizeBytes: number
  mimeType: string | null
  sourceCreatedAt?: Date | null
  sourceModifiedAt?: Date | null
  sourceOwner?: string | null
  sourcePermissions?: Record<string, unknown>
}

/**
 * Records provenance for a raw object that is already in the store (written by
 * landRawObject or uploaded directly by a browser). Idempotent; never rewrites
 * an existing row, and refuses a different sha256 for the same key.
 */
export async function recordRawObject(r: RawObjectRecord, sql: Sql): Promise<string> {
  const { rows } = await sql.query<{ id: string }>(
    `insert into public.source_objects (
       tenant_id, source_id, parent_id, external_id, original_path, original_filename,
       s3_bucket, s3_key, sha256, size_bytes, mime_type,
       source_created_at, source_modified_at, source_owner, source_permissions)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     on conflict (tenant_id, s3_key) do nothing
     returning id`,
    [
      r.tenantId,
      r.sourceId,
      r.parentId ?? null,
      r.externalId ?? null,
      r.originalPath,
      basename(r.originalPath),
      r.bucket,
      r.key,
      r.sha256,
      r.sizeBytes,
      r.mimeType,
      r.sourceCreatedAt ?? null,
      r.sourceModifiedAt ?? null,
      r.sourceOwner ?? null,
      JSON.stringify(r.sourcePermissions ?? {}),
    ],
  )
  if (rows[0]) return rows[0].id
  // Provenance already recorded earlier; it is never rewritten.
  const existing = await sql.query<{ id: string; sha256: string }>(
    `select id, sha256 from public.source_objects where tenant_id = $1 and s3_key = $2`,
    [r.tenantId, r.key],
  )
  if (existing.rows[0]?.sha256 !== r.sha256) throw new RawConflictError(`source_objects row for ${r.key} records a different sha256`)
  return existing.rows[0].id
}

/** Reads a local file and lands it, capturing the timestamps the filesystem still has. */
export async function landLocalFile(
  localPath: string,
  input: Omit<RawFileInput, 'bytes' | 'sourceCreatedAt' | 'sourceModifiedAt'>,
  deps: { store: ObjectStore; sql: Sql },
): Promise<LandedObject> {
  const [bytes, info] = await Promise.all([readFile(localPath), stat(localPath)])
  return landRawObject(
    { ...input, bytes, sourceCreatedAt: info.birthtime, sourceModifiedAt: info.mtime },
    deps,
  )
}
