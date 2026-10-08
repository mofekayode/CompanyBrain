// Evidence-derived evaluation set: what we believe is true about the client,
// written down as checks and questions so the company model, search and the
// agent can be measured. For a real client the client confirms it; for Riverton
// it is later scored against the hidden ground truth.
//
// The AI proposes TYPED assertions (never SQL); code turns them into SQL.

import { structured } from '../claude'
import type { Sql } from '../storage/raw'

export type Assertion =
  | { type: 'alias_resolves'; entity_type: string; alias: string; entity: string }
  | { type: 'entity_count'; entity_type: string; min: number; max: number }
  | { type: 'fact_value'; subject: string; predicate_hint: string; value_hint: string; as_of: string | null }
  | { type: 'relation_exists'; source: string; relationship: string; target: string }
  | { type: 'person_access'; person: string; path_hint: string; can_open: boolean }

const q = (s: string) => `'${s.replace(/'/g, "''")}'`

/** SQL returning one row {passed, detail} for an assertion (tenant id as $1). */
export function assertionSql(a: Assertion): string {
  const live = `e.status in ('candidate', 'active')`
  switch (a.type) {
    case 'alias_resolves':
      return `with hits as (
        select distinct e.id, e.canonical_name from public.entities e join public.entity_types t on t.id = e.entity_type_id and lower(t.name) = lower(${q(a.entity_type)})
        where e.tenant_id = $1 and ${live} and (lower(e.canonical_name) = lower(${q(a.alias)})
          or exists (select 1 from public.entity_aliases x where x.entity_id = e.id and x.status <> 'rejected' and x.normalized_alias = lower(btrim(${q(a.alias)})))))
      select count(*) = 1 and bool_and(lower(canonical_name) = lower(${q(a.entity)})) passed,
             coalesce(string_agg(canonical_name, ' | '), 'no entity') detail from hits`
    case 'entity_count':
      return `select count(*) between ${Number(a.min)} and ${Number(a.max)} passed, count(*)::text || ' entities' detail
      from public.entities e join public.entity_types t on t.id = e.entity_type_id and lower(t.name) = lower(${q(a.entity_type)})
      where e.tenant_id = $1 and ${live}`
    case 'fact_value':
      return `with s as (select e.id from public.entities e where e.tenant_id = $1 and ${live} and (lower(e.canonical_name) = lower(${q(a.subject)})
          or exists (select 1 from public.entity_aliases x where x.entity_id = e.id and x.status <> 'rejected' and x.normalized_alias = lower(btrim(${q(a.subject)}))))),
      f as (select f.predicate, f.value #>> '{}' v, f.valid_from, f.valid_to from public.facts f join s on s.id = f.subject_entity_id
        where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status in ('accepted', 'superseded')
          and (f.predicate ilike '%' || ${q(a.predicate_hint)} || '%' or f.metadata ->> 'summary' ilike '%' || ${q(a.predicate_hint)} || '%')
          ${a.as_of ? `and (f.valid_from is null or f.valid_from <= ${q(a.as_of)}::date) and (f.valid_to is null or f.valid_to > ${q(a.as_of)}::date)` : `and f.status = 'accepted'`})
      select coalesce(bool_or(v ilike '%' || ${q(a.value_hint)} || '%'), false) passed, coalesce(string_agg(predicate || ' = ' || v, ' | '), 'no matching fact') detail from f`
    case 'relation_exists':
      return `select count(*) > 0 passed, count(*)::text || ' links' detail
      from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id and lower(rt.name) = lower(${q(a.relationship)})
      join public.entities s on s.id = r.source_entity_id join public.entities o on o.id = r.target_entity_id
      where r.tenant_id = $1 and r.status <> 'rejected'
        and (lower(s.canonical_name) = lower(${q(a.source)}) or exists (select 1 from public.entity_aliases x where x.entity_id = s.id and x.status <> 'rejected' and x.normalized_alias = lower(btrim(${q(a.source)}))))
        and (lower(o.canonical_name) = lower(${q(a.target)}) or exists (select 1 from public.entity_aliases x where x.entity_id = o.id and x.status <> 'rejected' and x.normalized_alias = lower(btrim(${q(a.target)}))))`
    case 'person_access':
      // Evaluated in run.ts as the person (RLS); this SQL only locates the file.
      return `select count(*) > 0 passed, string_agg(original_path, ' | ') detail from public.source_objects where tenant_id = $1 and original_path ilike '%' || ${q(a.path_hint)} || '%'`
  }
}

interface GeneratedItem {
  kind: 'data_check' | 'question'
  category: string
  question: string
  expected_answer: string
  difficulty: 'easy' | 'medium' | 'hard'
  assertion: Assertion | null
  key_points: string[]
  evidence: number[] // indexes into the evidence pack
  persona: string | null
  as_of: string | null
}

const ASSERTION = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'entity_type', 'alias', 'entity', 'min', 'max', 'subject', 'predicate_hint', 'value_hint', 'as_of', 'source', 'relationship', 'target', 'person', 'path_hint', 'can_open'],
      properties: {
        type: { type: 'string', enum: ['alias_resolves', 'entity_count', 'fact_value', 'relation_exists', 'person_access'] },
        entity_type: { type: ['string', 'null'] },
        alias: { type: ['string', 'null'] },
        entity: { type: ['string', 'null'] },
        min: { type: ['integer', 'null'] },
        max: { type: ['integer', 'null'] },
        subject: { type: ['string', 'null'] },
        predicate_hint: { type: ['string', 'null'] },
        value_hint: { type: ['string', 'null'] },
        as_of: { type: ['string', 'null'] },
        source: { type: ['string', 'null'] },
        relationship: { type: ['string', 'null'] },
        target: { type: ['string', 'null'] },
        person: { type: ['string', 'null'] },
        path_hint: { type: ['string', 'null'] },
        can_open: { type: ['boolean', 'null'] },
      },
    },
  ],
}
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'category', 'question', 'expected_answer', 'difficulty', 'assertion', 'key_points', 'evidence', 'persona', 'as_of'],
        properties: {
          kind: { type: 'string', enum: ['data_check', 'question'] },
          category: { type: 'string', enum: ['lookup', 'alias', 'temporal', 'permission', 'multimodal', 'multi_hop', 'aggregation', 'exception', 'unanswerable', 'resolution', 'key_person'] },
          question: { type: 'string' },
          expected_answer: { type: 'string' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
          assertion: ASSERTION,
          key_points: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'integer' } },
          persona: { type: ['string', 'null'] },
          as_of: { type: ['string', 'null'] },
        },
      },
    },
  },
}

/** Builds the evidence pack the generator writes from: only things the model holds with sources. */
async function evidencePack(sql: Sql, tenantId: string) {
  const facts = (
    await sql.query(
      `select f.id, s.canonical_name subject, t.name type, f.predicate, f.value #>> '{}' value, f.valid_from::text, f.valid_to::text, f.status, f.metadata ->> 'kind' kind,
              f.metadata ->> 'summary' summary,
              (select jsonb_agg(jsonb_build_object('evidence_id', l.evidence_id, 'quote', left(l.quote, 200), 'file_id', so.id, 'path', so.original_path, 'kind', e.kind, 'start_ms', e.start_ms, 'page', e.page_number))
               from public.fact_claims fc join public.evidence_links l on l.fact_id = fc.claim_id join public.evidence e on e.id = l.evidence_id
               join public.document_versions dv on dv.id = e.document_version_id join public.source_objects so on so.id = dv.source_object_id
               where fc.canonical_id = f.id and fc.stance = 'supports') sources
       from public.facts f join public.entities s on s.id = f.subject_entity_id join public.entity_types t on t.id = s.entity_type_id
       where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status in ('accepted', 'superseded')
       order by f.confidence desc nulls last limit 220`,
      [tenantId],
    )
  ).rows
  const visual = (
    await sql.query(
      `select e.id evidence_id, so.id file_id, so.original_path path, e.kind, e.start_ms, left(e.content, 500) content
       from public.evidence e join public.document_versions dv on dv.id = e.document_version_id join public.documents d on d.current_version_id = dv.id
       join public.source_objects so on so.id = dv.source_object_id
       where e.tenant_id = $1 and e.kind in ('video_segment', 'image') and length(e.content) > 300 order by md5(e.id::text) limit 30`,
      [tenantId],
    )
  ).rows
  const aliases = (
    await sql.query(
      `select t.name type, e.canonical_name entity, string_agg(distinct a.alias, ' | ') aliases
       from public.entity_aliases a join public.entities e on e.id = a.entity_id and a.status <> 'rejected' and e.status in ('candidate', 'active') join public.entity_types t on t.id = e.entity_type_id
       where a.tenant_id = $1 and t.name in ('Customer', 'Branch', 'Person', 'Vendor') and lower(a.alias) <> lower(e.canonical_name)
       group by 1, 2 order by count(*) desc limit 40`,
      [tenantId],
    )
  ).rows
  const counts = (
    await sql.query(
      `select t.name type, count(*)::int n from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and e.status in ('candidate', 'active') group by 1 order by 2 desc`,
      [tenantId],
    )
  ).rows
  const workByCustomer = (
    await sql.query(
      `select c.canonical_name customer, count(*)::int work_orders,
              count(*) filter (where w.properties ->> 'date' >= '2025')::int since_2025
       from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id and rt.name = 'for_customer'
       join public.entities c on c.id = r.target_entity_id join public.entities w on w.id = r.source_entity_id
       where r.tenant_id = $1 group by 1 order by 2 desc limit 12`,
      [tenantId],
    )
  ).rows
  const scopes = (
    await sql.query(
      `select sc.name, sc.status, sc.hidden, sc.sensitivity,
              (select string_agg(p.display_name, ', ') from public.access_scope_audience a join public.principals p on p.id = a.principal_id where a.scope_id = sc.id) audience,
              (select string_agg(so.original_path, ' | ') from (select so.original_path from public.file_access fa join public.source_objects so on so.id = fa.source_object_id where fa.scope_id = sc.id and so.parent_id is null limit 3) so) sample_files
       from public.access_scopes sc where sc.tenant_id = $1 and sc.name not like 'Mailbox:%' order by sc.name`,
      [tenantId],
    )
  ).rows
  return { facts, visual, aliases, counts, workByCustomer, scopes }
}

export async function generateEvalSet(sql: Sql, tenantId: string, name = 'Evidence-derived v1'): Promise<{ set_id: string; items: number; by_category: Record<string, number> }> {
  const pack = await evidencePack(sql, tenantId)
  // Every source passage gets an index the generator can cite.
  const sources: { evidence_id: string; file_id: string; label: string }[] = []
  const cite = (s: { evidence_id: string; file_id: string; path: string; start_ms?: number | null; page?: number | null }) => {
    sources.push({ evidence_id: s.evidence_id, file_id: s.file_id, label: s.path })
    return `#${sources.length - 1} ${s.path}${s.page ? ` p.${s.page}` : ''}${s.start_ms != null ? ` @${Math.floor(s.start_ms / 1000)}s` : ''}`
  }
  const factText = pack.facts
    .map((f: any) => {
      const src = (f.sources ?? []).slice(0, 3).map((s: any) => `${cite(s)} "${s.quote ?? ''}"`).join('; ')
      return `- [${f.kind}${f.status === 'superseded' ? ', EARLIER PERIOD' : ''}] ${f.subject} (${f.type}) · ${f.predicate} = ${f.value}${f.valid_from ? ` from ${f.valid_from}` : ''}${f.valid_to ? ` to ${f.valid_to}` : ''}: ${f.summary ?? ''} | sources: ${src}`
    })
    .join('\n')
  const visualText = pack.visual.map((v: any) => `- ${cite(v)} [${v.kind}] ${String(v.content).replace(/\s+/g, ' ')}`).join('\n')
  const prompt = `Write an evaluation set for a company knowledge system, from what is known below (all of it is backed by sources).

## Facts (accepted; "EARLIER PERIOD" = no longer current)
${factText}

## Video and photo readings
${visualText}

## Names and their aliases (abbreviations, jargon, old names)
${pack.aliases.map((a: any) => `- ${a.type}: ${a.entity} ⟵ ${a.aliases}`).join('\n')}

## Counts in the model
${pack.counts.map((c: any) => `- ${c.type}: ${c.n}`).join('\n')}
Work orders by customer (top): ${pack.workByCustomer.map((w: any) => `${w.customer} ${w.work_orders} (${w.since_2025} since 2025)`).join('; ')}

## Access scopes (who may see what; held = admins only; hidden = not even listed)
${pack.scopes.map((s: any) => `- ${s.name} [${s.status}${s.hidden ? ', hidden' : ''}, ${s.sensitivity}] audience: ${s.audience ?? '-'} | e.g. ${s.sample_files ?? ''}`).join('\n')}

## What to write (about 70 items)
- ~25 data_check items with a typed assertion:
  - alias_resolves: an alias/jargon/abbreviation must resolve to exactly one entity (e.g. "Big Blue" → its customer).
  - entity_count: plausible ranges (e.g. branches 3–3).
  - fact_value: a subject's fact matches a value (predicate_hint/value_hint are short substrings), with as_of for time-dependent facts (both a current and an earlier period).
  - relation_exists: e.g. a site belongs_to its customer.
  - person_access: a named person can or cannot open a file (path_hint = distinctive part of a file path), from the scopes (released + audience = can; held, hidden or not in audience = cannot).
  For data checks, set unused assertion fields to null.
- ~45 question items (assertion null) across categories: lookup, alias (asked with jargon), temporal (as_of set; "what was true in 2024"), permission (persona = person name; expected answer reflects what THEY may see), multimodal (answer lives in a video/photo), multi_hop (customer → site → asset/technician), aggregation (use the counts given), exception (customer-specific deals), key_person, unanswerable (something the sources don't say: expected answer says it is unknown).
- Each question: a natural question as an employee or FDE would ask it; expected_answer (short, specific); key_points (2-4 facts a correct answer must contain); evidence = the #indexes of the sources that answer it (empty for unanswerable/aggregation).
- Only use what is stated above. Prefer high-value business questions (pricing, exceptions, safety, who does what, systems, history).`
  const out = await structured<{ items: GeneratedItem[] }>({
    system: 'You are building a rigorous evaluation set for an enterprise knowledge system. Questions must be answerable from the given sources (except unanswerable ones), unambiguous, and checkable.',
    prompt,
    schema: SCHEMA,
    effort: 'high',
    maxTokens: 64000,
  })

  const set = (
    await sql.query<{ id: string }>(
      `insert into public.eval_sets (tenant_id, name, description, origin) values ($1, $2, $3, 'ai')
       on conflict (tenant_id, name) do update set description = excluded.description returning id`,
      [tenantId, name, 'Generated from accepted facts, timelines, video/photo readings, aliases, counts and access scopes; every question cites its sources.'],
    )
  ).rows[0].id
  await sql.query(`delete from public.eval_items where set_id = $1 and origin = 'ai'`, [set])
  const people = new Map(
    (await sql.query<{ id: string; name: string }>(`select id, display_name name from public.principals where tenant_id = $1 and kind = 'user'`, [tenantId])).rows.map((p) => [p.name.toLowerCase(), p.id]),
  )
  const byCategory: Record<string, number> = {}
  for (const it of out.items) {
    const evidence = it.evidence.map((i) => sources[i]).filter(Boolean)
    const assertion = it.kind === 'data_check' && it.assertion ? (Object.fromEntries(Object.entries(it.assertion).filter(([, v]) => v !== null)) as Assertion) : null
    if (it.kind === 'data_check' && !assertion) continue
    await sql.query(
      `insert into public.eval_items (tenant_id, set_id, kind, category, question, expected_answer, expected, check_sql, persona_id, as_of, difficulty, origin)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ai')`,
      [
        tenantId,
        set,
        it.kind,
        it.category,
        it.question,
        it.expected_answer,
        JSON.stringify({ key_points: it.key_points, evidence_ids: evidence.map((e) => e.evidence_id), file_ids: [...new Set(evidence.map((e) => e.file_id))], files: [...new Set(evidence.map((e) => e.label))], assertion }),
        assertion ? assertionSql(assertion) : null,
        it.persona ? (people.get(it.persona.toLowerCase()) ?? null) : null,
        it.as_of && /^\d{4}-\d{2}-\d{2}$/.test(it.as_of) ? it.as_of : null,
        it.difficulty,
      ],
    )
    byCategory[`${it.kind}:${it.category}`] = (byCategory[`${it.kind}:${it.category}`] ?? 0) + 1
  }
  return { set_id: set, items: Object.values(byCategory).reduce((a, b) => a + b, 0), by_category: byCategory }
}
