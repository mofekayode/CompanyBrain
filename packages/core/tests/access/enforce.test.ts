// Access end to end on real migrations: scopes start held, admins release them,
// hidden scopes are invisible, passages follow their file, requests become grants,
// and only admins can decide.

import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { asUser, catalogFor, decideRequest, type Db, ensureMockUser, requestAccess, setScopeStatus } from '../../src/access/enforce'
import { type AccessProposal, applyAccess, detectPersonalData, matchRule, writeProposal } from '../../src/access/scopes'
import { searchEvidence } from '../../src/workbench/evidence-search'
import { createDb, one } from '../db/harness'

let db: PGlite
let tenantId: string
const people: Record<string, string> = {} // name → principal id
const users: Record<string, string> = {} // name → auth user id
const files: Record<string, string> = {} // path → source object id

beforeAll(async () => {
  db = await createDb()
  tenantId = (await one<{ id: string }>(db, `select public.create_tenant('acme', 'Acme', null) as id`)).id
  const src = (await one<{ id: string }>(db, `insert into sources (tenant_id, kind, name, config) values ($1, 'upload', 'SharePoint', '{"slug":"sp"}') returning id`, [tenantId])).id

  // Company map: three people, two groups.
  for (const name of ['Marcus Bell', 'Karen Liu', 'Sarah Okafor']) {
    people[name] = (
      await one<{ id: string }>(db, `insert into principals (tenant_id, kind, display_name, external_ref, metadata) values ($1, 'user', $2, $3, '{"origin":"company_map"}') returning id`, [
        tenantId,
        name,
        `person:${name}`,
      ])
    ).id
  }
  const group = async (name: string, members: string[]) => {
    const id = (await one<{ id: string }>(db, `insert into principals (tenant_id, kind, display_name, external_ref, metadata) values ($1, 'group', $2, $3, $4) returning id`, [tenantId, name, `group:${name}`, JSON.stringify({ origin: 'company_map', name })])).id
    for (const m of members) await db.query(`insert into principal_members (tenant_id, group_id, member_id) values ($1, $2, $3)`, [tenantId, id, people[m]])
  }
  await group('Louisville Team', ['Marcus Bell'])
  await group('HR', ['Karen Liu'])

  // Files with one passage each.
  for (const [path, content, kind] of [
    ['Louisville/route plan.docx', 'Louisville route plan for the ammonia customers', 'text'],
    ['Louisville/Customers/Big Blue.xlsx', 'Customer | Site\nBig Blue | Hamilton', 'table'],
    ['HR/Comp review 2026/comp.xlsx', 'Employee | Current comp | Proposed\nTyler Brandt | 61000 | 64000', 'table'],
    ['Safety/SOP.pdf', 'Lockout tagout: two-person verification for ammonia', 'text'],
    ['Accounting/payroll notes.txt', 'Direct deposit routing number 041000124 for the payroll account', 'text'],
  ] as const) {
    const so = (
      await one<{ id: string }>(db, `insert into source_objects (tenant_id, source_id, s3_bucket, s3_key, original_path, original_filename, sha256, size_bytes) values ($1, $2, 'b', $3, $4, $5, md5($4) || md5($4), 10) returning id`, [
        tenantId,
        src,
        `t/raw/sp/b/${path}`,
        path,
        path.split('/').pop(),
      ])
    ).id
    files[path] = so
    const doc = (await one<{ id: string }>(db, `insert into documents (tenant_id, source_id, kind, title) values ($1, $2, 'document', $3) returning id`, [tenantId, src, path])).id
    const dv = (
      await one<{ id: string }>(db, `insert into document_versions (tenant_id, document_id, source_object_id, version_number, extractor, extractor_version, extraction_status) values ($1, $2, $3, 1, 'test', '1', 'succeeded') returning id`, [tenantId, doc, so])
    ).id
    await db.query(`update documents set current_version_id = $2 where id = $1`, [doc, dv])
    await db.query(`insert into evidence (tenant_id, document_version_id, ordinal, kind, content) values ($1, $2, 1, $3, $4)`, [tenantId, dv, kind, content])
  }

  const proposal: AccessProposal = {
    scopes: [
      { key: 'all-staff', name: 'All staff', description: 'Company-wide', sensitivity: 'internal', hidden: false, audience: [{ ref: 'Louisville Team', why: 'everyone' }, { ref: 'HR', why: 'everyone' }], evidence: [] },
      { key: 'louisville', name: 'Louisville branch', description: 'Branch files', sensitivity: 'confidential', hidden: false, audience: [{ ref: 'Louisville Team', why: 'branch team' }], evidence: [] },
      { key: 'hr', name: 'HR (restricted)', description: 'HR and pay', sensitivity: 'restricted', hidden: true, audience: [{ ref: 'Karen Liu', why: 'HR manager' }], evidence: [] },
    ],
    rules: [
      { source: 'SharePoint', path_prefix: '', scope_key: 'all-staff', why: 'site root: All Staff' },
      { source: 'SharePoint', path_prefix: 'Louisville', scope_key: 'louisville', why: 'unique permissions' },
      { source: 'SharePoint', path_prefix: 'HR', scope_key: 'hr', why: 'label Highly Confidential - HR' },
    ],
    default_scope_key: 'all-staff',
    personal_data_scope_key: 'hr',
    notes: [],
  }
  await writeProposal(db, tenantId, proposal)
  await applyAccess(db, tenantId)
  users.marcus = await ensureMockUser(db, tenantId, people['Marcus Bell'], 'member')
  users.karen = await ensureMockUser(db, tenantId, people['Karen Liu'], 'member')
  users.sarah = await ensureMockUser(db, tenantId, people['Sarah Okafor'], 'admin')
})

const scopeId = async (key: string) => (await one<{ id: string }>(db, `select id from access_scopes where key = $1`, [key])).id
const catalog = async (who: string) => Object.fromEntries((await catalogFor(db as unknown as Db, tenantId, users[who])).map((f) => [f.original_path, f.can_open]))
const search = (who: string, q: string) => asUser(db as unknown as Db, users[who], (tx) => searchEvidence(tenantId, q, { db: tx })).then((r) => r.hits.map((h) => h.file_path))

describe('rules and detectors', () => {
  test('longest matching folder prefix wins', () => {
    const rules = [
      { source: 'S', path_prefix: '', scope_key: 'a', why: '' },
      { source: 'S', path_prefix: 'HR', scope_key: 'b', why: '' },
      { source: 'S', path_prefix: 'HR/Comp', scope_key: 'c', why: '' },
    ]
    expect(matchRule({ id: '1', source: 'S', path: 'HR/Comp/x.xlsx' }, rules)?.scope_key).toBe('c')
    expect(matchRule({ id: '1', source: 'S', path: 'HRX/y' }, rules)?.scope_key).toBe('a')
    expect(matchRule({ id: '1', source: 'T', path: 'HR/y' }, rules)).toBeNull()
  })

  test('personal data: SSNs, bank numbers, birth dates, and pay next to people (not price lists)', () => {
    expect(detectPersonalData('SSN 123-45-6789', 'text').map((h) => h.kind)).toEqual(['ssn'])
    expect(detectPersonalData('routing number 041000124', 'text').map((h) => h.kind)).toEqual(['bank_account'])
    expect(detectPersonalData('Employee | Rate\nTyler | 31.50', 'table').map((h) => h.kind)).toEqual(['personal_pay'])
    expect(detectPersonalData('Service | Rate\nLabor | 132', 'table')).toEqual([])
  })

  test('a file with bank details outside a restricted folder is escalated and flagged', async () => {
    const fa = await one<{ sensitivity: string; flagged: boolean; origin: string }>(db, `select sensitivity, flagged, origin from file_access where source_object_id = $1`, [files['Accounting/payroll notes.txt']])
    expect(fa).toEqual({ sensitivity: 'restricted', flagged: true, origin: 'detector' })
  })
})

describe('held → released', () => {
  test('before release nobody but admins can open anything; hidden scopes are not even listed', async () => {
    const m = await catalog('marcus')
    expect(Object.values(m).every((open) => open === false)).toBe(true)
    expect(m['HR/Comp review 2026/comp.xlsx']).toBeUndefined()
    expect(m['Accounting/payroll notes.txt']).toBeUndefined() // escalated into hidden HR
    expect(Object.keys(m).sort()).toEqual(['Louisville/Customers/Big Blue.xlsx', 'Louisville/route plan.docx', 'Safety/SOP.pdf'])
    expect(Object.values(await catalog('sarah')).every(Boolean)).toBe(true) // admin
    expect(await search('marcus', 'ammonia')).toEqual([])
  })

  test('releasing scopes opens them to their audience only; passages follow their file', async () => {
    for (const key of ['all-staff', 'louisville', 'hr']) await setScopeStatus(db as unknown as Db, tenantId, await scopeId(key), 'released', users.sarah)
    const m = await catalog('marcus')
    expect(m['Louisville/route plan.docx']).toBe(true)
    expect(m['Safety/SOP.pdf']).toBe(true)
    expect(m['HR/Comp review 2026/comp.xlsx']).toBeUndefined()
    const k = await catalog('karen')
    expect(k['HR/Comp review 2026/comp.xlsx']).toBe(true)
    expect(k['Louisville/route plan.docx']).toBe(false) // listed, locked
    expect((await search('marcus', 'ammonia')).sort()).toEqual(['Louisville/route plan.docx', 'Safety/SOP.pdf'])
    expect(await search('karen', 'ammonia')).toEqual(['Safety/SOP.pdf'])
    expect(await search('marcus', 'Tyler comp')).toEqual([])
  })
})

describe('requests', () => {
  test('a member cannot request a hidden file, and cannot decide requests', async () => {
    await expect(requestAccess(db as unknown as Db, tenantId, users.marcus, { fileId: files['HR/Comp review 2026/comp.xlsx'] }, 'curious')).rejects.toThrow(/not found/)
    const id = await requestAccess(db as unknown as Db, tenantId, users.karen, { fileId: files['Louisville/route plan.docx'] }, 'covering Louisville HR visit')
    await expect(decideRequest(db as unknown as Db, tenantId, users.marcus, id, { approve: true })).rejects.toThrow()
    expect((await catalogFor(db as unknown as Db, tenantId, users.karen)).find((f) => f.original_path === 'Louisville/route plan.docx')?.requested).toBe(true)
  })

  test('approving a file request opens that file only', async () => {
    const pending = await one<{ id: string }>(db, `select id from access_requests where status = 'pending'`)
    await decideRequest(db as unknown as Db, tenantId, users.sarah, pending.id, { approve: true, level: 'file' })
    const k = await catalog('karen')
    expect(k['Louisville/route plan.docx']).toBe(true)
    expect(k['Louisville/Customers/Big Blue.xlsx']).toBe(false)
    const audit = await db.query<{ action: string }>(`select action from access_audit order by created_at`)
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['scope.released', 'request.created', 'request.approved']))
  })

  test('holding a scope again closes it (except individual grants)', async () => {
    await setScopeStatus(db as unknown as Db, tenantId, await scopeId('louisville'), 'held', users.sarah)
    expect((await catalog('marcus'))['Louisville/route plan.docx']).toBe(false)
    expect((await catalog('karen'))['Louisville/route plan.docx']).toBe(true)
  })
})
