// Phase 3: land a client's corpus into S3 raw/ exactly as found and record
// provenance in Postgres. Driven by config/tenants/<slug>/sources.json.
// Idempotent: rerunning skips what already landed.
//
// Usage: npx tsx scripts/land-corpus.ts <tenant-slug> [--dry-run] [--create-tenant]
//
// Nothing is cleaned, renamed, deduplicated or filtered. Each pile the company
// handed over is one source; paths inside it are preserved.

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { companyBrainStore } from '../src/aws'
import { createServicePool } from '../src/db'
import { landLocalFile } from '../src/storage/raw'

const CONCURRENCY = 8

interface Manifest {
  tenant: { slug: string; name: string }
  corpus_root: string
  sources: { slug: string; name: string; kind: string; root: string; batch: string; description?: string }[]
}

async function walk(path: string): Promise<string[]> {
  const info = await stat(path)
  if (info.isFile()) return [path]
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(entries.filter((e) => e.isFile() || e.isDirectory()).map((e) => walk(join(path, e.name))))
  return nested.flat().sort()
}

async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug || slug.startsWith('--')) throw new Error('usage: land-corpus.ts <tenant-slug> [--dry-run] [--create-tenant]')
  const dryRun = process.argv.includes('--dry-run')
  const configDir = resolve(import.meta.dirname, '../../../config/tenants', slug)
  const manifest = JSON.parse(await readFile(join(configDir, 'sources.json'), 'utf8')) as Manifest
  const corpus = resolve(import.meta.dirname, '../../..', manifest.corpus_root)

  const store = await companyBrainStore() // refuses to run against any other AWS account
  const sql = createServicePool()
  try {
    let tenant = (await sql.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
    if (!tenant && process.argv.includes('--create-tenant') && !dryRun) {
      tenant = (await sql.query<{ id: string }>(`select public.create_tenant($1, $2, null) as id`, [slug, manifest.tenant.name])).rows[0]
      console.log(`created tenant ${slug} (${tenant.id})`)
    }
    if (!tenant && !dryRun) throw new Error(`tenant ${slug} does not exist (pass --create-tenant)`)

    const totals = { files: 0, bytes: 0, created: 0, existing: 0, failed: 0 }
    for (const spec of manifest.sources) {
      const rootPath = join(corpus, spec.root)
      const files = await walk(rootPath)
      const isSingleFile = (await stat(rootPath)).isFile()
      const source = dryRun
        ? { id: 'dry-run' }
        : (
            await sql.query<{ id: string }>(
              `insert into public.sources (tenant_id, kind, name, description, connector, config)
               values ($1, $2, $3, $4, 'manual-handoff', $5)
               on conflict (tenant_id, name) do update set description = excluded.description
               returning id`,
              [tenant!.id, spec.kind, spec.name, spec.description ?? null, JSON.stringify({ slug: spec.slug, root: spec.root, batch: spec.batch })],
            )
          ).rows[0]

      let created = 0
      let existing = 0
      const queue = [...files]
      const worker = async () => {
        for (let file = queue.shift(); file; file = queue.shift()) {
          // Path as it was inside the pile (single-file sources keep their filename).
          const originalPath = isSingleFile ? relative(join(rootPath, '..'), file) : relative(rootPath, file)
          const info = await stat(file)
          totals.files++
          totals.bytes += info.size
          if (dryRun) continue
          try {
            const landed = await landLocalFile(
              file,
              {
                tenantId: tenant!.id,
                source: { id: source.id, slug: spec.slug },
                batch: spec.batch,
                originalPath,
                // Only the copy's filesystem metadata survives a handoff; the source
                // system's own ACLs are mapped from its permission exports later.
                sourcePermissions: { observed_on: 'handoff copy', posix_mode: (info.mode & 0o777).toString(8) },
              },
              { store, sql },
            )
            if (landed.created) created++
            else existing++
          } catch (error) {
            totals.failed++
            console.error(`  FAILED ${spec.slug}/${originalPath}: ${(error as Error).message}`)
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
      totals.created += created
      totals.existing += existing
      console.log(`${spec.slug.padEnd(30)} ${String(files.length).padStart(5)} files  new ${created}, already landed ${existing}`)
    }

    console.log(
      `\n${dryRun ? 'DRY RUN ' : ''}total ${totals.files} files, ${(totals.bytes / 1048576).toFixed(1)} MB: ` +
        `${totals.created} new, ${totals.existing} already landed, ${totals.failed} failed`,
    )
    if (totals.failed > 0) process.exitCode = 1
  } finally {
    await sql.end()
  }
}

await main()
