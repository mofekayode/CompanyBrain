import { answer, buildContext } from '@companybrain/core/answer/answer'
import { runTool, TOOL_SPECS } from '@companybrain/core/answer/tools'
import { apiAllowed } from '@companybrain/core/claude'
import { enqueue } from '@companybrain/core/jobs/queue'
import { search } from '@companybrain/core/search/search'
import { pool } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/** Company search and answers (hybrid Elasticsearch retrieval; answers when the Claude API is on). */
export const searchRoutes = new Hono<Env>()

const csv = (v?: string) => (v ? v.split(',').filter(Boolean) : undefined)

/** GET /search?q=&as=<principal>&types=passage,fact&kinds=email_body&as_of=2025-06-01&rerank=1&only=bm25 */
searchRoutes.get('/search', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'q required' }, 400)
  return c.json(
    await search(pool(), c.get('tenant').id, q, {
      as: c.req.query('as') || null,
      docTypes: csv(c.req.query('types')) as ('passage' | 'entity' | 'fact')[] | undefined,
      kinds: csv(c.req.query('kinds')),
      asOf: c.req.query('as_of') || undefined,
      rerank: c.req.query('rerank') === '1',
      only: (c.req.query('only') as 'bm25' | 'knn' | undefined) || undefined,
      limit: Number(c.req.query('limit') ?? 15),
    }),
  )
})

/** Index health: documents by type, pending changes, last sync. */
searchRoutes.get('/search/status', async (c) => {
  const tenantId = c.get('tenant').id
  const [docs, outbox, last] = await Promise.all([
    pool().query<{ doc_type: string; kind: string; n: number; unindexed: number }>(
      `select doc_type, kind, count(*)::int n, count(*) filter (where indexed_at is null)::int unindexed from public.search_documents where tenant_id = $1 group by 1, 2 order by 1, 3 desc`,
      [tenantId],
    ),
    pool().query<{ n: number }>(`select count(*)::int n from public.search_outbox where tenant_id = $1 and processed_at is null`, [tenantId]),
    pool().query<{ finished_at: string | null; result: unknown }>(
      `select finished_at::text, result from public.ingestion_jobs where tenant_id = $1 and job_type = 'project_search' and status = 'succeeded' order by finished_at desc limit 1`,
      [tenantId],
    ),
  ])
  return c.json({ documents: docs.rows, pending_changes: outbox.rows[0].n, last_sync: last.rows[0] ?? null, answers_enabled: apiAllowed() })
})

/** Who the FDE can search as (people in the company map). */
searchRoutes.get('/search/people', async (c) =>
  c.json(
    (
      await pool().query<{ id: string; name: string; title: string | null }>(
        `select id, display_name name, metadata ->> 'title' title from public.principals
         where tenant_id = $1 and kind = 'user' and coalesce(metadata ->> 'status', 'active') = 'active' order by display_name`,
        [c.get('tenant').id],
      )
    ).rows,
  ),
)

/** Sync now (normally the worker does it within seconds of a change). */
searchRoutes.post('/search/sync', async (c) =>
  c.json({ job: await enqueue(pool(), { tenantId: c.get('tenant').id, jobType: 'project_search', idempotencyKey: `project-search:manual:${Date.now()}` }) }),
)

/** The context an answer is built from (sources, facts, the exact prompt). Works with the API off. */
searchRoutes.post('/ask/context', async (c) => {
  const b = (await c.req.json()) as { question?: string; as?: string; as_of?: string }
  if (!b.question?.trim()) return c.json({ error: 'question required' }, 400)
  return c.json(await buildContext(pool(), c.get('tenant').id, b.question, { as: b.as || null, asOf: b.as_of }))
})

/** A cited answer (Claude API on), otherwise the context pack with a note. */
searchRoutes.post('/ask', async (c) => {
  const b = (await c.req.json()) as { question?: string; as?: string }
  if (!b.question?.trim()) return c.json({ error: 'question required' }, 400)
  return c.json(await answer(pool(), c.get('tenant').id, b.question, { as: b.as || null }))
})

/** Agent tools, callable directly (debugging and the FDE's own investigation). */
searchRoutes.get('/tools', (c) => c.json(TOOL_SPECS))
searchRoutes.post('/tools/:name', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { input?: Record<string, unknown>; as?: string }
  return c.json(await runTool({ sql: pool(), tenantId: c.get('tenant').id, as: b.as || null }, c.req.param('name'), b.input ?? {}))
})
