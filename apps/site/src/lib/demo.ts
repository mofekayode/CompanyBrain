/**
 * Data for the clickable product mock in the hero. Illustrative, from the fictional
 * demo company. Replaced by the live demo once the client product exists.
 */
import type { SourceKind } from './answers'

export type DemoCustomer = {
  name: string
  aliases: string[]
  note: string
  tone: 'stale' | 'info'
  answerId?: string
  facts?: [string, string][]
  owner?: { onPaper: string; inPractice: string }
}

export const customers: DemoCustomer[] = [
  {
    name: 'Blue Ridge Foods',
    aliases: ['Big Blue', 'BLUE RIDGE FOOD PROCESSING', 'Blue Ridge Mills'],
    note: 'Books still show Net 30; contract says Net 60',
    tone: 'stale',
    answerId: 'terms',
    facts: [
      ['Sites', '4'],
      ['Open work orders', '12'],
      ['Terms', 'Net 60'],
    ],
    owner: { onPaper: 'the seller', inPractice: 'service manager' },
  },
  {
    name: 'Mill Creek Rendering',
    aliases: ['Mil Creek', 'Mill Crek', 'MillCreek'],
    note: 'Trip charge waived by habit, not in any contract',
    tone: 'stale',
    answerId: 'waivers',
    facts: [['Trip charge', 'Waived']],
  },
  {
    name: 'Pfeiffer Brothers Meats',
    aliases: ['Fifer'],
    note: 'Called “Fifer” in dispatch notes and interviews',
    tone: 'info',
    answerId: 'aliases',
  },
]

export type DemoPerson = { name: string; role: string; knows: string; risk: 'high' | 'watch'; answerId?: string }

export const people: DemoPerson[] = [
  { name: 'Rhonda', role: 'Billing lead', knows: 'Only person who knows all five fee waivers', risk: 'high', answerId: 'single-person' },
  { name: 'Kyle', role: 'Field technician', knows: 'Also runs the company’s IT, undocumented', risk: 'high', answerId: 'single-person' },
  { name: 'Tom Jablonski', role: 'Senior technician', knows: 'Retiring June 30', risk: 'watch' },
  { name: 'Dave Brennan', role: 'Operations', knows: 'Terminated in payroll, still active in email', risk: 'watch' },
]

export type DemoSearchHit = { kind: SourceKind | 'customer'; title: string; detail: string; match: string }

export const search = {
  query: 'mill crek',
  resolved: 'Mill Creek Rendering',
  alsoSearched: ['Mil Creek', 'MillCreek'],
  hits: [
    { kind: 'customer', title: 'Mill Creek Rendering', detail: 'Customer · 3 other spellings', match: 'Mill Crek' },
    { kind: 'video', title: 'Billing screen recording.mov', detail: '0:50 · “we always waive Mill Creek”', match: 'Mill Creek' },
    { kind: 'document', title: 'Invoice 61543.pdf', detail: 'p. 1 · trip charge $0.00', match: 'MILL CREEK RENDERING' },
    { kind: 'spreadsheet', title: 'dispatch db / WorkOrders.csv', detail: 'rows 27241–27280 · notes', match: 'Mil Creek' },
  ] satisfies DemoSearchHit[],
}

export const sources: { kind: SourceKind; name: string; detail: string }[] = [
  { kind: 'email', name: 'Email archive', detail: '784 messages · 546 threads' },
  { kind: 'interview', name: 'Interviews', detail: '13 recordings · speaker-labelled' },
  { kind: 'video', name: 'Videos & screen recordings', detail: 'Scene by scene, with on-screen text' },
  { kind: 'document', name: 'Shared drive', detail: 'Contracts, SOPs, price lists' },
  { kind: 'system', name: 'QuickBooks export', detail: 'Customers, invoices, terms' },
  { kind: 'system', name: 'Field service system', detail: 'Work orders, rates, assets' },
  { kind: 'photo', name: 'Scans & photos', detail: 'Read with OCR' },
]

export const sourceTotals = '1,333 files · 7.7k cited passages'

export const recent: { label: string; answerId: string }[] = [
  { label: 'Mill Creek trip charges', answerId: 'waivers' },
  { label: 'Ammonia LOTO procedure', answerId: 'training' },
  { label: 'Who is “Fifer”?', answerId: 'aliases' },
]
