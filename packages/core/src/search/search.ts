// Company search: hybrid retrieval over the client's index.
//
//   question ─► understand (entities, aliases, time) ─┬─► BM25 (words, names, aliases, typos) ─┐
//                                                     └─► kNN  (meaning, local embedding)     ─┴─► RRF fusion
//   ─► collapse duplicates (same email in 3 mailboxes) ─► source diversity ─► optional cross-encoder rerank
//
// Access is enforced inside Elasticsearch: every query carries a filter on acl_principals
// (the reader's user id and all their groups). An FDE search without `as` sees everything.

import type { estypes } from '@elastic/elasticsearch'
import type { Sql } from '../storage/raw'
import { embedQuery, rerankScores } from './embed'
import { es, indexAlias } from './es'
import { type Dictionary, type LinkedEntity, linkText, loadDictionary } from './linker'
import { parseTime, type TimeIntent } from './time'

export interface SearchOptions {
  /** Search as this person (principal id): only what they may open. Omit for the FDE view. */
  as?: string | null
  docTypes?: ('passage' | 'entity' | 'fact')[]
  kinds?: string[]
  sourceObjectId?: string
  /** Hard filter: only documents that mention one of these entities. */
  entityIds?: string[]
  /** Facts valid on this date (YYYY-MM-DD); passages observed on/before it. */
  asOf?: string
  limit?: number
  rerank?: boolean
  /** Turn off one leg (for evaluation): 'bm25' | 'knn'. */
  only?: 'bm25' | 'knn'
  /** At most this many results from one file (default 3). */
  perSource?: number
}

export interface SearchHit {
  id: string
  doc_type: 'passage' | 'entity' | 'fact'
  kind: string
  title: string
  snippet: string
  content: string
  path: string | null
  source_name: string | null
  source_object_id: string | null
  evidence_ids: string[]
  entity_ids: string[]
  citation: Record<string, unknown>
  observed_at: string | null
  valid_from: string | null
  valid_to: string | null
  is_current: boolean
  authority: string | null
  score: number
  ranks: { bm25: number | null; knn: number | null; fused: number; rerank?: number }
}

export interface SearchResult {
  query: string
  understood: { entities: LinkedEntity[]; asOf: string | null; preferCurrent: boolean; history: boolean; time: TimeIntent & { anchor_date?: string | null } }
  hits: SearchHit[]
  timings: { understand_ms: number; embed_ms: number; es_ms: number; rerank_ms: number; total_ms: number }
  counts: { bm25: number; knn: number; fused: number }
}

const RRF_K = 60
const dictCache = new Map<string, { at: number; dict: Dictionary }>()
async function dictionary(sql: Sql, tenantId: string) {
  const hit = dictCache.get(tenantId)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.dict
  const dict = await loadDictionary(sql, tenantId)
  dictCache.set(tenantId, { at: Date.now(), dict })
  return dict
}
const slugCache = new Map<string, string>()
async function slugOf(sql: Sql, tenantId: string) {
  if (!slugCache.has(tenantId)) slugCache.set(tenantId, (await sql.query<{ slug: string }>(`select slug from public.tenants where id = $1`, [tenantId])).rows[0].slug)
  return slugCache.get(tenantId)!
}

/** The reader's principals: themselves plus every group they belong to (transitively). */
export async function principalsOf(sql: Sql, tenantId: string, principalId: string): Promise<string[]> {
  return (
    await sql.query<{ id: string }>(
      `with recursive mine (id) as (select $2::uuid union select pm.group_id from public.principal_members pm join mine on pm.member_id = mine.id where pm.tenant_id = $1)
       select id::text from mine`,
      [tenantId, principalId],
    )
  ).rows.map((r) => r.id)
}

/** The client's "today": the date of their latest records (interviews can postdate the machine clock). */
const nowCache = new Map<string, { at: number; now: Date }>()
async function clientNow(sql: Sql, tenantId: string): Promise<Date> {
  const hit = nowCache.get(tenantId)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.now
  const r = (
    await sql.query<{ d: string | null }>(
      `select greatest(now(), (select max(observed_at) from public.evidence where tenant_id = $1 and observed_at < now() + interval '1 year'),
                       (select max(valid_from)::timestamptz from public.facts where tenant_id = $1 and metadata ->> 'layer' = 'canonical' and valid_from < now() + interval '1 year'))::text d`,
      [tenantId],
    )
  ).rows[0]
  const now = r?.d ? new Date(r.d) : new Date()
  nowCache.set(tenantId, { at: Date.now(), now })
  return now
}

/** What the question is about: entities by name/alias, and its time intent. */
export function understand(dict: Dictionary, q: string, asOf?: string, now?: Date) {
  const entities = linkText(dict, q)
  const time = parseTime(q, now)
  const date = asOf ?? time.asOf
  return {
    entities,
    time,
    asOf: date,
    preferCurrent: time.mode === 'current' || (time.mode === 'none' && !date),
    history: time.mode === 'change',
  }
}

export async function search(sql: Sql, tenantId: string, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const t0 = performance.now()
  const limit = Math.min(opts.limit ?? 10, 50)
  const dict = await dictionary(sql, tenantId)
  const u = understand(dict, query, opts.asOf, await clientNow(sql, tenantId))
  const slug0 = await slugOf(sql, tenantId)
  // "before the sale closed": date the event from the company's own dated facts.
  // "before Priya": a person or thing, not an event → a history question (the version before hers).
  let anchorDate: string | null = null
  if (u.time.anchor && !u.asOf) {
    const named = linkText(dict, u.time.anchor.phrase)
    if (named.length && named.every((e) => ['Person', 'Customer Contact'].includes(e.type))) {
      u.history = true
      u.preferCurrent = false
    } else {
      const at = query.toLowerCase().indexOf(u.time.anchor.phrase)
      const original = at >= 0 ? query.slice(at, at + u.time.anchor.phrase.length) : ''
      const names = original.split(/\s+/).filter((w) => /^[A-Z][a-z]{2,}/.test(w))
      const hit = (
        await es().search({
          index: indexAlias(slug0),
          size: 5,
          _source: ['valid_from', 'valid_to', 'title', 'content'],
          // Within what the question is about ("before Tyler took over [the Kroll account]").
          query: {
            bool: {
              filter: [{ term: { doc_type: 'fact' } }, { exists: { field: 'valid_from' } }, ...(u.entities.length ? [{ terms: { entity_ids: u.entities.map((e) => e.id) } }] : [])],
              // Proper names in the anchor ("Tyler") must match; the other words only rank.
              must: names.length ? [{ match: { content: { query: names.join(' '), operator: 'and' } } }] : [{ match: { content: { query: u.time.anchor.phrase, operator: u.entities.length ? 'or' : 'and' } } }],
              should: [{ match: { content: { query: u.time.anchor.phrase } } }],
            },
          },
        })
      ).hits.hits
        .map((h) => h._source as { valid_from?: string; content?: string })
        // The fact whose own statement (first line) names them, not one that merely quotes the name.
        .map((h) => ({ h, named: names.length > 0 && names.every((n) => h.content?.split('\n')[0].includes(n)) }))
        .sort((a, b) => Number(b.named) - Number(a.named))[0]?.h
      if (hit?.valid_from) {
        const d = String(hit.valid_from).slice(0, 10)
        anchorDate = u.time.anchor.relation === 'before' ? new Date(new Date(`${d}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10) : d
        u.asOf = anchorDate
        u.preferCurrent = false
      } else {
        u.history = true
        u.preferCurrent = false
      }
    }
  }
  const t1 = performance.now()

  // ---- filters shared by both legs
  const filter: estypes.QueryDslQueryContainer[] = []
  if (opts.as) filter.push({ terms: { acl_principals: await principalsOf(sql, tenantId, opts.as) } })
  if (opts.docTypes?.length) filter.push({ terms: { doc_type: opts.docTypes } })
  if (opts.kinds?.length) filter.push({ terms: { kind: opts.kinds } })
  if (opts.sourceObjectId) filter.push({ term: { source_object_id: opts.sourceObjectId } })
  if (opts.entityIds?.length) filter.push({ terms: { entity_ids: opts.entityIds } })
  if (opts.asOf) {
    // Facts must be valid on the date; passages must exist by then (undated ones pass).
    filter.push({
      bool: {
        should: [
          { bool: { must_not: [{ exists: { field: 'valid_from' } }, { exists: { field: 'valid_to' } }, { exists: { field: 'observed_at' } }] } },
          {
            bool: {
              filter: [
                { bool: { should: [{ bool: { must_not: { exists: { field: 'valid_from' } } } }, { range: { valid_from: { lte: opts.asOf } } }] } },
                { bool: { should: [{ bool: { must_not: { exists: { field: 'valid_to' } } } }, { range: { valid_to: { gt: opts.asOf } } }] } },
                { bool: { should: [{ bool: { must_not: { exists: { field: 'observed_at' } } } }, { range: { observed_at: { lte: opts.asOf } } }] } },
              ],
            },
          },
        ],
      },
    })
  }

  // ---- BM25: words in content/title, names & aliases of mentioned entities, typos, phrases
  const entityIds = u.entities.map((e) => e.id)
  // Codes (quote numbers, asset tags, invoice numbers) must match exactly: "Q26-1104" ≠ "Q26-1180".
  const codes = query.match(/\b[A-Za-z]{0,6}\d*[-#]?\d{2,}[A-Za-z]?\b/g)?.filter((c) => /\d/.test(c) && c.length >= 4 && !/^(19|20)\d{2}$/.test(c)) ?? []
  const expansion = u.entities.map((e) => e.name).join(' ')
  const bm25: estypes.SearchRequest = {
    size: 60,
    _source: { excludes: ['embedding'] },
    query: {
      // Vocabulary cards are one line long, which BM25 over-rewards: keep them, but lower.
      boosting: { negative: { term: { kind: 'Term' } }, negative_boost: 0.3, positive: {
      bool: {
        filter,
        should: [
          { multi_match: { query, type: 'best_fields', fields: ['title^2', 'content', 'content.exact', 'entity_terms^1.5', 'entity_terms.exact^1.5', 'path^0.5'], tie_breaker: 0.3 } },
          { multi_match: { query, fields: ['title', 'content'], fuzziness: 'AUTO', prefix_length: 1, boost: 0.3 } },
          { match_phrase: { content: { query, slop: 3, boost: 2 } } },
          ...codes.flatMap((c) => [{ match_phrase: { 'content.exact': { query: c, boost: 6 } } }, { match_phrase: { 'title.exact': { query: c, boost: 6 } } }]),
          ...(entityIds.length ? [{ terms: { entity_ids: entityIds, boost: 2.5 } }, { match: { content: { query: expansion, boost: 0.5 } } }] : []),
          ...(u.preferCurrent ? [{ term: { is_current: { value: true, boost: 0.5 } } }] : []),
          ...(u.history ? [{ term: { kind: { value: 'timeline', boost: 3 } } }, { match_phrase: { content: { query: 'Timeline:', boost: 1.5 } } }] : []),
        ],
        minimum_should_match: 1,
      },
      } },
    },
    highlight: { fields: { content: { fragment_size: 220, number_of_fragments: 2 } }, pre_tags: ['«'], post_tags: ['»'] },
  }

  const slug = await slugOf(sql, tenantId)
  const te0 = performance.now()
  const vector = opts.only === 'bm25' ? null : await embedQuery(expansion ? `${query} (${expansion})` : query)
  const te1 = performance.now()
  const [lex, sem] = await Promise.all([
    // Same shard copies for every query of a tenant: approximate kNN differs between replicas.
    opts.only === 'knn' ? null : es().search({ index: indexAlias(slug), preference: `cb-${slug}`, ...bm25 }),
    vector
      ? es().search({
          index: indexAlias(slug),
          preference: `cb-${slug}`,
          size: 60,
          _source: { excludes: ['embedding'] },
          knn: { field: 'embedding', query_vector: vector, k: 60, num_candidates: 400, filter },
        })
      : null,
  ])
  const te2 = performance.now()

  // ---- Reciprocal Rank Fusion: score = Σ 1 / (60 + rank) over the legs a doc appears in
  type Src = Record<string, unknown>
  const fused = new Map<string, { src: Src; bm25: number | null; knn: number | null; score: number; highlight?: string[] }>()
  lex?.hits.hits.forEach((h, i) => {
    fused.set(h._id!, { src: h._source as Src, bm25: i + 1, knn: null, score: 1 / (RRF_K + i + 1), highlight: h.highlight?.content })
  })
  sem?.hits.hits.forEach((h, i) => {
    const cur = fused.get(h._id!)
    if (cur) {
      cur.knn = i + 1
      cur.score += 1 / (RRF_K + i + 1)
    } else fused.set(h._id!, { src: h._source as Src, bm25: null, knn: i + 1, score: 1 / (RRF_K + i + 1) })
  })
  let ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score)

  // ---- collapse copies of the same message, then cap results per file
  const seen = new Set<string>()
  const perFile = new Map<string, number>()
  const cap = opts.perSource ?? 3
  ranked = ranked.filter(([, v]) => {
    const key = v.src.dedupe_key as string | null
    if (key) {
      if (seen.has(key)) return false
      seen.add(key)
    }
    const so = v.src.source_object_id as string | null
    if (so) {
      const n = (perFile.get(so) ?? 0) + 1
      perFile.set(so, n)
      if (n > cap) return false
    }
    return true
  })

  // The reranker sees the fused head plus each leg's own top 20: a document one leg ranks first
  // but the other missed (approximate kNN, a keyword-only match) still gets judged.
  const pool = opts.rerank
    ? ranked.filter(([, v], i) => i < Math.max(40, limit * 3) || (v.bm25 !== null && v.bm25 <= 20) || (v.knn !== null && v.knn <= 20))
    : ranked.slice(0, Math.max(40, limit * 3))
  let hits: SearchHit[] = pool.map(([id, v]) => toHit(id, v.src, v.highlight, query, { bm25: v.bm25, knn: v.knn, fused: ranked.findIndex(([x]) => x === id) + 1 }, v.score))

  // ---- optional cross-encoder rerank of the head of the list
  let rerankMs = 0
  if (opts.rerank && hits.length) {
    const r0 = performance.now()
    // The cross-encoder doesn't know nicknames: "Big Blue payment terms" scores low against
    // "Blue Ridge Food Processing LLC · payment terms". It reads the question with the real name
    // added next to the nickname ("Big Blue (Blue Ridge Food Processing LLC)"), so questions about
    // the old name itself still read right.
    let named = query
    for (const e of u.entities)
      if (e.type !== 'Term' && e.matched && !named.toLowerCase().includes(e.name.toLowerCase()))
        named = named.replace(new RegExp(e.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), (m) => `${m} (${e.name})`)
    const scores = await rerankScores(named, hits.map((h) => `${h.title}\n${h.content}`))
    hits = hits
      .map((h, i) => ({ ...h, ranks: { ...h.ranks, rerank: scores[i] }, score: scores[i] }))
      .sort((a, b) => b.score - a.score)
    rerankMs = performance.now() - r0
  }

  // ---- time: the right era first (applied last, so neither fusion nor the reranker can undo it)
  const factor = (h: SearchHit) => {
    if (u.asOf) {
      if (!h.valid_from && !h.valid_to) {
        // Undated passages: written well after the asked date → probably about a later state.
        if (!h.observed_at) return 1
        const seen = String(h.observed_at).slice(0, 10)
        const days = (new Date(`${seen}T12:00:00Z`).getTime() - new Date(`${u.asOf}T12:00:00Z`).getTime()) / 86_400_000
        return days > 120 ? 0.8 : days > -365 ? 1.1 : 1
      }
      // End dates count as the last valid day (some sources say "until Jun 7", others give the next start).
      const ok = (!h.valid_from || h.valid_from <= u.asOf) && (!h.valid_to || h.valid_to >= u.asOf)
      return ok ? 1.6 : 0.45
    }
    if (u.history) {
      if (h.kind === 'timeline' || h.content.includes('\nTimeline: ')) return 1.6
      // Single dated events (a rename, a switch) answer "when did…" too.
      return h.doc_type === 'fact' && h.valid_from ? 1.3 : 1
    }
    if (h.doc_type !== 'fact') return 1
    // Asked about "now": current facts up, replaced ones well down.
    if (u.time.mode === 'current') return h.is_current ? 1.25 : 0.4
    // No time in the question: don't favour facts over documents; only push replaced versions down.
    return h.is_current ? 1 : 0.6
  }
  hits = hits
    .map((h, i) => ({ h, s: (1 / (RRF_K + i + 1)) * factor(h) }))
    .sort((a, b) => b.s - a.s)
    .map(({ h }) => h)
  // Mixed results: when cards (facts, records) would fill the page, keep ~30% of the slots for the
  // best documents, answers need something to quote, and a card is only as good as its sources.
  if (!opts.docTypes?.length && limit >= 5) {
    const want = Math.ceil(limit * 0.3)
    const head = hits.slice(0, limit)
    const have = head.filter((h) => h.doc_type === 'passage').length
    if (have < want) {
      const extra = hits.slice(limit).filter((h) => h.doc_type === 'passage').slice(0, want - have)
      if (extra.length) {
        // Replace the lowest-ranked cards, keeping everyone else in order.
        const drop = new Set(head.filter((h) => h.doc_type !== 'passage').slice(-extra.length))
        hits = [...head.filter((h) => !drop.has(h)), ...extra, ...head.filter((h) => drop.has(h)), ...hits.slice(limit).filter((h) => !extra.includes(h))]
      }
    }
  }
  hits = hits.slice(0, limit)

  const t2 = performance.now()
  return {
    query,
    understood: { entities: u.entities, asOf: u.asOf, preferCurrent: u.preferCurrent, history: u.history, time: { ...u.time, anchor_date: anchorDate } },
    hits,
    timings: { understand_ms: Math.round(t1 - t0), embed_ms: Math.round(te1 - te0), es_ms: Math.round(te2 - te1), rerank_ms: Math.round(rerankMs), total_ms: Math.round(t2 - t0) },
    counts: { bm25: lex?.hits.hits.length ?? 0, knn: sem?.hits.hits.length ?? 0, fused: fused.size },
  }
}

function toHit(id: string, s: Record<string, unknown>, highlight: string[] | undefined, query: string, ranks: SearchHit['ranks'], score: number): SearchHit {
  const content = String(s.content ?? '')
  return {
    id,
    doc_type: s.doc_type as SearchHit['doc_type'],
    kind: String(s.kind),
    title: String(s.title),
    snippet: highlight?.join(' … ') ?? bestWindow(content, query),
    content,
    path: (s.path as string) ?? null,
    source_name: (s.source_name as string) ?? null,
    source_object_id: (s.source_object_id as string) ?? null,
    evidence_ids: [],
    entity_ids: (s.entity_ids as string[]) ?? [],
    citation: (s.citation as Record<string, unknown>) ?? {},
    observed_at: (s.observed_at as string) ?? null,
    valid_from: s.valid_from ? String(s.valid_from).slice(0, 10) : null,
    valid_to: s.valid_to ? String(s.valid_to).slice(0, 10) : null,
    is_current: s.is_current !== false,
    authority: (s.authority as string) ?? null,
    score,
    ranks,
  }
}

/** A 260-char window around the densest cluster of query words (for hits with no highlight). */
function bestWindow(text: string, q: string): string {
  const words = q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  if (!words.length || text.length <= 260) return text.slice(0, 260)
  const lower = text.toLowerCase()
  let best = 0
  let bestAt = 0
  for (let i = 0; i < lower.length; i += 40) {
    const win = lower.slice(i, i + 260)
    const n = words.filter((w) => win.includes(w)).length
    if (n > best) (best = n), (bestAt = i)
  }
  return `${bestAt ? '…' : ''}${text.slice(bestAt, bestAt + 260)}${bestAt + 260 < text.length ? '…' : ''}`
}
