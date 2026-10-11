// A model reranker for the head of the list. The cross-encoder (ms-marco, trained on web search) reads
// company language poorly: it scored the chat line "so we got sold" as irrelevant to "Is Riverton being
// sold?" and sometimes pushes the right document from #1 to #15. A small model that is told what the
// question's names mean scores the top candidates 0 to 3 for how well each answers the question; the
// head is re-ordered by that score (ties keep their order). Deterministic (temperature 0).
//
// Off unless asked for and answers are allowed (same approved API as rewriting). Any failure or a
// slow reply keeps the order as it was.

import { answersAllowed, claudeForAnswers } from '../claude'
import { type Dictionary, linkText } from './linker'
import { REWRITE_MODEL } from './rewrite'

const TIMEOUT_MS = Number(process.env.CB_MODEL_TIMEOUT_MS ?? 4000)
/** Calls made and calls that kept the old order (failure, timeout, unreadable reply), for dev checks. */
export const rerankStats = { calls: 0, fallbacks: 0 }
export const LLM_RERANK_HEAD = 20

const SYSTEM = `You judge search results for a question asked inside a company. For each numbered result, score how well it helps answer the question:
3 = directly answers it or is the source that states the answer
2 = clearly about the same thing and useful evidence
1 = loosely related
0 = not about it
Read company language generously: chat messages, nicknames, internal codes and informal speech count when they say the thing asked.
Output only a JSON array of the scores, one per result in order, for example [3,0,1,2]. No explanation.`

export interface Candidate {
  title: string
  content: string
}

/** Scores (0–3) for the candidates, in order, or null when off, unavailable or too slow. */
export async function llmScores(dict: Dictionary, question: string, candidates: Candidate[]): Promise<number[] | null> {
  if (!answersAllowed() || !candidates.length) return null
  const names = linkText(dict, question)
    .filter((e) => e.matched.toLowerCase() !== e.name.toLowerCase())
    .map((e) => `"${e.matched}" = ${e.name} (${e.type})`)
  const list = candidates.map((c, i) => `[${i + 1}] ${c.title}\n${c.content.replace(/\s+/g, ' ').slice(0, 420)}`).join('\n\n')
  const user = `Question: ${question}${names.length ? `\nNames in the question: ${names.join('; ')}.` : ''}\n\nResults:\n${list}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const msg = await claudeForAnswers().messages.create(
      { model: REWRITE_MODEL, max_tokens: 4 * candidates.length + 20, temperature: 0, system: SYSTEM, messages: [{ role: 'user', content: user }] },
      { signal: ac.signal },
    )
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const arr = text.match(/\[[\d,\s]*\]/)?.[0]
    const scores = arr ? (JSON.parse(arr) as number[]) : []
    const ok = scores.length === candidates.length && scores.every((x) => x >= 0 && x <= 3)
    rerankStats.calls++
    if (!ok) rerankStats.fallbacks++
    return ok ? scores : null
  } catch {
    rerankStats.calls++
    rerankStats.fallbacks++
    return null
  } finally {
    clearTimeout(timer)
  }
}
