// Dev tool: per-step checks for the steps we own, so a failure says which step broke.
//   understanding  the things the question names (nicknames resolved) and its time reading
//   lead fact      what the instant answer headlines (must contain / must not contain / none)
// No model calls: it runs the deterministic path only.
//
// Usage: npx tsx scripts/steps-eval.ts <slug> [path/to/set.json] [--verbose]

import { readFileSync } from 'node:fs'
import { briefAnswer } from '../src/answer/brief'
import { pool } from '../src/workbench/server'

interface Item {
  q: string
  as?: string
  entities?: string[]
  time?: string
  headline_any?: string[]
  headline_none_of?: string[]
  headline?: null
}

const args = process.argv.slice(2)
const slug = args[0]
if (!slug) throw new Error('usage: steps-eval.ts <slug> [set.json] [--verbose]')
const file = args.find((a, i) => i > 0 && !a.startsWith('--')) ?? `../../evals/${slug}/steps-dev-v1.json`
const verbose = args.includes('--verbose')
const set = JSON.parse(readFileSync(file, 'utf8')) as { name: string; items: Item[] }

const db = pool()
const tenant = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
if (!tenant) throw new Error(`unknown tenant ${slug}`)

const tally = { understanding: [0, 0], time: [0, 0], lead: [0, 0] }
const fails: string[] = []
for (const it of set.items) {
  const b = await briefAnswer({ sql: db, tenantId: tenant.id, as: it.as ?? null }, it.q)
  const got = b.entities.map((e) => e.name.toLowerCase())
  const head = (b.headline ?? '').toLowerCase()
  const checks: [keyof typeof tally, boolean, string][] = []
  if (it.entities) {
    const missing = it.entities.filter((e) => !got.includes(e.toLowerCase()))
    checks.push(['understanding', !missing.length, missing.length ? `missing ${missing.join(', ')} (got ${got.join(', ') || 'nothing'})` : ''])
  }
  if (it.time) checks.push(['time', b.time?.mode === it.time, `time ${b.time?.mode ?? 'none'}, wanted ${it.time}`])
  if (it.headline === null) checks.push(['lead', !b.headline, `should have no headline, got "${b.headline}"`])
  if (it.headline_any || it.headline_none_of) {
    const any = !it.headline_any || it.headline_any.some((x) => head.includes(x.toLowerCase()))
    const none = !(it.headline_none_of ?? []).some((x) => head.includes(x.toLowerCase()))
    checks.push(['lead', any && none, `headline "${b.headline ?? '(none)'}"`])
  }
  for (const [k, ok, why] of checks) {
    tally[k][1]++
    if (ok) tally[k][0]++
    else fails.push(`  FAIL [${k}] ${it.q}\n         ${why}`)
  }
  if (verbose) console.log(`${checks.every((c) => c[1]) ? 'ok  ' : 'FAIL'} ${it.q}\n     → ${b.headline ?? '(no headline)'} · ${b.time?.mode ?? 'no time'} · ${got.join(', ')}`)
}
console.log(`=== ${set.name}: understanding ${tally.understanding.join('/')} · time ${tally.time.join('/')} · lead fact ${tally.lead.join('/')}`)
for (const f of fails) console.log(f)
await db.end()
