// Dev tool: profile a tenant's raw objects from the terminal. The web workbench
// runs the same code as a job (Profile files button).
//
// Usage: npx tsx scripts/profile-raw.ts <tenant-slug> [--force]

import { companyBrainStore } from '../src/aws'
import { createServicePool } from '../src/db'
import { PROFILER_VERSION } from '../src/profiling/profile'
import { profileTenant } from '../src/profiling/run'

async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug || slug.startsWith('--')) throw new Error('usage: profile-raw.ts <tenant-slug> [--force]')

  const store = await companyBrainStore()
  const sql = createServicePool()
  try {
    const tenant = (await sql.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
    if (!tenant) throw new Error(`tenant ${slug} does not exist`)
    let last = 0
    const result = await profileTenant({
      sql,
      store,
      tenantId: tenant.id,
      force: process.argv.includes('--force'),
      onProgress: (p) => {
        if (p.done + p.failed === 0) console.log(`${p.total} object(s) to profile (profiler v${PROFILER_VERSION})`)
        if (p.done + p.failed - last >= 50) {
          last = p.done + p.failed
          console.log(`  ${last}/${p.total}`)
        }
      },
    })
    for (const f of result.failures) console.error(`  FAILED ${f.s3_key}: ${f.error}`)
    console.log(`profiled ${result.done}, failed ${result.failed}`)
    if (result.failed > 0) process.exitCode = 1
  } finally {
    await sql.end()
  }
}

await main()
