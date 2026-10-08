// Dev tool: (re)build a client's search index from Postgres into Elasticsearch.
// The worker does the same incrementally from the outbox (job `project_search`).
//
// Usage: npx tsx scripts/search-project.ts <slug> [--recreate]

import { ensureIndex } from '../src/search/es'
import { project } from '../src/search/project'
import { pool } from '../src/workbench/server'

const [slug, flag] = process.argv.slice(2)
if (!slug) throw new Error('usage: search-project.ts <slug> [--recreate]')
const db = pool()
const tenant = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
if (!tenant) throw new Error(`unknown tenant ${slug}`)
const t0 = Date.now()
if (flag === '--recreate') await db.query(`update public.search_documents set indexed_at = null where tenant_id = $1`, [tenant.id])
console.log('index', await ensureIndex(slug, { recreate: flag === '--recreate' }))
// Everything up to now is covered by the full build; mark the outbox as drained.
const mark = (await db.query<{ id: string }>(`select coalesce(max(id), 0)::text id from public.search_outbox where tenant_id = $1`, [tenant.id])).rows[0].id
const stats = await project(db, tenant.id, 'all', (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`))
await db.query(`update public.search_outbox set processed_at = now() where tenant_id = $1 and id <= $2 and processed_at is null`, [tenant.id, mark])
console.log(stats, `${((Date.now() - t0) / 1000).toFixed(0)}s`)
await db.end()
