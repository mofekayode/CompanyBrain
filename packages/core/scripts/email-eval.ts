// Dev tool: do questions about an email find the email? Questions are made from the mailboxes' own
// headers (a fixed sample): "What did <sender> email <recipient> about <subject topic>?" and a looser
// "What did <sender> say about <subject topic>?". A question passes when that message (or a copy in
// another mailbox) is in the top 5. Full access, no answer written.
//
// --rewrite: the product path (question rewriting and splitting; needs COMPANY_BRAIN_ALLOW_ANSWER_API=1).
// Usage: npx tsx scripts/email-eval.ts <slug> [n=40]

import { search } from '../src/search/search'
import { pool } from '../src/workbench/server'

const [slug, nArg] = process.argv.slice(2)
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const rows = (
  await db.query<{ key: string; subject: string; from: string; to: string }>(
    `select distinct on (d.dedupe_key) d.dedupe_key key, d.citation ->> 'subject' subject, d.citation ->> 'from' "from", substring(d.content from 'To: ([^\\n<,]+)') "to"
     from public.search_documents d where d.tenant_id = $1 and d.kind = 'email_body' and d.dedupe_key like 'msg:%'
       and length(coalesce(d.citation ->> 'subject', '')) > 12 and d.citation ->> 'from' is not null
     order by d.dedupe_key, d.id`,
    [t],
  )
).rows
// A fixed, spread-out sample: every k-th message by key.
const n = Number(nArg ?? 40)
const step = Math.max(1, Math.floor(rows.length / n))
const sample = rows.filter((_, i) => i % step === 0).slice(0, n)
const person = (s: string) => s.replace(/<.*?>/, '').replace(/"/g, '').trim()
const topic = (s: string) =>
  s
    .replace(/^((re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/\s+-\s+.*$/, '')
    .trim()
let pass = 0
let total = 0
for (const m of sample) {
  for (const q of [`What did ${person(m.from)} email ${person(m.to ?? '')} about ${topic(m.subject)}?`, `What did ${person(m.from).split(' ')[0]} say about ${topic(m.subject)}?`]) {
    const r = await search(db, t, q, { limit: 10, rerank: true, rewrite: process.argv.includes('--rewrite') })
    const i = r.hits.slice(0, 5).findIndex((h) => `msg:${h.citation.message_id}` === m.key)
    total++
    if (i >= 0) pass++
    else if (process.argv.includes('--verbose')) console.log(`  miss: ${q}  · top: ${r.hits.slice(0, 3).map((h) => (h.path ?? h.title).slice(0, 40)).join(' | ')}`)
  }
}
console.log(`email in top 5: ${pass}/${total} (${sample.length} messages, 2 phrasings each)`)
await db.end()
