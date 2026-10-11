// Versions of one document: "FINAL pricing.xlsx" → "FINAL pricing v2.xlsx" → "FINAL pricing v2 USE
// THIS.xlsx"; "SOP-LOTO Rev 3" → "SOP-LOTO Rev 4"; "Hot Job Policy 2018" → "Hot Job Policy 2025". Files
// whose names are the same once version markers (years, dates, revisions, v2, FINAL, USE THIS, copy
// numbers, signed/scan) are taken out belong to one family; within a family, the one with the latest
// date or version in its name is current and the others are replaced by it. Identical copies and
// equally ranked files replace nothing. Pure.

export interface FileName {
  id: string
  path: string
  observed_at: string | null
  sha: string | null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MARKERS = /\b(final|use this|signed|scan(ned)?|executed|copy|my copy|draft|latest|new|updated|old|rev\s*[a-z0-9]+|v\s?\d+(\.\d+)?|r\d+)\b/g

const base = (path: string) =>
  (path.split('/').pop() ?? path)
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .toLowerCase()

/** The family key: the name without version markers, dates or years. */
export function familyKey(path: string): string {
  return base(path)
    .replace(/\(\s*\d+\s*\)/g, ' ') // "(1)"
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ') // 8.29.25, 12/31/25
    .replace(/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/g, ' ') // 2026-09-30
    .replace(new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2},?\\s+)?\\d{4}\\b`, 'g'), ' ') // March 2025, Aug 6 2025
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(MARKERS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(and|the|of|for)\b/g, ' ')
    .replace(/\borg\b/g, 'organization')
    .replace(/\s+/g, ' ')
    .trim()
}

/** When a file's name says it is from: an explicit date, a month and year, or a year (mid-year). */
function nameDate(path: string): string | null {
  const b = base(path)
  let m = b.match(/\b(\d{4})[./-](\d{1,2})[./-](\d{1,2})\b/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = b.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/)
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  m = b.match(new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(?:(\\d{1,2}),?\\s+)?(\\d{4})\\b`))
  if (m) return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${(m[2] ?? '15').padStart(2, '0')}`
  const years = [...b.matchAll(/\b((?:19|20)\d{2})\b/g)].map((x) => x[1])
  return years.length ? `${years.sort().at(-1)}-07-01` : null
}

/** A revision or version number in the name (Rev C = 3, Rev 4 = 4, v2 = 2), or 0. */
function revision(path: string): number {
  const b = base(path)
  const rev = b.match(/\brev\s*([a-z]|\d+)\b/)
  if (rev) return /\d/.test(rev[1]) ? Number(rev[1]) : rev[1].charCodeAt(0) - 96
  const v = b.match(/\bv\s?(\d+)/)
  return v ? Number(v[1]) : 0
}

/** Markers that a later edit is meant to be the one to use. */
const preferred = (path: string) => (/\b(use this|final|signed|executed)\b/.test(base(path)) ? 1 : 0)

/**
 * For each file, the files in its family that replace it. A one-word family ("FINAL pricing" →
 * "pricing") counts only within one folder; "pricing" across the whole company is too vague.
 */
export function replacedBy(files: FileName[]): Map<string, string[]> {
  const families = new Map<string, FileName[]>()
  for (const f of files) {
    const k = familyKey(f.path)
    if (!k) continue
    const key = k.includes(' ') ? k : `${f.path.split('/').slice(0, -1).join('/')}|${k}`
    families.set(key, [...(families.get(key) ?? []), f])
  }
  const out = new Map<string, string[]>()
  for (const fam of families.values()) {
    if (fam.length < 2) continue
    const rank = (f: FileName) => [nameDate(f.path) ?? '', revision(f.path), preferred(f.path)] as const
    const cmp = (a: FileName, b: FileName) => {
      const [da, ra, pa] = rank(a)
      const [db, rb, pb] = rank(b)
      // Only compare dates both names give; otherwise revisions, then "use this"/"final".
      if (da && db && da !== db) return da < db ? -1 : 1
      if (ra !== rb) return ra < rb ? -1 : 1
      // The same numbered version (a typed v3 and its signed scan) replaces nothing, unless someone
      // marked one "use this".
      const useThis = (f: FileName) => /\buse this\b/.test(base(f.path))
      if (ra > 0) return useThis(a) === useThis(b) ? 0 : useThis(a) ? 1 : -1
      if (pa !== pb) return pa < pb ? -1 : 1
      return 0
    }
    for (const f of fam) {
      const newer = fam.filter((g) => g.id !== f.id && !(f.sha && g.sha === f.sha) && cmp(f, g) < 0).map((g) => g.id)
      if (newer.length) out.set(f.id, newer)
    }
  }
  return out
}
