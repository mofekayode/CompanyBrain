import { describe, expect, test } from 'vitest'
import { derivedKey, normalizeOriginalPath, processedKey, rawKey, tenantPrefix } from '../../src/storage/layout'

const T = '0b5e6f0e-1c2d-4e3f-8a9b-0c1d2e3f4a5b'
const V = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a'

describe('S3 key layout', () => {
  test('raw keys keep the original hierarchy and terrible filenames under source/batch', () => {
    expect(rawKey({ tenantId: T, sourceSlug: 'fileserver2', batch: '2026-10-02-it-exports', originalPath: 'Shared/Ops/FINAL pricing (2) copy.xlsx' }))
      .toBe(`${T}/raw/fileserver2/2026-10-02-it-exports/Shared/Ops/FINAL pricing (2) copy.xlsx`)
  })

  test('windows separators, leading slashes and "." segments are normalized', () => {
    expect(normalizeOriginalPath('\\\\S\\Ops\\.\\file.pdf')).toBe('S/Ops/file.pdf')
    expect(normalizeOriginalPath('/a//b/')).toBe('a/b')
  })

  test('path traversal is rejected', () => {
    expect(() => rawKey({ tenantId: T, sourceSlug: 's', batch: 'b', originalPath: 'a/../../other-tenant/x' })).toThrow(/\.\./)
  })

  test('tenant ids must be UUIDs so one tenant can never address another prefix', () => {
    expect(() => tenantPrefix('riverton', 'raw')).toThrow(/UUID/)
    expect(() => tenantPrefix(`${T}/../x`, 'raw')).toThrow(/UUID/)
  })

  test('source and batch must be slugs', () => {
    expect(() => rawKey({ tenantId: T, sourceSlug: 'Old S Drive', batch: 'b', originalPath: 'x' })).toThrow(/sourceSlug/)
    expect(() => rawKey({ tenantId: T, sourceSlug: 's', batch: '../b', originalPath: 'x' })).toThrow(/batch/)
  })

  test('processed and derived artifacts hang off a document version', () => {
    expect(processedKey({ tenantId: T, kind: 'documents', documentVersionId: V, artifact: 'content.md' })).toBe(`${T}/processed/documents/${V}/content.md`)
    expect(derivedKey({ tenantId: T, kind: 'video', documentVersionId: V, artifact: 'keyframes/00012000.jpg' })).toBe(`${T}/derived/video/${V}/keyframes/00012000.jpg`)
  })
})
