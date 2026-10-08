// The operator's skills: repeatable workflows that turn the company record into a cited brief.
// Each one is deterministic over facts, timelines, events and evidence (access-aware), so it
// works without the Claude API and every line can be checked.

import { resolveEntity, type ToolCtx } from '../answer/tools'
import { canSeeRecords, events, evidenceItems, factItems, type FactRow, facts, human, type Item, isCurrent, money, moneyByYear, type Report, ReportBuilder, statusOf, whenOf } from './report'

export interface SkillInput {
  /** A customer, person, asset, site… by name, nickname or id (when the skill takes one). */
  entity?: string
  /** A topic in plain words (SOP, training plan). */
  topic?: string
}

export interface SkillSpec {
  key: string
  name: string
  description: string
  input: 'entity' | 'topic' | 'person' | 'none'
  placeholder?: string
  run: (ctx: ToolCtx, input: SkillInput) => Promise<Report>
}

const words = (re: string) => `(f.predicate || ' ' || (f.value #>> '{}') || ' ' || coalesce(f.metadata ->> 'summary', '')) ~* '${re.replace(/'/g, "''")}'`
const SINGLE_POINT = "\\m(only|sole|nobody else|no one else|no backup|no successor|in (his|her) head|single.?person|single owner|undocumented|never (documented|written)|not written|knows how|the only)\\M"
/** Someone is leaving: said by the fact's predicate or value (summaries mention departures of others). */
const LEAVING_WHERE = `(f.predicate ~* '(retir|depart|employment_status|terminat|resign|last_day|leaving|post_departure)' or (f.value #>> '{}') ~* '\\m(retiring|retires|retired|retirement|former|resigned|last day|leaving|terminated|departure)\\M')`
/** A key-person fact that is really about a dependency (not just a title). */
const DEPENDENCY = `(${words(SINGLE_POINT)} or (f.metadata ->> 'kind' = 'key_person' and f.predicate !~* '^(role|title|work_schedule|employment_status)$' and ${words('\\m(relationship|loyal|named|holds|memory|knows|personally|owns|expert|best at)')}))`

const ARRANGEMENT = "(arrangement|protected|verbal|per [A-Z]|handshake|talk to|calls? .* first|no charge|waiv|leave .* alone|personally|undocumented|in (his|her) head|by gut|OK\\M|approv)"

/** A regex matching how records name a person: full name, first name, nicknames. */
async function personRegex(ctx: ToolCtx, person: { id: string; name: string }) {
  const names = [person.name, person.name.split(' ')[0], ...(await ctx.sql.query<{ a: string }>(`select alias a from public.entity_aliases where entity_id = $1 and status <> 'rejected' and kind in ('nickname', 'first_name')`, [person.id])).rows.map((r) => r.a)]
  return `\\m(${[...new Set(names)].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\M`
}

async function need(ctx: ToolCtx, ref: string | undefined, what: string) {
  if (!ref?.trim()) throw new Error(`Say which ${what}.`)
  const e = await resolveEntity(ctx, ref)
  if (!e) throw new Error(`No ${what} matches "${ref}".`)
  return e
}

/** Pick facts whose text matches a pattern, current first. */
const byCurrent = (rows: FactRow[]) => [...rows].sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)))

// ------------------------------------------------------------------------------------------

async function customerDossier(ctx: ToolCtx, input: SkillInput): Promise<Report> {
  const e = await need(ctx, input.entity, 'customer')
  const b = new ReportBuilder(ctx, 'customer_dossier', `Customer dossier: ${e.name}`, e.name)
  const all = await facts(ctx, `f.subject_entity_id = $2`, [e.id], 400)
  const card = await b.cite([`e:${e.id}`])
  const profile = (
    await ctx.sql.query<{ aliases: string[]; sites: string[]; contacts: string[]; owners: string[] }>(
      `select array(select a.alias from public.entity_aliases a where a.entity_id = $1 and a.status <> 'rejected' and a.kind in ('jargon', 'nickname', 'former_name', 'abbreviation')) aliases,
              array(select o.canonical_name from public.relationships r join public.entities o on o.id = r.source_entity_id join public.entity_types t on t.id = o.entity_type_id and t.name = 'Site' where r.target_entity_id = $1 and r.status <> 'rejected' and o.status in ('candidate','active') limit 12) sites,
              array(select o.canonical_name || coalesce(' (' || (o.properties ->> 'Job Title') || ')', '') from public.relationships r join public.entities o on o.id = r.source_entity_id join public.entity_types t on t.id = o.entity_type_id and t.name = 'Customer Contact' where r.target_entity_id = $1 and r.status <> 'rejected' limit 10) contacts,
              array(select distinct o.canonical_name from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id join public.entities o on o.id = r.target_entity_id where r.source_entity_id = $1 and rt.name ilike '%owner%' and r.status <> 'rejected') owners`,
      [e.id],
    )
  ).rows[0]
  b.section({
    heading: 'Who they are',
    items: [
      ...(profile.aliases.length ? [{ text: `Also called: ${profile.aliases.join(', ')}`, cites: card }] : []),
      ...(profile.sites.length ? [{ text: `Sites: ${profile.sites.join(', ')}`, cites: card }] : []),
      ...(profile.contacts.length ? [{ text: `Contacts: ${profile.contacts.join('; ')}`, cites: card }] : []),
      ...(profile.owners.length ? [{ text: `Account owner(s) in the systems: ${profile.owners.join(', ')}`, cites: card }] : []),
      ...(await factItems(b, all.filter((f) => /(customer since|renamed|legal name|parent|industry|profile|relationship|owner|contact|signer)/i.test(f.predicate) && isCurrent(f)).slice(0, 8))),
    ],
  })
  const commercial = all.filter((f) => /(term|price|pricing|markup|rate|discount|agreement|fee|billing|invoice|warranty|escalat|payment|credit|plan)/i.test(f.predicate))
  b.section({ heading: 'What changed', hint: 'Terms in force that replaced an earlier version. The history is under each.', items: await factItems(b, commercial.filter((f) => f.timeline && isCurrent(f))) })
  b.section({ heading: 'Other terms in force', items: await factItems(b, commercial.filter(isCurrent).slice(0, 14)) })
  const RISK = /(risk|rebid|hold|late|dispute|wrong|duplicate|concentration|retir|transition|collections|lost|competitor|complain|no.charge)/i
  const issues = all.filter((f) => f.kind === 'risk' || RISK.test(f.predicate) || f.status === 'disputed' || f.status === 'unknown' || f.outdated_by)
  b.section({ heading: 'Risks, exceptions and open questions', items: await factItems(b, byCurrent(issues).slice(0, 14)) })
  const people = all.filter((f) => f.kind === 'key_person' || /(relationship|depends|loyal|knows)/i.test(f.predicate))
  b.section({ heading: 'Relationship and key people', items: await factItems(b, people.filter(isCurrent).slice(0, 8)) })
  const [rev, pay] = await Promise.all([moneyByYear(ctx, 'Invoice', e.id), moneyByYear(ctx, 'Payment', e.id)])
  if (rev.length)
    b.section({
      heading: 'Money by year',
      hint: 'From QuickBooks invoices and payments linked to this customer.',
      items: [],
      table: { columns: ['Year', 'Invoiced', 'Invoices', 'Paid'], rows: rev.map((r) => [r.year, money(r.total), r.n, money(pay.find((p) => p.year === r.year)?.total ?? 0)]) },
    })
  if (await canSeeRecords(ctx, 'Work Order')) {
    const wos = await events(ctx, e.id, ['Work Order'])
    const note = (w: (typeof wos)[number]) => String(w.properties['Tech Notes'] ?? w.properties.Notes ?? '').trim()
    const recent = wos.filter((w) => w.day && note(w)).slice(-8).reverse()
    if (recent.length)
      b.section({
        heading: 'Recent work',
        hint: `${wos.length} work orders on record.`,
        items: recent.map((w) => ({ text: `${w.day} · ${w.name} · ${String(w.properties['Job Type'] ?? w.properties.Type ?? '')} · ${note(w).slice(0, 160)}`, cites: card })),
      })
  }
  b.section({ heading: 'Key documents and conversations', items: await evidenceItems(b, `${e.name} agreement renewal pricing relationship`, { entityIds: [e.id], limit: 6 }) })
  if (!commercial.length) b.gaps.push('No commercial terms recorded for this customer yet.')
  if (!people.length) b.gaps.push('No relationship owner or key contact captured.')
  return b.build()
}

async function keyPersonAudit(ctx: ToolCtx, input: SkillInput): Promise<Report> {
  const person = input.entity?.trim() ? await need(ctx, input.entity, 'person') : null
  const b = new ReportBuilder(ctx, 'key_person_audit', person ? `Key-person dependency: ${person.name}` : 'Key-person dependency audit', person?.name ?? null)
  const cond = DEPENDENCY
  const rows = person
    ? await facts(ctx, `${cond} and (f.subject_entity_id = $2 or (f.value #>> '{}') ~* $3 or f.metadata ->> 'summary' ~* $3)`, [person.id, await personRegex(ctx, person)], 300)
    : await facts(ctx, cond, [], 400)
  const current = rows.filter(isCurrent)
  if (!person) {
    // Rank people by how much only they know, and whether they are leaving.
    const leaving = new Set((await facts(ctx, `st.name = 'Person' and ${LEAVING_WHERE}`, [], 300)).filter(isCurrent).map((f) => f.subject_id))
    const byPerson = new Map<string, { name: string; id: string; facts: FactRow[] }>()
    for (const f of current.filter((f) => f.subject_type === 'Person')) {
      const p = byPerson.get(f.subject_id) ?? { name: f.subject, id: f.subject_id, facts: [] }
      p.facts.push(f)
      byPerson.set(f.subject_id, p)
    }
    const ranked = [...byPerson.values()].sort((a, b2) => Number(leaving.has(b2.id)) - Number(leaving.has(a.id)) || b2.facts.length - a.facts.length).slice(0, 12)
    b.section({
      heading: 'Who the business depends on',
      hint: 'People with knowledge or relationships nobody else holds; leaving or retiring first.',
      items: [],
      table: { columns: ['Person', 'Single-point items', 'Leaving / transition'], rows: ranked.map((p) => [p.name, p.facts.length, leaving.has(p.id) ? 'yes' : '']) },
    })
    for (const p of ranked.slice(0, 6)) b.section({ heading: p.name, items: await factItems(b, p.facts.slice(0, 6)) })
  } else {
    b.section({ heading: `What only ${person.name} knows or holds`, items: await factItems(b, current.filter((f) => f.subject_id === person.id).slice(0, 14)) })
    b.section({ heading: `Where others depend on ${person.name}`, items: await factItems(b, current.filter((f) => f.subject_id !== person.id).slice(0, 12), { withSubject: true }) })
    const arrangements = (
      await facts(ctx, `f.metadata ->> 'kind' in ('exception', 'practice', 'policy') and ${words(ARRANGEMENT)} and (f.subject_entity_id = $2 or (f.value #>> '{}') ~* $3 or f.metadata ->> 'summary' ~* $3)`, [person.id, await personRegex(ctx, person)], 40)
    ).filter(isCurrent)
    b.section({ heading: `Arrangements that exist because of ${person.name.split(' ')[0]}`, hint: 'Exceptions, habits and approvals tied to this person. They stop working, or nobody knows why, when they leave.', items: await factItems(b, arrangements.slice(0, 10), { withSubject: true }) })
    const leaving = (await facts(ctx, `f.subject_entity_id = $2 and ${LEAVING_WHERE}`, [person.id])).slice(0, 6)
    b.section({ heading: 'Departure and transition', items: await factItems(b, leaving) })
    b.section({ heading: 'In their own words', items: await evidenceItems(b, `${person.name} only one who knows how`, { kinds: ['transcript_segment', 'email_body'], entityIds: [person.id], limit: 5 }) })
    if (!leaving.length) b.gaps.push(`No departure date recorded for ${person.name}.`)
  }
  return b.build()
}

async function transitionBrief(ctx: ToolCtx): Promise<Report> {
  const b = new ReportBuilder(ctx, 'transition_brief', 'Acquisition transition brief')
  b.section({ heading: 'The deal', items: await factItems(b, byCurrent(await facts(ctx, words('(sale|sold|acqui|buyer|close[ds]?|closing|letter of intent|\\mLOI\\M|purchase agreement|\\mSPA\\M|deal committee)'), [], 40)).slice(0, 8), { withSubject: true }) })
  b.section({ heading: 'Leadership and roles that changed', items: await factItems(b, (await facts(ctx, `st.name = 'Person' and f.predicate ~* '(role|title|position|employment|work_schedule)' and f.valid_from >= '2025-01-01'`, [], 60)).slice(0, 10), { withSubject: true }) })
  b.section({ heading: 'Approvals with no clear owner', hint: 'Policies that still name someone who left, or limits in flux.', items: await factItems(b, (await facts(ctx, `${words("(gap|no owner|nobody owns|isn't the owner|no successor|unclear|no one can sign|override)")} and f.status <> 'unknown' and (st.name <> 'Person' or f.predicate ~* '(authority|approv|sign|qc|owner)')`, [], 40)).filter(isCurrent).slice(0, 10), { withSubject: true }) })
  b.section({ heading: 'People the business cannot lose', items: await factItems(b, (await facts(ctx, DEPENDENCY, [], 60)).filter(isCurrent).slice(0, 10), { withSubject: true }) })
  b.section({ heading: 'Customer concentration and relationships', items: await factItems(b, (await facts(ctx, words('(concentration|largest customer|biggest customer|revenue share|rebid|out to bid|relationship (moving|transition))'), [], 40)).filter(isCurrent).slice(0, 10), { withSubject: true }) })
  b.section({ heading: 'Conflicts to settle', items: await factItems(b, await facts(ctx, `f.status = 'disputed'`, [], 20), { withSubject: true }) })
  return b.build()
}

async function generateSop(ctx: ToolCtx, input: SkillInput): Promise<Report> {
  const topic = input.topic?.trim()
  if (!topic) throw new Error('Say what the procedure is about (e.g. "ammonia lockout", "closing out a job").')
  const b = new ReportBuilder(ctx, 'generate_sop', `Standard procedure: ${topic}`, topic)
  const { search } = await import('../search/search')
  const hits = await search(ctx.sql, ctx.tenantId, topic, { as: ctx.as, docTypes: ['fact'], limit: 30, rerank: true })
  const ids = hits.hits.filter((h) => h.id.startsWith('f:')).map((h) => h.id.slice(2))
  const rows = ids.length ? await facts(ctx, `f.id = any($2::uuid[])`, [ids], 40) : []
  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, c) => (order.get(a.id) ?? 0) - (order.get(c.id) ?? 0))
  const rules = rows.filter((f) => isCurrent(f) && (f.kind === 'policy' || /(must|required|never|no .* without|two-person|before|always)/i.test(f.value)))
  const steps = rows.filter((f) => isCurrent(f) && f.kind === 'practice')
  b.section({ heading: 'Rules that apply', items: await factItems(b, rules.slice(0, 12), { withSubject: true }) })
  b.section({ heading: 'How it is actually done', items: await factItems(b, steps.slice(0, 10), { withSubject: true }) })
  b.section({ heading: 'Step-by-step from the documents', items: await evidenceItems(b, `${topic} procedure steps`, { kinds: ['text', 'ocr', 'video_segment'], limit: 6 }) })
  b.section({ heading: 'Exceptions', items: await factItems(b, rows.filter((f) => isCurrent(f) && f.kind === 'exception').slice(0, 6), { withSubject: true }) })
  b.section({ heading: 'Outdated versions (do not use)', items: await factItems(b, rows.filter((f) => !isCurrent(f) || f.outdated_by).slice(0, 8), { withSubject: true }) })
  if (!rules.length && !steps.length) b.gaps.push(`Nothing written down about "${topic}" yet. Interview whoever does it.`)
  return b.build()
}

async function customerRiskReview(ctx: ToolCtx): Promise<Report> {
  const b = new ReportBuilder(ctx, 'customer_risk_review', 'Customer risk review')
  const rows = (await facts(ctx, `st.name = 'Customer' and (f.metadata ->> 'kind' = 'risk' or f.status = 'disputed' or ${words('\\m(credit hold|slow pay|late|stopped paying|collections|negative margin|below cost|lose money|rebid|out to bid|moved to|competitor|lost|concentration|dispute|payment plan|past due)\\M')})`, [], 300)).filter(isCurrent)
  const byCustomer = new Map<string, FactRow[]>()
  for (const f of rows) byCustomer.set(f.subject, [...(byCustomer.get(f.subject) ?? []), f])
  const revenue = new Map<string, number>()
  if (await canSeeRecords(ctx, 'Invoice')) {
    const r = (
      await ctx.sql.query<{ name: string; total: string }>(
        `select c.canonical_name name, sum((e.properties ->> 'amount')::numeric)::text total
         from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = 'Invoice'
         join public.relationships r on r.source_entity_id = e.id join public.entities c on c.id = r.target_entity_id and c.canonical_name = any($2::text[])
         where e.tenant_id = $1 and e.properties ->> 'date' like '%2025%' group by 1`,
        [ctx.tenantId, [...byCustomer.keys()]],
      )
    ).rows
    for (const x of r) revenue.set(x.name, Number(x.total))
  }
  const ranked = [...byCustomer.entries()].sort((a, c) => (revenue.get(c[0]) ?? 0) - (revenue.get(a[0]) ?? 0) || c[1].length - a[1].length)
  b.section({
    heading: 'Customers with open risk',
    hint: 'Ranked by 2025 invoiced revenue (what is at stake), then by number of issues.',
    items: [],
    table: { columns: ['Customer', '2025 invoiced', 'Issues'], rows: ranked.slice(0, 15).map(([n, fs]) => [n, revenue.has(n) ? money(Math.round(revenue.get(n)!)) : '-', fs.length]) },
  })
  for (const [name, fs] of ranked.slice(0, 8)) b.section({ heading: name, items: await factItems(b, fs.slice(0, 5)) })
  return b.build()
}

async function pricingLeakage(ctx: ToolCtx): Promise<Report> {
  const b = new ReportBuilder(ctx, 'pricing_leakage', 'Pricing leakage analysis')
  const MONEY = '(rate|price|pricing|fee|\\$|discount|markup|invoice|bill)'
  const groups: [string, string, string, string?][] = [
    ['Fees waived', '(waiv|\\mno (emergency )?dispatch fee|fee (left|removed)|left off|not charged|\\mfree of charge|undercharg)', 'Fees or charges left off invoices, often by habit rather than a written decision.'],
    ['Discounts outside policy', '(unapproved|without approval|beyond (his|her) authority|approval not confirmed|not logged|per G\\.?W\\.?|protected customer)', 'Discounts given above the approval limits, never logged, or protected by one person.'],
    ['Prices that never went up', '(escalator|never applied|not applied|below cost|underpriced|leave .* alone on price|increase withheld)', 'Contract escalators skipped and accounts priced below cost.'],
    ['Rates out of date in a system', '(rate table|stale|not updated|old rate|last year|template)', 'Systems that kept billing an old rate after a change.', '(rate|price|pricing|fee|\\$)'],
    ['Work not billed', '(not billed|unbilled|coded (as )?(standard )?t&m|miscod|billing gap|never invoiced|left open)', 'Hot jobs coded as ordinary work, jobs never closed or invoiced.'],
  ]
  for (const [heading, re, hint, must] of groups) {
    const rows = (await facts(ctx, `${words(re)} and ${words(must ?? MONEY)} and f.predicate !~* 'warranty'`, [], 80)).filter(isCurrent)
    b.section({ heading, hint, items: await factItems(b, rows.slice(0, 10), { withSubject: true }) })
  }
  return b.build()
}

async function incidentInvestigation(ctx: ToolCtx, input: SkillInput): Promise<Report> {
  const e = await need(ctx, input.entity, 'asset, site or customer')
  const b = new ReportBuilder(ctx, 'incident_investigation', `Incident investigation: ${e.name}`, e.name)
  const card = await b.cite([`e:${e.id}`])
  const FAIL = /(fail|leak|trip|broke|broken|down|callback|seal|noise|cavitat|overheat|vibration)/i
  const FIX = /(project|upsiz|replace[d]? .* with|install|modif|redesign|root cause|fix)/i
  if (await canSeeRecords(ctx, 'Work Order')) {
    const wos = (await events(ctx, e.id, ['Work Order'])).filter((w) => w.day)
    const note = (w: (typeof wos)[number]) => String(w.properties['Tech Notes'] ?? w.properties.Notes ?? '')
    const CHECK = /(check|verif|reading|inspect|baseline|follow.?up)/i
    const failures = wos.filter((w) => FAIL.test(note(w)) && !CHECK.test(note(w)) && !/^PM /i.test(note(w)))
    const fixes = wos.filter((w) => (FIX.test(note(w)) || /project/i.test(String(w.properties['Job Type'] ?? w.properties.Type ?? ''))) && !CHECK.test(note(w)) && !FAIL.test(note(w)))
    const lastFix = fixes.at(-1)
    const checks = lastFix ? wos.filter((w) => w.day! > lastFix.day! && CHECK.test(note(w)) && (FAIL.test(note(w)) || FIX.test(note(w)))) : []
    const after = lastFix ? failures.filter((f) => f.day! > lastFix.day!) : []
    b.section({ heading: 'Failure history', hint: `${failures.length} failure-related work orders of ${wos.length} on record.`, items: failures.map((w) => ({ text: `${w.day} · ${w.name} · ${note(w).slice(0, 200)}`, cites: card })) })
    b.section({ heading: 'Diagnosis over time', items: wos.filter((w) => /(diagnos|cause|believe|traced|found|because)/i.test(note(w))).map((w) => ({ text: `${w.day} · ${note(w).slice(0, 220)}`, cites: card })) })
    b.section({ heading: 'The fix', items: fixes.map((w) => ({ text: `${w.day} · ${w.name} · ${note(w).slice(0, 200)}${w.properties.amount ? ` · ${money(Number(w.properties.amount))}` : ''}`, cites: card })) })
    b.section({
      heading: 'Has it stopped?',
      items: [
        lastFix
          ? after.length
            ? { text: `Not resolved: ${after.length} failure(s) after the ${lastFix.day} fix.`, status: 'flag', cites: card }
            : { text: `No failures recorded since the fix on ${lastFix.day} (${wos.filter((w) => w.day! > lastFix.day!).length} later visits, none failure-related).`, status: 'current', cites: card }
          : { text: 'No fix recorded yet.', status: 'flag', cites: card },
        ...checks.map((w) => ({ text: `${w.day} · ${note(w).slice(0, 200)}`, cites: card })),
      ],
    })
  } else b.gaps.push('The work-order history is not visible to this person.')
  const aliases = [e.name, ...((await ctx.sql.query<{ a: string }>(`select alias a from public.entity_aliases where entity_id = $1 and status <> 'rejected' and kind in ('jargon', 'nickname', 'abbreviation') limit 4`, [e.id])).rows.map((r) => r.a))]
  const names = aliases.join(' ')
  const nameRe = `\\m(${aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\M`
  b.section({ heading: 'What people said (email, interviews, video)', items: await evidenceItems(b, `${names} failure cause fix`, { kinds: ['email_body', 'transcript_segment', 'video_segment', 'image'], limit: 8 }) })
  b.section({ heading: 'Facts on record', items: await factItems(b, (await facts(ctx, `(f.subject_entity_id = $2 or (f.value #>> '{}') ~* $3 or f.metadata ->> 'summary' ~* $3)`, [e.id, nameRe], 40)).slice(0, 10), { withSubject: true }) })
  return b.build()
}

async function obsoleteKnowledge(ctx: ToolCtx): Promise<Report> {
  const b = new ReportBuilder(ctx, 'obsolete_knowledge', 'Obsolete knowledge detector')
  b.section({ heading: 'Rules a newer version replaced elsewhere', hint: 'Still marked current, but the same rule changed on another record.', items: await factItems(b, await facts(ctx, `f.metadata ? 'possibly_outdated_by'`, [], 40), { withSubject: true }) })
  b.section({ heading: 'Documents and training that are out of date', items: await factItems(b, (await facts(ctx, words('(draft|never (approved|signed)|unsigned|not final|outdated|out of date|still (on the drive|circulat|forwarded)|old (video|version|training)|is wrong|superseded)'), [], 60)).filter(isCurrent).slice(0, 12), { withSubject: true }) })
  b.section({ heading: 'Systems that disagree with the current fact', items: await factItems(b, (await facts(ctx, `${words('(still (shows|says|lists|has)|not updated|field (is )?(wrong|stale)|stale|never updated)')} and ${words('(quickbooks|hubspot|fieldline|field|record|table|template|system|\\mQB\\M|CRM)')}`, [], 60)).filter(isCurrent).slice(0, 12), { withSubject: true }) })
  b.section({ heading: 'Replaced in the last 18 months', hint: 'Recently changed. People may still follow the old version.', items: await factItems(b, (await facts(ctx, `f.status = 'superseded' and f.valid_to >= (current_date - interval '18 months')`, [], 60)).slice(0, 15), { withSubject: true }) })
  return b.build()
}

async function trainingPlan(ctx: ToolCtx, input: SkillInput): Promise<Report> {
  const role = input.topic?.trim() || input.entity?.trim()
  if (!role) throw new Error('Say the role (e.g. "field technician", "dispatcher", "billing").')
  const b = new ReportBuilder(ctx, 'training_plan', `Training plan: ${role}`, role)
  const { search } = await import('../search/search')
  const pick = async (q: string, kinds: string[]) => {
    const r = await search(ctx.sql, ctx.tenantId, q, { as: ctx.as, docTypes: ['fact'], limit: 25, rerank: true })
    const ids = r.hits.filter((h) => h.id.startsWith('f:')).map((h) => h.id.slice(2))
    return ids.length ? (await facts(ctx, `f.id = any($2::uuid[]) and f.metadata ->> 'kind' = any($3::text[])`, [ids, kinds], 25)).filter(isCurrent) : []
  }
  b.section({ heading: 'Week 1: safety and non-negotiables', items: await factItems(b, (await pick(`${role} safety lockout PPE site rules must`, ['policy'])).slice(0, 8), { withSubject: true }) })
  b.section({ heading: 'How the work gets done here', items: await factItems(b, (await pick(`${role} how jobs are done close out notes procedure`, ['practice', 'policy'])).slice(0, 10), { withSubject: true }) })
  b.section({ heading: 'Customer and site quirks', items: await factItems(b, (await pick(`${role} customer site gate access escort rules`, ['practice', 'policy', 'exception'])).slice(0, 8), { withSubject: true }) })
  b.section({ heading: 'People to learn from', items: await factItems(b, (await pick(`${role} expert knows best teacher go-to`, ['key_person'])).slice(0, 8), { withSubject: true }) })
  b.section({ heading: 'Training material', items: await evidenceItems(b, `${role} training orientation procedure`, { kinds: ['text', 'video_segment', 'ocr'], limit: 6 }) })
  return b.build()
}

async function sellerInterviewPlanner(ctx: ToolCtx, input: SkillInput): Promise<Report> {
  const person = input.entity?.trim() ? await need(ctx, input.entity, 'person') : null
  const b = new ReportBuilder(ctx, 'seller_interview_planner', person ? `Interview plan: ${person.name}` : 'Seller interview plan', person?.name ?? null)
  // A person is "in" a fact when it is about them or names them (full name, first name, nickname).
  let scope = ''
  const params: unknown[] = []
  if (person) {
    params.push(person.id, await personRegex(ctx, person))
    scope = `and (f.subject_entity_id = $2 or (f.value #>> '{}') ~* $3 or f.metadata ->> 'summary' ~* $3)`
  }
  const ask = (f: FactRow, kind: string) =>
    kind === 'disputed'
      ? `Which is right for ${f.subject} · ${human(f.predicate)}: "${f.value}"? Sources disagree.`
      : kind === 'unknown'
        ? `Can you confirm: ${f.subject} · ${human(f.predicate)}: "${f.value}"?`
        : kind === 'single'
          ? `Walk us through it: ${f.subject} · ${human(f.predicate)} ("${f.value}"). Who else could do it, and where is it written down?`
          : kind === 'arrangement'
            ? `Why does this exist, and should it continue: ${f.subject} · ${human(f.predicate)} ("${f.value}")? Is it written anywhere?`
            : `Is this still true: ${f.subject} · ${human(f.predicate)}: "${f.value}"?`
  const add = async (heading: string, rows: FactRow[], kind: string, hint?: string) => {
    const items: Item[] = []
    for (const f of rows) {
      if (b.shown.has(f.id)) continue
      b.shown.add(f.id)
      items.push({ text: ask(f, kind), status: statusOf(f), when: whenOf(f), cites: await b.cite([`f:${f.id}`]) })
    }
    b.section({ heading, hint, items })
  }
  await add('Settle the conflicts', await facts(ctx, `f.status = 'disputed' ${scope}`, params, 20), 'disputed', 'Two sources say different things.')
  await add(
    'Capture what only they know',
    (await facts(ctx, `${DEPENDENCY} ${scope}`, params, 60)).filter(isCurrent).slice(0, 15),
    'single',
    'Knowledge, skills and relationships with no backup.',
  )
  await add(
    'Explain the side arrangements',
    (await facts(ctx, `f.metadata ->> 'kind' in ('exception', 'practice') and ${words(ARRANGEMENT)} ${scope}`, params, 40)).filter(isCurrent).slice(0, 12),
    'arrangement',
    'Exceptions and habits that exist because one person decided. The buyer inherits them.',
  )
  await add('Confirm what is only hearsay', await facts(ctx, `f.status = 'unknown' ${scope}`, params, 20), 'unknown', 'Single, hedged statements.')
  await add('Check rules that may be outdated', await facts(ctx, `f.metadata ? 'possibly_outdated_by' ${scope}`, params, 15), 'stale')
  if (person) {
    const leaving = (await facts(ctx, `f.subject_entity_id = $2 and ${LEAVING_WHERE}`, [person.id])).filter(isCurrent)
    if (leaving.length) b.section({ heading: 'Time left', items: await factItems(b, leaving.slice(0, 3)) })
    else b.gaps.push(`No departure date on record for ${person.name}.`)
  }
  return b.build()
}

export const SKILLS: SkillSpec[] = [
  { key: 'customer_dossier', name: 'Customer dossier', description: 'Everything about one customer: terms in force and how they changed, risks, people, money and the key documents.', input: 'entity', placeholder: 'A customer, its name or what people call it', run: customerDossier },
  { key: 'key_person_audit', name: 'Key-person dependency audit', description: 'Who the business depends on, what only they know, and who is leaving. Leave empty for the whole company.', input: 'person', placeholder: 'A person (or leave empty for everyone)', run: keyPersonAudit },
  { key: 'transition_brief', name: 'Acquisition transition brief', description: 'The deal, leadership changes, approvals with no owner, people you cannot lose, concentration and open conflicts.', input: 'none', run: (ctx) => transitionBrief(ctx) },
  { key: 'generate_sop', name: 'Generate SOP', description: 'A procedure from the rules, practices, documents and video on a topic, with outdated versions called out.', input: 'topic', placeholder: 'A task, e.g. lockout, closing out a job', run: generateSop },
  { key: 'customer_risk_review', name: 'Customer risk review', description: 'Customers with credit, margin, rebid or relationship risk, ranked by what is at stake.', input: 'none', run: (ctx) => customerRiskReview(ctx) },
  { key: 'pricing_leakage', name: 'Pricing leakage analysis', description: 'Waived fees, discounts outside policy, prices that never went up, stale rate tables and unbilled work.', input: 'none', run: (ctx) => pricingLeakage(ctx) },
  { key: 'incident_investigation', name: 'Incident investigation', description: 'Failure history, how the diagnosis evolved, the fix, and whether it stopped, from work orders, email, interviews and video.', input: 'entity', placeholder: 'An asset, site or customer', run: incidentInvestigation },
  { key: 'obsolete_knowledge', name: 'Obsolete knowledge detector', description: 'Rules replaced elsewhere, drafts treated as final, wrong training material and systems that disagree.', input: 'none', run: (ctx) => obsoleteKnowledge(ctx) },
  { key: 'training_plan', name: 'Employee training plan', description: 'Safety, how the work is done here, customer quirks and who to learn from, for a role.', input: 'topic', placeholder: 'A role, e.g. technician, dispatcher', run: trainingPlan },
  { key: 'seller_interview_planner', name: 'Seller interview planner', description: 'Questions to ask before knowledge leaves: conflicts, hearsay, single-person knowledge and outdated rules.', input: 'person', placeholder: 'A person who is leaving (or leave empty)', run: sellerInterviewPlanner },
]

export async function runSkill(ctx: ToolCtx, key: string, input: SkillInput = {}): Promise<Report> {
  const s = SKILLS.find((x) => x.key === key)
  if (!s) throw new Error(`Unknown skill ${key}`)
  return s.run(ctx, input)
}

/** Plain-text rendering (sharing, exports, LLM write-ups). */
export function reportMarkdown(r: Report): string {
  const lines = [`# ${r.title}`, '']
  for (const s of r.sections) {
    lines.push(`## ${s.heading}`)
    if (s.hint) lines.push(`_${s.hint}_`)
    if (s.table) {
      lines.push(`| ${s.table.columns.join(' | ')} |`, `| ${s.table.columns.map(() => '---').join(' | ')} |`)
      for (const row of s.table.rows) lines.push(`| ${row.join(' | ')} |`)
    }
    for (const i of s.items) lines.push(`- ${i.status && i.status !== 'current' ? `[${i.status}] ` : ''}${i.text}${i.when ? ` (${i.when})` : ''}${i.cites.length ? ` ${i.cites.map((n) => `[${n}]`).join('')}` : ''}${i.detail ? `\n  - ${i.detail}` : ''}`)
    lines.push('')
  }
  if (r.gaps.length) lines.push('## Gaps', ...r.gaps.map((g) => `- ${g}`), '')
  lines.push('## Sources', ...r.sources.map((s) => `${s.n}. ${s.title} · ${s.where}`))
  return lines.join('\n')
}

/** Starting points for each skill, from this client's own record (the most-documented customers, people, assets, procedures). */
export async function skillExamples(ctx: ToolCtx): Promise<Record<string, string[]>> {
  const top = async (type: string, kinds: string[] | null, n: number) =>
    (
      await ctx.sql.query<{ name: string }>(
        `select s.canonical_name name from public.facts f join public.entities s on s.id = f.subject_entity_id join public.entity_types t on t.id = s.entity_type_id
         where f.tenant_id = $1 and t.name = $2 and f.metadata ->> 'layer' = 'canonical' and f.status not in ('rejected', 'superseded')
           and ($3::text[] is null or f.metadata ->> 'kind' = any($3::text[]))
         group by 1 order by count(*) desc limit $4`,
        [ctx.tenantId, type, kinds, n],
      )
    ).rows.map((r) => r.name)
  const [customers, people, assets, procedures] = await Promise.all([top('Customer', null, 3), top('Person', ['key_person'], 2), top('Asset', null, 2), top('Term', ['policy', 'practice'], 3)])
  return {
    customer_dossier: customers,
    key_person_audit: ['', ...people],
    generate_sop: procedures,
    incident_investigation: assets,
    training_plan: [],
    seller_interview_planner: [...people, ''],
  }
}
