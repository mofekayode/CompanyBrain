import { decideRelationship, relationshipReview } from '@companybrain/core/ontology/relationship-review'
import { reviewFact } from '@companybrain/core/ontology/canonical'
import { canonicalFacts, decideMerge, type FactFilter, mergeQueue, reviewSummary } from '@companybrain/core/ontology/review'
import { pool } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/** Knowledge review: canonical facts, conflicts, timelines and merges that need an FDE. */
export const knowledge = new Hono<Env>()

knowledge.get('/knowledge', async (c) => c.json(await reviewSummary(pool(), c.get('tenant').id)))

knowledge.get('/knowledge/facts', async (c) =>
  c.json(await canonicalFacts(pool(), c.get('tenant').id, { filter: (c.req.query('filter') as FactFilter) ?? 'to_review', kind: c.req.query('kind') || undefined, q: c.req.query('q') || undefined })),
)

/** accept | dispute | reject | unknown | correct (with value, valid_from/valid_to). */
knowledge.post('/knowledge/facts/:id/review', async (c) => {
  const body = (await c.req.json()) as Parameters<typeof reviewFact>[3]
  if (!['accept', 'dispute', 'reject', 'unknown', 'correct'].includes(body.action)) return c.json({ error: 'bad action' }, 400)
  return c.json(await reviewFact(pool(), c.get('tenant').id, c.req.param('id'), body))
})

knowledge.get('/knowledge/merges', async (c) => c.json(await mergeQueue(pool(), c.get('tenant').id)))

knowledge.post('/knowledge/merges/:id', async (c) => {
  const { decision } = (await c.req.json()) as { decision: 'merge' | 'separate' }
  if (decision !== 'merge' && decision !== 'separate') return c.json({ error: 'bad decision' }, 400)
  return c.json(await decideMerge(pool(), c.get('tenant').id, c.req.param('id'), decision))
})

/** Relationship review: link types, exceptions to learned patterns, prose links. Cached briefly (it scans every link). */
const relCache = new Map<string, { at: number; data: unknown }>()
knowledge.get('/knowledge/relationships', async (c) => {
  const id = c.get('tenant').id
  const hit = relCache.get(id)
  if (hit && Date.now() - hit.at < 30 * 60_000 && c.req.query('fresh') !== '1') return c.json(hit.data)
  const data = await relationshipReview(pool(), id)
  relCache.set(id, { at: Date.now(), data })
  return c.json(data)
})

knowledge.post('/knowledge/relationships/:id', async (c) => {
  const body = (await c.req.json()) as { action: 'accept' | 'reject' | 'end'; valid_to?: string; note?: string }
  if (!['accept', 'reject', 'end'].includes(body.action)) return c.json({ error: 'action must be accept, reject or end' }, 400)
  const rid = c.req.param('id')
  const out = await decideRelationship(pool(), c.get('tenant').id, rid, body)
  // Keep the cached review, minus what was just decided (a full rescan takes a while).
  const hit = relCache.get(c.get('tenant').id) as { data: { issues: { links: { relationship_id: string }[] }[]; prose: { relationship_id: string }[] } } | undefined
  if (hit) {
    hit.data.issues = hit.data.issues.filter((i) => !i.links.some((l) => l.relationship_id === rid))
    hit.data.prose = hit.data.prose.filter((p) => p.relationship_id !== rid)
  }
  return c.json(out)
})
