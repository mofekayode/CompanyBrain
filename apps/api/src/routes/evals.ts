import { runDataChecks } from '@companybrain/core/evals/run'
import { pool } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/** Eval sets and their latest data-check runs. */
export const evals = new Hono<Env>()

evals.get('/evals', async (c) => {
  const tenantId = c.get('tenant').id
  const sets = (
    await pool().query<{ id: string; name: string; description: string | null; checks: number; questions: number }>(
      `select s.id, s.name, s.description,
              count(*) filter (where i.kind = 'data_check' and i.status = 'active')::int checks,
              count(*) filter (where i.kind = 'question' and i.status = 'active')::int questions
       from public.eval_sets s left join public.eval_items i on i.set_id = s.id where s.tenant_id = $1 group by s.id order by s.name`,
      [tenantId],
    )
  ).rows
  const out = []
  for (const s of sets) {
    const runs = (
      await pool().query<{ id: string; started_at: string; summary: { total: number; passed: number; by_category: Record<string, { passed: number; total: number }> } | null }>(
        `select id, started_at::text, summary from public.eval_runs where set_id = $1 and target = 'data' and finished_at is not null order by started_at desc limit 10`,
        [s.id],
      )
    ).rows
    const latest = runs[0]
    const results = latest
      ? (
          await pool().query<{ category: string; question: string; passed: boolean; detail: string; kind: string }>(
            `select i.category, i.question, r.passed, r.output ->> 'detail' detail, i.kind from public.eval_results r join public.eval_items i on i.id = r.item_id where r.run_id = $1 order by r.passed, i.category, i.question`,
            [latest.id],
          )
        ).rows
      : []
    const questions = (
      await pool().query<{ category: string; question: string; expected_answer: string | null; files: string[] }>(
        `select category, question, expected_answer, coalesce(array(select jsonb_array_elements_text(expected -> 'files')), '{}') files from public.eval_items where set_id = $1 and kind = 'question' and status = 'active' order by category, question`,
        [s.id],
      )
    ).rows
    out.push({ ...s, runs: runs.map((r) => ({ id: r.id, started_at: r.started_at, total: r.summary?.total ?? 0, passed: r.summary?.passed ?? 0 })), latest: latest?.summary ?? null, results, question_items: questions })
  }
  return c.json(out)
})

/** Run a set's data checks now (seconds; no AI). */
evals.post('/evals/:id/run', async (c) => c.json(await runDataChecks(pool(), c.get('tenant').id, c.req.param('id'))))
