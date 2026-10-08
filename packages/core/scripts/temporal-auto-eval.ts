// Dev tool: generate a temporal eval from EVERY timeline in the client's facts (not hand-picked).
// For each fact that changed: one "as of <Month YYYY>" question per period, plus one "now"
// question; pass = a value unique to the right version ranks above the other versions' values.
//
// Usage: npx tsx scripts/temporal-auto-eval.ts <slug> [out.json]   (then: npm run eval-set -- <slug> <out.json>)

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { timelines, type TimelineStep } from '../src/ontology/timeline'
import { pool } from '../src/workbench/server'

const [slug, outArg] = process.argv.slice(2)
const db = pool()
const tenantId = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const tokens = (v: string) => v.match(/\$?\d[\d,.]*%?|[A-Za-z][A-Za-z'-]{2,}/g)?.map((t) => t.replace(/[.,]$/, '')) ?? []
/** A short piece of this version's value that no other version in the chain contains. */
function distinctive(step: TimelineStep, others: TimelineStep[]): string | null {
  const otherText = others.map((o) => o.value.toLowerCase()).join(' | ')
  const cands = tokens(step.value).filter((t) => !otherText.includes(t.toLowerCase()))
  // Prefer numbers and amounts ("$187.50", "60"), then names ("Andrea"); skip filler words.
  const FILLER = new Set(['days', 'year', 'years', 'after', 'before', 'until', 'from', 'with', 'only', 'every', 'each', 'week', 'month', 'standard', 'policy', 'customer', 'customers', 'branch', 'job', 'jobs'])
  const strongNum = (t: string) => /[$%.]/.test(t) || (t.replace(/\D/g, '').length >= 3 && !/^(19|20)\d{2}$/.test(t))
  const num = cands.find((t) => /\d/.test(t) && strongNum(t))
  const word = cands.find((t) => /^[A-Za-z]/.test(t) && t.length >= 4 && !FILLER.has(t.toLowerCase()))
  return num ?? word ?? null
}
const mid = (s: TimelineStep): string | null => {
  if (!s.valid_from && !s.valid_to) return null
  const a = s.valid_from ? new Date(`${s.valid_from}T12:00:00Z`).getTime() : null
  const b = s.valid_to ? new Date(`${s.valid_to}T12:00:00Z`).getTime() : null
  const t = a && b ? (a + b) / 2 : a ? a + 45 * 86_400_000 : b! - 45 * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

const items: Record<string, unknown>[] = []
for (const tl of await timelines(db, tenantId)) {
  if (!tl.key.startsWith('sp:')) continue
  const steps = tl.steps.filter((s) => s.status !== 'disputed' && (s.valid_from || s.valid_to))
  if (steps.length < 2) continue
  const subject = steps[0].subject
  const what = steps[0].predicate.replaceAll('_', ' ')
  for (const s of steps) {
    const others = steps.filter((o) => o !== s)
    const want = distinctive(s, others)
    const d = mid(s)
    if (!want || !d) continue
    const rival = others.map((o) => distinctive(o, [s])).find(Boolean) ?? null
    const [y, m] = d.split('-').map(Number)
    items.push({
      kind: 'question',
      category: 'temporal:auto_as_of',
      question: `What was the ${what} of ${subject} in ${MONTHS[m - 1]} ${y}?`,
      expected_answer: `${s.value} (${s.valid_from ?? '…'} → ${s.valid_to ?? 'now'})`,
      key_points: [s.value],
      retrieval: { text: want, ...(rival ? { above: rival } : {}), top: 5 },
    })
  }
  const cur = [...steps].reverse().find((s) => s.status === 'accepted' && !s.valid_to)
  if (cur) {
    const prev = steps.filter((s) => s !== cur)
    const want = distinctive(cur, prev)
    const rival = prev.map((o) => distinctive(o, [cur])).find(Boolean) ?? null
    if (want)
      items.push({
        kind: 'question',
        category: 'temporal:auto_current',
        question: `What is the ${what} of ${subject} now?`,
        expected_answer: `${cur.value} since ${cur.valid_from ?? '?'}; before: ${prev.map((p) => p.value).join(' → ')}`,
        key_points: [cur.value, 'mentions the previous value'],
        retrieval: { text: want, ...(rival ? { above: rival } : {}), top: 3 },
      })
  }
}
const out = outArg ?? resolve(import.meta.dirname, `../../../evals/${slug}/temporal-auto-v1.json`)
await writeFile(
  out,
  `${JSON.stringify({ name: 'Temporal (all timelines) auto', description: 'Generated from every fact timeline: one as-of question per period and one current question per chain. Era ordering must be right.', items }, null, 2)}\n`,
)
console.log(`${items.length} questions → ${out}`)
await db.end()
