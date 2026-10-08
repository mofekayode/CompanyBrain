import { describe, expect, test } from 'vitest'
import { S3ObjectStore } from '../../src/storage/object-store'
import { sha256Hex } from '../../src/storage/raw'

// Opt-in: S3_LIVE=1 npm test. Uses a fixed key under the _smoke prefix so reruns
// do not accumulate objects (raw objects can never be deleted).
const live = process.env.S3_LIVE === '1'
const BUCKET = process.env.S3_BUCKET ?? 'company-brain-787137578043'
const KEY = '_smoke/raw/s3-object-store-live-test.txt'
const BODY = new TextEncoder().encode('company brain S3ObjectStore live test v1\n')

describe.runIf(live)('S3ObjectStore against the real bucket', () => {
  const store = new S3ObjectStore(BUCKET)

  test('write-once: first put creates (or already exists), sha256 is recorded', async () => {
    expect(['created', 'exists']).toContain(await store.putIfAbsent(KEY, BODY, { sha256Hex: sha256Hex(BODY), contentType: 'text/plain' }))
    expect(await store.head(KEY)).toMatchObject({ sha256Hex: sha256Hex(BODY), size: BODY.byteLength })
  })

  test('a second put never overwrites', async () => {
    const other = new TextEncoder().encode('tampered')
    expect(await store.putIfAbsent(KEY, other, { sha256Hex: sha256Hex(other) })).toBe('exists')
    expect(new TextDecoder().decode((await store.get(KEY)) ?? undefined)).toBe(new TextDecoder().decode(BODY))
  })

  test('S3 rejects bytes that do not match the declared sha256', async () => {
    const body = new TextEncoder().encode('real bytes')
    await expect(store.putIfAbsent(`_smoke/processed/bad-checksum-${Date.now()}.txt`, body, { sha256Hex: sha256Hex(new TextEncoder().encode('other')) }))
      .rejects.toThrow()
  })
})
