import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { detectPersonalData } from '../../src/access/scopes'
import { exportTenant, importTenant } from '../../src/config/export'
import { compileRules, DEFAULT_RULES, diffRules, mergeRules, rulesFor, saveOverrides, validateRules } from '../../src/config/tenant-config'
import { multi, normalizeName } from '../../src/ontology/load'
import type { Sql } from '../../src/storage/raw'
import { createDb, one } from '../db/harness'

let db: PGlite
let sql: Sql
let acme: string
let beta: string

beforeAll(async () => {
  db = await createDb()
  sql = db as unknown as Sql
  acme = (await one<{ id: string }>(db, `select public.create_tenant('acme', 'Acme', null) as id`)).id
  beta = (await one<{ id: string }>(db, `select public.create_tenant('beta', 'Beta', null) as id`)).id
})

describe('rules: defaults + overrides', () => {
  test('merge keeps untouched keys and replaces arrays/patterns wholesale', () => {
    const r = mergeRules(DEFAULT_RULES, { resolution: { small_type_max: 40 }, cleaning: { legal_suffixes: ['gmbh'] } })
    expect(r.resolution.small_type_max).toBe(40)
    expect(r.resolution.max_fuzzy).toBe(DEFAULT_RULES.resolution.max_fuzzy)
    expect(r.cleaning.legal_suffixes).toEqual(['gmbh'])
    expect(r.cleaning.placeholder_values).toEqual(DEFAULT_RULES.cleaning.placeholder_values)
  })
  test('diff stores only what differs', () => {
    expect(diffRules(DEFAULT_RULES)).toEqual({})
    expect(diffRules(mergeRules(DEFAULT_RULES, { authority: { rank: { ...DEFAULT_RULES.authority.rank, email: 3 } } }))).toEqual({ authority: { rank: { ...DEFAULT_RULES.authority.rank, email: 3 } } })
  })
  test('bad patterns are rejected', () => {
    expect(validateRules(mergeRules(DEFAULT_RULES, { cleaning: { code_list: { pattern: '([' } } }))).toHaveLength(1)
  })
  test('compiled rules drive cleaning and detectors', () => {
    const r = compileRules(mergeRules(DEFAULT_RULES, { cleaning: { placeholder_values: { pattern: '^(tbd|ohne)$', flags: 'i' }, legal_suffixes: ['gmbh', 'ag'] } }))
    expect(multi('Tech', 'OHNE', r)).toEqual([])
    expect(multi('Tech', 'UNASSIGNED', r)).toEqual(['UNASSIGNED'])
    expect(normalizeName('Müller Pumpen GmbH', r)).toBe('m ller pumpen')
    const noSsn = compileRules(mergeRules(DEFAULT_RULES, { personal_data: { ssn: { pattern: 'NEVER-MATCH-\\d{20}' } } }))
    expect(detectPersonalData('SSN 123-45-6789', 'text').map((h) => h.kind)).toContain('ssn')
    expect(detectPersonalData('SSN 123-45-6789', 'text', noSsn).map((h) => h.kind)).not.toContain('ssn')
  })
})

describe('stored per tenant', () => {
  test('saving a version changes only that tenant', async () => {
    const saved = await saveOverrides(sql, acme, { resolution: { small_type_max: 50 } }, 'more whole-type review')
    expect(saved).toEqual({ version: 1, problems: [] })
    expect((await rulesFor(sql, acme)).resolution.small_type_max).toBe(50)
    expect((await rulesFor(sql, beta)).resolution.small_type_max).toBe(DEFAULT_RULES.resolution.small_type_max)
  })
  test('invalid overrides are refused', async () => {
    const saved = await saveOverrides(sql, acme, { cleaning: { code_list: { pattern: '((' } } }, 'broken')
    expect(saved.version).toBe(0)
    expect(saved.problems[0]).toMatch(/code_list/)
  })
})

describe('export / import', () => {
  test('template carries rules and types, not client data', async () => {
    await saveOverrides(sql, acme, { resolution: { small_type_max: 50 }, prompts: { company_context: 'Acme makes anvils' } }, 'context')
    await db.query(`insert into entity_types (tenant_id, name, description, status) values ($1, 'Customer', 'who we bill', 'active'), ($1, 'Site', null, 'active')`, [acme])
    await db.query(
      `insert into relationship_types (tenant_id, name, source_type_id, target_type_id, status)
       select $1, 'located_at', s.id, c.id, 'active' from entity_types s, entity_types c where s.tenant_id = $1 and c.tenant_id = $1 and s.name = 'Site' and c.name = 'Customer'`,
      [acme],
    )
    const t = await exportTenant(sql, acme, 'template')
    expect(t.rules).toEqual({ resolution: { small_type_max: 50 } })
    expect(t.ontology.entity_types.map((x) => x.name)).toEqual(['Customer', 'Site'])
    expect(t.vocabulary).toBeUndefined()
    expect(t.access).toBeUndefined()

    const report = await importTenant(sql, beta, t)
    expect(report.entity_types).toBe(2)
    expect(report.relationship_types).toBe(1)
    expect((await rulesFor(sql, beta)).resolution.small_type_max).toBe(50)
    // Imported into another client, types arrive as proposals for the FDE to accept.
    expect((await one<{ status: string }>(db, `select status from entity_types where tenant_id = $1 and name = 'Customer'`, [beta])).status).toBe('proposed')
    // Re-import is a no-op.
    const again = await importTenant(sql, beta, t)
    expect(again.rules).toBe('unchanged')
    expect(again.entity_types).toBe(0)
  })

  test('full export keeps vocabulary, including rejected aliases', async () => {
    const type = (await one<{ id: string }>(db, `select id from entity_types where tenant_id = $1 and name = 'Customer'`, [acme])).id
    const e = (await one<{ id: string }>(db, `insert into entities (tenant_id, entity_type_id, canonical_name) values ($1, $2, 'Blue Ridge Foods') returning id`, [acme, type])).id
    await db.query(`insert into entity_aliases (tenant_id, entity_id, alias, kind, status) values ($1, $2, 'Big Blue', 'jargon', 'confirmed'), ($1, $2, 'P17', 'jargon', 'rejected')`, [acme, e])
    const full = await exportTenant(sql, acme, 'full')
    expect(full.vocabulary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alias: 'Big Blue', status: 'confirmed' }),
        expect.objectContaining({ alias: 'P17', status: 'rejected' }),
      ]),
    )
    // Into a tenant that has the same customer: aliases attach; the rejected one stays rejected.
    const btype = (await one<{ id: string }>(db, `select id from entity_types where tenant_id = $1 and name = 'Customer'`, [beta])).id
    await db.query(`insert into entities (tenant_id, entity_type_id, canonical_name) values ($1, $2, 'Blue Ridge Foods')`, [beta, btype])
    const report = await importTenant(sql, beta, { ...full, access: undefined, validation: undefined })
    expect(report.vocabulary.added).toBe(2)
    const rows = (await db.query<{ alias: string; status: string }>(`select alias, status from entity_aliases where tenant_id = $1 order by alias`, [beta])).rows
    expect(rows).toEqual([
      { alias: 'Big Blue', status: 'confirmed' },
      { alias: 'P17', status: 'rejected' },
    ])
  })
})
