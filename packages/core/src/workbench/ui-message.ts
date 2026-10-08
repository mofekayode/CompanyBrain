import type { UIMessage } from 'ai'

/** Data parts the workbench streams alongside text/reasoning/tool parts. */
export type WorkbenchDataTypes = {
  session: { id: string; title: string }
  finding: { question_id: string }
}

export type WorkbenchUIMessage = UIMessage<never, WorkbenchDataTypes>

/** What the UI receives as a tool part's output (same shape live and on replay). */
export interface ToolOutputView {
  summary: string
  duration_ms: number | null
  /** Truncated JSON for display; the full result stays in workbench_steps. */
  preview: string
  /** Full output for tools whose result IS the display (charts). */
  full?: unknown
}

const FULL_OUTPUT_TOOLS = new Set(['render_chart'])

export function toolOutputView(toolName: string, output: unknown, summary: string, durationMs: number | null, maxChars = 4000): ToolOutputView {
  const serialized = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
  return {
    summary,
    duration_ms: durationMs,
    preview: serialized.length > maxChars ? `${serialized.slice(0, maxChars)}\n… (truncated)` : serialized,
    ...(FULL_OUTPUT_TOOLS.has(toolName) ? { full: output } : {}),
  }
}
