// Read models for visualising the company model: the business map (types and
// how they connect, with real counts), entity search, an entity's neighbourhood
// (events collapsed into counted links so a customer with 2,000 work orders stays
// readable), and an entity's full detail with the evidence behind it.

import { citation } from '../workbench/evidence-search'
import type { Sql } from '../storage/raw'

const LIVE = `e.status in ('candidate', 'active')`

// The business map aggregates every link (hundreds of thousands); it only changes when a model run finishes.
const MAP_TTL_MS = 120_000
const mapCache = new Map<string, { at: number; data: Promise<Awaited<ReturnType<typeof computeBusinessMap>>> }>()

export function businessMap(sql: Sql, tenantId: string, opts: { fresh?: boolean } = {}) {
  const hit = mapCache.get(tenantId)
  if (hit && !opts.fresh && Date.now() - hit.at < MAP_TTL_MS) return hit.data
  const data = computeBusinessMap(sql, tenantId)
  mapCache.set(tenantId, { at: Date.now(), data })
  data.catch(() => mapCache.delete(tenantId))
  return data
}

async function computeBusinessMap(sql: Sql, tenantId: string) {
  const types = (
    await sql.query(
      `select t.id, t.name, t.description, t.status, coalesce(t.metadata ->> 'kind', 'thing') kind, t.metadata -> 'examples' examples,
              p.name parent, count(e.id)::int entities
       from public.entity_types t left join public.entity_types p on p.id = t.parent_type_id
       left join public.entities e on e.entity_type_id = t.id and ${LIVE}
       where t.tenant_id = $1 group by t.id, p.name order by entities desc`,
      [tenantId],
    )
  ).rows
  const links = (
    await sql.query(
      `select rt.id, rt.name, rt.description, st.entity_type_id source_type, tt.entity_type_id target_type, count(*)::int n
       from public.relationships r
       join public.relationship_types rt on rt.id = r.relationship_type_id
       join public.entities st on st.id = r.source_entity_id
       join public.entities tt on tt.id = r.target_entity_id
       where r.tenant_id = $1 and r.status <> 'rejected' and rt.name <> 'possibly_same_as'
       group by rt.id, st.entity_type_id, tt.entity_type_id order by n desc`,
      [tenantId],
    )
  ).rows
  const resolution = (
    await sql.query<{ merged: number; rejected: number; unsure: number }>(
      `select (select count(*)::int from public.entities where tenant_id = $1 and status = 'merged') merged,
              (select count(*)::int from public.entities where tenant_id = $1 and status = 'rejected') rejected,
              (select count(*)::int from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id
               where r.tenant_id = $1 and rt.name = 'possibly_same_as' and r.status = 'candidate') unsure`,
      [tenantId],
    )
  ).rows[0]
  return { types, links, resolution }
}

/** The most connected entities of a type (what the business revolves around). */
export async function topEntities(sql: Sql, tenantId: string, typeId: string, limit = 25) {
  return (
    await sql.query(
      `select e.id, e.canonical_name name, e.status,
              (select count(*)::int from public.relationships r where r.tenant_id = e.tenant_id and (r.source_entity_id = e.id or r.target_entity_id = e.id)) degree
       from public.entities e where e.tenant_id = $1 and e.entity_type_id = $2 and ${LIVE}
       order by degree desc, e.canonical_name limit $3`,
      [tenantId, typeId, limit],
    )
  ).rows
}

export async function searchEntities(sql: Sql, tenantId: string, q: string, limit = 20) {
  return (
    await sql.query(
      `select e.id, e.canonical_name name, t.name type, coalesce(t.metadata ->> 'kind', 'thing') kind,
              greatest(similarity(lower(e.canonical_name), lower($2)),
                       coalesce((select max(similarity(a.normalized_alias, lower($2))) from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected'), 0)) score
       from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and ${LIVE}
         and (lower(e.canonical_name) like '%' || lower($2) || '%' or lower(e.canonical_name) % lower($2)
              or exists (select 1 from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected' and (a.normalized_alias like '%' || lower($2) || '%'))
              or exists (select 1 from public.entity_identifiers i where i.entity_id = e.id and lower(i.value) = lower($2)))
       order by coalesce(t.metadata ->> 'kind', 'thing') = 'event', score desc, e.canonical_name limit $3`,
      [tenantId, q, limit],
    )
  ).rows
}

export interface GraphNode {
  id: string
  label: string
  type: string
  kind: 'thing' | 'event' | 'cluster'
  count?: number
  focus?: boolean
}
export interface GraphEdge {
  source: string
  target: string
  label: string
  count?: number
  derived?: boolean
}

const CLUSTER_OVER = 12

/**
 * An entity's neighbourhood. Direct neighbours are shown individually up to a
 * limit, else as one counted cluster node per (relationship, type). For event
 * neighbours (work orders, invoices…), the things on the other side of those
 * events are shown with derived edges ("412 work orders" between a customer
 * and a technician), so the picture shows how things actually connect.
 */
export async function neighbourhood(sql: Sql, tenantId: string, entityId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const focus = (
    await sql.query<{ id: string; name: string; type: string; kind: string }>(
      `select e.id, e.canonical_name name, t.name type, coalesce(t.metadata ->> 'kind', 'thing') kind
       from public.entities e join public.entity_types t on t.id = e.entity_type_id where e.tenant_id = $1 and e.id = $2`,
      [tenantId, entityId],
    )
  ).rows[0]
  if (!focus) return { nodes: [], edges: [] }
  const nodes = new Map<string, GraphNode>([[focus.id, { id: focus.id, label: focus.name, type: focus.type, kind: focus.kind as GraphNode['kind'], focus: true }]])
  const edges: GraphEdge[] = []

  // Direct neighbours, grouped by relationship, direction and type.
  const direct = (
    await sql.query<{ rel: string; dir: 'out' | 'in'; type: string; kind: string; n: number; sample: { id: string; name: string }[] }>(
      `select rt.name rel, x.dir, t.name type, coalesce(t.metadata ->> 'kind', 'thing') kind, count(*)::int n,
              to_jsonb((array_agg(jsonb_build_object('id', o.id, 'name', o.canonical_name) order by o.canonical_name))[1:${CLUSTER_OVER}]) sample
       from (select r.relationship_type_id, r.target_entity_id other, 'out' dir from public.relationships r where r.tenant_id = $1 and r.source_entity_id = $2 and r.status <> 'rejected'
             union all
             select r.relationship_type_id, r.source_entity_id other, 'in' dir from public.relationships r where r.tenant_id = $1 and r.target_entity_id = $2 and r.status <> 'rejected') x
       join public.relationship_types rt on rt.id = x.relationship_type_id
       join public.entities o on o.id = x.other and o.status in ('candidate', 'active')
       join public.entity_types t on t.id = o.entity_type_id
       group by rt.name, x.dir, t.name, t.metadata ->> 'kind' order by n desc`,
      [tenantId, entityId],
    )
  ).rows
  for (const g of direct) {
    if (g.n <= CLUSTER_OVER) {
      for (const o of g.sample) {
        if (!nodes.has(o.id)) nodes.set(o.id, { id: o.id, label: o.name, type: g.type, kind: g.kind as GraphNode['kind'] })
        edges.push(g.dir === 'out' ? { source: focus.id, target: o.id, label: g.rel } : { source: o.id, target: focus.id, label: g.rel })
      }
    } else {
      const cid = `cluster:${g.rel}:${g.dir}:${g.type}`
      nodes.set(cid, { id: cid, label: `${g.n.toLocaleString()} ${g.type}${g.n === 1 ? '' : 's'}`, type: g.type, kind: 'cluster', count: g.n })
      edges.push(g.dir === 'out' ? { source: focus.id, target: cid, label: g.rel, count: g.n } : { source: cid, target: focus.id, label: g.rel, count: g.n })
    }
  }

  // Through events: what sits on the other side of this entity's events (top 6 per type).
  if (focus.kind !== 'event') {
    const via = (
      await sql.query<{ event_type: string; rel: string; type: string; id: string; name: string; n: number; rnk: number }>(
        `with ev as (
           select o.id, t.name event_type from (
             select r.source_entity_id other from public.relationships r where r.tenant_id = $1 and r.target_entity_id = $2
             union select r.target_entity_id from public.relationships r where r.tenant_id = $1 and r.source_entity_id = $2) x
           join public.entities o on o.id = x.other join public.entity_types t on t.id = o.entity_type_id
           where coalesce(t.metadata ->> 'kind', 'thing') = 'event'),
         far as (
           select ev.event_type, rt.name rel, t.name type, o.id, o.canonical_name name, count(*)::int n
           from ev join public.relationships r on r.tenant_id = $1 and r.source_entity_id = ev.id
           join public.relationship_types rt on rt.id = r.relationship_type_id
           join public.entities o on o.id = r.target_entity_id and o.id <> $2 and o.status in ('candidate', 'active')
           join public.entity_types t on t.id = o.entity_type_id and coalesce(t.metadata ->> 'kind', 'thing') <> 'event'
           group by 1, 2, 3, 4, 5)
         select * from (select far.*, row_number() over (partition by event_type, type order by n desc) rnk from far) z where rnk <= 6`,
        [tenantId, entityId],
      )
    ).rows
    for (const v of via) {
      if (!nodes.has(v.id)) nodes.set(v.id, { id: v.id, label: v.name, type: v.type, kind: 'thing' })
      edges.push({ source: focus.id, target: v.id, label: `${v.n.toLocaleString()} ${v.event_type.toLowerCase()}${v.n === 1 ? '' : 's'}`, count: v.n, derived: true })
    }
  }
  return { nodes: [...nodes.values()], edges }
}

export async function entityDetail(sql: Sql, tenantId: string, entityId: string) {
  const entity = (
    await sql.query(
      `select e.id, e.canonical_name name, e.description, e.properties, e.status, e.confidence, e.metadata, e.valid_from, e.valid_to,
              t.name type, coalesce(t.metadata ->> 'kind', 'thing') kind
       from public.entities e join public.entity_types t on t.id = e.entity_type_id where e.tenant_id = $1 and e.id = $2`,
      [tenantId, entityId],
    )
  ).rows[0]
  if (!entity) return null
  const [aliases, identifiers, facts, merged, evidence, relCounts] = await Promise.all([
    sql.query(`select alias, kind, status, context from public.entity_aliases where entity_id = $1 order by kind, alias`, [entityId]),
    sql.query(`select system, value, status from public.entity_identifiers where entity_id = $1 order by system`, [entityId]),
    sql.query(
      `select f.id, f.predicate, f.value, o.canonical_name object, f.valid_from, f.valid_to, f.authority, f.confidence, f.status, f.note,
              coalesce((select jsonb_agg(jsonb_build_object('quote', l.quote, 'evidence_id', l.evidence_id, 'stance', l.stance)) from public.evidence_links l where l.fact_id = f.id), '[]') evidence
       from public.facts f left join public.entities o on o.id = f.object_entity_id
       where f.tenant_id = $1 and (f.subject_entity_id = $2 or f.object_entity_id = $2) order by f.valid_from nulls last, f.predicate`,
      [tenantId, entityId],
    ),
    sql.query(`select id, canonical_name name, properties ->> 'source_system' system, metadata ->> 'merge_reason' why from public.entities where merged_into_id = $1 order by 2`, [entityId]),
    sql.query(
      `select l.quote, l.stance, e.id evidence_id, e.kind, e.page_number, e.section_path, e.start_ms, e.end_ms, e.speaker, e.observed_at, e.locator,
              so.id file_id, so.original_path file_path
       from public.evidence_links l join public.evidence e on e.id = l.evidence_id
       join public.document_versions dv on dv.id = e.document_version_id join public.source_objects so on so.id = dv.source_object_id
       where l.entity_id = $1 order by e.kind, so.original_path limit 60`,
      [entityId],
    ),
    sql.query(
      `select rt.name rel, t.name type, count(*)::int n from (
         select relationship_type_id, target_entity_id other from public.relationships where tenant_id = $1 and source_entity_id = $2
         union all select relationship_type_id, source_entity_id from public.relationships where tenant_id = $1 and target_entity_id = $2) x
       join public.relationship_types rt on rt.id = x.relationship_type_id join public.entities o on o.id = x.other join public.entity_types t on t.id = o.entity_type_id
       group by 1, 2 order by 3 desc`,
      [tenantId, entityId],
    ),
  ])
  return {
    ...entity,
    aliases: aliases.rows,
    identifiers: identifiers.rows,
    facts: facts.rows,
    merged_from: merged.rows,
    evidence: evidence.rows.map((r: any) => ({ ...r, citation: citation(r) })),
    connections: relCounts.rows,
  }
}

/** Members of a cluster node (e.g. a customer's work orders), newest first. */
export async function clusterMembers(sql: Sql, tenantId: string, entityId: string, rel: string, dir: 'out' | 'in', type: string, limit = 100) {
  return (
    await sql.query(
      `select o.id, o.canonical_name name, o.properties ->> 'date' date, o.properties ->> 'amount' amount
       from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id and rt.name = $3
       join public.entities o on o.id = case when $4 = 'out' then r.target_entity_id else r.source_entity_id end
       join public.entity_types t on t.id = o.entity_type_id and t.name = $5
       where r.tenant_id = $1 and case when $4 = 'out' then r.source_entity_id else r.target_entity_id end = $2
       order by o.properties ->> 'date' desc nulls last limit $6`,
      [tenantId, entityId, rel, dir, type, limit],
    )
  ).rows
}

/** Facts and vocabulary read from prose, grouped for review: exceptions, risks, key people, practices, history, policies. */
export async function knowledgeOverview(sql: Sql, tenantId: string) {
  const facts = (
    await sql.query(
      `select f.id, f.predicate, f.value #>> '{}' value, f.valid_from, f.valid_to, f.authority, f.confidence, f.status,
              f.metadata ->> 'kind' kind, f.metadata ->> 'certainty' certainty,
              s.id subject_id, s.canonical_name subject, st.name subject_type, o.id object_id, o.canonical_name object,
              l.quote, ev.id evidence_id, ev.kind evidence_kind, ev.page_number, ev.section_path, ev.start_ms, ev.end_ms, ev.speaker, ev.observed_at, ev.locator,
              so.id file_id, so.original_path file_path
       from public.facts f
       join public.entities s on s.id = f.subject_entity_id join public.entity_types st on st.id = s.entity_type_id
       left join public.entities o on o.id = f.object_entity_id
       left join lateral (select * from public.evidence_links l where l.fact_id = f.id limit 1) l on true
       left join public.evidence ev on ev.id = l.evidence_id
       left join public.document_versions dv on dv.id = ev.document_version_id
       left join public.source_objects so on so.id = dv.source_object_id
       where f.tenant_id = $1 and f.status <> 'rejected'
       order by f.metadata ->> 'kind', s.canonical_name, f.valid_from nulls last`,
      [tenantId],
    )
  ).rows.map((r: any) => ({ ...r, citation: r.file_path ? citation({ ...r, kind: r.evidence_kind }) : null }))
  const terms = (
    await sql.query(
      `select e.id, e.canonical_name term, e.description meaning,
              (select jsonb_build_object('id', o.id, 'name', o.canonical_name, 'type', ot.name) from public.relationships r
               join public.entities o on o.id = r.target_entity_id join public.entity_types ot on ot.id = o.entity_type_id
               where r.source_entity_id = e.id limit 1) refers_to,
              (select l.quote from public.evidence_links l where l.entity_id = e.id limit 1) quote,
              (select count(*)::int from public.evidence_links l where l.entity_id = e.id) mentions
       from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and t.name = 'Term' and e.status in ('candidate', 'active') order by mentions desc, e.canonical_name`,
      [tenantId],
    )
  ).rows
  return { facts, terms }
}
