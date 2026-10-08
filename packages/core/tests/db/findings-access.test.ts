import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, expect, test } from 'vitest'
import { asService, asUser, createDb, createUser, one } from './harness'

let db: PGlite
let fde: string
let tech: string

beforeAll(async () => {
  db = await createDb()
  fde = await createUser(db, 'fde@example.com')
  tech = await createUser(db, 'tech@example.com')
  await asService(db, async (tx) => {
    const t = (await one<{ id: string }>(tx, `select public.create_tenant('acme', 'Acme', null) as id`)).id
    await tx.query(`insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'fde'), ($1, $3, 'member')`, [t, fde, tech])
    await tx.query(`insert into discovery_findings (tenant_id, question_id, answer) values ($1, 'p4.key_people', 'Dave is a key-person risk; termination letter found')`, [t])
    await tx.query(`insert into workbench_notes (tenant_id, title, body) values ($1, 'Internal summary', 'internal')`, [t])
  })
})

test('findings and notes are FDE-only: a plain member sees neither', async () => {
  expect((await asUser(db, fde, (tx) => tx.query(`select 1 from discovery_findings`))).rows).toHaveLength(1)
  expect((await asUser(db, fde, (tx) => tx.query(`select 1 from workbench_notes`))).rows).toHaveLength(1)
  expect((await asUser(db, tech, (tx) => tx.query(`select 1 from discovery_findings`))).rows).toHaveLength(0)
  expect((await asUser(db, tech, (tx) => tx.query(`select 1 from workbench_notes`))).rows).toHaveLength(0)
})
