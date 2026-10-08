// People & access as background jobs, so FDEs watch them in the Activity panel.

import { buildCompanyMap } from '../access/directory'
import { applyAccess, proposeAccess, writeProposal } from '../access/scopes'
import type { ObjectStore } from '../storage/object-store'
import type { Sql } from '../storage/raw'
import { enqueue, type Job, NotReadyError, settleParent, startRun } from './queue'

type Ctx = { sql: Sql; store: ObjectStore }

export const ACCESS_HANDLERS: Record<string, (job: Job, ctx: Ctx) => Promise<unknown>> = {
  /** Reads the client's directory exports and writes people and groups. */
  build_company_map: (job, ctx) => buildCompanyMap(ctx.sql, ctx.store, job.tenant_id, { remap: !!job.payload?.remap }),

  /** Proposes scopes from permission exports + folders + company map, assigns every file, and applies ACLs. */
  propose_access: async (job, ctx) => {
    // Needs the company map from the same run first.
    const map = await ctx.sql.query<{ status: string }>(
      `select status from public.ingestion_jobs where parent_job_id = $1 and job_type = 'build_company_map'`,
      [job.parent_job_id],
    )
    if (map.rows[0] && map.rows[0].status !== 'succeeded') {
      if (map.rows[0].status === 'dead') throw new Error('company map failed; fix it first')
      throw new NotReadyError('waiting for the company map', 10)
    }
    const proposal = await proposeAccess(ctx.sql, ctx.store, job.tenant_id)
    const written = await writeProposal(ctx.sql, job.tenant_id, proposal)
    const applied = await applyAccess(ctx.sql, job.tenant_id)
    return { ...written, applied }
  },
}

/** Starts the people & access stage: company map, then scope proposal. */
export async function startAccessRun(sql: Sql, tenantId: string, opts: { mapOnly?: boolean; remap?: boolean } = {}) {
  const runId = await startRun(sql, tenantId, 'access', { label: opts.mapOnly ? 'Company map' : 'Company map + access scopes' })
  await enqueue(sql, { tenantId, jobType: 'build_company_map', idempotencyKey: `company-map:${runId}`, parentJobId: runId, payload: { remap: !!opts.remap } })
  if (!opts.mapOnly) await enqueue(sql, { tenantId, jobType: 'propose_access', idempotencyKey: `propose-access:${runId}`, parentJobId: runId, priority: -1 })
  await settleParent(sql, runId)
  return { runId }
}
