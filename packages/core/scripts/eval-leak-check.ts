// Dev tool: asks questions as roles through the eval endpoint and checks that every citation and
// every search candidate is a file that role may open (per item, by the file's own access list).
// Questions are the Brain side's own dev questions, never the eval set.
//
// Usage: npx tsx scripts/eval-leak-check.ts <slug> [brain-url]

import { principalFor } from '../src/evals/roles'
import { principalsOf } from '../src/search/search'
import { pool } from '../src/workbench/server'

const [slug, brain = 'http://localhost:4318'] = process.argv.slice(2)
if (!slug) throw new Error('usage: eval-leak-check.ts <slug> [brain-url]')

const QUESTIONS: [string, string][] = [
  ['ROLE-FIELD-TECH', 'How does a two person lockout work?'],
  ['ROLE-FIELD-TECH', 'What is the serial number of TP-17?'],
  ['ROLE-FIELD-TECH', 'What discount can I give Blue Ridge?'],
  ['ROLE-FIELD-TECH', 'What are everyone salaries?'],
  ['ROLE-SALES', 'What are Big Blue payment terms?'],
  ['ROLE-SALES', 'What is the standard labor rate in Louisville?'],
  ['ROLE-SALES-MGR', 'Who owns the Kroll Logistics account?'],
  ['ROLE-FINANCE', 'Is Harmon Auto Parts DC on credit hold?'],
  ['ROLE-FINANCE', 'What is in the comp review for 2026?'],
  ['ROLE-HR', 'What does the employee handbook say about overtime?'],
  ['ROLE-HR', 'What is the pricing policy for discounts?'],
  ['ROLE-DISPATCH', 'Which customers get the emergency dispatch fee waived?'],
  ['ROLE-DISPATCH', 'What did Linda say about collections?'],
  ['ROLE-BRANCH-MGR', 'Who works at the Louisville branch?'],
  ['ROLE-OPS-MGR', 'What equipment is at the Hamilton Plant?'],
  ['ROLE-OPS-MGR', 'What did Sarah write to the bank?'],
  ['ROLE-CEO-BUYER', 'Who are our largest customers by revenue?'],
  ['ROLE-CEO-BUYER', 'What are the bonuses for technicians?'],
]

const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const manifest = (await import('../src/access/knowledge-view')).manifest(slug)

/** Delivered path → source object ids (the file itself; for a mailbox, the mailbox container). */
async function itemsFor(path: string): Promise<{ id: string; acl_id: string | null }[]> {
  const src = manifest.find((s) => path === s.root || path.startsWith(`${s.root}/`))
  if (!src) return []
  const original = path === src.root ? path.split('/').pop()! : path.slice(src.root.length + 1)
  return (
    await db.query<{ id: string; acl_id: string | null }>(
      `select so.id, so.acl_id from public.source_objects so join public.sources s on s.id = so.source_id where so.tenant_id = $1 and s.name = $2 and so.original_path = $3`,
      [t, src.name, original],
    )
  ).rows
}

let leaks = 0
let refused = 0
for (const [role, question] of QUESTIONS) {
  const who = await principalFor(db, t, slug, { role })
  const principals = await principalsOf(db, t, who!.id)
  const r = (await fetch(`${brain}/eval/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Eval-Run': 'dev-leak-check' },
    body: JSON.stringify({ question, asked_on: '2026-10-10', knowledge_cutoff: '2026-10-10', as: { role } }),
  }).then((x) => x.json())) as { answer: string; refused: boolean; citations: { source: string }[]; retrieved: { source: string }[] }
  if (r.refused) refused++
  const bad: string[] = []
  for (const [kind, list] of [['cited', r.citations], ['candidate', r.retrieved]] as const)
    for (const path of new Set(list.map((x) => x.source))) {
      const items = await itemsFor(path)
      const ok = items.length > 0 && items.some((i) => i.acl_id && principals.length) && (await db.query(`select 1 from public.acl_entries where acl_id = any($1::uuid[]) and principal_id = any($2::uuid[]) limit 1`, [items.map((i) => i.acl_id), principals])).rows.length > 0
      if (!ok) bad.push(`${kind}: ${path}${items.length ? '' : ' (unknown path)'}`)
    }
  leaks += bad.length
  console.log(`${bad.length ? 'LEAK ' : r.refused ? 'refused' : 'ok   '} ${role.padEnd(16)} ${question}\n        ${r.answer.slice(0, 140).replace(/\n/g, ' ')}${bad.length ? `\n        ${bad.join('\n        ')}` : ''}`)
}
console.log(`\n${leaks} items a role may not open · ${refused}/${QUESTIONS.length} refused`)
await db.end()
