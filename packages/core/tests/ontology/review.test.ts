import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { reviewFact } from '../../src/ontology/canonical'
import { createDb, one } from '../db/harness'

let db: PGlite
let tenantId: string
let subject: string

beforeAll(async () => {
  db = await createDb()
  tenantId = (await one<{ id: string }>(db, `select public.create_tenant('acme', 'Acme', null) as id`)).id
  const type = (await one<{ id: string }>(db, `insert into entity_types (tenant_id, name) values ($1, 'Customer') returning id`, [tenantId])).id
  subject = (await one<{ id: string }>(db, `insert into entities (tenant_id, entity_type_id, canonical_name) values ($1, $2, 'Blue Ridge') returning id`, [tenantId, type])).id
})

const fact = async (value: string) =>
  (
    await one<{ id: string }>(
      db,
      `insert into facts (tenant_id, subject_entity_id, predicate, value, status, metadata) values ($1, $2, 'payment_terms', $3, 'disputed', '{"layer":"canonical"}') returning id`,
      [tenantId, subject, JSON.stringify(value)],
    )
  ).id

describe('fact review', () => {
  test('a correction is a new accepted fact that supersedes the old one, which stays as history', async () => {
    const old = await fact('Net 30')
    const { id } = await reviewFact(db, tenantId, old, { action: 'correct', value: 'Net 60', valid_from: '2025-07-01', note: 'renewal' })
    const now = await one<{ value: string; status: string; supersedes_fact_id: string; valid_from: string }>(db, `select value #>> '{}' value, status, supersedes_fact_id, valid_from::text from facts where id = $1`, [id])
    expect(now).toEqual({ value: 'Net 60', status: 'accepted', supersedes_fact_id: old, valid_from: '2025-07-01' })
    expect((await one<{ status: string }>(db, `select status from facts where id = $1`, [old])).status).toBe('superseded')
    // Every change is versioned.
    expect((await one<{ n: number }>(db, `select count(*)::int n from fact_versions where fact_id = $1`, [old])).n).toBeGreaterThanOrEqual(2)
  })

  test('accept, unknown and reject set the status and mark the fact reviewed', async () => {
    for (const [action, status] of [
      ['accept', 'accepted'],
      ['unknown', 'unknown'],
      ['reject', 'rejected'],
    ] as const) {
      const id = await fact(`v-${action}`)
      await reviewFact(db, tenantId, id, { action })
      const r = await one<{ status: string; reviewed: boolean }>(db, `select status, reviewed_at is not null reviewed from facts where id = $1`, [id])
      expect(r).toEqual({ status, reviewed: true })
    }
  })
})
