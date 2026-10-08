import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { knowledgeView, prepareView, tenantFiles } from '@companybrain/core/access/knowledge-view'
import { buildContext } from '@companybrain/core/answer/answer'
import { briefAnswer } from '@companybrain/core/answer/brief'
import type { ToolCtx } from '@companybrain/core/answer/tools'
import { answerModel, writeAnswer } from '@companybrain/core/answer/write'
import { answersAllowed } from '@companybrain/core/claude'
import { refsFor, type Ref } from '@companybrain/core/evals/contract'
import { exportOntology } from '@companybrain/core/evals/ontology-export'
import { exportComponents } from '@companybrain/core/evals/components'
import { principalFor } from '@companybrain/core/evals/roles'
import { search } from '@companybrain/core/search/search'
import { pool, tenantBySlug } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'

/**
 * The eval contract (docs/eval-contract.md): the external runner asks questions as a role or a
 * person, on a date, against a knowledge cutoff, and gets the answer, its citations and the ranked
 * candidates. Questions asked here are never stored, indexed or learned from: they go to a run log
 * outside the knowledge store (logs/eval), nothing else. Each answer is independent.
 */
export const evalContract = new Hono()

const SLUG = process.env.COMPANY_BRAIN_EVAL_TENANT ?? 'riverton'
const LOCKED = 'I can’t answer that from the information you have access to.'
const LOG_DIR = join(import.meta.dirname, '../../../../logs/eval')

interface EvalConfig {
  /** Knowledge cutoffs to prepare at startup. */
  warm_cutoffs?: string[]
  /** A role is a real person, or a profile: a set of groups (that access, nobody's personal files). */
  roles: Record<string, { person?: string; profile?: string[]; why: string }>
}
const evalConfig = (): EvalConfig => JSON.parse(readFileSync(join(import.meta.dirname, '../../../../config/tenants', SLUG, 'eval-roles.json'), 'utf8')) as EvalConfig

const tenant = async () => {
  const t = await tenantBySlug(SLUG)
  if (!t) throw new Error(`unknown eval tenant ${SLUG}`)
  return t
}

const day = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null)

evalContract.post('/eval/answer', async (c) => {
  const t0 = performance.now()
  const body = (await c.req.json()) as { question?: string; asked_on?: string; knowledge_cutoff?: string; as?: { role?: string; person?: { name?: string; email?: string } } }
  const question = body.question?.trim()
  const askedOn = day(body.asked_on)
  const cutoff = day(body.knowledge_cutoff) ?? askedOn
  if (!question || !askedOn || !cutoff) return c.json({ error: 'question, asked_on and knowledge_cutoff (YYYY-MM-DD) are required' }, 400)
  const t = await tenant()
  const who = body.as ? await principalFor(pool(), t.id, SLUG, body.as) : null
  if (body.as && !who) return c.json({ error: `no person for ${JSON.stringify(body.as)}` }, 422)

  const sql = pool()
  const view = await knowledgeView(sql, t.id, SLUG, cutoff, askedOn)
  const ctx: ToolCtx = { sql, tenantId: t.id, as: who?.id ?? null, view, today: askedOn }
  const files = await tenantFiles(sql, t.id, SLUG)

  // Ranked candidates after access and cutoff filtering, before generation.
  const [ranked, brief] = await Promise.all([search(sql, t.id, question, { as: ctx.as, limit: 50, rerank: true, view, today: askedOn }), briefAnswer(ctx, question)])

  const tRetrieved = performance.now()
  let text = ''
  let cited: string[] = []
  let model = 'none (instant answer)'
  const locked = !!brief.restricted?.best_is_locked && brief.evidence === 'weak'
  // The writer gets a chance whenever search found anything: weak matches can still answer from
  // ordinary documents, and it says plainly when they don't (or refuses when only locked sources would).
  if (answersAllowed() && ranked.hits.length) {
    const pack = await buildContext(sql, t.id, question, { as: ctx.as, prefetched: { ...ranked, hits: ranked.hits.slice(0, 12) }, view, today: askedOn })
    const w = await writeAnswer(pack, () => {}, { restricted: !!brief.restricted?.best_is_locked })
    if (w) {
      model = w.model
      const nums = [...new Set([...w.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
      cited = nums.map((n) => pack.sources[n - 1]?.id).filter((x): x is string => !!x)
      text = w.text.replace(/\n\s*---\s*\n/, '\n\n').trim()
    }
  }
  if (!text) {
    text = locked ? LOCKED : brief.headline ? [brief.headline, brief.detail, brief.changed].filter(Boolean).join('\n\n') : 'Nothing in the available records answers this.'
    // A refusal or "nothing found" cites nothing; an instant answer cites what it rests on.
    cited = brief.headline ? brief.sources.map((s) => s.id) : []
  }
  if (/^I can[’']t answer that from the information you have access to/.test(text.trim())) cited = []

  const refs = await refsFor(ctx, files, [...new Set([...cited, ...ranked.hits.map((h) => h.id)])])
  const citations: Ref[] = []
  const seen = new Set<string>()
  for (const id of cited)
    for (const r of refs.get(id) ?? []) {
      if (seen.has(r.source + r.locator)) continue
      seen.add(r.source + r.locator)
      citations.push(r)
    }
  // One entry per piece of evidence, in result order: a fact lists the (readable) files behind it.
  const retrieved: { source: string; locator: string; rank: number; score: number }[] = []
  const listed = new Set<string>()
  for (const h of ranked.hits)
    for (const r of refs.get(h.id) ?? []) {
      if (listed.has(r.source + r.locator)) continue
      listed.add(r.source + r.locator)
      retrieved.push({ source: r.source, locator: r.locator, rank: retrieved.length + 1, score: Number((h.ranks.rerank ?? h.score).toFixed(4)) })
    }

  // Refused = the direct answer is the refusal (not an answer that mentions some sources are locked).
  const opening = text.split(/\n\s*\n/)[0].trim()
  const refused = /^I can[’']t answer that from the information you have access to/.test(opening)
  // Generation settings: the answer model doesn't accept a temperature (deprecated for it), so runs
  // are fixed by model id and prompt instead; reported so the runner can record it.
  const out = { answer: text, refused, citations, retrieved, latency_ms: Math.round(performance.now() - t0), model, timings: { retrieval_ms: Math.round(tRetrieved - t0) }, generation: { temperature: 'not supported by model; default' } }

  // Run log only (latency, debugging): outside the knowledge store, never read back by the Brain.
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const run = (c.req.header('X-Eval-Run') ?? 'no-run').replace(/[^\w.-]/g, '_')
    appendFileSync(join(LOG_DIR, `${run}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), as: who?.name ?? null, asked_on: askedOn, cutoff, latency_ms: out.latency_ms, model, refused, citations: citations.length, retrieved: retrieved.length })}\n`)
  } catch {}
  return c.json(out)
})

/** The company model as known by the cutoff, in the scorer's export format. */
evalContract.get('/eval/ontology', async (c) => {
  const cutoff = day(c.req.query('knowledge_cutoff'))
  if (!cutoff) return c.json({ error: 'knowledge_cutoff (YYYY-MM-DD) is required' }, 400)
  const t = await tenant()
  const view = await knowledgeView(pool(), t.id, SLUG, cutoff, cutoff)
  return c.json(await exportOntology({ sql: pool(), tenantId: t.id, as: null, view, today: cutoff }, SLUG))
})

/** What each extraction stage produced (speech, OCR, on-screen text, entity links), for component scores. */
let componentsCache: { at: number; data: unknown } | null = null
evalContract.get('/eval/components', async (c) => {
  if (!componentsCache || Date.now() - componentsCache.at > 30 * 60_000) componentsCache = { at: Date.now(), data: await exportComponents(pool(), (await tenant()).id, SLUG) }
  return c.json(componentsCache.data)
})

/** Builds the slow part of the Day 10 view ahead of time, so the first question isn't charged for it. */
export async function warmEval() {
  let cutoffs: string[] = []
  try {
    cutoffs = evalConfig().warm_cutoffs ?? []
  } catch {
    return // no eval config for this tenant
  }
  const t = await tenant()
  for (const cut of cutoffs) await prepareView(pool(), t.id, SLUG, cut)
}
