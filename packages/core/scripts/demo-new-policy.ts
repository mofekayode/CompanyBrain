// Demo: incremental ingestion of a new policy, end to end, on a live tenant.
//
//   npx tsx scripts/demo-new-policy.ts <slug>          run the demo (prints each stage with timings)
//   npx tsx scripts/demo-new-policy.ts <slug> --undo   retire everything it created (soft delete / reject)
//
// 1. Ask "Who approves overtime?", the 2021 rule (dispatch lead or branch manager).
// 2. Upload a clearly-labelled DEMO memo through the same signed-URL path as the web upload.
// 3. The worker profiles and extracts it; the admin puts it in the company-wide area.
// 4. Search finds the memo within seconds of the sync.
// 5. The FDE records the change in Knowledge review (the old rule becomes history).
// 6. Ask again, the answer is the new rule, with "Changed: it was …" and the memo as source.
//
// The memo is fictional and marked DEMO; --undo restores the record exactly (nothing is deleted).

import { createHash } from 'node:crypto'
import { briefAnswer } from '../src/answer/brief'
import { moveFiles } from '../src/access/overview'
import { drainSearchOutbox } from '../src/jobs/search'
import { reviewFact } from '../src/ontology/canonical'
import { search } from '../src/search/search'
import { es, indexAlias } from '../src/search/es'
import { completeUpload, finishUpload, signUpload, startUpload } from '../src/workbench/uploads'
import { pool } from '../src/workbench/server'

const [slug, flag] = process.argv.slice(2)
const db = pool()
const tenantId = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const PATH = 'DEMO - Overtime approval memo (Northgate integration).txt'
const SOURCE = 'Demo uploads'
const QUESTION = 'Who approves overtime now?'
const t0 = Date.now()
const stamp = (s: string) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s] ${s}`)
const sync = async () => {
  await drainSearchOutbox(db, tenantId)
  await es().indices.refresh({ index: indexAlias(slug) })
}
const show = async () => {
  const a = await briefAnswer({ sql: db, tenantId, as: null }, QUESTION)
  console.log(`   → ${a.headline}`)
  if (a.changed) console.log(`     ${a.changed}`)
  console.log(`     sources: ${a.sources.slice(0, 4).map((s) => s.title.slice(0, 60)).join(' | ')}`)
}

const oldFact = (
  await db.query<{ id: string; status: string }>(
    `select f.id, f.status from public.facts f join public.entities s on s.id = f.subject_entity_id
     where f.tenant_id = $1 and s.canonical_name = 'Overtime' and f.predicate = 'requires_preapproval' and f.metadata ->> 'layer' = 'canonical'
       and coalesce(f.metadata ->> 'demo', '') = '' order by f.created_at limit 1`,
    [tenantId],
  )
).rows[0]
if (!oldFact) throw new Error('the overtime pre-approval fact is not in this tenant')

if (flag === '--undo') {
  const files = (await db.query<{ id: string }>(`update public.source_objects set deleted_at = now() where tenant_id = $1 and original_path like $2 and deleted_at is null returning id`, [tenantId, `%${PATH}`])).rows
  await db.query(
    `update public.documents set deleted_at = now() where tenant_id = $1 and deleted_at is null and current_version_id in (select id from public.document_versions where source_object_id = any($2::uuid[]))`,
    [tenantId, files.map((f) => f.id)],
  )
  const demo = await db.query(`update public.facts set status = 'rejected', note = 'demo retired' where tenant_id = $1 and metadata ->> 'demo' = 'new-policy' and status <> 'rejected' returning id`, [tenantId])
  // Put the original rule back exactly as it was before the first demo correction (fact_versions keeps every state).
  const before = (
    await db.query<{ snapshot: Record<string, unknown> }>(
      `select v.snapshot from public.fact_versions v where v.fact_id = $1 and v.changed_at < coalesce(
         (select min(f.created_at) from public.facts f where f.supersedes_fact_id = $1 and f.metadata ->> 'demo' = 'new-policy'), now())
       order by v.version desc limit 1`,
      [oldFact.id],
    )
  ).rows[0]?.snapshot
  if (before)
    await db.query(`update public.facts set status = $2, note = $3, valid_to = $4, reviewed_at = $5, metadata = $6 where id = $1`, [
      oldFact.id,
      before.status,
      before.note,
      before.valid_to,
      before.reviewed_at,
      JSON.stringify(before.metadata),
    ])
  await sync()
  console.log(`undone: ${files.length} file(s) soft-deleted, ${demo.rowCount} demo fact(s) rejected, original rule restored`)
  await show()
  await db.end()
  process.exit(0)
}

stamp(`1. Before, "${QUESTION}"`)
await show()

stamp('2. Upload the memo (signed URL → S3 raw, write-once, sha256-checked)')
const body = Buffer.from(
  [
    'DEMO DOCUMENT, fictional memo used to demonstrate incremental ingestion.',
    '',
    'MEMO, Overtime approval (Northgate integration)',
    'From: Sarah Okafor, President',
    'To: All field and dispatch staff',
    'Date: October 5, 2026',
    '',
    'Effective October 5, 2026, overtime must be approved in advance by the branch manager in FieldLine before the shift starts.',
    'Dispatch leads can no longer approve overtime. Hot Jobs where the technician is already on site are still exempt; log the hours the same day.',
    'This replaces the overtime approval rule in the 2021 Overtime and On-Call Policy.',
  ].join('\n'),
)
const sha256 = createHash('sha256').update(body).digest('hex')
const desc = { sourceName: SOURCE, relativePath: PATH, size: body.length, sha256, contentType: 'text/plain' }
const { runId } = await startUpload(tenantId, 'demo: new policy')
const signed = await signUpload(tenantId, runId, desc)
if (signed.status === 'upload') {
  const put = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body })
  if (!put.ok) throw new Error(`upload failed: ${put.status} ${await put.text()}`)
  await completeUpload(tenantId, runId, desc)
}
await finishUpload(tenantId, runId)
const fileId = (await db.query<{ id: string }>(`select id from public.source_objects where tenant_id = $1 and original_path like $2 and deleted_at is null order by created_at desc limit 1`, [tenantId, `%${PATH}`])).rows[0].id
console.log(`   stored as source object ${fileId}; ingestion queued`)

stamp('3. Worker: profile → extract (waiting for evidence)')
let evidence: { id: string }[] = []
for (let i = 0; i < 180 && !evidence.length; i++) {
  evidence = (await db.query<{ id: string }>(`select e.id from public.evidence e join public.document_versions v on v.id = e.document_version_id where v.source_object_id = $1`, [fileId])).rows
  if (!evidence.length) await new Promise((r) => setTimeout(r, 2000))
}
if (!evidence.length) throw new Error('no evidence after 6 minutes, is the worker running?')
console.log(`   ${evidence.length} passage(s) extracted`)

stamp('4. Admin puts it in the company-wide area (everyone can read it)')
const companyWide = (await db.query<{ id: string }>(`select id from public.access_scopes where tenant_id = $1 and key = 'company-wide'`, [tenantId])).rows[0].id
await moveFiles(db, tenantId, [fileId], companyWide, 'demo: new policy for all staff')
await sync()
const hits = (await search(db, tenantId, 'overtime approval branch manager FieldLine', { limit: 5 })).hits
console.log(`   search "overtime approval branch manager FieldLine" → #${hits.findIndex((h) => h.source_object_id === fileId) + 1}: ${hits.find((h) => h.source_object_id === fileId)?.title ?? 'not found'}`)

stamp('5. FDE records the change in Knowledge review (old rule kept as history)')
const created = await reviewFact(db, tenantId, oldFact.id, {
  action: 'correct',
  value: 'Must be approved in advance by the branch manager in FieldLine before the shift; dispatch leads can no longer approve. Hot Jobs with the tech already on site are exempt.',
  valid_from: '2026-10-05',
  note: 'per overtime approval memo (DEMO)',
})
await db.query(`update public.facts set metadata = metadata || '{"demo":"new-policy","summary":"Since October 5, 2026 only the branch manager can approve overtime, in FieldLine, before the shift."}' where id = $1`, [created.id])
await db.query(`insert into public.evidence_links (tenant_id, fact_id, evidence_id) select $1, $2, unnest($3::uuid[]) on conflict do nothing`, [tenantId, created.id, evidence.map((e) => e.id)])
const { consolidateTimelines } = await import('../src/ontology/timeline')
await consolidateTimelines(db, tenantId)
await sync()

stamp(`6. After, "${QUESTION}"`)
await show()
console.log('\nRun with --undo to restore the record.')
await db.end()
