// Knowledge from prose (interviews, emails, documents): company vocabulary,
// customer-specific exceptions, dated facts and who knows what, each tied to the
// entities already in the model and to the exact quote it came from.
//
// Statements are evidence, not truth: facts are stored as candidates with their
// authority (interview, email, official document) and confidence; an FDE (or the
// canonical layer later) accepts, disputes or supersedes them.

import { structured } from '../claude'
import { rulesFor, withContext } from '../config/tenant-config'
import type { Sql } from '../storage/raw'
import { normalizeName } from './load'

const BATCH_CHARS = 14000

export interface ProseFinding {
  vocabulary: { term: string; meaning: string; refers_to: { type: string; name: string } | null; passage: number; quote: string }[]
  facts: {
    subject: { type: string; name: string }
    predicate: string
    value: string | null
    object: { type: string; name: string } | null
    valid_from: string | null
    valid_to: string | null
    kind: 'exception' | 'policy' | 'practice' | 'history' | 'key_person' | 'risk' | 'other'
    certainty: 'stated' | 'estimate' | 'uncertain'
    passage: number
    quote: string
  }[]
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vocabulary', 'facts'],
  properties: {
    vocabulary: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'meaning', 'refers_to', 'passage', 'quote'],
        properties: {
          term: { type: 'string' },
          meaning: { type: 'string' },
          refers_to: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['type', 'name'], properties: { type: { type: 'string' }, name: { type: 'string' } } }] },
          passage: { type: 'integer' },
          quote: { type: 'string' },
        },
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'predicate', 'value', 'object', 'valid_from', 'valid_to', 'kind', 'certainty', 'passage', 'quote'],
        properties: {
          subject: { type: 'object', additionalProperties: false, required: ['type', 'name'], properties: { type: { type: 'string' }, name: { type: 'string' } } },
          predicate: { type: 'string' },
          value: { type: ['string', 'null'] },
          object: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['type', 'name'], properties: { type: { type: 'string' }, name: { type: 'string' } } }] },
          valid_from: { type: ['string', 'null'] },
          valid_to: { type: ['string', 'null'] },
          kind: { type: 'string', enum: ['exception', 'policy', 'practice', 'history', 'key_person', 'risk', 'other'] },
          certainty: { type: 'string', enum: ['stated', 'estimate', 'uncertain'] },
          passage: { type: 'integer' },
          quote: { type: 'string' },
        },
      },
    },
  },
}

// Evidence kind → authority label comes from the tenant's authority rules (rules.authority.evidence_kind).

/** Finds an entity of a type by name or alias; creates a candidate when the prose names something new. */
async function entityFor(sql: Sql, tenantId: string, ref: { type: string; name: string }, types: Map<string, string>, cache: Map<string, string>): Promise<string | null> {
  const typeId = types.get(ref.type.toLowerCase())
  if (!typeId || !ref.name.trim()) return null
  const key = `${typeId}|${normalizeName(ref.name)}`
  if (cache.has(key)) return cache.get(key)!
  // Indexed lookups only (exact name, exact alias, trigram index): types can hold 50k+ entities.
  const found = (
    await sql.query<{ id: string }>(
      `select id from (
         select e.id, 1.0 s from public.entities e
         where e.tenant_id = $1 and e.entity_type_id = $2 and e.status in ('candidate', 'active') and lower(e.canonical_name) = lower($3)
         union all
         select a.entity_id, 0.95 from public.entity_aliases a join public.entities e on e.id = a.entity_id
         where a.tenant_id = $1 and a.status <> 'rejected' and a.normalized_alias = lower(btrim($3)) and e.entity_type_id = $2 and e.status in ('candidate', 'active')
         union all
         select e.id, similarity(lower(e.canonical_name), lower($3)) from public.entities e
         where e.tenant_id = $1 and e.entity_type_id = $2 and e.status in ('candidate', 'active')
           and lower(e.canonical_name) % lower($3) and similarity(lower(e.canonical_name), lower($3)) > 0.6) x
       order by s desc limit 1`,
      [tenantId, typeId, ref.name.trim()],
    )
  ).rows[0]
  // A single name ("Linda") matches the one entity of that type whose name starts with it, if exactly one does.
  // Only for small types (people, branches…), not 50k work orders.
  const small = (await sql.query<{ n: number }>(`select count(*)::int n from public.entities where tenant_id = $1 and entity_type_id = $2 and status in ('candidate', 'active')`, [tenantId, typeId])).rows[0].n < 3000
  const byFirst =
    !found && small && !/\s/.test(ref.name.trim())
      ? (
          await sql.query<{ id: string }>(
            `select e.id from public.entities e where e.tenant_id = $1 and e.entity_type_id = $2 and e.status in ('candidate', 'active')
               and (lower(e.canonical_name) like lower($3) || ' %' or exists (select 1 from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected' and a.normalized_alias like lower($3) || ' %'))
             group by e.id limit 2`,
            [tenantId, typeId, ref.name.trim()],
          )
        ).rows
      : []
  const id =
    found?.id ??
    (byFirst.length === 1 ? byFirst[0].id : undefined) ??
    (
      await sql.query<{ id: string }>(
        `insert into public.entities (tenant_id, entity_type_id, canonical_name, status, metadata) values ($1, $2, $3, 'candidate', '{"origin":"prose"}') returning id`,
        [tenantId, typeId, ref.name.trim().slice(0, 300)],
      )
    ).rows[0].id
  cache.set(key, id)
  return id
}

/** The vocabulary entity for a term (one per normalized term). */
async function termEntity(sql: Sql, tenantId: string, term: string, meaning: string): Promise<string> {
  const typeId = (
    await sql.query<{ id: string }>(
      `insert into public.entity_types (tenant_id, name, description, status, origin, metadata)
       values ($1, 'Term', 'Company vocabulary: jargon, nicknames and internal terms, with what they mean', 'proposed', 'ai', '{"kind":"term"}')
       on conflict (tenant_id, lower(name)) do update set name = entity_types.name returning id`,
      [tenantId],
    )
  ).rows[0].id
  const existing = (
    await sql.query<{ id: string }>(`select id from public.entities where tenant_id = $1 and entity_type_id = $2 and lower(canonical_name) = lower($3) and status <> 'merged' limit 1`, [tenantId, typeId, term])
  ).rows[0]
  if (existing) return existing.id
  return (
    await sql.query<{ id: string }>(
      `insert into public.entities (tenant_id, entity_type_id, canonical_name, description, status, metadata) values ($1, $2, $3, $4, 'candidate', '{"origin":"prose"}') returning id`,
      [tenantId, typeId, term.slice(0, 200), meaning.slice(0, 1000)],
    )
  ).rows[0].id
}

async function refersTo(sql: Sql, tenantId: string): Promise<string> {
  return (
    await sql.query<{ id: string }>(
      `insert into public.relationship_types (tenant_id, name, description, status, origin) values ($1, 'refers_to', 'A company term and the thing it names', 'active', 'ai')
       on conflict (tenant_id, lower(name)) do update set name = relationship_types.name returning id`,
      [tenantId],
    )
  ).rows[0].id
}

// The most connected business entities, as context for reading prose. Computed with one
// aggregate and cached per client: every document job needs it.
const knownCache = new Map<string, { at: number; rows: { name: string; type: string }[] }>()
async function knownEntities(sql: Sql, tenantId: string) {
  const hit = knownCache.get(tenantId)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.rows
  const rows = (
    await sql.query<{ name: string; type: string }>(
      `with deg as (select target_entity_id id, count(*) n from public.relationships where tenant_id = $1 group by 1)
       select e.canonical_name name, t.name type from public.entities e join public.entity_types t on t.id = e.entity_type_id
       left join deg on deg.id = e.id
       where e.tenant_id = $1 and e.status in ('candidate', 'active')
         and t.name in ('Customer', 'Person', 'Branch', 'Vendor', 'Site', 'PM Agreement', 'Service Item', 'Labor Rate')
       order by coalesce(deg.n, 0) desc limit 400`,
      [tenantId],
    )
  ).rows
  knownCache.set(tenantId, { at: Date.now(), rows })
  return rows
}

/** Reads one document's prose and writes vocabulary (as jargon aliases) and facts with their quotes. */
/**
 * Reads one document, or a batch of small ones (e.g. an email thread), for facts and vocabulary.
 * In a batch, each passage is labelled with its own source and date.
 */
export async function extractKnowledge(
  sql: Sql,
  tenantId: string,
  documentVersionIds: string | string[],
  opts: { includeSmallTables?: boolean } = {},
): Promise<{ passages: number; vocabulary: number; facts: number; calls: number }> {
  const ids = Array.isArray(documentVersionIds) ? documentVersionIds : [documentVersionIds]
  const passages = (
    await sql.query<{ id: string; kind: string; content: string; observed_at: string | null; path: string }>(
      `select e.id, e.kind, e.content, e.observed_at, so.original_path path
       from public.evidence e join public.document_versions dv on dv.id = e.document_version_id join public.source_objects so on so.id = dv.source_object_id
       where e.document_version_id = any($1::uuid[])
         -- Tables are records (loaded as entities); small ones (price sheets, rate tables) can be read for facts when asked.
         and (e.kind <> 'table' or ($2 and (select count(*) from public.evidence t where t.document_version_id = e.document_version_id) <= 5))
       order by array_position($1::uuid[], e.document_version_id), e.ordinal`,
      [ids, !!opts.includeSmallTables],
    )
  ).rows
  const batch = ids.length > 1
  if (!passages.length) return { passages: 0, vocabulary: 0, facts: 0, calls: 0 }
  const rules = await rulesFor(sql, tenantId)
  const AUTHORITY = rules.authority.evidence_kind
  const typeRows = (await sql.query<{ id: string; name: string; description: string | null }>(`select id, name, description from public.entity_types where tenant_id = $1 and status <> 'rejected'`, [tenantId])).rows
  const types = new Map(typeRows.map((t) => [t.name.toLowerCase(), t.id]))
  const cache = new Map<string, string>()
  const known = await knownEntities(sql, tenantId)

  // Batches of passages up to BATCH_CHARS.
  const batches: { start: number; text: string }[] = []
  let cur = ''
  let start = 0
  passages.forEach((p, i) => {
    const label = batch ? ` (${p.path}${p.observed_at ? `, ${String(p.observed_at).slice(0, 10)}` : ''})` : ''
    const block = `[${i}]${label} ${p.content.replace(/\s+/g, ' ').trim()}\n`
    if (cur.length + block.length > BATCH_CHARS && cur) {
      batches.push({ start, text: cur })
      cur = ''
      start = i
    }
    cur += block
  })
  if (cur) batches.push({ start, text: cur })

  let vocab = 0
  let facts = 0
  for (const b of batches) {
    const out = await structured<ProseFinding>({
      system: `You extract operational knowledge about a company from its own words. Only record what the passages actually say; quote exactly. Use these entity types: ${typeRows.map((t) => t.name).join(', ')}. Prefer the names of known entities when the passage refers to them (nicknames and jargon included).${withContext(rules)}`,
      prompt: `${batch ? `Sources: ${ids.length} ${AUTHORITY[passages[0].kind] ?? passages[0].kind}s (each passage labelled with its source and date)` : `Source: ${passages[0].path} (${AUTHORITY[passages[0].kind] ?? passages[0].kind}${passages[0].observed_at ? `, ${String(passages[0].observed_at).slice(0, 10)}` : ''})`}

Known entities (type: name), most important first:
${known.map((k) => `${k.type}: ${k.name}`).join('\n')}

Passages (numbered):
${b.text}

Extract:
- vocabulary: company jargon, nicknames and internal terms (team nicknames for places, customers, equipment and procedures, e.g. "the board", "the cage", a branch called by its town), with their meaning and, when it names a thing, which entity (type + name).
- facts: concrete, useful statements about how the business works: customer-specific exceptions (special pricing, waived fees, unusual terms), policies and practices (how things are actually done, which may differ from documents), history and changes with dates (valid_from/valid_to as YYYY-MM-DD or YYYY when stated), who knows or does what that others don't (key_person), risks. subject = the entity the fact is about; predicate = short snake_case (e.g. waives_dispatch_fee, verifies_lockout, knows_how_to); value = the literal value or a short description; object = another entity if the fact links two. certainty: stated, estimate ("about", "I think"), or uncertain.
- passage = the [number] the quote comes from. Skip small talk and anything not about the business.`,
      schema: SCHEMA,
      effort: 'low',
      maxTokens: 16000,
    })
    for (const v of out.vocabulary) {
      const p = passages[v.passage]
      if (!p || !v.term.trim()) continue
      // The term itself is an entity (company vocabulary), linked to what it refers to.
      const term = await termEntity(sql, tenantId, v.term.trim(), v.meaning)
      await sql.query(`insert into public.evidence_links (tenant_id, evidence_id, entity_id, stance, quote, origin) values ($1, $2, $3, 'supports', $4, 'ai')`, [tenantId, p.id, term, v.quote.slice(0, 1000)])
      const entity = v.refers_to ? await entityFor(sql, tenantId, v.refers_to, types, cache) : null
      if (entity) {
        await sql.query(
          `insert into public.entity_aliases (tenant_id, entity_id, alias, kind, status, origin, context)
           select $1, $2, $3, 'jargon', 'candidate', 'ai', $4
           where not exists (select 1 from public.entity_aliases a where a.entity_id = $2 and a.normalized_alias = lower(btrim(regexp_replace($3, '\\s+', ' ', 'g'))))`,
          [tenantId, entity, v.term.trim().slice(0, 200), JSON.stringify({ meaning: v.meaning })],
        )
        await sql.query(
          `insert into public.relationships (tenant_id, relationship_type_id, source_entity_id, target_entity_id, status, metadata)
           select $1, $2, $3, $4, 'candidate', '{"origin":"prose"}'
           where not exists (select 1 from public.relationships r where r.relationship_type_id = $2 and r.source_entity_id = $3 and r.target_entity_id = $4)`,
          [tenantId, await refersTo(sql, tenantId), term, entity],
        )
      }
      vocab++
    }
    for (const f of out.facts) {
      const p = passages[f.passage]
      if (!p) continue
      const subject = await entityFor(sql, tenantId, f.subject, types, cache)
      if (!subject) continue
      const object = f.object ? await entityFor(sql, tenantId, f.object, types, cache) : null
      const date = (s: string | null) => (s && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s) ? (s.length === 4 ? `${s}-01-01` : s.length === 7 ? `${s}-01` : s) : null)
      const fact = (
        await sql.query<{ id: string }>(
          `insert into public.facts (tenant_id, subject_entity_id, predicate, value, object_entity_id, valid_from, valid_to, observed_at, authority, confidence, status, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'candidate', $11) returning id`,
          [
            tenantId,
            subject,
            f.predicate.slice(0, 120),
            f.value === null && !object ? JSON.stringify('(stated)') : f.value === null ? null : JSON.stringify(f.value),
            object,
            date(f.valid_from),
            date(f.valid_to),
            p.observed_at,
            AUTHORITY[p.kind] ?? 'document',
            f.certainty === 'stated' ? 0.8 : f.certainty === 'estimate' ? 0.6 : 0.4,
            JSON.stringify({ origin: 'prose', layer: 'claim', kind: f.kind, certainty: f.certainty }),
          ],
        )
      ).rows[0]
      await sql.query(`insert into public.evidence_links (tenant_id, evidence_id, fact_id, stance, quote, origin) values ($1, $2, $3, 'supports', $4, 'ai')`, [tenantId, p.id, fact.id, f.quote.slice(0, 1000)])
      facts++
    }
  }
  return { passages: passages.length, vocabulary: vocab, facts, calls: batches.length }
}
