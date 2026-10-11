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
import { type KnowledgeView, viewAliases, viewContent } from '../access/knowledge-view'
import { embedQuery, rerankScores } from './embed'
import { baseId } from './readers'
import { rewriteQuestion, splitQuestion } from './rewrite'
import { activeVersion, es, indexAlias } from './es'
import { type Dictionary, type LinkedEntity, linkText, loadDictionary, normalize } from './linker'
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
  /** Only what was known by a cutoff (evaluation, "as the Brain stood on…"): enforced in the query like access. */
  view?: KnowledgeView
  /** The question's "today" (YYYY-MM-DD); default: the client's latest dated evidence. */
  today?: string
  /** Rewrite the question into the documents' words first (search/rewrite.ts; uses the answer API). */
  rewrite?: boolean
  /** A question asking for several things is searched part by part as well (splitParts). Default: as rewrite. */
  decompose?: boolean
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
  understood: { entities: LinkedEntity[]; asOf: string | null; preferCurrent: boolean; history: boolean; time: TimeIntent & { anchor_date?: string | null }; rewrite?: string | null; parts?: string[] }
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

/** Meaning-search depth: how many neighbours Elasticsearch returns, from how many it examines. */
const KNN_K = Number(process.env.CB_KNN_K ?? 100)
const KNN_CANDIDATES = Number(process.env.CB_KNN_CANDIDATES ?? 1000)
/** How deep into each leg (keyword, meaning) the reranker looks, beyond the fused head. */
const LEG_POOL = Number(process.env.CB_LEG_POOL ?? 20)
/** How much of the fused list the reranker judges (plus each leg's top LEG_POOL). */
const RERANK_HEAD = 40

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

/**
 * The evidence (of those given) a reader can actually open: evidence counts only through a
 * passage that holds it and that the reader may see (and, under a knowledge view, that existed).
 */
export async function readableEvidence(sql: Sql, tenantId: string, principalId: string | null, evidenceIds: string[], view?: KnowledgeView): Promise<Set<string>> {
  if (!evidenceIds.length) return new Set()
  const principals = principalId ? await principalsOf(sql, tenantId, principalId) : null
  const rows = (
    await sql.query<{ id: string; evidence_ids: string[]; so: string | null }>(
      `select d.id, d.evidence_ids, d.source_object_id so from public.search_documents d
       where d.tenant_id = $1 and d.doc_type = 'passage' and d.evidence_ids && $2::uuid[]
         and ($3::uuid[] is null or exists (select 1 from public.acl_entries ae where ae.acl_id = any(d.acl_ids) and ae.principal_id = any($3::uuid[])))`,
      [tenantId, evidenceIds, principals],
    )
  ).rows
  const out = new Set<string>()
  const want = new Set(evidenceIds)
  for (const r of rows) {
    if (view && (view.hiddenDocs.has(r.id) || (r.so && view.hiddenObjects.has(r.so)))) continue
    for (const e of r.evidence_ids) if (want.has(e)) out.add(e)
  }
  return out
}

/**
 * For facts a reader can see only partly (some evidence restricted for them): which to show as a
 * bare statement (partial) and which to hide (hidden) because nothing they can open actually says the
 * value: it may come from the restricted part alone ("bonus: $30k" from a restricted email).
 */
export async function factsForReader(sql: Sql, tenantId: string, principalId: string, factDocIds: string[], view?: KnowledgeView): Promise<{ partial: Set<string>; hidden: Set<string> }> {
  const partial = new Set<string>()
  const hidden = new Set<string>()
  if (!factDocIds.length) return { partial, hidden }
  const ev = (
    await sql.query<{ id: string; content: string; evidence_ids: string[] }>(`select id, content, evidence_ids from public.search_documents where tenant_id = $1 and id = any($2::text[])`, [tenantId, factDocIds])
  ).rows
  const readable = await readableEvidence(sql, tenantId, principalId, [...new Set(ev.flatMap((r) => r.evidence_ids))], view)
  const part = ev.filter((r) => r.evidence_ids.some((e) => !readable.has(e)))
  const openIds = part.flatMap((r) => r.evidence_ids.filter((e) => readable.has(e)))
  const text = new Map<string, string>()
  if (openIds.length) for (const e of (await sql.query<{ id: string; content: string }>(`select id, content from public.evidence where id = any($1::uuid[])`, [openIds])).rows) text.set(e.id, e.content.toLowerCase())
  for (const r of part) (saysValue(r.content.split('\n')[0].split(': ').slice(1).join(': '), r.evidence_ids.map((e) => text.get(e) ?? '').join('\n')) ? partial : hidden).add(r.id)
  return { partial, hidden }
}

/** Does this text (lowercase) say the value: every number in it, and most of its words? */
export function saysValue(value: string, open: string): boolean {
  const words = [...new Set(value.toLowerCase().match(/[a-z0-9$%.,]{3,}/g)?.map((w) => w.replace(/[.,]+$/, '')) ?? [])]
  return !words.length || (words.filter((w) => /\d/.test(w)).every((n) => open.includes(n)) && words.filter((w) => open.includes(w)).length / words.length >= 0.6)
}

/** One rewrite per question for a minute: an answer runs a few searches for the same question. */
const rewrites = new Map<string, { at: number; text: Promise<string | null> }>()
function cachedRewrite(sql: Sql, tenantId: string, dict: Dictionary, q: string) {
  const key = `${tenantId}:${q}`
  const hit = rewrites.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.text
  const text = rewriteQuestion(sql, tenantId, dict, q)
  rewrites.set(key, { at: Date.now(), text })
  if (rewrites.size > 500) for (const [k, v] of rewrites) if (Date.now() - v.at > 60_000) rewrites.delete(k)
  return text
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

/**
 * The separate questions in a compound one, by its clauses: a second question ("…? And who…?"), or
 * "…and what/who/when/how…". Parts that lose their subject ("…and what are their terms?") get the
 * names the whole question mentions. One part: not compound.
 */
export function splitParts(dict: Dictionary, q: string): string[] {
  const parts = q
    .split(/\?\s+(?=\S)|;\s+|,?\s+(?:and|also|plus|then)\s+(?=(?:what|who|whom|whose|when|where|why|how|which|is|are|was|were|does|did|do|can|could|should|has|have)\b)/i)
    .map((p) => p.trim().replace(/\?$/, ''))
    .filter((p) => p.split(/\s+/).length >= 3)
  if (parts.length < 2) return [q]
  const names = linkText(dict, q).filter((e) => e.type !== 'Term')
  return parts.slice(0, 3).map((p) => {
    const missing = names.filter((e) => !p.toLowerCase().includes(e.matched.toLowerCase())).map((e) => e.matched)
    return `${p}${missing.length ? ` (${[...new Set(missing)].join(', ')})` : ''}?`
  })
}
const splits = new Map<string, { at: number; parts: Promise<string[] | null> }>()

/** Searches a compound question as a whole and part by part, taking turns between the lists. */
async function searchParts(sql: Sql, tenantId: string, query: string, opts: SearchOptions): Promise<SearchResult> {
  const dict = await dictionary(sql, tenantId)
  let parts = splitParts(dict, query)
  // Not split by its wording but naming several things or asking "and": the model splits it.
  if (parts.length < 2 && opts.rewrite && (/\band\b/i.test(query) || linkText(dict, query).filter((e) => e.type !== 'Term').length >= 2)) {
    const key = `${tenantId}:${query}`
    if (!splits.has(key) || Date.now() - splits.get(key)!.at > 60_000) splits.set(key, { at: Date.now(), parts: splitQuestion(sql, tenantId, dict, query) })
    parts = (await splits.get(key)!.parts) ?? [query]
  }
  const whole = search(sql, tenantId, query, { ...opts, decompose: false })
  if (parts.length < 2) return whole
  const lists = await Promise.all([whole, ...parts.map((p) => search(sql, tenantId, p, { ...opts, decompose: false, limit: 15 }))])
  const limit = Math.min(opts.limit ?? 10, 50)
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (let i = 0; hits.length < limit && lists.some((l) => l.hits.length > i); i++)
    for (const l of lists) {
      const h = l.hits[i]
      if (!h || seen.has(baseId(h.id))) continue
      seen.add(baseId(h.id))
      hits.push(h)
    }
  return { ...lists[0], hits: hits.slice(0, limit), understood: { ...lists[0].understood, parts } }
}

export async function search(sql: Sql, tenantId: string, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  // Compound questions are split wherever questions are rewritten (the product paths), unless told not to.
  if (opts.decompose ?? opts.rewrite) return searchParts(sql, tenantId, query, opts)
  const t0 = performance.now()
  const limit = Math.min(opts.limit ?? 10, 50)
  const dict = await dictionary(sql, tenantId)
  const now = opts.today ? new Date(`${opts.today}T12:00:00Z`) : await clientNow(sql, tenantId)
  const u = understand(dict, query, opts.asOf, now)
  // "today" is a question about now: replaced versions are out even when nobody recorded when they ended.
  if (u.asOf && !opts.asOf && u.asOf >= now.toISOString().slice(0, 10)) {
    u.asOf = null
    u.preferCurrent = true
    u.time = { ...u.time, mode: 'current' }
  }
  // Rewritten into the documents' words (opt-in): time and names were read from the original above;
  // keyword search, meaning search and the reranker use the original plus the rewrite.
  const rewritten = opts.rewrite ? await cachedRewrite(sql, tenantId, dict, query) : null
  if (rewritten) query = `${query}\n${rewritten}`
  // A view only resolves names it could have known (not a nickname first heard in a later interview).
  if (opts.view) {
    const view = opts.view
    u.entities = u.entities.filter((e) => !view.hiddenDocs.has(`e:${e.id}`) && (normalize(e.matched) === normalize(e.name) || !view.hiddenAliases.has(normalize(e.matched))))
  }
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
  if (opts.view) filter.push({ bool: { must_not: [{ terms: { source_object_id: [...opts.view.hiddenObjects] } }, { ids: { values: [...opts.view.hiddenDocs] } }] } })
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
  // One hit per card or message: variants of a card (split by reader group) and copies of a message
  // share a key, and would otherwise take several of each leg's places.
  const collapse = { field: 'dedupe_key' }
  const bm25: estypes.SearchRequest = {
    size: 60,
    collapse,
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
  // Embedded with the model of the index version the alias points to.
  const vector = opts.only === 'bm25' ? null : await embedQuery(expansion ? `${query} (${expansion})` : query, await activeVersion(slug))
  const te1 = performance.now()
  const [lex, sem] = await Promise.all([
    // Same shard copies for every query of a tenant: approximate kNN differs between replicas.
    opts.only === 'knn' ? null : es().search({ index: indexAlias(slug), preference: `cb-${slug}`, ...bm25 }),
    vector
      ? es().search({
          index: indexAlias(slug),
          preference: `cb-${slug}`,
          size: 60,
          collapse,
          _source: { excludes: ['embedding'] },
          knn: { field: 'embedding', query_vector: vector, k: KNN_K, num_candidates: KNN_CANDIDATES, filter },
        })
      : null,
  ])
  const te2 = performance.now()

  // ---- Reciprocal Rank Fusion: score = Σ 1 / (60 + rank) over the legs a doc appears in. Fused per
  // card or message (the two legs may return different variants or copies of it); the fuller variant
  // is the one kept.
  type Src = Record<string, unknown>
  const fused = new Map<string, { id: string; src: Src; bm25: number | null; knn: number | null; score: number; highlight?: string[] }>()
  const keyOf = (h: estypes.SearchHit<unknown>) => ((h._source as Src).dedupe_key as string | null) ?? h._id!
  lex?.hits.hits.forEach((h, i) => {
    fused.set(keyOf(h), { id: h._id!, src: h._source as Src, bm25: i + 1, knn: null, score: 1 / (RRF_K + i + 1), highlight: h.highlight?.content })
  })
  sem?.hits.hits.forEach((h, i) => {
    const cur = fused.get(keyOf(h))
    if (cur) {
      cur.knn = i + 1
      cur.score += 1 / (RRF_K + i + 1)
      if (String((h._source as Src).content ?? '').length > String(cur.src.content ?? '').length) Object.assign(cur, { id: h._id!, src: h._source as Src })
    } else fused.set(keyOf(h), { id: h._id!, src: h._source as Src, bm25: null, knn: i + 1, score: 1 / (RRF_K + i + 1) })
  })
  let ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score)

  // ---- cap results per file
  const perFile = new Map<string, number>()
  const cap = opts.perSource ?? 3
  ranked = ranked.filter(([, v]) => {
    const so = v.src.source_object_id as string | null
    if (so) {
      const n = (perFile.get(so) ?? 0) + 1
      perFile.set(so, n)
      if (n > cap) return false
    }
    return true
  })

  // The reranker sees the fused head plus each leg's own top LEG_POOL (30): a document one leg ranks first
  // but the other missed (approximate kNN, a keyword-only match) still gets judged.
  const pool = opts.rerank
    ? // A fixed shortlist however many results are asked for: the reranker is the slow step (CPU).
      ranked.filter(([, v], i) => i < RERANK_HEAD || (v.bm25 !== null && v.bm25 <= LEG_POOL) || (v.knn !== null && v.knn <= LEG_POOL))
    : ranked.slice(0, Math.max(40, limit * 3))
  let hits: SearchHit[] = pool.map(([key, v]) => toHit(v.id, v.src, v.highlight, query, { bm25: v.bm25, knn: v.knn, fused: ranked.findIndex(([x]) => x === key) + 1 }, v.score))
  // A reader sees a fact through evidence they can open; if what they can open doesn't say the value,
  // it is hidden (the value may come from the restricted part alone). Quotes, notes and history are
  // already limited to what the reader may open (cards are split by reader group, project.ts).
  if (opts.as) {
    const facts = hits.filter((h) => h.doc_type === 'fact' && h.kind !== 'timeline')
    const { hidden } = await factsForReader(sql, tenantId, opts.as, facts.map((h) => h.id), opts.view)
    hits = hits.filter((h) => !hidden.has(h.id))
  }
  // As known by the view's cutoff: whether a fact was current then, and its history as far as it went.
  if (opts.view) {
    const view = opts.view
    hits = hits.map((h) =>
      h.doc_type === 'fact' && view.facts.has(h.id) ? { ...h, is_current: view.facts.get(h.id)!.is_current, content: viewContent(view, h.id, h.content) } : h.doc_type === 'entity' ? { ...h, content: viewAliases(view, h.content) } : h,
    )
  }

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

  // ---- outdated sources: a passage whose facts have all been replaced (as far as was known by the
  // view's cutoff) is an old version of something, unless the question asks about the past.
  const outdated = new Set<string>()
  const replacedFacts = new Set<string>()
  if (!u.asOf && !u.history) {
    const supported = [...new Set(hits.flatMap((h) => (h.doc_type === 'passage' ? ((h.citation.facts as string[] | undefined) ?? []) : [])))]
    const current = new Map<string, boolean>()
    const titles = new Map<string, string>()
    if (supported.length)
      for (const r of (
        await sql.query<{ id: string; cur: boolean; title: string }>(`select citation ->> 'fact_id' id, is_current cur, title from public.search_documents where tenant_id = $1 and id = any($2::text[])`, [
          tenantId,
          supported.map((f) => `f:${f}`),
        ])
      ).rows) {
        titles.set(r.id, r.title)
        if (!opts.view) current.set(r.id, r.cur)
      }
    if (opts.view)
      for (const f of supported) {
        const v = opts.view.facts.get(`f:${f}`)
        if (v) current.set(f, v.is_current)
      }
    // Outdated only next to its replacement: an old version that is the only source for something
    // (a procedure the new revision dropped) stays where it ranks.
    const files = new Set(hits.map((h) => h.source_object_id).filter(Boolean))
    const currentFactTitles = new Set(hits.filter((h) => h.doc_type === 'fact' && h.is_current).map((h) => h.title))
    for (const h of hits) {
      if (h.doc_type !== 'passage') continue
      const fs = ((h.citation.facts as string[] | undefined) ?? []).filter((f) => current.has(f))
      if (fs.length && fs.every((f) => !current.get(f)) && fs.some((f) => currentFactTitles.has(titles.get(f) ?? ''))) outdated.add(h.id)
      // An older version of a document, when a newer one (known by the view's cutoff) is in the results.
      const newer = ((h.citation.replaced_by as string[] | undefined) ?? []).filter((so) => !opts.view?.hiddenObjects.has(so))
      if (newer.some((so) => files.has(so))) outdated.add(h.id)
    }
    // A replaced fact whose current version is in the results adds nothing but confusion.
    const currentTitles = new Set(hits.filter((h) => h.doc_type === 'fact' && h.is_current).map((h) => h.title))
    for (const h of hits) if (h.doc_type === 'fact' && h.kind !== 'timeline' && !h.is_current && currentTitles.has(h.title)) replacedFacts.add(h.id)
    hits = hits.filter((h) => !replacedFacts.has(h.id))
  }

  // ---- the kind of source asked for: "what did Linda email…" wants the email; "what did Dave say…"
  // wants his words (an email or a recording) more than a card summarising them.
  const asksEmail = /\b(e-?mail(s|ed)?|wrote|written to|sent|replied|reply|forwarded|cc'?d|inbox|thread)\b/i.test(query.split('\n')[0])
  const asksWords = asksEmail || /\b(say|said|says|told|tell|mention(ed)?|according to|in (his|her|their) words)\b/i.test(query.split('\n')[0])
  const kindFactor = (h: SearchHit) => (asksEmail && h.kind === 'email_body' ? 1.5 : asksWords && h.doc_type === 'passage' && /email_body|transcript_segment|video_segment/.test(h.kind) ? 1.25 : 1)

  // ---- time: the right era first (applied last, so neither fusion nor the reranker can undo it)
  const factor = (h: SearchHit) => kindFactor(h) * timeFactor(h)
  const timeFactor = (h: SearchHit) => {
    if (outdated.has(h.id)) return 0.3
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
    understood: { entities: u.entities, asOf: u.asOf, preferCurrent: u.preferCurrent, history: u.history, time: { ...u.time, anchor_date: anchorDate }, rewrite: rewritten },
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
