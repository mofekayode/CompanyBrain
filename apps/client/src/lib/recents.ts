// Per-person recents in this browser: searches, questions and things opened. A convenience only, // if storage is blocked (private window) the app works the same, just without recents.

export interface Recent {
  kind: 'search' | 'ask' | 'entity' | 'file'
  label: string
  /** Query text, entity id or file id. */
  ref: string
  detail?: string | null
  at: number
}

const key = (slug: string, person: string | undefined) => `cb.recents.${slug}.${person ?? 'anon'}`
const MAX = 40

export function readRecents(slug: string, person: string | undefined): Recent[] {
  try {
    const raw = localStorage.getItem(key(slug, person))
    return raw ? (JSON.parse(raw) as Recent[]) : []
  } catch {
    return []
  }
}

export function pushRecent(slug: string, person: string | undefined, r: Omit<Recent, 'at'>) {
  try {
    const all = readRecents(slug, person).filter((x) => !(x.kind === r.kind && x.ref.toLowerCase() === r.ref.toLowerCase()))
    localStorage.setItem(key(slug, person), JSON.stringify([{ ...r, at: Date.now() }, ...all].slice(0, MAX)))
    window.dispatchEvent(new Event('cb-recents'))
  } catch {}
}

export function recentOf(slug: string, person: string | undefined, kinds: Recent['kind'][], n = 6) {
  return readRecents(slug, person)
    .filter((r) => kinds.includes(r.kind))
    .slice(0, n)
}
