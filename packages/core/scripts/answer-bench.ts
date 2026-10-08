// Benchmark: which model should write Company Brain's answers?
//
//   COMPANY_BRAIN_ALLOW_API=1 npx tsx scripts/answer-bench.ts <slug> [--limit N] [--only model,model]
//
// Every question gets ONE evidence pack (the same Elasticsearch retrieval + facts + history the
// product uses). Each contender writes an answer from that pack only; the deterministic "brief"
// (no model) is the baseline. Two judges from different vendors grade every answer blind against
// the eval's key points: key points covered, claims the sources don't support, wrong citations.
// Results are cached per (question, contender) so a re-run only does what's missing.

import Anthropic from '@anthropic-ai/sdk'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { buildContext, type ContextPack } from '../src/answer/answer'
import { briefAnswer } from '../src/answer/brief'
import { readEnv } from '../src/env'
import { pool } from '../src/workbench/server'

const args = process.argv.slice(2)
const flag = (k: string) => {
  const i = args.indexOf(k)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const limit = Number(flag('--limit') ?? 999)
const only = flag('--only')?.split(',')
const [slug = 'riverton'] = args
if (process.env.COMPANY_BRAIN_ALLOW_API !== '1') throw new Error('This spends API credit: run with COMPANY_BRAIN_ALLOW_API=1')

const env = readEnv(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const)
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
const ROOT = new URL('../../../', import.meta.url).pathname
const OUT = `${ROOT}evals/${slug}/answer-bench-v1.json`

// ---------------------------------------------------------------------------- contenders

type Usage = { input: number; output: number }
type Written = { text: string; usage: Usage; ms: number }

const SYSTEM = `You answer questions about a company for the people who now run it, using ONLY the material in the user message (facts, their history, and numbered sources). Rules:
- Lead with the direct answer in one or two sentences. Then the details that matter (dates, amounts, exceptions, who).
- When something changed over time, say what it is now and what it was before, with dates.
- If the question asks about a past date, answer for that date and mention what it is now.
- Cite sources inline as [n] after the sentence they support. Never cite a source that doesn't say it.
- If the material doesn't answer the question, say so plainly and say what is missing. Never use outside knowledge or guess.
- If sources disagree, say so and show both.
- Plain prose, no headings, at most ~180 words.
- Never use em dashes. Use commas, colons, periods or parentheses instead.`

/** Stricter variant: no inference, no background, no arithmetic the sources don't do. */
export const STRICT = `${SYSTEM}
- State only what a source says. Do not infer, extrapolate, connect facts into new conclusions, do arithmetic, or add background the sources don't state.
- Every sentence with a fact ends with its citation. If you can't cite it, leave it out.
- Quote numbers, dates and names exactly as the sources give them.`

async function viaClaude(model: string, user: string, effort?: 'low' | 'medium', system = SYSTEM): Promise<Written> {
  const t0 = performance.now()
  const res = await anthropic.messages.create({
    model,
    max_tokens: 1500,
    system,
    ...(effort ? { output_config: { effort } } : {}),
    messages: [{ role: 'user', content: user }],
  } as Anthropic.MessageCreateParamsNonStreaming)
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n')
  return { text, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens }, ms: Math.round(performance.now() - t0) }
}

async function viaOpenAI(model: string, user: string): Promise<Written> {
  const t0 = performance.now()
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_completion_tokens: 4000, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }),
  })
  const d = (await r.json()) as { choices?: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number }; error?: { message: string } }
  if (!d.choices) throw new Error(`${model}: ${d.error?.message ?? r.status}`)
  return { text: d.choices[0].message.content ?? '', usage: { input: d.usage?.prompt_tokens ?? 0, output: d.usage?.completion_tokens ?? 0 }, ms: Math.round(performance.now() - t0) }
}

const ALL: { key: string; label: string; write: (user: string) => Promise<Written> }[] = [
  { key: 'claude-opus-5-5', label: 'Claude Opus 5.5', write: (u) => viaClaude('claude-opus-5-5', u, 'low') },
  { key: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', write: (u) => viaClaude('claude-sonnet-5-5', u, 'low') },
  { key: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', write: (u) => viaClaude('claude-haiku-4-5-20251001', u) },
  { key: 'claude-sonnet-5-5-strict', label: 'Claude Sonnet 5.5 (strict prompt)', write: (u) => viaClaude('claude-sonnet-5-5', u, 'low', STRICT) },
  { key: 'gpt-6.1-sol', label: 'GPT-6.1 sol', write: (u) => viaOpenAI('gpt-6.1-sol', u) },
  { key: 'gpt-6-luna', label: 'GPT-6 luna', write: (u) => viaOpenAI('gpt-6-luna', u) },
]
const CONTENDERS = ALL.filter((c) => !only || only.includes(c.key))

// ---------------------------------------------------------------------------- judging

interface Grade {
  key_points: { point: string; hit: boolean }[]
  unsupported_claims: string[]
  citation_errors: number
  notes: string
}
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key_points', 'unsupported_claims', 'citation_errors', 'notes'],
  properties: {
    key_points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['point', 'hit'], properties: { point: { type: 'string' }, hit: { type: 'boolean' } } } },
    unsupported_claims: { type: 'array', items: { type: 'string' } },
    citation_errors: { type: 'integer' },
    notes: { type: 'string' },
  },
}
const judgePrompt = (q: Item, sourcesText: string, answer: string) => `Grade one answer to a question about a company. Be strict and literal.

QUESTION: ${q.question}
EXPECTED ANSWER (reference): ${q.expected_answer}
KEY POINTS (each must be clearly stated or unambiguously implied to count as hit):
${q.key_points.map((k, i) => `${i + 1}. ${k}`).join('\n')}

SOURCES THE ANSWERER HAD (the only allowed evidence):
${sourcesText}

ANSWER TO GRADE:
${answer || '(empty)'}

Return:
- key_points: for each key point above (same order, same text), hit true/false.
- unsupported_claims: factual statements in the answer that the SOURCES do not support (wrong numbers, dates, names, invented details). Do not count claims that match the reference answer if the sources support them. Phrasing differences are fine.
- citation_errors: number of [n] citations that point to a source that doesn't support the sentence, or to a number that doesn't exist.
- notes: one short sentence.`

async function judgeClaude(prompt: string): Promise<Grade> {
  const res = await anthropic.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 3000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  } as Anthropic.MessageCreateParamsNonStreaming)
  return JSON.parse(res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')!.text)
}
async function judgeOpenAI(prompt: string): Promise<Grade> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-6.1-sol',
      max_completion_tokens: 6000,
      response_format: { type: 'json_schema', json_schema: { name: 'grade', strict: true, schema: JUDGE_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const d = (await r.json()) as { choices?: { message: { content: string } }[]; error?: { message: string } }
  if (!d.choices) throw new Error(`judge gpt: ${d.error?.message ?? r.status}`)
  return JSON.parse(d.choices[0].message.content)
}

// ---------------------------------------------------------------------------- run

interface Item {
  id: string
  set: string
  question: string
  expected_answer: string
  key_points: string[]
}
interface Row {
  item: string
  contender: string
  answer: string
  usage: Usage
  ms: number
  grades: Record<'claude' | 'gpt', Grade | { error: string }>
}

const items: Item[] = []
for (const [set, file] of [
  ['evidence', 'evidence-derived-v1.json'],
  ['temporal', 'temporal-v1.json'],
] as const) {
  const d = JSON.parse(readFileSync(`${ROOT}evals/${slug}/${file}`, 'utf8')) as { items: (Item & { kind: string })[] }
  d.items.filter((i) => i.kind === 'question' && i.key_points?.length).forEach((i, n) => items.push({ id: `${set}:${n}`, set, question: i.question, expected_answer: i.expected_answer, key_points: i.key_points }))
}
const work = items.slice(0, limit)
const saved: { rows: Row[]; packs: Record<string, { user: string; sources: string }> } = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { rows: [], packs: {} }
const save = () => writeFileSync(OUT, JSON.stringify(saved, null, 1))

const db = pool()
const tenantId = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const ctx = { sql: db, tenantId, as: null }

async function pool4<T>(xs: T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < xs.length) await f(xs[i++])
  }))
}

console.log(`${work.length} questions × ${CONTENDERS.length} models + baseline → ${OUT}`)

// 1. One evidence pack per question (shared by every model), plus the no-AI baseline.
await pool4(work, 3, async (q) => {
  if (!saved.packs[q.id]) {
    const pack: ContextPack = await buildContext(db, tenantId, q.question)
    saved.packs[q.id] = { user: pack.prompt.user, sources: pack.sources.map((s) => `[${s.n}] ${s.title}, ${s.where} (${s.label})\n${s.text}`).join('\n\n') }
  }
  if (!saved.rows.find((r) => r.item === q.id && r.contender === 'baseline')) {
    const t0 = performance.now()
    const b = await briefAnswer(ctx, q.question)
    const text = [b.headline ?? (b.sources[0] ? `Found in ${b.sources[0].title}.` : 'Nothing on record answers this.'), b.detail, b.timeline ? `History: ${b.timeline.map((s) => `${s.value} (${s.when})`).join(' → ')}` : '', b.changed, ...b.also.map((a) => `${a.text} [${a.cites.join('][')}]`)]
      .filter(Boolean)
      .join('\n')
    const sources = b.sources.map((s) => `[${s.n}] ${s.title}, ${s.where}${s.quote ? `\n${s.quote}` : ''}`).join('\n\n')
    saved.rows.push({ item: q.id, contender: 'baseline', answer: `${text}\n[sources]\n${sources}`, usage: { input: 0, output: 0 }, ms: Math.round(performance.now() - t0), grades: {} as Row['grades'] })
  }
  process.stdout.write('.')
})
save()
console.log('\npacks ready')

// 2. Every contender writes every answer.
const jobs = work.flatMap((q) => CONTENDERS.map((c) => ({ q, c })))
await pool4(jobs, 6, async ({ q, c }) => {
  if (saved.rows.find((r) => r.item === q.id && r.contender === c.key)) return
  try {
    const w = await c.write(saved.packs[q.id].user)
    saved.rows.push({ item: q.id, contender: c.key, answer: w.text, usage: w.usage, ms: w.ms, grades: {} as Row['grades'] })
    process.stdout.write('+')
  } catch (e) {
    console.log(`\n✗ ${c.key} on ${q.id}: ${(e as Error).message}`)
  }
  if (saved.rows.length % 10 === 0) save()
})
save()
console.log('\nanswers written')

// 3. Two blind judges grade every answer.
const toGrade = saved.rows.filter((r) => work.some((q) => q.id === r.item) && (!r.grades.claude || 'error' in r.grades.claude || !r.grades.gpt || 'error' in r.grades.gpt))
await pool4(toGrade, 6, async (r) => {
  const q = work.find((x) => x.id === r.item)!
  const [answer, own] = r.contender === 'baseline' ? r.answer.split('\n[sources]\n') : [r.answer, null]
  const prompt = judgePrompt(q, own ?? saved.packs[q.id].sources, answer)
  for (const [k, f] of [['claude', judgeClaude], ['gpt', judgeOpenAI]] as const) {
    if (r.grades[k] && !('error' in r.grades[k])) continue
    r.grades[k] = await f(prompt).catch((e) => ({ error: (e as Error).message }))
  }
  process.stdout.write('✓')
  if (Math.random() < 0.1) save()
})
save()

// 4. Scoreboard.
const PRICE: Record<string, [number, number]> = {
  // $ per million tokens (input, output), list prices at time of writing; edit if they change.
  'claude-opus-5-5': [5, 25],
  'claude-sonnet-5-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
}
console.log('\n\ncontender            key points   unsupported/ans   bad cites/ans   p50 latency   tokens in/out per ans   est $/answer')
for (const key of ['baseline', ...CONTENDERS.map((c) => c.key)]) {
  const rows = saved.rows.filter((r) => r.contender === key && work.some((q) => q.id === r.item))
  if (!rows.length) continue
  const gs = rows.flatMap((r) => (['claude', 'gpt'] as const).map((k) => r.grades[k]).filter((g): g is Grade => !!g && !('error' in g)))
  const kp = gs.flatMap((g) => g.key_points)
  const hit = kp.length ? kp.filter((k) => k.hit).length / kp.length : 0
  const unsup = gs.length ? gs.reduce((n, g) => n + g.unsupported_claims.length, 0) / gs.length : 0
  const cites = gs.length ? gs.reduce((n, g) => n + g.citation_errors, 0) / gs.length : 0
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
  const tin = rows.reduce((n, r) => n + r.usage.input, 0) / rows.length
  const tout = rows.reduce((n, r) => n + r.usage.output, 0) / rows.length
  const price = PRICE[key]
  console.log(
    `${key.padEnd(20)} ${(hit * 100).toFixed(0).padStart(6)}%   ${unsup.toFixed(2).padStart(10)}   ${cites.toFixed(2).padStart(12)}   ${(ms / 1000).toFixed(1).padStart(9)} s   ${`${Math.round(tin)}/${Math.round(tout)}`.padStart(16)}   ${price ? `$${((tin * price[0] + tout * price[1]) / 1e6).toFixed(4)}` : key === 'baseline' ? '$0' : 'see OpenAI pricing'}`,
  )
}
await db.end()
