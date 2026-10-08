import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { cutPassages, type EvRow } from '../../src/search/project'
import { type Dictionary, linkText } from '../../src/search/linker'
import { understand } from '../../src/search/search'
import { createDb, one } from '../db/harness'

const row = (o: Partial<EvRow>): EvRow => ({
  id: crypto.randomUUID(),
  dv: 'dv1',
  ordinal: 0,
  kind: 'text',
  content: '',
  page_number: null,
  start_ms: null,
  end_ms: null,
  speaker: null,
  observed_at: null,
  locator: {},
  acl_id: 'acl1',
  so_id: 'so1',
  path: 'Ops/file.pdf',
  source_name: 'SharePoint',
  ...o,
})

describe('chunking', () => {
  test('tables become 12-row windows with the header repeated', () => {
    const lines = ['WO # | Customer | Notes', ...Array.from({ length: 30 }, (_, i) => `${100 + i} | Kemper | note ${i}`)]
    const out = cutPassages([row({ kind: 'table', content: lines.join('\n'), locator: { sheet: 'CSV', row_start: 41 } })])
    expect(out).toHaveLength(3)
    expect(out.every((p) => p.content.startsWith('WO # | Customer | Notes'))).toBe(true)
    expect(out[1].citation).toMatchObject({ row_start: 53, row_end: 64 })
    expect(out[2].title).toContain('rows 65–70')
  })
  test('transcript segments merge into ~90 s windows', () => {
    const segs = Array.from({ length: 10 }, (_, i) => row({ kind: 'transcript_segment', content: `[0:${i}] Speaker 1: line ${i}`, start_ms: i * 20_000, end_ms: i * 20_000 + 18_000, speaker: 'Speaker 1', ordinal: i }))
    const out = cutPassages(segs)
    expect(out.length).toBeGreaterThan(1)
    expect(out.length).toBeLessThan(5)
    expect(out[0].citation).toMatchObject({ start_ms: 0 })
    expect(out[0].evidence_ids.length).toBeGreaterThan(2)
  })
  test('tiny text pieces merge; emails keep one passage with a dedupe key', () => {
    const tiny = Array.from({ length: 6 }, (_, i) => row({ content: `Short line ${i}.`, ordinal: i, page_number: 1 + Math.floor(i / 3) }))
    expect(cutPassages(tiny)).toHaveLength(1)
    const mail = cutPassages([row({ kind: 'email_body', content: 'From: Linda Marsh <l@x.com>\nSubject: Harmon plan\nDate: 2026-05-14\n\nBody', locator: { message_id: 'abc@x' } })])
    expect(mail[0]).toMatchObject({ dedupe_key: 'msg:abc@x', title: 'Harmon plan · Linda Marsh' })
  })
})

describe('entity linking', () => {
  const dict: Dictionary = {
    phrases: new Map([
      ['big blue', new Set(['br'])],
      ['blue ridge food processing', new Set(['br'])],
      ['tp 17', new Set(['tp'])],
      ['mike h', new Set(['m1', 'm2'])],
    ]),
    entities: new Map([
      ['br', { name: 'Blue Ridge Food Processing LLC', type: 'Customer', terms: ['Blue Ridge Food Processing LLC', 'Big Blue'] }],
      ['tp', { name: 'TP-17', type: 'Asset', terms: ['TP-17', 'P17'] }],
      ['m1', { name: 'Mike Hargis', type: 'Person', terms: [] }],
      ['m2', { name: 'Mike Hargrove', type: 'Person', terms: [] }],
    ]),
    maxTokens: 4,
  }
  test('aliases, codes; ambiguous names are skipped', () => {
    expect(linkText(dict, 'Big Blue says TP-17 failed again; ask Mike H').map((e) => e.id)).toEqual(['br', 'tp'])
  })
  test('query understanding: entities, years, current vs history', () => {
    const u = understand(dict, 'What did Big Blue pay in 2024?')
    expect(u.entities.map((e) => e.name)).toEqual(['Blue Ridge Food Processing LLC'])
    expect(u.asOf).toBe('2024-07-01')
    expect(understand(dict, 'current terms').preferCurrent).toBe(true)
    expect(understand(dict, 'what were the terms before the amendment').time.anchor).toEqual({ phrase: 'amendment', relation: 'before' })
    expect(understand(dict, 'how have the terms changed').history).toBe(true)
  })
})

describe('change outbox', () => {
  let db: PGlite
  let tenant: string
  beforeAll(async () => {
    db = await createDb()
    tenant = (await one<{ id: string }>(db, `select public.create_tenant('acme', 'Acme', null) as id`)).id
  })
  test('renames, aliases, facts and access changes are queued for the search sync', async () => {
    const type = (await one<{ id: string }>(db, `insert into entity_types (tenant_id, name) values ($1, 'Customer') returning id`, [tenant])).id
    const e = (await one<{ id: string }>(db, `insert into entities (tenant_id, entity_type_id, canonical_name) values ($1, $2, 'Kemper Molding') returning id`, [tenant, type])).id
    await db.query(`update entities set canonical_name = 'Kemper Plastics Corp.' where id = $1`, [e])
    await db.query(`insert into entity_aliases (tenant_id, entity_id, alias, kind) values ($1, $2, 'Kemper Molding', 'former_name')`, [tenant, e])
    await db.query(`insert into facts (tenant_id, subject_entity_id, predicate, value, status, metadata) values ($1, $2, 'payment_terms', '"Net 30"', 'accepted', '{"layer":"canonical"}')`, [tenant, e])
    await db.query(`insert into facts (tenant_id, subject_entity_id, predicate, value, status, metadata) values ($1, $2, 'note', '"x"', 'candidate', '{"layer":"claim"}')`, [tenant, e])
    const rows = (await db.query<{ kind: string; ref: string }>(`select kind, ref from search_outbox where tenant_id = $1 order by id`, [tenant])).rows
    expect(rows.map((r) => r.kind)).toEqual(['entity', 'entity', 'fact'])
    expect(rows[0].ref).toBe(e)
  })
})
