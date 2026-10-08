import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { consolidateTimelines, detectTopics, timelines, timelineText } from '../../src/ontology/timeline'
import type { Sql } from '../../src/storage/raw'
import { createDb, one } from '../db/harness'

let db: PGlite
let sql: Sql
let tenant: string
const type = async (name: string) => (await one<{ id: string }>(db, `insert into entity_types (tenant_id, name) values ($1, $2) returning id`, [tenant, name])).id
const entity = async (typeId: string, name: string) => (await one<{ id: string }>(db, `insert into entities (tenant_id, entity_type_id, canonical_name) values ($1, $2, $3) returning id`, [tenant, typeId, name])).id
const fact = async (subject: string, predicate: string, value: string, from: string | null, to: string | null, status = 'accepted') =>
  (
    await one<{ id: string }>(
      db,
      `insert into facts (tenant_id, subject_entity_id, predicate, value, valid_from, valid_to, status, metadata) values ($1, $2, $3, $4, $5, $6, $7, '{"layer":"canonical"}') returning id`,
      [tenant, subject, predicate, JSON.stringify(value), from, to, status],
    )
  ).id
const get = async (id: string) => one<{ status: string; valid_to: string | null; metadata: Record<string, unknown> }>(db, `select status, valid_to::text, metadata from facts where id = $1`, [id])

beforeAll(async () => {
  db = await createDb()
  sql = db as unknown as Sql
  tenant = (await one<{ id: string }>(db, `select public.create_tenant('acme', 'Acme', null) as id`)).id
})

describe('timeline consolidation', () => {
  test('older versions end where the next starts; accepted predecessors become superseded; duplicates fold', async () => {
    const customer = await type('Customer')
    const c = await entity(customer, 'Blue Ridge')
    const net30 = await fact(c, 'payment_terms', 'Net 30', '2022-07-01', null)
    const net60 = await fact(c, 'payment_terms', 'Net 60', '2025-07-01', null)
    const dup1 = await fact(c, 'status', 'Former', '2026-09-01', null, 'superseded')
    await fact(c, 'status', 'Former', '2026-09-30', null)
    const r = await consolidateTimelines(sql, tenant)
    expect(r.closed).toBeGreaterThanOrEqual(1)
    expect(await get(net30)).toMatchObject({ status: 'superseded', valid_to: '2025-07-01' })
    expect((await get(net60)).status).toBe('accepted')
    expect((await get(dup1)).status).toBe('rejected')
    const tl = (await timelines(sql, tenant)).find((t) => t.key.endsWith(':payment_terms'))!
    expect(timelineText(tl.steps)).toBe('Net 30 (Jul 2022 – Jul 2025) → Net 60 (since Jul 2025)')
  })
})

describe('topics across subjects', () => {
  test('a rule recorded on different subjects is linked, and the stale version is flagged', async () => {
    const person = await type('Person')
    const term = await type('Term')
    const dave = await entity(person, 'Dave Brennan')
    const sarah = await entity(person, 'Sarah Okafor')
    const policy = await entity(term, 'Discount approval')
    const old = await fact(policy, 'discount_approval_authority', 'Any discount above 10% must be approved by Dave Brennan', '2019-02-04', null)
    await fact(dave, 'discount_approval_authority', 'Discounts above 10% require Dave', '2019-02-04', '2025-06-01', 'superseded')
    await fact(sarah, 'discount_approval_authority', 'Sarah approves deals up to $75,000; above goes to the Northgate deal committee', '2026-10-19', null)
    const r = await detectTopics(sql, tenant)
    const topic = r.topics.find((t) => t.facts.some((f) => f.subject === 'Sarah Okafor'))
    expect(topic?.kind).toBe('rule')
    expect(topic?.facts.map((f) => f.subject).sort()).toEqual(['Dave Brennan', 'Discount approval', 'Sarah Okafor'])
    expect(r.stale.some((s) => s.startsWith('Discount approval'))).toBe(true)
    expect((await get(old)).metadata.possibly_outdated_by).toBeTruthy()
  }, 60_000)

  test("different customers' own terms are an attribute family, never 'outdated' by each other", async () => {
    const customer = (await one<{ id: string }>(db, `select id from entity_types where tenant_id = $1 and name = 'Customer'`, [tenant])).id
    const a = await entity(customer, 'Tri State Bottling')
    const b = await entity(customer, 'Ohio Valley Cold Storage')
    const fa = await fact(a, 'pm_labor_discount', 'Blue Book standard rate less 10%', '2026-02-01', null)
    const fb = await fact(b, 'pm_labor_discount', 'Blue Book standard rate less 5%', '2024-03-01', null)
    const r = await detectTopics(sql, tenant)
    expect(r.topics.find((t) => t.facts.some((f) => f.subject === 'Tri State Bottling'))?.kind).toBe('attribute')
    expect((await get(fa)).metadata.possibly_outdated_by).toBeUndefined()
    expect((await get(fb)).metadata.possibly_outdated_by).toBeUndefined()
  }, 60_000)
})
