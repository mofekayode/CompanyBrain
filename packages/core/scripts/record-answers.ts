// Dev tool: record graded answers for an eval set's questions.
// While the Claude API is off, a Claude Code session answers each question from the
// system's own context pack (`ask.ts context`), nothing else, and writes a JSON file:
//   { "answered_by": "claude-code (opus-5.5) from context packs", "mode": "rag" | "agent",
//     "answers": [{ "question": "...", "answer": "...", "key_points_hit": ["..."], "citations": ["file, p. 2"], "notes": "..." }] }
// This script matches them to eval items, scores key-point coverage, and stores a run.
//
// Usage: npx tsx scripts/record-answers.ts <slug> <answers.json>

import { readFile } from 'node:fs/promises'
import { pool } from '../src/workbench/server'

const [slug, file] = process.argv.slice(2)
const data = JSON.parse(await readFile(file, 'utf8')) as {
  answered_by: string
  mode: 'rag' | 'agent'
  answers: { question: string; answer: string; key_points_hit: string[]; citations?: string[]; notes?: string }[]
}
const db = pool()
const tenantId = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const items = (
  await db.query<{ id: string; set_id: string; category: string; question: string; expected: { key_points?: string[] } }>(
    `select i.id, i.set_id, i.category, i.question, i.expected from public.eval_items i join public.eval_sets s on s.id = i.set_id
     where s.tenant_id = $1 and i.kind = 'question' and i.status = 'active' and i.expected ? 'key_points' and jsonb_array_length(i.expected -> 'key_points') > 0`,
    [tenantId],
  )
).rows
const bySet = new Map<string, typeof items>()
for (const it of items) bySet.set(it.set_id, [...(bySet.get(it.set_id) ?? []), it])
let total = 0
let full = 0
let pointSum = 0
for (const [setId, setItems] of bySet) {
  const run = (await db.query<{ id: string }>(`insert into public.eval_runs (tenant_id, set_id, target) values ($1, $2, $3) returning id`, [tenantId, setId, `answer:${data.mode}:${data.answered_by}`])).rows[0].id
  const byCategory: Record<string, { passed: number; total: number }> = {}
  for (const it of setItems) {
    const a = data.answers.find((x) => x.question.trim().toLowerCase() === it.question.trim().toLowerCase())
    if (!a) continue
    const points = it.expected.key_points ?? []
    const hit = points.filter((p) => a.key_points_hit.includes(p))
    const score = points.length ? hit.length / points.length : 0
    const passed = score >= 0.75
    total++
    pointSum += score
    if (passed) full++
    const c = (byCategory[it.category] ??= { passed: 0, total: 0 })
    c.total++
    if (passed) c.passed++
    await db.query(`insert into public.eval_results (tenant_id, run_id, item_id, passed, score, output) values ($1, $2, $3, $4, $5, $6)`, [
      tenantId,
      run,
      it.id,
      passed,
      score,
      JSON.stringify({ answer: a.answer, key_points_hit: hit, key_points_missed: points.filter((p) => !hit.includes(p)), citations: a.citations ?? [], notes: a.notes ?? '' }),
    ])
  }
  await db.query(`update public.eval_runs set summary = $2, finished_at = now() where id = $1`, [
    run,
    JSON.stringify({ total, passed: full, mean_key_points: total ? pointSum / total : 0, by_category: byCategory, answered_by: data.answered_by }),
  ])
}
console.log(`${full}/${total} answers cover ≥75% of key points · mean coverage ${(100 * (pointSum / Math.max(1, total))).toFixed(0)}%`)
await db.end()
