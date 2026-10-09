// Elasticsearch: one index per client (`cb-<slug>-v<n>`, reached through the alias
// `cb-<slug>`), holding passages, entity cards and fact cards. Postgres
// (search_documents) is the source of truth; this index can be rebuilt from it.

import { Client, type estypes } from '@elastic/elasticsearch'
import { readEnv } from '../env'
import { DEFAULT_EMBEDDING_VERSION, EMBEDDINGS } from './embed'

let client: Client | undefined
export function es(): Client {
  if (client) return client
  const env = readEnv(['ELASTIC_SEARCH_ENDPOINT', 'ELASTIC_SEARCH_APIKEY'] as const)
  if (!env.ELASTIC_SEARCH_ENDPOINT || !env.ELASTIC_SEARCH_APIKEY) throw new Error('ELASTIC_SEARCH_ENDPOINT / ELASTIC_SEARCH_APIKEY are not set')
  client = new Client({ node: env.ELASTIC_SEARCH_ENDPOINT, auth: { apiKey: env.ELASTIC_SEARCH_APIKEY }, requestTimeout: 60_000 })
  return client
}

export const indexAlias = (slug: string) => `cb-${slug}`
/** The version a fresh index gets (see EMBEDDINGS for each version's model). */
export const MAPPING_VERSION = DEFAULT_EMBEDDING_VERSION
export const indexName = (slug: string, version = MAPPING_VERSION) => `cb-${slug}-v${version}`

/**
 * Field design:
 * - content / title: English analyzer (stemming: "failing" ≈ "failed"), plus `.exact`
 *   (standard analyzer) so codes and names like "TP-17" or "Net 60" match as written.
 * - entity_terms: names + aliases of the entities a passage mentions, so "Big Blue"
 *   finds passages that only say "Blue Ridge" (and vice versa).
 * - acl_principals: who may read the document (users and groups). Every query filters on it.
 * - embedding: a vector from the index version's local model (EMBEDDINGS), cosine, HNSW.
 */
export const mappingFor = (version: number): Pick<estypes.IndicesCreateRequest, 'settings' | 'mappings'> => ({
  settings: {
    number_of_shards: 1,
    analysis: {
      analyzer: {
        path_words: { type: 'pattern', pattern: '[\\W_]+', lowercase: true },
      },
    },
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      tenant_id: { type: 'keyword' },
      doc_type: { type: 'keyword' },
      kind: { type: 'keyword' },
      title: { type: 'text', analyzer: 'english', fields: { exact: { type: 'text', analyzer: 'standard' }, raw: { type: 'keyword', ignore_above: 512 } } },
      content: { type: 'text', analyzer: 'english', fields: { exact: { type: 'text', analyzer: 'standard' } } },
      entity_ids: { type: 'keyword' },
      entity_terms: { type: 'text', analyzer: 'english', fields: { exact: { type: 'text', analyzer: 'standard' } } },
      acl_principals: { type: 'keyword' },
      source_object_id: { type: 'keyword' },
      document_version_id: { type: 'keyword' },
      path: { type: 'text', analyzer: 'path_words', fields: { raw: { type: 'keyword', ignore_above: 1024 } } },
      source_name: { type: 'keyword' },
      observed_at: { type: 'date' },
      valid_from: { type: 'date' },
      valid_to: { type: 'date' },
      is_current: { type: 'boolean' },
      authority: { type: 'keyword' },
      dedupe_key: { type: 'keyword' },
      citation: { type: 'object', enabled: false },
      embedding: { type: 'dense_vector', dims: EMBEDDINGS[version].dims, similarity: 'cosine', index: true },
    },
  },
})
export const MAPPING = mappingFor(MAPPING_VERSION)

/** Creates the versioned index and points the alias at it (no-op when it exists). */
export async function ensureIndex(slug: string, opts: { recreate?: boolean } = {}) {
  // Keep whatever version the alias already points to (an index may have been rebuilt on a newer model).
  const name = indexName(slug, (await aliasedVersion(slug)) ?? MAPPING_VERSION)
  const exists = await es().indices.exists({ index: name })
  if (exists && opts.recreate) await es().indices.delete({ index: name })
  if (!exists || opts.recreate) await es().indices.create({ index: name, ...mappingFor(Number(name.split('-v').pop())) })
  await es().indices.updateAliases({ actions: [{ add: { index: name, alias: indexAlias(slug) } }] })
  return name
}

/** The index version the client's alias points to (null if there is no alias yet). */
export async function aliasedVersion(slug: string): Promise<number | null> {
  try {
    const r = await es().indices.getAlias({ name: indexAlias(slug) })
    const names = Object.keys(r)
    return names.length ? Math.max(...names.map((n) => Number(n.split('-v').pop()))) : null
  } catch {
    return null
  }
}
const activeCache = new Map<string, { at: number; v: number }>()
/** Version to embed questions with for this client (cached briefly; follows an alias swap within a minute). */
export async function activeVersion(slug: string): Promise<number> {
  const hit = activeCache.get(slug)
  if (hit && Date.now() - hit.at < 60_000) return hit.v
  const v = (await aliasedVersion(slug)) ?? MAPPING_VERSION
  activeCache.set(slug, { at: Date.now(), v })
  return v
}

/** Creates a new index version (not yet live). */
export async function createVersion(slug: string, version: number) {
  const name = indexName(slug, version)
  if (await es().indices.exists({ index: name })) await es().indices.delete({ index: name })
  await es().indices.create({ index: name, ...mappingFor(version) })
  return name
}

/** Points the alias at one version, atomically (searches switch model with it). */
export async function swapAlias(slug: string, version: number) {
  const alias = indexAlias(slug)
  const current = await es()
    .indices.getAlias({ name: alias })
    .then((r) => Object.keys(r))
    .catch(() => [] as string[])
  await es().indices.updateAliases({ actions: [...current.map((index) => ({ remove: { index, alias } })), { add: { index: indexName(slug, version), alias } }] })
  activeCache.delete(slug)
}
