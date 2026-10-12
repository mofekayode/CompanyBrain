// Dev tool: propose new entity aliases from what the company's own prose calls things, with the
// quote that supports each. Read-only: nothing is written to the database. The output is a review
// file for the FDE (evals/<slug>/alias-candidates.json), not a load.
// Usage: npx tsx scripts/mine-aliases.ts <slug> [--out <path>] [--top 40]
//
// Four patterns, all over prose evidence (text, ocr, email_body, transcript_segment, video_segment; tables skipped):
//   parenthetical  "Blue Ridge Mills (BRM)", "BRM (Blue Ridge)", "X, aka Y", "X (we call it Y)", "\"Y\" for X", "goes by Y",
//                  "everybody calls it Y", "known as Y", "Y is what we call X", "X, the Y". One side must link to a known entity.
//   nickname       a capitalised short form, a quoted term or "the <noun>" within 12 words of a known entity mention,
//                  repeated in at least two passages, and mostly seen near that entity (not a word that is everywhere).
//   initialism     the initials of a multi-word name ("OVCS", "LMRWA") seen at least twice as a standalone token.
//   short_form     the first word or two of a customer / vendor name ("Kemper", "Big Walnut") standing alone in a passage
//                  that also names the company in full; skipped when the word is ordinary English or shared by several companies.
//   chat_handle    text-message sender labels ("Sam O:", "Steve K:", "Big Mike:") matched to exactly one person by last initial
//                  and first name or its usual short form (Sam / Samuel, Steve / Steven, Tony / Anthony).
// Exclusions: already an alias (normalized) of anything; the canonical name of another live entity; under 3 characters
// unless an uppercase initialism; generic words; a person's first name alone unless only one person has it.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadDictionary, linkText, normalize, type Dictionary } from '../src/search/linker'
import { pool } from '../src/workbench/server'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const outArg = flag('--out')
const top = Number(flag('--top') ?? 40)
const slug = args[0]
if (!slug) {
  console.error('usage: npx tsx scripts/mine-aliases.ts <slug> [--out <path>] [--top 40]')
  process.exit(1)
}

const TARGET_TYPES = new Set(['Customer', 'Person', 'Site', 'Asset', 'Vendor', 'Branch'])
const PROSE_KINDS = ['text', 'ocr', 'email_body', 'transcript_segment', 'video_segment']
const WINDOW = 12
const QUOTE_MAX = 160

/** Words that name a kind of thing, not a thing: never an alias on their own. */
const GENERIC = new Set(
  `customer customers client clients account accounts plant plants pump pumps site sites truck trucks van branch branches shop shops job jobs office warehouse
   facility facilities building place places thing things stuff company companies vendor vendors supplier part parts invoice invoices quote quotes order orders
   work motor motors unit units system systems skid skids tank tanks line lines guy guys team teams crew people person folks contract contracts deal deals
   project projects dispatch service services tech techs meeting call calls email emails phone phones week weeks month months year years day days morning
   afternoon tonight today tomorrow yesterday time times hour hours minute minutes number numbers price prices rate rates cost costs list lists sheet sheets
   board boards book books copy copies note notes file files report reports form forms page pages table tables one ones way ways end ends side sides
   front back top bottom left right new old big little small main other same first last next total rest lot lots bit kind sort type kinds sorts types
   speaker subject date from sent cc bcc re fw fwd attachment attachments regards thanks thank hi hello hey dear sincerely best
   monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december
   mon tue wed thu fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec am pm ok okay yes yeah no nope
   north south east west northern southern eastern western county city state street road rd ave avenue dr drive hwy highway lane ln blvd
   usa us ohio kentucky indiana ky oh in cincinnati louisville columbus
   fieldline quickbooks qb crm excel outlook iphone chrome google zoom teams
   shared mobile cell home desk voicemail inc llc co corp corporation ltd company incorporated valid attn ref page t&m pos wos pl ste blvd`
    .split(/\s+/)
    .filter(Boolean),
)
/** Job titles and roles: "(General Manager)" after a name is a role, not a nickname. */
const ROLE_WORDS = new Set(
  `manager managers supervisor supervisors director directors coordinator controller owner owners president vp ceo cfo coo gm engineer engineers technician
   technicians tech dispatcher dispatchers accountant bookkeeper admin administrator assistant lead foreman estimator buyer purchasing sales inside outside field
   billing payable receivable payroll hr safety quality general operations ops regional senior junior apprentice intern contractor consultant rep representative
   specialist analyst clerk receptionist driver mechanic electrician welder machinist millwright founder partner partners member managing operating executive
   chief principal associate maintenance quoting dispatching accounting finance marketing president`.split(/\s+/),
)
/** Function words that end a "the <noun>" phrase. */
const STOP = new Set(
  `is was are were be been being am and or but so if to of in on at for with by from as that this these those which who whom whose what when where why how
   has have had do does did will would can could should may might must not no nor up down out over under there here they we you he she it i me him her them
   us our your their its his my a an the then than just also still again back off all any some each every both few more most much very too only own same so
   such into onto about after before during through until while because since though although unless whether per via`.split(/\s+/),
)
const COMMON_INITIALISMS = new Set(
  'PM PO WO OT HR QC QA AP AR PTO LLC INC CO CORP LTD DC HQ KY OH IN USA NET QB CRM HPU LOTO SOP OSHA GL ETA ASAP FYI RE FW CC EOD COD EST AM PM TV OK NA TBD TM T&M VFD HP RPM PSI GPM ID IT'.split(
    ' ',
  ),
)
/** Acronyms of everyday business that are never a nickname ("HQ" and "DC" are not here: "Oakley (HQ)" is a real alias). */
const COMMON_ACRONYMS = new Set('PPE HSA FSA RSVP FYI ASAP ETA OSHA EPA DOT FMLA COBRA SOP MSDS SDS GFCI VFD PLC HVAC AHU RTU CFM NDA LOI QOE CIM EBITDA KPI ROI PDF CSV API URL HTTP ID IDS AP AR PM PO WO OT HR QC QA PTO GL IT LLC INC CO CORP LTD'.split(' '))
const LEGAL = /^(inc|llc|co|corp|corporation|company|ltd|incorporated|the|of|and|&|a|an)$/i

type Pattern = 'parenthetical' | 'nickname' | 'initialism' | 'short_form' | 'chat_handle'
interface Example {
  source: string
  quote: string
}
interface Candidate {
  entity: string
  entity_type: string
  alias: string
  pattern: string
  count: number
  examples: Example[]
  note?: string
}
interface Evidence {
  id: string
  kind: string
  content: string
  source: string
}
interface Word {
  w: string
  start: number
  end: number
}
interface Span {
  entityId: string
  type: string
  from: number // word index, inclusive
  to: number // word index, inclusive
}

const db = pool()
const t0 = Date.now()
const tenant = (await db.query<{ id: string; name: string }>(`select id, name from public.tenants where slug = $1`, [slug])).rows[0]
if (!tenant) {
  console.error(`no tenant with slug ${slug}`)
  process.exit(1)
}
// The company's own name is on every signature and letterhead: never a nickname for anything.
for (const w of normalize(tenant.name).split(' ')) if (w.length >= 3) GENERIC.add(w)

// --- Known names -------------------------------------------------------------------------------
const dict: Dictionary = await loadDictionary(db, tenant.id)
const liveRows = (
  await db.query<{ id: string; name: string; type: string; aliases: string[] }>(
    `select e.id, e.canonical_name name, t.name type,
            array(select a.alias from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected') aliases
     from public.entities e join public.entity_types t on t.id = e.entity_type_id
     where e.tenant_id = $1 and e.status in ('candidate', 'active') and e.merged_into_id is null`,
    [tenant.id],
  )
).rows
const live = new Map(liveRows.map((r) => [r.id, r]))
const targets = liveRows.filter((r) => TARGET_TYPES.has(r.type))
// Every non-rejected alias of anything, normalized.
const knownAliases = new Set<string>()
for (const r of (
  await db.query<{ alias: string; normalized_alias: string | null }>(
    `select a.alias, a.normalized_alias from public.entity_aliases a join public.entities e on e.id = a.entity_id where e.tenant_id = $1 and a.status <> 'rejected'`,
    [tenant.id],
  )
).rows) {
  knownAliases.add(normalize(r.alias))
  if (r.normalized_alias) knownAliases.add(r.normalized_alias)
}
// Canonical names of live things (Terms are vocabulary, handled below).
const canonicalOf = new Map<string, Set<string>>()
for (const r of liveRows) {
  if (r.type === 'Term') continue
  const n = normalize(r.name)
  canonicalOf.set(n, (canonicalOf.get(n) ?? new Set()).add(r.id))
}
// Terms: known when they point at something (refers_to) or carry aliases; otherwise only noted.
const termRefers = new Set(
  (
    await db.query<{ term: string }>(
      `select r.source_entity_id term from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id and rt.name = 'refers_to'
       where r.tenant_id = $1 and r.status <> 'rejected'`,
      [tenant.id],
    )
  ).rows.map((r) => r.term),
)
const looseTerms = new Map<string, string>() // normalized term name → term name, for Terms with no refers_to
for (const r of liveRows) {
  if (r.type !== 'Term') continue
  if (termRefers.has(r.id) || r.aliases.length) knownAliases.add(normalize(r.name))
  else looseTerms.set(normalize(r.name), r.name)
}
// People: how many share a first name (first names alone are aliases only when unique).
const firstNames = new Map<string, Set<string>>()
for (const r of liveRows) {
  if (r.type !== 'Person' && r.type !== 'Customer Contact') continue
  for (const n of [r.name, ...r.aliases]) {
    const first = normalize(n).split(' ')[0]
    if (first && first.length >= 3) firstNames.set(first, (firstNames.get(first) ?? new Set()).add(r.id))
  }
}

// "Blue Ridge Food Processing LLC" is also known without the suffix.
for (const r of liveRows) {
  const bare = r.name.replace(/\b(llc|inc|co|corp|ltd|company)\.?$/i, '').replace(/[,.]\s*$/, '').trim()
  if (r.type !== 'Term' && bare && bare !== r.name) knownAliases.add(normalize(bare))
}
// Known = in the alias table, a live canonical name, or vocabulary that already points somewhere. The linker's own
// guessed shorthands ("sycamore", "tammy") are not in the table, so they can still be proposed for it.
const isKnown = (alias: string) => {
  const n = normalize(alias)
  return !n || knownAliases.has(n) || canonicalOf.has(n)
}

/** Why a candidate is unusable, or null when it passes. */
function reject(alias: string, entityId: string): string | null {
  const raw = alias.trim()
  const n = normalize(raw)
  if (!n) return 'empty'
  const toks = n.split(' ')
  if (toks.length > 5) return 'too long'
  if (/^\d[\d.,:/-]*$/.test(n) || /^\d+ ?(am|pm)$/.test(n)) return 'number'
  if (n.length < 3 && !/^[A-Z]{2}$/.test(raw)) return 'too short'
  if (isKnown(raw)) return 'known'
  const others = canonicalOf.get(n)
  if (others && [...others].some((id) => id !== entityId)) return 'canonical name of another entity'
  if (toks.every((x) => GENERIC.has(x) || STOP.has(x) || ROLE_WORDS.has(x))) return 'generic'
  if (/^[A-Z&-]+$/.test(raw) && COMMON_ACRONYMS.has(raw)) return 'generic'
  if (toks.some((x) => ROLE_WORDS.has(x))) return 'role'
  if (toks.length === 1 && firstNames.has(toks[0]) && firstNames.get(toks[0])!.size > 1) return 'shared first name'
  const e = live.get(entityId)
  if (e) {
    // "Galvanizing" for Midwest Galvanizing: an inner word of the name is not a safe shorthand.
    const nameToks = normalize(e.name).split(' ')
    if (toks.length === 1 && nameToks.slice(1).includes(toks[0]) && !/^[A-Z]{2,}$/.test(raw)) return 'inner word of own name'
  }
  return null
}

// --- Evidence ----------------------------------------------------------------------------------
// Prose is small enough to hold (the tables are what is big); still read it in id-ordered chunks.
const evidence: Evidence[] = []
let lastId = '00000000-0000-0000-0000-000000000000'
for (;;) {
  const chunk = (
    await db.query<Evidence>(
      `select ev.id, ev.kind, ev.content, so.original_path source
       from public.evidence ev
       join public.document_versions dv on dv.id = ev.document_version_id
       join public.source_objects so on so.id = dv.source_object_id
       where ev.tenant_id = $1 and ev.kind = any($2) and ev.id > $3 and length(ev.content) > 0
       order by ev.id limit 500`,
      [tenant.id, PROSE_KINDS, lastId],
    )
  ).rows
  if (!chunk.length) break
  evidence.push(...chunk)
  lastId = chunk[chunk.length - 1].id
}
console.log(`${slug}: ${evidence.length} prose passages, ${targets.length} live entities of ${[...TARGET_TYPES].join('/')}, ${knownAliases.size} known aliases (${(Date.now() - t0) / 1000}s)`)

// --- Tokenising and position-aware linking --------------------------------------------------------
const WORD = /[A-Za-z0-9][A-Za-z0-9'’.&-]*[A-Za-z0-9]|[A-Za-z0-9]/g
function words(text: string): Word[] {
  const out: Word[] = []
  for (const m of text.matchAll(WORD)) out.push({ w: m[0], start: m.index!, end: m.index! + m[0].length })
  return out
}

/** Same resolution as linkText, but every occurrence with its word positions. */
function linkSpans(ws: Word[]): Span[] {
  const toks: { tok: string; word: number }[] = []
  ws.forEach((w, i) => {
    for (const tok of normalize(w.w).split(' ')) if (tok) toks.push({ tok, word: i })
  })
  const spans: Span[] = []
  for (let i = 0; i < toks.length; i++) {
    for (let len = Math.min(dict.maxTokens, toks.length - i); len >= 1; len--) {
      const phrase = toks
        .slice(i, i + len)
        .map((x) => x.tok)
        .join(' ')
      const ids = dict.phrases.get(phrase)
      if (!ids) continue
      let real = ids.size > 1 ? [...ids].filter((id) => dict.entities.get(id)?.type !== 'Term') : [...ids]
      if (real.length > 1) {
        const j = real.filter((id) => dict.jargon?.get(phrase)?.has(id))
        if (j.length === 1) real = j
      }
      if (real.length === 1) {
        const e = dict.entities.get(real[0])
        if (e) spans.push({ entityId: real[0], type: e.type, from: toks[i].word, to: toks[i + len - 1].word })
      }
      i += len - 1
      break
    }
  }
  return spans
}

/** Exactly one linked entity of a target type in a piece of text, else null. */
function soleTarget(text: string): { id: string; name: string; type: string } | null {
  const hits = linkText(dict, text).filter((l) => TARGET_TYPES.has(l.type))
  return hits.length === 1 ? hits[0] : null
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
function quoteAround(text: string, at: number, len: number): string {
  const before = Math.max(0, at - 70)
  const after = Math.min(text.length, at + len + 80)
  let q = squash(text.slice(before, after))
  if (q.length > QUOTE_MAX) q = q.slice(0, QUOTE_MAX - 1).replace(/\s+\S*$/, '') + '…'
  return (before > 0 ? '…' : '') + q
}

// --- Collecting --------------------------------------------------------------------------------
interface Hit {
  entityId: string
  alias: string
  pattern: Pattern
  evidenceId: string
  example: Example
  note?: string
}
const hits: Hit[] = []
const rejected = new Map<string, number>()
function propose(entityId: string, alias: string, pattern: Pattern, ev: Evidence, at: number, len: number, note?: string) {
  const clean = alias.replace(/^[\s"“”'‘’]+|[\s"“”'‘’,.;:!?]+$/g, '').replace(/[’']s$/, '')
  const why = reject(clean, entityId)
  if (why) {
    rejected.set(why, (rejected.get(why) ?? 0) + 1)
    return
  }
  const loose = looseTerms.get(normalize(clean))
  hits.push({ entityId, alias: clean, pattern, evidenceId: ev.id, example: { source: ev.source, quote: quoteAround(ev.content, at, len) }, note: note ?? (loose ? `a Term "${loose}" exists with no refers_to link` : undefined) })
}

// "the freezer", "the foundry", "the co-op", "the water plant": a nickname of this shape names a kind of place or business.
const FACILITY = new Set(
  `plant mill freezer foundry bottler dairy distillery distilleries brewery brewhouse bakery co-op coop cooperative elevator warehouse dc yard terminal quarry
   galvanizer laundry creamery cannery packinghouse smelter refinery depot hub garage hangar airport hospital school college university church farm ranch
   feedlot pit mine headquarters store market mall tower station works rendering barn silo dock port lab laboratory kitchen cage pool brewer printer
   packer plater caster roaster slaughterhouse stockyard lumberyard sawmill glassworks ironworks waterworks greenhouse nursery orchard vineyard winery
   fab shop`.split(/\s+/),
)
const PLACE_TAIL = new Set('plant mill dc yard terminal shop warehouse building facility site store works house center centre cage pool room bay line freezer cooler lot dock'.split(' '))
const ASSET_TAIL = new Set('pump pumps compressor chiller boiler press conveyor mixer blower fan motor gearbox skid unit machine line tank crane hoist generator cooler freezer screw extruder dryer kiln oven furnace'.split(' '))
const theShapeOk = (phrase: string, type: string) => {
  const toks = phrase.toLowerCase().split(' ').slice(1)
  const last = toks[toks.length - 1]
  if (type === 'Asset') return toks.length >= 2 && ASSET_TAIL.has(last)
  if (toks.length === 1) return FACILITY.has(last) && !GENERIC.has(last)
  return (FACILITY.has(last) || PLACE_TAIL.has(last)) && !toks.every((x) => GENERIC.has(x))
}

// Pattern 1: parentheticals and "aka".
const NP = String.raw`[A-Z][\w'’.&-]*(?:\s+(?:[A-Z][\w'’.&-]*|&|of|the|de))*`
const Q = String.raw`["“][^"”\n]{2,40}["”]`
const unquote = (s: string) => s.replace(/^["“]|["”]$/g, '').trim()
/** A parenthetical that could be a name: "BRM", "Blue Ridge", "J-town", "the freezer"; not "read before Monday". */
const NAMELIKE = /^(?:[A-Z][\w'’.&-]*(?:\s+(?:[A-Z][\w'’.&-]*|&|of|the|de))*|the [a-z]+(?: [a-z]+)?)$/
const P1 = [
  // Blue Ridge Mills (BRM) · BRM (Blue Ridge) · Hartwell (the foundry) · OVCS (we call it the freezer)
  { re: new RegExp(String.raw`(${NP})\s*\(((?:we call (?:it|them|him|her)|aka|a\.k\.a\.|also known as|or)\s+)?([^()\n]{2,40})\)`, 'g'), kind: 'paren' as const },
  // X, aka Y · X a.k.a. Y · X, also known as Y · "Y", aka X
  { re: new RegExp(String.raw`(${NP}|${Q}),?\s+(?:aka|a\.k\.a\.|also known as|also called|otherwise known as|or just|or simply)\s+(${Q}|${NP}|the [a-z]+(?: [a-z]+)?)`, 'g'), kind: 'pair' as const },
  // "Y" for X · "Y" is X · "Y" means X · "Y" = X
  { re: new RegExp(String.raw`(${Q})\s+(?:for|is|means|=)\s+(${NP})`, 'g'), kind: 'pair' as const },
  // Y is what we call X · "Y" is what everybody calls X
  { re: new RegExp(String.raw`(${Q}|${NP}|the [a-z]+(?: [a-z]+)?) is what (?:we|they|everybody|everyone|people|the guys|the techs) (?:all )?call (${NP})`, 'g'), kind: 'pair' as const },
  // everybody calls it Y · people call them Y · known as Y · goes by Y (the known side is the sole entity in the sentence)
  {
    re: new RegExp(
      String.raw`(?:(?:everybody|everyone|people|we|they|the guys|the techs|customers?|drivers?|nobody) (?:all |just |still )?(?:calls?|says?|refers? to) (?:it|them|him|her|that|that place|the place|the plant|the site)?\s*(?:as )?|known as |goes by |called )(${Q}|${NP}|the [a-z]+(?: [a-z]+)?)`,
      'g',
    ),
    kind: 'sole' as const,
  },
  // Hartwell, the foundry, … · Midwest Galvanizing, the galvanizer.
  { re: new RegExp(String.raw`(${NP}), (the [a-z]+(?: [a-z]+)?)(?=[,.;:]|$)`, 'gm'), kind: 'appos' as const },
]
/** Could `short` be an abbreviation or truncation of `long`? (BRM ↔ Blue Ridge Mills, Kemper ↔ Kemper Plastics) */
function abbreviates(short: string, long: string): boolean {
  const s = normalize(short).split(' ')
  const l = normalize(long).split(' ')
  if (s.length && s.every((x, i) => l[i] === x)) return true
  if (s.length === 1 && /^[A-Za-z]{2,6}$/.test(s[0])) {
    const letters = s[0].split('')
    let j = 0
    for (const w of l) if (j < letters.length && w[0] === letters[j]) j++
    return j === letters.length
  }
  return false
}
function pair(ev: Evidence, x: string, y: string, at: number, len: number) {
  const ex = soleTarget(x)
  const ey = soleTarget(y)
  if (ex && !ey && !isKnown(y)) propose(ex.id, y, 'parenthetical', ev, at, len)
  else if (ey && !ex && !isKnown(x) && abbreviates(x, ey.name)) propose(ey.id, x, 'parenthetical', ev, at, len)
}
for (const ev of evidence) {
  const sentences = ev.content.split(/(?<=[.!?])\s+|\n+/)
  let offset = 0
  for (const s of sentences) {
    const at0 = ev.content.indexOf(s, offset)
    offset = at0 + s.length
    for (const { re, kind } of P1) {
      re.lastIndex = 0
      for (const m of s.matchAll(re)) {
        const at = at0 + m.index!
        if (kind === 'paren') {
          const [, x, marker, inner] = m
          if (marker) {
            // "(we call it Y)" / "(aka Y)": X is the known side.
            const ex = soleTarget(x)
            if (ex && !isKnown(inner)) propose(ex.id, inner, 'parenthetical', ev, at, m[0].length)
          } else if (NAMELIKE.test(inner.trim())) pair(ev, x, inner, at, m[0].length)
        } else if (kind === 'pair') pair(ev, unquote(m[1]), unquote(m[2]), at, m[0].length)
        else if (kind === 'appos') {
          const ex = soleTarget(m[1])
          if (ex && TARGET_TYPES.has(ex.type) && ex.type !== 'Person' && !isKnown(m[2]) && theShapeOk(m[2], ex.type)) propose(ex.id, m[2], 'parenthetical', ev, at, m[0].length)
        } else {
          const y = unquote(m[1])
          const sole = soleTarget(s.replace(m[1], ' '))
          if (sole && !isKnown(y)) propose(sole.id, y, 'parenthetical', ev, at, m[0].length)
        }
      }
    }
  }
}
const p1Done = Date.now()

/** Usual short forms of first names, so "Sam O" and "Big Mike" can meet Samuel and Michael. */
const SHORT_NAMES: Record<string, string[]> = {
  sam: ['samuel', 'samantha'], steve: ['steven', 'stephen'], tony: ['anthony'], mike: ['michael'], zach: ['zachary'], nate: ['nathan', 'nathaniel'], josh: ['joshua'],
  jake: ['jacob'], ben: ['benjamin'], dave: ['david'], kev: ['kevin'], kenny: ['kenneth'], ken: ['kenneth'], rusty: ['russell'], hank: ['henry'], frank: ['francis'],
  phil: ['phillip', 'philip'], patty: ['patricia'], pat: ['patricia', 'patrick'], bri: ['brianna'], jas: ['jasmine'], ray: ['raymond'], ron: ['ronald'], nick: ['nicholas'],
  matt: ['matthew'], chris: ['christopher', 'christine'], rob: ['robert'], bob: ['robert'], bobby: ['robert'], jim: ['james'], tom: ['thomas'], andy: ['andrew'],
  dan: ['daniel'], joe: ['joseph'], greg: ['gregory'], ty: ['tyler'], alex: ['alexander', 'alexandra'], will: ['william'], bill: ['william'], ed: ['edward'],
  liz: ['elizabeth'], beth: ['elizabeth'], kate: ['katherine'], katie: ['katherine'], jen: ['jennifer'], jenny: ['jennifer'], mandy: ['amanda'], dee: ['denise'],
  gabe: ['gabriel'], vic: ['victor'], jon: ['jonathan'], don: ['donald'], tim: ['timothy'], jeff: ['jeffrey'], mel: ['melissa'], deb: ['deborah'], sue: ['susan'],
}
const sameFirst = (label: string, name: string) => {
  const a = normalize(label).split(' ')[0]
  const b = normalize(name).split(' ')[0]
  if (!a || !b) return false
  return a === b || (SHORT_NAMES[a] ?? []).includes(b) || (SHORT_NAMES[b] ?? []).includes(a)
}

// Pattern 2: nicknames in speech (near a known entity mention, repeated, and mostly seen near that entity).
// Email headers, calendar lines, chat sender labels and signature footers are not speech: blank them (keeping offsets).
const MASK = [
  /^(?:From|To|Cc|Bcc|Date|Sent|Subject|Reply-To|Attachments?):.*$/gim,
  /^(?:ATTENDEE|ORGANIZER|SUMMARY|DTSTART|DTEND|UID|BEGIN|END|DESCRIPTION|LOCATION|RRULE|SEQUENCE|STATUS|TRANSP|CLASS|CREATED|LAST-MODIFIED|DTSTAMP)[;:].*$/gm,
  /^\[[\d-]+ [\d:]+ (?:AM|PM)\] [^:\n]{1,40}:/gm,
  /Sent from my iPhone/g,
  /^.*\|.*\|.*\|.*$/gm, // pipe-delimited lines are tables in disguise ("Reg Hrs 4.5 | OT Hrs 0.0 | Labor Rate")
]
const blank = (m: string) => ' '.repeat(m.length)
const speech = new Map<string, string>()
for (const ev of evidence) {
  let c = ev.content
  for (const re of MASK) c = c.replace(re, blank)
  speech.set(ev.id, c)
}
// People named in mail headers ("Owen Mercer <omercer@...>") are correspondents, not nicknames of whoever they write to.
const headerNames = new Set<string>()
const headerSurnames = new Set<string>()
for (const ev of evidence) {
  for (const m of ev.content.matchAll(/(?:^|[:,]\s*)([A-Z][\w'’.-]+(?: [A-Z][\w'’.-]+){1,2}) <[^>\s]+@[^>\s]+>/gm)) {
    headerNames.add(normalize(m[1]))
    const toks = normalize(m[1]).split(' ')
    if (toks.length >= 2) headerSurnames.add(toks[toks.length - 1])
  }
}
// Corpus word statistics: which capitalised words are names and which are just sentence starts.
const capMid = new Map<string, number>()
const lower = new Map<string, number>()
const phraseTotal = new Map<string, number>() // "the galvanizer" everywhere in the corpus
/** "the <noun phrase>" starting at word i (after "the"): up to three lowercase words, stopping at function words. */
const thePhrase = (ws: Word[], i: number, inSpan?: boolean[]) => {
  let j = i
  while (j < ws.length && j - i < 3 && /^[a-z]/.test(ws[j].w) && !STOP.has(ws[j].w.toLowerCase()) && !(inSpan && inSpan[j]) && (j === i || ws[j].start - ws[j - 1].end === 1)) j++
  return j > i ? { to: j - 1, text: `the ${ws.slice(i, j).map((w) => w.w).join(' ')}` } : null
}
for (const ev of evidence) {
  const text = speech.get(ev.id)!
  const ws = words(text)
  ws.forEach((w, i) => {
    const key = w.w.toLowerCase()
    if (/^[A-Z]/.test(w.w)) {
      const prev = i > 0 ? text.slice(ws[i - 1].end, w.start) : '\n'
      if (!/[.!?:\n"“|\]]/.test(prev) && i > 0) capMid.set(key, (capMid.get(key) ?? 0) + 1)
    } else if (/^[a-z]/.test(w.w)) lower.set(key, (lower.get(key) ?? 0) + 1)
    if (key === 'the' && i + 1 < ws.length) {
      const ph = thePhrase(ws, i + 1)
      if (ph) phraseTotal.set(ph.text.toLowerCase(), (phraseTotal.get(ph.text.toLowerCase()) ?? 0) + 1)
    }
  })
  for (const m of text.matchAll(/["“]([^"”\n]{2,40})["”]/g)) {
    const key = normalize(m[1])
    phraseTotal.set(key, (phraseTotal.get(key) ?? 0) + 1)
  }
}
const properish = (w: string) => {
  const key = w.toLowerCase()
  const cap = capMid.get(key) ?? 0
  const low = lower.get(key) ?? 0
  return cap >= 1 && low <= cap
}
/** Does the alias share a word, an abbreviation or a first name with the entity's names? */
const lexicalLink = (alias: string, e: { name: string; type: string; aliases: string[] }) => {
  const names = [e.name, ...e.aliases]
  const toks = normalize(alias).split(' ').filter((x) => x.length >= 3 && !GENERIC.has(x) && !STOP.has(x))
  for (const n of names) {
    if (abbreviates(alias, n)) return true
    const nt = new Set(normalize(n).split(' '))
    if (toks.some((x) => nt.has(x))) return true
    if (e.type === 'Person' && sameFirst(alias, n)) return true
  }
  return false
}
const capRunTotal = new Map<string, number>()
interface Near {
  entityId: string
  alias: string
  ev: Evidence
  at: number
  len: number
}
const nears: Near[] = []
for (const ev of evidence) {
  const text = speech.get(ev.id)!
  const ws = words(text)
  if (!ws.length) continue
  const spans = linkSpans(ws).filter((s) => TARGET_TYPES.has(s.type))
  if (!spans.length) continue
  const inSpan = new Array<boolean>(ws.length).fill(false)
  for (const s of spans) for (let i = s.from; i <= s.to; i++) inSpan[i] = true
  const gap = (a: number, b: number) => text.slice(ws[a].end, ws[b].start) // text between two words
  // Capitalised runs (1-3 words on one line) outside any linked span.
  const runs: { from: number; to: number; text: string }[] = []
  const spanEndingAt = new Map(spans.map((s) => [s.to, s]))
  const spanStartingAt = new Map(spans.map((s) => [s.from, s]))
  const combined: { from: number; to: number; text: string; entityId: string }[] = []
  for (let i = 0; i < ws.length; i++) {
    if (inSpan[i] || !/^[A-Z]/.test(ws[i].w)) continue
    let j = i
    while (j + 1 < ws.length && j - i < 2 && !inSpan[j + 1] && /^[A-Z]/.test(ws[j + 1].w) && gap(j, j + 1) === ' ') j++
    const run = ws.slice(i, j + 1)
    const runText = text.slice(run[0].start, run[run.length - 1].end)
    const after = text.slice(run[run.length - 1].end, run[run.length - 1].end + 2)
    const n = normalize(runText)
    const ok =
      properish(run[0].w) &&
      !run.some((w) => GENERIC.has(w.w.toLowerCase()) || STOP.has(w.w.toLowerCase()) || (w.w.length <= 2 && !/^[A-Z]+$/.test(w.w))) && // "Pl", "St" are not names
      !/^\s?[:=]/.test(after) && // "Valid: 30 days", "CN=…" are field labels
      !headerNames.has(n) &&
      !(run.length === 1 && headerSurnames.has(n)) &&
      !(run.length >= 2 && (firstNames.has(n.split(' ')[0]) || headerSurnames.has(n.split(' ').pop()!))) // somebody's full name
    if (ok) {
      runs.push({ from: i, to: j, text: runText })
      capRunTotal.set(n, (capRunTotal.get(n) ?? 0) + 1)
      // A run glued to a mention is a longer form of the name: "Harmon DC", "Derby City", "BR Hamilton", "Big Mike".
      const before = i > 0 ? spanEndingAt.get(i - 1) : undefined
      if (before && before.type !== 'Person' && gap(i - 1, i) === ' ') combined.push({ from: before.from, to: j, text: text.slice(ws[before.from].start, ws[j].end), entityId: before.entityId })
      const after = spanStartingAt.get(j + 1)
      if (after && gap(j, j + 1) === ' ') combined.push({ from: i, to: after.to, text: text.slice(ws[i].start, ws[after.to].end), entityId: after.entityId })
    }
    i = j
  }
  // "the <noun>" phrases outside spans.
  const thes: { from: number; to: number; text: string }[] = []
  for (let i = 0; i + 1 < ws.length; i++) {
    if (ws[i].w.toLowerCase() !== 'the' || inSpan[i]) continue
    const ph = thePhrase(ws, i + 1, inSpan)
    if (ph) thes.push({ from: i, to: ph.to, text: ph.text })
  }
  // Quoted terms.
  const quotes: { from: number; to: number; text: string }[] = []
  for (const m of text.matchAll(/["“]([^"”\n]{2,40})["”]/g)) {
    const a = m.index! + 1
    const b = a + m[1].length
    const idx = ws.map((w, i) => (w.start >= a && w.end <= b ? i : -1)).filter((i) => i >= 0)
    if (!idx.length || idx.length > 3 || idx.some((i) => inSpan[i]) || /[_{}<>=/\\]/.test(m[1])) continue
    quotes.push({ from: idx[0], to: idx[idx.length - 1], text: m[1].trim() })
  }
  const near = (c: { from: number; to: number }, s: Span) => c.from <= s.to + WINDOW && c.to >= s.from - WINDOW && (c.to < s.from || c.from > s.to)
  // A run glued to the mention continues its name ("Owen Mercer", "Hamilton & Pierce"), except a prefix on a place ("BR Hamilton").
  const continues = (c: { from: number; to: number }, s: Span) => {
    const g = c.to < s.from ? gap(c.to, s.from) : c.from > s.to ? gap(s.to, c.from) : ''
    if (/^\s*(?:&|and)\s*$/.test(g)) return true
    if (!/^[ \t]$/.test(g)) return false
    return s.type === 'Person' || c.from > s.to
  }
  // Each candidate goes with the nearest mention only ("Oakley (HQ) | Grove City" names Oakley, not Grove City).
  const distance = (c: { from: number; to: number }, s: Span) => (c.to < s.from ? s.from - c.to : c.from - s.to)
  const nearest = (c: { from: number; to: number }, ok: (s: Span) => boolean) => {
    let hit: Span | null = null
    for (const s of spans) if (ok(s) && near(c, s) && !continues(c, s) && (!hit || distance(c, s) < distance(c, hit))) hit = s
    return hit
  }
  const push = (c: { from: number; to: number; text: string }, s: Span | null) => {
    if (s) nears.push({ entityId: s.entityId, alias: c.text, ev, at: ws[c.from].start, len: ws[c.to].end - ws[c.from].start })
  }
  for (const c of runs) push(c, nearest(c, () => true))
  for (const c of combined) nears.push({ entityId: c.entityId, alias: c.text, ev, at: ws[c.from].start, len: ws[c.to].end - ws[c.from].start })
  for (const c of thes) push(c, nearest(c, (s) => s.type !== 'Person' && theShapeOk(c.text, s.type)))
  for (const c of quotes) push(c, nearest(c, () => true))
}
{
  // Keep (entity, nickname) pairs seen in at least two passages, where that entity accounts for at least half of the nickname's uses.
  const byPair = new Map<string, Near[]>()
  for (const n of nears) {
    const key = `${n.entityId}|${normalize(n.alias)}`
    byPair.set(key, [...(byPair.get(key) ?? []), n])
  }
  // Each nickname goes to the entity it is seen with most ("HQ" is Oakley, even though Grove City is on the same letterhead).
  const best = new Map<string, number>()
  for (const [key, list] of byPair) {
    const norm = key.split('|')[1]
    best.set(norm, Math.max(best.get(norm) ?? 0, new Set(list.map((n) => n.ev.id)).size))
  }
  for (const [key, list] of byPair) {
    const passages = new Set(list.map((n) => n.ev.id))
    const [entityId, norm] = key.split('|')
    if (passages.size < 2 || passages.size < best.get(norm)!) continue
    const e = live.get(entityId)
    if (!e) continue
    const first = list[0].alias
    const isThe = first.toLowerCase().startsWith('the ')
    const total = isThe ? (phraseTotal.get(first.toLowerCase()) ?? passages.size) : (capRunTotal.get(norm) ?? phraseTotal.get(norm) ?? passages.size)
    const share = passages.size / Math.max(total, passages.size)
    if (/\d/.test(first) && e.type !== 'Asset') continue
    if (isThe) {
      if (share < 0.5) continue
    } else if (!lexicalLink(first, e)) {
      // No word in common with the name ("J-town", "Big Blue"): needs more repetition, and almost always this entity.
      if (passages.size < 3 || share < (e.type === 'Person' ? 0.8 : 0.6)) continue
    }
    const seen = new Set<string>()
    for (const n of list) {
      if (seen.has(n.ev.id)) continue
      seen.add(n.ev.id)
      propose(n.entityId, n.alias, 'nickname', n.ev, n.at, n.len)
    }
  }
}
const p2Done = Date.now()

// Pattern 3: initialisms of multi-word names.
const initialismOf = new Map<string, Set<string>>() // "OVCS" → entity ids
for (const e of targets) {
  if (e.type === 'Asset') continue
  const bare = e.name.replace(/\s*[(-].*$/, '') // "Columbus Branch (Grove City)" → "Columbus Branch"
  for (const name of new Set([e.name, bare])) {
    const toks = name.split(/[\s/]+/).filter((w) => /^[A-Za-z]/.test(w) && !LEGAL.test(w))
    if (toks.length < 2) continue
    const ini = toks.map((w) => w[0].toUpperCase()).join('')
    if (ini.length < 2 || ini.length > 6) continue
    initialismOf.set(ini, (initialismOf.get(ini) ?? new Set()).add(e.id))
    // "OV gate code", "BR Hamilton": the first two words of a long name, as initials.
    if (toks.length >= 3 && e.type !== 'Person') {
      const two = ini.slice(0, 2)
      initialismOf.set(two, (initialismOf.get(two) ?? new Set()).add(e.id))
    }
  }
}
const wanted = [...initialismOf.keys()].filter((ini) => !COMMON_INITIALISMS.has(ini) && !isKnown(ini) && !canonicalOf.has(normalize(ini)))
if (wanted.length) {
  const re = new RegExp(String.raw`(?<![A-Za-z0-9-])(${wanted.sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z0-9=-])`, 'g')
  const occ = new Map<string, { ev: Evidence; at: number; entityId: string }[]>()
  for (const ev of evidence) {
    let linked: Set<string> | null = null
    for (const m of ev.content.matchAll(re)) {
      const ini = m[1]
      // "LA GRANGE PLATING": initials-looking words inside an all-caps name are not initialisms.
      const before = ev.content.slice(Math.max(0, m.index! - 12), m.index!)
      const afterText = ev.content.slice(m.index! + ini.length, m.index! + ini.length + 12)
      if (/[A-Z]{3,}[.,]? ?$/.test(before) || /^[ .,]?[A-Z]{3,}\b/.test(afterText)) continue
      const ids = initialismOf.get(ini)!
      let entityId: string | undefined
      if (ids.size === 1) entityId = [...ids][0]
      else {
        // Shared initials (HC: Harrison Coatings, Hilliard Concrete): only when the passage names one of them in full.
        linked ??= new Set(linkText(dict, ev.content).map((l) => l.id))
        const here = [...ids].filter((id) => linked!.has(id))
        if (here.length === 1) entityId = here[0]
      }
      if (!entityId) continue
      occ.set(ini, [...(occ.get(ini) ?? []), { ev, at: m.index!, entityId }])
    }
  }
  for (const [ini, list] of occ) {
    const byEntity = new Map<string, typeof list>()
    for (const o of list) byEntity.set(o.entityId, [...(byEntity.get(o.entityId) ?? []), o])
    for (const [entityId, os] of byEntity) {
      const docs = new Set(os.map((o) => o.ev.id)).size
      if (docs < 2 || (ini.length === 2 && (docs < 3 || live.get(entityId)?.type === 'Person'))) continue
      for (const o of os) propose(entityId, ini, 'initialism', o.ev, o.at, ini.length)
    }
  }
}
const p3Done = Date.now()

// Pattern 4: short forms of customer / vendor names, standing alone in a passage that also names the company in full.
const COMMON_SHORT = new Set('new west east north south great little big river mill spring queen tri mid mt la walk reliable united american national general first central valley'.split(' '))
const shortForms = new Map<string, Set<string>>() // normalized short form → entity ids
for (const e of targets) {
  if (e.type !== 'Customer' && e.type !== 'Vendor') continue
  const toks = normalize(e.name).split(' ')
  if (toks.length < 2) continue
  const forms = [toks[0]]
  if (toks.length >= 3 && !LEGAL.test(toks[1])) forms.push(`${toks[0]} ${toks[1]}`)
  for (const f of forms) {
    if (f.length < 3 || /\d/.test(f) || COMMON_SHORT.has(f) || LEGAL.test(f) || f.split(' ').some((x) => GENERIC.has(x))) continue
    shortForms.set(f, (shortForms.get(f) ?? new Set()).add(e.id))
  }
}
let ambiguousShort = 0
let englishShort = 0
for (const [form, ids] of [...shortForms]) {
  if (ids.size > 1) {
    ambiguousShort++
    shortForms.delete(form)
    continue
  }
  const w = form.split(' ')[0]
  if ((lower.get(w) ?? 0) > 0 && (lower.get(w) ?? 0) >= (capMid.get(w) ?? 0)) {
    englishShort++
    shortForms.delete(form)
    continue
  }
  if (isKnown(form)) shortForms.delete(form)
}
// A short form counts once the full name is seen in the same passage at least once; after that, every standalone use counts.
const shortHits = new Map<string, { anchored: boolean; ev: Evidence; at: number; len: number; text: string }[]>()
for (const ev of evidence) {
  const ws = words(ev.content)
  if (!ws.length) continue
  const spans = linkSpans(ws)
  const norm = ws.map((w) => normalize(w.w))
  // The full name (or a multi-word alias) in the passage anchors the short form: the linker's own one-word shorthand does not count.
  const present = new Set<string>()
  for (const s of spans) if (s.to > s.from) present.add(s.entityId)
  const spanAt: (Span | undefined)[] = new Array(ws.length)
  for (const s of spans) for (let i = s.from; i <= s.to; i++) spanAt[i] = s
  for (const [form, ids] of shortForms) {
    const entityId = [...ids][0]
    const ft = form.split(' ')
    // free, or covered only by the linker's one-word shorthand for this same entity
    const free = (i: number) => !spanAt[i] || (spanAt[i]!.entityId === entityId && spanAt[i]!.from === spanAt[i]!.to)
    for (let i = 0; i + ft.length <= ws.length; i++) {
      if (!free(i) || norm[i] !== ft[0]) continue
      if (ft.length === 2 && (!free(i + 1) || norm[i + 1] !== ft[1])) continue
      if (ft.length === 1 && i + 1 < ws.length && spanAt[i + 1] && spanAt[i + 1]!.from === i + 1 && spanAt[i + 1]!.entityId === entityId) continue // "Kemper Plastics" is the full name, not the short form
      // a standalone mention must be capitalised like a name
      if (!/^[A-Z]/.test(ws[i].w)) continue
      const key = `${entityId}|${form}`
      shortHits.set(key, [...(shortHits.get(key) ?? []), { anchored: present.has(entityId), ev, at: ws[i].start, len: ws[i + ft.length - 1].end - ws[i].start, text: ws.slice(i, i + ft.length).map((w) => w.w).join(' ') }])
    }
  }
}
for (const [key, list] of shortHits) {
  if (!list.some((h) => h.anchored)) continue
  const entityId = key.split('|')[0]
  for (const h of [...list].sort((a, b) => Number(b.anchored) - Number(a.anchored))) propose(entityId, h.text, 'short_form', h.ev, h.at, h.len)
}
const p4Done = Date.now()

// Pattern 5: chat sender labels. "[2025-04-21 02:30:00 PM] Steve K:" is one person, found by last initial and first name or its short form.
const people = targets.filter((e) => e.type === 'Person')
const labelHits = new Map<string, { ev: Evidence; at: number; len: number }[]>()
for (const ev of evidence) {
  for (const m of ev.content.matchAll(/^\[[\d-]+ [\d:]+ (?:AM|PM)\] ([A-Z][\w'’.-]*(?: [A-Z][\w'’.-]*){0,2}):/gm)) {
    const label = m[1].replace(/\.$/, '')
    labelHits.set(label, [...(labelHits.get(label) ?? []), { ev, at: m.index! + m[0].length - label.length - 1, len: label.length }])
  }
}
for (const [label, os] of labelHits) {
  if (isKnown(label)) continue
  const toks = normalize(label).split(' ')
  const lastInitial = toks.length >= 2 && toks[toks.length - 1].length === 1 ? toks[toks.length - 1] : null
  const matches = people.filter((e) => {
    const names = [e.name, ...e.aliases]
    const first = names.some((n) => sameFirst(label, n))
    if (!first) return false
    if (!lastInitial) return toks.length === 1
    return names.some((n) => {
      const last = normalize(n).split(' ').pop()
      return !!last && last.length > 1 && last.startsWith(lastInitial)
    })
  })
  if (matches.length !== 1) continue
  const e = matches[0]
  for (const o of os) propose(e.id, label, 'chat_handle', o.ev, o.at, o.len)
  // "Sam" alone, when no other person could be a Sam.
  if (lastInitial) {
    const first = label.split(' ')[0]
    const others = people.filter((x) => x.id !== e.id && [x.name, ...x.aliases].some((n) => sameFirst(first, n)))
    if (!others.length && !isKnown(first)) for (const o of os) propose(e.id, first, 'chat_handle', o.ev, o.at, first.length)
  }
}
const p5Done = Date.now()

// --- Merge, write, summarise ---------------------------------------------------------------------
const merged = new Map<string, Candidate & { evidenceIds: Set<string>; patterns: Set<string> }>()
for (const h of hits) {
  const e = live.get(h.entityId)
  if (!e) continue
  const key = `${h.entityId}|${normalize(h.alias)}`
  let c = merged.get(key)
  if (!c) {
    c = { entity: e.name, entity_type: e.type, alias: h.alias, pattern: h.pattern, count: 0, examples: [], evidenceIds: new Set(), patterns: new Set(), note: h.note }
    merged.set(key, c)
  }
  c.patterns.add(h.pattern)
  if (c.evidenceIds.has(h.evidenceId)) continue
  c.evidenceIds.add(h.evidenceId)
  c.count++
  if (c.examples.length < 3 && !c.examples.some((x) => x.quote === h.example.quote)) c.examples.push(h.example)
  // prefer the most name-like spelling (capitalised, longest) as the displayed alias
  if (h.alias.length > c.alias.length && /^[A-Z]/.test(h.alias)) c.alias = h.alias
}
const candidates: Candidate[] = [...merged.values()]
  .map(({ evidenceIds, patterns, ...c }) => ({ ...c, pattern: [...patterns].join('+') }))
  .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity) || a.alias.localeCompare(b.alias))

const outPath = outArg ? resolve(outArg) : resolve(import.meta.dirname, '../../../evals', slug, 'alias-candidates.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(candidates, null, 2) + '\n')

const tally = (key: (c: Candidate) => string) => {
  const m = new Map<string, number>()
  for (const c of candidates) for (const k of key(c).split('+')) m.set(k, (m.get(k) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')
}
console.log(`\n${candidates.length} alias candidates → ${outPath}`)
console.log(`per pattern: ${tally((c) => c.pattern)}`)
console.log(`per entity type: ${tally((c) => c.entity_type)}`)
console.log(`rejected: ${[...rejected].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}`)
console.log(`short forms skipped: ${ambiguousShort} shared by several companies, ${englishShort} ordinary English words`)
console.log(`timing: parenthetical ${((p1Done - t0) / 1000).toFixed(1)}s · nickname ${((p2Done - p1Done) / 1000).toFixed(1)}s · initialism ${((p3Done - p2Done) / 1000).toFixed(1)}s · short form ${((p4Done - p3Done) / 1000).toFixed(1)}s · chat handle ${((p5Done - p4Done) / 1000).toFixed(1)}s`)
console.log(`\ntop ${Math.min(top, candidates.length)}:`)
const show = (c: Candidate, quotes = 2) => {
  console.log(`${String(c.count).padStart(4)}  ${c.alias}  →  ${c.entity} [${c.entity_type}]  (${c.pattern})${c.note ? `  note: ${c.note}` : ''}`)
  for (const x of c.examples.slice(0, quotes)) console.log(`        ${x.source.slice(-60)}: ${x.quote}`)
}
for (const c of candidates.slice(0, top)) show(c)
for (const pattern of ['parenthetical', 'initialism', 'short_form', 'nickname']) {
  const list = candidates.filter((c) => c.pattern.includes(pattern)).slice(0, 15)
  if (!list.length) continue
  console.log(`\n${pattern}, top ${list.length}:`)
  for (const c of list) show(c, 1)
}
await db.end()
