// Postgres → Elasticsearch sync. Triggers write what changed to search_outbox; the
// worker turns pending changes into one `project_search` job per client, which
// rebuilds only the affected search documents:
//
//   evidence added/changed (new interview, re-extracted policy) → re-cut that document
//   entity renamed / merged / alias added or rejected           → its card, its facts, and passages that mention it
//   canonical fact accepted / corrected / superseded            → that fact card
//   access list changed (scope released, person added)         → re-push the documents it covers (no re-embedding)
//   file deleted                                                → its passages removed

import { project, type ProjectScope } from '../search/project'
import type { Sql } from '../storage/raw'
import { enqueue, type Job } from './queue'

interface Ctx {
  sql: Sql
}

/**
 * One sync per client at a time (the worker's job, a script, a test): concurrent syncs
 * rewrite the same search documents and deadlock. A session advisory lock on a dedicated
 * connection serialises them; the second one then finds little or nothing left to do.
 */
export async function drainSearchOutbox(sql: Sql, tenantId: string, log: (m: string) => void = () => {}) {
  const pool = sql as Sql & { connect?: () => Promise<Sql & { release: () => void }> }
  const conn = typeof pool.connect === 'function' ? await pool.connect() : null
  try {
    if (conn) await conn.query(`select pg_advisory_lock(hashtext('search_sync:' || $1))`, [tenantId])
    return await drainUnlocked(sql, tenantId, log)
  } finally {
    if (conn) {
      await conn.query(`select pg_advisory_unlock(hashtext('search_sync:' || $1))`, [tenantId]).catch(() => {})
      conn.release()
    }
  }
}

async function drainUnlocked(sql: Sql, tenantId: string, log: (m: string) => void) {
  const rows = (
    await sql.query<{ id: string; kind: string; ref: string }>(
      `select id::text, kind, ref from public.search_outbox where tenant_id = $1 and processed_at is null order by id limit 50000`,
      [tenantId],
    )
  ).rows
  if (!rows.length) return { changes: 0, scope: { documents: 0, entities: 0, facts: 0, access_touched: 0 }, passages: 0, entities: 0, facts: 0, changed: 0, deleted: 0, embedded: 0, indexed: 0 }
  const refs = (k: string) => [...new Set(rows.filter((r) => r.kind === k).map((r) => r.ref))]
  const scope: Required<ProjectScope> = { documentVersionIds: refs('document_version'), entityIds: refs('entity'), factIds: refs('fact'), touchDocIds: [] }

  const sources = refs('source')
  if (sources.length)
    scope.documentVersionIds.push(
      ...(await sql.query<{ id: string }>(`select current_version_id id from public.documents where id = any($1::uuid[]) and current_version_id is not null`, [sources])).rows.map((r) => r.id),
    )

  if (scope.entityIds.length) {
    // Passages that mention these entities by any name: re-cut (new aliases create new links).
    const terms = (
      await sql.query<{ t: string }>(
        `select distinct t from (
           select canonical_name t from public.entities where id = any($1::uuid[]) and status in ('candidate', 'active')
           union select alias from public.entity_aliases where entity_id = any($1::uuid[]) and status <> 'rejected') x where length(t) >= 4`,
        [scope.entityIds],
      )
    ).rows.map((r) => `%${r.t.replace(/[%_\\]/g, '\\$&')}%`)
    scope.documentVersionIds.push(
      ...(
        await sql.query<{ dv: string }>(
          `select distinct document_version_id dv from public.search_documents
           where tenant_id = $1 and doc_type = 'passage' and document_version_id is not null and (entity_ids && $2::uuid[] or content ilike any($3::text[])) limit 3000`,
          [tenantId, scope.entityIds, terms],
        )
      ).rows.map((r) => r.dv),
    )
    // Their facts (a merge moves facts to the survivor).
    scope.factIds.push(
      ...(
        await sql.query<{ id: string }>(`select id from public.facts where tenant_id = $1 and subject_entity_id = any($2::uuid[]) and metadata ->> 'layer' = 'canonical'`, [tenantId, scope.entityIds])
      ).rows.map((r) => r.id),
    )
  }

  const acls = refs('acl')
  if (acls.length) scope.touchDocIds = (await sql.query<{ id: string }>(`select id from public.search_documents where tenant_id = $1 and acl_ids && $2::uuid[]`, [tenantId, acls])).rows.map((r) => r.id)

  scope.documentVersionIds = [...new Set(scope.documentVersionIds)]
  scope.factIds = [...new Set(scope.factIds)]
  const stats = await project(sql, tenantId, scope, log)
  const last = rows.at(-1)!.id
  await sql.query(`update public.search_outbox set processed_at = now() where tenant_id = $1 and id <= $2 and processed_at is null`, [tenantId, last])
  return {
    changes: rows.length,
    scope: { documents: scope.documentVersionIds.length, entities: scope.entityIds.length, facts: scope.factIds.length, access_touched: scope.touchDocIds.length },
    ...stats,
  }
}

export const SEARCH_HANDLERS: Record<string, (job: Job, ctx: Ctx) => Promise<unknown>> = {
  project_search: (job, ctx) => drainSearchOutbox(ctx.sql, job.tenant_id),
}

/**
 * Called by the worker every few seconds: one sync job per client with pending
 * changes (only clients that have a search index, i.e. at least one document).
 */
export async function scheduleSearchSync(sql: Sql): Promise<number> {
  const pending = (
    await sql.query<{ tenant_id: string; last: string }>(
      `select o.tenant_id, max(o.id)::text last from public.search_outbox o
       where o.processed_at is null and exists (select 1 from public.search_documents d where d.tenant_id = o.tenant_id)
         and not exists (select 1 from public.ingestion_jobs j where j.tenant_id = o.tenant_id and j.job_type = 'project_search' and j.status in ('queued', 'running'))
       group by 1`,
    )
  ).rows
  for (const p of pending) await enqueue(sql, { tenantId: p.tenant_id, jobType: 'project_search', idempotencyKey: `project-search:${p.last}`, maxAttempts: 3 })
  return pending.length
}
