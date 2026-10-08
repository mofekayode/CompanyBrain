// Extraction stage: route each profiled raw object to the right extractor job,
// and the handlers that run them. Started explicitly by an FDE (it costs money
// and time), after profiling and discovery.

import { type Profile, profileObject } from '../profiling/profile'
import { AUDIO_EXTRACTOR, extractAudio, extractImage, extractVideo, IMAGE_EXTRACTOR, VIDEO_EXTRACTOR } from '../extraction/extract-media'
import { DOCLING_EXTRACTOR, extractWithDocling } from '../extraction/extract-docling'
import { rebuildEmailIndex } from '../extraction/email-index'
import { EMAIL_EXTRACTOR, extractEmail, splitMbox } from '../extraction/extract-email'
import { extractOfficeXml, extractTable, extractText, TABLE_EXTRACTOR, TEXT_EXTRACTOR } from '../extraction/extract-basic'
import { embedVideo, TWELVELABS_EMBEDDER, twelveLabsConfigured } from '../extraction/embed-twelvelabs'
import { enc } from '../extraction/types'
import type { ExtractionResult } from '../extraction/types'
import { processedKey } from '../storage/layout'
import { existingVersion, loadRawObject, type RawObjectRow, twinVersion, writeDuplicateVersion, writeExtraction, writeSkipped } from '../extraction/write'
import type { ObjectStore } from '../storage/object-store'
import { guessMimeType, landRawObject, type Sql } from '../storage/raw'
import { enqueue, type Job, NotReadyError, settleParent, startRun } from './queue'

interface Route {
  jobType: string
  extractor: { name: string; version: string }
}

const MAILBOX_SPLITTER = { name: 'mbox-split', version: '1' }

/** Which extraction job a profiled file needs (null = nothing to extract, recorded as skipped). */
export function routeFor(p: Pick<Profile, 'format' | 'category'> | null | undefined): Route | null {
  if (!p) return null
  switch (p.format) {
    case 'pdf':
    case 'docx':
    case 'pptx':
      return { jobType: 'extract_document', extractor: DOCLING_EXTRACTOR }
    case 'csv':
    case 'xlsx':
      return { jobType: 'extract_table', extractor: TABLE_EXTRACTOR }
    case 'text':
    case 'markdown':
    case 'html':
    case 'rtf':
    case 'ics':
      return { jobType: 'extract_text', extractor: TEXT_EXTRACTOR }
    case 'mbox':
      return { jobType: 'unpack_mailbox', extractor: MAILBOX_SPLITTER }
    case 'eml':
      return { jobType: 'extract_email', extractor: EMAIL_EXTRACTOR }
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'heic':
      return { jobType: 'describe_image', extractor: IMAGE_EXTRACTOR }
    case 'mp3':
    case 'wav':
      return { jobType: 'transcribe_audio', extractor: AUDIO_EXTRACTOR }
    case 'mp4':
    case 'quicktime':
      return p.category === 'audio' ? { jobType: 'transcribe_audio', extractor: AUDIO_EXTRACTOR } : { jobType: 'analyze_video', extractor: VIDEO_EXTRACTOR }
    default:
      return null // zip (already unpacked), office_lock, ole2/Thumbs.db, sqlite, empty, unknown
  }
}

/** Per-type concurrency limits for the worker (external APIs and heavy CPU). */
export const EXTRACTION_CONCURRENCY: Record<string, number> = {
  extract_document: 2,
  analyze_video: 1,
  embed_video: 2,
  transcribe_audio: 2,
  describe_image: 2,
  build_company_map: 1,
  propose_access: 1,
  propose_ontology: 1,
  load_ontology: 1,
  resolve_entities: 1,
  extract_knowledge: 4,
  canonicalize_facts: 1,
  project_search: 1,
}

export interface ExtractionOptions {
  /** Only these source objects (e.g. a sample, or files picked in the portal). Default: every profiled file. */
  objectIds?: string[]
  /** Extract again even when a current extraction exists (new document version; nothing is overwritten). */
  force?: boolean
  /** Shown in the activity panel, e.g. "Sample (12 files)". */
  label?: string
}

/** Starts an extraction run for a client: queues every profiled object that has no current extraction (or the chosen ones). */
export async function startExtraction(sql: Sql, tenantId: string, opts: ExtractionOptions = {}): Promise<{ runId: string; queued: number; skipped: number }> {
  const runId = await startRun(sql, tenantId, 'extract', { label: opts.label ?? (opts.objectIds ? `${opts.objectIds.length} selected file(s)` : 'All files'), force: !!opts.force })
  // Forced jobs get their own keys (one per run) so they are not deduplicated against earlier extractions.
  const keySuffix = opts.force ? `:force:${runId}` : ''
  const payload = opts.force ? { force: true, after: new Date().toISOString() } : {}
  // Profiled files, plus messages split out of mailboxes (not profiled; they are always email).
  const { rows } = await sql.query<{ id: string; source_id: string; profile: Profile | null }>(
    `select so.id, so.source_id,
            case when so.metadata ? 'profile' then so.metadata -> 'profile' else '{"format":"eml","category":"email"}'::jsonb end as profile
     from public.source_objects so
     where so.tenant_id = $1
       and (so.metadata ? 'profile' or exists (select 1 from public.ingestion_jobs j where j.source_object_id = so.id and j.job_type = 'extract_email'))
       and ($2::uuid[] is null or so.id = any($2::uuid[]))
     order by so.original_path`,
    [tenantId, opts.objectIds ?? null],
  )
  let queued = 0
  let skipped = 0
  for (const o of rows) {
    const route = routeFor(o.profile)
    if (!route) {
      const done = await existingSkip(sql, o.id)
      if (!done) {
        await writeSkipped(sql, await loadRawObject(sql, o.id), 'none', '1', `nothing to extract (${o.profile?.format ?? 'unknown'})`)
        skipped++
      }
      continue
    }
    const id = await enqueue(sql, {
      tenantId,
      jobType: route.jobType,
      idempotencyKey: `${o.id}:${route.extractor.name}:v${route.extractor.version}${keySuffix}`,
      sourceObjectId: o.id,
      sourceId: o.source_id,
      parentJobId: runId,
      payload,
    })
    if (id) queued++
    // Videos also get Twelve Labs embeddings (for semantic video search), when configured.
    if (route.jobType === 'analyze_video' && twelveLabsConfigured()) {
      const e = await enqueue(sql, {
        tenantId,
        jobType: 'embed_video',
        idempotencyKey: `${o.id}:${TWELVELABS_EMBEDDER.name}:v${TWELVELABS_EMBEDDER.version}${keySuffix}`,
        sourceObjectId: o.id,
        sourceId: o.source_id,
        parentJobId: runId,
        priority: -1,
        payload,
      })
      if (e) queued++
    }
  }
  // Email threads and the address book are rebuilt once this run's emails are extracted.
  if (rows.some((o) => o.profile?.format === 'mbox' || o.profile?.format === 'eml')) {
    const e = await enqueue(sql, { tenantId, jobType: 'index_email', idempotencyKey: `email-index:${runId}`, parentJobId: runId, priority: -2 })
    if (e) queued++
  }
  await settleParent(sql, runId)
  return { runId, queued, skipped }
}

/**
 * A small, representative set of top-level files: one or two of each kind the
 * pipeline handles (text PDF, scanned PDF, Word, PowerPoint, Excel, CSV, text,
 * mailbox, photos, audio, video), preferring small files so a sample run is
 * quick and cheap.
 */
export async function sampleObjectIds(sql: Sql, tenantId: string): Promise<string[]> {
  const { rows } = await sql.query<{ id: string }>(
    `with files as (
       select so.id, so.size_bytes, so.metadata -> 'profile' p,
              case
                when so.metadata -> 'profile' ->> 'format' = 'pdf' and coalesce((so.metadata -> 'profile' -> 'document' ->> 'likely_scanned')::boolean, false) then 'pdf_scan'
                when so.metadata -> 'profile' ->> 'format' in ('pdf', 'docx', 'pptx', 'xlsx', 'csv', 'mbox', 'eml') then so.metadata -> 'profile' ->> 'format'
                when so.metadata -> 'profile' ->> 'format' in ('text', 'markdown', 'html', 'rtf', 'ics') then 'text'
                when so.metadata -> 'profile' ->> 'category' = 'image' then 'image'
                when so.metadata -> 'profile' ->> 'category' = 'audio' then 'audio'
                when so.metadata -> 'profile' ->> 'category' = 'video' then 'video'
              end bucket
       from public.source_objects so
       where so.tenant_id = $1 and so.parent_id is null and so.metadata ? 'profile' and so.size_bytes > 2000),
     ranked as (
       select id, bucket, row_number() over (partition by bucket order by size_bytes) n from files where bucket is not null)
     select id from ranked where n <= case bucket when 'image' then 2 else 1 end`,
    [tenantId],
  )
  return rows.map((r) => r.id)
}

async function existingSkip(sql: Sql, sourceObjectId: string): Promise<boolean> {
  const r = await sql.query(`select 1 from public.document_versions where source_object_id = $1 limit 1`, [sourceObjectId])
  return r.rows.length > 0
}

/** Queues extraction for one newly landed child (mail message, attachment) inside the same run. */
async function enqueueChild(sql: Sql, job: Job, child: { id: string; sourceId: string; profile: Pick<Profile, 'format' | 'category'> }) {
  const route = routeFor(child.profile)
  if (!route) return
  const force = !!job.payload?.force
  await enqueue(sql, {
    tenantId: job.tenant_id,
    jobType: route.jobType,
    idempotencyKey: `${child.id}:${route.extractor.name}:v${route.extractor.version}${force ? `:force:${job.parent_job_id}` : ''}`,
    sourceObjectId: child.id,
    sourceId: child.sourceId,
    parentJobId: job.parent_job_id,
    payload: force ? job.payload : {},
  })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type Ctx = { sql: Sql; store: ObjectStore }

/** Common wrapper: idempotent (already extracted → done), extract-once for identical content. */
async function runExtraction(job: Job, ctx: Ctx, extractor: { name: string; version: string }, extract: (bytes: Uint8Array, obj: RawObjectRow, profile: Profile | null) => Promise<ExtractionResult>) {
  const obj = await loadRawObject(ctx.sql, job.source_object_id!)
  const force = !!job.payload?.force
  if (!force && (await existingVersion(ctx.sql, obj.id, extractor.name, extractor.version))) return { already: true }
  const twin = force ? null : await twinVersion(ctx.sql, obj, extractor.name, extractor.version)
  if (twin) return { duplicate_of: await writeDuplicateVersion(ctx.sql, obj, twin, extractor.name, extractor.version) }
  const profile = (await ctx.sql.query<{ profile: Profile | null }>(`select metadata -> 'profile' as profile from public.source_objects where id = $1`, [obj.id])).rows[0]?.profile ?? null
  const bytes = await ctx.store.get(obj.s3_key)
  if (!bytes) throw new Error('raw object missing from S3')
  const result = await extract(bytes, obj, profile)
  const written = await writeExtraction(ctx.sql, ctx.store, obj, result)
  const kinds: Record<string, number> = {}
  for (const u of result.units) kinds[u.kind] = (kinds[u.kind] ?? 0) + 1
  return {
    version: written.versionId,
    evidence: written.evidence,
    extractor: `${result.extractor} v${result.extractorVersion}`,
    kinds,
    pages: Math.max(0, ...result.units.map((u) => u.pageNumber ?? 0)) || undefined,
    seconds: Math.max(0, ...result.units.map((u) => (u.endMs ?? 0) / 1000)) || undefined,
  }
}

const mime = (obj: RawObjectRow, fallback: string) => guessMimeType(obj.original_filename) ?? fallback

export const EXTRACTION_HANDLERS: Record<string, (job: Job, ctx: Ctx) => Promise<unknown>> = {
  /** Rebuilds email threads and addresses for the client, after every pending email job has finished. */
  index_email: async (job, ctx) => {
    const pending = await ctx.sql.query<{ n: number }>(
      `select count(*)::int n from public.ingestion_jobs
       where tenant_id = $1 and job_type in ('unpack_mailbox', 'extract_email') and status in ('queued', 'running')`,
      [job.tenant_id],
    )
    if (pending.rows[0].n > 0) throw new NotReadyError(`${pending.rows[0].n} email jobs still pending`, 30)
    return rebuildEmailIndex(ctx.sql, job.tenant_id)
  },

  extract_document: (job, ctx) =>
    runExtraction(job, ctx, DOCLING_EXTRACTOR, async (bytes, obj, p) => {
      const format = p?.format ?? 'pdf'
      try {
        return await extractWithDocling(bytes, obj.original_filename, format, { likelyScanned: !!p?.document?.likely_scanned })
      } catch (error) {
        // Docling rejected the file itself (not unreachable): Office files still have readable XML.
        const message = (error as Error).message
        if ((format === 'pptx' || format === 'docx') && /could not convert/.test(message)) return extractOfficeXml(bytes, format, obj.original_filename, message)
        throw error
      }
    }),

  extract_table: (job, ctx) => runExtraction(job, ctx, TABLE_EXTRACTOR, (bytes, obj, p) => extractTable(bytes, p?.format ?? 'csv', obj.original_filename, p ?? undefined)),

  extract_text: (job, ctx) => runExtraction(job, ctx, TEXT_EXTRACTOR, (bytes, obj, p) => extractText(bytes, p?.format ?? 'text', obj.original_filename)),

  describe_image: (job, ctx) => runExtraction(job, ctx, IMAGE_EXTRACTOR, (bytes, obj, p) => extractImage(bytes, obj.original_filename, p ?? undefined)),

  transcribe_audio: (job, ctx) => runExtraction(job, ctx, AUDIO_EXTRACTOR, (bytes, obj) => extractAudio(bytes, obj.original_filename, mime(obj, 'audio/mp4'))),

  analyze_video: (job, ctx) => runExtraction(job, ctx, VIDEO_EXTRACTOR, (bytes, obj) => extractVideo(bytes, obj.original_filename, mime(obj, 'video/mp4'))),

  /**
   * Twelve Labs embeddings for a video, attached to its analyze_video extraction (no new version).
   * Waits for that extraction first (retries with backoff until it exists).
   */
  embed_video: async (job, ctx) => {
    const obj = await loadRawObject(ctx.sql, job.source_object_id!)
    const version = (
      await ctx.sql.query<{ id: string; metadata: Record<string, unknown> }>(
        `select id, metadata from public.document_versions
         where source_object_id = $1 and extractor = $2 and extraction_status = 'succeeded' and ($3::timestamptz is null or created_at >= $3::timestamptz)
         order by created_at desc limit 1`,
        [obj.id, VIDEO_EXTRACTOR.name, (job.payload?.after as string | undefined) ?? null],
      )
    ).rows[0]
    if (!version) {
      const analysis = await ctx.sql.query<{ status: string }>(
        `select status from public.ingestion_jobs where source_object_id = $1 and job_type = 'analyze_video' order by created_at desc limit 1`,
        [obj.id],
      )
      if (analysis.rows[0]?.status === 'dead') throw new Error('video analysis failed; nothing to embed against')
      throw new NotReadyError('video not analyzed yet', 60)
    }
    if ((version.metadata?.twelvelabs as { version?: string } | undefined)?.version === TWELVELABS_EMBEDDER.version) return { already: true }
    const out = await embedVideo(obj.s3_key)
    const key = processedKey({ tenantId: obj.tenant_id, kind: 'video', documentVersionId: version.id, artifact: 'twelvelabs-embeddings.json' })
    await ctx.store.put(key, enc(JSON.stringify(out)), 'application/json')
    const summary = { version: TWELVELABS_EMBEDDER.version, model: out.model, task_id: out.task_id, segments: out.segments.length, dimensions: out.dimensions, artifact: 'twelvelabs-embeddings.json' }
    await ctx.sql.query(`update public.document_versions set metadata = metadata || jsonb_build_object('twelvelabs', $2::jsonb) where id = $1`, [version.id, JSON.stringify(summary)])
    return summary
  },

  /** mbox → one raw .eml child per message (the mbox stays untouched), each queued for extract_email. */
  unpack_mailbox: async (job, ctx) => {
    const obj = await loadRawObject(ctx.sql, job.source_object_id!)
    const split = await existingVersion(ctx.sql, obj.id, MAILBOX_SPLITTER.name, MAILBOX_SPLITTER.version)
    if (split && !job.payload?.force) return { already: true }
    const bytes = await ctx.store.get(obj.s3_key)
    if (!bytes) throw new Error('raw object missing from S3')
    const source = (await ctx.sql.query<{ config: { slug?: string } }>(`select config from public.sources where id = $1`, [obj.source_id])).rows[0]
    const batch = obj.s3_key.split('/')[3]
    if (!source?.config?.slug || !batch) throw new Error('cannot derive source/batch for mailbox messages')
    const messages = splitMbox(bytes)
    for (const [i, msg] of messages.entries()) {
      const child = await landRawObject(
        {
          tenantId: obj.tenant_id,
          source: { id: obj.source_id, slug: source.config.slug },
          batch,
          originalPath: `${obj.original_path}/messages/${String(i + 1).padStart(5, '0')}.eml`,
          bytes: msg,
          parentId: obj.id,
          mimeType: 'message/rfc822',
          sourcePermissions: { inherited_from: obj.id },
        },
        ctx,
      )
      if (obj.acl_id) await ctx.sql.query(`update public.source_objects set acl_id = coalesce(acl_id, $2) where id = $1`, [child.id, obj.acl_id])
      // Profile inline (cheap) so each message is a normal, profiled file in the inventory.
      const profile = { ...(await profileObject(msg, `${String(i + 1).padStart(5, '0')}.eml`)), profiled_at: new Date().toISOString() }
      await ctx.sql.query(
        `update public.source_objects set metadata = jsonb_set(metadata, '{profile}', $2::jsonb), status = 'profiled' where id = $1 and not metadata ? 'profile'`,
        [child.id, JSON.stringify(profile)],
      )
      await enqueueChild(ctx.sql, job, { id: child.id, sourceId: obj.source_id, profile: { format: 'eml', category: 'email' } })
    }
    if (!split) {
      await writeSkipped(ctx.sql, obj, MAILBOX_SPLITTER.name, MAILBOX_SPLITTER.version, `container: split into ${messages.length} messages`)
      await ctx.sql.query(`update public.document_versions set extraction_status = 'succeeded' where source_object_id = $1 and extractor = $2`, [obj.id, MAILBOX_SPLITTER.name])
    }
    return { messages: messages.length }
  },

  /** One message → headers, thread key, fresh body; attachments land as raw children and are extracted too. */
  extract_email: async (job, ctx) => {
    let attachments: { filename: string; contentType: string; bytes: Uint8Array }[] = []
    const out = await runExtraction(job, ctx, EMAIL_EXTRACTOR, async (bytes, obj) => {
      const parsed = await extractEmail(bytes, obj.original_filename)
      attachments = parsed.attachments
      return parsed.result
    })
    if (attachments.length) {
      const obj = await loadRawObject(ctx.sql, job.source_object_id!)
      const source = (await ctx.sql.query<{ config: { slug?: string } }>(`select config from public.sources where id = $1`, [obj.source_id])).rows[0]
      const batch = obj.s3_key.split('/')[3]
      for (const a of attachments) {
        const safe = a.filename.replace(/[/\\]/g, '_')
        const child = await landRawObject(
          { tenantId: obj.tenant_id, source: { id: obj.source_id, slug: source!.config.slug! }, batch, originalPath: `${obj.original_path}/attachments/${safe}`, bytes: a.bytes, parentId: obj.id, mimeType: a.contentType, sourcePermissions: { inherited_from: obj.id } },
          ctx,
        )
        if (obj.acl_id) await ctx.sql.query(`update public.source_objects set acl_id = coalesce(acl_id, $2) where id = $1`, [child.id, obj.acl_id])
        // Profile inline (cheap) so the attachment is routed by its real format.
        const profile = { ...(await profileObject(a.bytes, safe)), profiled_at: new Date().toISOString() }
        await ctx.sql.query(
          `update public.source_objects set metadata = jsonb_set(metadata, '{profile}', $2::jsonb), status = 'profiled' where id = $1 and not metadata ? 'profile'`,
          [child.id, JSON.stringify(profile)],
        )
        await enqueueChild(ctx.sql, job, { id: child.id, sourceId: obj.source_id, profile })
      }
    }
    return { ...(out as object), attachments: attachments.length }
  },
}
