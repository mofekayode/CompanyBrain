// Dev tool: export or import a client's configuration (rules + what the FDE learned).
// The portal does the same through /api/t/<slug>/config.
//
// Usage:
//   npx tsx scripts/tenant-config.ts export <slug> [--template] [out.json]
//   npx tsx scripts/tenant-config.ts import <slug> <file.json>
// Default export path: config/tenants/<slug>/tenant.json (template: config/templates/<slug>.json)

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { exportTenant, importTenant, type TenantExport } from '../src/config/export'
import { pool } from '../src/workbench/server'

const [cmd, slug, ...rest] = process.argv.slice(2)
if (!cmd || !slug) throw new Error('usage: tenant-config.ts export|import <slug> …')
const ROOT = resolve(import.meta.dirname, '../../..')
const db = pool()
const tenant = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]
if (!tenant) throw new Error(`unknown tenant ${slug}`)

if (cmd === 'export') {
  const template = rest.includes('--template')
  const file = rest.find((r) => !r.startsWith('--')) ?? resolve(ROOT, template ? `config/templates/${slug}.json` : `config/tenants/${slug}/tenant.json`)
  const data = await exportTenant(db, tenant.id, template ? 'template' : 'full')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`wrote ${file}`)
  console.log({
    rules: Object.keys(data.rules).length ? data.rules : 'defaults',
    entity_types: data.ontology.entity_types.length,
    relationship_types: data.ontology.relationship_types.length,
    table_mappings: data.ontology.table_mappings?.length,
    directory_mappings: data.directory_mappings?.length,
    vocabulary: data.vocabulary?.length,
    merges: data.merges?.length,
    separate: data.separate?.length,
    scopes: data.access?.scopes.length,
    file_moves: data.access?.file_moves.length,
    eval_sets: data.validation?.eval_sets.map((s) => `${s.name} (${s.items.length})`),
  })
} else if (cmd === 'import') {
  const file = rest[0]
  if (!file) throw new Error('import needs a file')
  const data = JSON.parse(await readFile(file, 'utf8')) as TenantExport
  console.log(JSON.stringify(await importTenant(db, tenant.id, data), null, 2))
} else throw new Error(`unknown command ${cmd}`)
await db.end()
