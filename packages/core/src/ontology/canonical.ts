// Canonical knowledge: from many claims (what each source says) to the facts the
// company model believes.
// - Repeated claims become one canonical fact with all its sources.
// - Sources are ranked: system of record > official document > email > interview.
// - Values that changed over time become a timeline (each period its own fact,
//   linked by supersedes_fact_id); nothing is overwritten.
// - Claims that disagree are kept as a conflict for an FDE to settle.
// Reviewed canonical facts (reviewed_at set) are never regenerated.

import { structured } from '../claude'
import { DEFAULT_RULES, rulesFor, withContext } from '../config/tenant-config'
import type { Sql } from '../storage/raw'

/** Default authority order; a tenant can override it (rules.authority.rank). */
export const AUTHORITY_RANK: Record<string, number> = DEFAULT_RULES.authority.rank

/** "system_of_record > document = official_document > email > interview = video = photo" */
export function authorityOrder(rank: Record<string, number>): string {
  const levels = new Map<number, string[]>()
  for (const [k, n] of Object.entries(rank)) levels.set(n, [...(levels.get(n) ?? []), k])
  return [...levels.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, ks]) => ks.join(' = '))
    .join(' > ')
}

interface Claim {
  id: string
  predicate: string
  value: string | null
  object: string | null
  valid_from: string | null
  valid_to: string | null
  authority: string
  kind: string | null
  certainty: string | null
  observed_at: string | null
  quote: string | null
  source: string | null
}

interface Canonical {
  predicate: string
  value: string
  kind: 'exception' | 'policy' | 'practice' | 'history' | 'key_person' | 'risk' | 'other'
  valid_from: string | null
  valid_to: string | null
  status: 'agreed' | 'single_source' | 'conflict' | 'unknown'
  summary: string
  conflict_note: string | null
  supports: string[] // claim refs (c3, s1)
  contradicts: string[]
  confidence: number
  previous: number | null // index in this subject's list of the period this one replaced
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subjects'],
  properties: {
    subjects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'facts'],
        properties: {
          subject: { type: 'string' },
          facts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['predicate', 'value', 'kind', 'valid_from', 'valid_to', 'status', 'summary', 'conflict_note', 'supports', 'contradicts', 'confidence', 'previous'],
              properties: {
                predicate: { type: 'string' },
                value: { type: 'string' },
                kind: { type: 'string', enum: ['exception', 'policy', 'practice', 'history', 'key_person', 'risk', 'other'] },
                valid_from: { type: ['string', 'null'] },
                valid_to: { type: ['string', 'null'] },
                status: { type: 'string', enum: ['agreed', 'single_source', 'conflict', 'unknown'] },
                summary: { type: 'string' },
                conflict_note: { type: ['string', 'null'] },
                supports: { type: 'array', items: { type: 'string' } },
                contradicts: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number' },
                previous: { type: ['integer', 'null'] },
              },
            },
          },
        },
      },
    },
  },
}

const day = (s: string | null) => (s && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s) ? (s.length === 4 ? `${s}-01-01` : s.length === 7 ? `${s}-01` : s) : null)

/** Removes unreviewed canonical facts and system claims from an earlier run. */
async function clearUnreviewed(sql: Sql, tenantId: string) {
  await sql.query(`update public.facts set supersedes_fact_id = null where tenant_id = $1 and metadata ->> 'layer' = 'canonical' and reviewed_at is null`, [tenantId])
  await sql.query(`delete from public.facts where tenant_id = $1 and metadata ->> 'layer' = 'canonical' and reviewed_at is null`, [tenantId])
  await sql.query(
    `delete from public.facts f where f.tenant_id = $1 and f.metadata ->> 'origin' = 'system'
       and not exists (select 1 from public.fact_claims c where c.claim_id = f.id)`,
    [tenantId],
  )
}

export async function canonicalize(sql: Sql, tenantId: string, opts: { subjectsPerCall?: number } = {}): Promise<Record<string, number>> {
  const rules = await rulesFor(sql, tenantId)
  const rank = rules.authority.rank
  await sql.query(`update public.facts set metadata = metadata || '{"layer":"claim"}' where tenant_id = $1 and metadata ->> 'origin' = 'prose' and not metadata ? 'layer'`, [tenantId])
  await clearUnreviewed(sql, tenantId)
  // Subjects with claims, and their claims (reviewed subjects keep their reviewed facts; we still regenerate the rest).
  const claims = (
    await sql.query<Claim & { subject_id: string; subject: string; subject_type: string; props: Record<string, unknown> }>(
      `select f.id, f.predicate, f.value #>> '{}' value, o.canonical_name object, f.valid_from::text, f.valid_to::text, coalesce(f.authority, 'interview') authority,
              f.metadata ->> 'kind' kind, f.metadata ->> 'certainty' certainty, f.observed_at::text,
              (select l.quote from public.evidence_links l where l.fact_id = f.id limit 1) quote,
              (select so.original_path from public.evidence_links l join public.evidence e on e.id = l.evidence_id
                 join public.document_versions dv on dv.id = e.document_version_id join public.source_objects so on so.id = dv.source_object_id where l.fact_id = f.id limit 1) source,
              s.id subject_id, s.canonical_name subject, t.name subject_type, s.properties props
       from public.facts f join public.entities s on s.id = f.subject_entity_id join public.entity_types t on t.id = s.entity_type_id
       left join public.entities o on o.id = f.object_entity_id
       where f.tenant_id = $1 and f.metadata ->> 'layer' = 'claim' and f.metadata ->> 'origin' = 'prose' and f.status <> 'rejected'
         -- Incremental: claims already behind a reviewed canonical fact are settled.
         and not exists (select 1 from public.fact_claims fc join public.facts k on k.id = fc.canonical_id where fc.claim_id = f.id and k.reviewed_at is not null)
       order by s.canonical_name, f.predicate`,
      [tenantId],
    )
  ).rows
  const bySubject = new Map<string, { name: string; type: string; props: Record<string, unknown>; claims: Claim[] }>()
  for (const c of claims) {
    const s = bySubject.get(c.subject_id) ?? { name: c.subject, type: c.subject_type, props: c.props, claims: [] }
    s.claims.push(c)
    bySubject.set(c.subject_id, s)
  }
  // Batches of subjects, ~70 claims per call.
  const subjects = [...bySubject.entries()].sort((a, b) => b[1].claims.length - a[1].claims.length)
  const batches: (typeof subjects)[] = []
  let cur: typeof subjects = []
  let n = 0
  for (const s of subjects) {
    if (n + s[1].claims.length > 70 && cur.length) {
      batches.push(cur)
      cur = []
      n = 0
    }
    cur.push(s)
    n += s[1].claims.length
  }
  if (cur.length) batches.push(cur)

  const stats = { subjects: subjects.length, claims: claims.length, canonical: 0, conflicts: 0, timelines: 0, calls: 0 }
  for (const batch of batches) {
    const refs = new Map<string, { kind: 'claim'; id: string } | { kind: 'system'; subject: string; field: string; value: string; system: string }>()
    const blocks = batch.map(([sid, s], si) => {
      const lines = s.claims.map((c, i) => {
        const ref = `c${si}_${i}`
        refs.set(ref, { kind: 'claim', id: c.id })
        return `${ref} [${c.authority}${c.observed_at ? ` ${c.observed_at.slice(0, 10)}` : ''}${c.certainty && c.certainty !== 'stated' ? `, ${c.certainty}` : ''}] ${c.predicate}: ${c.value ?? ''}${c.object ? ` → ${c.object}` : ''}${c.valid_from ? ` (from ${c.valid_from})` : ''}${c.valid_to ? ` (to ${c.valid_to})` : ''}${c.quote ? ` | "${c.quote.slice(0, 220)}"` : ''}`
      })
      const system = Object.entries(s.props)
        .filter(([k, v]) => k !== 'source_system' && v !== null && v !== '' && String(v).length < 200)
        .slice(0, 14)
        .map(([k, v], i) => {
          const ref = `s${si}_${i}`
          refs.set(ref, { kind: 'system', subject: sid, field: k, value: String(v), system: String(s.props.source_system ?? 'system') })
          return `${ref} [system_of_record: ${s.props.source_system ?? 'system'}] ${k}: ${v}`
        })
      return `## ${s.type}: ${s.name}\nClaims:\n${lines.join('\n')}${system.length ? `\nSystem fields:\n${system.join('\n')}` : ''}`
    })
    const out = await structured<{ subjects: { subject: string; facts: Canonical[] }[] }>({
      system: `You turn claims about a company into canonical facts. Authority, strongest first: ${authorityOrder(rank)} (documents means signed/official ones). Never invent: every canonical fact must be supported by at least one claim or system field ref.${withContext(rules)}`,
      prompt: `For each subject below, produce its canonical facts:
- Merge claims that say the same thing (different wording, different interviews) into ONE fact; list all their refs in supports.
- If sources disagree on a value (including a system field vs an interview), make ONE fact with the best-supported value (by authority, recency and corroboration), status "conflict", the disagreeing refs in contradicts, and conflict_note saying exactly who says what.
- If a value changed over time (e.g. terms Net 30 then Net 60 from 2025-07), make one fact per period with valid_from/valid_to (YYYY-MM-DD or YYYY), and set previous = the index (within this subject's facts list) of the period it replaced.
- status: agreed (2+ independent sources agree), single_source, conflict, or unknown (sources say they don't know / guess).
- confidence 0-1 from authority, corroboration and certainty. summary: one plain sentence a new FDE understands. In summary and conflict_note, name sources in words ("the 2025 policy", "the owner's interview"), never by ref code. Use only system fields that matter to a claim.
- subject must be the exact subject name after "## Type: ".

${blocks.join('\n\n')}`,
      schema: SCHEMA,
      effort: 'medium',
      maxTokens: 32000,
    })
    stats.calls++
    for (const subj of out.subjects) {
      const entry = batch.find(([, s]) => s.name === subj.subject)
      if (!entry) continue
      const [subjectId] = entry
      const ids: string[] = []
      for (const f of subj.facts) {
        const supports = f.supports.filter((r) => refs.has(r))
        if (!supports.length) {
          ids.push('')
          continue
        }
        const supportAuth = supports.map((r) => refs.get(r)!).map((r) => (r.kind === 'system' ? 'system_of_record' : claims.find((c) => c.id === r.id)?.authority ?? 'interview'))
        const authority = supportAuth.sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0]
        const id = (
          await sql.query<{ id: string }>(
            `insert into public.facts (tenant_id, subject_entity_id, predicate, value, valid_from, valid_to, authority, confidence, status, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
            [
              tenantId,
              subjectId,
              f.predicate.slice(0, 120),
              JSON.stringify(f.value),
              day(f.valid_from),
              day(f.valid_to),
              authority,
              Math.max(0, Math.min(1, f.confidence)),
              f.status === 'conflict' ? 'disputed' : f.status === 'unknown' ? 'unknown' : 'candidate',
              JSON.stringify({ layer: 'canonical', kind: f.kind, agreement: f.status, summary: f.summary, conflict_note: f.conflict_note, sources: supports.length }),
            ],
          )
        ).rows[0].id
        ids.push(id)
        stats.canonical++
        if (f.status === 'conflict') stats.conflicts++
        for (const [list, stance] of [
          [supports, 'supports'],
          [f.contradicts.filter((r) => refs.has(r)), 'contradicts'],
        ] as const) {
          for (const r of list) {
            const ref = refs.get(r)!
            const claimId =
              ref.kind === 'claim'
                ? ref.id
                : (
                    await sql.query<{ id: string }>(
                      `insert into public.facts (tenant_id, subject_entity_id, predicate, value, authority, confidence, status, metadata)
                       values ($1, $2, $3, $4, 'system_of_record', 0.9, 'candidate', $5) returning id`,
                      [tenantId, ref.subject, ref.field.slice(0, 120), JSON.stringify(ref.value), JSON.stringify({ layer: 'claim', origin: 'system', source_system: ref.system })],
                    )
                  ).rows[0].id
            await sql.query(`insert into public.fact_claims (tenant_id, canonical_id, claim_id, stance) values ($1, $2, $3, $4) on conflict do nothing`, [tenantId, id, claimId, stance])
          }
        }
      }
      // Timelines: link each period to the one it replaced.
      for (let i = 0; i < subj.facts.length; i++) {
        const prev = subj.facts[i].previous
        if (prev === null || prev === i || !ids[i] || !ids[prev]) continue
        await sql.query(`update public.facts set supersedes_fact_id = $2 where id = $1`, [ids[i], ids[prev]])
        stats.timelines++
        await sql.query(`update public.facts set status = 'superseded' where id = $1 and status = 'candidate'`, [ids[prev]])
      }
    }
  }
  return stats
}

/** An FDE decision on a canonical fact. Every change is versioned (fact_versions) with the reason. */
export async function reviewFact(
  sql: Sql,
  tenantId: string,
  factId: string,
  decision: { action: 'accept' | 'dispute' | 'reject' | 'unknown' | 'correct'; value?: string; note?: string; valid_from?: string | null; valid_to?: string | null; reviewer?: 'fde' | 'ai' },
): Promise<{ id: string }> {
  const reviewer = decision.reviewer ?? 'fde'
  const status = { accept: 'accepted', dispute: 'disputed', reject: 'rejected', unknown: 'unknown', correct: 'accepted' }[decision.action]
  if (decision.action === 'correct') {
    // A correction is a new accepted fact that supersedes the old one; the old one stays as history.
    const old = (await sql.query<{ subject_entity_id: string; predicate: string; metadata: Record<string, unknown> }>(`select subject_entity_id, predicate, metadata from public.facts where tenant_id = $1 and id = $2`, [tenantId, factId])).rows[0]
    if (!old) throw new Error('unknown fact')
    const id = (
      await sql.query<{ id: string }>(
        `insert into public.facts (tenant_id, subject_entity_id, predicate, value, valid_from, valid_to, authority, confidence, status, supersedes_fact_id, note, reviewed_at, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, 1, 'accepted', $8, $9, now(), $10) returning id`,
        [tenantId, old.subject_entity_id, old.predicate, JSON.stringify(decision.value ?? ''), decision.valid_from ?? null, decision.valid_to ?? null, reviewer === 'ai' ? 'ai_review' : 'fde', factId, decision.note ?? null, JSON.stringify({ ...old.metadata, layer: 'canonical', corrected: true, reviewed_by: reviewer })],
      )
    ).rows[0].id
    await sql.query(`insert into public.fact_claims (tenant_id, canonical_id, claim_id, stance) select tenant_id, $2, claim_id, stance from public.fact_claims where canonical_id = $1 on conflict do nothing`, [factId, id])
    await sql.query(`update public.facts set status = 'superseded', reviewed_at = now(), note = coalesce($2, note), metadata = metadata || jsonb_build_object('reviewed_by', $3::text) where id = $1`, [factId, `corrected by ${reviewer === 'ai' ? 'AI review' : 'FDE'}${decision.note ? `: ${decision.note}` : ''}`, reviewer])
    return { id }
  }
  await sql.query(
    `update public.facts set status = $3, reviewed_at = now(), note = coalesce($4, note), metadata = metadata || jsonb_build_object('reviewed_by', $5::text) where tenant_id = $1 and id = $2`,
    [tenantId, factId, status, decision.note ?? null, reviewer],
  )
  return { id: factId }
}
