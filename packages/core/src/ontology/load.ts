// Loads the structured part of the company model, deterministically, from an
// ontology proposal:
// - types and relationship types (status 'proposed', for FDE review)
// - People and Branches from the company map
// - one entity per row of each "entities" table, with its system identifier,
//   properties, provenance and a link to the table passage it came from
// - one entity per event of each "events" table (rows grouped by event id),
//   linked to its participants (customer, site, asset, technician, …)
// Link targets are found by identifier, then by name/alias; missing targets are
// created as candidates for resolution to merge.

import { randomUUID } from 'node:crypto'
import { readTableFile } from '../access/directory'
import { type CompiledRules, DEFAULTS, rulesFor } from '../config/tenant-config'
import type { ObjectStore } from '../storage/object-store'
import type { Sql } from '../storage/raw'
import type { OntologyProposal, TableMapping } from './propose'

export const LOAD_ORIGINS = ['company_map', 'structured', 'event', 'link'] as const

/** Lowercase, strip punctuation and legal suffixes: "The Kemper Molding Co., Inc." → "kemper molding" */
export function normalizeName(s: string, rules: CompiledRules = DEFAULTS): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(rules.rx.legalSuffix, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Splits multi-valued cells: "50025; 50433", "Asset ID(s)" lists, comma lists of codes
 * ("PRESS-106, PRESS-71" but not "Smith, John"), and slash-joined initials ("HO/MKH").
 * Placeholders ("UNASSIGNED") are dropped. Patterns come from the tenant's cleaning rules.
 */
export const multi = (header: string, v: string, rules: CompiledRules = DEFAULTS) =>
  (/[;|]/.test(v) || /\(s\)/i.test(header) || rules.rx.codeList.test(v.trim()) ? v.split(/\s*[;|]\s*|\s*,\s*/) : /^[A-Z]{1,4}(\/[A-Z]{1,4})+$/.test(v.trim()) ? v.split('/') : [v])
    .map((x) => x.trim())
    .filter((x) => x && !rules.rx.placeholder.test(x))

/** The identifier system a property column holds (Serial, VIN, …), if it is a strong id column. */
const strongIdSystem = (column: string, rules: CompiledRules) => rules.rx.strongIdColumns.find((s) => s.column.test(column))?.system

interface NewEntity {
  id: string
  type_id: string
  name: string
  properties: Record<string, unknown>
  metadata: Record<string, unknown>
}
interface NewRel {
  type_id: string
  source: string
  target: string
  properties?: Record<string, unknown>
}

class Index {
  constructor(private rules: CompiledRules = DEFAULTS) {}
  private byId = new Map<string, string>() // `${type}|${system}|${value}` and `${type}|*|${value}`
  private byName = new Map<string, string>() // `${type}|${normalized}`
  addId(type: string, system: string, value: string, entity: string) {
    const v = value.trim().toLowerCase()
    if (!v) return
    if (!this.byId.has(`${type}|${system}|${v}`)) this.byId.set(`${type}|${system}|${v}`, entity)
    if (!this.byId.has(`${type}|*|${v}`)) this.byId.set(`${type}|*|${v}`, entity)
  }
  addName(type: string, name: string, entity: string) {
    const n = normalizeName(name, this.rules)
    if (n && !this.byName.has(`${type}|${n}`)) this.byName.set(`${type}|${n}`, entity)
  }
  find(type: string, value: string, system: string | null, match: 'id' | 'name'): string | undefined {
    const v = value.trim().toLowerCase()
    const id = (system && this.byId.get(`${type}|${system}|${v}`)) || this.byId.get(`${type}|*|${v}`)
    const name = this.byName.get(`${type}|${normalizeName(value, this.rules)}`)
    return match === 'id' ? (id ?? name) : (name ?? id)
  }
}

export async function loadStructured(sql: Sql, store: ObjectStore, tenantId: string, proposal: OntologyProposal): Promise<Record<string, unknown>> {
  const rules = await rulesFor(sql, tenantId)
  // ---- types --------------------------------------------------------------
  const eventTypes = new Set(proposal.tables.filter((t) => t.kind === 'events' && t.event_type).map((t) => t.event_type!))
  const typeNames = new Set([...proposal.entity_types.map((t) => t.name), ...eventTypes, ...proposal.relationship_types.flatMap((r) => [r.source_type, r.target_type])])
  const typeId = new Map<string, string>()
  for (const name of typeNames) {
    const spec = proposal.entity_types.find((t) => t.name === name)
    const { rows } = await sql.query<{ id: string }>(
      `insert into public.entity_types (tenant_id, name, description, status, origin, metadata)
       values ($1, $2, $3, 'proposed', 'ai', $4)
       on conflict (tenant_id, lower(name)) do update set description = coalesce(excluded.description, entity_types.description),
         metadata = entity_types.metadata || excluded.metadata
       returning id`,
      [tenantId, name, spec?.description ?? null, JSON.stringify({ kind: eventTypes.has(name) ? 'event' : 'thing', identifier_systems: spec?.identifier_systems ?? [], examples: spec?.examples ?? [] })],
    )
    typeId.set(name, rows[0].id)
  }
  for (const t of proposal.entity_types) {
    if (t.parent && typeId.has(t.parent)) await sql.query(`update public.entity_types set parent_type_id = $2 where id = $1`, [typeId.get(t.name), typeId.get(t.parent)])
  }
  const relTypeId = new Map<string, string>()
  const relType = async (name: string, source: string, target: string, description?: string) => {
    const key = name.toLowerCase()
    if (relTypeId.has(key)) return relTypeId.get(key)!
    const { rows } = await sql.query<{ id: string }>(
      `insert into public.relationship_types (tenant_id, name, description, source_type_id, target_type_id, status, origin)
       values ($1, $2, $3, $4, $5, 'proposed', 'ai')
       on conflict (tenant_id, lower(name)) do update set description = coalesce(excluded.description, relationship_types.description)
       returning id`,
      [tenantId, name, description ?? null, typeId.get(source) ?? null, typeId.get(target) ?? null],
    )
    relTypeId.set(key, rows[0].id)
    return rows[0].id
  }
  for (const r of proposal.relationship_types) await relType(r.name, r.source_type, r.target_type, r.description)

  // ---- clear the previous unreviewed load ------------------------------------
  await clearLoad(sql, tenantId)

  // ---- index of what already exists (reviewed entities survive re-loads) ----
  const index = new Index(rules)
  const existing = await sql.query<{ id: string; type: string; name: string; aliases: string[]; ids: { system: string; value: string }[] }>(
    `select e.id, t.name type, e.canonical_name name,
            array(select a.alias from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected') aliases,
            coalesce((select jsonb_agg(jsonb_build_object('system', i.system, 'value', i.value)) from public.entity_identifiers i where i.entity_id = e.id), '[]') ids
     from public.entities e join public.entity_types t on t.id = e.entity_type_id
     where e.tenant_id = $1 and e.status <> 'merged'`,
    [tenantId],
  )
  for (const e of existing.rows) {
    index.addName(e.type, e.name, e.id)
    for (const a of e.aliases) index.addName(e.type, a, e.id)
    for (const i of e.ids) index.addId(e.type, i.system, i.value, e.id)
  }

  const entities: NewEntity[] = []
  const identifiers: { entity: string; system: string; value: string }[] = []
  const aliases: { entity: string; alias: string; kind: string }[] = []
  const rels: NewRel[] = []
  const evidence: { entity: string; file_id: string; row: number; quote: string }[] = []
  const byId = new Map<string, NewEntity>()
  const create = (type: string, name: string, origin: string, props: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => {
    const id = randomUUID()
    const e = { id, type_id: typeId.get(type)!, name: name.slice(0, 300), properties: props, metadata: { origin, ...meta } }
    entities.push(e)
    byId.set(id, e)
    index.addName(type, name, id)
    return id
  }

  // ---- People and Branches from the company map -------------------------------
  const people = (
    await sql.query<{ id: string; name: string; m: Record<string, any> }>(
      `select id, display_name name, metadata m from public.principals
       where tenant_id = $1 and kind = 'user' and metadata ->> 'origin' = 'company_map' and not metadata ? 'stale' and metadata ->> 'status' in ('active', 'former')`,
      [tenantId],
    )
  ).rows
  const branchGroups = (
    await sql.query<{ id: string; name: string }>(
      `select id, metadata ->> 'name' name from public.principals where tenant_id = $1 and kind = 'group' and metadata ->> 'group_type' = 'location' and not metadata ? 'stale'`,
      [tenantId],
    )
  ).rows
  const branchByGroup = new Map<string, string>()
  if (typeId.has('Branch')) {
    for (const b of branchGroups) {
      const id = index.find('Branch', b.name, null, 'name') ?? create('Branch', b.name, 'company_map', {}, { principal_id: b.id })
      branchByGroup.set(b.name, id)
    }
  }
  if (typeId.has('Person')) {
    const basedAt = typeId.has('Branch') ? await relType('based_at', 'Person', 'Branch') : null
    const reportsTo = await relType('reports_to', 'Person', 'Person', 'Manager in the HR system')
    const personIds = new Map<string, string>()
    for (const p of people) {
      const existingId = (p.m.emails as string[] | undefined)?.map((e) => index.find('Person', e, 'Email', 'id')).find(Boolean) ?? index.find('Person', p.name, null, 'name')
      const id =
        existingId ??
        create('Person', p.name, 'company_map', { title: p.m.title ?? null, department: p.m.department ?? null, status: p.m.status }, { principal_id: p.id })
      personIds.set(p.id, id)
      for (const e of (p.m.emails as string[]) ?? []) (identifiers.push({ entity: id, system: 'Email', value: e }), index.addId('Person', 'Email', e, id))
      for (const [system, value] of Object.entries((p.m.external_ids as Record<string, string>) ?? {})) (identifiers.push({ entity: id, system, value }), index.addId('Person', system, value, id))
      for (const n of (p.m.names as string[]) ?? []) if (n !== p.name) (aliases.push({ entity: id, alias: n, kind: 'name' }), index.addName('Person', n, id))
      // First name + last initial is how techs often appear in older systems.
      const parts = p.name.split(/\s+/)
      if (parts.length >= 2) index.addName('Person', `${parts[0]} ${parts.at(-1)![0]}`, id)
      if (basedAt && p.m.location && branchByGroup.get(p.m.location) && p.m.status === 'active') rels.push({ type_id: basedAt, source: id, target: branchByGroup.get(p.m.location)! })
    }
    // Initials ("SO") and first names ("Gina") identify a person only when no one else shares them.
    const shortForms = new Map<string, string[]>()
    for (const p of people) {
      const names = [p.name, ...((p.m.names as string[]) ?? [])]
      const forms = new Set<string>()
      for (const n of names) {
        const parts = n.split(/\s+/).filter(Boolean)
        if (parts.length >= 2) forms.add(`initials:${parts.map((x) => x[0]).join('').toUpperCase()}`).add(`initials:${(parts[0][0] + parts.at(-1)![0]).toUpperCase()}`)
        if (parts.length) forms.add(`first:${parts[0].toLowerCase()}`)
      }
      for (const k of forms) shortForms.set(k, [...(shortForms.get(k) ?? []), personIds.get(p.id)!])
    }
    for (const [k, ids] of shortForms) {
      const unique = [...new Set(ids)]
      if (unique.length !== 1) continue
      if (k.startsWith('initials:')) index.addId('Person', 'Initials', k.slice(9), unique[0])
      else index.addName('Person', k.slice(6), unique[0])
    }
    for (const p of people) {
      const mgr = p.m.manager_id ? personIds.get(p.m.manager_id) : undefined
      if (mgr) rels.push({ type_id: reportsTo, source: personIds.get(p.id)!, target: mgr })
    }
  }

  // ---- tables -----------------------------------------------------------------
  const tables = proposal.tables.filter((t) => t.kind !== 'ignore')
  // Entities first (so events can link to them), within that, tables with system ids first.
  tables.sort((a, b) => Number(a.kind === 'events') - Number(b.kind === 'events') || Number(!a.id_column) - Number(!b.id_column))
  const files = new Map(
    (
      await sql.query<{ id: string; s3_key: string; format: string; path: string }>(
        `select id, s3_key, metadata -> 'profile' ->> 'format' format, original_path path from public.source_objects where id = any($1::uuid[])`,
        [tables.map((t) => t.file_id)],
      )
    ).rows.map((r) => [r.id, r]),
  )
  const report: Record<string, unknown>[] = []

  for (const t of tables) {
    const f = files.get(t.file_id)
    const bytes = f && (await store.get(f.s3_key))
    if (!f || !bytes) continue
    const sheet = (await readTableFile(bytes, f.format, f.id, f.path)).sheets.find((s) => s.header.filter(Boolean).length > 1)
    if (!sheet) continue
    const col = (name: string | null) => (name ? sheet.header.findIndex((h) => h === name) : -1)
    const val = (row: string[], name: string | null) => {
      const i = col(name)
      return i >= 0 ? String(row[i] ?? '').trim() : ''
    }
    const linkTarget = (l: TableMapping['links'][number], value: string, row: string[]) => {
      if (!typeId.has(l.target_type)) return undefined
      let target = index.find(l.target_type, value, l.system, l.match)
      // For id links, a sibling column named after the target type usually holds its name ("Customer ID" + "Customer").
      const sibling = l.match === 'id' ? sheet.header.find((h) => h !== l.column && new RegExp(`^${l.target_type.split(' ')[0]}( name)?$`, 'i').test(h)) : undefined
      const siblingName = sibling ? val(row, sibling) : ''
      if (!target && siblingName) target = index.find(l.target_type, siblingName, null, 'name')
      if (!target) {
        // A link to something no list contains yet: create it (resolution merges duplicates later).
        const name = siblingName || value
        target = create(l.target_type, name, 'link', {}, { first_seen: f.path })
        if (l.match === 'id' && l.system) (identifiers.push({ entity: target, system: l.system, value }), index.addId(l.target_type, l.system, value, target))
      }
      return target
    }

    if (t.kind === 'entities' && t.entity_type && typeId.has(t.entity_type)) {
      const names = sheet.rows.map((r) => val(r, t.name_column))
      const counts = new Map<string, number>()
      for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
      const first = sheet.header.find((h) => /^first ?name$/i.test(h))
      const last = sheet.header.find((h) => /^last ?name$/i.test(h))
      let created = 0
      sheet.rows.forEach((row, i) => {
        // A cell with no letters or digits (" · ", "-") or a placeholder ("(No owner)") is no name.
        const named = (v: string) => (v && /[a-z0-9]/i.test(v) && !rules.rx.placeholder.test(v.trim()) ? v : '')
        let name = named(val(row, t.name_column))
        const ext = val(row, t.id_column)
        if (first && last && (!name || name.includes('@'))) name = `${val(row, first)} ${val(row, last)}`.trim() || name
        if (!name && !ext) return
        // No name of its own (e.g. an asset without a customer tag): describe it from its type/description/model.
        if (!name) name = t.property_columns.filter((p) => /type|description|make|manufacturer|model/i.test(p)).map((p) => val(row, p)).filter(Boolean).slice(0, 2).join(' ')
        if (name && (counts.get(val(row, t.name_column)) ?? 0) > 1) name = `${name} · ${ext || t.links.map((l) => val(row, l.column)).find(Boolean) || `row ${i + 2}`}`
        // Known only by its id in this system (a technician by initials): say so, don't invent a name.
        const onlyId = !name && !!ext
        // Same thing already known: by this system's id, else by a name that is unique in this table.
        let id = (ext && index.find(t.entity_type!, ext, t.system, 'id')) || ((counts.get(val(row, t.name_column)) ?? 0) === 1 && name ? index.find(t.entity_type!, name, null, 'name') : undefined) || undefined
        const props: Record<string, unknown> = { source_system: t.system }
        for (const p of t.property_columns) if (val(row, p)) props[p] = val(row, p)
        if (onlyId) props.Description ??= `Known only as "${ext}" in ${t.system}`
        const source = { file_id: f.id, path: f.path, row: i + 2, system: t.system }
        if (!id) {
          id = create(t.entity_type!, name || ext, 'structured', props, { source })
          created++
        } else {
          // Created earlier from a bare link (e.g. a site id on an asset row): now we know its name and properties.
          const known = byId.get(id)
          if (known && known.metadata.origin === 'link') {
            known.name = (name || known.name).slice(0, 300)
            known.metadata = { ...known.metadata, origin: 'structured', source }
            index.addName(t.entity_type!, name, id)
            created++
          }
          if (known) Object.assign(known.properties, props)
          if (name) aliases.push({ entity: id, alias: name, kind: 'system_spelling' })
        }
        if (ext) (identifiers.push({ entity: id, system: t.system, value: ext }), index.addId(t.entity_type!, t.system, ext, id))
        for (const p of t.property_columns) {
          const system = strongIdSystem(p, rules)
          if (system && val(row, p)) (identifiers.push({ entity: id, system, value: val(row, p) }), index.addId(t.entity_type!, system, val(row, p), id))
        }
        evidence.push({ entity: id, file_id: f.id, row: i + 1, quote: row.join(' | ').slice(0, 500) })
        for (const l of t.links) {
          for (const v of multi(l.column, val(row, l.column), rules)) {
            const target = linkTarget(l, v, row)
            if (target && target !== id) rels.push({ type_id: relTypeId.get(l.relationship.toLowerCase()) ?? await_rel_placeholder(l.relationship), source: id, target })
          }
        }
      })
      report.push({ table: f.path, kind: 'entities', type: t.entity_type, rows: sheet.rows.length, created })
    }

    if (t.kind === 'events' && t.event_type && typeId.has(t.event_type)) {
      // Rows → events grouped by event id (invoice lines → one invoice). No id: each row is an event.
      const groups = new Map<string, string[][]>()
      sheet.rows.forEach((row, i) => {
        // Report footers and banners ("TOTAL", "Exported Friday…") are not events.
        if (row.slice(0, 3).some((c) => rules.rx.reportRow.test((c ?? '').trim()))) return
        const key = val(row, t.event_id_column) || `row-${i}`
        groups.set(key, [...(groups.get(key) ?? []), row])
      })
      for (const [key, rows] of groups) {
        const r0 = rows[0]
        const amount = t.amount_column ? rows.reduce((sum, r) => sum + (Number(val(r, t.amount_column).replace(/[$,]/g, '')) || 0), 0) : null
        const props: Record<string, unknown> = { source_system: t.system, date: val(r0, t.date_column) || null, ...(amount !== null ? { amount: Math.round(amount * 100) / 100 } : {}), ...(rows.length > 1 ? { lines: rows.length } : {}) }
        for (const p of t.property_columns) if (val(r0, p)) props[p] = val(r0, p).slice(0, 500)
        const ext = t.event_id_column && !key.startsWith('row-') ? key : ''
        let id = ext ? index.find(t.event_type, ext, t.system, 'id') : undefined
        if (!id) id = create(t.event_type, ext ? `${t.event_type} ${ext}` : `${t.event_type} ${props.date ?? ''}`.trim(), 'event', props, { source: { file_id: f.id, path: f.path, system: t.system } })
        else if (byId.get(id)) Object.assign(byId.get(id)!.properties, props)
        if (ext) (identifiers.push({ entity: id, system: t.system, value: ext }), index.addId(t.event_type, t.system, ext, id))
        const seen = new Set<string>()
        for (const r of rows) {
          for (const l of t.links) {
            for (const v of multi(l.column, val(r, l.column), rules)) {
              const target = linkTarget(l, v, r)
              const k = `${l.relationship}|${target}`
              if (target && target !== id && !seen.has(k)) {
                seen.add(k)
                rels.push({ type_id: relTypeId.get(l.relationship.toLowerCase()) ?? (await_rel_placeholder(l.relationship)), source: id, target })
              }
            }
          }
        }
      }
      report.push({ table: f.path, kind: 'events', type: t.event_type, rows: sheet.rows.length, events: groups.size })
    }
  }

  // Relationship types referenced by links but not proposed are created now.
  for (const [name, placeholder] of pendingRelTypes) {
    const real = await relType(name, '', '')
    for (const r of rels) if (r.type_id === placeholder) r.type_id = real
  }
  pendingRelTypes.clear()

  // ---- write ------------------------------------------------------------------
  const batch = async <T>(items: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) => {
    for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size))
  }
  await batch(entities, 2000, (chunk) =>
    sql.query(
      `insert into public.entities (id, tenant_id, entity_type_id, canonical_name, properties, status, metadata)
       select x.id, $1, x.type_id, x.name, x.properties, 'candidate', x.metadata
       from jsonb_to_recordset($2::jsonb) as x(id uuid, type_id uuid, name text, properties jsonb, metadata jsonb)`,
      [tenantId, JSON.stringify(chunk)],
    ),
  )
  const uniq = <T>(items: T[], key: (x: T) => string) => [...new Map(items.map((x) => [key(x), x])).values()]
  await batch(uniq(identifiers, (i) => `${i.entity}|${i.system}|${i.value}`), 4000, (chunk) =>
    sql.query(
      `insert into public.entity_identifiers (tenant_id, entity_id, system, value, status)
       select $1, x.entity, x.system, x.value, 'candidate' from jsonb_to_recordset($2::jsonb) as x(entity uuid, system text, value text)
       on conflict (entity_id, system, value) do nothing`,
      [tenantId, JSON.stringify(chunk)],
    ),
  )
  await batch(uniq(aliases, (a) => `${a.entity}|${a.alias.toLowerCase()}`), 4000, (chunk) =>
    sql.query(
      `insert into public.entity_aliases (tenant_id, entity_id, alias, kind, status, origin)
       select $1, x.entity, x.alias, x.kind, 'candidate', 'import' from jsonb_to_recordset($2::jsonb) as x(entity uuid, alias text, kind text)`,
      [tenantId, JSON.stringify(chunk)],
    ),
  )
  const relRows = uniq(rels, (r) => `${r.type_id}|${r.source}|${r.target}`)
  await batch(relRows, 5000, (chunk) =>
    sql.query(
      `insert into public.relationships (tenant_id, relationship_type_id, source_entity_id, target_entity_id, status, metadata)
       select $1, x.type_id, x.source, x.target, 'candidate', '{"origin":"structured"}' from jsonb_to_recordset($2::jsonb) as x(type_id uuid, source uuid, target uuid)`,
      [tenantId, JSON.stringify(chunk)],
    ),
  )
  // Provenance: each list entity points at the table passage that holds its row.
  await batch(evidence, 3000, (chunk) =>
    sql.query(
      `insert into public.evidence_links (tenant_id, evidence_id, entity_id, stance, quote, origin)
       select $1, ev.id, x.entity, 'supports', x.quote, 'import'
       from jsonb_to_recordset($2::jsonb) as x(entity uuid, file_id uuid, row int, quote text)
       join public.document_versions dv on dv.source_object_id = x.file_id
       join public.documents d on d.id = dv.document_id and d.current_version_id = dv.id
       join lateral (select e.id from public.evidence e where e.document_version_id = dv.id and e.kind = 'table'
                     and (e.locator ->> 'row_start')::int <= x.row and (e.locator ->> 'row_end')::int >= x.row limit 1) ev on true`,
      [tenantId, JSON.stringify(chunk)],
    ),
  )
  return { types: typeId.size, relationship_types: relTypeId.size, entities: entities.length, identifiers: identifiers.length, relationships: relRows.length, evidence_links: evidence.length, tables: report }
}

// Relationship names used by links but missing from the proposal get a placeholder id, replaced before writing.
const pendingRelTypes = new Map<string, string>()
function await_rel_placeholder(name: string): string {
  const key = name.toLowerCase()
  if (!pendingRelTypes.has(key)) pendingRelTypes.set(key, `pending:${key}`)
  return pendingRelTypes.get(key)!
}

/** Removes the previous unreviewed load (candidates and merged rows from loads), in chunks, dependents first. */
export async function clearLoad(sql: Sql, tenantId: string): Promise<number> {
  let total = 0
  for (;;) {
    const ids = (
      await sql.query<{ id: string }>(
        `select id from public.entities where tenant_id = $1 and status in ('candidate', 'merged') and metadata ->> 'origin' = any($2::text[]) limit 20000`,
        [tenantId, [...LOAD_ORIGINS]],
      )
    ).rows.map((r) => r.id)
    if (!ids.length) return total
    await sql.query(`delete from public.relationships where tenant_id = $1 and (source_entity_id = any($2::uuid[]) or target_entity_id = any($2::uuid[]))`, [tenantId, ids])
    await sql.query(`delete from public.facts where tenant_id = $1 and (subject_entity_id = any($2::uuid[]) or object_entity_id = any($2::uuid[]))`, [tenantId, ids])
    await sql.query(`delete from public.evidence_links where entity_id = any($1::uuid[])`, [ids])
    await sql.query(`delete from public.entity_identifiers where entity_id = any($1::uuid[])`, [ids])
    await sql.query(`delete from public.entity_aliases where entity_id = any($1::uuid[])`, [ids])
    // Entities merged into one of these (from an older load) lose their pointer first.
    await sql.query(`delete from public.entities where tenant_id = $1 and merged_into_id = any($2::uuid[]) and not (id = any($2::uuid[]))`, [tenantId, ids])
    await sql.query(`delete from public.entities where id = any($1::uuid[])`, [ids])
    total += ids.length
  }
}
