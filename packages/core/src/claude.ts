// Shared Claude client and a structured-output helper for pipeline steps
// (column mapping, access proposals, classification).

import Anthropic from '@anthropic-ai/sdk'
import { readEnv } from './env'

export const PIPELINE_MODEL = 'claude-opus-5-5'

/**
 * Claude API calls cost money on the client's / owner's API key. They are OFF unless
 * COMPANY_BRAIN_ALLOW_API=1 (env or .env). While off, AI steps are done in Claude Code
 * by an FDE session instead, and pipeline steps that need the API fail clearly.
 */
export function apiAllowed(): boolean {
  return (process.env.COMPANY_BRAIN_ALLOW_API ?? readEnv(['COMPANY_BRAIN_ALLOW_API'] as const).COMPANY_BRAIN_ALLOW_API) === '1'
}

export function assertApiAllowed(): void {
  if (!apiAllowed()) throw new Error('Claude API calls are disabled (no API spend). Set COMPANY_BRAIN_ALLOW_API=1 to enable them.')
}

/**
 * Written answers in the product (one short call per question) have their own switch, so they
 * can be on while the bulk pipeline steps (reading, grouping, reviews) stay off:
 * COMPANY_BRAIN_ALLOW_ANSWER_API=1. The general switch enables them too.
 */
export function answersAllowed(): boolean {
  return apiAllowed() || (process.env.COMPANY_BRAIN_ALLOW_ANSWER_API ?? readEnv(['COMPANY_BRAIN_ALLOW_ANSWER_API'] as const).COMPANY_BRAIN_ALLOW_ANSWER_API) === '1'
}

let answerClient: Anthropic | undefined
/** Claude client for written answers only (see answersAllowed). */
export function claudeForAnswers(): Anthropic {
  if (!answersAllowed()) throw new Error('Written answers are off. Set COMPANY_BRAIN_ALLOW_ANSWER_API=1 to enable them.')
  if (answerClient) return answerClient
  const env = readEnv(['ANTHROPIC_API_KEY'] as const)
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set (add it to .env)')
  answerClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  return answerClient
}

let client: Anthropic | undefined
export function claude(): Anthropic {
  assertApiAllowed()
  if (client) return client
  const env = readEnv(['ANTHROPIC_API_KEY'] as const)
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set (add it to .env)')
  client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  return client
}

/**
 * One request whose answer must match `schema` (JSON Schema). Streams so long
 * outputs don't hit request timeouts; returns the parsed object.
 */
export async function structured<T>(opts: {
  system?: string
  prompt: string
  schema: Record<string, unknown>
  effort?: 'low' | 'medium' | 'high'
  maxTokens?: number
}): Promise<T> {
  const stream = claude().messages.stream({
    model: PIPELINE_MODEL,
    max_tokens: opts.maxTokens ?? 32000,
    ...(opts.system ? { system: opts.system } : {}),
    output_config: { effort: opts.effort ?? 'medium', format: { type: 'json_schema', schema: opts.schema } },
    messages: [{ role: 'user', content: opts.prompt }],
  })
  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') throw new Error('Claude declined the request')
  if (message.stop_reason === 'max_tokens') throw new Error('Claude ran out of output tokens; split the input')
  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text
  if (!text) throw new Error('Claude returned no JSON')
  return JSON.parse(text) as T
}
