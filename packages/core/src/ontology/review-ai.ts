// AI review: an automated first pass over the knowledge review queue (for mock
// clients, or to pre-sort a real queue for an FDE). Every decision is marked
// reviewed_by = 'ai' with its reason, so a person can audit or undo it.

import { structured } from '../claude'
import type { Sql } from '../storage/raw'
import { reviewFact } from './canonical'
import { canonicalFacts, decideMerge, mergeQueue } from './review'

const FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fact', 'action', 'value', 'valid_from', 'why'],
        properties: {
          fact: { type: 'integer' },
          action: { type: 'string', enum: ['accept', 'correct', 'unknown', 'reject'] },
          value: { type: ['string', 'null'] },
          valid_from: { type: ['string', 'null'] },
          why: { type: 'string' },
        },
      },
    },
  },
}

/** Reviews open canonical facts (conflicts first) in batches. */
export async function aiReviewFacts(sql: Sql, tenantId: string, opts: { limit?: number } = {}): Promise<Record<string, number>> {
  const open = [
    ...(await canonicalFacts(sql, tenantId, { filter: 'conflicts', limit: 1000 })),
    ...(await canonicalFacts(sql, tenantId, { filter: 'to_review', limit: 2000 })).filter((f: any) => f.status !== 'disputed'),
  ].slice(0, opts.limit ?? 5000)
  const stats: Record<string, number> = { reviewed: 0, accept: 0, correct: 0, unknown: 0, reject: 0 }
  for (let i = 0; i < open.length; i += 20) {
    const chunk = open.slice(i, i + 20)
    const out = await structured<{ decisions: { fact: number; action: 'accept' | 'correct' | 'unknown' | 'reject'; value: string | null; valid_from: string | null; why: string }[] }>({
      system: `You review proposed facts about a company against their sources, like a careful analyst. Source strength: system of record > signed/official document > email > interview > video/photo. Decide:
- accept: the fact is well supported (a document/system source, or 2+ independent sources, or one clear first-hand statement with no contradiction) and the summary matches the sources.
- correct: the sources support a different value (give it, and valid_from if a date applies): e.g. a conflict where the stronger or more recent source says otherwise.
- unknown: sources are guesses or contradict each other with no way to tell.
- reject: not supported by the quoted sources, trivial, or not a fact about the business.`,
      prompt: chunk
        .map((f: any, k: number) => {
          const sources = f.claims
            .map((c: any) => `   ${c.stance === 'contradicts' ? '✗' : '✓'} [${c.authority}${c.certainty && c.certainty !== 'stated' ? `, ${c.certainty}` : ''}] ${c.predicate}: ${c.value ?? ''}${c.quote ? ` | "${String(c.quote).slice(0, 200)}"` : ''}${c.citation ? ` (${c.citation})` : ''}`)
            .join('\n')
          return `${k}. ${f.subject} · ${f.predicate} = ${f.value}${f.valid_from ? ` (from ${String(f.valid_from).slice(0, 10)})` : ''} [${f.status === 'disputed' ? 'CONFLICT' : f.agreement}]\n   summary: ${f.summary}${f.conflict_note ? `\n   conflict: ${f.conflict_note}` : ''}\n${sources}`
        })
        .join('\n\n'),
      schema: FACT_SCHEMA,
      effort: 'medium',
    })
    for (const d of out.decisions) {
      const f = chunk[d.fact] as any
      if (!f) continue
      await reviewFact(sql, tenantId, f.id, {
        action: d.action === 'correct' && !d.value ? 'accept' : d.action,
        value: d.value ?? undefined,
        valid_from: d.valid_from,
        note: `AI review: ${d.why}`.slice(0, 1000),
        reviewer: 'ai',
      })
      stats.reviewed++
      stats[d.action]++
    }
  }
  return stats
}

const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['pair', 'same', 'why'], properties: { pair: { type: 'integer' }, same: { type: 'boolean' }, why: { type: 'string' } } },
    },
  },
}

/** Decides the possible-duplicate pairs. */
export async function aiReviewMerges(sql: Sql, tenantId: string): Promise<Record<string, number>> {
  const pairs = await mergeQueue(sql, tenantId)
  const stats = { pairs: pairs.length, merged: 0, separate: 0 }
  const fmt = (name: string, props: Record<string, unknown>, ids: string[], links: number) =>
    `"${name}" (${props.source_system ?? 'link'}; ${links} links; ${ids.slice(0, 3).join(', ')}; ${Object.entries(props)
      .filter(([k, v]) => k !== 'source_system' && v)
      .slice(0, 4)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
      .join('; ')})`
  for (let i = 0; i < pairs.length; i += 30) {
    const chunk = pairs.slice(i, i + 30)
    const out = await structured<{ decisions: { pair: number; same: boolean; why: string }[] }>({
      system: 'You decide whether two records of a company model denote the same real-world thing. Be conservative: different sites, different people with similar names, or a generic vs a branch-specific rate are different things.',
      prompt: chunk.map((p: any, k: number) => `${k}. [${p.type}] A=${fmt(p.a_name, p.a_props, p.a_ids, p.a_links)}\n   B=${fmt(p.b_name, p.b_props, p.b_ids, p.b_links)}\n   resolver's doubt: ${p.why ?? ''}`).join('\n'),
      schema: MERGE_SCHEMA,
      effort: 'medium',
    })
    for (const d of out.decisions) {
      const p = chunk[d.pair] as any
      if (!p) continue
      try {
        await decideMerge(sql, tenantId, p.id, d.same ? 'merge' : 'separate')
        await sql.query(`update public.relationships set metadata = metadata || jsonb_build_object('decided_by', 'ai_review', 'decision_why', $2::text) where id = $1`, [p.id, d.why])
        d.same ? stats.merged++ : stats.separate++
      } catch {
        // An earlier merge in this batch may already have absorbed one side.
      }
    }
  }
  return stats
}

const TERM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'verdict', 'refers_to', 'why'],
        properties: {
          term: { type: 'integer' },
          verdict: { type: 'string', enum: ['keep', 'relink', 'unlink'] },
          refers_to: { type: ['string', 'null'] },
          why: { type: 'string' },
        },
      },
    },
  },
}

/** Checks each vocabulary term's link against its quote and the facts known about the candidates. */
export async function aiReviewTerms(sql: Sql, tenantId: string): Promise<Record<string, number>> {
  const terms = (
    await sql.query<{ id: string; term: string; meaning: string | null; quote: string | null; rel_id: string | null; target: string | null; target_type: string | null }>(
      `select e.id, e.canonical_name term, e.description meaning, (select l.quote from public.evidence_links l where l.entity_id = e.id limit 1) quote,
              r.id rel_id, o.canonical_name target, ot.name target_type
       from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = 'Term'
       left join public.relationships r on r.source_entity_id = e.id
       left join public.entities o on o.id = r.target_entity_id left join public.entity_types ot on ot.id = o.entity_type_id
       where e.tenant_id = $1 and e.status in ('candidate', 'active')`,
      [tenantId],
    )
  ).rows
  const candidates = (
    await sql.query<{ id: string; name: string; type: string; aliases: string | null }>(
      `with deg as (select target_entity_id id, count(*) n from public.relationships where tenant_id = $1 group by 1)
       select e.id, e.canonical_name name, t.name type, (select string_agg(a.alias, '; ') from (select alias from public.entity_aliases where entity_id = e.id limit 6) a) aliases
       from public.entities e join public.entity_types t on t.id = e.entity_type_id left join deg on deg.id = e.id
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and t.name in ('Customer', 'Person', 'Branch', 'Vendor', 'Site', 'Service Item')
       order by coalesce(deg.n, 0) desc limit 250`,
      [tenantId],
    )
  ).rows
  const stats = { terms: terms.length, kept: 0, relinked: 0, unlinked: 0 }
  const refersTo = (await sql.query<{ id: string }>(`select id from public.relationship_types where tenant_id = $1 and name = 'refers_to'`, [tenantId])).rows[0]?.id
  for (let i = 0; i < terms.length; i += 40) {
    const chunk = terms.slice(i, i + 40)
    const out = await structured<{ decisions: { term: number; verdict: 'keep' | 'relink' | 'unlink'; refers_to: string | null; why: string }[] }>({
      system: 'You check that company jargon is linked to the right thing. Use the quote, the meaning and the candidate entities (with their aliases).',
      prompt: `Candidate entities (type: name [aliases]):\n${candidates.map((c) => `${c.type}: ${c.name}${c.aliases ? ` [${c.aliases}]` : ''}`).join('\n')}\n\nTerms:\n${chunk
        .map((t, k) => `${k}. "${t.term}": ${t.meaning ?? ''} | linked to: ${t.target ? `${t.target_type}: ${t.target}` : '(nothing)'} | quote: "${(t.quote ?? '').slice(0, 200)}"`)
        .join('\n')}\n\nFor each term: keep the link, relink (give the exact candidate name in refers_to), or unlink (it names no single entity).`,
      schema: TERM_SCHEMA,
      effort: 'medium',
    })
    for (const d of out.decisions) {
      const t = chunk[d.term]
      if (!t) continue
      if (d.verdict === 'keep') {
        stats.kept++
        continue
      }
      if (t.rel_id) await sql.query(`delete from public.relationships where id = $1`, [t.rel_id])
      if (d.verdict === 'relink' && d.refers_to && refersTo) {
        const target = candidates.find((c) => c.name === d.refers_to)
        if (target) {
          await sql.query(
            `insert into public.relationships (tenant_id, relationship_type_id, source_entity_id, target_entity_id, status, metadata) values ($1, $2, $3, $4, 'accepted', $5)`,
            [tenantId, refersTo, t.id, target.id, JSON.stringify({ origin: 'ai_review', why: d.why })],
          )
          await sql.query(
            `insert into public.entity_aliases (tenant_id, entity_id, alias, kind, status, origin, context)
             select $1, $2, $3, 'jargon', 'candidate', 'ai', $4
             where not exists (select 1 from public.entity_aliases a where a.entity_id = $2 and a.normalized_alias = lower(btrim($3)))`,
            [tenantId, target.id, t.term, JSON.stringify({ meaning: t.meaning })],
          )
          stats.relinked++
          continue
        }
      }
      stats.unlinked++
    }
  }
  return stats
}
