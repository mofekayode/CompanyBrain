// Knowledge review (FDE): the queue of what needs a human decision, and the
// decisions themselves. Facts: conflicts first, then unreviewed facts.
// Merges: pairs resolution could not decide.

import { citation } from '../workbench/evidence-search'
import type { Sql } from '../storage/raw'
import { mergeInto } from './resolve'

export async function reviewSummary(sql: Sql, tenantId: string) {
  const r = (
    await sql.query<Record<string, number>>(
      `select count(*) filter (where status = 'disputed')::int conflicts,
              count(*) filter (where status in ('candidate', 'unknown') and reviewed_at is null)::int to_review,
              count(*) filter (where status = 'accepted')::int accepted,
              count(*) filter (where status = 'superseded')::int history,
              count(*) filter (where status = 'rejected')::int rejected,
              count(*)::int total
       from public.facts where tenant_id = $1 and metadata ->> 'layer' = 'canonical'`,
      [tenantId],
    )
  ).rows[0]
  const byKind = (
    await sql.query(
      `select metadata ->> 'kind' kind, count(*)::int n, count(*) filter (where reviewed_at is null and status in ('candidate', 'unknown'))::int open
       from public.facts where tenant_id = $1 and metadata ->> 'layer' = 'canonical' group by 1 order by 2 desc`,
      [tenantId],
    )
  ).rows
  const merges = (
    await sql.query<{ n: number }>(
      `select count(*)::int n from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id
       join public.entities a on a.id = r.source_entity_id and a.status in ('candidate', 'active') join public.entities b on b.id = r.target_entity_id and b.status in ('candidate', 'active') and b.id <> a.id
       where r.tenant_id = $1 and rt.name = 'possibly_same_as' and r.status = 'candidate'`,
      [tenantId],
    )
  ).rows[0].n
  const claims = (await sql.query<{ n: number }>(`select count(*)::int n from public.facts where tenant_id = $1 and metadata ->> 'layer' = 'claim' and metadata ->> 'origin' = 'prose'`, [tenantId])).rows[0].n
  return { ...r, by_kind: byKind, merges, claims }
}

export type FactFilter = 'conflicts' | 'to_review' | 'accepted' | 'history' | 'all'

export async function canonicalFacts(sql: Sql, tenantId: string, opts: { filter?: FactFilter; kind?: string; q?: string; limit?: number } = {}) {
  const where = {
    conflicts: `f.status = 'disputed'`, // disputed = sources (or reviewers) disagree; open until someone decides
    to_review: `f.status in ('candidate', 'unknown') and f.reviewed_at is null`,
    accepted: `f.status = 'accepted'`,
    history: `f.status = 'superseded'`,
    all: `true`,
  }[opts.filter ?? 'to_review']
  const facts = (
    await sql.query(
      `select f.id, f.predicate, f.value #>> '{}' value, f.valid_from, f.valid_to, f.status, f.authority, f.confidence, f.note, f.reviewed_at,
              f.metadata ->> 'kind' kind, f.metadata ->> 'agreement' agreement, f.metadata ->> 'summary' summary, f.metadata ->> 'conflict_note' conflict_note,
              s.id subject_id, s.canonical_name subject, st.name subject_type,
              p.id previous_id, p.value #>> '{}' previous_value, p.valid_from previous_from,
              (select n.id from public.facts n where n.supersedes_fact_id = f.id limit 1) next_id
       from public.facts f join public.entities s on s.id = f.subject_entity_id join public.entity_types st on st.id = s.entity_type_id
       left join public.facts p on p.id = f.supersedes_fact_id
       where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and ${where}
         and ($2::text is null or f.metadata ->> 'kind' = $2)
         and ($3::text is null or s.canonical_name ilike '%' || $3 || '%' or f.metadata ->> 'summary' ilike '%' || $3 || '%' or f.predicate ilike '%' || $3 || '%')
       order by (f.status = 'disputed') desc, f.confidence desc nulls last, s.canonical_name
       limit $4`,
      [tenantId, opts.kind ?? null, opts.q?.trim() || null, opts.limit ?? 200],
    )
  ).rows
  if (!facts.length) return []
  const claims = (
    await sql.query(
      `select fc.canonical_id, fc.stance, c.id, c.predicate, c.value #>> '{}' value, c.authority, c.metadata ->> 'certainty' certainty,
              c.metadata ->> 'source_system' source_system, c.observed_at,
              l.quote, e.id evidence_id, e.kind, e.page_number, e.section_path, e.start_ms, e.end_ms, e.speaker, e.observed_at e_observed_at, e.locator,
              so.id file_id, so.original_path file_path
       from public.fact_claims fc join public.facts c on c.id = fc.claim_id
       left join lateral (select * from public.evidence_links l where l.fact_id = c.id limit 1) l on true
       left join public.evidence e on e.id = l.evidence_id
       left join public.document_versions dv on dv.id = e.document_version_id
       left join public.source_objects so on so.id = dv.source_object_id
       where fc.canonical_id = any($1::uuid[])
       order by fc.stance, c.authority`,
      [facts.map((f: any) => f.id)],
    )
  ).rows
  return facts.map((f: any) => ({
    ...f,
    claims: claims
      .filter((c: any) => c.canonical_id === f.id)
      .map((c: any) => ({ ...c, citation: c.file_path ? citation({ ...c, observed_at: c.e_observed_at }) : c.source_system ? `${c.source_system} (system field)` : null })),
  }))
}

export async function mergeQueue(sql: Sql, tenantId: string) {
  const pairs = (
    await sql.query(
      `select r.id, r.metadata ->> 'why' why, t.name type,
              a.id a_id, a.canonical_name a_name, a.properties a_props, b.id b_id, b.canonical_name b_name, b.properties b_props,
              (select coalesce(jsonb_agg(i.system || ': ' || i.value), '[]') from public.entity_identifiers i where i.entity_id = a.id) a_ids,
              (select coalesce(jsonb_agg(i.system || ': ' || i.value), '[]') from public.entity_identifiers i where i.entity_id = b.id) b_ids,
              (select count(*)::int from public.relationships x where x.tenant_id = r.tenant_id and (x.source_entity_id = a.id or x.target_entity_id = a.id)) a_links,
              (select count(*)::int from public.relationships x where x.tenant_id = r.tenant_id and (x.source_entity_id = b.id or x.target_entity_id = b.id)) b_links
       from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id and rt.name = 'possibly_same_as'
       join public.entities a on a.id = r.source_entity_id join public.entities b on b.id = r.target_entity_id
       join public.entity_types t on t.id = a.entity_type_id
       where r.tenant_id = $1 and r.status = 'candidate' and a.status in ('candidate', 'active') and b.status in ('candidate', 'active') and a.id <> b.id
       order by t.name, a.canonical_name`,
      [tenantId],
    )
  ).rows
  return pairs
}

/** Merge the pair (the more connected one survives) or keep them separate. */
export async function decideMerge(sql: Sql, tenantId: string, relationshipId: string, decision: 'merge' | 'separate') {
  const r = (
    await sql.query<{ a: string; b: string; a_links: number; b_links: number }>(
      `select r.source_entity_id a, r.target_entity_id b,
              (select count(*)::int from public.relationships x where x.source_entity_id = r.source_entity_id or x.target_entity_id = r.source_entity_id) a_links,
              (select count(*)::int from public.relationships x where x.source_entity_id = r.target_entity_id or x.target_entity_id = r.target_entity_id) b_links
       from public.relationships r where r.tenant_id = $1 and r.id = $2`,
      [tenantId, relationshipId],
    )
  ).rows[0]
  if (!r) throw new Error('unknown pair')
  if (decision === 'separate') {
    await sql.query(`update public.relationships set status = 'rejected', metadata = metadata || '{"decided_by":"fde"}' where id = $1`, [relationshipId])
    return { kept_separate: true }
  }
  const [survivor, other] = r.a_links >= r.b_links ? [r.a, r.b] : [r.b, r.a]
  await mergeInto(sql, tenantId, survivor, [other], 'FDE confirmed: same thing')
  await sql.query(`update public.entities set status = 'active' where id = $1 and status = 'candidate'`, [survivor])
  return { merged_into: survivor }
}
