// Persists an extraction: document (one per raw object) → new document_version
// → processed/derived artifacts in S3 → evidence rows. Re-running with the same
// extractor version is a no-op; a new extractor version creates a new version.

import { createHash } from 'node:crypto'
import { derivedKey, processedKey } from '../storage/layout'
import type { ObjectStore } from '../storage/object-store'
import type { Sql } from '../storage/raw'
import type { ExtractionResult } from './types'

export interface RawObjectRow {
  id: string
  tenant_id: string
  source_id: string
  original_path: string
  original_filename: string
  s3_key: string
  sha256: string
  acl_id: string | null
}

export async function loadRawObject(sql: Sql, id: string): Promise<RawObjectRow> {
  const row = (
    await sql.query<RawObjectRow>(
      `select id, tenant_id, source_id, original_path, original_filename, s3_key, sha256, acl_id from public.source_objects where id = $1`,
      [id],
    )
  ).rows[0]
  if (!row) throw new Error(`source object ${id} not found`)
  return row
}

/** The extracted version for this object, if this extractor version already ran. */
export async function existingVersion(sql: Sql, sourceObjectId: string, extractor: string, version: string): Promise<string | null> {
  const r = await sql.query<{ id: string }>(
    `select id from public.document_versions
     where source_object_id = $1 and extractor = $2 and extractor_version = $3 and extraction_status in ('succeeded', 'skipped')
     limit 1`,
    [sourceObjectId, extractor, version],
  )
  return r.rows[0]?.id ?? null
}

/** Another object with identical bytes already extracted by this extractor version (extract once per content). */
export async function twinVersion(sql: Sql, obj: RawObjectRow, extractor: string, version: string): Promise<{ id: string; title: string | null; kind: string; page_count: number | null } | null> {
  const r = await sql.query<{ id: string; title: string | null; kind: string; page_count: number | null }>(
    `select dv.id, d.title, d.kind, dv.page_count
     from public.document_versions dv
     join public.source_objects so on so.id = dv.source_object_id
     join public.documents d on d.id = dv.document_id
     where so.tenant_id = $1 and so.sha256 = $2 and so.id <> $3
       and so.deleted_at is null and d.deleted_at is null -- a deleted copy's passages are gone from search
       and exists (select 1 from public.evidence e where e.document_version_id = dv.id)
       and dv.extractor = $4 and dv.extractor_version = $5 and dv.extraction_status = 'succeeded'
       and coalesce((dv.metadata ->> 'same_content_as') is null, true)
     limit 1`,
    [obj.tenant_id, obj.sha256, obj.id, extractor, version],
  )
  return r.rows[0] ?? null
}

async function documentFor(sql: Sql, obj: RawObjectRow, kind: string, title: string | null): Promise<string> {
  const existing = (
    await sql.query<{ id: string }>(
      `select d.id from public.documents d join public.document_versions dv on dv.document_id = d.id where dv.source_object_id = $1 limit 1`,
      [obj.id],
    )
  ).rows[0]
  if (existing) return existing.id
  return (
    await sql.query<{ id: string }>(
      `insert into public.documents (tenant_id, source_id, kind, title, canonical_path, acl_id)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [obj.tenant_id, obj.source_id, kind, title ?? obj.original_filename, obj.original_path, obj.acl_id],
    )
  ).rows[0].id
}

async function newVersion(sql: Sql, obj: RawObjectRow, documentId: string, fields: { extractor: string; version: string; status: string; pageCount?: number | null; language?: string | null; metadata?: Record<string, unknown> }): Promise<string> {
  return (
    await sql.query<{ id: string }>(
      `insert into public.document_versions (tenant_id, document_id, source_object_id, version_number, extractor, extractor_version, extraction_status, page_count, language, acl_id, metadata)
       values ($1, $2, $3, (select coalesce(max(version_number), 0) + 1 from public.document_versions where document_id = $2), $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [obj.tenant_id, documentId, obj.id, fields.extractor, fields.version, fields.status, fields.pageCount ?? null, fields.language ?? null, obj.acl_id, JSON.stringify(fields.metadata ?? {})],
    )
  ).rows[0].id
}

/** Writes a completed extraction. Returns the document_version id and evidence count. */
export async function writeExtraction(sql: Sql, store: ObjectStore, obj: RawObjectRow, r: ExtractionResult): Promise<{ versionId: string; evidence: number }> {
  const documentId = await documentFor(sql, obj, r.documentKind, r.title ?? null)
  const versionId = await newVersion(sql, obj, documentId, {
    extractor: r.extractor,
    version: r.extractorVersion,
    status: 'processing',
    pageCount: r.pageCount,
    language: r.language,
    metadata: r.metadata,
  })

  // Artifacts: processed/{kind}/{version}/name and derived/{kind}/{version}/name
  const kindSlug = r.documentKind.replace(/[^a-z0-9._-]/g, '-')
  for (const a of r.artifacts) {
    const key = (a.zone === 'processed' ? processedKey : derivedKey)({ tenantId: obj.tenant_id, kind: kindSlug, documentVersionId: versionId, artifact: a.name })
    await store.put(key, a.body, a.contentType)
  }
  const prefix = processedKey({ tenantId: obj.tenant_id, kind: kindSlug, documentVersionId: versionId, artifact: 'x' }).replace(/x$/, '')

  // Evidence, in batches (multi-row insert).
  const BATCH = 200
  for (let i = 0; i < r.units.length; i += BATCH) {
    const slice = r.units.slice(i, i + BATCH)
    const values: unknown[] = []
    const rows = slice.map((u, j) => {
      const o = i + j
      values.push(
        obj.tenant_id, versionId, o, u.kind, u.content,
        createHash('sha256').update(u.content).digest('hex'),
        u.pageNumber ?? null, u.sectionPath ?? null, u.startMs ?? null, u.endMs ?? null,
        JSON.stringify(u.locator ?? {}), u.speaker ?? null, u.observedAt ?? null, obj.acl_id, JSON.stringify(u.metadata ?? {}),
      )
      const b = j * 15
      return `(${Array.from({ length: 15 }, (_, k) => `$${b + k + 1}`).join(', ')})`
    })
    await sql.query(
      `insert into public.evidence (tenant_id, document_version_id, ordinal, kind, content, content_sha256, page_number, section_path,
                                    start_ms, end_ms, locator, speaker, observed_at, acl_id, metadata)
       values ${rows.join(', ')}`,
      values,
    )
  }

  await sql.query(
    `update public.document_versions set extraction_status = 'succeeded', processed_prefix = $2 where id = $1`,
    [versionId, prefix],
  )
  await sql.query(`update public.documents set current_version_id = $2, title = coalesce($3, title) where id = $1`, [documentId, versionId, r.title ?? null])
  await sql.query(`update public.source_objects set status = 'processed' where id = $1 and status in ('landed', 'profiled', 'processing')`, [obj.id])
  return { versionId, evidence: r.units.length }
}

/** Duplicate content: record a version that points at the twin's extraction instead of re-extracting. */
export async function writeDuplicateVersion(sql: Sql, obj: RawObjectRow, twin: { id: string; title: string | null; kind: string; page_count: number | null }, extractor: string, version: string): Promise<string> {
  const documentId = await documentFor(sql, obj, twin.kind, twin.title)
  const versionId = await newVersion(sql, obj, documentId, {
    extractor,
    version,
    status: 'succeeded',
    pageCount: twin.page_count,
    metadata: { same_content_as: twin.id },
  })
  await sql.query(`update public.documents set current_version_id = $2 where id = $1`, [documentId, versionId])
  await sql.query(`update public.source_objects set status = 'processed' where id = $1 and status in ('landed', 'profiled', 'processing')`, [obj.id])
  return versionId
}

/** Records that a file was deliberately not extracted (system files, unsupported formats). */
export async function writeSkipped(sql: Sql, obj: RawObjectRow, extractor: string, version: string, reason: string): Promise<void> {
  const documentId = await documentFor(sql, obj, 'file', null)
  await newVersion(sql, obj, documentId, { extractor, version, status: 'skipped', metadata: { reason } })
  await sql.query(`update public.source_objects set status = 'skipped' where id = $1 and status in ('landed', 'profiled')`, [obj.id])
}
