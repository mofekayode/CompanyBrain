// S3 key layout. One bucket, one prefix per tenant, three zones:
//
//   {tenant_id}/raw/{source}/{batch}/{original path}   exact evidence as received (immutable)
//   {tenant_id}/processed/{kind}/{document_version_id}/{artifact}   machine-readable representations
//   {tenant_id}/derived/{kind}/{document_version_id}/{artifact}     generated artifacts (keyframes, thumbnails, ...)
//
// Raw keys keep the original folder hierarchy under a delivery batch
// (e.g. "2026-10-02-ridgeline-vdr"), so the same path can arrive again in a
// later delivery without colliding with the immutable first copy.

export const ZONES = ['raw', 'processed', 'derived'] as const
export type Zone = (typeof ZONES)[number]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/

function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new Error(`${what} must be a lowercase UUID, got "${value}"`)
}

function assertSlug(value: string, what: string): void {
  if (!SLUG.test(value)) throw new Error(`${what} must match ${SLUG}, got "${value}"`)
}

/** Normalizes a path from a source system into a safe relative key suffix. Keeps names exactly, spaces and all. */
export function normalizeOriginalPath(originalPath: string): string {
  const segments = originalPath.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) throw new Error('original path is empty')
  if (segments.includes('..')) throw new Error(`original path must not contain "..": ${originalPath}`)
  return segments.join('/')
}

export function tenantPrefix(tenantId: string, zone: Zone): string {
  assertUuid(tenantId, 'tenantId')
  return `${tenantId}/${zone}/`
}

export function rawKey(p: { tenantId: string; sourceSlug: string; batch: string; originalPath: string }): string {
  assertSlug(p.sourceSlug, 'sourceSlug')
  assertSlug(p.batch, 'batch')
  return `${tenantPrefix(p.tenantId, 'raw')}${p.sourceSlug}/${p.batch}/${normalizeOriginalPath(p.originalPath)}`
}

export function processedKey(p: { tenantId: string; kind: string; documentVersionId: string; artifact: string }): string {
  return artifactKey('processed', p)
}

export function derivedKey(p: { tenantId: string; kind: string; documentVersionId: string; artifact: string }): string {
  return artifactKey('derived', p)
}

function artifactKey(
  zone: 'processed' | 'derived',
  p: { tenantId: string; kind: string; documentVersionId: string; artifact: string },
): string {
  assertSlug(p.kind, 'kind')
  assertUuid(p.documentVersionId, 'documentVersionId')
  return `${tenantPrefix(p.tenantId, zone)}${p.kind}/${p.documentVersionId}/${normalizeOriginalPath(p.artifact)}`
}
