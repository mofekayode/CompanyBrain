// Runs the data checks of an eval set and stores per-item results. Access checks
// run as the named person (mock login + RLS), not by reading the scope tables.

import { catalogFor, type Db, ensureMockUser } from '../access/enforce'
import type { Sql } from '../storage/raw'
import type { Assertion } from './generate'

export async function runDataChecks(sql: Sql, tenantId: string, setId: string): Promise<{ run_id: string; total: number; passed: number; by_category: Record<string, { passed: number; total: number }> }> {
  const run = (await sql.query<{ id: string }>(`insert into public.eval_runs (tenant_id, set_id, target) values ($1, $2, 'data') returning id`, [tenantId, setId])).rows[0].id
  const items = (
    await sql.query<{ id: string; category: string; question: string; check_sql: string; expected: { assertion?: Assertion } }>(
      `select id, category, question, check_sql, expected from public.eval_items where set_id = $1 and kind = 'data_check' and status = 'active'`,
      [setId],
    )
  ).rows
  const byCategory: Record<string, { passed: number; total: number }> = {}
  let passed = 0
  for (const it of items) {
    let ok = false
    let detail = ''
    try {
      const a = it.expected.assertion
      if (a?.type === 'person_access') {
        const person = (await sql.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and kind = 'user' and lower(display_name) = lower($2) limit 1`, [tenantId, a.person])).rows[0]
        if (!person) throw new Error(`unknown person ${a.person}`)
        const user = await ensureMockUser(sql, tenantId, person.id, 'member')
        const files = (await catalogFor(sql as Db, tenantId, user)).filter((f) => f.original_path.toLowerCase().includes(a.path_hint.toLowerCase()))
        const opens = files.some((f) => f.can_open)
        ok = opens === a.can_open
        detail = files.length ? `${files.length} matching files visible, ${files.filter((f) => f.can_open).length} openable` : 'no matching files visible (hidden or locked out)'
      } else {
        const r = (await sql.query<{ passed: boolean; detail: string }>(it.check_sql, [tenantId])).rows[0]
        ok = !!r?.passed
        detail = r?.detail ?? ''
      }
    } catch (error) {
      detail = `error: ${(error as Error).message}`
    }
    if (ok) passed++
    const c = (byCategory[it.category] ??= { passed: 0, total: 0 })
    c.total++
    if (ok) c.passed++
    await sql.query(`insert into public.eval_results (tenant_id, run_id, item_id, passed, score, output) values ($1, $2, $3, $4, $5, $6)`, [
      tenantId,
      run,
      it.id,
      ok,
      ok ? 1 : 0,
      JSON.stringify({ detail: String(detail).slice(0, 1000) }),
    ])
  }
  const summary = { total: items.length, passed, by_category: byCategory }
  await sql.query(`update public.eval_runs set summary = $2, finished_at = now() where id = $1`, [run, JSON.stringify(summary)])
  return { run_id: run, ...summary }
}
