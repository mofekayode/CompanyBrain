// Who can actually read what, as sets of people. Search documents list the access lists of their
// sources, and a reader passes if any of their principals is on any list (a union). That is right
// for a passage (one file) but wrong for a card that combines several files: anyone who may open
// one of them would read what came from all of them. Cards are therefore split into variants
// (see project.ts): each variant holds only content that every one of its readers may open.
//
// Containment is checked on people (users, including role profiles), with group membership
// expanded, so "Sales group" and "the three people in Sales" compare as the same readers.

import type { Sql } from '../storage/raw'

export interface Readers {
  /** The people who may read through any of these access lists. */
  of(aclIds: string[]): Set<string>
  /** True when every person allowed by `who` may also read through `through` (an empty `through` means everyone). */
  covers(who: string[], through: string[] | null): boolean
}

export async function loadReaders(sql: Sql, tenantId: string): Promise<Readers> {
  const [entries, members, users] = await Promise.all([
    sql.query<{ acl_id: string; principal_id: string }>(`select acl_id, principal_id from public.acl_entries where tenant_id = $1`, [tenantId]),
    sql.query<{ group_id: string; member_id: string }>(`select group_id, member_id from public.principal_members where tenant_id = $1`, [tenantId]),
    sql.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and kind = 'user'`, [tenantId]),
  ])
  const isUser = new Set(users.rows.map((r) => r.id))
  const childrenOf = new Map<string, string[]>()
  for (const m of members.rows) childrenOf.set(m.group_id, [...(childrenOf.get(m.group_id) ?? []), m.member_id])
  // A principal → the people it stands for (a user: themselves; a group: its members, transitively).
  const people = new Map<string, Set<string>>()
  const expand = (p: string, seen = new Set<string>()): Set<string> => {
    if (people.has(p)) return people.get(p)!
    const out = new Set<string>()
    if (isUser.has(p)) out.add(p)
    if (!seen.has(p)) {
      seen.add(p)
      for (const c of childrenOf.get(p) ?? []) for (const u of expand(c, seen)) out.add(u)
    }
    people.set(p, out)
    return out
  }
  const byAcl = new Map<string, Set<string>>()
  for (const e of entries.rows) {
    const s = byAcl.get(e.acl_id) ?? new Set<string>()
    for (const u of expand(e.principal_id)) s.add(u)
    byAcl.set(e.acl_id, s)
  }
  const cache = new Map<string, Set<string>>()
  const of = (aclIds: string[]) => {
    const key = [...new Set(aclIds)].sort().join(',')
    if (!cache.has(key)) {
      const s = new Set<string>()
      for (const a of aclIds) for (const u of byAcl.get(a) ?? []) s.add(u)
      cache.set(key, s)
    }
    return cache.get(key)!
  }
  const covered = new Map<string, boolean>()
  return {
    of,
    covers(who, through) {
      if (through === null) return true
      const key = `${[...new Set(who)].sort().join(',')}|${[...new Set(through)].sort().join(',')}`
      if (!covered.has(key)) {
        const can = of(through)
        let ok = true
        for (const u of of(who))
          if (!can.has(u)) {
            ok = false
            break
          }
        covered.set(key, ok)
      }
      return covered.get(key)!
    },
  }
}

/** A card's base id: variants of one card ("f:<id>~<k>") share it. */
export const baseId = (docId: string) => docId.split('~')[0]

/**
 * Splits a card into variants by reader group. `classes` are the access lists through which the
 * card may be seen; `build(acl)` returns the content those readers may read (null: nothing). Lists
 * whose content comes out the same share one variant. The variant with the most readers keeps the
 * card's own id; the others get a stable suffix.
 */
export function splitByReaders<T extends { id: string; acl_ids: string[]; content: string; dedupe_key: string | null }>(
  card: T,
  classes: string[],
  readers: Readers,
  build: (acl: string) => string | null,
  hash: (s: string) => string,
): T[] {
  const groups = new Map<string, string[]>()
  for (const acl of [...new Set(classes)]) {
    const content = build(acl)
    if (content === null) continue
    groups.set(content, [...(groups.get(content) ?? []), acl])
  }
  const out = [...groups.entries()]
    .map(([content, acls]) => ({ content, acls: acls.sort(), n: readers.of(acls).size }))
    .sort((a, b) => b.n - a.n || a.acls.join().localeCompare(b.acls.join()))
  return out.map((g, i) => ({ ...card, id: i === 0 ? card.id : `${card.id}~${hash(g.acls.join(',')).slice(0, 8)}`, content: g.content, acl_ids: g.acls, dedupe_key: card.id }))
}
