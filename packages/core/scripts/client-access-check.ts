// Dev tool: an independent check that the search index enforces the client-confirmed access list
// (config/tenants/<slug>/client-access.json). It reads the list and the index tables directly, using
// none of the Brain's access code, and compares who the index lets read each passage and card with
// who the client allows on the file (or email message) it came from.
//
// Rules from the list's notes: a role may read a file iff it is listed in the file's roles; a mailbox
// has one entry per message (path = mailbox, message_id) and the mailbox-level entry lists only roles
// allowed on every message; people named on a file read it regardless of role. Attachments and
// archive members follow the nearest listed parent; an identical copy (same checksum) read once
// carries its copy's message id.
//
// Who may read an index document: a role whose group (directly, or through a group holding it) is in
// the entries of any of the document's access lists.
//
//   passages   readers must equal the roles allowed on the file or message (too open: extra roles,
//              too closed: missing roles), per unit (one file, or one message with its attachments)
//   cards      readers must be within the union of roles allowed on the card's source files
//              (facts: the files of their evidence; entities: the files of the record, its merged
//              duplicates and the records whose rows link to it; timelines: the union over their facts)
//
// Usage: npx tsx scripts/client-access-check.ts <slug>

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pool } from '../src/workbench/server'

interface Entry {
  roles: string[]
  people: string[]
}
interface ClientAccess {
  roles: Record<string, unknown>
  files: { path: string; message_id?: string; roles: string[]; people?: string[] }[]
}

const slug = process.argv[2]
if (!slug) throw new Error('usage: client-access-check.ts <slug>')
const access = JSON.parse(readFileSync(join(import.meta.dirname, '../../../config/tenants', slug, 'client-access.json'), 'utf8')) as ClientAccess
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const EXAMPLES = 15
const short = (r: string) => r.replace(/^ROLE-/, '')
const roleList = (s: Iterable<string>) => [...s].sort().map(short).join(',') || 'nobody'
const uniq = <T>(xs: T[]) => [...new Set(xs)]

// ------------------------------------------------------------------ the list: entries by path and by message

const strip = (mid: string) => mid.replace(/^<|>$/g, '')
const byPath = new Map<string, Entry>()
const byMessage = new Map<string, Entry>()
for (const f of access.files) {
  const e = { roles: f.roles, people: f.people ?? [] }
  if (f.message_id) byMessage.set(`${f.path}|${strip(f.message_id)}`, e)
  else byPath.set(f.path, e)
}

// ------------------------------------------------------------------ our files: each one's entry and unit

const files = (
  await db.query<{ id: string; source: string; path: string; mid: string | null }>(
    `select so.id, s.name source, so.original_path path,
            (select e.locator ->> 'message_id' from public.evidence e join public.document_versions dv on dv.id = e.document_version_id
               join public.source_objects c on c.id = dv.source_object_id
              where (c.id = so.id or (so.sha256 is not null and c.sha256 = so.sha256)) and e.kind = 'email_body' limit 1) mid
     from public.source_objects so join public.sources s on s.id = so.source_id where so.tenant_id = $1 and so.deleted_at is null`,
    [t],
  )
).rows
const fullPath = (source: string, path: string) =>
  source === 'FDE interview recordings' ? `fde-captures/audio/${path}` : source === 'FDE inbox' ? `fde-captures/inbox/${path}` : source === 'Northgate handoff README' ? `company-as-found/${path}` : `company-as-found/${source}/${path}`
const midOf = new Map(files.filter((f) => f.mid).map((f) => [`${f.source}|${f.path}`, strip(f.mid!)]))

interface Unit {
  key: string
  label: string
  pile: string
  entry: Entry
}
const unitOf = new Map<string, Unit>() // source object id → its unit (a file, or a message with its attachments)
const pathOf = new Map<string, string>()
const noRule = new Map<string, string[]>() // pile → files the list says nothing about
const matchedEntries = new Set<string>()
for (const f of files) {
  const p = fullPath(f.source, f.path)
  pathOf.set(f.id, p)
  const msgFile = f.path.match(/^(mail\/[^/]+)\/messages\/[^/]+\.eml/)
  if (msgFile) {
    const mid = midOf.get(`${f.source}|${msgFile[0]}`)
    const box = fullPath(f.source, msgFile[1])
    const e = mid ? byMessage.get(`${box}|${mid}`) : undefined
    if (e && mid) {
      unitOf.set(f.id, { key: `${box}|${mid}`, label: `${fullPath(f.source, msgFile[0])} <${mid}>`, pile: f.source, entry: e })
      matchedEntries.add(`${box}|${mid}`)
      continue
    }
  }
  const parts = p.split('/')
  let at = p
  let hit = byPath.get(p)
  for (let i = parts.length - 1; i > 1 && !hit; i--) {
    at = parts.slice(0, i).join('/')
    hit = byPath.get(at)
  }
  if (hit) {
    unitOf.set(f.id, { key: p, label: p === at ? p : `${p} (via ${at})`, pile: f.source, entry: hit })
    matchedEntries.add(at)
  } else noRule.set(f.source, [...(noRule.get(f.source) ?? []), p])
}
const unmatchedEntries = access.files.filter((f) => !matchedEntries.has(f.message_id ? `${f.path}|${strip(f.message_id)}` : f.path))

// ------------------------------------------------------------------ who reads each access list

const roleGroup = new Map<string, string>() // principal id → role
for (const r of (await db.query<{ id: string; ref: string }>(`select id, external_ref ref from public.principals where tenant_id = $1 and kind = 'group' and external_ref like 'role:%'`, [t])).rows)
  roleGroup.set(r.id, r.ref.slice('role:'.length))
const rolesWithoutGroup = Object.keys(access.roles).filter((r) => ![...roleGroup.values()].includes(r))
const parents = new Map<string, string[]>() // member → the groups holding it
for (const m of (await db.query<{ g: string; m: string }>(`select group_id g, member_id m from public.principal_members where tenant_id = $1`, [t])).rows) parents.set(m.m, [...(parents.get(m.m) ?? []), m.g])
/** A principal and every group that holds it, transitively. */
const closure = (id: string) => {
  const seen = new Set([id])
  const stack = [id]
  while (stack.length) for (const g of parents.get(stack.pop()!) ?? []) if (!seen.has(g)) seen.add(g), stack.push(g)
  return seen
}
const entries = new Map<string, Set<string>>() // acl → principals in its entries
for (const e of (await db.query<{ acl: string; p: string }>(`select acl_id acl, principal_id p from public.acl_entries where tenant_id = $1`, [t])).rows) (entries.get(e.acl) ?? entries.set(e.acl, new Set()).get(e.acl)!).add(e.p)
const rolesOfAcl = new Map<string, Set<string>>()
for (const [acl, ps] of entries) {
  const s = new Set<string>()
  for (const [gid, role] of roleGroup) if ([...closure(gid)].some((x) => ps.has(x))) s.add(role)
  rolesOfAcl.set(acl, s)
}
const readers = (aclIds: string[]) => {
  const s = new Set<string>()
  for (const a of aclIds) for (const r of rolesOfAcl.get(a) ?? []) s.add(r)
  return s
}
// People named on a file, by any name they go by.
const personByName = new Map<string, string>()
for (const p of (
  await db.query<{ id: string; name: string; names: string[] }>(
    `select id, display_name name, array(select jsonb_array_elements_text(coalesce(metadata -> 'names', '[]'))) names from public.principals where tenant_id = $1 and kind = 'user'`,
    [t],
  )
).rows)
  for (const n of [p.name, ...p.names]) if (!personByName.has(n.toLowerCase())) personByName.set(n.toLowerCase(), p.id)
const personClosure = new Map<string, Set<string> | null>()
const unknownPeople = new Set<string>()
const personReads = (aclIds: string[], name: string) => {
  if (!personClosure.has(name)) {
    const id = personByName.get(name.toLowerCase())
    if (!id) unknownPeople.add(name)
    personClosure.set(name, id ? closure(id) : null)
  }
  const c = personClosure.get(name)
  return !!c && aclIds.some((a) => [...c].some((x) => entries.get(a)?.has(x)))
}

// ------------------------------------------------------------------ 1. passages

interface UnitDiff {
  pile: string
  label: string
  allowed: string[]
  extra: Set<string>
  missing: Set<string>
  peopleMissing: Set<string>
  passages: number
  bad: number
}
const passages = (await db.query<{ id: string; so: string; acl_ids: string[] }>(`select id, source_object_id so, acl_ids from public.search_documents where tenant_id = $1 and doc_type = 'passage'`, [t])).rows
const units = new Map<string, UnitDiff>()
let orphanPassages = 0
let passagesOpen = 0
let passagesClosed = 0
for (const p of passages) {
  const u = unitOf.get(p.so)
  if (!u) {
    orphanPassages++
    continue
  }
  const d = units.get(u.key) ?? units.set(u.key, { pile: u.pile, label: u.label, allowed: u.entry.roles, extra: new Set(), missing: new Set(), peopleMissing: new Set(), passages: 0, bad: 0 }).get(u.key)!
  const r = readers(p.acl_ids)
  const extra = [...r].filter((x) => !u.entry.roles.includes(x))
  const missing = u.entry.roles.filter((x) => !r.has(x))
  extra.forEach((x) => d.extra.add(x))
  missing.forEach((x) => d.missing.add(x))
  for (const name of u.entry.people) if (!personReads(p.acl_ids, name)) d.peopleMissing.add(name)
  d.passages++
  if (extra.length || missing.length) d.bad++
  if (extra.length) passagesOpen++
  if (missing.length) passagesClosed++
}

interface PileCount {
  units: number
  open: number
  closed: number
  people: number
  openEx: string[]
  closedEx: string[]
  peopleEx: string[]
}
const piles = new Map<string, PileCount>()
for (const d of units.values()) {
  const c = piles.get(d.pile) ?? piles.set(d.pile, { units: 0, open: 0, closed: 0, people: 0, openEx: [], closedEx: [], peopleEx: [] }).get(d.pile)!
  c.units++
  const where = `${d.label} (${d.bad}/${d.passages} passages; allowed ${roleList(d.allowed)})`
  if (d.extra.size) c.open++, c.openEx.length < EXAMPLES && c.openEx.push(`+${roleList(d.extra)}  ${where}`)
  if (d.missing.size) c.closed++, c.closedEx.length < EXAMPLES && c.closedEx.push(`-${roleList(d.missing)}  ${where}`)
  if (d.peopleMissing.size) c.people++, c.peopleEx.length < EXAMPLES && c.peopleEx.push(`-${[...d.peopleMissing].sort().join(', ')}  ${d.label}`)
}

// ------------------------------------------------------------------ 2. cards

interface Card {
  id: string
  kind: string
  title: string
  evidence_ids: string[]
  acl_ids: string[]
  citation: Record<string, unknown>
}
const cards = (
  await db.query<Card>(`select id, kind, title, evidence_ids, acl_ids, citation from public.search_documents where tenant_id = $1 and doc_type in ('entity', 'fact') order by id`, [t])
).rows
const factCards = cards.filter((c) => c.id.startsWith('f:') && c.kind !== 'timeline')
const entityCards = cards.filter((c) => c.id.startsWith('e:'))
const timelineCards = cards.filter((c) => c.kind === 'timeline')
const idOf = (card: string) => card.slice(2).split('~')[0]

/** The roles allowed on a set of files: their union, and whether a file is missing from the list. */
const unionOf = (fileIds: string[]) => {
  const roles = new Set<string>()
  let unknown = 0
  for (const f of uniq(fileIds)) {
    const u = unitOf.get(f)
    if (!u) unknown++
    else u.entry.roles.forEach((x) => roles.add(x))
  }
  return { roles, unknown }
}
interface CardCheck {
  checked: number
  open: number
  skipped: Record<string, number>
  examples: string[]
}
const checkCards = (list: Card[], filesOf: (c: Card) => string[] | string): CardCheck => {
  const out: CardCheck = { checked: 0, open: 0, skipped: {}, examples: [] }
  for (const c of list) {
    const fs = filesOf(c)
    if (typeof fs === 'string') {
      out.skipped[fs] = (out.skipped[fs] ?? 0) + 1
      continue
    }
    const { roles, unknown } = unionOf(fs)
    if (unknown) {
      out.skipped['a source file not in the list'] = (out.skipped['a source file not in the list'] ?? 0) + 1
      continue
    }
    out.checked++
    const extra = [...readers(c.acl_ids)].filter((x) => !roles.has(x))
    if (!extra.length) continue
    out.open++
    if (out.examples.length < EXAMPLES) {
      const paths = uniq(fs.map((f) => pathOf.get(f) ?? f))
      out.examples.push(`+${roleList(extra)}  ${c.id} ${c.title} (allowed ${roleList(roles)}; ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` +${paths.length - 3} more` : ''})`)
    }
  }
  return out
}

// Facts: the files of their evidence.
const fileOfEvidence = new Map<string, string>()
const evIds = uniq(factCards.flatMap((c) => c.evidence_ids))
for (let i = 0; i < evIds.length; i += 5000)
  for (const r of (
    await db.query<{ id: string; so: string }>(`select e.id, dv.source_object_id so from public.evidence e join public.document_versions dv on dv.id = e.document_version_id where e.id = any($1::uuid[])`, [evIds.slice(i, i + 5000)])
  ).rows)
    fileOfEvidence.set(r.id, r.so)
const factFiles = (c: Card) => (c.evidence_ids.length ? c.evidence_ids.map((e) => fileOfEvidence.get(e) ?? `evidence:${e}`) : 'no evidence')
const facts = checkCards(factCards, factFiles)

// Entities: the files of the record, of duplicates merged into it, and of records whose rows link to it.
const entityIds = uniq(entityCards.map((c) => idOf(c.id)))
const ownFiles = new Map<string, string[]>()
const linkFiles = new Map<string, string[]>()
for (let i = 0; i < entityIds.length; i += 5000) {
  const slice = entityIds.slice(i, i + 5000)
  for (const r of (
    await db.query<{ eid: string; file: string }>(
      `select coalesce(m.merged_into_id, m.id) eid, m.metadata #>> '{source,file_id}' file from public.entities m
       where m.tenant_id = $1 and coalesce(m.merged_into_id, m.id) = any($2::uuid[]) and m.metadata #>> '{source,file_id}' is not null`,
      [t, slice],
    )
  ).rows)
    ownFiles.set(r.eid, [...(ownFiles.get(r.eid) ?? []), r.file])
  for (const r of (
    await db.query<{ eid: string; file: string }>(
      `select distinct r.target_entity_id eid, s.metadata #>> '{source,file_id}' file from public.relationships r join public.entities s on s.id = r.source_entity_id
       where r.tenant_id = $1 and r.status <> 'rejected' and r.target_entity_id = any($2::uuid[]) and s.metadata #>> '{source,file_id}' is not null`,
      [t, slice],
    )
  ).rows)
    linkFiles.set(r.eid, [...(linkFiles.get(r.eid) ?? []), r.file])
}
const entityFiles = (c: Card) => {
  const id = idOf(c.id)
  const fs = [...(ownFiles.get(id) ?? []), ...(linkFiles.get(id) ?? [])]
  return fs.length ? fs : 'no source file (company directory)'
}
const entities = checkCards(entityCards, entityFiles)

// Timelines: the union over their facts.
const filesOfFact = new Map<string, string[] | string>()
for (const c of factCards) if (!filesOfFact.has(idOf(c.id))) filesOfFact.set(idOf(c.id), factFiles(c))
const timelineFiles = (c: Card) => {
  const ids = (c.citation.facts as string[] | undefined) ?? []
  if (!ids.length) return 'no facts cited'
  const fs: string[] = []
  for (const f of ids) {
    const x = filesOfFact.get(f)
    if (!x) return 'a fact without a card'
    if (typeof x === 'string') return `a fact with ${x}`
    fs.push(...x)
  }
  return fs
}
const timelines = checkCards(timelineCards, timelineFiles)

// ------------------------------------------------------------------ report

const pad = (s: string | number, n: number) => String(s).padEnd(n)
const num = (s: string | number, n: number) => String(s).padStart(n)
console.log(`client-access-check ${slug}: ${access.files.length} entries (${byPath.size} files, ${byMessage.size} messages), ${files.length} files on our side, ${passages.length} passages, ${cards.length} cards`)
console.log(`roles: ${Object.keys(access.roles).map(short).join(', ')}${rolesWithoutGroup.length ? `; NO GROUP in principals for: ${rolesWithoutGroup.join(', ')}` : ''}`)
const noRuleTotal = [...noRule.values()].reduce((a, b) => a + b.length, 0)
console.log(`files not in the list: ${noRuleTotal} (${orphanPassages} passages, skipped); list entries matching no file: ${unmatchedEntries.length}`)
for (const [pile, ps] of noRule) console.log(`  ${pile}: ${ps.length}${ps.length ? `, e.g. ${ps.slice(0, 3).join('; ')}` : ''}`)
for (const e of unmatchedEntries.slice(0, 10)) console.log(`  no file for entry: ${e.path}${e.message_id ? ` <${strip(e.message_id)}>` : ''}`)
if (unmatchedEntries.length > 10) console.log(`  ... ${unmatchedEntries.length - 10} more`)
if (unknownPeople.size) console.log(`named people not matched to a person: ${[...unknownPeople].join(', ')}`)

console.log(`\n== 1. passages, by unit (one file, or one message with its attachments)`)
console.log(`${pad('pile', 40)} ${num('units', 7)} ${num('too open', 9)} ${num('too closed', 11)} ${num('people missing', 15)}`)
const tot = { units: 0, open: 0, closed: 0, people: 0 }
for (const [pile, c] of [...piles].sort((a, b) => b[1].units - a[1].units)) {
  console.log(`${pad(pile, 40)} ${num(c.units, 7)} ${num(c.open, 9)} ${num(c.closed, 11)} ${num(c.people, 15)}`)
  tot.units += c.units, (tot.open += c.open), (tot.closed += c.closed), (tot.people += c.people)
}
console.log(`${pad('total', 40)} ${num(tot.units, 7)} ${num(tot.open, 9)} ${num(tot.closed, 11)} ${num(tot.people, 15)}   (passages: ${passagesOpen} too open, ${passagesClosed} too closed)`)
for (const [pile, c] of piles) {
  if (c.openEx.length) console.log(`\n  too open, ${pile}:`), c.openEx.forEach((x) => console.log(`    ${x}`))
  if (c.closedEx.length) console.log(`\n  too closed, ${pile}:`), c.closedEx.forEach((x) => console.log(`    ${x}`))
  if (c.peopleEx.length) console.log(`\n  named people who cannot read, ${pile}:`), c.peopleEx.forEach((x) => console.log(`    ${x}`))
}

const cardReport = (name: string, r: CardCheck) => {
  console.log(`\n== ${name}: ${r.checked} checked, ${r.open} too open${Object.keys(r.skipped).length ? `; skipped: ${Object.entries(r.skipped).map(([k, v]) => `${v} with ${k}`).join(', ')}` : ''}`)
  r.examples.forEach((x) => console.log(`    ${x}`))
}
cardReport('2a. fact cards', facts)
cardReport('2b. entity cards', entities)
cardReport('3. timeline cards', timelines)

const skippedTotal = (r: CardCheck) => Object.values(r.skipped).reduce((a, b) => a + b, 0)
console.log(`\n== summary`)
console.log(`${pad('check', 16)} ${num('checked', 8)} ${num('too open', 9)} ${num('too closed', 11)} ${num('skipped', 8)}`)
console.log(`${pad('passage units', 16)} ${num(tot.units, 8)} ${num(tot.open, 9)} ${num(tot.closed, 11)} ${num(noRuleTotal, 8)}`)
console.log(`${pad('fact cards', 16)} ${num(facts.checked, 8)} ${num(facts.open, 9)} ${num('', 11)} ${num(skippedTotal(facts), 8)}`)
console.log(`${pad('entity cards', 16)} ${num(entities.checked, 8)} ${num(entities.open, 9)} ${num('', 11)} ${num(skippedTotal(entities), 8)}`)
console.log(`${pad('timeline cards', 16)} ${num(timelines.checked, 8)} ${num(timelines.open, 9)} ${num('', 11)} ${num(skippedTotal(timelines), 8)}`)
await db.end()
