import { pool } from './server'
import { toolOutputView, type WorkbenchUIMessage } from './ui-message'

interface Block { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }

export interface StoredSession {
  session: { id: string; title: string | null; phase: string; updated_at: string }
  messages: WorkbenchUIMessage[]
}

/** Rebuilds a stored session as AI SDK UIMessages: the same parts the live stream produces. */
export async function loadSession(tenantId: string, id: string): Promise<StoredSession | null> {
  const db = pool()
  const session = (await db.query(`select id, title, phase, updated_at from public.workbench_sessions where tenant_id = $1 and id = $2`, [tenantId, id])).rows[0]
  if (!session) return null

  const stored = (await db.query<{ ordinal: number; role: string; content: Block[] }>(`select ordinal, role, content from public.workbench_messages where session_id = $1 order by ordinal`, [id])).rows
  const steps = (
    await db.query<{ tool_use_id: string; tool_name: string; summary: string; status: string; output_text: string | null; full_output: unknown; duration_ms: number | null }>(
      `select tool_use_id, tool_name, summary, status, left(output::text, 6000) as output_text,
              case when tool_name = 'render_chart' then output end as full_output,
              (extract(epoch from (finished_at - started_at)) * 1000)::int as duration_ms
       from public.workbench_steps where session_id = $1`,
      [id],
    )
  ).rows
  const stepByUse = new Map(steps.map((s) => [s.tool_use_id, s]))

  const messages: WorkbenchUIMessage[] = []
  for (const m of stored) {
    if (m.role === 'user') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      if (text) messages.push({ id: `m-${m.ordinal}`, role: 'user', parts: [{ type: 'text', text }] })
      continue // tool_result messages are represented by the tool parts below
    }
    let assistant = messages.at(-1)
    if (!assistant || assistant.role !== 'assistant') {
      assistant = { id: `m-${m.ordinal}`, role: 'assistant', parts: [] }
      messages.push(assistant)
    }
    assistant.parts.push({ type: 'step-start' })
    for (const b of m.content) {
      if (b.type === 'thinking' && b.thinking) assistant.parts.push({ type: 'reasoning', text: b.thinking, state: 'done' })
      else if (b.type === 'text' && b.text) assistant.parts.push({ type: 'text', text: b.text, state: 'done' })
      else if (b.type === 'tool_use' && b.id && b.name) {
        const s = stepByUse.get(b.id)
        if (!s || s.status === 'running') {
          assistant.parts.push({ type: 'dynamic-tool', toolName: b.name, toolCallId: b.id, state: 'input-available', input: b.input })
        } else if (s.status === 'error') {
          assistant.parts.push({ type: 'dynamic-tool', toolName: b.name, toolCallId: b.id, state: 'output-error', input: b.input, errorText: s.output_text ?? 'error' })
        } else {
          assistant.parts.push({
            type: 'dynamic-tool',
            toolName: b.name,
            toolCallId: b.id,
            state: 'output-available',
            input: b.input,
            output: toolOutputView(b.name, s.full_output ?? tryParse(s.output_text), s.summary, s.duration_ms),
          })
        }
      }
    }
  }
  return { session, messages }
}

function tryParse(s: string | null): unknown {
  if (s == null) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
