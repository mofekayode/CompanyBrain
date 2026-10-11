// Dev tool: repairs records that a row from another system was attached to by mistake. The loader
// used to match an id against any system's ids, so QuickBooks customer 40 (Hartwell) joined dispatch
// customer 40 (Blue Ridge), bringing its name as an alias, its QuickBooks id, its properties (email,
// city, open balance), its evidence and its links. The loader now matches ids only within their own
// system (or universal ones: email, initials, serials); this repairs what an earlier load did.
//
// For every row of every entity list in the latest ontology proposal: the record holding the row's
// own-system id must fit the row's name (a shared word, or letters in order) or share a universal id
// with it. If not, the row's id, name, properties, evidence and links move to the record the row
// names (found by a universal id or an exact name), and the wrong record's properties are rebuilt
// from the rows that are really its own. Rows naming no existing record are reported, not created.
//
// Usage: npx tsx scripts/repair-cross-system-ids.ts <slug> [--apply]

import { readTableFile } from '../src/access/directory'
import { latestProposal } from '../src/jobs/ontology'
import { pool, store } from '../src/workbench/server'

const [slug, flag] = process.argv.slice(2)
if (!slug) throw new Error('usage: repair-cross-system-ids.ts <slug> [--apply]')
const apply = flag === '--apply'
const db = pool()
const s3 = await store()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const proposal = await latestProposal(db, t)
if (!proposal) throw new Error('no ontology proposal')

const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(inc|llc|co|corp|company|the)\b/g, ' ').replace(/\s+/g, ' ').trim()
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length >= 3))
const squash = (s: string) => norm(s).replace(/ /g, '')
const inOrder = (a: string, b: string) => {
  let i = 0
  for (const ch of b) if (ch === a[i]) i++
  return i === a.length
}
// The same first word ("Kemper Molding" / "Kemper Plastics"), or one name's letters in order in the other
// ("BRM" in "Blue Ridge Mills"). A shared generic word ("Dairy", "and") is no evidence.
const first = (s: string) => norm(s).split(' ')[0] ?? ''
// People also by surname and first initial ("Henry Ostrander" / "Hank Ostrander").
const sameSurname = (a: string, b: string) => norm(a).split(' ').length > 1 && norm(a).split(' ').at(-1) === norm(b).split(' ').at(-1) && norm(a)[0] === norm(b)[0]
const fits = (a: string, b: string, person = false) => (person && sameSurname(a, b)) || (first(a).length >= 2 && first(a) === first(b)) || (squash(a).length > 1 && (inOrder(squash(a), squash(b)) || inOrder(squash(b), squash(a))))

// Live records with the names they were made from (their own and merged rows'), their non-import
// aliases, and their identifiers.
const types = new Map((await db.query<{ id: string; name: string }>(`select id, name from public.entity_types where tenant_id = $1`, [t])).rows.map((r) => [r.name, r.id]))
const live = new Map(
  (
    await db.query<{ id: string; type: string; name: string; props: Record<string, unknown> }>(
      `select e.id, ty.name type, e.canonical_name name, e.properties props from public.entities e join public.entity_types ty on ty.id = e.entity_type_id
       where e.tenant_id = $1 and e.merged_into_id is null and e.status in ('candidate', 'active') and coalesce(ty.metadata ->> 'kind', 'thing') <> 'event'`,
      [t],
    )
  ).rows.map((r) => [r.id, { ...r, names: new Set<string>([r.name]) }]),
)
for (const r of (await db.query<{ eid: string; name: string }>(`select merged_into_id eid, canonical_name name from public.entities where tenant_id = $1 and merged_into_id is not null`, [t])).rows)
  live.get(r.eid)?.names.add(r.name)
for (const r of (await db.query<{ eid: string; alias: string }>(`select entity_id eid, alias from public.entity_aliases where tenant_id = $1 and status <> 'rejected' and origin <> 'import'`, [t])).rows)
  live.get(r.eid)?.names.add(r.alias)
const idHolder = new Map<string, string>() // `${type}|${system}|${value}` → record
const idsOf = new Map<string, { system: string; value: string }[]>()
for (const r of (
  await db.query<{ eid: string; system: string; value: string }>(`select entity_id eid, system, value from public.entity_identifiers where tenant_id = $1 and entity_id = any($2::uuid[]) and status <> 'rejected'`, [t, [...live.keys()]])
).rows) {
  const e = live.get(r.eid)!
  idHolder.set(`${e.type}|${r.system}|${r.value.trim().toLowerCase()}`, r.eid)
  ;(idsOf.get(r.eid) ?? idsOf.set(r.eid, []).get(r.eid)!).push(r)
}
const byName = new Map<string, string[]>()
for (const e of live.values()) for (const n of e.names) byName.set(`${e.type}|${norm(n)}`, [...new Set([...(byName.get(`${e.type}|${norm(n)}`) ?? []), e.id])])
const UNIVERSAL = /^(email|initials|serial|vin|.*serial.*)$/i

interface Fix {
  type: string
  system: string
  ext: string
  rowName: string
  holder: string
  into: string | null
  props: Record<string, string>
  quote: string
  links: { rel: string; type: string; system: string | null; value: string }[]
}
const fixes: Fix[] = []
// Ids a table gives to two different rows ("DH" for Dwayne Hatcher and Darnell Hughes) identify neither.
const ambiguous: { type: string; system: string; ext: string; rowName: string }[] = []
const ownRows = new Map<string, Record<string, string>[]>() // record → props of rows that are really its own

for (const tb of proposal.tables.filter((x) => x.kind === 'entities' && x.entity_type && x.id_column)) {
  const f = (await db.query<{ s3_key: string; format: string; path: string }>(`select s3_key, metadata -> 'profile' ->> 'format' format, original_path path from public.source_objects where id = $1`, [tb.file_id])).rows[0]
  const bytes = f && (await s3.get(f.s3_key))
  if (!bytes) continue
  const sheet = (await readTableFile(bytes, f.format, tb.file_id, f.path)).sheets.find((sh) => sh.header.filter(Boolean).length > 1)
  if (!sheet) continue
  const val = (row: string[], col: string | null) => (col && sheet.header.indexOf(col) >= 0 ? String(row[sheet.header.indexOf(col)] ?? '').trim() : '')
  // Names each id is given in this table; an id is shared when two of them name different things.
  const namesById = new Map<string, Set<string>>()
  for (const row of sheet.rows) {
    const k = val(row, tb.id_column).toLowerCase()
    if (k && val(row, tb.name_column)) (namesById.get(k) ?? namesById.set(k, new Set()).get(k)!).add(val(row, tb.name_column))
  }
  const shared = (k: string) => {
    const ns = [...(namesById.get(k) ?? [])]
    return ns.some((a, i) => ns.slice(i + 1).some((b) => !fits(a, b, tb.entity_type === 'Person')))
  }
  for (const row of sheet.rows) {
    const ext = val(row, tb.id_column)
    // Named as the loader names it: first and last name when the name column holds an email.
    const firstCol = sheet.header.find((h) => /^first ?name$/i.test(h)) ?? null
    const lastCol = sheet.header.find((h) => /^last ?name$/i.test(h)) ?? null
    let rowName = val(row, tb.name_column)
    if (firstCol && lastCol && (!rowName || rowName.includes('@'))) rowName = `${val(row, firstCol)} ${val(row, lastCol)}`.trim() || rowName
    if (!ext) continue
    if (shared(ext.toLowerCase())) {
      if (rowName) ambiguous.push({ type: tb.entity_type!, system: tb.system, ext, rowName })
      continue
    }
    const holder = idHolder.get(`${tb.entity_type}|${tb.system}|${ext.toLowerCase()}`)
    if (!holder) continue
    const h = live.get(holder)!
    const props: Record<string, string> = {}
    for (const p of tb.property_columns) if (val(row, p)) props[p] = val(row, p)
    // Universal ids in the row (serials, emails) that the holder also has: the same thing.
    const universal = tb.property_columns.filter((p) => UNIVERSAL.test(p) && val(row, p)).map((p) => val(row, p).toLowerCase())
    const sharesUniversal = universal.some((v) => (idsOf.get(holder) ?? []).some((i) => i.value.toLowerCase() === v))
    if (!rowName || sharesUniversal || [...h.names].some((n) => fits(rowName, n, tb.entity_type === 'Person'))) {
      ;(ownRows.get(holder) ?? ownRows.set(holder, []).get(holder)!).push(props)
      continue
    }
    const byUniversal = [...live.values()].find((e) => e.type === tb.entity_type && e.id !== holder && universal.some((v) => (idsOf.get(e.id) ?? []).some((i) => i.value.toLowerCase() === v)))
    const named = (byName.get(`${tb.entity_type}|${norm(rowName)}`) ?? []).filter((x) => x !== holder)
    const into = byUniversal?.id ?? (named.length === 1 ? named[0] : null)
    fixes.push({
      type: tb.entity_type!,
      system: tb.system,
      ext,
      rowName,
      holder,
      into,
      props,
      quote: row.join(' | ').slice(0, 500),
      links: tb.links.map((l) => ({ rel: l.relationship, type: l.target_type, system: l.match === 'id' ? l.system : null, value: val(row, l.column) })).filter((l) => l.value),
    })
    if (into) (ownRows.get(into) ?? ownRows.set(into, []).get(into)!).push(props)
  }
}

const name = (id: string | null) => (id ? live.get(id)!.name : '(no record)')
const ambiguousIds = [...new Map(ambiguous.map((a) => [`${a.type}|${a.system}|${a.ext.toLowerCase()}`, a])).values()]
console.log(`ids shared by two rows of one table (identify neither): ${ambiguousIds.map((a) => `${a.system} ${a.ext} (${ambiguous.filter((b) => b.ext === a.ext && b.system === a.system).map((b) => b.rowName).join(' / ')})`).join('; ') || 'none'}`)
const byType = new Map<string, number>()
for (const x of fixes) byType.set(x.type, (byType.get(x.type) ?? 0) + 1)
console.log(`rows attached to the wrong record: ${fixes.length} (${[...byType].map(([k, v]) => `${k} ${v}`).join(', ')}); ${fixes.filter((x) => !x.into).length} name no existing record`)
for (const x of fixes) console.log(`  ${x.type.padEnd(9)} ${x.system} ${x.ext}: "${x.rowName}" was on ${name(x.holder)} → ${name(x.into)}`)

if (apply) {
  for (const x of fixes.filter((f) => f.into)) {
    // The row's id, its name as a spelling, its evidence.
    await db.query(`update public.entity_identifiers set entity_id = $3 where tenant_id = $1 and entity_id = $2 and system = $4 and lower(btrim(value)) = $5`, [t, x.holder, x.into, x.system, x.ext.toLowerCase()])
    await db.query(
      `update public.entity_aliases set status = 'rejected', context = coalesce(context, '{}') || '{"rejected_why":"belongs to another record (cross-system id mix-up)"}'
       where tenant_id = $1 and entity_id = $2 and normalized_alias = lower(btrim(regexp_replace($3, '\\s+', ' ', 'g'))) and origin = 'import'`,
      [t, x.holder, x.rowName],
    )
    await db.query(
      `insert into public.entity_aliases (tenant_id, entity_id, alias, kind, status, origin)
       select $1, $2, $3, 'system_spelling', 'candidate', 'import'
       where not exists (select 1 from public.entity_aliases a where a.entity_id = $2 and a.normalized_alias = lower(btrim(regexp_replace($3, '\\s+', ' ', 'g'))))`,
      [t, x.into, x.rowName],
    )
    await db.query(`update public.evidence_links set entity_id = $3 where tenant_id = $1 and entity_id = $2 and quote = $4`, [t, x.holder, x.into, x.quote])
    // Links the row made (its rep, its branch) go with it, unless the holder's own rows make them too.
    for (const l of x.links) {
      const target =
        (l.system && idHolder.get(`${l.type}|${l.system}|${l.value.toLowerCase()}`)) || ((byName.get(`${l.type}|${norm(l.value)}`) ?? []).length === 1 ? byName.get(`${l.type}|${norm(l.value)}`)![0] : null)
      if (!target) continue
      const ownMakesIt = (ownRows.get(x.holder) ?? []).length > 0 && fixes.every((o) => o.holder !== x.holder || o === x) === false
      if (ownMakesIt) continue
      await db.query(
        `update public.relationships r set source_entity_id = $3 from public.relationship_types rt
         where r.tenant_id = $1 and r.source_entity_id = $2 and r.target_entity_id = $4 and rt.id = r.relationship_type_id and lower(rt.name) = lower($5)
           and not exists (select 1 from public.relationships o where o.source_entity_id = $3 and o.target_entity_id = $4 and o.relationship_type_id = r.relationship_type_id)`,
        [t, x.holder, x.into, target, l.rel],
      )
    }
  }
  // Ambiguous ids: no record keeps them, no record keeps a row's name it doesn't fit, and events that
  // name them (dispatch work orders by "DH") are not linked to anyone.
  for (const a of ambiguous) {
    await db.query(`update public.entity_identifiers set status = 'rejected' where tenant_id = $1 and system = $2 and lower(btrim(value)) = $3`, [t, a.system, a.ext.toLowerCase()])
    const holders = (
      await db.query<{ id: string; eid: string }>(
        `select id, entity_id eid from public.entity_aliases where tenant_id = $1 and normalized_alias = lower(btrim(regexp_replace($2, '\\s+', ' ', 'g'))) and origin = 'import' and status <> 'rejected'`,
        [t, a.rowName],
      )
    ).rows.filter((r) => live.get(r.eid)?.type === a.type && ![...live.get(r.eid)!.names].some((n) => fits(a.rowName, n, a.type === 'Person')))
    if (holders.length)
      await db.query(`update public.entity_aliases set status = 'rejected', context = coalesce(context, '{}') || '{"rejected_why":"belongs to another record (shared id)"}' where id = any($1::uuid[])`, [
        holders.map((h) => h.id),
      ])
  }
  // The records a shared id could mean (Dwayne Hatcher and Darnell Hughes for "DH"): only links to them come off.
  const candidates = (type: string, system: string) =>
    [...live.values()].filter((e) => e.type === type && ambiguous.some((a) => a.type === type && a.system === system && [...e.names].some((n) => norm(n) === norm(a.rowName)))).map((e) => e.id)
  let unlinked = 0
  for (const tb of proposal.tables.filter((x) => x.kind === 'events' && x.event_id_column && x.event_type)) {
    const mine = ambiguousIds.filter((a) => a.system === tb.system)
    const links = tb.links.filter((l) => mine.some((a) => a.type === l.target_type))
    if (!links.length) continue
    const f = (await db.query<{ s3_key: string; format: string; path: string }>(`select s3_key, metadata -> 'profile' ->> 'format' format, original_path path from public.source_objects where id = $1`, [tb.file_id])).rows[0]
    const bytes = f && (await s3.get(f.s3_key))
    if (!bytes) continue
    const sheet = (await readTableFile(bytes, f.format, tb.file_id, f.path)).sheets.find((sh) => sh.header.filter(Boolean).length > 1)
    if (!sheet) continue
    const col = (c: string | null) => (c ? sheet.header.indexOf(c) : -1)
    for (const l of links) {
      const events: string[] = []
      for (const row of sheet.rows) {
        const vals = String(row[col(l.column)] ?? '').split(/[/;,]/).map((x) => x.trim().toLowerCase())
        if (mine.some((a) => a.type === l.target_type && vals.includes(a.ext.toLowerCase()))) events.push(String(row[col(tb.event_id_column)] ?? '').trim())
      }
      if (!events.length) continue
      const r = await db.query(
        `update public.relationships r set status = 'rejected', metadata = coalesce(r.metadata, '{}') || '{"rejected_why":"named by an id two people share"}'
         from public.relationship_types rt, public.entity_identifiers i, public.entities tg, public.entity_types tt
         where r.tenant_id = $1 and rt.id = r.relationship_type_id and lower(rt.name) = lower($2) and r.status <> 'rejected'
           and i.entity_id = r.source_entity_id and i.system = $3 and i.value = any($4::text[])
           and tg.id = r.target_entity_id and tt.id = tg.entity_type_id and tt.name = $5 and tg.id = any($6::uuid[])`,
        [t, l.relationship, tb.system, events, l.target_type, candidates(l.target_type, tb.system)],
      )
      unlinked += r.rowCount ?? 0
    }
  }
  console.log(`event links named only by a shared id, unlinked: ${unlinked}`)
  // Events of the same system that name the row (a dispatch work order's tech "DH") were linked to
  // the record holding that id: they go to the right one.
  let moved = 0
  for (const tb of proposal.tables.filter((x) => x.kind === 'events' && x.event_id_column && x.event_type)) {
    const mine = fixes.filter((f) => f.into && f.system === tb.system)
    const links = tb.links.filter((l) => mine.some((f) => f.type === l.target_type))
    if (!mine.length || !links.length) continue
    const f = (await db.query<{ s3_key: string; format: string; path: string }>(`select s3_key, metadata -> 'profile' ->> 'format' format, original_path path from public.source_objects where id = $1`, [tb.file_id])).rows[0]
    const bytes = f && (await s3.get(f.s3_key))
    if (!bytes) continue
    const sheet = (await readTableFile(bytes, f.format, tb.file_id, f.path)).sheets.find((sh) => sh.header.filter(Boolean).length > 1)
    if (!sheet) continue
    const col = (c: string | null) => (c ? sheet.header.indexOf(c) : -1)
    const plan = new Map<string, { events: string[]; fix: Fix; rel: string }>()
    for (const row of sheet.rows) {
      const key = String(row[col(tb.event_id_column)] ?? '').trim()
      if (!key) continue
      for (const l of links)
        for (const v of String(row[col(l.column)] ?? '').split(/[/;,]/).map((x) => x.trim().toLowerCase()).filter(Boolean))
          for (const fx of mine.filter((m) => m.type === l.target_type && (m.ext.toLowerCase() === v || norm(m.rowName) === norm(v)))) {
            const k = `${fx.holder}|${fx.into}|${l.relationship}`
            ;(plan.get(k) ?? plan.set(k, { events: [], fix: fx, rel: l.relationship }).get(k)!).events.push(key)
          }
    }
    for (const { events, fix, rel } of plan.values()) {
      const r = await db.query(
        `update public.relationships r set target_entity_id = $3 from public.relationship_types rt, public.entity_identifiers i
         where r.tenant_id = $1 and r.target_entity_id = $2 and rt.id = r.relationship_type_id and lower(rt.name) = lower($4)
           and i.entity_id = r.source_entity_id and i.system = $5 and i.value = any($6::text[])`,
        [t, fix.holder, fix.into, rel, tb.system, events],
      )
      moved += r.rowCount ?? 0
    }
  }
  console.log(`event links moved: ${moved}`)
  // Properties: the wrong values come off the holder; each record keeps what its own rows say.
  const touched = new Set(fixes.filter((f) => f.into).flatMap((f) => [f.holder, f.into!]))
  for (const id of touched) {
    const e = live.get(id)!
    const props = { ...e.props } as Record<string, unknown>
    for (const x of fixes.filter((f) => f.holder === id && f.into)) for (const [k, v] of Object.entries(x.props)) if (props[k] === v) delete props[k]
    for (const own of ownRows.get(id) ?? []) for (const [k, v] of Object.entries(own)) props[k] ??= v
    await db.query(`update public.entities set properties = $2 where id = $1`, [id, JSON.stringify(props)])
  }
  console.log(`repaired ${fixes.filter((f) => f.into).length} rows across ${touched.size} records`)
} else console.log('dry run (--apply to repair)')
await db.end()
