// Entity linking: which known things (customers, people, sites, assets, vendors,
// branches, company terms) a piece of text mentions, by canonical name or alias.
// Used twice: at index time (passages get entity_ids + entity_terms) and at query
// time (the question "what does Big Blue pay?" resolves to Blue Ridge Food Processing).
//
// Deliberately conservative: an alias that points at two entities is ambiguous and
// skipped ("Mike H"); one-word names must be ≥3 letters and not everyday words;
// rejected aliases are ignored; event types (work orders, invoices) are not linked.

import type { Sql } from '../storage/raw'

export interface LinkedEntity {
  id: string
  name: string
  type: string
  matched: string
}

/** Entity types whose names are too generic to spot in free text. */
const SKIP_TYPES = new Set(['GL Account', 'Fixed Asset', 'Vehicle', 'Labor Rate'])
/** Everyday words that are also somebody's alias or a term name. */
const COMMON = new Set(
  'the and for with from that this have will your about office shop service parts sales team board cage plan rate terms notes note main north south east west hot job jobs pump pumps company customer customers site sites contract policy safety billing dispatch on-call oncall call calls price pricing quote quotes invoice invoices payment payments vendor vendors new old'.split(
    ' ',
  ),
)

export const normalize = (s: string) =>
  s
    .toLowerCase()
    // "Big Blue's terms" names Big Blue: drop the possessive (on both names and text, so it stays consistent).
    .replace(/[’']s\b/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export interface Dictionary {
  /** normalized phrase → entity ids (more than one = ambiguous) */
  phrases: Map<string, Set<string>>
  /** phrases that are an explicit nickname / jargon / vocabulary term of an entity: they win ties */
  jargon?: Map<string, Set<string>>
  entities: Map<string, { name: string; type: string; terms: string[] }>
  maxTokens: number
}

const CODE = /^[a-z]{1,6} ?\d+[a-z]?$/ // "tp 17", "p17", "pmp 070"
/** Business abbreviations people write either way ("Service Labor - OT" ↔ "overtime"). */
const ABBREV: Record<string, string> = { ot: 'overtime', pm: 'preventive maintenance', ap: 'accounts payable', ar: 'accounts receivable', hr: 'human resources', wo: 'work order', po: 'purchase order', qc: 'quality control', loto: 'lockout tagout' }

export async function loadDictionary(sql: Sql, tenantId: string): Promise<Dictionary> {
  const rows = (
    await sql.query<{ id: string; name: string; type: string; aliases: string[] | null; jargon: string[] | null }>(
      `select e.id, e.canonical_name name, t.name type,
              array(select a.alias from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected') aliases,
              array(select a.alias from public.entity_aliases a where a.entity_id = e.id and a.status <> 'rejected' and a.kind in ('jargon', 'nickname', 'abbreviation', 'former_name')) jargon
       from public.entities e join public.entity_types t on t.id = e.entity_type_id
       where e.tenant_id = $1 and e.status in ('candidate', 'active') and coalesce(t.metadata ->> 'kind', 'thing') <> 'event'`,
      [tenantId],
    )
  ).rows
  // Company vocabulary ("Big Blue", "the cage") points at the real thing through refers_to:
  // a term's words link to what it refers to, not to the term record.
  const refersTo = new Map(
    (
      await sql.query<{ term: string; target: string }>(
        `select r.source_entity_id term, r.target_entity_id target from public.relationships r
         join public.relationship_types rt on rt.id = r.relationship_type_id and rt.name = 'refers_to'
         join public.entities t on t.id = r.target_entity_id and t.status in ('candidate', 'active')
         where r.tenant_id = $1 and r.status <> 'rejected'`,
        [tenantId],
      )
    ).rows.map((r) => [r.term, r.target]),
  )
  const phrases = new Map<string, Set<string>>()
  const jargon = new Map<string, Set<string>>()
  const strong = (phrase: string, id: string) => {
    const n = normalize(phrase)
    if (n) jargon.set(n, (jargon.get(n) ?? new Set()).add(id))
  }
  const entities = new Map<string, { name: string; type: string; terms: string[] }>()
  let maxTokens = 1
  const add = (phrase: string, id: string, type: string, isName: boolean, isJargon = false) => {
    const n = normalize(phrase)
    if (!n) return
    const tokens = n.split(' ')
    if (tokens.length > 8) return
    if (tokens.length === 1 && !CODE.test(n) && (n.length < 3 || COMMON.has(n))) return
    // Everyday words alone are noise, unless the company uses them as a set phrase ("the cage", "hot job").
    if (tokens.every((t) => COMMON.has(t)) && !(isJargon && tokens.length > 1)) return
    // Assets: only codes (TP-17) and their nicknames, not generated names like "Goulds pump".
    if (type === 'Asset' && isName && !CODE.test(n)) return
    maxTokens = Math.max(maxTokens, tokens.length)
    const set = phrases.get(n) ?? new Set<string>()
    set.add(id)
    phrases.set(n, set)
  }
  for (const r of rows) {
    if (SKIP_TYPES.has(r.type)) continue
    entities.set(r.id, { name: r.name, type: r.type, terms: [r.name, ...(r.aliases ?? [])] })
    const target = r.type === 'Term' ? refersTo.get(r.id) : undefined
    const jargonSet = new Set((r.jargon ?? []).map(normalize))
    add(r.name, target ?? r.id, r.type, !target, r.type === 'Term')
    for (const a of r.aliases ?? []) add(a, target ?? r.id, r.type, false, r.type === 'Term' || jargonSet.has(normalize(a)))
    if (target) [r.name, ...(r.aliases ?? [])].forEach((a) => strong(a, target))
    for (const a of r.jargon ?? []) strong(a, r.id)
    // Spelled-out abbreviations: "Service Labor - OT" is also "service labor overtime" (and "overtime" alone when unique).
    const toks = normalize(r.name).split(' ')
    if (toks.some((t) => ABBREV[t])) {
      add(toks.map((t) => ABBREV[t] ?? t).join(' '), r.id, r.type, false)
      for (const t of toks) if (ABBREV[t] && toks.length > 1) add(ABBREV[t], r.id, r.type, false)
    }
    // "Blue Ridge Food Processing LLC" is also written "Blue Ridge Food Processing".
    const bare = r.name.replace(/\b(llc|inc|co|corp|ltd|company)\.?$/i, '').replace(/[,.]\s*$/, '').trim()
    if (bare !== r.name) add(bare, r.id, r.type, true)
  }
  // How people actually refer to things: "Dave", "Sarah", "Northgate", "Kemper". A first name
  // (people) or first word (organisations, ≥5 letters) counts only when exactly one entity has it.
  const short = new Map<string, Set<string>>()
  // Words that also occur later in other names ("Ohio *Valley* Cold Storage") are not safe shorthands.
  const inner = new Set(rows.flatMap((r) => normalize(r.name).split(' ').slice(1)))
  for (const r of rows) {
    if (!['Person', 'Customer', 'Vendor', 'Site', 'Customer Contact'].includes(r.type)) continue
    const first = normalize(r.name).split(' ')[0]
    if (!first || first === normalize(r.name) || COMMON.has(first) || /\d/.test(first) || inner.has(first)) continue
    if (r.type !== 'Person' && r.type !== 'Customer Contact' && first.length < 5) continue
    if ((r.type === 'Person' || r.type === 'Customer Contact') && first.length < 3) continue
    const key = `${r.type === 'Person' || r.type === 'Customer Contact' ? 'p' : 'o'}|${first}`
    short.set(key, (short.get(key) ?? new Set()).add(r.id))
  }
  for (const [key, ids] of short) {
    const word = key.slice(2)
    if (ids.size !== 1 || phrases.has(word)) continue
    phrases.set(word, new Set(ids))
  }
  // The real thing is also known by its vocabulary terms ("Big Blue" is a name of Blue Ridge).
  for (const [term, target] of refersTo) {
    const t = entities.get(term)
    const e = entities.get(target)
    if (t && e) e.terms = [...new Set([...e.terms, ...t.terms])]
  }
  return { phrases, entities, maxTokens, jargon }
}

/** Entities mentioned in a text (longest match wins; ambiguous phrases skipped). */
export function linkText(dict: Dictionary, text: string): LinkedEntity[] {
  const tokens = normalize(text).split(' ').filter(Boolean)
  const found = new Map<string, LinkedEntity>()
  for (let i = 0; i < tokens.length; i++) {
    for (let len = Math.min(dict.maxTokens, tokens.length - i); len >= 1; len--) {
      const phrase = tokens.slice(i, i + len).join(' ')
      const ids = dict.phrases.get(phrase)
      if (!ids) continue
      // Ambiguous between a vocabulary term and one real thing → the real thing.
      let real = ids.size > 1 ? [...ids].filter((id) => dict.entities.get(id)?.type !== 'Term') : [...ids]
      // Still a tie: the company's own nickname for one of them wins ("Pump 17" is TP-17, not asset PUMP-17).
      if (real.length > 1) {
        const j = real.filter((id) => dict.jargon?.get(phrase)?.has(id))
        if (j.length === 1) real = j
      }
      if (real.length === 1) {
        const id = real[0]
        const e = dict.entities.get(id)
        if (e && !found.has(id)) found.set(id, { id, name: e.name, type: e.type, matched: phrase })
      }
      i += len - 1
      break
    }
  }
  return [...found.values()]
}
