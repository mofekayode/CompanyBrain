// Dev tool: checks who may open what against expectations written from the permission exports
// (evals/<slug>/access-dev-v1.json). Per item: a file is openable if its own access list (or one of its
// members', for a mailbox or archive) admits the role.
//
// Usage: npx tsx scripts/access-check.ts <slug> [set.json]

import { readFileSync } from 'node:fs'
import { principalFor } from '../src/evals/roles'
import { principalsOf } from '../src/search/search'
import { pool } from '../src/workbench/server'

const [slug, file] = process.argv.slice(2)
if (!slug) throw new Error('usage: access-check.ts <slug> [set.json]')
const set = JSON.parse(readFileSync(file ?? `../../evals/${slug}/access-dev-v1.json`, 'utf8')) as { name: string; checks: { role: string; path: string; allow: boolean; why: string }[] }
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id

let pass = 0
const fails: string[] = []
const missing: string[] = []
for (const c of set.checks) {
  const who = await principalFor(db, t, slug, { role: c.role })
  if (!who) throw new Error(`no principal for ${c.role}`)
  const principals = await principalsOf(db, t, who.id)
  // The file and everything inside it (mailbox messages, archive members).
  // Per item, as the company's systems decide it: the file's (or its members') own access list.
  // Identical copies elsewhere don't change whether *this* copy may be opened.
  const r = (
    await db.query<{ files: number; readable: number }>(
      `with g as (select id, acl_id from public.source_objects where tenant_id = $1 and (original_path = $2 or original_path like $2 || '/%'))
       select (select count(*) from g)::int files,
              (select count(*) from g where exists (select 1 from public.acl_entries ae where ae.acl_id = g.acl_id and ae.principal_id = any($3::uuid[])))::int readable`,
      [t, c.path, principals],
    )
  ).rows[0]
  if (!r.files) {
    missing.push(c.path)
    continue
  }
  const ok = r.readable > 0 === c.allow
  if (ok) pass++
  else fails.push(`  FAIL ${c.role} ${c.allow ? 'should open' : 'must NOT open'} ${c.path} (${c.why}); readable items: ${r.readable}/${r.files}`)
}
console.log(`=== ${set.name}: ${pass}/${set.checks.length - missing.length} pass${missing.length ? ` · ${missing.length} paths not found: ${missing.join(', ')}` : ''}`)
for (const f of fails) console.log(f)
await db.end()
