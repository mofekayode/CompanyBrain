// Dev tool: an independent check of who may read what. It rebuilds each file's readers straight
// from the company's own permission exports (SharePoint permissions, sharing links, mailbox
// permissions, group members, guests, the data room's user report), using none of the Brain's
// access code or config, then compares them with the readers the search index actually allows.
//
// It reports, per source pile:
//   too open    people the index lets read a file (or a card) whom the exports don't allow
//   too closed  people the exports allow whom the index doesn't
//   no rule     files the exports say nothing about (the Brain's access there is a guess)
//
// Interpretation it shares with the Brain (so it can't catch a wrong reading of these, only a wrong
// implementation): the stricter of a file's location and a sensitivity label marked inside it
// wins; a label's audience is everyone allowed on the SharePoint folders that carry it; identical
// copies of a file may be read by readers of any copy; a mailbox is read by its owner and its
// delegates.
//
// Usage: npx tsx scripts/permission-oracle.ts <slug> [--files] [--cards]

import { loadReaders } from '../src/search/readers'
import { pool } from '../src/workbench/server'

const [slug, ...flags] = process.argv.slice(2)
if (!slug) throw new Error('usage: permission-oracle.ts <slug> [--files] [--cards]')
const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id

// ------------------------------------------------------------------ exports, read as tables

async function table(path: string): Promise<Record<string, string>[]> {
  const rows = (
    await db.query<{ content: string }>(
      `select e.content from public.evidence e join public.document_versions dv on dv.id = e.document_version_id join public.source_objects so on so.id = dv.source_object_id
       where so.tenant_id = $1 and so.original_path = $2 and so.deleted_at is null order by e.ordinal`,
      [t, path],
    )
  ).rows
  const out: Record<string, string>[] = []
  for (const r of rows) {
    const lines = r.content.split('\n').filter((l) => l.trim() && !/^(#|Sheet:)/.test(l))
    const head = lines[0].split(' | ').map((c) => c.trim())
    for (const l of lines.slice(1)) {
      const v = l.split(' | ')
      if (v.join('|') === head.join('|')) continue
      out.push(Object.fromEntries(head.map((h, i) => [h, (v[i] ?? '').trim()])))
    }
  }
  return out
}

const [users, guests, members, spPerms, links, mailboxes, vdr] = await Promise.all([
  table('users.csv'),
  table('guest_users.csv'),
  table('group_members.csv'),
  table('sharepoint_permissions.csv'),
  table('sharing_links.csv'),
  table('mailbox_permissions.csv'),
  table('_admin reports/VDR_User_Access_Report_2026-10-09.csv'),
])

// ------------------------------------------------------------------------------- people

type People = Set<string> // lowercase email addresses
const lc = (s: string) => s.trim().toLowerCase()
const enabled = new Set(users.filter((u) => u['Account enabled'] === 'TRUE').map((u) => lc(u['User principal name'])))
const everyone: People = new Set([...enabled])
const NICK: Record<string, string> = { dave: 'david', greg: 'gregory', tom: 'thomas', josh: 'joshua', tony: 'anthony', tammy: 'tamara', bobby: 'robert', ben: 'benjamin', kate: 'katherine', mike: 'michael', jim: 'james' }
const first = (s: string) => {
  const f = lc(s).split(/\s+/)[0]
  return NICK[f] ?? f
}
const last = (s: string) => lc(s).split(/\s+/).at(-1)!
/** A person's email from a display name in an export ("Dave Brennan" → david.brennan@...). */
function byName(name: string): string | null {
  const n = name.replace(/\(.*?\)/g, '').trim()
  const exact = users.find((u) => lc(u['Display name']) === lc(n))
  if (exact) return lc(exact['User principal name'])
  const cands = users.filter((u) => last(u['Display name']) === last(n) && (first(u['Display name']).startsWith(first(n).slice(0, 3)) || first(n).startsWith(first(u['Display name']).slice(0, 3))))
  return cands.length === 1 ? lc(cands[0]['User principal name']) : null
}
/** A mailbox or address local part → the person (UPN, proxy alias, or first.last). */
function byAddress(addr: string): string | null {
  const a = lc(addr.includes('@') ? addr : `${addr}@rivertonindustrial.com`)
  const local = a.split('@')[0]
  for (const u of users) {
    if (lc(u['User principal name']) === a) return a
    if (lc(u['Proxy aliases'] ?? '').split(/[;,\s]+/).some((x) => x.replace(/^smtp:/, '') === a)) return lc(u['User principal name'])
  }
  const g = guests.find((x) => lc(x.Mail) === a)
  if (g) return lc(g.Mail)
  const [f, l] = local.split('.')
  return l ? byName(`${f} ${l}`) : null
}
// An external account as written in Entra ("rstein_northgateip.com#EXT#@tenant") → its address.
const guestMail = (upn: string) => {
  const m = lc(upn).match(/^(.+)_([^_]+)#ext#@/)
  return m ? `${m[1]}@${m[2]}` : lc(upn)
}
const isGuest = (email: string) => guests.some((g) => lc(g.Mail) === email)
const groupNames = new Set(members.map((m) => lc(m.Group)))
const groupCache = new Map<string, People>()
function group(name: string, seen = new Set<string>()): People {
  const g = lc(name)
  if (groupCache.has(g)) return groupCache.get(g)!
  const out: People = new Set()
  seen.add(g)
  for (const m of members.filter((x) => lc(x.Group) === g)) {
    if (groupNames.has(lc(m.Member)) && !seen.has(lc(m.Member))) for (const p of group(m.Member, seen)) out.add(p)
    else if (m.UPN) out.add(guestMail(m.UPN))
  }
  groupCache.set(g, out)
  return out
}
const unresolved = new Set<string>()
/** An export's principal (user, group, guest, link audience) → people. */
function principal(name: string, type = ''): People {
  const ty = lc(type)
  if (/anonymous/.test(ty) || /^anyone/i.test(name)) return new Set(everyone)
  if (/^organization$/i.test(name)) return new Set(everyone)
  const email = name.match(/[\w.+-]+@[\w.-]+/)?.[0]
  if (email) return new Set([byAddress(email) ?? lc(email)])
  const bare = name.replace(/\s*\((group|guest)[^)]*\)\s*/gi, '').replace(/\(.*?\)/g, '').trim()
  if (groupNames.has(lc(bare))) return group(bare)
  if (/group/.test(ty)) {
    unresolved.add(`group ${bare}`)
    return new Set()
  }
  const p = byName(bare)
  if (!p) unresolved.add(`person ${bare}`)
  return new Set(p ? [p] : [])
}
const union = (...s: People[]) => new Set(s.flatMap((x) => [...x]))
const inter = (a: People, b: People) => new Set([...a].filter((x) => b.has(x)))

// ----------------------------------------------------------------- readers of a location

interface Rule {
  readers: People
  how: string
}
const NO_RULE: null = null

// SharePoint (and OneDrive) permission rows by path; a row's "Members:" note names SharePoint group members.
const spRows = spPerms.filter((r) => r.Path && r.Path !== 'Path')
function spReaders(path: string): { readers: People; label: string | null } | null {
  const rows = spRows.filter((r) => path === r.Path || path.startsWith(`${r.Path}/`))
  if (!rows.length) return null
  const best = Math.max(...rows.map((r) => r.Path.length))
  const here = rows.filter((r) => r.Path.length === best)
  // A labelled folder keeps content inside the organization: guests only when granted by name.
  const readers = union(
    ...here.map((r) => {
      const who =
        /sharepoint group/i.test(r['Principal type']) && /Members:/.test(r.Notes ?? '')
          ? union(...r.Notes.replace(/.*Members:\s*/, '').split(',').map((n) => principal(n.trim())))
          : principal(r.Principal, r['Principal type'])
      const labelled = r['Sensitivity label'] && r['Sensitivity label'] !== '(none)'
      return labelled && /group/i.test(r['Principal type']) ? new Set([...who].filter((x) => !isGuest(x))) : who
    }),
  )
  const label = here.map((r) => r['Sensitivity label']).find((l) => l && l !== '(none)') ?? null
  return { readers, label }
}
// A label's audience: everyone allowed on the SharePoint folders that carry it.
const LABELS = [...new Set(spRows.map((r) => r['Sensitivity label']).filter((l) => l && l !== '(none)'))].sort((a, b) => b.length - a.length)
const labelAudience = new Map(LABELS.map((l) => [l, union(...[...new Set(spRows.filter((r) => r['Sensitivity label'] === l).map((r) => r.Path))].map((p) => spReaders(p)!.readers))]))
// Sharing links on an exact item add readers.
function linkReaders(item: string): People {
  return union(...links.filter((l) => l.Item === item && /active/i.test(l.Status)).map((l) => principal(l['Shared with'], l['Link type'])))
}

const ownerOf = (local: string) => byAddress(local)
const canSignIn = (email: string | null) => !!email && enabled.has(email)

function locationRule(source: string, path: string): Rule | null {
  if (source.startsWith('SharePoint')) {
    const sp = spReaders(`Shared Documents/${path}`)
    if (!sp) return NO_RULE
    return { readers: union(sp.readers, linkReaders(`Shared Documents/${path}`)), how: 'SharePoint folder' }
  }
  if (source === 'OneDrive exports') {
    const [who, ...rest] = path.split('/')
    const owner = ownerOf(who)
    const display = users.find((u) => lc(u['User principal name']) === owner)?.['Display name']
    if (!owner || !display) return NO_RULE
    const root = spRows.map((r) => r.Path).find((p) => new RegExp(`^OneDrive - ${display}( \\(|$|/)`).test(p) || (first(display) && new RegExp(`^OneDrive - \\w+ ${display.split(' ').at(-1)}`).test(p) && byName(p.replace(/^OneDrive - /, '').replace(/[/(].*/, '').trim()) === owner))
    const base = root ? root.replace(/\/.*$/, '') : `OneDrive - ${display}`
    const full = `${base}/${rest.join('/')}`
    const sp = spReaders(full)
    // Item links are listed without the "(archived)" suffix.
    const linkPath = `${base.replace(/\s*\(.*\)$/, '')}/${rest.join('/')}`
    return { readers: union(canSignIn(owner) ? new Set([owner]) : new Set(), sp?.readers ?? new Set(), linkReaders(full), linkReaders(linkPath)), how: 'OneDrive' }
  }
  if (source.startsWith('Dave')) {
    const dave = byName('David Brennan')!
    if (path.startsWith('OneDrive/')) {
      const sp = spReaders(`OneDrive - David Brennan/Documents/${path.slice(9)}`) ?? spReaders(`OneDrive - David Brennan/${path.slice(9)}`)
      return { readers: union(new Set([dave]), sp?.readers ?? new Set()), how: 'OneDrive' }
    }
    return NO_RULE // his old laptop: no export covers it
  }
  if (path.startsWith('mail/')) {
    const box = path.split('/')[1].replace(/\.mbox$|_calendar\.ics$/, '')
    if (box === 'old' || !box) return NO_RULE
    // By the mailbox's own address: several shared addresses (dispatch@, billing@) also sit on people's
    // accounts as aliases, so aliases don't decide whose mailbox it is.
    const person = byName(box.replace(/\./g, ' '))
    const rows = mailboxes.filter((m) => lc(m.Mailbox).split('@')[0] === box || (!!person && !/shared/i.test(m['Mailbox type']) && byName(lc(m.Mailbox).split('@')[0].replace(/\./g, ' ')) === person))
    const shared = rows.some((r) => /shared/i.test(r['Mailbox type']))
    const owner = shared ? null : (users.find((u) => lc(u['User principal name']).split('@')[0] === box) ? `${box}@rivertonindustrial.com` : byName(box.replace(/\./g, ' ')))
    const readers = union(canSignIn(owner) ? new Set([owner!]) : new Set(), ...rows.map((r) => principal(r.Principal.replace(/\s*\(group.*?\)/i, ''), /group/i.test(r.Principal) ? 'group' : '')))
    return rows.length || owner ? { readers, how: 'mailbox' } : NO_RULE
  }
  if (source.startsWith('Ridgeline VDR')) {
    // The data room report names who has access; it doesn't map permission groups to folders.
    const full = vdr.filter((v) => /full|administrator/i.test(v['Permission group'])).map((v) => byAddress(v.Email) ?? lc(v.Email))
    const finance = vdr.filter((v) => /finance/i.test(v['Permission group'])).map((v) => byAddress(v.Email) ?? lc(v.Email))
    return { readers: new Set([...full, ...(/^0?2 Financial/i.test(path) ? finance : [])]), how: 'data room (finance group assumed to see 02 Financial)' }
  }
  return NO_RULE
}

// A sensitivity label marked inside the content (a heading or banner line naming it).
function markedLabel(text: string): string | null {
  for (const raw of text.split('\n').slice(0, 40)) {
    const line = raw.replace(/^[#*\s|>-]+|[*\s|]+$/g, '').replace(/^(sensitivity|classification|label)\s*:\s*/i, '')
    if (line.length > 80 || line.split('|').length > 2) continue
    const l = LABELS.find((x) => new RegExp(`(^|[^a-z])${x.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}($|[^a-z-])`, 'i').test(line))
    if (l && l.length / line.length >= 0.4) return l
  }
  return null
}

// ------------------------------------------------------------------- the index's readers

const readers = await loadReaders(db, t)
const principals = (await db.query<{ id: string; emails: string[] | null; name: string }>(`select id, metadata -> 'emails' emails, display_name name from public.principals where tenant_id = $1 and kind = 'user'`, [t])).rows
const emailOf = new Map<string, string>()
for (const p of principals) {
  const e = (Array.isArray(p.emails) ? p.emails : []).map(lc).find((x) => enabled.has(x) || users.some((u) => lc(u['User principal name']) === x) || guests.some((g) => lc(g.Mail) === x))
  if (e) emailOf.set(p.id, byAddress(e) ?? e)
}
const known = new Set(emailOf.values())
const ours = (acls: string[]): People => new Set([...readers.of(acls)].map((id) => emailOf.get(id)).filter((x): x is string => !!x))

// ------------------------------------------------------------------------------ compare

const files = (
  await db.query<{ id: string; path: string; source: string; sha: string | null }>(
    `select so.id, so.original_path path, s.name source, so.sha256 sha from public.source_objects so join public.sources s on s.id = so.source_id where so.tenant_id = $1 and so.deleted_at is null`,
    [t],
  )
).rows
const fileById = new Map(files.map((f) => [f.id, f]))
const copies = new Map<string, string[]>()
for (const f of files) if (f.sha) copies.set(f.sha, [...(copies.get(f.sha) ?? []), f.id])

// Readers of one file (or one sheet of it): its location's rule, narrowed by a label marked in it.
const contentOf = new Map<string, string>()
for (const r of (
  await db.query<{ so: string; sheet: string | null; text: string }>(
    `select dv.source_object_id so, e.locator ->> 'sheet' sheet, string_agg(left(e.content, 1500), E'\\n' order by e.ordinal) text
     from public.evidence e join public.document_versions dv on dv.id = e.document_version_id where e.tenant_id = $1 and e.ordinal < 40 group by 1, 2`,
    [t],
  )
).rows)
  contentOf.set(`${r.so}|${r.sheet ?? ''}`, r.text)
function fileReaders(id: string, sheet: string): (Rule & { label: string | null }) | null {
  const f = fileById.get(id)!
  const rule = locationRule(f.source, f.path)
  if (!rule) return null
  const label = markedLabel(contentOf.get(`${id}|${sheet}`) ?? '') ?? (sheet ? null : null)
  return { readers: label ? inter(rule.readers, labelAudience.get(label)!) : rule.readers, how: rule.how, label }
}
// Content readable through any identical copy (sheets keep their own label).
function contentReaders(id: string, sheet: string): { readers: People; how: string; unknownCopies: number } | null {
  const f = fileById.get(id)!
  const ids = f.sha ? (copies.get(f.sha) ?? [id]) : [id]
  const rules = ids.map((c) => fileReaders(c, sheet))
  const knownRules = rules.filter((r): r is NonNullable<typeof r> => !!r)
  if (!knownRules.length) return null
  return { readers: union(...knownRules.map((r) => r.readers)), how: [...new Set(knownRules.map((r) => r.how + (r.label ? ` + label ${r.label}` : '')))].join(', '), unknownCopies: rules.length - knownRules.length }
}

const passages = (
  await db.query<{ so: string; sheet: string | null; acl_ids: string[] }>(
    `select distinct source_object_id so, citation ->> 'sheet' sheet, acl_ids from public.search_documents where tenant_id = $1 and doc_type = 'passage' and source_object_id is not null`,
    [t],
  )
).rows
type Tally = { units: number; noRule: number; open: number; closed: number }
const bySource = new Map<string, Tally>()
const tally = (s: string) => bySource.get(s) ?? (bySource.set(s, { units: 0, noRule: 0, open: 0, closed: 0 }), bySource.get(s)!)
const openList: { path: string; extra: string[]; how: string; viaUnknownCopy: boolean }[] = []
const closedList: { path: string; missing: string[]; how: string }[] = []
const names = new Map(users.map((u) => [lc(u['User principal name']), u['Display name']]))
const nm = (e: string) => names.get(e) ?? e
for (const p of passages) {
  const f = fileById.get(p.so)!
  const sheet = p.sheet && p.sheet !== 'CSV' ? p.sheet : ''
  const tl = tally(f.source)
  tl.units++
  const want = contentReaders(p.so, sheet)
  if (!want) {
    tl.noRule++
    continue
  }
  const have = ours(p.acl_ids)
  const extra = [...have].filter((x) => !want.readers.has(x))
  const missing = [...want.readers].filter((x) => known.has(x) && !have.has(x))
  if (extra.length) {
    tl.open++
    openList.push({ path: `${f.path}${sheet ? ` [${sheet}]` : ''}`, extra: extra.map(nm), how: want.how, viaUnknownCopy: want.unknownCopies > 0 })
  }
  if (missing.length) {
    tl.closed++
    closedList.push({ path: `${f.path}${sheet ? ` [${sheet}]` : ''}`, missing: missing.map(nm), how: want.how })
  }
}

console.log(`=== Readers by file, index vs. the company's permission exports (${passages.length} file/sheet units)`)
console.table(Object.fromEntries([...bySource.entries()].sort().map(([s, v]) => [s, { units: v.units, 'no rule in exports': v.noRule, 'too open': v.open, 'too closed': v.closed }])))
if (unresolved.size) console.log(`names in the exports not matched to a person: ${[...unresolved].join('; ')}`)
const show = flags.includes('--files')
const uniq = <T extends { path: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.path, x])).values()]
console.log(`\ntoo open (${uniq(openList).length} units)${show ? '' : ', first 25 (--files for all)'}:`)
for (const o of uniq(openList).slice(0, show ? 1e9 : 25)) console.log(`  ${o.path}\n      +${o.extra.length}: ${o.extra.slice(0, 8).join(', ')}${o.extra.length > 8 ? ' …' : ''} · rule: ${o.how}${o.viaUnknownCopy ? ' · has a copy with no rule' : ''}`)
console.log(`\ntoo closed (${uniq(closedList).length} units)${show ? '' : ', first 15'}:`)
for (const c of uniq(closedList).slice(0, show ? 1e9 : 15)) console.log(`  ${c.path}\n      -${c.missing.length}: ${c.missing.slice(0, 8).join(', ')}${c.missing.length > 8 ? ' …' : ''} · rule: ${c.how}`)

// ------------------------------------------------------------------- group membership

{
  const ourGroups = (
    await db.query<{ name: string; members: string[] }>(
      `select g.display_name name, array_agg(pm.member_id::text) members from public.principals g join public.principal_members pm on pm.group_id = g.id where g.tenant_id = $1 and g.kind = 'group' group by 1`,
      [t],
    )
  ).rows
  console.log(`\n=== Group membership, index vs. group_members.csv (membership values: ${[...new Set(members.map((m) => m.Membership))].join(', ')})`)
  for (const name of [...groupNames].sort()) {
    const want = group(name)
    const og = ourGroups.find((g) => lc(g.name) === name)
    const have = new Set((og?.members ?? []).map((id) => emailOf.get(id)).filter((x): x is string => !!x))
    const extra = [...have].filter((x) => !want.has(x))
    const missing = [...want].filter((x) => known.has(x) && !have.has(x))
    if (extra.length || missing.length || !og) console.log(`  ${name}${og ? '' : ' (no such group in the index)'}: ${extra.length ? `+${extra.map(nm).join(', ')} ` : ''}${missing.length ? `-${missing.map(nm).join(', ')}` : ''}`)
  }
}

// ------------------------------------------------------------------------------- cards

if (flags.includes('--cards')) {
  // A card's readers must each be able to read some file it was made from.
  // A card's readers must each be able to read some file it was made from: a fact's evidence files;
  // a record's own rows and the rows that link to it (a work order "for customer").
  const cards = (
    await db.query<{ id: string; doc_type: string; title: string; acl_ids: string[]; evidence_ids: string[] }>(
      `select id, doc_type, title, acl_ids, evidence_ids from public.search_documents where tenant_id = $1 and doc_type in ('fact', 'entity') and kind <> 'timeline'`,
      [t],
    )
  ).rows
  const evFile = new Map(
    (
      await db.query<{ id: string; so: string }>(
        `select e.id, dv.source_object_id so from public.evidence e join public.document_versions dv on dv.id = e.document_version_id where e.id = any($1::uuid[])`,
        [[...new Set(cards.flatMap((c) => c.evidence_ids))]],
      )
    ).rows.map((r) => [r.id, r.so]),
  )
  const recFiles = new Map<string, Set<string>>()
  const addRec = (e: string, f: string | null) => f && (recFiles.get(e) ?? recFiles.set(e, new Set()).get(e)!).add(f)
  for (const r of (
    await db.query<{ e: string; f: string }>(
      `select coalesce(merged_into_id, id) e, metadata #>> '{source,file_id}' f from public.entities where tenant_id = $1 and metadata #>> '{source,file_id}' is not null and coalesce(metadata ->> 'origin', '') <> 'prose'
       and entity_type_id in (select id from public.entity_types where coalesce(metadata ->> 'kind', 'thing') <> 'event')`,
      [t],
    )
  ).rows)
    addRec(r.e, r.f)
  for (const r of (
    await db.query<{ e: string; f: string }>(
      `select distinct r.target_entity_id e, o.metadata #>> '{source,file_id}' f from public.relationships r join public.entities o on o.id = r.source_entity_id
       where r.tenant_id = $1 and r.status <> 'rejected' and o.metadata #>> '{source,file_id}' is not null`,
      [t],
    )
  ).rows)
    addRec(r.e, r.f)
  // Records from the company directory (name, title, department, manager) are shown to everyone, as
  // the Microsoft 365 address book is; they aren't checked against files.
  const directory = new Set(
    (await db.query<{ id: string }>(`select id from public.entities where tenant_id = $1 and metadata ->> 'origin' = 'company_map' and merged_into_id is null`, [t])).rows.map((r) => r.id),
  )
  const filesOf = (c: (typeof cards)[number]) =>
    c.doc_type === 'entity' && directory.has(c.id.split('~')[0].slice(2)) ? [] :
    c.doc_type === 'fact' ? [...new Set(c.evidence_ids.map((e) => evFile.get(e)).filter((x): x is string => !!x))] : [...(recFiles.get(c.id.split('~')[0].slice(2)) ?? [])]
  let checked = 0
  let unknown = 0
  const bad: string[] = []
  for (const c of cards) {
    const files = filesOf(c)
    if (!files.length) continue
    const rules = files.map((f) => (fileById.has(f) ? contentReaders(f, '') : null))
    if (rules.some((r) => !r)) {
      unknown++
      continue
    }
    checked++
    const can = union(...rules.map((r) => r!.readers))
    const extra = [...ours(c.acl_ids)].filter((x) => !can.has(x))
    if (extra.length) bad.push(`  ${c.id.split('~')[0].slice(0, 10)}${c.id.includes('~') ? '~' : ' '} ${c.title.slice(0, 70)} · +${extra.length}: ${extra.slice(0, 5).map(nm).join(', ')}`)
  }
  console.log(`\n=== Cards: ${checked} checked (every source file has a rule), ${unknown} with a source the exports don't cover; ${bad.length} readable by someone who can read none of their sources`)
  for (const b of bad.slice(0, 30)) console.log(b)
}
await db.end()
