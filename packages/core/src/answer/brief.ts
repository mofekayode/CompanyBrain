// A brief answer without a language model: the best fact for the question (in the era the
// question asks about), its history ("it was X until …"), a few supporting facts, and the
// files they come from, all as numbered sources, all through the asker's access.
//
// This is what the client app shows when the Claude API is off, and the skeleton of what
// the model writes from when it is on. When the asker can't see what would answer the
// question, it says so (and which kind of files matched) instead of guessing.

import { search, type SearchHit, type SearchResult } from '../search/search'
import { fieldLabel, humanDate, tidy } from '../text'
import { citeLabel, factLabel, type ToolCtx, visible } from './tools'

export interface BriefSource {
  n: number
  id: string
  title: string
  where: string
  /** document | system | email | video | interview | spreadsheet | photo | fact */
  kind: string
  status: 'current' | 'outdated' | 'disputed' | 'supporting'
  file_id: string | null
  start_ms: number | null
  quote: string | null
}
export interface BriefAnswer {
  question: string
  headline: string | null
  detail: string | null
  /** Oldest → newest; the last is in force (unless the question is about the past). */
  timeline: { value: string; when: string; current: boolean }[] | null
  /** "Changed since: …", said whenever the answer has a history. */
  changed: string | null
  also: { text: string; status: BriefSource['status']; cites: number[] }[]
  time: { mode: string; reading: string; as_of: string | null } | null
  entities: { id: string; name: string; type: string }[]
  sources: BriefSource[]
  /** Matches in files this person can't open (names of the access scopes only). */
  restricted: { count: number; scopes: string[]; best_is_locked: boolean } | null
  /** Sources that disagree with each other on this (disputed facts). */
  conflicts: string[]
  /** How well the record answers: a reviewed fact (strong), only passages (partial), or barely (weak). */
  evidence: 'strong' | 'partial' | 'weak'
  ms: number
}

/** A step the answer really goes through, reported as it happens (for progress UIs). */
export interface BriefStep {
  id: 'search' | 'fact' | 'history' | 'files' | 'access' | 'write'
  label: string
  status: 'active' | 'done'
  detail?: string
}
export interface BriefProgress {
  onStep?: (s: BriefStep) => void
  /** The reader's search result, so a written answer can reuse it instead of searching again. */
  onSearch?: (r: SearchResult) => void
  /** The answer so far (headline, history), sent before sources and access checks finish. */
  onPartial?: (p: Pick<BriefAnswer, 'question' | 'headline' | 'detail' | 'timeline' | 'changed' | 'time' | 'entities'>) => void
}

const KIND: Record<string, string> = {
  email_body: 'email',
  transcript_segment: 'interview',
  video_segment: 'video',
  image: 'photo',
  table: 'spreadsheet',
  text: 'document',
  ocr: 'document',
}

/** "Blue Ridge Food Processing LLC (Customer) · payment terms: Net 60" → "Blue Ridge Food Processing LLC · payment terms: Net 60" (older cards used a long dash). */
const statement = (content: string) =>
  tidy(content.split('\n')[0].replace(/ \([A-Z][A-Za-z ]+\) [-·] /, ' · ').replace(/ · ([a-z][a-z_ ]*):/, (_m, f: string) => ` · ${fieldLabel(f)}:`))
const sentence = (content: string) => {
  const l = content.split('\n')[1] ?? ''
  return l && !/^(Valid|Status|Timeline|Review note|“)/.test(l) ? tidy(l) : null
}
const statusOf = (h: SearchHit): BriefSource['status'] =>
  h.doc_type !== 'fact' ? 'supporting' : h.citation.status === 'disputed' ? 'disputed' : h.is_current ? 'current' : 'outdated'

function timelineOf(h: SearchHit, asOf: string | null) {
  const line = h.content.split('\n').find((l) => l.startsWith('Timeline: '))
  if (!line) return null
  const steps = line
    .slice(10)
    .split(' → ')
    .map((p) => {
      const m = p.match(/^(.*) \(([^()]*)\)$/)
      return m ? { value: tidy(m[1]), when: m[2] } : { value: tidy(p), when: '' }
    })
  if (steps.length < 2) return null
  // The highlighted step: the one in force at the question's date, else the latest.
  const lead = statement(h.content).split(': ').slice(1).join(': ')
  const at = asOf ? steps.findIndex((s) => lead.startsWith(s.value.slice(0, 40))) : -1
  const cur = at >= 0 ? at : steps.length - 1
  return steps.map((s, i) => ({ ...s, current: i === cur }))
}

export async function briefAnswer(ctx: ToolCtx, question: string, progress: BriefProgress = {}): Promise<BriefAnswer> {
  const t0 = performance.now()
  const step = (id: BriefStep['id'], label: string, status: BriefStep['status'], detail?: string) => progress.onStep?.({ id, label, status, detail })
  step('search', 'Looking across documents, email, interviews and records', 'active')
  // With a reader, the full-access search (for "N more matches are locked") runs alongside theirs.
  const known = { view: ctx.view, today: ctx.today, rewrite: ctx.rewrite }
  const fullAccess = ctx.as ? search(ctx.sql, ctx.tenantId, question, { limit: 12, rerank: true, ...known }) : null
  const r = await search(ctx.sql, ctx.tenantId, question, { as: ctx.as, limit: 12, rerank: true, ...known })
  progress.onSearch?.(r)
  {
    const ents = r.understood.entities.filter((e) => e.type !== 'Term')
    const bits = [
      `${r.hits.length} matches`,
      ents.length ? `about ${ents.map((e) => e.name).slice(0, 3).join(', ')}` : '',
      r.understood.time && r.understood.time.mode !== 'none' ? `time: ${r.understood.time.reading}` : '',
    ].filter(Boolean)
    step('search', 'Looking across documents, email, interviews and records', 'done', bits.join(' · '))
  }
  const asOf = r.understood.time?.mode === 'as_of' ? (r.understood.asOf ?? null) : null
  // Topic timeline cards ("history across N records") support the answer; they never lead it.
  const allFacts = r.hits.filter((h) => h.doc_type === 'fact' && h.kind !== 'timeline')
  // A fact only answers when it's about what was asked: its subject is something the question
  // names, or its label ("discount approval authority") shares a real word with the question.
  // Otherwise it's merely on topic ("Sarah Okafor · role" for "when does the Northgate deal close?").
  const named = new Set(r.understood.entities.map((e) => e.id))
  const stem = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)
  const STOP = new Set(['what', 'when', 'where', 'which', 'whose', 'there', 'their', 'about', 'does', 'have', 'this', 'that', 'with', 'from', 'were', 'will', 'would', 'should', 'could', 'today', 'right', 'still', 'company', 'riverton'])
  const asked = new Set(question.split(/\s+/).filter((w) => w.replace(/[^a-z0-9]/gi, '').length >= 4 && !STOP.has(w.toLowerCase().replace(/[^a-z]/g, ''))).map(stem))
  const answers = (f: SearchHit) => f.entity_ids.some((id) => named.has(id)) || f.title.split(/[\s:_·]+/).some((w) => w.length >= 4 && asked.has(stem(w)))
  // Among close candidates, the fact whose label covers more of the question leads: "payment terms"
  // over "payment pattern" for "What are Big Blue payment terms?", "credit hold" over "payment plan".
  // Names the question already resolved ("Harmon") don't count: they say who, not what.
  const nameStems = new Set(r.understood.entities.filter((e) => e.type !== 'Term').flatMap((e) => `${e.name} ${e.matched}`.split(/\s+/)).map(stem))
  const overlap = (f: SearchHit) => new Set((f.title.split(': ').slice(1).join(' ') || f.title).split(/[\s:_·]+/).filter((w) => w.length >= 4).map(stem).filter((w) => asked.has(w) && !nameStems.has(w))).size
  const relevant = allFacts.filter(answers)
  const best = Math.max(0, ...relevant.slice(0, 6).map(overlap))
  const facts = [...relevant.filter((f, i) => i < 6 && overlap(f) === best), ...relevant.filter((f, i) => !(i < 6 && overlap(f) === best))]
  const passages = r.hits.filter((h) => h.doc_type === 'passage')

  // Lead: the top fact, but for "now" questions prefer a fact in force among the top three.
  // "Now": the newest rule in force among the top few (a rule that changed beats a static one).
  // "In March 2025": a fact whose dated period covers that day beats an undated one.
  const mode = r.understood.time?.mode
  const wantsNow = !asOf && mode !== 'change'
  // "Newest in force wins" only compares facts that answer equally well (same label overlap).
  const top = best > 0 ? facts.slice(0, 4).filter((f) => overlap(f) === best) : facts.slice(0, 4)
  const day = (d: string | null) => (d ? d.slice(0, 10) : null)
  let lead: SearchHit | null = null
  if (asOf) lead = top.find((f) => day(f.valid_from) && day(f.valid_from)! <= asOf && (!f.valid_to || day(f.valid_to)! >= asOf)) ?? null
  else if (mode === 'current')
  {
    // Only among facts that answer about as well as the best one (cross-encoder score within 2.5).
    const best = top[0]?.ranks.rerank ?? 0
    lead = top
      .filter((f) => f.is_current && f.citation.status !== 'disputed' && f.valid_from && (f.ranks.rerank === undefined || f.ranks.rerank >= best - 2.5))
      .sort((a, b) => day(b.valid_from)!.localeCompare(day(a.valid_from)!))[0] ?? null
  }
  if (!lead && wantsNow) lead = facts.slice(0, 3).find((f) => f.is_current && f.citation.status !== 'disputed') ?? null
  lead ??= facts[0] ?? null
  // A fact only headlines when the cross-encoder says it actually answers (ms-marco scores:
  // relevant ≳ 2, unrelated < 0). Otherwise the answer says where the topic appears instead.
  if (lead && lead.ranks.rerank !== undefined && lead.ranks.rerank < 0.5) lead = null
  step('fact', 'Choosing the reviewed fact that answers it', 'done', lead ? statement(lead.content).slice(0, 90) : 'No single reviewed fact answers this')

  const sources: BriefSource[] = []
  const seen = new Map<string, number>()
  const add = (s: Omit<BriefSource, 'n'>) => {
    const have = seen.get(s.id)
    if (have) return have
    const n = sources.length + 1
    sources.push({ ...s, n })
    seen.set(s.id, n)
    return n
  }

  // The files behind a fact: passages holding its evidence, that this person can read.
  const filesFor = async (h: SearchHit) => {
    const rows = (
      await ctx.sql.query<{ id: string; title: string; kind: string; path: string | null; citation: Record<string, unknown>; source_object_id: string | null }>(
        `select p.id, p.title, p.kind, so.original_path path, p.citation, p.source_object_id
         from public.search_documents f join public.search_documents p on p.tenant_id = f.tenant_id and p.doc_type = 'passage' and p.evidence_ids && f.evidence_ids
         left join public.source_objects so on so.id = p.source_object_id
         where f.tenant_id = $1 and f.id = $2 limit 4`,
        [ctx.tenantId, h.id],
      )
    ).rows
    const ok = await visible(ctx, rows.map((x) => x.id))
    return rows.filter((x) => ok.has(x.id))
  }
  // Fetch every candidate fact's files at once (Supabase round trips add up), number them in order after.
  const fileCache = new Map<string, Promise<Awaited<ReturnType<typeof filesFor>>>>()
  const filesOf = (h: SearchHit) => {
    if (!fileCache.has(h.id)) fileCache.set(h.id, filesFor(h))
    return fileCache.get(h.id)!
  }
  const prefetch = (hs: (SearchHit | null)[]) => hs.forEach((h) => h && filesOf(h))
  const factSource = async (h: SearchHit) => {
    const quote = h.content.split('\n').find((l) => l.startsWith('“'))?.replace(/\s*\([a-z_ ]+\)$/, '') ?? null
    const ns = [add({ id: h.id, title: statement(h.content), where: factLabel(h), kind: 'fact', status: statusOf(h), file_id: null, start_ms: null, quote })]
    for (const f of await filesOf(h))
      ns.push(
        add({
          id: f.id,
          title: (f.path ?? f.title).split('/').pop() ?? f.title,
          where: citeLabel(f.path, f.citation),
          kind: KIND[f.kind] ?? 'document',
          status: 'supporting',
          file_id: f.source_object_id,
          start_ms: f.citation.start_ms != null ? Number(f.citation.start_ms) : null,
          quote: null,
        }),
      )
    return ns
  }

  let headline: string | null = null
  let detail: string | null = null
  let timeline: BriefAnswer['timeline'] = null
  let changed: string | null = null
  if (lead) {
    headline = statement(lead.content)
    detail = sentence(lead.content)
    timeline = timelineOf(lead, asOf)
    if (timeline) step('history', 'Checking how it changed over time', 'done', `${timeline.length} versions, ${timeline[0].when.split(/[–-]/)[0].trim() || 'earliest'} → ${timeline.at(-1)!.when}`)
    if (timeline) {
      const i = timeline.findIndex((s) => s.current)
      const before = timeline[i - 1]
      const after = timeline[i + 1]
      changed = after ? `Changed since: ${after.value} (${after.when})${timeline.length > i + 2 ? `, now ${timeline.at(-1)!.value}` : ''}.` : before ? `Changed: it was ${before.value} (${before.when}).` : null
    } else if (!lead.is_current && lead.citation.status !== 'disputed') changed = `No longer in force${lead.valid_to ? ` since ${humanDate(lead.valid_to)}` : ''}.`
  } else if (passages[0]) {
    headline = null
    detail = null
  }

  progress.onPartial?.({
    question,
    headline,
    detail,
    timeline,
    changed,
    time: r.understood.time ? { mode: r.understood.time.mode, reading: r.understood.time.reading, as_of: r.understood.asOf ?? null } : null,
    entities: r.understood.entities.filter((e) => e.type !== 'Term').map((e) => ({ id: e.id, name: e.name, type: e.type })),
  })
  step('files', 'Opening the files behind it', 'active')
  prefetch([lead, ...allFacts.filter((f) => f !== lead).slice(0, 3)])
  if (lead) await factSource(lead)
  const also: BriefAnswer['also'] = []
  for (const f of allFacts.filter((f) => f !== lead).slice(0, 3)) {
    if (wantsNow && !f.is_current && lead?.is_current) continue
    also.push({ text: statement(f.content), status: statusOf(f), cites: await factSource(f) })
  }
  for (const p of passages.slice(0, 5))
    add({
      id: p.id,
      title: (p.path ?? p.title).split('/').pop() ?? p.title,
      where: citeLabel(p.path, p.citation),
      kind: KIND[p.kind] ?? 'document',
      status: 'supporting',
      file_id: p.source_object_id ?? null,
      start_ms: p.citation.start_ms != null ? Number(p.citation.start_ms) : null,
      quote: p.snippet.replace(/[«»]/g, '').replace(/\s+/g, ' ').replace(/From: .*?Subject: /, '').slice(0, 220),
    })

  step('files', 'Opening the files behind it', 'done', `${new Set(sources.filter((x) => x.kind !== 'fact').map((x) => x.title)).size} files`)

  // What this person can't see: run the same search with full access, count the rest.
  let restricted: BriefAnswer['restricted'] = null
  if (ctx.as) {
    step('access', 'Checking for matches in files you can’t open', 'active')
    const all = await fullAccess!
    const hidden = all.hits.filter((h) => !r.hits.some((x) => x.id === h.id))
    const ok = await visible(ctx, hidden.map((h) => h.id))
    const blocked = hidden.filter((h) => !ok.has(h.id))
    if (blocked.length) {
      const objs = blocked.map((h) => h.source_object_id).filter(Boolean)
      const scopes = objs.length
        ? (
            await ctx.sql.query<{ name: string }>(
              `select distinct s.name from public.file_access fa join public.access_scopes s on s.id = fa.scope_id
               where fa.tenant_id = $1 and fa.source_object_id = any($2::uuid[]) and not coalesce(s.hidden, false)`,
              [ctx.tenantId, objs],
            )
          ).rows.map((x) => x.name)
        : []
      // "Locked" only when the single best source for the question (ranked with full access) is one they can't open.
      restricted = { count: blocked.length, scopes, best_is_locked: !!all.hits[0] && blocked.some((b) => b.id === all.hits[0].id) }
    }
    step('access', 'Checking for matches in files you can’t open', 'done', restricted ? `${restricted.count} locked` : 'nothing locked')
  }

  const conflicts = [lead, ...facts.filter((f) => f !== lead).slice(0, 3)].filter((f): f is SearchHit => !!f && f.citation.status === 'disputed').map((f) => statement(f.content))
  // On-topic facts that don't headline still count as material for a written answer.
  const topPassage = Math.max(...passages.map((p) => p.ranks.rerank ?? -99), ...allFacts.map((f) => f.ranks.rerank ?? -99), -99)
  const evidence: BriefAnswer['evidence'] = lead ? 'strong' : topPassage >= 1 ? 'partial' : 'weak'

  return {
    question,
    headline,
    detail,
    timeline,
    changed,
    also,
    time: r.understood.time ? { mode: r.understood.time.mode, reading: r.understood.time.reading, as_of: r.understood.asOf ?? null } : null,
    entities: r.understood.entities.filter((e) => e.type !== 'Term').map((e) => ({ id: e.id, name: e.name, type: e.type })),
    sources,
    restricted,
    conflicts,
    evidence,
    ms: Math.round(performance.now() - t0),
  }
}
