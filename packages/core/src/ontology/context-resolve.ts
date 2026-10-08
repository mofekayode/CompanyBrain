// Resolution by context: names that share no spelling but share activity.
// Legacy systems abbreviate ("K-Plate", "QCPP", "BRM"): spelling similarity can't
// connect them, but their work happens at the same sites as the official
// customer. Pairs whose events point at a place owned by another entity of the
// same type are candidates; the AI confirms each with names, systems, counts and
// shared places; confirmed pairs are merged (aliases kept), the rest left alone.

import { structured } from '../claude'
import type { Sql } from '../storage/raw'
import { mergeInto } from './resolve'

interface Candidate {
  a_id: string
  a_name: string
  a_system: string | null
  a_ids: string[]
  b_id: string
  b_name: string
  b_system: string | null
  b_ids: string[]
  shared: number
  places: string[]
  a_own_places: number
}

/**
 * Pairs of entities of one type (e.g. Customer) where events linked to A (via `eventRel`)
 * happen at places (via `placeRel`) that belong to B (via `ownerRel`).
 */
async function candidates(sql: Sql, tenantId: string, rels: { eventRel: string; placeRel: string; ownerRel: string }, minShared: number): Promise<Candidate[]> {
  const { rows } = await sql.query<Candidate>(
    `with rt as (select id, name from public.relationship_types where tenant_id = $1),
     ev_a as (select r.source_entity_id ev, r.target_entity_id a from public.relationships r join rt on rt.id = r.relationship_type_id and rt.name = $2 where r.tenant_id = $1),
     ev_p as (select r.source_entity_id ev, r.target_entity_id p from public.relationships r join rt on rt.id = r.relationship_type_id and rt.name = $3 where r.tenant_id = $1),
     p_b as (select r.source_entity_id p, r.target_entity_id b from public.relationships r join rt on rt.id = r.relationship_type_id and rt.name = $4 where r.tenant_id = $1),
     pairs as (
       select ev_a.a, p_b.b, count(*)::int shared, array_agg(distinct pe.canonical_name) places
       from ev_a join ev_p on ev_p.ev = ev_a.ev join p_b on p_b.p = ev_p.p join public.entities pe on pe.id = ev_p.p
       where ev_a.a <> p_b.b group by 1, 2 having count(*) >= $5)
     select pairs.a a_id, a.canonical_name a_name, a.properties ->> 'source_system' a_system,
            array(select i.system || ':' || i.value from public.entity_identifiers i where i.entity_id = a.id limit 4) a_ids,
            pairs.b b_id, b.canonical_name b_name, b.properties ->> 'source_system' b_system,
            array(select i.system || ':' || i.value from public.entity_identifiers i where i.entity_id = b.id limit 4) b_ids,
            pairs.shared, pairs.places[1:4] places,
            (select count(*)::int from p_b where p_b.b = pairs.a) a_own_places
     from pairs join public.entities a on a.id = pairs.a and a.status in ('candidate', 'active')
     join public.entities b on b.id = pairs.b and b.status in ('candidate', 'active')
     order by pairs.shared desc`,
    [tenantId, rels.eventRel, rels.placeRel, rels.ownerRel, minShared],
  )
  return rows
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pair', 'same', 'why'],
        properties: { pair: { type: 'integer' }, same: { type: 'boolean' }, why: { type: 'string' } },
      },
    },
  },
}

export async function resolveByContext(
  sql: Sql,
  tenantId: string,
  opts: { type?: string; eventRel?: string; placeRel?: string; ownerRel?: string; minShared?: number } = {},
): Promise<{ candidates: number; merged: number; kept: number }> {
  const rels = { eventRel: opts.eventRel ?? 'for_customer', placeRel: opts.placeRel ?? 'at_site', ownerRel: opts.ownerRel ?? 'belongs_to' }
  const type = opts.type ?? 'Customer'
  const all = await candidates(sql, tenantId, rels, opts.minShared ?? 3)
  // One decision per unordered pair; skip pairs already decided "different" by an FDE.
  const seen = new Set<string>()
  const pairs = all.filter((c) => {
    const k = [c.a_id, c.b_id].sort().join('|')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  let merged = 0
  let kept = 0
  const mergedIds = new Set<string>()
  for (let i = 0; i < pairs.length; i += 40) {
    const chunk = pairs.slice(i, i + 40)
    const out = await structured<{ decisions: { pair: number; same: boolean; why: string }[] }>({
      system: `You decide whether two ${type} records are the same real-world ${type}. Legacy systems often abbreviate names ("K-Plate" for "Kentucky Plating Works", "ACPP" for "Acme City Paper & Packaging"). Work recorded for one at a site owned by the other is strong evidence they are the same, unless the names clearly denote different organisations (e.g. a contractor working at a customer's plant, or a parent and an unrelated company).`,
      prompt: `Pairs (A | B | how many of A's events happened at B's places | which places | whether A owns places of its own):
${chunk
  .map(
    (c, k) =>
      `${k}. A="${c.a_name}" (${c.a_system ?? 'link'}; ${c.a_ids.join(', ')}) | B="${c.b_name}" (${c.b_system ?? 'link'}; ${c.b_ids.join(', ')}) | ${c.shared} events at ${c.places.join(', ')} | A owns ${c.a_own_places} places`,
  )
  .join('\n')}

For each pair return same = true only if A and B are the same ${type}.`,
      schema: SCHEMA,
      effort: 'medium',
    })
    for (const d of out.decisions) {
      const c = chunk[d.pair]
      if (!c) continue
      if (!d.same || mergedIds.has(c.a_id) || mergedIds.has(c.b_id)) {
        kept++
        continue
      }
      // The entity that owns places (the official record) survives.
      const [survivor, other] = c.a_own_places > 0 ? [c.a_id, c.b_id] : [c.b_id, c.a_id]
      const live = (await sql.query<{ n: number }>(`select count(*)::int n from public.entities where id = any($1::uuid[]) and status in ('candidate', 'active')`, [[survivor, other]])).rows[0].n
      if (live < 2) continue
      await mergeInto(sql, tenantId, survivor, [other], `AI (context): ${d.why}`)
      mergedIds.add(other)
      merged++
    }
  }
  return { candidates: pairs.length, merged, kept }
}
