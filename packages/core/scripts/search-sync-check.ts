// Dev tool: proves Postgres → Elasticsearch sync on a live tenant with synthetic,
// clearly-labelled records ("Zephyr …", path sync-test/…). Each step changes something,
// drains the outbox exactly like the worker does, and checks search sees the change.
// Afterwards the synthetic records are retired (rejected / soft-deleted).
//
// Usage: npx tsx scripts/search-sync-check.ts <slug>

import { randomUUID } from 'node:crypto'
import { drainSearchOutbox } from '../src/jobs/search'
import { reviewFact } from '../src/ontology/canonical'
import { search } from '../src/search/search'
import { es, indexAlias } from '../src/search/es'
import { pool } from '../src/workbench/server'

const [slug] = process.argv.slice(2)
const db = pool()
const tenantId = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const refresh = () => es().indices.refresh({ index: indexAlias(slug) })
const sync = async () => {
  const r = await drainSearchOutbox(db, tenantId)
  await refresh()
  return r
}
const results: { step: string; ok: boolean; detail: string }[] = []
const check = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${step}, ${detail}`)
}
const find = async (q: string, opts: Parameters<typeof search>[3] = {}) => (await search(db, tenantId, q, { limit: 10, ...opts })).hits
const t0 = Date.now()

// Reader without access to restricted files, and the company-wide access list.
const jamal = (await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and display_name = 'Jamal Whitaker'`, [tenantId])).rows[0].id
const allStaff = (await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and kind = 'group' and display_name = 'All Staff'`, [tenantId])).rows[0].id
const template = (await db.query<{ source_id: string; kind: string }>(`select source_id, kind from public.documents where tenant_id = $1 limit 1`, [tenantId])).rows[0]

// A private access list for the synthetic file: readable by All Staff.
const acl = (await db.query<{ id: string }>(`insert into public.acls (tenant_id, name, origin) values ($1, 'sync-test', '{"sync_test": true}') returning id`, [tenantId])).rows[0].id
await db.query(`insert into public.acl_entries (tenant_id, acl_id, principal_id) values ($1, $2, $3)`, [tenantId, acl, allStaff])

// 1. New policy uploaded (a document with evidence appears).
const so = randomUUID()
const doc = randomUUID()
const dv = randomUUID()
await db.query(
  `insert into public.source_objects (id, tenant_id, source_id, original_path, original_filename, s3_bucket, s3_key, sha256, size_bytes, acl_id, status, metadata)
   values ($1, $2, $3, 'sync-test/Zephyr widget policy.txt', 'Zephyr widget policy.txt', 'sync-test', $4, $5, 120, $6, 'profiled', '{"sync_test": true}')`,
  [so, tenantId, template.source_id, `sync-test/${so}`, so.replaceAll('-', '').padEnd(64, '0'), acl],
)
await db.query(`insert into public.documents (id, tenant_id, source_id, kind, title, canonical_path, acl_id, metadata) values ($1, $2, $3, $4, 'Zephyr widget policy', 'sync-test/Zephyr widget policy.txt', $5, '{"sync_test": true}')`, [
  doc,
  tenantId,
  template.source_id,
  template.kind,
  acl,
])
await db.query(`insert into public.document_versions (id, tenant_id, document_id, source_object_id, version_number, acl_id, extraction_status) values ($1, $2, $3, $4, 1, $5, 'succeeded')`, [dv, tenantId, doc, so, acl])
await db.query(`update public.documents set current_version_id = $2 where id = $1`, [doc, dv])
await db.query(
  `insert into public.evidence (tenant_id, document_version_id, ordinal, kind, content, content_sha256, acl_id) values ($1, $2, 0, 'text', $3, md5($3), $4)`,
  [tenantId, dv, 'Zephyr widget policy: every quarzite widget must be inspected by the shop foreman before it ships. Effective immediately.', acl],
)
let s = await sync()
check('new policy uploaded', (await find('quarzite widget inspection')).some((h) => h.path === 'sync-test/Zephyr widget policy.txt'), `outbox ${s.changes} changes → ${JSON.stringify(s.scope)}`)

// 2. New interview added (transcript evidence on the same file kind of flow).
await db.query(
  `insert into public.evidence (tenant_id, document_version_id, ordinal, kind, content, content_sha256, acl_id, start_ms, end_ms, speaker) values ($1, $2, 1, 'transcript_segment', $3, md5($3), $4, 0, 9000, 'Speaker 1')`,
  [tenantId, dv, '[00:00:01] Speaker 1: The Zephyr crew calls the inspection bench the glasshouse.', acl],
)
s = await sync()
check('new interview segment added', (await find('glasshouse inspection bench')).some((h) => h.kind === 'transcript_segment'), `re-cut ${s.scope?.documents} document(s)`)

// 3. Customer appears, then is renamed.
const customerType = (await db.query<{ id: string }>(`select id from public.entity_types where tenant_id = $1 and name = 'Customer'`, [tenantId])).rows[0].id
const ent = (
  await db.query<{ id: string }>(`insert into public.entities (tenant_id, entity_type_id, canonical_name, status, metadata) values ($1, $2, 'Zephyr Test Co', 'candidate', '{"sync_test": true}') returning id`, [
    tenantId,
    customerType,
  ])
).rows[0].id
await db.query(`update public.entities set canonical_name = 'Zephyr Quarry Supply' where id = $1`, [ent])
s = await sync()
let hits = await find('Zephyr Quarry Supply')
check('customer renamed', hits.some((h) => h.id === `e:${ent}` && h.title.startsWith('Zephyr Quarry Supply')), `card title: ${hits.find((h) => h.id === `e:${ent}`)?.title ?? 'missing'}`)

// 4. Alias added: the nickname finds the customer and the policy passages that mention it get linked.
await db.query(`insert into public.entity_aliases (tenant_id, entity_id, alias, kind, status, origin) values ($1, $2, 'the Zephyr crew', 'nickname', 'confirmed', 'human')`, [tenantId, ent])
s = await sync()
hits = await find('the Zephyr crew')
const linked = (await db.query<{ n: number }>(`select count(*)::int n from public.search_documents where tenant_id = $1 and document_version_id = $2 and $3 = any(entity_ids)`, [tenantId, dv, ent])).rows[0].n
check('alias added', hits.some((h) => h.id === `e:${ent}`) && linked > 0, `nickname → card; ${linked} passage(s) now linked to the customer`)

// 5. Fact added, then superseded by a correction.
const fact = (
  await db.query<{ id: string }>(
    `insert into public.facts (tenant_id, subject_entity_id, predicate, value, valid_from, status, metadata) values ($1, $2, 'payment_terms', '"Net 15"', '2024-01-01', 'accepted', '{"layer":"canonical","kind":"term","sync_test":true}') returning id`,
    [tenantId, ent],
  )
).rows[0].id
await sync()
const corrected = await reviewFact(db, tenantId, fact, { action: 'correct', value: 'Net 45', valid_from: '2026-07-01', note: 'sync test: terms changed', reviewer: 'fde' })
s = await sync()
hits = await find('Zephyr Quarry Supply payment terms', { docTypes: ['fact'] })
const old = hits.find((h) => h.id === `f:${fact}`)
const cur = hits.find((h) => h.id === `f:${corrected.id}`)
check('fact superseded', !!cur?.is_current && (!old || !old.is_current), `now: ${cur?.content.split('\n')[0] ?? 'missing'} · before: ${old ? (old.is_current ? 'still current ✗' : 'outdated') : 'not in top 10'}`)
hits = await find('Zephyr Quarry Supply payment terms', { docTypes: ['fact'], asOf: '2025-01-01' })
check('as-of search returns the old terms', hits.some((h) => h.id === `f:${fact}`) && !hits.some((h) => h.id === `f:${corrected.id}`), `as of 2025-01-01: ${hits.filter((h) => h.id.includes(fact) || h.id.includes(corrected.id)).map((h) => h.content.split('\n')[0]).join(' | ')}`)

// 6. Permission change: All Staff removed from the file's access list.
check('before: Jamal can find the policy', (await find('quarzite widget inspection', { as: jamal })).some((h) => h.path?.startsWith('sync-test/')), 'All Staff on the list')
await db.query(`delete from public.acl_entries where acl_id = $1 and principal_id = $2`, [acl, allStaff])
s = await sync()
check('permission revoked', !(await find('quarzite widget inspection', { as: jamal })).some((h) => h.path?.startsWith('sync-test/')), `re-pushed ${s.scope?.access_touched} document(s) without re-embedding (embedded ${s.embedded})`)
check('FDE still sees it', (await find('quarzite widget inspection')).some((h) => h.path?.startsWith('sync-test/')), 'admin view unchanged')

// 7. Source deleted.
await db.query(`update public.documents set deleted_at = now() where id = $1`, [doc])
await db.query(`update public.source_objects set deleted_at = now() where id = $1`, [so])
s = await sync()
check('source deleted', !(await find('quarzite widget inspection')).some((h) => h.path?.startsWith('sync-test/')), `removed ${s.deleted} passage(s)`)

// Retire the synthetic customer and its facts.
await db.query(`update public.entities set status = 'rejected', metadata = metadata || '{"rejected_reason":"sync test record"}' where id = $1`, [ent])
await db.query(`update public.facts set status = 'rejected' where subject_entity_id = $1`, [ent])
await sync()
check('cleanup', !(await find('Zephyr Quarry Supply')).some((h) => h.id === `e:${ent}`), 'synthetic customer gone from search')

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} sync checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
await db.end()
