import { pool } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/** Discovery questions, findings review and internal FDE notes. */
export const discovery = new Hono<Env>()

discovery.get('/questions', async (c) => {
  const { rows } = await pool().query(
    `select q.id, q.phase, q.ordinal, q.question, q.guidance,
            f.id as finding_id, f.answer, f.status, f.confidence, f.created_at, f.reviewed_at, f.review_note,
            coalesce(ev.evidence, '[]'::jsonb) as evidence
     from public.discovery_questions q
     left join lateral (
       select * from public.discovery_findings f
       where f.tenant_id = $1 and f.question_id = q.id and f.status <> 'superseded'
       order by f.created_at desc limit 1) f on true
     left join lateral (
       select jsonb_agg(jsonb_build_object('id', o.id, 'path', o.original_path, 'source', s.name, 'note', e.note) order by o.original_path) evidence
       from public.discovery_finding_evidence e
       join public.source_objects o on o.id = e.source_object_id
       join public.sources s on s.id = o.source_id
       where e.finding_id = f.id) ev on true
     where q.phase = $2 order by q.ordinal`,
    [c.get('tenant').id, c.req.query('phase') ?? '4'],
  )
  return c.json(rows)
})

/** FDE review: confirm or reject a finding (or send it back to hypothesis). */
discovery.patch('/findings/:id', async (c) => {
  const { status, note } = (await c.req.json()) as { status?: string; note?: string }
  if (status !== 'confirmed' && status !== 'rejected' && status !== 'hypothesis') return c.json({ error: 'bad status' }, 400)
  const { rows } = await pool().query(
    `update public.discovery_findings
     set status = $3, review_note = $4, reviewed_at = case when $3 = 'hypothesis' then null else now() end
     where tenant_id = $1 and id = $2 returning id, status`,
    [c.get('tenant').id, c.req.param('id'), status, note ?? null],
  )
  return rows[0] ? c.json(rows[0]) : c.json({ error: 'unknown finding' }, 404)
})

/** Internal FDE notes for a client (never client-facing). */
discovery.get('/notes', async (c) => {
  const { rows } = await pool().query(
    `select id, title, body, kind, session_id, created_at from public.workbench_notes where tenant_id = $1 order by created_at desc`,
    [c.get('tenant').id],
  )
  return c.json(rows)
})

discovery.post('/notes', async (c) => {
  const { title, body, kind, sessionId } = (await c.req.json()) as { title?: string; body?: string; kind?: string; sessionId?: string | null }
  if (!body?.trim()) return c.json({ error: 'empty note' }, 400)
  const { rows } = await pool().query(
    `insert into public.workbench_notes (tenant_id, title, body, kind, session_id)
     values ($1, $2, $3, $4, (select id from public.workbench_sessions where tenant_id = $1 and id = $5::uuid))
     returning id, title, kind, created_at`,
    [c.get('tenant').id, (title?.trim() || 'Untitled note').slice(0, 200), body, kind === 'discovery_summary' ? kind : 'note', sessionId ?? null],
  )
  return c.json(rows[0])
})
