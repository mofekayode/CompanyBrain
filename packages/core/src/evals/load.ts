// Loads a hand-written eval set (JSON written by an FDE or a Claude Code session)
// into eval_sets / eval_items. Data checks become SQL through assertionSql; questions
// get their evidence from "anchors" (subject + predicate of the canonical facts the
// answer rests on), so every expected answer cites the files it came from.

import type { Sql } from '../storage/raw'
import { type Assertion, assertionSql } from './generate'

export interface EvalSpecItem {
  kind: 'data_check' | 'question'
  category: string
  question: string
  expected_answer?: string
  difficulty?: 'easy' | 'medium' | 'hard'
  assertion?: Assertion
  key_points?: string[]
  /** Canonical facts the answer rests on: subject (name or alias) + predicate substring. */
  anchors?: { subject: string; predicate: string }[]
  persona?: string
  as_of?: string
  /** Search-only expectation: something matching these must be in the top results (or never, for forbid_path). */
  retrieval?: { entity?: string; kind?: string; text?: string; text_all?: string[]; above?: string; path?: string; forbid_path?: string; top?: number }
}

export interface EvalSpec {
  name: string
  description: string
  /** Who wrote it: 'ai' (a Claude session / generator) or 'human' (FDE, client). Default 'ai'. */
  origin?: 'ai' | 'human'
  items: EvalSpecItem[]
}

async function anchorEvidence(sql: Sql, tenantId: string, anchors: { subject: string; predicate: string }[]) {
  if (!anchors.length) return { evidence_ids: [] as string[], file_ids: [] as string[], files: [] as string[], missing: [] as string[] }
  const rows = (
    await sql.query<{ i: number; evidence_id: string | null; file_id: string | null; path: string | null }>(
      `with a as (select (x ->> 'subject') subject, (x ->> 'predicate') predicate, (o - 1)::int i from jsonb_array_elements($2::jsonb) with ordinality t(x, o)),
       f as (select a.i, f.id from a
             join public.entities s on s.tenant_id = $1 and s.status in ('candidate', 'active')
               and (lower(s.canonical_name) = lower(a.subject) or exists (select 1 from public.entity_aliases x where x.entity_id = s.id and x.status <> 'rejected' and x.normalized_alias = lower(btrim(a.subject))))
             join public.facts f on f.subject_entity_id = s.id and f.metadata ->> 'layer' = 'canonical' and f.status <> 'rejected' and f.predicate ilike '%' || a.predicate || '%'),
       ids as (select i, id from f union select f.i, fc.claim_id from f join public.fact_claims fc on fc.canonical_id = f.id)
       select ids.i, l.evidence_id, so.id file_id, so.original_path path
       from ids left join public.evidence_links l on l.fact_id = ids.id
       left join public.evidence e on e.id = l.evidence_id
       left join public.document_versions dv on dv.id = e.document_version_id
       left join public.source_objects so on so.id = dv.source_object_id`,
      [tenantId, JSON.stringify(anchors)],
    )
  ).rows
  const found = new Set(rows.map((r) => r.i))
  const withEvidence = rows.filter((r) => r.evidence_id)
  return {
    evidence_ids: [...new Set(withEvidence.map((r) => r.evidence_id!))],
    file_ids: [...new Set(withEvidence.map((r) => r.file_id!))],
    files: [...new Set(withEvidence.map((r) => r.path!))],
    missing: anchors.filter((_, i) => !found.has(i)).map((a) => `${a.subject} · ${a.predicate}`),
  }
}

/** Replaces the items of the named set (same origin) with the spec's items. */
export async function loadEvalSet(sql: Sql, tenantId: string, spec: EvalSpec, origin: 'ai' | 'human' = spec.origin ?? 'ai') {
  const set = (
    await sql.query<{ id: string }>(
      `insert into public.eval_sets (tenant_id, name, description, origin) values ($1, $2, $3, $4)
       on conflict (tenant_id, name) do update set description = excluded.description returning id`,
      [tenantId, spec.name, spec.description, origin],
    )
  ).rows[0].id
  await sql.query(`delete from public.eval_items where set_id = $1 and origin = $2`, [set, origin])
  const people = new Map(
    (await sql.query<{ id: string; name: string }>(`select id, display_name name from public.principals where tenant_id = $1 and kind = 'user'`, [tenantId])).rows.map((p) => [p.name.toLowerCase(), p.id]),
  )
  const warnings: string[] = []
  const byCategory: Record<string, number> = {}
  for (const it of spec.items) {
    if (it.kind === 'data_check' && !it.assertion) throw new Error(`data check without assertion: ${it.question}`)
    const ev = await anchorEvidence(sql, tenantId, it.anchors ?? [])
    if (ev.missing.length) warnings.push(`${it.question} → no canonical fact for ${ev.missing.join(', ')}`)
    const persona = it.persona ? people.get(it.persona.toLowerCase()) : null
    if (it.persona && !persona) warnings.push(`${it.question} → unknown persona ${it.persona}`)
    await sql.query(
      `insert into public.eval_items (tenant_id, set_id, kind, category, question, expected_answer, expected, check_sql, persona_id, as_of, difficulty, origin)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        tenantId,
        set,
        it.kind,
        it.category,
        it.question,
        it.expected_answer ?? null,
        JSON.stringify({ key_points: it.key_points ?? [], anchors: it.anchors ?? [], evidence_ids: ev.evidence_ids, file_ids: ev.file_ids, files: ev.files, assertion: it.assertion ?? null, retrieval: it.retrieval ?? null }),
        it.assertion ? assertionSql(it.assertion) : null,
        persona ?? null,
        it.as_of ?? null,
        it.difficulty ?? 'medium',
        origin,
      ],
    )
    byCategory[`${it.kind}:${it.category}`] = (byCategory[`${it.kind}:${it.category}`] ?? 0) + 1
  }
  return { set_id: set, items: spec.items.length, by_category: byCategory, warnings }
}
