// Dev tool: rebuild a client's search index on a different embedding model without downtime.
// Builds index version <n> (its model is EMBEDDINGS[n] in src/search/embed.ts) next to the live
// one; with --swap, then points the alias at it, and searches switch model with the alias.
//
// Usage: npx tsx scripts/search-rebuild.ts <slug> <version> [--swap]
//        npx tsx scripts/search-rebuild.ts <slug> <version> --swap-only   (switch back or forth, no rebuild)

import { EMBEDDINGS } from '../src/search/embed'
import { aliasedVersion, swapAlias } from '../src/search/es'
import { buildVersion } from '../src/search/project'
import { pool } from '../src/workbench/server'

const [slug, v, flag] = process.argv.slice(2)
const version = Number(v)
if (!slug || !EMBEDDINGS[version]) throw new Error(`usage: search-rebuild.ts <slug> <version: ${Object.keys(EMBEDDINGS).join('|')}> [--swap | --swap-only]`)
const db = pool()
const tenant = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
console.log(`live: v${await aliasedVersion(slug)} · target: v${version} (${EMBEDDINGS[version].model}, ${EMBEDDINGS[version].dims} dims)`)
if (flag !== '--swap-only') {
  const t0 = Date.now()
  const r = await buildVersion(db, tenant.id, version, (n, total) => {
    if (n % 2560 === 0 || n === total) console.log(`  ${n}/${total} (${Math.round((Date.now() - t0) / 1000)} s)`)
  })
  console.log(`built ${r.index}: ${r.indexed} documents in ${Math.round((Date.now() - t0) / 1000)} s`)
}
if (flag === '--swap' || flag === '--swap-only') {
  await swapAlias(slug, version)
  console.log(`alias now → v${await aliasedVersion(slug)}`)
}
await db.end()
