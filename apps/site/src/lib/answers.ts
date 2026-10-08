/**
 * Sample answers shown in product mocks. Illustrative, drawn from the demo company
 * (a fictional industrial services business), never a real customer.
 */
export type SourceKind = 'document' | 'system' | 'email' | 'video' | 'interview' | 'spreadsheet' | 'photo'
export type SourceStatus = 'current' | 'outdated' | 'supporting'

export type Citation = {
  kind: SourceKind
  title: string
  locator: string
  status: SourceStatus
  note?: string
}

export type TimelineStep = { when: string; value: string; current?: boolean }

export type Answer = {
  id: string
  question: string
  group: 'now' | 'unknown'
  summary: string
  detail?: string
  timeline?: TimelineStep[]
  citations: Citation[]
}

export const answers: Answer[] = [
  {
    id: 'terms',
    group: 'now',
    question: "What are Blue Ridge's actual payment terms?",
    summary: 'Net 60, effective July 1, 2025.',
    detail:
      'The 2025 amendment moved Blue Ridge from Net 30 to Net 60. QuickBooks still shows Net 30 on the customer record, so the books and the contract disagree.',
    timeline: [
      { when: '2022', value: 'Net 30' },
      { when: 'Jul 2025', value: 'Net 60', current: true },
    ],
    citations: [
      { kind: 'document', title: 'Blue Ridge MSA, Amendment 2.pdf', locator: 'p. 2, § 4 Payment terms', status: 'current' },
      {
        kind: 'system',
        title: 'QuickBooks: BLUE RIDGE FOOD PROCESSING',
        locator: 'Customer record, Terms',
        status: 'outdated',
        note: 'Still Net 30',
      },
      { kind: 'email', title: 'Re: Blue Ridge renewal terms', locator: 'Thread, 6 messages, Jun 2025', status: 'supporting' },
    ],
  },
  {
    id: 'waivers',
    group: 'now',
    question: 'Which customers get fees waived, and why?',
    summary: 'Five customers have standing waivers. Only two are written down.',
    detail:
      'Mill Creek Rendering is one of them: billing waives the trip charge by habit, and it shows up on invoices but in no contract. The other three live in the billing lead’s memory.',
    citations: [
      { kind: 'video', title: 'Billing screen recording.mov', locator: '0:50, “we always waive Mill Creek”', status: 'current' },
      { kind: 'interview', title: 'Interview: billing lead', locator: '14:32, speaker 2', status: 'supporting' },
      { kind: 'document', title: 'Invoice 61543.pdf', locator: 'p. 1, line 3, trip charge $0.00', status: 'supporting' },
    ],
  },
  {
    id: 'aliases',
    group: 'now',
    question: 'Who is “Fifer”, and where is “J-town”?',
    summary: '“Fifer” is Pfeiffer Brothers Meats. “J-town” is the Louisville branch.',
    detail:
      'Both are shop-floor nicknames that appear in dispatch notes and interviews but never in the CRM. We keep every spelling we find: Mill Creek Rendering also appears as “Mil Creek”, “Mill Crek” and “MillCreek”.',
    citations: [
      { kind: 'interview', title: 'Interview: dispatch supervisor', locator: '08:11, speaker 1', status: 'current' },
      { kind: 'spreadsheet', title: 'dispatch db / WorkOrders.csv', locator: 'rows 27241–27280, notes column', status: 'supporting' },
    ],
  },
  {
    id: 'single-person',
    group: 'unknown',
    question: 'Which critical work depends on only one person?',
    summary: 'Billing exceptions and IT each rest on a single person.',
    detail:
      'Only the billing lead knows all five fee waivers. IT is run by a field technician who handles it on the side. Neither is documented anywhere else.',
    citations: [
      { kind: 'interview', title: 'Interview: billing lead', locator: '14:32, “I’m the only one who knows those”', status: 'current' },
      { kind: 'interview', title: 'Interview: operations manager', locator: '22:05, “Kyle is also our IT department”', status: 'current' },
    ],
  },
  {
    id: 'training',
    group: 'unknown',
    question: 'Where does training contradict current policy?',
    summary: 'The lockout/tagout training video teaches a procedure that changed in October 2025.',
    detail:
      'The 2024 training video shows single-technician verification from Rev 3. Rev 4, effective October 15, 2025, requires two people on ammonia systems. The old video is still in the onboarding folder.',
    timeline: [
      { when: '2024', value: 'Rev 3: one technician verifies' },
      { when: 'Oct 2025', value: 'Rev 4: two people for ammonia', current: true },
    ],
    citations: [
      { kind: 'document', title: 'Safety / SOP-LOTO Rev 4.pdf', locator: 'p. 1, § 2 Responsibilities', status: 'current' },
      { kind: 'video', title: 'LOTO training 2024.mp4', locator: '0:20, “SOP-LOTO Rev 3” on screen', status: 'outdated' },
    ],
  },
  {
    id: 'rate',
    group: 'unknown',
    question: 'Are we charging the labor rate we think we are?',
    summary: 'The standard rate is $132/hour since January 1, 2026, but not every customer pays it.',
    detail:
      'The field-service system is the source of truth for rates. Customers on legacy pricing or verbal waivers are billed below standard, and nobody has reviewed them since the rate changed.',
    citations: [
      { kind: 'system', title: 'FieldLine: rates.csv', locator: 'Standard labor, effective 2026-01-01', status: 'current' },
      { kind: 'spreadsheet', title: 'Legacy pricing.xlsx', locator: 'Sheet “Old rates”, rows 4–19', status: 'outdated' },
    ],
  },
]
