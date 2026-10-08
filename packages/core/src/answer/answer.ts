// Answers (Phases 18–19).
//
// Standard RAG, buildContext → answer:
//   question → understand (entities, aliases, time) → retrieve (hybrid, access-filtered)
//   → canonical facts of the entities (current + history) → numbered sources → LLM → cited answer
//
// Agentic, answerWithAgent: the model gets the tools in ./tools.ts and investigates
// (resolve "Pump 17" → timeline → technician notes → video → later failures) before answering.
//
// Both call the Claude API only when it is switched on (COMPANY_BRAIN_ALLOW_API=1).
// With it off, buildContext still works: a Claude Code session reads the same context
// pack and writes the answer, and the eval records it as such.

import Anthropic from '@anthropic-ai/sdk'
import { apiAllowed, claude, PIPELINE_MODEL, structured } from '../claude'
import { search, type SearchResult } from '../search/search'
import type { Sql } from '../storage/raw'
import { humanDate, humanPeriod } from '../text'
import { citeLabel, factLabel, getCurrentFacts, getFactHistory, runTool, TOOL_SPECS, type ToolCtx } from './tools'

export interface Source {
  n: number
  id: string
  type: 'passage' | 'entity' | 'fact'
  title: string
  where: string
  label: 'Current' | 'Outdated' | 'Disputed' | 'Supports'
  text: string
  /** For opening the cited file in place. */
  kind: string
  path: string | null
  file_id: string | null
  start_ms: number | null
}

export interface ContextPack {
  question: string
  as: string | null
  understood: { entities: string[]; as_of: string | null }
  facts: { entity: string; current: string[]; history: string[] }[]
  sources: Source[]
  prompt: { system: string; user: string }
  ms: number
}

export const ANSWER_SYSTEM = `You answer questions about a company from its own records, for someone who now runs it.
Rules:
- Use only the facts and numbered sources given. Cite every claim with [n]. Never invent names, numbers or dates.
- Prefer current facts. When the answer changed over time, always call it out in one short line:
  "<now> since <date>, it was <before> until then." For a question about the past, answer for that date and add what it is now.
- Never present an Outdated source as current.
- When sources disagree, say so and say which source is stronger (signed document > system record > email > interview).
- If the sources do not answer the question, say "I can't find this in the records you can see" and stop. Do not guess.
- Lead with the direct answer in one sentence, then the supporting detail. Keep it short.
- Never use em dashes. Use commas, colons, periods or parentheses instead.`

export async function buildContext(sql: Sql, tenantId: string, question: string, opts: { as?: string | null; asOf?: string; limit?: number; prefetched?: SearchResult } = {}): Promise<ContextPack> {
  const t0 = performance.now()
  const ctx: ToolCtx = { sql, tenantId, as: opts.as ?? null }
  // Answers get the reranked list: 40/41 retrieval checks vs 37/41 without, for ~1 s more.
  const r = opts.prefetched ?? (await search(sql, tenantId, question, { as: opts.as, asOf: opts.asOf, limit: opts.limit ?? 12, rerank: true }))

  // Facts about the entities the question names (visible to this reader only).
  const facts: ContextPack['facts'] = []
  const ents = r.understood.entities.filter((e) => e.type !== 'Term').slice(0, 3)
  const loaded = await Promise.all(ents.map(async (e) => [await getCurrentFacts(ctx, { entity: e.id }), await getFactHistory(ctx, { entity: e.id })] as const))
  for (const [k, e] of ents.entries()) {
    const [cur, hist] = loaded[k]
    if ('error' in cur || 'error' in hist) continue
    const old = hist.history.filter((h) => h.status === 'superseded' || (h.to && h.to < new Date().toISOString().slice(0, 10)))
    facts.push({
      entity: `${e.name} (${e.type})`,
      current: cur.facts.slice(0, 25).map((f) => `${f.fact}${f.since ? ` (since ${humanDate(f.since)})` : ''}${f.status === 'disputed' ? ' [DISPUTED]' : ''}`),
      history: old.slice(0, 15).map((h) => `${h.fact} (${humanPeriod(h.from, h.to) || 'dates unknown'})`),
    })
  }

  const sources: Source[] = r.hits.map((h, i) => ({
    n: i + 1,
    id: h.id,
    type: h.doc_type,
    title: h.title,
    where: h.doc_type === 'fact' ? factLabel(h) : citeLabel(h.path, h.citation),
    label: h.doc_type === 'fact' ? (h.citation.status === 'disputed' ? 'Disputed' : h.is_current ? 'Current' : 'Outdated') : 'Supports',
    text: h.content.slice(0, 900),
    kind: h.kind,
    path: h.path,
    file_id: h.source_object_id ?? null,
    start_ms: h.citation.start_ms != null ? Number(h.citation.start_ms) : null,
  }))
  // Every source with a history becomes a "what changed" line, so the answer can say "it was X before".
  const changes = [
    ...new Set(
      r.hits.flatMap((h, i) => {
        const line = h.content.split('\n').find((l) => l.startsWith('Timeline: '))
        if (line) return [`${h.title}: ${line.slice(10)}`]
        if (h.kind === 'timeline' && i < 3) return [h.content.split('\n').slice(0, 8).join(' | ')]
        return []
      }),
    ),
  ]
  const user = [
    `Question: ${question}`,
    r.understood.time.reading ? `Time in the question: ${r.understood.time.reading}${r.understood.asOf ? ` → facts as of ${r.understood.asOf}` : ''}` : '',
    changes.length ? `\nWhat changed (oldest → newest):\n${changes.map((c) => `- ${c}`).join('\n')}` : '',
    facts.length
      ? `\nKnown facts about the entities in the question:\n${facts
          .map((f) => `## ${f.entity}\nCurrent:\n${f.current.map((c) => `- ${c}`).join('\n') || '- (none recorded)'}${f.history.length ? `\nEarlier:\n${f.history.map((c) => `- ${c}`).join('\n')}` : ''}`)
          .join('\n')}`
      : '',
    `\nSources:\n${sources.map((s) => `[${s.n}] ${s.title} · ${s.where} (${s.label})\n${s.text}`).join('\n\n')}`,
  ].join('\n')
  return {
    question,
    as: opts.as ?? null,
    understood: { entities: r.understood.entities.map((e) => `${e.name} (${e.type})`), as_of: r.understood.asOf },
    facts,
    sources,
    prompt: { system: ANSWER_SYSTEM, user },
    ms: Math.round(performance.now() - t0),
  }
}

export interface Answer {
  answer: string
  confidence: 'high' | 'medium' | 'low' | 'not_found'
  citations: number[]
  answered_by: string
}

/** Standard RAG answer. With the Claude API off, returns the context pack only. */
export async function answer(sql: Sql, tenantId: string, question: string, opts: { as?: string | null; asOf?: string } = {}): Promise<{ context: ContextPack; answer: Answer | null; note?: string }> {
  const context = await buildContext(sql, tenantId, question, opts)
  if (!apiAllowed()) return { context, answer: null, note: 'Claude API is off: context only (answer it in a Claude Code session).' }
  const out = await structured<Omit<Answer, 'answered_by'>>({
    system: context.prompt.system,
    prompt: context.prompt.user,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['answer', 'confidence', 'citations'],
      properties: { answer: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'not_found'] }, citations: { type: 'array', items: { type: 'integer' } } },
    },
    effort: 'low',
    maxTokens: 2000,
  })
  return { context, answer: { ...out, answered_by: PIPELINE_MODEL } }
}

/** Agentic answer: the model investigates with the company tools, then answers with citations. */
export async function answerWithAgent(sql: Sql, tenantId: string, question: string, opts: { as?: string | null; maxSteps?: number } = {}) {
  const ctx: ToolCtx = { sql, tenantId, as: opts.as ?? null }
  const client = claude() // throws when the API is off
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }]
  const steps: { tool: string; input: unknown }[] = []
  for (let i = 0; i < (opts.maxSteps ?? 12); i++) {
    const res = await client.messages.create({
      model: PIPELINE_MODEL,
      max_tokens: 4000,
      system: `${ANSWER_SYSTEM}\nInvestigate with the tools before answering: resolve names, check current facts and history, read the evidence. Cite tool results as [tool:id] or by file and page/time.`,
      tools: TOOL_SPECS as unknown as Anthropic.Tool[],
      messages,
    })
    messages.push({ role: 'assistant', content: res.content })
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (!calls.length) return { answer: res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n'), steps }
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const c of calls) {
      steps.push({ tool: c.name, input: c.input })
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(await runTool(ctx, c.name, c.input as Record<string, unknown>)).slice(0, 30_000) })
    }
    messages.push({ role: 'user', content: results })
  }
  return { answer: null, steps, note: 'step limit reached' }
}
