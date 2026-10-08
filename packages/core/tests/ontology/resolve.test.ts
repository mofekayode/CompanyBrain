import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { normalizeName } from '../../src/ontology/load'
import { containsName, mergeInto, mergeMany } from '../../src/ontology/resolve'
import { createDb, one } from '../db/harness'

describe('names', () => {
  test('normalizeName drops case, punctuation, legal suffixes and parentheses', () => {
    expect(normalizeName('The Kemper Molding Co., Inc.')).toBe('kemper molding')
    expect(normalizeName('Greg Whitfield (Deactivated User)')).toBe('greg whitfield')
    expect(normalizeName('Queen City Paper & Packaging')).toBe('queen city paper and packaging')
  })
  test('containsName: one name’s words are a prefix-subset of the other’s', () => {
    expect(containsName('kemper', 'kemper molding')).toBe(true)
    expect(containsName('mill creek', 'mill creek rendering')).toBe(true)
    // Ambiguous short names are candidates for review (never merged without the AI/FDE deciding).
    expect(containsName('blue', 'blue ridge food processing')).toBe(true)
    expect(containsName('co', 'columbus branch')).toBe(false) // too short to mean anything
    expect(containsName('ohio valley cold storage', 'ohio river dairy')).toBe(false)
  })
})

describe('merging', () => {
  let db: PGlite
  let tenantId: string
  let customer: string
  let rel: string
  const entity = async (name: string, system: string, id: string) => {
    const e = (await one<{ id: string }>(db, `insert into entities (tenant_id, entity_type_id, canonical_name, properties, metadata) values ($1, $2, $3, $4, '{"origin":"structured"}') returning id`, [tenantId, customer, name, JSON.stringify({ source_system: system })])).id
    await db.query(`insert into entity_identifiers (tenant_id, entity_id, system, value) values ($1, $2, $3, $4)`, [tenantId, e, system, id])
    return e
  }

  beforeAll(async () => {
    db = await createDb()
    tenantId = (await one<{ id: string }>(db, `select public.create_tenant('acme', 'Acme', null) as id`)).id
    customer = (await one<{ id: string }>(db, `insert into entity_types (tenant_id, name) values ($1, 'Customer') returning id`, [tenantId])).id
    const wo = (await one<{ id: string }>(db, `insert into entity_types (tenant_id, name, metadata) values ($1, 'Work Order', '{"kind":"event"}') returning id`, [tenantId])).id
    rel = (await one<{ id: string }>(db, `insert into relationship_types (tenant_id, name) values ($1, 'for_customer') returning id`, [tenantId])).id
    // Three records of one customer in three systems, each with work orders.
    const a = await entity('Mill Creek Rendering', 'QuickBooks', 'Q-1')
    const b = await entity('Mill Crek', 'Legacy', '3')
    const c = await entity('Mill Creek Rendering Co.', 'HubSpot', 'H-9')
    for (const [target, n] of [[a, 3], [b, 2], [c, 1]] as const) {
      for (let i = 0; i < n; i++) {
        const w = (await one<{ id: string }>(db, `insert into entities (tenant_id, entity_type_id, canonical_name) values ($1, $2, $3) returning id`, [tenantId, wo, `WO ${target}-${i}`])).id
        await db.query(`insert into relationships (tenant_id, relationship_type_id, source_entity_id, target_entity_id) values ($1, $2, $3, $4)`, [tenantId, rel, w, target])
      }
    }
  })

  test('mergeMany moves every link, identifier and name to the survivor and marks the rest merged', async () => {
    const [a, b, c] = (await db.query<{ id: string }>(`select id from entities where entity_type_id = $1 order by canonical_name`, [customer])).rows.map((r) => r.id)
    // Order by name: "Mill Creek Rendering", "Mill Creek Rendering Co.", "Mill Crek"
    expect(await mergeMany(db, tenantId, [{ survivor: a, others: [a, b, c] }], 'test')).toBe(2)
    expect((await one<{ n: number }>(db, `select count(*)::int n from relationships where target_entity_id = $1`, [a])).n).toBe(6)
    expect((await db.query<{ system: string }>(`select system from entity_identifiers where entity_id = $1 order by system`, [a])).rows.map((r) => r.system)).toEqual(['HubSpot', 'Legacy', 'QuickBooks'])
    const aliases = (await db.query<{ alias: string }>(`select alias from entity_aliases where entity_id = $1 order by alias`, [a])).rows.map((r) => r.alias)
    expect(aliases).toEqual(['Mill Creek Rendering Co.', 'Mill Crek'])
    expect((await db.query<{ status: string; merged_into_id: string }>(`select status, merged_into_id from entities where id = any($1::uuid[])`, [[b, c]])).rows).toEqual([
      { status: 'merged', merged_into_id: a },
      { status: 'merged', merged_into_id: a },
    ])
  })

  test('mergeInto removes duplicate edges created by the move', async () => {
    const [a] = (await db.query<{ id: string }>(`select id from entities where entity_type_id = $1 and status = 'candidate' order by canonical_name`, [customer])).rows.map((r) => r.id)
    const d = await entity('Mill Creek', 'Sheet', 'S-1')
    const someWo = (await one<{ source_entity_id: string }>(db, `select source_entity_id from relationships where target_entity_id = $1 limit 1`, [a])).source_entity_id
    await db.query(`insert into relationships (tenant_id, relationship_type_id, source_entity_id, target_entity_id) values ($1, $2, $3, $4)`, [tenantId, rel, someWo, d])
    await mergeInto(db, tenantId, a, [d], 'test')
    expect((await one<{ n: number }>(db, `select count(*)::int n from relationships where target_entity_id = $1`, [a])).n).toBe(6)
  })
})
