// Data for the client app: an entity page and a home page, structured for UI (the agent
// tools return text for a model). Everything goes through the reader's access: facts and
// passages by their sources, system records only when the reader can open those exports.

import { EVENT_DATE, resolveEntity, type ToolCtx, visible } from '../answer/tools'
import { search } from '../search/search'
import { fieldLabel, tidy } from '../text'
import { canSeeRecords, type FactRow, facts, isCurrent, moneyByYear } from '../skills/report'

export interface PageFact {
  id: string
  subject?: string
  predicate: string
  value: string
  summary: string | null
  kind: string | null
  status: 'current' | 'outdated' | 'disputed' | 'unknown' | 'check'
  from: string | null
  to: string | null
  timeline: { value: string; when: string; current: boolean }[] | null
}

export function pageFact(f: FactRow, withSubject = false): PageFact {
  const steps = f.timeline
    ? f.timeline.split(' → ').map((p) => {
        const m = p.match(/^(.*) \(([^()]*)\)$/)
        return m ? { value: tidy(m[1]), when: m[2] } : { value: tidy(p), when: '' }
      })
    : null
  return {
    id: f.id,
    subject: withSubject ? f.subject : undefined,
    predicate: fieldLabel(f.predicate),
    value: tidy(f.value),
    summary: tidy(f.summary),
    kind: f.kind,
    status: f.status === 'disputed' ? 'disputed' : f.status === 'unknown' ? 'unknown' : f.outdated_by ? 'check' : isCurrent(f) ? 'current' : 'outdated',
    from: f.valid_from,
    to: f.valid_to,
    timeline: steps && steps.length > 1 ? steps.map((s, i) => ({ ...s, current: i === steps.length - 1 })) : null,
  }
}

/** A question someone running the business would ask about a fact that changed: the current state, not the history. */
function decisionQuestion(subject: string, predicate: string) {
  const who = subject
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .trim()
  const p = predicate.toLowerCase()
  if (/(account owner|account manager|owner)/.test(p)) return `Who owns the ${who} account now?`
  if (/credit hold/.test(p)) return `Is ${who} still on credit hold?`
  if (/(role|title|position)/.test(p)) return `What is ${who}'s role now?`
  if (/(manager|lead|approver|contact)/.test(p)) return `Who is ${who}'s ${p} now?`
  if (/(terms|rate|price|pricing|fee|discount|markup)/.test(p)) return `What are ${who}'s ${p} today?`
  return `What is ${who}'s ${p} now?`
}

const NAMES = ['jargon', 'nickname', 'former_name', 'abbreviation', 'first_name']

export async function entityPage(ctx: ToolCtx, ref: string) {
  const e = await resolveEntity(ctx, ref)
  if (!e) return null
  if (!(await visible(ctx, [`e:${e.id}`])).size) return null
  const base = (
    await ctx.sql.query<{
      description: string | null
      properties: Record<string, unknown>
      kind: string | null
      aliases: { alias: string; kind: string }[]
      ids: number
    }>(
      `select e.description, e.properties, t.metadata ->> 'kind' kind,
              coalesce((select jsonb_agg(distinct jsonb_build_object('alias', a.alias, 'kind', a.kind)) from public.entity_aliases a
                        where a.entity_id = e.id and a.status <> 'rejected' and a.kind = any($2::text[])), '[]') aliases,
              (select count(*)::int from public.entity_identifiers i where i.entity_id = e.id) ids
       from public.entities e join public.entity_types t on t.id = e.entity_type_id where e.id = $1`,
      [e.id, NAMES],
    )
  ).rows[0]

  // Facts about it, and facts elsewhere that name it.
  const own = await facts(ctx, `f.subject_entity_id = $2`, [e.id], 300)
  const mentions = (await facts(ctx, `f.subject_entity_id <> $2 and ((f.value #>> '{}') ilike '%' || $3 || '%' or exists (select 1 from public.search_documents d where d.tenant_id = f.tenant_id and d.id = 'f:' || f.id and $2 = any(d.entity_ids)))`, [e.id, e.name], 30)).filter(isCurrent)

  // Connections, grouped (other things only, events are shown as activity).
  const links = (
    await ctx.sql.query<{
      rel: string
      dir: 'out' | 'in'
      other_type: string
      n: number
      sample: { id: string; name: string }[]
    }>(
      `with l as (
         select rt.name rel, case when r.source_entity_id = $1 then 'out' else 'in' end dir, o.id, o.canonical_name name, ot.name other_type
         from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id
         join public.entities o on o.id = case when r.source_entity_id = $1 then r.target_entity_id else r.source_entity_id end
         join public.entity_types ot on ot.id = o.entity_type_id and (ot.metadata ->> 'kind') is distinct from 'event' and ot.name <> 'Term'
         where (r.source_entity_id = $1 or r.target_entity_id = $1) and r.status not in ('rejected', 'superseded')
           and (r.valid_to is null or r.valid_to >= current_date) and o.status in ('candidate', 'active'))
       select rel, dir, other_type, count(distinct id)::int n, (array_agg(distinct jsonb_build_object('id', id, 'name', name)))[1:12] sample from l group by 1, 2, 3 order by n desc limit 14`,
      [e.id],
    )
  ).rows
  const ok = await visible(
    ctx,
    links.flatMap((l) => l.sample.map((s) => `e:${s.id}`)),
  )
  const connections = links.map((l) => ({ ...l, sample: l.sample.filter((s) => ok.has(`e:${s.id}`)) })).filter((l) => l.sample.length)

  // Activity from the systems (only if the reader can open those exports).
  const types = (
    await ctx.sql.query<{
      type: string
      n: number
      first: string | null
      last: string | null
    }>(
      `select t.name type, count(*)::int n, min(${EVENT_DATE})::text first, max(${EVENT_DATE})::text last
       from public.relationships r join public.entities e on e.id = case when r.source_entity_id = $1 then r.target_entity_id else r.source_entity_id end
       join public.entity_types t on t.id = e.entity_type_id and t.metadata ->> 'kind' = 'event'
       where (r.source_entity_id = $1 or r.target_entity_id = $1) and r.status <> 'rejected' and e.status in ('candidate', 'active')
       group by 1 order by 2 desc`,
      [e.id],
    )
  ).rows
  const activity = []
  for (const t of types) if (await canSeeRecords(ctx, t.type)) activity.push(t)
  const recent = activity.length
    ? (
        await ctx.sql.query<{
          id: string
          name: string
          type: string
          day: string | null
          note: string | null
          amount: string | null
        }>(
          `select e.id, e.canonical_name name, t.name type, ${EVENT_DATE}::text as day,
                  coalesce(e.properties ->> 'Tech Notes', e.properties ->> 'Notes', e.properties ->> 'Job Type', e.properties ->> 'memo') note, e.properties ->> 'amount' amount
           from public.relationships r join public.entities e on e.id = case when r.source_entity_id = $1 then r.target_entity_id else r.source_entity_id end
           join public.entity_types t on t.id = e.entity_type_id and t.name = any($2::text[])
           where (r.source_entity_id = $1 or r.target_entity_id = $1) and r.status <> 'rejected' and e.status in ('candidate', 'active') and ${EVENT_DATE} <= current_date
           order by ${EVENT_DATE} desc nulls last limit 12`,
          [e.id, activity.map((a) => a.type)],
        )
      ).rows
    : []
  const [invoiced, paid] = await Promise.all([moneyByYear(ctx, 'Invoice', e.id), moneyByYear(ctx, 'Payment', e.id)])

  const r = await search(ctx.sql, ctx.tenantId, e.name, {
    as: ctx.as,
    docTypes: ['passage'],
    entityIds: [e.id],
    limit: 8,
  })

  return {
    id: e.id,
    name: e.name,
    type: e.type,
    kind: base.kind,
    description: base.description,
    aliases: base.aliases.map((a) => a.alias),
    identifiers: base.ids,
    properties: Object.fromEntries(
      Object.entries(base.properties ?? {})
        .filter(([k, v]) => v !== null && v !== '' && typeof v !== 'object' && !/(^id$|_id$|hash|source)/i.test(k))
        .slice(0, 14),
    ),
    facts: own.map((f) => pageFact(f)),
    mentioned_in: mentions.slice(0, 10).map((f) => pageFact(f, true)),
    connections,
    activity,
    recent,
    money: invoiced.map((y) => ({
      year: y.year,
      invoiced: Number(y.total),
      invoices: y.n,
      paid: Number(paid.find((p) => p.year === y.year)?.total ?? 0),
    })),
    documents: r.hits.map((h) => ({
      id: h.id,
      title: (h.path ?? h.title).split('/').pop(),
      kind: h.kind,
      snippet: h.snippet.replace(/[«»]/g, '').replace(/\s+/g, ' ').slice(0, 220),
      file_id: h.source_object_id,
      citation: h.citation,
    })),
  }
}

/** Home: what changed recently, and starting points derived from the record itself. */
export async function home(ctx: ToolCtx) {
  // The client's "now" is the latest dated fact, not the server clock (data may lag).
  const [changedRows, riskRows, top, people] = await Promise.all([
    facts(ctx, `f.valid_from >= (select max(valid_from) from public.facts where tenant_id = $1 and valid_from <= current_date) - interval '200 days' and f.valid_from <= current_date`, [], 120),
    facts(ctx, `f.metadata ->> 'kind' in ('risk', 'key_person') and f.status <> 'superseded'`, [], 60),
    canSeeRecords(ctx, 'Invoice').then(async (ok) =>
      !ok
        ? []
        : (
            await ctx.sql.query<{ id: string; name: string; total: string }>(
              `select c.id, c.canonical_name name, round(sum((e.properties ->> 'amount')::numeric))::text total
           from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = 'Invoice'
           join public.relationships r on r.source_entity_id = e.id join public.entities c on c.id = r.target_entity_id
           join public.entity_types ct on ct.id = c.entity_type_id and ct.name = 'Customer'
           where e.tenant_id = $1 and ${EVENT_DATE} >= current_date - interval '365 days' group by 1, 2 order by sum((e.properties ->> 'amount')::numeric) desc limit 6`,
              [ctx.tenantId],
            )
          ).rows,
    ),
    // People the record knows most about (who to look up first).
    ctx.sql
      .query<{ id: string; name: string; title: string | null; n: number }>(
        `select e.id, e.canonical_name name, coalesce(e.properties ->> 'Job Title', e.properties ->> 'title') title, count(f.id)::int n
         from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = 'Person'
         join public.facts f on f.subject_entity_id = e.id and f.metadata ->> 'layer' = 'canonical' and f.status not in ('rejected', 'superseded')
         where e.tenant_id = $1 and e.status in ('candidate', 'active') group by 1, 2, 3 order by n desc limit 12`,
        [ctx.tenantId],
      )
      .then((r) => r.rows),
  ])
  const changed = changedRows
    .filter((f) => isCurrent(f) && f.timeline)
    .slice(0, 8)
    .map((f) => pageFact(f, true))
  const risks = riskRows.filter(isCurrent)
  const subjects = [...new Set(risks.filter((f) => f.subject_type === 'Person').map((f) => f.subject))].slice(0, 2)
  const asks = [...changed.slice(0, 3).map((f) => decisionQuestion(f.subject ?? '', f.predicate)), ...(top[0] ? [`What are ${top[0].name}'s payment terms?`] : [])]
  const discover = [
    ...subjects.slice(0, 1).map((s) => `What does ${s} know that nobody else does?`),
    'Which critical work depends on one person?',
    'Which customers get fees waived, and why?',
    'Where are we billing differently from our contracts?',
    'Where does training contradict current policy?',
  ]
  const okPeople = await visible(
    ctx,
    people.map((p) => `e:${p.id}`),
  )
  return {
    changed,
    top_customers: top.map((t) => ({ ...t, total: Number(t.total) })),
    asks,
    discover,
    people: people
      .filter((p) => okPeople.has(`e:${p.id}`))
      .slice(0, 6)
      .map(({ n: _n, ...p }) => p),
  }
}

/** A small card for "best match" in search: who/what it is, other names, a few current facts. */
export async function entityCard(ctx: ToolCtx, id: string) {
  if (!(await visible(ctx, [`e:${id}`])).size) return null
  const e = (
    await ctx.sql.query<{ id: string; name: string; type: string; title: string | null; aliases: string[] }>(
      `select e.id, e.canonical_name name, t.name type,
              coalesce(e.properties ->> 'Job Title', e.properties ->> 'title', e.properties ->> 'Description', e.properties ->> 'Equipment Type') title,
              -- Nicknames: its own aliases plus company vocabulary that refers to it ("Pump 17", "Seventeen").
              array(select n from (
                      select a.alias n from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected' and a.kind = any($2::text[])
                      union
                      select v.canonical_name from public.relationships r join public.entities v on v.id = r.source_entity_id
                      join public.entity_types vt on vt.id = v.entity_type_id and vt.name = 'Term'
                      where r.target_entity_id = e.id and r.status <> 'rejected' and v.status in ('candidate', 'active')) x
                    where lower(n) <> lower(e.canonical_name) and n !~ '^[0-9]+$' order by length(n) limit 8) aliases
       from public.entities e join public.entity_types t on t.id = e.entity_type_id where e.id = $1`,
      [id, NAMES],
    )
  ).rows[0]
  if (!e) return null
  const [all, places] = await Promise.all([
    // Its own facts, plus facts about it filed under something else ("Blue Ridge · p17 suction fix").
    facts(ctx, `(f.subject_entity_id = $2 or exists (select 1 from public.search_documents d where d.tenant_id = f.tenant_id and d.id = 'f:' || f.id and $2 = any(d.entity_ids)))`, [id], 80).then((fs) => fs.filter(isCurrent)),
    // Where it sits: the site, customer, branch or vendor it belongs to.
    ctx.sql
      .query<{ id: string; name: string; type: string }>(
        `select distinct on (ot.name) o.id, o.canonical_name name, ot.name type
         from public.relationships r join public.entities o on o.id = r.target_entity_id
         join public.entity_types ot on ot.id = o.entity_type_id and ot.name in ('Site', 'Customer', 'Branch', 'Vendor')
         where r.source_entity_id = $1 and r.status not in ('rejected', 'superseded') and (r.valid_to is null or r.valid_to >= current_date) and o.status in ('candidate', 'active')
         order by ot.name, r.created_at desc`,
        [id],
      )
      .then((r) => r.rows),
  ])
  const seen = new Set<string>()
  const aliases = e.aliases.filter((a) => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase())).slice(0, 5)
  const okPlaces = await visible(ctx, places.map((p) => `e:${p.id}`))
  const PLACE_ORDER = ['Site', 'Branch', 'Customer', 'Vendor']
  const context = places.filter((p) => okPlaces.has(`e:${p.id}`)).sort((a, b) => PLACE_ORDER.indexOf(a.type) - PLACE_ORDER.indexOf(b.type))
  // The latest change: the newest fact in force that replaced an earlier version.
  // Failing that, the newest dated fact in force.
  const newest = (fs: FactRow[]) => fs.filter((f) => f.valid_from).sort((a, b) => b.valid_from!.localeCompare(a.valid_from!))[0]
  // Its own facts come first; facts filed under something else only fill in (and say whose they are).
  const own = all.filter((f) => f.subject_id === id)
  const other = all.filter((f) => f.subject_id !== id)
  const latest = newest(own.filter((f) => f.timeline)) ?? newest(own) ?? newest(other)
  // Commercial and role facts first: what someone looking this up most likely needs.
  const PRIORITY = ['payment terms', 'role', 'title', 'account owner', 'branch manager', 'credit hold', 'discount', 'agreement term', 'markup', 'rate']
  const order = (p: string) => {
    const i = PRIORITY.findIndex((k) => p.replaceAll('_', ' ').includes(k))
    return i < 0 ? PRIORITY.length : i
  }
  // Role and employment feed the header (title, "Former…" note), so they don't repeat below.
  const inHeader = (f: FactRow) => /^(role|title|job title|position|employment status|status)$/.test(f.predicate.replaceAll('_', ' ').toLowerCase())
  const byPriority = (fs: FactRow[]) => fs.filter((f) => f !== latest && !inHeader(f)).sort((a, b) => order(a.predicate) - order(b.predicate))
  const key = [...byPriority(own), ...(own.length < 4 ? byPriority(other) : [])].slice(0, 4).map((f) => pageFact(f, f.subject_id !== id))
  // A system field can be out of date ("President & CEO" for someone who has left): a current
  // reviewed fact about role or employment wins, and departure is said plainly.
  const pred = (f: FactRow) => f.predicate.replaceAll('_', ' ').toLowerCase()
  const role = own.find((f) => /^(role|title|job title|position)$/.test(pred(f)))
  const employment = own.find((f) => /^employment status|^status$/.test(pred(f)))
  const gone = employment && /\b(former|left|retired|departed|terminated|no longer)\b/i.test(employment.value)
  const title = tidy(role?.value ?? e.title)
  const status_note = gone ? tidy(employment!.value) : null
  return { ...e, title: gone ? `Former ${title ?? e.type.toLowerCase()}` : title, status_note, aliases, context, changed: latest ? pageFact(latest, latest.subject_id !== id) : null, facts: key, fact_count: all.length }
}

export interface PassageDetail {
  id: string
  doc_type: string
  kind: string
  title: string
  content: string
  citation: Record<string, unknown>
  file_id: string | null
  path: string | null
  valid_from: string | null
  valid_to: string | null
  is_current: boolean | null
  /** For a fact: the passages it rests on (the exact places it is said). */
  supporting: {
    id: string
    title: string
    kind: string
    content: string
    citation: Record<string, unknown>
    file_id: string | null
    path: string | null
  }[]
}

/** One cited thing, exactly: the passage text and where it sits; for a fact, the passages behind it. */
export async function passageDetail(ctx: ToolCtx, id: string): Promise<PassageDetail | null> {
  if (!(await visible(ctx, [id])).size) return null
  const row = (
    await ctx.sql.query<Omit<PassageDetail, 'supporting'> & { evidence_ids: string[] }>(
      `select d.id, d.doc_type, d.kind, d.title, d.content, d.citation, d.source_object_id file_id, so.original_path path,
              d.valid_from::text, d.valid_to::text, d.is_current, d.evidence_ids
       from public.search_documents d left join public.source_objects so on so.id = d.source_object_id
       where d.tenant_id = $1 and d.id = $2`,
      [ctx.tenantId, id],
    )
  ).rows[0]
  if (!row) return null
  let supporting: PassageDetail['supporting'] = []
  if (row.doc_type === 'fact' && row.evidence_ids?.length) {
    const ps = (
      await ctx.sql.query<PassageDetail['supporting'][number]>(
        `select p.id, p.title, p.kind, p.content, p.citation, p.source_object_id file_id, so.original_path path
         from public.search_documents p left join public.source_objects so on so.id = p.source_object_id
         where p.tenant_id = $1 and p.doc_type = 'passage' and p.evidence_ids && $2::uuid[] limit 200`,
        [ctx.tenantId, row.evidence_ids],
      )
    ).rows
    // Evidence is often a whole file (an interview, a long email), so every chunk of it matches.
    // Show the chunks that actually say the fact: most of its distinctive words, best first.
    const STOP = new Set([
      'the',
      'and',
      'for',
      'with',
      'from',
      'that',
      'this',
      'are',
      'was',
      'not',
      'has',
      'have',
      'its',
      'per',
      'all',
      'any',
      'into',
      'now',
      'since',
      'valid',
      'status',
      'accepted',
      'current',
    ])
    const words = (t: string) =>
      new Set(
        t
          .toLowerCase()
          .match(/[a-z0-9$%.]{3,}/g)
          ?.map((w) => w.replace(/\.$/, ''))
          .filter((w) => !STOP.has(w)) ?? [],
      )
    const want = words(row.content.split('\n').slice(0, 2).join(' '))
    const scored = ps
      .map((p) => {
        const have = words(p.content)
        let n = 0
        for (const w of want) if (have.has(w)) n++
        return { p, score: want.size ? n / want.size : 0 }
      })
      .filter((x) => x.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((x) => x.p)
    const ok = await visible(
      ctx,
      scored.map((p) => p.id),
    )
    supporting = scored.filter((p) => ok.has(p.id))
  }
  const { evidence_ids: _e, ...rest } = row
  return { ...rest, title: tidy(rest.title), supporting }
}
