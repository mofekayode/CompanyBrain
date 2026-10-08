// House style for text we show: no em dashes, ever. Text written by us, by AI reviews (fact
// summaries) or by an answer model goes through tidy() before it reaches a person. Quotes from
// the company's own documents are left exactly as written.

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
export function humanPeriod(from: string | null | undefined, to: string | null | undefined): string {
  if (from && to) return `${humanDate(from)} to ${humanDate(to)}`
  if (from) return `since ${humanDate(from)}`
  if (to) return `until ${humanDate(to)}`
  return ''
}

const ACRONYMS: Record<string, string> = { pm: 'PM', tm: 'T&M', crm: 'CRM', vp: 'VP', ceo: 'CEO', cfo: 'CFO', sop: 'SOP', po: 'PO', ar: 'AR', hvac: 'HVAC', id: 'ID', qc: 'QC', gm: 'GM' }

/** A stored field name as a label: "pm_agreement_term" → "PM agreement term", "named qc program manager" → "Named QC program manager". */
export function fieldLabel(p: string): string {
  const s = p
    .split(/[_\s]+/)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w)
    .join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
