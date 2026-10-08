// Time in questions: "in 2023", "as of March 2025", "last year", "before the sale closed",
// "what is it now", "how has it changed". Pure parsing; event anchors ("the sale") are
// resolved to dates by search.ts from the company's own dated facts.

export type TimeMode = 'as_of' | 'current' | 'change' | 'none'

export interface TimeIntent {
  mode: TimeMode
  /** The date facts should be valid on (YYYY-MM-DD), when the question names one. */
  asOf: string | null
  /** An event to date from the facts ("the sale closed"), with which side of it. */
  anchor: { phrase: string; relation: 'before' | 'after' } | null
  /** Human-readable reading of the time words, for the debug view. */
  reading: string
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MON = MONTHS.map((m) => m.slice(0, 3))
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const dayBefore = (d: string) => new Date(new Date(`${d}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10)

const CURRENT = /\b(current(ly)?|now|today|these days|still|latest|in force|right now|at the moment|nowadays|any more|anymore)\b/i
const CHANGE = /\b(changed?|changes|over (the )?(time|years)|history|histor(ical|y)|evolv\w*|went (up|down)|go up|gone up|raised|increase[ds]?|decrease[ds]?|when did|since when|how long|timeline|used to|before and after|previous(ly)?|originally)\b/i
const PAST_VERB = /\b(was|were|did|had|used to|back then|at the time)\b/i

/**
 * Reads the time intent of a question. `now` anchors relative words ("last year").
 * Priority: explicit date > relative date > event anchor > change words > current words.
 */
export function parseTime(q: string, now: Date = new Date()): TimeIntent {
  const s = q.toLowerCase()
  const thisYear = now.getUTCFullYear()
  const mk = (mode: TimeMode, asOf: string | null, reading: string, anchor: TimeIntent['anchor'] = null): TimeIntent => ({ mode, asOf, anchor, reading })
  const before = /\b(before|prior to|until|up to)\b/.test(s)
  const after = /\b(after|since|from)\b/.test(s)

  // ISO date
  const isoM = s.match(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/)
  if (isoM) {
    const d = `${isoM[1]}-${isoM[2]}-${isoM[3]}`
    return mk(CURRENT.test(s) && !PAST_VERB.test(s) ? 'current' : 'as_of', before ? dayBefore(d) : d, `on ${d}`)
  }
  // "March 2025", "mar 2025", "march of 2025"
  const monM = s.match(new RegExp(`\\b(${MONTHS.join('|')}|${MON.join('|')})\\.?\\s+(?:of\\s+)?((?:19|20)\\d{2})\\b`))
  if (monM) {
    const m = (MONTHS.indexOf(monM[1]) >= 0 ? MONTHS.indexOf(monM[1]) : MON.indexOf(monM[1].slice(0, 3))) + 1
    const y = Number(monM[2])
    const d = before ? dayBefore(iso(y, m, 1)) : after ? iso(y, m, lastDay(y, m)) : iso(y, m, 15)
    return mk('as_of', d, `${MONTHS[m - 1]} ${y}${before ? ' (before)' : after ? ' (after)' : ''}`)
  }
  // "in 2023", "during 2023", "back in 2019", "2023" with a past verb, "before 2020", "after 2024"
  const yearM = s.match(/\b(in|during|back in|as of|for|before|by|after|since|around|until)?\s*((?:19|20)\d{2})\b/)
  if (yearM && !/\b\d{4}-\d/.test(s)) {
    const y = Number(yearM[2])
    const w = yearM[1]
    const d = w === 'before' || w === 'until' ? `${y - 1}-12-31` : w === 'after' || w === 'since' ? `${y}-12-31` : y === thisYear ? now.toISOString().slice(0, 10) : `${y}-07-01`
    if (w || PAST_VERB.test(s) || y < thisYear) return mk(CHANGE.test(s) && (w === 'since' || w === 'after') ? 'change' : 'as_of', d, `${w ?? 'in'} ${y}`)
  }
  // Relative: last year / this year / last month / N years ago
  if (/\blast year\b/.test(s)) return mk('as_of', `${thisYear - 1}-07-01`, `last year (${thisYear - 1})`)
  if (/\bthis year\b/.test(s)) return mk('current', now.toISOString().slice(0, 10), `this year (${thisYear})`)
  if (/\blast month\b/.test(s)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))
    return mk('as_of', d.toISOString().slice(0, 10), 'last month')
  }
  const ago = s.match(/\b(\d{1,2}|a|one|two|three|five|ten)\s+years?\s+ago\b/)
  if (ago) {
    const n = { a: 1, one: 1, two: 2, three: 3, five: 5, ten: 10 }[ago[1] as 'a'] ?? Number(ago[1])
    return mk('as_of', `${thisYear - n}-07-01`, `${n} year(s) ago`)
  }
  // Event anchors: "before the sale closed", "after Tom left", "since the switch to FieldLine"
  const ev = s.match(/\b(before|prior to|after|since|until)\s+(?:the\s+|we\s+|they\s+|he\s+|she\s+)?([a-z][a-z0-9 '&.-]{2,40}?)(?=\s*(?:\?|,|\.|$|\band\b|\bor\b|\bwhat\b|\bwho\b))/)
  if (ev && !/^(that|this|then|now|today|it|them|him|her)\b/.test(ev[2])) {
    const relation = ev[1] === 'after' || ev[1] === 'since' ? 'after' : 'before'
    return mk(relation === 'after' && CURRENT.test(s) ? 'current' : 'as_of', null, `${ev[1]} "${ev[2]}"`, { phrase: ev[2].trim(), relation })
  }
  if (CHANGE.test(s)) return mk('change', null, 'how it changed')
  if (CURRENT.test(s)) return mk('current', now.toISOString().slice(0, 10), 'now')
  return mk('none', null, '')
}
