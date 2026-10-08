import Anthropic from '@anthropic-ai/sdk'
import type { UIMessageChunk } from 'ai'
import { assertApiAllowed } from '../claude'
import { readEnv } from '../env'
import { pool } from './server'
import { findTool, TOOL_DEFINITIONS } from './tools'
import { toolOutputView, type WorkbenchDataTypes } from './ui-message'

export const MODEL = 'claude-opus-5-5'
const MAX_TOOL_ROUNDS = 40

export type WorkbenchChunk = UIMessageChunk<never, WorkbenchDataTypes>

const SYSTEM_PROMPT = `You are the discovery agent inside Company Brain's FDE workbench. A forward-deployed engineer is onboarding a newly acquired company whose files were handed over exactly as found. Your job is source discovery: learn what the raw evidence IS (systems, history, duplicates, integrity, structure, permission boundaries, key people, likely systems of record) before anyone claims to understand what it MEANS.

Workflow for a client: (1) profile the raw files (run_profiling) if they are not profiled yet; (2) answer the discovery questions with evidence (record_finding); (3) when asked to double-check, re-verify findings and record corrected ones; (4) extract the content of the files (run_extraction) once discovery is confirmed or when asked; (5) answer questions about what the files SAY using the extracted content; (6) summarize. If a request needs profile data that does not exist yet, run run_profiling first and say so.

How to work:
- Use the tools to look at the actual inventory and files. Every claim needs evidence you looked at in this session: file paths, row counts, dates, column layouts, permission export rows.
- Prefer aggregate queries (query_inventory) to find candidates, then open the specific files that settle the question (get_file_profile, read_file).
- Separate observation from interpretation. Observations are facts about files. Interpretations (legacy vs current, authority, key-person risk) are hypotheses and must be labeled as such.
- Copy-time filesystem timestamps are not history; use content and embedded metadata dates.
- Every number you write (counts, totals, row counts, dates) must come from a tool result in this session, ideally a query_inventory count. Never count a list by hand; if you list items, make the stated total match a query. When a list and a total disagree, re-query.
- When a question is answered, call record_finding with a concise markdown answer and the file ids that support it. Keep answers skimmable: short lead sentence, then bullets with counts and paths.
- After extraction, questions about content (what a procedure says, who said what in an interview, what an email thread decided, what a video shows) go through search_evidence, then get_evidence or email_thread for context. Cite every statement with the citation the tool returns (file, page/section/rows, or timestamp and speaker), and say whether the evidence is a document, an email, an interview statement or a visual reading. Interview statements and old documents are evidence, not truth: note when sources disagree or are dated.
- Email addresses carry candidate signals (internal, old domain, shared mailbox, possibly former, likely aliases). Treat them as leads to verify, not facts.
- If evidence is missing or ambiguous, say so plainly rather than guessing; "unknown" is a valid finding.
- Never invent file ids. Never use outside knowledge about this company.

Showing your work:
- Before a batch of tool calls, say in one short sentence what you are checking and why.
- When numbers compare or distribute (files per source, rows per system, records per year), call render_chart with numbers you obtained from tools.
- When structure matters (which systems feed which, what replaced what and when), include a mermaid diagram in a \`\`\`mermaid code block (flowchart or timeline). Keep diagrams small and label edges with evidence-backed facts.`

export function anthropic(): Anthropic {
  assertApiAllowed()
  const env = readEnv(['ANTHROPIC_API_KEY'] as const)
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set (add it to .env)')
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
}

/**
 * Runs one user turn: streams the model as AI SDK UI chunks, executes tool
 * calls, persists every message and step, and loops until the model ends its turn.
 */
export async function runTurn(p: { tenantId: string; sessionId: string; userText: string; write: (chunk: WorkbenchChunk) => void }): Promise<void> {
  const db = pool()
  const client = anthropic()

  const history = (
    await db.query<{ role: 'user' | 'assistant'; content: Anthropic.Beta.BetaContentBlockParam[] }>(
      `select role, content from public.workbench_messages where session_id = $1 order by ordinal`,
      [p.sessionId],
    )
  ).rows
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.content }))

  let ordinal = history.length
  const turn = history.filter((m) => m.role === 'user' && !m.content.some((b) => b.type === 'tool_result')).length + 1
  let stepOrdinal = Number((await db.query<{ n: number }>(`select coalesce(max(ordinal), 0)::int n from public.workbench_steps where session_id = $1`, [p.sessionId])).rows[0].n)

  const append = async (role: 'user' | 'assistant', content: Anthropic.Beta.BetaContentBlockParam[], extra: { usage?: unknown; stop_reason?: string | null } = {}) => {
    messages.push({ role, content })
    await db.query(
      `insert into public.workbench_messages (tenant_id, session_id, ordinal, role, content, usage, stop_reason) values ($1, $2, $3, $4, $5, $6, $7)`,
      [p.tenantId, p.sessionId, ordinal++, role, JSON.stringify(content), extra.usage ? JSON.stringify(extra.usage) : null, extra.stop_reason ?? null],
    )
  }

  await append('user', [{ type: 'text', text: p.userText }])
  if (history.length === 0) {
    const title = p.userText.slice(0, 80)
    await db.query(`update public.workbench_sessions set title = $2, model = $3 where id = $1`, [p.sessionId, title, MODEL])
    p.write({ type: 'data-session', data: { id: p.sessionId, title }, transient: true })
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    p.write({ type: 'start-step' })
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
    })

    // Map Anthropic content blocks to AI SDK UI parts as they stream.
    const blockIds = new Map<number, { id: string; kind: 'text' | 'reasoning' | 'tool' }>()
    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start') {
        const b = event.content_block
        if (b.type === 'thinking') {
          const id = `r-${round}-${event.index}`
          blockIds.set(event.index, { id, kind: 'reasoning' })
          p.write({ type: 'reasoning-start', id })
        } else if (b.type === 'text') {
          const id = `t-${round}-${event.index}`
          blockIds.set(event.index, { id, kind: 'text' })
          p.write({ type: 'text-start', id })
        } else if (b.type === 'tool_use') {
          blockIds.set(event.index, { id: b.id, kind: 'tool' })
          p.write({ type: 'tool-input-start', toolCallId: b.id, toolName: b.name, dynamic: true })
        }
      } else if (event.type === 'content_block_delta') {
        const block = blockIds.get(event.index)
        if (!block) return
        if (event.delta.type === 'thinking_delta') p.write({ type: 'reasoning-delta', id: block.id, delta: event.delta.thinking })
        else if (event.delta.type === 'text_delta') p.write({ type: 'text-delta', id: block.id, delta: event.delta.text })
      } else if (event.type === 'content_block_stop') {
        const block = blockIds.get(event.index)
        if (block?.kind === 'reasoning') p.write({ type: 'reasoning-end', id: block.id })
        else if (block?.kind === 'text') p.write({ type: 'text-end', id: block.id })
      }
    })
    const message = await stream.finalMessage()

    // Append-only: the assistant content goes back exactly as received (thinking blocks included).
    await append('assistant', message.content as Anthropic.Beta.BetaContentBlockParam[], { usage: message.usage, stop_reason: message.stop_reason })

    if (message.stop_reason === 'refusal') {
      p.write({ type: 'error', errorText: 'The model declined this request.' })
      p.write({ type: 'finish-step' })
      break
    }
    if (message.stop_reason === 'pause_turn') {
      p.write({ type: 'finish-step' })
      continue
    }
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) {
      p.write({ type: 'finish-step' })
      break
    }
    if (message.stop_reason === 'max_tokens') {
      p.write({ type: 'error', errorText: 'Output limit reached mid tool call; ask me to continue.' })
      p.write({ type: 'finish-step' })
      break
    }

    // Run this round's tool calls concurrently; return all results in one user message.
    const results = await Promise.all(
      toolUses.map(async (use): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const t = findTool(use.name)
        const parsed = t?.schema.safeParse(use.input)
        const stepId = crypto.randomUUID()
        const ordinalForStep = ++stepOrdinal
        const summary = t && parsed?.success ? t.summarize(parsed.data as never) : use.name
        const started = Date.now()
        await db.query(
          `insert into public.workbench_steps (id, tenant_id, session_id, turn, ordinal, kind, tool_name, tool_use_id, input, summary, status)
           values ($1, $2, $3, $4, $5, 'tool_call', $6, $7, $8, $9, 'running')`,
          [stepId, p.tenantId, p.sessionId, turn, ordinalForStep, use.name, use.id, JSON.stringify(use.input), summary],
        )
        p.write({ type: 'tool-input-available', toolCallId: use.id, toolName: use.name, input: use.input, dynamic: true })

        let output: unknown
        let errorText: string | undefined
        if (!t) errorText = `unknown tool ${use.name}`
        else if (!parsed!.success) errorText = `invalid input: ${parsed!.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        else {
          try {
            output = await t.run(parsed!.data as never, { tenantId: p.tenantId, sessionId: p.sessionId })
          } catch (error) {
            errorText = (error as Error).message
          }
        }
        const duration = Date.now() - started
        const finalSummary = (!errorText && t?.summarizeResult?.(parsed!.data as never, output)) || summary
        const serialized = errorText ? JSON.stringify({ error: errorText }) : JSON.stringify(output)
        await db.query(
          `update public.workbench_steps set output = $2, status = $3, summary = $4, finished_at = now() where id = $1`,
          [stepId, serialized.length > 200_000 ? JSON.stringify({ truncated: serialized.slice(0, 200_000) }) : serialized, errorText ? 'error' : 'ok', finalSummary],
        )

        if (errorText) p.write({ type: 'tool-output-error', toolCallId: use.id, errorText, dynamic: true })
        else p.write({ type: 'tool-output-available', toolCallId: use.id, output: toolOutputView(use.name, output, finalSummary, duration), dynamic: true })
        if (!errorText && use.name === 'record_finding') {
          p.write({ type: 'data-finding', data: { question_id: (parsed!.data as { question_id: string }).question_id }, transient: true })
        }

        return {
          type: 'tool_result',
          tool_use_id: use.id,
          content: serialized.length > 60_000 ? `${serialized.slice(0, 60_000)}… (truncated)` : serialized,
          is_error: errorText ? true : undefined,
        }
      }),
    )
    await append('user', results)
    p.write({ type: 'finish-step' })
  }

  await db.query(`update public.workbench_sessions set updated_at = now() where id = $1`, [p.sessionId])
}
