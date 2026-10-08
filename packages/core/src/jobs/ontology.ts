// The company model as background jobs: propose → load → resolve, in one run.

import { consolidateTimelines, detectTopics } from '../ontology/timeline'
import { rulesFor } from '../config/tenant-config'
import { canonicalize } from '../ontology/canonical'
import { extractKnowledge } from '../ontology/knowledge'
import { loadStructured } from '../ontology/load'
import { type OntologyProposal, proposeOntology } from '../ontology/propose'
import { resolveAll } from '../ontology/resolve'
import type { ObjectStore } from '../storage/object-store'
import type { Sql } from '../storage/raw'
import { enqueue, type Job, NotReadyError, settleParent, startRun } from './queue'

type Ctx = { sql: Sql; store: ObjectStore }

/** The result of the run's earlier step, or wait for it. */
async function previous<T>(sql: Sql, job: Job, type: string): Promise<T> {
  const r = (await sql.query<{ status: string; result: T }>(`select status, result from public.ingestion_jobs where parent_job_id = $1 and job_type = $2`, [job.parent_job_id, type])).rows[0]
  if (!r) throw new Error(`${type} is not part of this run`)
  if (r.status === 'dead') throw new Error(`${type} failed; fix it first`)
  if (r.status !== 'succeeded') throw new NotReadyError(`waiting for ${type}`, 10)
  return r.result
}

/** The latest proposal for a client (from its last successful propose job). */
export async function latestProposal(sql: Sql, tenantId: string): Promise<(OntologyProposal & { proposed_at: string }) | null> {
  const r = (
    await sql.query<{ result: OntologyProposal; finished_at: string }>(
      `select result, finished_at from public.ingestion_jobs where tenant_id = $1 and job_type = 'propose_ontology' and status = 'succeeded' order by finished_at desc limit 1`,
      [tenantId],
    )
  ).rows[0]
  return r ? { ...r.result, proposed_at: r.finished_at } : null
}

export const ONTOLOGY_HANDLERS: Record<string, (job: Job, ctx: Ctx) => Promise<unknown>> = {
  propose_ontology: (job, ctx) => proposeOntology(ctx.sql, ctx.store, job.tenant_id),
  load_ontology: async (job, ctx) => {
    const proposal = job.payload?.reuse ? await latestProposal(ctx.sql, job.tenant_id) : await previous<OntologyProposal>(ctx.sql, job, 'propose_ontology')
    if (!proposal) throw new Error('no ontology proposal yet')
    return loadStructured(ctx.sql, ctx.store, job.tenant_id, proposal)
  },
  extract_knowledge: async (job, ctx) =>
    extractKnowledge(ctx.sql, job.tenant_id, (job.payload.document_version_ids as string[] | undefined) ?? (job.payload.document_version_id as string)),
  canonicalize_facts: async (job, ctx) => {
    // Group only once every pending reading job has finished.
    const pending = (await ctx.sql.query<{ n: number }>(`select count(*)::int n from public.ingestion_jobs where tenant_id = $1 and job_type = 'extract_knowledge' and status in ('queued', 'running')`, [job.tenant_id])).rows[0].n
    if (pending > 0) throw new NotReadyError(`${pending} documents still being read`, 30)
    const grouped = await canonicalize(ctx.sql, job.tenant_id)
    // Then repair the timelines and link versions that live on different subjects.
    const timeline = await consolidateTimelines(ctx.sql, job.tenant_id)
    const topics = await detectTopics(ctx.sql, job.tenant_id)
    return { ...grouped, timeline: { closed: timeline.closed, superseded: timeline.superseded, folded: timeline.folded }, topics: topics.topics.length, possibly_outdated: topics.stale.length }
  },
  resolve_entities: async (job, ctx) => {
    await previous(ctx.sql, job, 'load_ontology')
    return resolveAll(ctx.sql, job.tenant_id)
  },
}

/** Starts a company-model run. reuse: skip proposing and reload from the latest proposal. */
export async function startOntologyRun(sql: Sql, tenantId: string, opts: { reuse?: boolean } = {}) {
  const runId = await startRun(sql, tenantId, 'model', { label: opts.reuse ? 'Reload + resolve' : 'Propose + load + resolve' })
  if (!opts.reuse) await enqueue(sql, { tenantId, jobType: 'propose_ontology', idempotencyKey: `propose-ontology:${runId}`, parentJobId: runId })
  await enqueue(sql, { tenantId, jobType: 'load_ontology', idempotencyKey: `load-ontology:${runId}`, parentJobId: runId, priority: -1, payload: { reuse: !!opts.reuse } })
  await enqueue(sql, { tenantId, jobType: 'resolve_entities', idempotencyKey: `resolve:${runId}`, parentJobId: runId, priority: -2 })
  await settleParent(sql, runId)
  return { runId }
}

/**
 * Reads prose for vocabulary, exceptions and facts. scope 'interviews' (default: the
 * richest, smallest set), 'documents', 'emails' or 'all'. One job per document.
 */
export type KnowledgeScope = 'interviews' | 'official' | 'documents' | 'emails' | 'all'
/** Official documents: policies, SOPs, contracts, agreements, handbooks, pricing, memos, letters. */
// Official documents are matched by the tenant's authority.official_paths rule.

export async function startKnowledgeRun(sql: Sql, tenantId: string, scope: KnowledgeScope = 'interviews') {
  const kinds = { interviews: ['transcript_segment', 'video_segment'], official: ['text', 'ocr'], documents: ['text', 'ocr'], emails: ['email_body'], all: ['transcript_segment', 'video_segment', 'text', 'ocr', 'email_body'] }[scope]
  const { rows } = await sql.query<{ id: string; source_object_id: string }>(
    `select distinct dv.id, dv.source_object_id from public.document_versions dv
     join public.documents d on d.current_version_id = dv.id
     join public.evidence e on e.document_version_id = dv.id
     join public.source_objects so on so.id = dv.source_object_id
     where dv.tenant_id = $1 and e.kind = any($2::text[])
       and ($3::text is null or (so.original_path ~* $3 and so.original_path !~ '/messages/'))`,
    [tenantId, kinds, scope === 'official' ? (await rulesFor(sql, tenantId)).authority.official_paths.pattern : null],
  )
  const runId = await startRun(sql, tenantId, 'model', { label: `Read ${scope} for vocabulary and facts (${rows.length} files)` })
  if (scope === 'emails') {
    // Emails are short: one job per ~12k characters, in conversation order (unique messages only).
    const sized = (
      await sql.query<{ id: string; chars: number }>(
        `select dv.id, sum(length(e.content))::int chars
         from public.document_versions dv join public.evidence e on e.document_version_id = dv.id
         left join public.email_thread_messages m on m.document_id = dv.document_id
         where dv.id = any($1::uuid[]) and e.kind = 'email_body'
         group by dv.id, m.thread_id, m.ordinal order by m.thread_id nulls last, m.ordinal`,
        [rows.map((r) => r.id)],
      )
    ).rows
    // Copies of the same message in several mailboxes are read once (the first copy).
    const unique = (
      await sql.query<{ id: string }>(
        `select distinct on (coalesce(dv.metadata ->> 'message_id', dv.id::text)) dv.id from public.document_versions dv where dv.id = any($1::uuid[])
         order by coalesce(dv.metadata ->> 'message_id', dv.id::text), dv.created_at`,
        [rows.map((r) => r.id)],
      )
    ).rows.map((r) => r.id)
    const keep = new Set(unique)
    let batch: string[] = []
    let chars = 0
    let n = 0
    const flush = async () => {
      if (!batch.length) return
      await enqueue(sql, { tenantId, jobType: 'extract_knowledge', idempotencyKey: `knowledge:emails:${n++}:${runId}`, parentJobId: runId, payload: { document_version_ids: batch } })
      batch = []
      chars = 0
    }
    for (const r of sized.filter((x) => keep.has(x.id))) {
      if (chars + r.chars > 12000) await flush()
      batch.push(r.id)
      chars += r.chars
    }
    await flush()
    await settleParent(sql, runId)
    return { runId, files: keep.size, jobs: n }
  }
  for (const r of rows) {
    await enqueue(sql, { tenantId, jobType: 'extract_knowledge', idempotencyKey: `knowledge:${r.id}:${runId}`, sourceObjectId: r.source_object_id, parentJobId: runId, payload: { document_version_id: r.id } })
  }
  await settleParent(sql, runId)
  return { runId, files: rows.length }
}

/** Turns claims into canonical facts (grouping, authority, timelines, conflicts). */
export async function startCanonicalRun(sql: Sql, tenantId: string) {
  const runId = await startRun(sql, tenantId, 'model', { label: 'Canonical facts: group, rank, timelines, conflicts' })
  await enqueue(sql, { tenantId, jobType: 'canonicalize_facts', idempotencyKey: `canonical:${runId}`, parentJobId: runId })
  await settleParent(sql, runId)
  return { runId }
}
