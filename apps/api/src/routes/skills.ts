import { reportMarkdown, runSkill, SKILLS, skillExamples } from '@companybrain/core/skills/skills'
import { pool } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/** Skills: repeatable workflows that turn the company record into a cited report. */
export const skills = new Hono<Env>()

skills.get('/skills', (c) => c.json(SKILLS.map(({ run: _run, ...s }) => s)))

/** Example inputs per skill, drawn from this client's record. */
skills.get('/skills/examples', async (c) => c.json(await skillExamples({ sql: pool(), tenantId: c.get('tenant').id, as: null })))

/** POST /skills/:key  { entity?, topic?, as? }  → Report (add ?format=md for Markdown). */
skills.post('/skills/:key', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { entity?: string; topic?: string; as?: string | null }
  try {
    const r = await runSkill({ sql: pool(), tenantId: c.get('tenant').id, as: body.as || null }, c.req.param('key'), { entity: body.entity, topic: body.topic })
    return c.req.query('format') === 'md' ? c.text(reportMarkdown(r)) : c.json(r)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})
