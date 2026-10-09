// Question rewriting: people ask about their situation ("a tech's tools got stolen from the van, are
// we covered?"); documents use their own words ("inland marine coverage, tools and equipment in
// transit"). A small model turns the question into the words company documents would use, grounded in
// what our own name matcher already knows ("Lunken" = Lunken Aerospace Components, a customer).
// Search then runs on the original question plus the rewrite, so a poor rewrite can't lose what the
// original would have found.
//
// Measured on the phrasing-robustness set (evals/<slug>/robustness-dev-v1.json, bge-base index):
// 108/120 right file in the top 10 without rewriting, 113/120 with it (situation-style questions
// 17/24 → 21/24), about 0.6 s and ~140 input / ~13 output tokens per question.
//
// Off unless the caller asks for it and written answers are allowed (COMPANY_BRAIN_ALLOW_ANSWER_API):
// it uses the same approved API, and dev scripts never spend by accident. Any failure or a slow reply
// falls back to the original question.

import { answersAllowed, claudeForAnswers } from '../claude'
import type { Sql } from '../storage/raw'
import { type Dictionary, linkText } from './linker'

export const REWRITE_MODEL = process.env.COMPANY_BRAIN_REWRITE_MODEL ?? 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = 2000

const SYSTEM =
  "You turn a question from someone at a company into a search query for that company's own documents (policies, contracts, procedures, emails, spreadsheets, insurance, vendor agreements). Use the company's own names for things you are given. Keep the question's specifics, and add the formal terms those documents would use for the situation described. Do not add the company's own name: every document has it. Never ask a question, never refuse, never explain: output only the query, under 20 words, no quotes."

const companyNames = new Map<string, string>()

/** The rewrite (the query alone), or null when off, unavailable or too slow. */
export async function rewriteQuestion(sql: Sql, tenantId: string, dict: Dictionary, question: string): Promise<string | null> {
  if (!answersAllowed() || question.trim().split(/\s+/).length < 3) return null
  if (!companyNames.has(tenantId)) companyNames.set(tenantId, (await sql.query<{ name: string }>(`select name from public.tenants where id = $1`, [tenantId])).rows[0]?.name ?? '')
  const names = linkText(dict, question).map((e) => `"${e.matched}" = ${e.name} (${e.type})`)
  const user = `Company: ${companyNames.get(tenantId)}.${names.length ? ` Names in the question: ${names.join('; ')}.` : ''}\nQuestion: ${question}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const msg = await claudeForAnswers().messages.create({ model: REWRITE_MODEL, max_tokens: 60, system: SYSTEM, messages: [{ role: 'user', content: user }] }, { signal: ac.signal })
    const text = msg.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
      .replace(/^"|"$/g, '')
    return text && text.length < 300 ? text : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
