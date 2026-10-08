// Relationship review: hundreds of thousands of links come from system exports, so nobody
// reviews them one by one. Instead the data tells us what "normal" looks like and we show
// the exceptions:
//
// - Single-valued links with several targets. When almost every source has exactly one
//   target for a link type (an asset's customer, a customer's account owner), the few with
//   two or more are worth a look: a stale owner, a bad import, a real shared asset.
// - Triangles that disagree. When A → B and A → C → B' usually land on the same thing
//   (an asset's customer = the customer of the site it sits at), the cases where B ≠ B'
//   are flagged. Patterns are learned per tenant; nothing here knows Riverton's ontology.
// - Prose links (vocabulary "refers to", AI-proposed links) still waiting for a decision.
//
// Decisions are recorded on the relationship (accepted / rejected / ended), never deleted.

import type { Sql } from '../storage/raw'

const ACTIVE = `r.status not in ('rejected', 'superseded') and (r.valid_to is null or r.valid_to >= current_date)`

export interface LinkRef {
  id: string
  name: string
  type: string
}
export interface RelIssue {
  kind: 'several_targets' | 'triangle'
  key: string
  title: string
  detail: string
  source: LinkRef
  links: { relationship_id: string; type: string; target: LinkRef; origin: string | null; valid_from: string | null }[]
}
export interface RelTypeRow {
  type: string
  source_type: string
  target_type: string
  source_kind: string | null
  total: number
  candidate: number
  accepted: number
  rejected: number
  origin: string | null
}

/** Every link type with its volume and decisions, the shape of the graph. */
export async function relationshipSummary(sql: Sql, tenantId: string): Promise<RelTypeRow[]> {
  return (
    await sql.query<RelTypeRow>(
      `select rt.name type, st.name source_type, tt.name target_type, st.metadata ->> 'kind' source_kind, count(*)::int total,
              count(*) filter (where r.status = 'candidate')::int candidate, count(*) filter (where r.status = 'accepted')::int accepted,
              count(*) filter (where r.status = 'rejected')::int rejected, mode() within group (order by r.metadata ->> 'origin') origin
       from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id
       join public.entities s on s.id = r.source_entity_id join public.entity_types st on st.id = s.entity_type_id
       join public.entities t on t.id = r.target_entity_id join public.entity_types tt on tt.id = t.entity_type_id
       where r.tenant_id = $1 group by 1, 2, 3, 4 order by total desc`,
      [tenantId],
    )
  ).rows
}

/**
 * Link types that are single-valued in practice (≥ `share` of sources have one target),
 * and the sources that break the pattern.
 */
export async function severalTargets(sql: Sql, tenantId: string, share = 0.85, limit = 300): Promise<RelIssue[]> {
  const rows = (
    await sql.query<{
      rel_type: string
      source_id: string
      source_name: string
      source_type: string
      targets: { relationship_id: string; id: string; name: string; type: string; origin: string | null; valid_from: string | null }[]
      single_share: number
      sources: number
    }>(
      `with active as (
         select r.id, r.relationship_type_id, r.source_entity_id, r.target_entity_id, r.metadata ->> 'origin' origin, r.valid_from
         from public.relationships r join public.entities s on s.id = r.source_entity_id and s.status in ('candidate', 'active')
         join public.entities t on t.id = r.target_entity_id and t.status in ('candidate', 'active')
         where r.tenant_id = $1 and ${ACTIVE}),
       per_source as (
         select relationship_type_id, source_entity_id, count(distinct target_entity_id) n from active group by 1, 2),
       single_valued as (
         select relationship_type_id, avg((n = 1)::int) single_share, count(*) sources from per_source group by 1
         having count(*) >= 5 and avg((n = 1)::int) >= $2 and avg((n = 1)::int) < 1)
       select rt.name rel_type, s.id source_id, s.canonical_name source_name, st.name source_type, sv.single_share::float, sv.sources::int,
              jsonb_agg(jsonb_build_object('relationship_id', a.id, 'id', t.id, 'name', t.canonical_name, 'type', tt.name, 'origin', a.origin, 'valid_from', a.valid_from) order by a.valid_from nulls first) targets
       from per_source ps join single_valued sv using (relationship_type_id)
       join active a on a.relationship_type_id = ps.relationship_type_id and a.source_entity_id = ps.source_entity_id
       join public.relationship_types rt on rt.id = ps.relationship_type_id
       join public.entities s on s.id = ps.source_entity_id join public.entity_types st on st.id = s.entity_type_id
       join public.entities t on t.id = a.target_entity_id join public.entity_types tt on tt.id = t.entity_type_id
       where ps.n > 1 and (st.metadata ->> 'kind') is distinct from 'event'
       group by rt.name, s.id, s.canonical_name, st.name, sv.single_share, sv.sources
       order by sv.single_share desc, count(*) desc
       limit $3`,
      [tenantId, share, limit],
    )
  ).rows
  return rows.map((r) => ({
    kind: 'several_targets',
    key: `several:${r.rel_type}:${r.source_id}`,
    title: `${r.source_name} has ${r.targets.length} × ${r.rel_type.replaceAll('_', ' ')}`,
    detail: `${Math.round(r.single_share * 100)}% of ${r.sources} ${r.source_type} records have exactly one. Keep the right one, end the old ones.`,
    source: { id: r.source_id, name: r.source_name, type: r.source_type },
    links: r.targets.map((t) => ({ relationship_id: t.relationship_id, type: r.rel_type, target: { id: t.id, name: t.name, type: t.type }, origin: t.origin, valid_from: t.valid_from ? String(t.valid_from).slice(0, 10) : null })),
  }))
}

/**
 * Triangles A -r1-> B, A -r2-> C -r3-> B' (B and B' of one type) whose pattern usually
 * agrees (B = B' for ≥ `agree` of instances), and the instances where it doesn't.
 */
export async function triangles(sql: Sql, tenantId: string, agree = 0.8, limit = 300): Promise<RelIssue[]> {
  const rows = (
    await sql.query<{
      r1: string
      r2: string
      r3: string
      agree_share: number
      instances: number
      a_id: string
      a_name: string
      a_type: string
      b: { id: string; name: string; type: string; rid: string; origin: string | null }
      c: { id: string; name: string; type: string; rid: string; origin: string | null }
      b2: { id: string; name: string; type: string; rid: string; origin: string | null }
    }>(
      `with active as (
         select r.id, r.relationship_type_id t, r.source_entity_id s, r.target_entity_id o, r.metadata ->> 'origin' origin
         from public.relationships r join public.entities e on e.id = r.source_entity_id and e.status in ('candidate', 'active')
         join public.entity_types et on et.id = e.entity_type_id and (et.metadata ->> 'kind') is distinct from 'event'
         where r.tenant_id = $1 and ${ACTIVE}),
       typed as (select a.*, e.entity_type_id ot from active a join public.entities e on e.id = a.o and e.status in ('candidate', 'active')),
       tri as (
         select x.t r1, y.t r2, z.t r3, x.s a, x.o b, y.o c, z.o b2, x.id x_id, y.id y_id, z.id z_id, x.origin x_origin, y.origin y_origin, z.origin z_origin,
                exists (select 1 from public.relationships w where w.source_entity_id = x.s and w.relationship_type_id = x.t and w.target_entity_id = z.o and w.status not in ('rejected', 'superseded')) agrees
         from typed x join typed y on y.s = x.s and y.t <> x.t and y.o <> x.o
         join typed z on z.s = y.o and z.ot = x.ot and z.o <> y.s),
       pattern as (select r1, r2, r3, avg(agrees::int) agree_share, count(*) instances from tri group by 1, 2, 3 having count(*) >= 10 and avg(agrees::int) >= $2 and avg(agrees::int) < 1)
       select r1.name r1, r2.name r2, r3.name r3, p.agree_share::float, p.instances::int,
              a.id a_id, a.canonical_name a_name, at.name a_type,
              jsonb_build_object('id', b.id, 'name', b.canonical_name, 'type', bt.name, 'rid', tri.x_id, 'origin', tri.x_origin) b,
              jsonb_build_object('id', c.id, 'name', c.canonical_name, 'type', ct.name, 'rid', tri.y_id, 'origin', tri.y_origin) c,
              jsonb_build_object('id', b2.id, 'name', b2.canonical_name, 'type', b2t.name, 'rid', tri.z_id, 'origin', tri.z_origin) b2
       from tri join pattern p using (r1, r2, r3)
       join public.relationship_types r1 on r1.id = p.r1 join public.relationship_types r2 on r2.id = p.r2 join public.relationship_types r3 on r3.id = p.r3
       join public.entities a on a.id = tri.a join public.entity_types at on at.id = a.entity_type_id
       join public.entities b on b.id = tri.b join public.entity_types bt on bt.id = b.entity_type_id
       join public.entities c on c.id = tri.c join public.entity_types ct on ct.id = c.entity_type_id
       join public.entities b2 on b2.id = tri.b2 join public.entity_types b2t on b2t.id = b2.entity_type_id
       where not tri.agrees
       order by p.agree_share desc, a.canonical_name
       limit $3`,
      [tenantId, agree, limit],
    )
  ).rows
  const h = (s: string) => s.replaceAll('_', ' ')
  return rows.map((r) => ({
    kind: 'triangle',
    key: `tri:${r.a_id}:${r.b.rid}:${r.c.rid}:${r.b2.rid}`,
    title: `${r.a_name}: ${h(r.r1)} ${r.b.name}, but its ${r.c.type} ${r.c.name} ${h(r.r3)} ${r.b2.name}`,
    detail: `${Math.round(r.agree_share * 100)}% of ${r.instances} ${r.a_type} records agree here (${h(r.r1)} = ${h(r.r2)} → ${h(r.r3)}). One of these links is likely wrong or out of date.`,
    source: { id: r.a_id, name: r.a_name, type: r.a_type },
    links: [
      { relationship_id: r.b.rid, type: r.r1, target: r.b, origin: r.b.origin, valid_from: null },
      { relationship_id: r.c.rid, type: r.r2, target: r.c, origin: r.c.origin, valid_from: null },
      { relationship_id: r.b2.rid, type: `${r.c.name} → ${h(r.r3)}`, target: r.b2, origin: r.b2.origin, valid_from: null },
    ],
  }))
}

export interface ProseLink {
  relationship_id: string
  type: string
  status: string
  source: LinkRef
  target: LinkRef
  origin: string | null
  why: string | null
}

/** Links proposed from prose or by AI review (not system rows), awaiting or carrying a decision. */
export async function proseLinks(sql: Sql, tenantId: string): Promise<ProseLink[]> {
  return (
    await sql.query<ProseLink>(
      `select r.id relationship_id, rt.name type, r.status,
              jsonb_build_object('id', s.id, 'name', s.canonical_name, 'type', st.name) source,
              jsonb_build_object('id', t.id, 'name', t.canonical_name, 'type', tt.name) target,
              r.metadata ->> 'origin' origin, coalesce(r.metadata ->> 'why', s.description, r.metadata ->> 'retargeted') why
       from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id
       join public.entities s on s.id = r.source_entity_id join public.entity_types st on st.id = s.entity_type_id
       join public.entities t on t.id = r.target_entity_id join public.entity_types tt on tt.id = t.entity_type_id
       where r.tenant_id = $1 and coalesce(r.metadata ->> 'origin', '') not in ('structured', 'resolution') and r.status = 'candidate'
       order by st.name, s.canonical_name`,
      [tenantId],
    )
  ).rows
}

export async function relationshipReview(sql: Sql, tenantId: string) {
  // One after another: in parallel these scans slow each other down (~20 s vs ~28 s on 500k links).
  const summary = await relationshipSummary(sql, tenantId)
  const several = await severalTargets(sql, tenantId)
  const tri = await triangles(sql, tenantId)
  const prose = await proseLinks(sql, tenantId)
  return { summary, issues: [...several, ...tri], prose, checked_at: new Date().toISOString() }
}

/** Accept, reject, or end (valid_to) one link. Recorded on the row, never deleted. */
export async function decideRelationship(sql: Sql, tenantId: string, id: string, d: { action: 'accept' | 'reject' | 'end'; valid_to?: string; note?: string; reviewer?: string }) {
  const review = JSON.stringify({ review: { action: d.action, note: d.note ?? null, reviewer: d.reviewer ?? 'fde', at: new Date().toISOString() } })
  const r =
    d.action === 'end'
      ? await sql.query(`update public.relationships set valid_to = coalesce($3::date, current_date - 1), metadata = metadata || $4::jsonb, updated_at = now() where tenant_id = $1 and id = $2 returning id, status, valid_to::text`, [
          tenantId,
          id,
          d.valid_to ?? null,
          review,
        ])
      : await sql.query(`update public.relationships set status = $3, metadata = metadata || $4::jsonb, updated_at = now() where tenant_id = $1 and id = $2 returning id, status, valid_to::text`, [
          tenantId,
          id,
          d.action === 'accept' ? 'accepted' : 'rejected',
          review,
        ])
  if (!r.rows.length) throw new Error('relationship not found')
  return r.rows[0]
}
