// Dev tool: how often does an outdated source rank above a current one? (The benchmark's "outdated
// ranked above current".) Questions about now, from the temporal sets, asked twice: as written
// ("...now?") and without the word "now" (how people usually ask), plus a question per document that
// has older versions. A hit is outdated when it is a replaced fact, a passage whose facts have all
// been replaced, or a passage of an older version of a document; current when it is a current fact,
// a passage supporting one, or a passage of the newest version. Judged from the database, independently of search's code.
//
// --rewrite: the product path (question rewriting and splitting; needs COMPANY_BRAIN_ALLOW_ANSWER_API=1).
// Usage: npx tsx scripts/outdated-eval.ts <slug>

import { readFileSync } from 'node:fs'
import { search } from '../src/search/search'
import { familyKey, replacedBy } from '../src/search/versions'
import { pool } from '../src/workbench/server'

const [slug] = process.argv.slice(2)
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const sets = ['temporal-auto-v1.json', 'temporal-v1.json'].map((f) => JSON.parse(readFileSync(`../../evals/${slug}/${f}`, 'utf8')).items as { kind: string; category: string; question: string }[])
const asked = sets.flat().filter((i) => i.kind === 'question' && /current|stale/.test(i.category)).map((i) => i.question)
const questions = [...asked, ...asked.map((q) => q.replace(/\s*\b(now|today|currently|at the moment)\b\s*/gi, ' ').replace(/\s+\?/, '?').trim())]
// Documents with older versions: ask about each family ("What does the hot job policy say?").
const files = (await db.query<{ id: string; path: string; observed_at: null; sha: string | null }>(`select id, original_path path, null observed_at, sha256 sha from public.source_objects where tenant_id = $1 and deleted_at is null and original_path not like 'mail/%'`, [t])).rows
const replaced = replacedBy(files)
const newest = new Set([...replaced.values()].flat().filter((id) => !replaced.has(id)))
const families = [...new Set([...replaced.keys()].map((id) => familyKey(files.find((f) => f.id === id)!.path)))]
questions.push(...families.flatMap((k) => [`What does the ${k} say?`, k]))
const factCurrent = new Map((await db.query<{ id: string; cur: boolean }>(`select citation ->> 'fact_id' id, is_current cur from public.search_documents where tenant_id = $1 and doc_type = 'fact' and kind <> 'timeline' and id not like '%~%'`, [t])).rows.map((r) => [r.id, r.cur]))
let worse = 0
let judged = 0
const bad: string[] = []
for (const q of questions) {
  const r = await search(db, t, q, { limit: 10, rerank: true, rewrite: process.argv.includes('--rewrite') })
  const state = r.hits.map((h) => {
    if (h.doc_type === 'fact' && h.kind !== 'timeline') return h.is_current ? 'current' : 'outdated'
    if (h.doc_type === 'passage' && h.source_object_id && replaced.has(h.source_object_id)) return 'outdated'
    if (h.doc_type === 'passage' && h.source_object_id && newest.has(h.source_object_id)) return 'current'
    const fs = ((h.citation.facts as string[] | undefined) ?? []).filter((f) => factCurrent.has(f))
    if (h.doc_type !== 'passage' || !fs.length) return null
    return fs.some((f) => factCurrent.get(f)) ? 'current' : 'outdated'
  })
  const firstCur = state.indexOf('current')
  const firstOld = state.indexOf('outdated')
  if (firstCur < 0 && firstOld < 0) continue
  judged++
  if (firstOld >= 0 && (firstCur < 0 || firstOld < firstCur)) {
    worse++
    bad.push(`  ${q} · outdated #${firstOld + 1}: ${(r.hits[firstOld].path ?? r.hits[firstOld].title).slice(0, 60)}${firstCur >= 0 ? ` · first current #${firstCur + 1}` : ''}`)
  }
}
console.log(`outdated above current: ${worse}/${judged} (${Math.round((worse / judged) * 100)}%) of ${questions.length} questions`)
console.log(bad.join('\n'))
await db.end()
