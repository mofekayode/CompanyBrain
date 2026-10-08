// Entity resolution: different names for the same real thing become one entity;
// genuinely ambiguous ones stay separate.
//
// 1. Certain merges: same normalized name, or a shared strong identifier
//    (serial number, VIN, email) within a type.
// 2. Candidate groups: similar spellings (trigram) or one name contained in
//    another ("Kemper" / "Kemper Molding"), grouped into small components.
// 3. Claude partitions each component into real-world things using names,
//    systems, ids, properties and activity, and flags placeholders ("Cash cust").
//    Unsure pairs are linked as possibly_same_as instead of merged.
// 4. Merges move relationships, facts, evidence links and identifiers to the
//    survivor; every merged spelling becomes an alias. Nothing is deleted.

import { structured } from '../claude'
import { rulesFor, withContext } from '../config/tenant-config'
import type { Sql } from '../storage/raw'
import { normalizeName } from './load'

// Thresholds (strong id systems, small/large type sizes, batch size) come from the tenant's resolution rules.

interface Row {
  id: string
  name: string
  props: Record<string, unknown>
  ids: { system: string; value: string }[]
  activity: Record<string, number>
}

class UnionFind {
  parent = new Map<string, string>()
  find(x: string): string {
    let r = x
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r)!
    this.parent.set(x, r)
    return r
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

/** Two normalized names likely denote the same thing: one's words are a prefix-subset of the other's. */
export function containsName(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  const s = short.split(' ').filter(Boolean)
  const l = long.split(' ').filter(Boolean)
  if (!s.length || !s.some((w) => w.length >= 4)) return false
  return s.every((w) => l.some((x) => x === w || (w.length >= 4 && x.startsWith(w))))
}

const PARTITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups', 'placeholders', 'unsure'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['members', 'canonical_name', 'why'],
        properties: { members: { type: 'array', items: { type: 'string' } }, canonical_name: { type: 'string' }, why: { type: 'string' } },
      },
    },
    placeholders: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'why'], properties: { id: { type: 'string' }, why: { type: 'string' } } },
    },
    unsure: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['a', 'b', 'why'], properties: { a: { type: 'string' }, b: { type: 'string' }, why: { type: 'string' } } },
    },
  },
}

async function loadRows(sql: Sql, tenantId: string, typeId: string): Promise<Row[]> {
  const { rows } = await sql.query<{ id: string; name: string; props: Record<string, unknown>; ids: { system: string; value: string }[]; activity: Record<string, number> | null }>(
    `select e.id, e.canonical_name name, e.properties props,
            coalesce((select jsonb_agg(jsonb_build_object('system', i.system, 'value', i.value)) from public.entity_identifiers i where i.entity_id = e.id), '[]') ids,
            (select jsonb_object_agg(x.name, x.n) from (
               select rt.name, count(*)::int n from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id
               where r.tenant_id = e.tenant_id and r.target_entity_id = e.id group by rt.name order by 2 desc limit 4) x) activity
     from public.entities e where e.tenant_id = $1 and e.entity_type_id = $2 and e.status in ('candidate', 'active')`,
    [tenantId, typeId],
  )
  return rows.map((r) => ({ ...r, activity: r.activity ?? {} }))
}

/** Merges `others` into `survivor`: moves everything, records aliases, marks them merged. */
export async function mergeInto(sql: Sql, tenantId: string, survivor: string, others: string[], why: string, canonicalName?: string) {
  const ids = others.filter((o) => o !== survivor)
  if (!ids.length) return
  await sql.query(
    `insert into public.entity_aliases (tenant_id, entity_id, alias, kind, status, origin, context)
     select $1, $2, e.canonical_name, 'system_spelling', 'candidate', 'ai', jsonb_build_object('merged_from', e.id, 'source_system', e.properties ->> 'source_system')
     from public.entities e where e.id = any($3::uuid[])
       and not exists (select 1 from public.entity_aliases a where a.entity_id = $2 and a.normalized_alias = lower(btrim(regexp_replace(e.canonical_name, '\\s+', ' ', 'g'))))`,
    [tenantId, survivor, ids],
  )
  await sql.query(`update public.entity_aliases set entity_id = $2 where entity_id = any($1::uuid[])`, [ids, survivor])
  await sql.query(
    `update public.entity_identifiers i set entity_id = $2 where entity_id = any($1::uuid[])
       and not exists (select 1 from public.entity_identifiers j where j.entity_id = $2 and j.system = i.system and j.value = i.value)`,
    [ids, survivor],
  )
  await sql.query(`delete from public.entity_identifiers where entity_id = any($1::uuid[])`, [ids])
  await sql.query(`update public.relationships set source_entity_id = $2 where tenant_id = $3 and source_entity_id = any($1::uuid[])`, [ids, survivor, tenantId])
  await sql.query(`update public.relationships set target_entity_id = $2 where tenant_id = $3 and target_entity_id = any($1::uuid[])`, [ids, survivor, tenantId])
  // Self-links and duplicate edges created by the move.
  await sql.query(`delete from public.relationships where tenant_id = $1 and source_entity_id = $2 and target_entity_id = $2`, [tenantId, survivor])
  await sql.query(
    `delete from public.relationships r using public.relationships k
     where r.tenant_id = $1 and k.tenant_id = $1 and (r.source_entity_id = $2 or r.target_entity_id = $2)
       and r.relationship_type_id = k.relationship_type_id and r.source_entity_id = k.source_entity_id and r.target_entity_id = k.target_entity_id and r.id > k.id`,
    [tenantId, survivor],
  )
  await sql.query(`update public.facts set subject_entity_id = $2 where tenant_id = $3 and subject_entity_id = any($1::uuid[])`, [ids, survivor, tenantId])
  await sql.query(`update public.facts set object_entity_id = $2 where tenant_id = $3 and object_entity_id = any($1::uuid[])`, [ids, survivor, tenantId])
  await sql.query(`update public.evidence_links set entity_id = $2 where entity_id = any($1::uuid[])`, [ids, survivor])
  await sql.query(
    `update public.entities s set properties = (select coalesce(jsonb_object_agg(k, v), '{}') from (
        select distinct on (k) k, v from (select (jsonb_each(e.properties)).* , e.id = s.id as own from public.entities e where e.id = s.id or e.id = any($2::uuid[])) x(k, v, own)
        order by k, own desc) y),
       canonical_name = coalesce($3, canonical_name),
       metadata = metadata || jsonb_build_object('merged', (coalesce((metadata -> 'merged')::int, 0) + $4))
     where s.id = $1`,
    [survivor, ids, canonicalName ?? null, ids.length],
  )
  await sql.query(
    `update public.entities set status = 'merged', merged_into_id = $2, metadata = metadata || jsonb_build_object('merge_reason', $3::text) where id = any($1::uuid[])`,
    [ids, survivor, why],
  )
}

/**
 * Many merges at once (certain ones: same name, shared serial/VIN/email): the same
 * moves as mergeInto, set-based over a map of old → survivor, in chunks.
 */
export async function mergeMany(sql: Sql, tenantId: string, merges: { survivor: string; others: string[] }[], why: string): Promise<number> {
  const pairs = merges.flatMap((m) => m.others.filter((o) => o !== m.survivor).map((o) => ({ old: o, new: m.survivor })))
  for (let i = 0; i < pairs.length; i += 2000) {
    const map = JSON.stringify(pairs.slice(i, i + 2000))
    const M = `(select x.old, x.new from jsonb_to_recordset($1::jsonb) as x(old uuid, new uuid))`
    await sql.query(
      `insert into public.entity_aliases (tenant_id, entity_id, alias, kind, status, origin, context)
       select distinct on (m.new, lower(e.canonical_name)) $2::uuid, m.new, e.canonical_name, 'system_spelling', 'candidate', 'ai', jsonb_build_object('merged_from', e.id, 'source_system', e.properties ->> 'source_system')
       from ${M} m join public.entities e on e.id = m.old`,
      [map, tenantId],
    )
    await sql.query(`update public.entity_aliases a set entity_id = m.new from ${M} m where a.entity_id = m.old`, [map])
    await sql.query(
      `insert into public.entity_identifiers (tenant_id, entity_id, system, value, status)
       select i.tenant_id, m.new, i.system, i.value, i.status from public.entity_identifiers i join ${M} m on i.entity_id = m.old
       on conflict (entity_id, system, value) do nothing`,
      [map],
    )
    await sql.query(`delete from public.entity_identifiers i using ${M} m where i.entity_id = m.old`, [map])
    await sql.query(`update public.relationships r set source_entity_id = m.new from ${M} m where r.tenant_id = $2 and r.source_entity_id = m.old`, [map, tenantId])
    await sql.query(`update public.relationships r set target_entity_id = m.new from ${M} m where r.tenant_id = $2 and r.target_entity_id = m.old`, [map, tenantId])
    await sql.query(`update public.facts f set subject_entity_id = m.new from ${M} m where f.tenant_id = $2 and f.subject_entity_id = m.old`, [map, tenantId])
    await sql.query(`update public.facts f set object_entity_id = m.new from ${M} m where f.tenant_id = $2 and f.object_entity_id = m.old`, [map, tenantId])
    await sql.query(`update public.evidence_links l set entity_id = m.new from ${M} m where l.entity_id = m.old`, [map])
    await sql.query(
      `update public.entities e set status = 'merged', merged_into_id = m.new, metadata = e.metadata || jsonb_build_object('merge_reason', $2::text) from ${M} m where e.id = m.old`,
      [map, why],
    )
    // Self-links and duplicate edges among the survivors' links.
    const survivors = JSON.stringify([...new Set(pairs.slice(i, i + 2000).map((p) => p.new))])
    await sql.query(
      `delete from public.relationships where tenant_id = $1 and source_entity_id = target_entity_id and source_entity_id in (select jsonb_array_elements_text($2::jsonb)::uuid)`,
      [tenantId, survivors],
    )
    await sql.query(
      `delete from public.relationships r using public.relationships k
       where r.tenant_id = $1 and k.tenant_id = $1 and r.id > k.id and r.relationship_type_id = k.relationship_type_id
         and r.source_entity_id = k.source_entity_id and r.target_entity_id = k.target_entity_id
         and (r.source_entity_id in (select jsonb_array_elements_text($2::jsonb)::uuid) or r.target_entity_id in (select jsonb_array_elements_text($2::jsonb)::uuid))`,
      [tenantId, survivors],
    )
  }
  return pairs.length
}

/** Picks the survivor: most identifiers, then most activity, then longest name. */
function survivorOf(rows: Row[]): Row {
  const score = (r: Row) => r.ids.length * 1000 + Object.values(r.activity).reduce((a, b) => a + b, 0)
  return [...rows].sort((a, b) => score(b) - score(a) || b.name.length - a.name.length)[0]
}

export async function resolveType(sql: Sql, tenantId: string, typeId: string, typeName: string): Promise<{ certain: number; ai_merged: number; placeholders: number; unsure: number; components: number }> {
  const rules = await rulesFor(sql, tenantId)
  const { strong_systems, strong_min_length, max_fuzzy, small_type_max, max_component } = rules.resolution
  const rows = await loadRows(sql, tenantId, typeId)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const uf = new UnionFind()
  // 1. Certain: same normalized name, or shared strong identifier.
  const byName = new Map<string, string>()
  const byStrong = new Map<string, string>()
  for (const r of rows) {
    const n = normalizeName(r.name, rules)
    if (n.length >= 3) byName.has(n) ? uf.union(byName.get(n)!, r.id) : byName.set(n, r.id)
    for (const i of r.ids.filter((i) => strong_systems.includes(i.system) && i.value.trim().length >= strong_min_length)) {
      const k = `${i.system}|${i.value.trim().toLowerCase()}`
      byStrong.has(k) ? uf.union(byStrong.get(k)!, r.id) : byStrong.set(k, r.id)
    }
  }
  const groups = new Map<string, string[]>()
  for (const r of rows) groups.set(uf.find(r.id), [...(groups.get(uf.find(r.id)) ?? []), r.id])
  const certainMerges = [...groups.values()].filter((m) => m.length > 1).map((members) => ({ survivor: survivorOf(members.map((m) => byId.get(m)!)).id, others: members }))
  const certain = await mergeMany(sql, tenantId, certainMerges, 'same normalized name or shared identifier')
  const roots = [...groups.values()].map((m) => survivorOf(m.map((x) => byId.get(x)!)))
  if (roots.length > max_fuzzy) return { certain, ai_merged: 0, placeholders: 0, unsure: 0, components: 0 }

  // 2. Candidate components: similar or contained names.
  const norm = new Map(roots.map((r) => [r.id, normalizeName(r.name, rules)]))
  const sim = (a: string, b: string) => {
    const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 2) }, (_, i) => s.slice(i, i + 3)))
    const ga = grams(`  ${a} `)
    const gb = grams(`  ${b} `)
    let inter = 0
    for (const g of ga) if (gb.has(g)) inter++
    return inter / (ga.size + gb.size - inter || 1)
  }
  const fuzzy = new UnionFind()
  const edges: [string, string][] = []
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = norm.get(roots[i].id)!
      const b = norm.get(roots[j].id)!
      if (!a || !b) continue
      if (sim(a, b) >= 0.5 || containsName(a, b)) {
        fuzzy.union(roots[i].id, roots[j].id)
        edges.push([roots[i].id, roots[j].id])
      }
    }
  }
  // Small types (branches, rate types…) are reviewed as a whole: jargon like "J-town" for the
  // Louisville (Jeffersontown) branch shares no spelling with its official name.
  if (roots.length > 1 && roots.length <= small_type_max) for (const r of roots.slice(1)) (fuzzy.union(roots[0].id, r.id), edges.push([roots[0].id, r.id]))
  const comps = new Map<string, Row[]>()
  for (const [a, b] of edges) for (const x of [a, b]) {
    const k = fuzzy.find(x)
    if (!comps.get(k)?.some((r) => r.id === x)) comps.set(k, [...(comps.get(k) ?? []), byId.get(x)!])
  }
  // Big components are split into chunks of similar names.
  const batches: Row[][] = []
  for (const c of comps.values()) {
    const sorted = [...c].sort((a, b) => normalizeName(a.name, rules).localeCompare(normalizeName(b.name, rules)))
    for (let i = 0; i < sorted.length; i += max_component) batches.push(sorted.slice(i, i + max_component))
  }

  // 3. Claude partitions, a few components per call.
  let aiMerged = 0
  let placeholders = 0
  let unsure = 0
  const possiblySame = await ensurePossiblySame(sql, tenantId, typeId)
  const describe = (r: Row) =>
    `${r.id} | "${r.name}" | systems: ${[...new Set([r.props.source_system, ...r.ids.map((i) => i.system)].filter(Boolean))].join(', ')} | ids: ${r.ids
      .slice(0, 4)
      .map((i) => `${i.system}:${i.value}`)
      .join(', ')} | ${Object.entries(r.props)
      .filter(([k]) => k !== 'source_system')
      .slice(0, 5)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 50)}`)
      .join('; ')} | activity: ${Object.entries(r.activity)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`
  for (let i = 0; i < batches.length; i += 6) {
    const chunk = batches.slice(i, i + 6)
    const out = await structured<{ groups: { members: string[]; canonical_name: string; why: string }[]; placeholders: { id: string; why: string }[]; unsure: { a: string; b: string; why: string }[] }>({
      system: `You resolve duplicate records of type "${typeName}" from a company's systems (CRM, accounting, dispatch, spreadsheets). Merge only when the records clearly denote the same real-world ${typeName} (same organisation or site, spelled differently or abbreviated). Different plants or sites of one company are NOT the same ${typeName} unless the type is the parent organisation. When in doubt, do not merge: list the pair as unsure.${withContext(rules)}`,
      prompt: `Each block lists candidate records (id | name | systems | ids | properties | activity). For each block, return groups of ids that are the same real-world ${typeName} (only groups with 2+ members), with the best canonical name; ids that are placeholders rather than a real ${typeName} (e.g. "cash", "misc", "COD walk-in", "unknown"); and unsure pairs.

${chunk.map((c, k) => `## Block ${k + 1}\n${c.map(describe).join('\n')}`).join('\n\n')}`,
      schema: PARTITION_SCHEMA,
      effort: 'medium',
    })
    const known = new Set(chunk.flat().map((r) => r.id))
    for (const g of out.groups) {
      const members = [...new Set(g.members)].filter((m) => known.has(m) && byId.get(m))
      if (members.length < 2) continue
      const s = survivorOf(members.map((m) => byId.get(m)!))
      await mergeInto(sql, tenantId, s.id, members, `AI: ${g.why}`, g.canonical_name || undefined)
      aiMerged += members.length - 1
    }
    for (const p of out.placeholders.filter((p) => known.has(p.id))) {
      await sql.query(`update public.entities set status = 'rejected', metadata = metadata || jsonb_build_object('rejected_reason', $2::text) where id = $1 and status = 'candidate'`, [p.id, `placeholder: ${p.why}`])
      placeholders++
    }
    for (const u of out.unsure.filter((u) => known.has(u.a) && known.has(u.b))) {
      await sql.query(
        `insert into public.relationships (tenant_id, relationship_type_id, source_entity_id, target_entity_id, status, metadata)
         values ($1, $2, $3, $4, 'candidate', $5)`,
        [tenantId, possiblySame, u.a, u.b, JSON.stringify({ origin: 'resolution', why: u.why })],
      )
      unsure++
    }
  }
  return { certain, ai_merged: aiMerged, placeholders, unsure, components: batches.length }
}

async function ensurePossiblySame(sql: Sql, tenantId: string, typeId: string): Promise<string> {
  const { rows } = await sql.query<{ id: string }>(
    `insert into public.relationship_types (tenant_id, name, description, is_symmetric, status, origin)
     values ($1, 'possibly_same_as', 'Resolution could not decide whether these are the same thing: FDE to review', true, 'active', 'ai')
     on conflict (tenant_id, lower(name)) do update set name = excluded.name returning id`,
    [tenantId],
  )
  void typeId
  return rows[0].id
}

/** Resolves every non-event type of the client's ontology. */
export async function resolveAll(sql: Sql, tenantId: string): Promise<Record<string, unknown>> {
  const types = (
    await sql.query<{ id: string; name: string; n: number }>(
      `select t.id, t.name, count(e.*)::int n from public.entity_types t join public.entities e on e.entity_type_id = t.id and e.status in ('candidate', 'active')
       where t.tenant_id = $1 and coalesce(t.metadata ->> 'kind', 'thing') <> 'event' group by t.id order by 3`,
      [tenantId],
    )
  ).rows
  const out: Record<string, unknown> = {}
  for (const t of types) out[t.name] = { before: t.n, ...(await resolveType(sql, tenantId, t.id, t.name)) }
  return out
}
