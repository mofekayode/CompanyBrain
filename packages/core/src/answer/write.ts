// Writing the answer with a language model, streamed word by word. The model gets the same
// evidence pack the product shows (facts, their history, numbered sources) and must cite [n].
// Which model is configurable (COMPANY_BRAIN_ANSWER_MODEL); calls only happen when the API is
// switched on (COMPANY_BRAIN_ALLOW_ANSWER_API=1, or the general COMPANY_BRAIN_ALLOW_API=1).

import type Anthropic from '@anthropic-ai/sdk'
import { answersAllowed, claudeForAnswers } from '../claude'
import { readEnv } from '../env'
import { tidy } from '../text'
import type { ContextPack } from './answer'

/**
 * Picked by benchmark (scripts/answer-bench.ts → evals/<slug>/answer-bench-v1.json, 2026-10-07):
 * Sonnet 5.5 with the strict prompt covered 81% of key points with 0.40 unsupported claims and
 * 0.13 bad citations per answer, first word in ~0.6 s. GPT-6.1 sol was slightly more faithful
 * (0.23 / 0.10) but takes 3 to 9 s to start writing.
 */
export const DEFAULT_ANSWER_MODEL = 'claude-sonnet-5-5'

export const WRITE_SYSTEM = `You answer questions about a company for the people who now run it, using ONLY the material in the user message (facts, their history, and numbered sources).

Write two parts:
1. The direct answer: at most three short sentences (about 50 words). Say what is true now (or on the date asked), with the key numbers, names and dates. Cite each sentence with [n].
2. A line containing only ---
3. Then the supporting detail, at most about 120 words: what it was before and when it changed, exceptions, caveats, where sources disagree. Cite each sentence with [n].

Rules:
- State only what a source says. Do not infer, extrapolate, connect facts into new conclusions, do arithmetic, or add background the sources don't state.
- Every sentence with a fact ends with its citation. If you can't cite it, leave it out.
- Quote numbers and names exactly as the sources give them. Write dates the way people say them (Oct 19, 2026 or Oct 2026), never as 2026-10-19.
- If the material doesn't answer the question, the direct answer says so in one sentence and nothing else is invented.
- Plain prose, no headings, no lists.
- Never use em dashes. Use commas, colons, periods or parentheses instead.`

export function answerModel(): string {
  return process.env.COMPANY_BRAIN_ANSWER_MODEL ?? readEnv(['COMPANY_BRAIN_ANSWER_MODEL'] as const).COMPANY_BRAIN_ANSWER_MODEL ?? DEFAULT_ANSWER_MODEL
}

export interface Written {
  text: string
  model: string
  usage: { input: number; output: number }
  ms: number
}

/** Streams the answer; onDelta gets each new piece of text. Returns null when the API is off. */
export async function writeAnswer(pack: ContextPack, onDelta: (text: string) => void, opts: { model?: string; signal?: AbortSignal; restricted?: boolean } = {}): Promise<Written | null> {
  if (!answersAllowed()) return null
  const model = opts.model ?? answerModel()
  const t0 = performance.now()
  // Some sources this reader can't open may matter. Never let the answer imply the information doesn't exist.
  const user = opts.restricted
    ? `${pack.prompt.user}\n\nNote: some sources this person cannot open may be relevant. If the material above doesn't answer the question, the direct answer must be exactly: "I can't answer that from the information you have access to." Never say or imply the information doesn't exist, and never guess what the restricted sources contain.`
    : pack.prompt.user
  if (model.startsWith('claude')) {
    const stream = claudeForAnswers().messages.stream(
      {
        model,
        max_tokens: 1500,
        system: WRITE_SYSTEM,
        ...(/opus|sonnet/.test(model) ? { output_config: { effort: 'low' } } : {}),
        messages: [{ role: 'user', content: user }],
      } as Anthropic.MessageStreamParams,
      { signal: opts.signal },
    )
    stream.on('text', (t) => onDelta(t))
    const msg = await stream.finalMessage()
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('')
    return { text: tidy(text), model, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens }, ms: Math.round(performance.now() - t0) }
  }
  // OpenAI (chat completions, streamed).
  const { OPENAI_API_KEY } = readEnv(['OPENAI_API_KEY'] as const)
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: opts.signal,
    headers: { authorization: `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 4000, messages: [{ role: 'system', content: WRITE_SYSTEM }, { role: 'user', content: user }] }),
  })
  if (!res.ok || !res.body) throw new Error(`${model}: ${res.status} ${await res.text()}`)
  let text = ''
  let usage = { input: 0, output: 0 }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      if (!l.startsWith('data: ') || l === 'data: [DONE]') continue
      const d = JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } }
      const t = d.choices?.[0]?.delta?.content
      if (t) {
        text += t
        onDelta(t)
      }
      if (d.usage) usage = { input: d.usage.prompt_tokens, output: d.usage.completion_tokens }
    }
  }
  return { text: tidy(text), model, usage, ms: Math.round(performance.now() - t0) }
}
