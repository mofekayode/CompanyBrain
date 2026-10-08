import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { MemoryObjectStore } from '../../src/storage/object-store'
import { landRawObject, RawConflictError, sha256Hex } from '../../src/storage/raw'
import { asService, createDb, one } from '../db/harness'

const enc = (s: string) => new TextEncoder().encode(s)

let db: PGlite
let tenantId: string
let source: { id: string; slug: string }
const store = new MemoryObjectStore('company-brain-test')

beforeAll(async () => {
  db = await createDb()
  await asService(db, async (tx) => {
    tenantId = (await one<{ id: string }>(tx, `select public.create_tenant('acme', 'Acme', null) as id`)).id
    const id = (await one<{ id: string }>(tx, `insert into sources (tenant_id, kind, name) values ($1, 'fileserver', 'Old S drive') returning id`, [tenantId])).id
    source = { id, slug: 'old-s-drive' }
  })
})

const land = (originalPath: string, content: string, extra: object = {}) =>
  asService(db, (sql) => landRawObject({ tenantId, source, batch: '2026-10-02-it-exports', originalPath, bytes: enc(content), ...extra }, { store, sql }))

describe('landing raw evidence', () => {
  test('stores the bytes write-once and records full provenance', async () => {
    const modified = new Date('2019-03-04T05:06:07Z')
    const landed = await land('Ops/Pricing/FINAL pricing (2).xlsx', 'v1 bytes', {
      sourceModifiedAt: modified, sourceOwner: 'linda', sourcePermissions: { sharepoint: ['Ops'] },
    })
    expect(landed.created).toBe(true)
    expect(landed.s3Key).toBe(`${tenantId}/raw/old-s-drive/2026-10-02-it-exports/Ops/Pricing/FINAL pricing (2).xlsx`)
    expect(store.objects.get(landed.s3Key)?.metadata['original-path']).toBe(encodeURIComponent('Ops/Pricing/FINAL pricing (2).xlsx'))

    const row = await one<Record<string, unknown>>(db, `select * from source_objects where id = $1`, [landed.id])
    expect(row).toMatchObject({
      original_path: 'Ops/Pricing/FINAL pricing (2).xlsx',
      original_filename: 'FINAL pricing (2).xlsx',
      s3_bucket: 'company-brain-test',
      sha256: sha256Hex(enc('v1 bytes')),
      size_bytes: 8,
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      source_owner: 'linda',
      source_permissions: { sharepoint: ['Ops'] },
      status: 'landed',
    })
    expect((row.source_modified_at as Date).toISOString()).toBe(modified.toISOString())
  })

  test('re-landing the same file is idempotent and leaves provenance untouched', async () => {
    const first = await land('Ops/handbook.pdf', 'handbook')
    const before = await one<{ updated_at: Date }>(db, `select updated_at from source_objects where id = $1`, [first.id])
    const again = await land('Ops/handbook.pdf', 'handbook')
    const after = await one<{ updated_at: Date }>(db, `select updated_at from source_objects where id = $1`, [first.id])
    expect(again).toMatchObject({ id: first.id, created: false })
    expect(after.updated_at).toEqual(before.updated_at)
  })

  test('different bytes at an existing raw key is refused', async () => {
    await land('Ops/policy.docx', 'original')
    await expect(land('Ops/policy.docx', 'tampered')).rejects.toThrow(RawConflictError)
    expect(new TextDecoder().decode(await store.get(`${tenantId}/raw/old-s-drive/2026-10-02-it-exports/Ops/policy.docx`) ?? undefined)).toBe('original')
  })

  test('duplicates are preserved: same bytes at another path is its own object', async () => {
    const a = await land('Ops/forms/w9.pdf', 'same bytes')
    const b = await land('Linda USB/w9 (copy).pdf', 'same bytes')
    expect(a.id).not.toBe(b.id)
    expect(a.sha256).toBe(b.sha256)
  })

  test('the same path in a later delivery batch lands alongside the first, not over it', async () => {
    const first = await land('Ops/rates.csv', 'old rates')
    const later = await asService(db, (sql) => landRawObject(
      { tenantId, source, batch: '2026-11-01-resync', originalPath: 'Ops/rates.csv', bytes: enc('new rates') }, { store, sql }))
    expect(later.s3Key).not.toBe(first.s3Key)
    expect(new TextDecoder().decode(await store.get(first.s3Key) ?? undefined)).toBe('old rates')
  })
})
