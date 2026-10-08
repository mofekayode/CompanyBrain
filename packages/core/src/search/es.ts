// Elasticsearch: one index per client (`cb-<slug>-v<n>`, reached through the alias
// `cb-<slug>`), holding passages, entity cards and fact cards. Postgres
// (search_documents) is the source of truth; this index can be rebuilt from it.

import { Client, type estypes } from '@elastic/elasticsearch'
import { readEnv } from '../env'
import { EMBEDDING_DIMS } from './embed'

let client: Client | undefined
export function es(): Client {
  if (client) return client
  const env = readEnv(['ELASTIC_SEARCH_ENDPOINT', 'ELASTIC_SEARCH_APIKEY'] as const)
  if (!env.ELASTIC_SEARCH_ENDPOINT || !env.ELASTIC_SEARCH_APIKEY) throw new Error('ELASTIC_SEARCH_ENDPOINT / ELASTIC_SEARCH_APIKEY are not set')
  client = new Client({ node: env.ELASTIC_SEARCH_ENDPOINT, auth: { apiKey: env.ELASTIC_SEARCH_APIKEY }, requestTimeout: 60_000 })
  return client
}

export const indexAlias = (slug: string) => `cb-${slug}`
export const MAPPING_VERSION = 1
export const indexName = (slug: string, version = MAPPING_VERSION) => `cb-${slug}-v${version}`

/**
 * Field design:
 * - content / title: English analyzer (stemming: "failing" ≈ "failed"), plus `.exact`
 *   (standard analyzer) so codes and names like "TP-17" or "Net 60" match as written.
 * - entity_terms: names + aliases of the entities a passage mentions, so "Big Blue"
 *   finds passages that only say "Blue Ridge" (and vice versa).
 * - acl_principals: who may read the document (users and groups). Every query filters on it.
 * - embedding: 384-d vector from a local model (bge-small), cosine, HNSW.
 */
export const MAPPING: Pick<estypes.IndicesCreateRequest, 'settings' | 'mappings'> = {
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
      embedding: { type: 'dense_vector', dims: EMBEDDING_DIMS, similarity: 'cosine', index: true },
    },
  },
}

/** Creates the versioned index and points the alias at it (no-op when it exists). */
export async function ensureIndex(slug: string, opts: { recreate?: boolean } = {}) {
  const name = indexName(slug)
  const exists = await es().indices.exists({ index: name })
  if (exists && opts.recreate) await es().indices.delete({ index: name })
  if (!exists || opts.recreate) await es().indices.create({ index: name, ...MAPPING })
  await es().indices.updateAliases({ actions: [{ add: { index: name, alias: indexAlias(slug) } }] })
  return name
}
