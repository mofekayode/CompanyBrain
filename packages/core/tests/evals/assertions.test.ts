import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { assertionSql } from '../../src/evals/generate'
import { createDb, one } from '../db/harness'

let db: PGlite
let tenantId: string

beforeAll(async () => {
  db = await createDb()
  tenantId = (await one<{ id: string }>(db, `select public.create_tenant('acme', 'Acme', null) as id`)).id
  const customer = (await one<{ id: string }>(db, `insert into entity_types (tenant_id, name) values ($1, 'Customer') returning id`, [tenantId])).id
  const branch = (await one<{ id: string }>(db, `insert into entity_types (tenant_id, name) values ($1, 'Branch') returning id`, [tenantId])).id
  const br = (await one<{ id: string }>(db, `insert into entities (tenant_id, entity_type_id, canonical_name) values ($1, $2, 'Blue Ridge Food Processing') returning id`, [tenantId, customer])).id
  await db.query(`insert into entity_aliases (tenant_id, entity_id, alias, kind) values ($1, $2, 'Big Blue', 'jargon')`, [tenantId, br])
  for (const b of ['Oakley', 'Louisville', 'Columbus']) await db.query(`insert into entities (tenant_id, entity_type_id, canonical_name) values ($1, $2, $3)`, [tenantId, branch, b])
  const old = (
    await one<{ id: string }>(db, `insert into facts (tenant_id, subject_entity_id, predicate, value, valid_to, status, metadata) values ($1, $2, 'payment_terms', '"Net 30"', '2025-07-01', 'superseded', '{"layer":"canonical"}') returning id`, [tenantId, br])
  ).id
  await db.query(`insert into facts (tenant_id, subject_entity_id, predicate, value, valid_from, status, supersedes_fact_id, metadata) values ($1, $2, 'payment_terms', '"Net 60"', '2025-07-01', 'accepted', $3, '{"layer":"canonical"}')`, [tenantId, br, old])
})

const check = async (sql: string) => one<{ passed: boolean; detail: string }>(db, sql, [tenantId])

describe('typed assertions → SQL', () => {
  test('alias resolves to exactly one entity', async () => {
    expect((await check(assertionSql({ type: 'alias_resolves', entity_type: 'Customer', alias: 'Big Blue', entity: 'Blue Ridge Food Processing' }))).passed).toBe(true)
    expect((await check(assertionSql({ type: 'alias_resolves', entity_type: 'Customer', alias: 'Big Blue', entity: 'Somebody Else' }))).passed).toBe(false)
  })
  test('entity counts in a range', async () => {
    expect((await check(assertionSql({ type: 'entity_count', entity_type: 'Branch', min: 3, max: 3 }))).passed).toBe(true)
  })
  test('fact value as of a date picks the right period', async () => {
    expect((await check(assertionSql({ type: 'fact_value', subject: 'Big Blue', predicate_hint: 'terms', value_hint: '60', as_of: '2026-01-01' }))).passed).toBe(true)
    expect((await check(assertionSql({ type: 'fact_value', subject: 'Big Blue', predicate_hint: 'terms', value_hint: '30', as_of: '2024-06-01' }))).passed).toBe(true)
    expect((await check(assertionSql({ type: 'fact_value', subject: 'Big Blue', predicate_hint: 'terms', value_hint: '30', as_of: '2026-01-01' }))).passed).toBe(false)
  })
  test("quotes in names can't break the SQL", async () => {
    expect((await check(assertionSql({ type: 'alias_resolves', entity_type: 'Customer', alias: "O'Brien'; drop table facts; --", entity: 'x' }))).passed).toBe(false)
  })
})
