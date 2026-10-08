import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { asAnon, asService, asUser, createDb, createUser, one } from './harness'

const SHA = (c: string) => c.repeat(64)

let db: PGlite
const u: Record<string, string> = {}
const t: Record<string, string> = {}
const ids: Record<string, string> = {}

// Two unrelated fictional companies with different ontologies, plus a
// restricted HR document inside the first.
beforeAll(async () => {
  db = await createDb()
  for (const name of ['ceo', 'fde', 'tech', 'admin', 'other']) u[name] = await createUser(db, `${name}@example.com`)

  await asService(db, async (tx) => {
    t.acme = (await one<{ id: string }>(tx, `select public.create_tenant('acme-pumps', 'Acme Pumps', $1) as id`, [u.ceo])).id
    t.dental = (await one<{ id: string }>(tx, `select public.create_tenant('bright-dental', 'Bright Dental', $1) as id`, [u.other])).id
    await tx.query(
      `insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'fde'), ($1, $3, 'member'), ($1, $4, 'admin')`,
      [t.acme, u.fde, u.tech, u.admin],
    )

    // Restricted HR folder: readable by the "HR" group, which contains "Finance", which contains the CEO.
    const ceoPrincipal = (await one<{ id: string }>(tx, `select id from principals where tenant_id = $1 and user_id = $2`, [t.acme, u.ceo])).id
    const hr = (await one<{ id: string }>(tx, `insert into principals (tenant_id, kind, external_ref, display_name) values ($1, 'group', 'sharepoint:group:HR', 'HR') returning id`, [t.acme])).id
    const finance = (await one<{ id: string }>(tx, `insert into principals (tenant_id, kind, display_name) values ($1, 'group', 'Finance') returning id`, [t.acme])).id
    await tx.query(`insert into principal_members (tenant_id, group_id, member_id) values ($1, $2, $3), ($1, $3, $4)`, [t.acme, hr, finance, ceoPrincipal])
    ids.hrAcl = (await one<{ id: string }>(tx, `insert into acls (tenant_id, name) values ($1, 'SharePoint HR') returning id`, [t.acme])).id
    await tx.query(`insert into acl_entries (tenant_id, acl_id, principal_id) values ($1, $2, $3)`, [t.acme, ids.hrAcl, hr])

    for (const [tenant, key] of [[t.acme, 'acme'], [t.dental, 'dental']] as const) {
      const src = (await one<{ id: string }>(tx, `insert into sources (tenant_id, kind, name) values ($1, 'fileserver', 'S drive') returning id`, [tenant])).id
      ids[`${key}Source`] = src
      for (const [file, acl, sha] of [['handbook.pdf', null, 'a'], ['salaries.xlsx', key === 'acme' ? ids.hrAcl : null, 'b']] as const) {
        const obj = (await one<{ id: string }>(tx,
          `insert into source_objects (tenant_id, source_id, original_path, original_filename, s3_bucket, s3_key, sha256, size_bytes, acl_id)
           values ($1, $2, $3, $4, 'company-brain', $5, $6, 100, $7) returning id`,
          [tenant, src, `/S/${file}`, file, `${tenant}/raw/s-drive/${file}`, SHA(sha), acl])).id
        const doc = (await one<{ id: string }>(tx, `insert into documents (tenant_id, source_id, kind, title, acl_id) values ($1, $2, 'file', $3, $4) returning id`, [tenant, src, file, acl])).id
        const ver = (await one<{ id: string }>(tx, `insert into document_versions (tenant_id, document_id, source_object_id, version_number, acl_id) values ($1, $2, $3, 1, $4) returning id`, [tenant, doc, obj, acl])).id
        await tx.query(`update documents set current_version_id = $1 where id = $2`, [ver, doc])
        const ev = (await one<{ id: string }>(tx, `insert into evidence (tenant_id, document_version_id, ordinal, kind, content, page_number, acl_id) values ($1, $2, 0, 'text', $3, 1, $4) returning id`, [tenant, ver, `${key} ${file} content`, acl])).id
        ids[`${key}:${file}`] = obj
        ids[`${key}:${file}:version`] = ver
        ids[`${key}:${file}:evidence`] = ev
      }
    }

    // Different ontologies, same tables.
    const customer = (await one<{ id: string }>(tx, `insert into entity_types (tenant_id, name, status) values ($1, 'Customer', 'active') returning id`, [t.acme])).id
    const employee = (await one<{ id: string }>(tx, `insert into entity_types (tenant_id, name, status) values ($1, 'Employee', 'active') returning id`, [t.acme])).id
    const patient = (await one<{ id: string }>(tx, `insert into entity_types (tenant_id, name, status) values ($1, 'Patient', 'active') returning id`, [t.dental])).id
    await tx.query(`insert into entity_types (tenant_id, name, status) values ($1, 'Procedure', 'active')`, [t.dental])
    await tx.query(`insert into entities (tenant_id, entity_type_id, canonical_name, properties) values ($1, $2, 'Jane Lee', '{"insurer": "Delta"}')`, [t.dental, patient])
    ids.blueRidge = (await one<{ id: string }>(tx, `insert into entities (tenant_id, entity_type_id, canonical_name, status) values ($1, $2, 'Blue Ridge Foods', 'active') returning id`, [t.acme, customer])).id
    ids.dave = (await one<{ id: string }>(tx, `insert into entities (tenant_id, entity_type_id, canonical_name, status) values ($1, $2, 'Dave', 'active') returning id`, [t.acme, employee])).id
    await tx.query(`insert into entity_aliases (tenant_id, entity_id, alias, kind) values ($1, $2, '  Big   Blue ', 'nickname')`, [t.acme, ids.blueRidge])
    ids.salaryFact = (await one<{ id: string }>(tx,
      `insert into facts (tenant_id, subject_entity_id, predicate, value, status, acl_id) values ($1, $2, 'salary', '95000', 'accepted', $3) returning id`,
      [t.acme, ids.dave, ids.hrAcl])).id
    await tx.query(`insert into evidence_links (tenant_id, evidence_id, fact_id) values ($1, $2, $3)`, [t.acme, ids['acme:salaries.xlsx:evidence'], ids.salaryFact])
  })
})

const count = async (userId: string, table: string) =>
  asUser(db, userId, async (tx) => Number((await one<{ n: string }>(tx, `select count(*) as n from ${table}`)).n))

describe('tenant isolation', () => {
  test('a user only sees their own tenants', async () => {
    const rows = await asUser(db, u.tech, (tx) => tx.query<{ slug: string }>(`select slug from tenants`))
    expect(rows.rows.map((r) => r.slug)).toEqual(['acme-pumps'])
  })

  test.each(['sources', 'source_objects', 'documents', 'document_versions', 'evidence', 'entity_types', 'entities', 'permissions', 'principals'])(
    '%s rows of another tenant are invisible', async (table) => {
      const rows = await asUser(db, u.other, (tx) => tx.query<{ tenant_id: string }>(`select tenant_id from ${table}`))
      expect(rows.rows.length).toBeGreaterThan(0)
      expect(rows.rows.every((r) => r.tenant_id === t.dental)).toBe(true)
    })

  test('anon sees nothing', async () => {
    await expect(asAnon(db, (tx) => tx.query(`select * from tenants`))).rejects.toThrow(/permission denied/)
  })

  test('users cannot insert into another tenant', async () => {
    await expect(asUser(db, u.fde, (tx) =>
      tx.query(`insert into entity_types (tenant_id, name) values ($1, 'Sneaky')`, [t.dental]))).rejects.toThrow(/row-level security/)
  })

  test('composite foreign keys block cross-tenant references even for service_role', async () => {
    await expect(asService(db, (tx) =>
      tx.query(`insert into evidence (tenant_id, document_version_id, ordinal, kind, content) values ($1, $2, 9, 'text', 'x')`,
        [t.dental, ids['acme:handbook.pdf:version']]))).rejects.toThrow(/foreign key/)
  })

  test('a suspended tenant is invisible to its members', async () => {
    await asService(db, (tx) => tx.query(`update tenants set status = 'suspended' where id = $1`, [t.dental]))
    expect(await count(u.other, 'entity_types')).toBe(0)
    await asService(db, (tx) => tx.query(`update tenants set status = 'active' where id = $1`, [t.dental]))
  })
})

describe('resource ACLs', () => {
  test('technician cannot see restricted HR evidence, documents, raw objects or facts', async () => {
    await asUser(db, u.tech, async (tx) => {
      const ev = await tx.query<{ content: string }>(`select content from evidence`)
      expect(ev.rows.map((r) => r.content)).toEqual(['acme handbook.pdf content'])
      expect((await tx.query(`select 1 from source_objects where id = $1`, [ids['acme:salaries.xlsx']])).rows).toHaveLength(0)
      expect((await tx.query(`select 1 from documents where title = 'salaries.xlsx'`)).rows).toHaveLength(0)
      expect((await tx.query(`select 1 from facts where predicate = 'salary'`)).rows).toHaveLength(0)
      expect((await tx.query(`select 1 from fact_versions`)).rows).toHaveLength(0)
      expect((await tx.query(`select 1 from evidence_links`)).rows).toHaveLength(0)
    })
  })

  test('CEO sees it through nested group membership (Finance ⊂ HR)', async () => {
    // CEO is owner, so remove the bypass first to prove the group path works on its own.
    await asService(db, (tx) => tx.query(`delete from permissions where tenant_id = $1 and role = 'owner' and permission = 'acl.bypass'`, [t.acme]))
    expect(await count(u.ceo, 'facts')).toBe(1)
    expect(await count(u.ceo, 'evidence')).toBe(2)
    await asService(db, (tx) => tx.query(`insert into permissions (tenant_id, role, permission) values ($1, 'owner', 'acl.bypass')`, [t.acme]))
  })

  test('FDE does not bypass ACLs by default; admin does', async () => {
    expect(await count(u.fde, 'evidence')).toBe(1)
    expect(await count(u.admin, 'evidence')).toBe(2)
  })

  test('changing one ACL changes visibility everywhere it propagates', async () => {
    const techPrincipal = (await one<{ id: string }>(db, `select id from principals where user_id = $1`, [u.tech])).id
    await asService(db, (tx) => tx.query(`insert into acl_entries (tenant_id, acl_id, principal_id) values ($1, $2, $3)`, [t.acme, ids.hrAcl, techPrincipal]))
    expect(await count(u.tech, 'evidence')).toBe(2)
    expect(await count(u.tech, 'facts')).toBe(1)
    await asService(db, (tx) => tx.query(`delete from acl_entries where principal_id = $1`, [techPrincipal]))
    expect(await count(u.tech, 'evidence')).toBe(1)
  })
})

describe('role permissions', () => {
  test('member cannot change the ontology; FDE can', async () => {
    await expect(asUser(db, u.tech, (tx) =>
      tx.query(`insert into entity_types (tenant_id, name) values ($1, 'Pump')`, [t.acme]))).rejects.toThrow(/row-level security/)
    await asUser(db, u.fde, (tx) => tx.query(`insert into entity_types (tenant_id, name, origin) values ($1, 'Pump', 'ai')`, [t.acme]))
  })

  test('member cannot read ingestion jobs; FDE can', async () => {
    await asService(db, (tx) => tx.query(`insert into ingestion_jobs (tenant_id, job_type, idempotency_key) values ($1, 'extract', 'x')`, [t.acme]))
    expect(await count(u.tech, 'ingestion_jobs')).toBe(0)
    expect(await count(u.fde, 'ingestion_jobs')).toBe(1)
  })

  test('admin can add members but cannot create owners', async () => {
    const newbie = await createUser(db, 'newbie@example.com')
    await expect(asUser(db, u.admin, (tx) =>
      tx.query(`insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'owner')`, [t.acme, newbie]))).rejects.toThrow(/row-level security/)
    await asUser(db, u.admin, (tx) => tx.query(`insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'member')`, [t.acme, newbie]))
    // Membership automatically creates a principal so ACLs can name the user.
    expect((await db.query(`select 1 from principals where user_id = $1 and tenant_id = $2`, [newbie, t.acme])).rows).toHaveLength(1)
  })

  test('only service_role can provision tenants', async () => {
    await expect(asUser(db, u.ceo, (tx) => tx.query(`select public.create_tenant('x-co', 'X', null)`))).rejects.toThrow(/permission denied/)
  })

  test('users cannot forge fact history', async () => {
    await expect(asUser(db, u.admin, (tx) =>
      tx.query(`insert into fact_versions (tenant_id, fact_id, version, snapshot) values ($1, $2, 99, '{}')`, [t.acme, ids.salaryFact]))).rejects.toThrow(/permission denied/)
  })
})

describe('provenance and history', () => {
  test('raw object identity is immutable, processing status is not', async () => {
    await expect(asService(db, (tx) =>
      tx.query(`update source_objects set sha256 = $1 where id = $2`, [SHA('c'), ids['acme:handbook.pdf']]))).rejects.toThrow(/immutable/)
    await expect(asService(db, (tx) =>
      tx.query(`update source_objects set original_path = '/tidy/handbook.pdf' where id = $1`, [ids['acme:handbook.pdf']]))).rejects.toThrow(/immutable/)
    await asService(db, (tx) => tx.query(`update source_objects set status = 'processed' where id = $1`, [ids['acme:handbook.pdf']]))
  })

  test('members cannot delete raw objects', async () => {
    const r = await asUser(db, u.admin, (tx) => tx.query(`delete from source_objects`))
    expect(r.affectedRows).toBe(0)
  })

  test('duplicates are preserved: same bytes at two paths', async () => {
    await asService(db, (tx) => tx.query(
      `insert into source_objects (tenant_id, source_id, original_path, original_filename, s3_bucket, s3_key, sha256, size_bytes)
       values ($1, $2, '/S/copy of handbook.pdf', 'copy of handbook.pdf', 'company-brain', $3, $4, 100)`,
      [t.acme, ids.acmeSource, `${t.acme}/raw/s-drive/copy of handbook.pdf`, SHA('a')]))
    const r = await db.query(`select 1 from source_objects where tenant_id = $1 and sha256 = $2`, [t.acme, SHA('a')])
    expect(r.rows).toHaveLength(2)
  })

  test('every fact edit is versioned, with who and why', async () => {
    await asUser(db, u.admin, async (tx) => {
      await tx.query(`select set_config('app.change_reason', 'corrected from payroll export', true)`)
      await tx.query(`update facts set value = '97000' where id = $1`, [ids.salaryFact])
    })
    const v = await db.query<{ version: number; value: unknown; changed_by: string | null; change_reason: string | null }>(
      `select version, snapshot->'value' as value, changed_by, change_reason from fact_versions where fact_id = $1 order by version`, [ids.salaryFact])
    expect(v.rows).toEqual([
      { version: 1, value: 95000, changed_by: null, change_reason: null },
      { version: 2, value: 97000, changed_by: u.admin, change_reason: 'corrected from payroll export' },
    ])
  })

  test('temporal facts coexist instead of overwriting', async () => {
    await asService(db, async (tx) => {
      const old = (await one<{ id: string }>(tx,
        `insert into facts (tenant_id, subject_entity_id, predicate, value, valid_from, valid_to, status)
         values ($1, $2, 'payment_terms', '"Net 30"', '2022-01-01', '2025-06-30', 'superseded') returning id`, [t.acme, ids.blueRidge])).id
      await tx.query(
        `insert into facts (tenant_id, subject_entity_id, predicate, value, valid_from, status, supersedes_fact_id)
         values ($1, $2, 'payment_terms', '"Net 60"', '2025-07-01', 'accepted', $3)`, [t.acme, ids.blueRidge, old])
    })
    const at = async (date: string) => (await one<{ value: string }>(db,
      `select value from facts where subject_entity_id = $1 and predicate = 'payment_terms'
         and (valid_from is null or valid_from <= $2) and (valid_to is null or valid_to >= $2)`, [ids.blueRidge, date])).value
    expect(await at('2024-03-01')).toBe('Net 30')
    expect(await at('2026-01-01')).toBe('Net 60')
  })

  test('aliases are normalized for lookup', async () => {
    const r = await asUser(db, u.tech, (tx) => tx.query<{ canonical_name: string }>(
      `select e.canonical_name from entity_aliases a join entities e on e.id = a.entity_id where a.normalized_alias = 'big blue'`))
    expect(r.rows).toEqual([{ canonical_name: 'Blue Ridge Foods' }])
  })

  test('an evidence link must have exactly one target', async () => {
    await expect(asService(db, (tx) =>
      tx.query(`insert into evidence_links (tenant_id, evidence_id, entity_id, fact_id) values ($1, $2, $3, $4)`,
        [t.acme, ids['acme:handbook.pdf:evidence'], ids.blueRidge, ids.salaryFact]))).rejects.toThrow(/check constraint/)
  })
})
