// House style: no em dashes in anything we show. Same rule as packages/core/src/text.ts.

/** ", " becomes ", "; a dash between words becomes a hyphen; a lone dash (empty value) becomes "-". */
export function tidy(s: string): string
export function tidy(s: string | null): string | null
export function tidy(s: string | null): string | null {
  if (s == null) return s
  return s
    .replace(/\s+-\s+/g, ', ')
    .replace(/(\w)-(\w)/g, '$1-$2')
    .replace(/-/g, '-')
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-10-19" → "Oct 19, 2026"; "2026-10" → "Oct 2026". Anything else is returned as is. */
export function humanDate(s: string | null | undefined): string {
  if (!s) return ''
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s)
  if (!m) return s
  const mon = MONTHS[Number(m[2]) - 1]
  return m[3] ? `${mon} ${Number(m[3])}, ${m[1]}` : `${mon} ${m[1]}`
}

/** "since Jul 1, 2025" / "Jul 1, 2022 to Jun 30, 2025" / "until Jun 30, 2028". */
export function period(from: string | null | undefined, to: string | null | undefined): string {
  if (from && to) return `${humanDate(from)} to ${humanDate(to)}`
  if (from) return `since ${humanDate(from)}`
  if (to) return `until ${humanDate(to)}`
  return ''
}
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
