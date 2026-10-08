import { type KnowledgeScope, latestProposal, startCanonicalRun, startKnowledgeRun, startOntologyRun } from '@companybrain/core/jobs/ontology'
import { businessMap, clusterMembers, entityDetail, knowledgeOverview, neighbourhood, searchEntities, topEntities } from '@companybrain/core/ontology/graph'
import { pool } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/** The company model (ontology + knowledge graph), for the FDE's model view. */
export const model = new Hono<Env>()

/** Types with counts and how they connect (the business map), plus the proposal's notes. */
model.get('/model', async (c) => {
  const tenantId = c.get('tenant').id
  const [map, proposal] = await Promise.all([businessMap(pool(), tenantId, { fresh: c.req.query('fresh') !== undefined }), latestProposal(pool(), tenantId)])
  return c.json({ ...map, notes: proposal?.notes ?? [], proposed_at: proposal?.proposed_at ?? null })
})

/** Build or rebuild the model in the background. Body: { reuse?: true } reloads from the latest proposal. */
model.post('/model/run', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reuse?: boolean }
  return c.json(await startOntologyRun(pool(), c.get('tenant').id, body))
})

/** Accept or reject a proposed type. */
model.patch('/model/types/:id', async (c) => {
  const { status } = (await c.req.json()) as { status?: 'active' | 'rejected' | 'proposed' }
  if (!status) return c.json({ error: 'status required' }, 400)
  await pool().query(`update public.entity_types set status = $3 where tenant_id = $1 and id = $2`, [c.get('tenant').id, c.req.param('id'), status])
  return c.json({ ok: true })
})

model.get('/model/types/:id/top', async (c) => c.json(await topEntities(pool(), c.get('tenant').id, c.req.param('id'), Number(c.req.query('limit') ?? 25))))
model.get('/model/search', async (c) => c.json(await searchEntities(pool(), c.get('tenant').id, c.req.query('q') ?? '')))
model.get('/model/entities/:id', async (c) => {
  const d = await entityDetail(pool(), c.get('tenant').id, c.req.param('id'))
  return d ? c.json(d) : c.json({ error: 'unknown entity' }, 404)
})
model.get('/model/entities/:id/graph', async (c) => c.json(await neighbourhood(pool(), c.get('tenant').id, c.req.param('id'))))
model.get('/model/entities/:id/cluster', async (c) =>
  c.json(await clusterMembers(pool(), c.get('tenant').id, c.req.param('id'), c.req.query('rel') ?? '', (c.req.query('dir') as 'in' | 'out') ?? 'in', c.req.query('type') ?? '')),
)

/** Read prose for vocabulary, exceptions and facts. Body: { scope: 'interviews' | 'documents' | 'emails' | 'all' } */
model.post('/model/knowledge', async (c) => {
  const { scope } = (await c.req.json().catch(() => ({}))) as { scope?: KnowledgeScope }
  return c.json(await startKnowledgeRun(pool(), c.get('tenant').id, scope ?? 'interviews'))
})

/** Facts and vocabulary read from prose. */
model.get('/model/knowledge', async (c) => c.json(await knowledgeOverview(pool(), c.get('tenant').id)))

/** Group claims into canonical facts (background run). */
model.post('/model/canonical', async (c) => c.json(await startCanonicalRun(pool(), c.get('tenant').id)))
