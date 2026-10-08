import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, expect, test } from 'vitest'
import { asService, asUser, createDb, createUser, one } from './harness'

let db: PGlite
let tech: string
let ceo: string

beforeAll(async () => {
  db = await createDb()
  tech = await createUser(db, 'tech@example.com')
  ceo = await createUser(db, 'ceo@example.com')
  await asService(db, async (tx) => {
    const t = (await one<{ id: string }>(tx, `select public.create_tenant('acme', 'Acme', $1) as id`, [ceo])).id
    await tx.query(`insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'member')`, [t, tech])
    const src = (await one<{ id: string }>(tx, `insert into sources (tenant_id, kind, name) values ($1, 'sharepoint', 'SP') returning id`, [t])).id
    const hr = (await one<{ id: string }>(tx, `insert into acls (tenant_id, name) values ($1, 'HR') returning id`, [t])).id
    const profile = (format: string, earliest: string) => JSON.stringify({ profile: { profiler_version: 1, format, category: 'document', structure: 'unstructured', integrity: { ok: true, issues: [] }, dates: { earliest, latest: earliest }, people: ['Pat'] } })
    const ins = `insert into source_objects (tenant_id, source_id, original_path, original_filename, s3_bucket, s3_key, sha256, size_bytes, acl_id, metadata, status)
                 values ($1, $2, $3, $4, 'b', $5, $6, 10, $7, $8, 'profiled')`
    await tx.query(ins, [t, src, 'Ops/Pricing book 2026.pdf', 'Pricing book 2026.pdf', `${t}/raw/a`, 'a'.repeat(64), null, profile('pdf', '2019-01-01')])
    await tx.query(ins, [t, src, 'Old/Pricing book 2026 (copy).pdf', 'Pricing book 2026 (copy).pdf', `${t}/raw/b`, 'a'.repeat(64), null, profile('pdf', '2019-01-01')])
    await tx.query(ins, [t, src, 'HR/Comp review 2026.xlsx', 'Comp review 2026.xlsx', `${t}/raw/c`, 'c'.repeat(64), hr, profile('xlsx', '2026-01-01')])
  })
})

test('inventory flattens the profile and counts duplicate copies', async () => {
  const rows = await asUser(db, ceo, (tx) => tx.query<{ original_path: string; format: string; duplicate_copies: number; content_earliest: Date }>(
    `select original_path, format, duplicate_copies, content_earliest from source_inventory order by original_path`))
  expect(rows.rows.map((r) => [r.original_path, r.format, r.duplicate_copies])).toEqual([
    ['HR/Comp review 2026.xlsx', 'xlsx', 1],
    ['Old/Pricing book 2026 (copy).pdf', 'pdf', 2],
    ['Ops/Pricing book 2026.pdf', 'pdf', 2],
  ])
})

test('inventory respects ACLs: restricted files are invisible to a technician', async () => {
  const rows = await asUser(db, tech, (tx) => tx.query<{ original_path: string }>(`select original_path from source_inventory`))
  expect(rows.rows.map((r) => r.original_path).sort()).toEqual(['Old/Pricing book 2026 (copy).pdf', 'Ops/Pricing book 2026.pdf'])
})

test('path search is fuzzy and case-insensitive', async () => {
  const rows = await asUser(db, ceo, (tx) => tx.query<{ original_path: string }>(
    `select original_path from source_inventory where original_path ilike '%pricing%' order by extensions.similarity(original_path, 'pricing book') desc`))
  expect(rows.rows).toHaveLength(2)
})

test('workbench_agent sandbox: one tenant, inventory + content + model only, read-only', async () => {
  const other = await asService(db, async (tx) => {
    const t = (await one<{ id: string }>(tx, `select public.create_tenant('other-co', 'Other', null) as id`)).id
    const src = (await one<{ id: string }>(tx, `insert into sources (tenant_id, kind, name) values ($1, 'x', 'X') returning id`, [t])).id
    await tx.query(`insert into source_objects (tenant_id, source_id, original_path, original_filename, s3_bucket, s3_key, sha256, size_bytes) values ($1, $2, 'secret.txt', 'secret.txt', 'b', $3, $4, 1)`, [t, src, `${t}/raw/s`, 'e'.repeat(64)])
    return t
  })
  const acme = (await one<{ id: string }>(db, `select id from tenants where slug = 'acme'`)).id
  const asAgent = (tenantId: string, sql: string) => db.transaction(async (tx) => {
    await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenantId])
    await tx.exec('set local transaction_read_only = on; set local role workbench_agent')
    return tx.query<Record<string, unknown>>(sql)
  })

  const mine = await asAgent(acme, `select original_path from source_inventory`)
  expect(mine.rows).toHaveLength(3)
  expect((await asAgent(other, `select original_path from source_inventory`)).rows).toEqual([{ original_path: 'secret.txt' }])
  await expect(asAgent(acme, `select * from tenant_members`)).rejects.toThrow(/permission denied/)
  await expect(asAgent(acme, `select * from access_grants`)).rejects.toThrow(/permission denied/)
  // The company model is readable, for its own client only.
  expect((await asAgent('', `select count(*)::int n from entities`)).rows).toEqual([{ n: 0 }])
  await expect(asAgent(acme, `update source_objects set status = 'failed'`)).rejects.toThrow(/read-only|permission denied/)
  expect((await asAgent('', `select count(*)::int n from source_inventory`)).rows).toEqual([{ n: 0 }])
})
