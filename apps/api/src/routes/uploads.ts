import { completeUpload, type FileDescriptor, finishUpload, signUpload, startUpload, UploadError } from '@companybrain/core/workbench/uploads'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Env } from '../tenant'

/** Browser uploads straight to S3 raw/: start a run, sign each file, confirm it, finish the run. */
export const uploads = new Hono<Env>()

uploads.onError((error, c) => {
  if (error instanceof UploadError) return c.json({ error: error.message }, error.status as ContentfulStatusCode)
  throw error
})

uploads.post('/uploads', async (c) => {
  const { label } = (await c.req.json().catch(() => ({}))) as { label?: string }
  return c.json(await startUpload(c.get('tenant').id, label))
})

uploads.post('/uploads/:runId/sign', async (c) => c.json(await signUpload(c.get('tenant').id, c.req.param('runId'), await c.req.json<FileDescriptor>())))

uploads.post('/uploads/:runId/complete', async (c) => c.json(await completeUpload(c.get('tenant').id, c.req.param('runId'), await c.req.json<FileDescriptor>())))

uploads.post('/uploads/:runId/finish', async (c) => {
  await finishUpload(c.get('tenant').id, c.req.param('runId'))
  return c.json({ ok: true })
})
