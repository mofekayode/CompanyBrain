// Dev tool: reset a tenant's discovery work so profiling and the discovery
// questions can be tested from scratch. Raw files (S3 + source_objects rows),
// sources, the tenant and the question catalog are kept.
//
// Usage: npx tsx scripts/reset-discovery.ts <tenant-slug> --yes

import { createServicePool } from '../src/db'

async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug || slug.startsWith('--')) throw new Error('usage: reset-discovery.ts <tenant-slug> --yes')
  if (!process.argv.includes('--yes')) throw new Error('refusing without --yes: this deletes chats, findings and file profiles')

  const sql = createServicePool(1)
  try {
    const tenant = (await sql.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
    if (!tenant) throw new Error(`tenant ${slug} does not exist`)
    await sql.query('begin')
    const count = async (label: string, q: string) => console.log(`${label.padEnd(26)} ${(await sql.query(q, [tenant.id])).rowCount}`)
    await count('finding evidence deleted', `delete from public.discovery_finding_evidence where tenant_id = $1`)
    await count('findings deleted', `delete from public.discovery_findings where tenant_id = $1`)
    await count('chat steps deleted', `delete from public.workbench_steps where tenant_id = $1`)
    await count('chat messages deleted', `delete from public.workbench_messages where tenant_id = $1`)
    await count('chat sessions deleted', `delete from public.workbench_sessions where tenant_id = $1`)
    await count('profiling jobs deleted', `delete from public.ingestion_jobs where tenant_id = $1 and job_type = 'profile'`)
    await count(
      'file profiles cleared',
      `update public.source_objects set metadata = metadata - 'profile', status = 'landed' where tenant_id = $1 and (metadata ? 'profile' or status <> 'landed')`,
    )
    await sql.query('commit')
  } catch (error) {
    await sql.query('rollback').catch(() => {})
    throw error
  } finally {
    await sql.end()
  }
}

await main()
