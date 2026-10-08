// Retrieval evals: is the evidence an answer needs actually found, near the top,
// only for people allowed to see it, and fast? Runs the eval set's questions through
// search and scores the ranked list, no AI involved.
//
// Two kinds of items:
// - questions with anchors (the canonical facts an answer rests on): gold = the files
//   behind those facts. Scored by hit@10, recall@10 over gold files and MRR.
// - probes with `retrieval` expectations (entity / kind / text / path in the top k, or
//   a forbidden path that must never appear for that persona).

import { search, type SearchHit, type SearchOptions } from '../search/search'
import type { Sql } from '../storage/raw'

export type Variant = 'hybrid' | 'bm25' | 'knn' | 'hybrid+rerank'

interface Item {
  id: string
  category: string
  question: string
  persona_id: string | null
  expected: {
    file_ids?: string[]
    files?: string[]
    retrieval?: { entity?: string; kind?: string; text?: string; text_all?: string[]; above?: string; path?: string; forbid_path?: string; forbid_text?: string; top?: number } | null
  }
}

export interface RetrievalItemResult {
  item_id: string
  category: string
  question: string
  passed: boolean | null // null = not measurable by retrieval (e.g. unanswerable)
  rank: number | null
  recall: number | null
  latency_ms: number
  top: { title: string; kind: string; path: string | null }[]
  note: string
}

/** Files behind each hit: a passage's own file; a fact card's supporting evidence files. */
async function hitFiles(sql: Sql, tenantId: string, hits: SearchHit[]): Promise<string[][]> {
  const cards = hits.filter((h) => !h.source_object_id).map((h) => h.id)
  const byCard = new Map<string, string[]>()
  if (cards.length) {
    const rows = (
      await sql.query<{ id: string; files: string[] }>(
        `select d.id, coalesce(array_agg(distinct dv.source_object_id::text) filter (where dv.source_object_id is not null), '{}') files
         from public.search_documents d left join public.evidence e on e.id = any(d.evidence_ids) left join public.document_versions dv on dv.id = e.document_version_id
         where d.tenant_id = $1 and d.id = any($2::text[]) group by d.id`,
        [tenantId, cards],
      )
    ).rows
    for (const r of rows) byCard.set(r.id, r.files)
  }
  return hits.map((h) => (h.source_object_id ? [h.source_object_id] : (byCard.get(h.id) ?? [])))
}

const optionsFor = (variant: Variant): Partial<SearchOptions> =>
  variant === 'bm25' ? { only: 'bm25' } : variant === 'knn' ? { only: 'knn' } : variant === 'hybrid+rerank' ? { rerank: true } : {}

export async function runRetrievalEval(sql: Sql, tenantId: string, setIds: string[], variant: Variant = 'hybrid') {
  const items = (
    await sql.query<Item>(
      `select id, category, question, persona_id, expected from public.eval_items where set_id = any($1::uuid[]) and kind = 'question' and status = 'active' order by created_at`,
      [setIds],
    )
  ).rows
  const entityIds = new Map<string, string>()
  const entityId = async (name: string) => {
    if (!entityIds.has(name))
      entityIds.set(
        name,
        (
          await sql.query<{ id: string }>(`select id from public.entities where tenant_id = $1 and status in ('candidate', 'active') and lower(canonical_name) = lower($2) limit 1`, [tenantId, name])
        ).rows[0]?.id ?? '',
      )
    return entityIds.get(name)!
  }

  const results: RetrievalItemResult[] = []
  for (const it of items) {
    const r = it.expected.retrieval
    const top = r?.top ?? 10
    const res = await search(sql, tenantId, it.question, { as: it.persona_id, limit: Math.max(top, 10), ...optionsFor(variant) })
    const hits = res.hits.slice(0, Math.max(top, 10))
    const out: RetrievalItemResult = {
      item_id: it.id,
      category: it.category,
      question: it.question,
      passed: null,
      rank: null,
      recall: null,
      latency_ms: res.timings.total_ms,
      top: hits.slice(0, 5).map((h) => ({ title: h.title, kind: h.kind, path: h.path })),
      note: '',
    }
    if (r) {
      if (r.forbid_text) {
        // A pattern that must never surface for this persona (e.g. a confidential deal's name).
        const re = new RegExp(r.forbid_text, 'i')
        const leak = hits.find((h) => re.test(`${h.title} ${h.content}`))
        out.passed = !leak
        out.note = leak ? `LEAK: "${leak.title}"` : `${hits.length} results, none matching /${r.forbid_text}/`
      } else if (r.forbid_path) {
        const leak = hits.find((h) => h.path?.toLowerCase().includes(r.forbid_path!.toLowerCase()))
        out.passed = !leak
        out.note = leak ? `LEAK: ${leak.path}` : `${hits.length} results, none from ${r.forbid_path}`
      } else if (r.text_all?.length && !r.text && !r.entity && !r.kind && !r.path) {
        // Change questions: every version must be in the top k (not just the current one).
        const blob = hits.slice(0, top).map((h) => `${h.title}\n${h.content}`.toLowerCase())
        const ranks = r.text_all.map((t) => blob.findIndex((b) => b.includes(t.toLowerCase())))
        out.passed = ranks.every((x) => x >= 0)
        out.rank = out.passed ? Math.max(...ranks) + 1 : null
        out.note = r.text_all.map((t, i) => `${t}: ${ranks[i] >= 0 ? `#${ranks[i] + 1}` : 'missing'}`).join(' · ')
      } else {
        // What a hit itself states: history lines and timeline cards mention every version, so they
        // can't tell which era a result belongs to.
        const own = (h: SearchHit) => (h.kind === 'timeline' ? '' : `${h.title}\n${h.content.split('\n').filter((l) => !l.startsWith('Timeline: ')).join('\n')}`.toLowerCase())
        const eid = r.entity ? await entityId(r.entity) : null
        const ok = (h: SearchHit) =>
          (!r.entity || (!!eid && h.entity_ids.includes(eid))) &&
          (!r.kind || h.kind === r.kind) &&
          (!r.text || own(h).includes(r.text.toLowerCase())) &&
          (!r.path || (h.path ?? '').toLowerCase().includes(r.path.toLowerCase()))
        const idx = hits.findIndex(ok)
        out.rank = idx >= 0 ? idx + 1 : null
        out.passed = idx >= 0 && idx < top
        out.note = idx >= 0 ? `found at #${idx + 1}` : `not in top ${hits.length}${r.entity && !eid ? ` (unknown entity ${r.entity})` : ''}`
        if (r.above) {
          // Time questions: the right era must rank before the wrong one.
          const other = hits.findIndex((h) => own(h).includes(r.above!.toLowerCase()))
          if (out.passed && other >= 0 && other < idx) {
            out.passed = false
            out.note += `, but "${r.above}" ranks higher (#${other + 1})`
          } else if (out.passed) out.note += other >= 0 ? `, above "${r.above}" (#${other + 1})` : `, "${r.above}" absent`
        }
      }
    } else if (it.expected.file_ids?.length) {
      const gold = new Set(it.expected.file_ids)
      const files = await hitFiles(sql, tenantId, hits.slice(0, 10))
      const firstGold = files.findIndex((fs) => fs.some((f) => gold.has(f)))
      const found = new Set(files.flat().filter((f) => gold.has(f)))
      out.rank = firstGold >= 0 ? firstGold + 1 : null
      out.recall = found.size / gold.size
      out.passed = firstGold >= 0
      out.note = `${found.size}/${gold.size} source files in top 10${firstGold >= 0 ? `, first at #${firstGold + 1}` : ''}`
    } else out.note = 'not measurable by retrieval'
    results.push(out)
  }

  const measured = results.filter((r) => r.passed !== null)
  const lat = results.map((r) => r.latency_ms).sort((a, b) => a - b)
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? 0
  const ranked = measured.filter((r) => r.rank !== null || r.passed === false)
  const byCategory: Record<string, { passed: number; total: number }> = {}
  for (const r of measured) {
    const c = (byCategory[r.category] ??= { passed: 0, total: 0 })
    c.total++
    if (r.passed) c.passed++
  }
  const recalls = results.filter((r) => r.recall !== null).map((r) => r.recall!)
  const summary = {
    variant,
    total: measured.length,
    passed: measured.filter((r) => r.passed).length,
    mrr: ranked.length ? ranked.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / ranked.length : 0,
    recall_at_10: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
    latency_p50_ms: pct(50),
    latency_p95_ms: pct(95),
    by_category: byCategory,
  }

  // Keep the run next to data-check runs (one run per set).
  for (const setId of setIds) {
    const run = (await sql.query<{ id: string }>(`insert into public.eval_runs (tenant_id, set_id, target) values ($1, $2, $3) returning id`, [tenantId, setId, `search:elastic:${variant}`])).rows[0].id
    const mine = results.filter((r) => items.find((i) => i.id === r.item_id))
    const setItems = new Set((await sql.query<{ id: string }>(`select id from public.eval_items where set_id = $1`, [setId])).rows.map((r) => r.id))
    for (const r of mine.filter((m) => setItems.has(m.item_id)))
      await sql.query(`insert into public.eval_results (tenant_id, run_id, item_id, passed, score, output) values ($1, $2, $3, $4, $5, $6)`, [
        tenantId,
        run,
        r.item_id,
        r.passed ?? false,
        r.rank ? 1 / r.rank : 0,
        JSON.stringify({ rank: r.rank, recall: r.recall, latency_ms: r.latency_ms, note: r.note, top: r.top, measured: r.passed !== null }),
      ])
    await sql.query(`update public.eval_runs set summary = $2, finished_at = now() where id = $1`, [run, JSON.stringify(summary)])
  }
  return { summary, results }
}
