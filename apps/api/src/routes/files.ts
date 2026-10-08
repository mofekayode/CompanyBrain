import { fileExtraction } from '@companybrain/core/workbench/evidence-search'
import { readableTables, readableText, type PreviewTable } from '@companybrain/core/workbench/read-file'
import { pool, store } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import { serveRaw } from '../media'
import { transcriptFor } from '@companybrain/core/workbench/transcript'
import type { Env } from '../tenant'

export const files = new Hono<Env>()

files.get('/inventory', async (c) => {
  const tenant = c.get('tenant')
  const { rows } = await pool().query(
    `select id, source_name, source_kind, original_path, original_filename, format, category, structure, size_bytes,
            integrity_ok, integrity_issues, content_earliest, content_latest, duplicate_copies, likely_scanned,
            coalesce(profile -> 'table' ->> 'rows', profile -> 'email' ->> 'messages') as rows_or_messages
     from public.source_inventory where tenant_id = $1 order by source_name, original_path`,
    [tenant.id],
  )
  return c.json({ tenant, files: rows })
})

/** File details plus a text/table preview (PDFs and media are rendered by the browser from /raw). */
files.get('/files/:id', async (c) => {
  const file = (
    await pool().query(
      `select id, source_name, original_path, original_filename, format, category, mime_type, size_bytes, sha256, s3_key, source_modified_at,
              duplicate_copies, integrity_ok, integrity_issues, profile
       from public.source_inventory where tenant_id = $1 and id = $2`,
      [c.get('tenant').id, c.req.param('id')],
    )
  ).rows[0]
  if (!file) return c.json({ error: 'unknown file' }, 404)
  const browserRendered = ['pdf', 'jpeg', 'png', 'gif', 'mp4', 'quicktime', 'mp3', 'wav'].includes(file.format)
  let preview: { text: string; note?: string } = { text: '' }
  let tables: PreviewTable[] | null = null
  if (!browserRendered) {
    try {
      const bytes = await (await store()).get(file.s3_key)
      if (bytes) {
        tables = await readableTables(bytes, file.format)
        if (!tables) preview = await readableText(bytes, file.format, { maxChars: 60000, offset: 0 })
      }
    } catch (error) {
      preview = { text: '', note: `preview failed: ${(error as Error).message}` }
    }
  }
  return c.json({ ...file, preview, tables })
})

/** What extraction produced for this file: versions and the current passages with citations. */
files.get('/files/:id/extraction', async (c) => c.json(await fileExtraction(c.get('tenant').id, c.req.param('id'))))

/** Original raw bytes, so the browser can render PDFs, images, audio and video. */
files.get('/files/:id/raw', async (c) => {
  const file = (
    await pool().query<{ s3_key: string; mime_type: string | null; original_filename: string }>(
      `select s3_key, mime_type, original_filename from public.source_objects where tenant_id = $1 and id = $2`,
      [c.get('tenant').id, c.req.param('id')],
    )
  ).rows[0]
  if (!file) return c.text('unknown file', 404)
  return serveRaw(c.req.raw, file, { download: c.req.query('download') !== undefined })
})

/** Timed transcript (speaker lines) of an audio or video file. */
files.get('/files/:id/transcript', async (c) => c.json(await transcriptFor(pool(), c.get('tenant').id, c.req.param('id'))))
