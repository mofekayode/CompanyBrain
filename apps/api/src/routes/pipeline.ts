import { listRuns, runActivity } from '@companybrain/core/workbench/activity'
import { extractionStatus, startTenantExtraction } from '@companybrain/core/workbench/extraction-status'
import { nextSteps } from '@companybrain/core/workbench/next-steps'
import { profilingStatus, startProfiling } from '@companybrain/core/workbench/profiling-job'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/** The client's workflow stages: profiling, extraction, and what to do next. */
export const pipeline = new Hono<Env>()

pipeline.get('/next-steps', async (c) => c.json(await nextSteps(c.get('tenant').id)))

pipeline.get('/profiling', async (c) => c.json(await profilingStatus(c.get('tenant').id)))

/** { force: false } profiles new/outdated files, { force: true } re-profiles everything. */
pipeline.post('/profiling', async (c) => {
  const { force } = (await c.req.json().catch(() => ({}))) as { force?: boolean }
  return c.json(await startProfiling(c.get('tenant').id, !!force))
})

pipeline.get('/extraction', async (c) => c.json(await extractionStatus(c.get('tenant').id)))

/**
 * Start extraction. Body: { mode: 'remaining' } (default) queues every file not yet extracted and retries failures;
 * { mode: 'sample' } re-extracts a small representative set; { mode: 'files', fileIds } re-extracts those files.
 */
pipeline.post('/extraction', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { mode?: 'remaining' | 'sample' | 'files'; fileIds?: string[] }
  if (body.mode && !['remaining', 'sample', 'files'].includes(body.mode)) return c.json({ error: 'bad mode' }, 400)
  return c.json(await startTenantExtraction(c.get('tenant').id, { mode: body.mode, fileIds: body.fileIds }))
})

/** Background runs (profiling, uploads, extraction), newest first. */
pipeline.get('/runs', async (c) => c.json(await listRuns(c.get('tenant').id)))

/** File-by-file activity of one run (default: the latest). */
pipeline.get('/activity', async (c) => c.json(await runActivity(c.get('tenant').id, c.req.query('run') || undefined)))
