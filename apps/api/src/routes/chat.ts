import { runTurn } from '@companybrain/core/workbench/agent'
import { pool } from '@companybrain/core/workbench/server'
import { loadSession } from '@companybrain/core/workbench/sessions'
import type { WorkbenchUIMessage } from '@companybrain/core/workbench/ui-message'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/** Workbench chat sessions and the agent stream. */
export const chat = new Hono<Env>()

chat.get('/sessions', async (c) => {
  const { rows } = await pool().query(
    `select s.id, s.title, s.phase, s.updated_at,
            (select count(*)::int from public.workbench_steps st where st.session_id = s.id) as steps
     from public.workbench_sessions s where s.tenant_id = $1 order by s.updated_at desc limit 50`,
    [c.get('tenant').id],
  )
  return c.json(rows)
})

chat.post('/sessions', async (c) => {
  const { rows } = await pool().query(
    `insert into public.workbench_sessions (tenant_id, phase) values ($1, '4') returning id, title, phase, updated_at, 0 as steps`,
    [c.get('tenant').id],
  )
  return c.json(rows[0])
})

chat.get('/sessions/:id', async (c) => {
  const stored = await loadSession(c.get('tenant').id, c.req.param('id'))
  return stored ? c.json(stored) : c.json({ error: 'unknown session' }, 404)
})

/**
 * AI SDK chat stream. The server owns conversation state (workbench_messages),
 * so the client sends only the session id and the new user text. A session is
 * created on the first message and announced with a `data-session` part.
 */
chat.post('/chat', async (c) => {
  const tenant = c.get('tenant')
  const { sessionId, text } = (await c.req.json()) as { sessionId?: string | null; text?: string }
  if (!text?.trim()) return c.json({ error: 'empty message' }, 400)

  let id = sessionId ?? null
  if (id) {
    const owns = await pool().query(`select 1 from public.workbench_sessions where tenant_id = $1 and id = $2`, [tenant.id, id])
    if (owns.rowCount === 0) return c.json({ error: 'unknown session' }, 404)
  } else {
    id = (await pool().query<{ id: string }>(`insert into public.workbench_sessions (tenant_id, phase) values ($1, '4') returning id`, [tenant.id])).rows[0].id
  }

  const stream = createUIMessageStream<WorkbenchUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: 'start' })
      await runTurn({ tenantId: tenant.id, sessionId: id, userText: text.trim(), write: (chunk) => writer.write(chunk) })
      writer.write({ type: 'finish' })
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  })
  return createUIMessageStreamResponse({ stream })
})
