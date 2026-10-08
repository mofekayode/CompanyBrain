import { describe, expect, test } from 'vitest'
import { buildAddresses, buildThreads, departureNearName, type MessageRow, normalizeSubject } from '../../src/extraction/email-index'

let n = 0
const msg = (p: Partial<MessageRow>): MessageRow => ({
  documentId: `d${++n}`,
  messageId: null,
  inReplyTo: null,
  references: [],
  subject: null,
  date: null,
  from: [],
  to: [],
  cc: [],
  aclId: null,
  hasAttachments: false,
  forwarded: false,
  ...p,
})
const p = (address: string, name = '') => ({ address, name })

describe('normalizeSubject', () => {
  test('strips reply/forward prefixes and tags, repeatedly', () => {
    expect(normalizeSubject('RE: Fwd: [EXT] Kemper  pricing ')).toBe('kemper pricing')
    expect(normalizeSubject('AW: RE[2]: Pump 7')).toBe('pump 7')
  })
})

describe('buildThreads', () => {
  test('links by Message-ID headers, orders by date and records reply depth', () => {
    const a = msg({ messageId: 'a@x', subject: 'Kemper pricing', date: '2025-03-01T10:00:00Z', from: [p('dave@riverton.com')] })
    const b = msg({ messageId: 'b@x', inReplyTo: 'a@x', references: ['a@x'], subject: 'Re: Kemper pricing', date: '2025-03-02T10:00:00Z' })
    const c = msg({ messageId: 'c@x', inReplyTo: 'b@x', references: ['a@x', 'b@x'], subject: 'Re: Kemper pricing', date: '2025-03-03T10:00:00Z' })
    const [t] = buildThreads([c, a, b])
    expect(t.linkedBy).toBe('headers')
    expect(t.key).toBe('a@x')
    expect(t.messages.map((m) => [m.documentId, m.depth])).toEqual([
      [a.documentId, 0],
      [b.documentId, 1],
      [c.documentId, 2],
    ])
    expect(t.missingMessages).toBe(0)
  })

  test('replies to a message missing from the corpus still form one thread', () => {
    const b = msg({ messageId: 'b@x', inReplyTo: 'gone@x', references: ['gone@x'], date: '2025-03-02T10:00:00Z' })
    const c = msg({ messageId: 'c@x', inReplyTo: 'gone@x', references: ['gone@x'], date: '2025-03-03T10:00:00Z' })
    const threads = buildThreads([b, c])
    expect(threads).toHaveLength(1)
    expect(threads[0].missingMessages).toBe(1)
  })

  test('falls back to subject + shared people within 60 days, but not for generic subjects', () => {
    const dave = p('dave@riverton.com')
    const a = msg({ subject: 'Pump 7 seal', date: '2025-03-01T10:00:00Z', from: [dave] })
    const b = msg({ subject: 'RE: Pump 7 seal', date: '2025-03-05T10:00:00Z', to: [dave] })
    const far = msg({ subject: 'Pump 7 seal', date: '2025-09-01T10:00:00Z', from: [dave] })
    const g1 = msg({ subject: 'Question', date: '2025-03-01T10:00:00Z', from: [dave] })
    const g2 = msg({ subject: 'RE: question', date: '2025-03-02T10:00:00Z', to: [dave] })
    const threads = buildThreads([a, b, far, g1, g2])
    const pump = threads.find((t) => t.messages.some((m) => m.documentId === a.documentId))!
    expect(pump.linkedBy).toBe('subject')
    expect(pump.messages.map((m) => m.documentId)).toEqual([a.documentId, b.documentId])
    expect(threads).toHaveLength(4)
  })

  test('a thread whose messages carry different ACLs is marked mixed', () => {
    const a = msg({ messageId: 'a@x', aclId: 'acl-1' })
    const b = msg({ messageId: 'b@x', inReplyTo: 'a@x', aclId: 'acl-2' })
    const [t] = buildThreads([a, b])
    expect(t.mixedAcl).toBe(true)
    expect(t.aclId).toBeNull()
  })
})

describe('buildAddresses', () => {
  const d = (day: string) => `2025-${day}T12:00:00Z`
  const messages = [
    // Old domain used until March, new domain from April.
    msg({ date: d('01-10'), from: [p('linda@rivertonsupply.com', 'Linda Park')], to: [p('ar@rivertonsupply.com', 'Accounts Receivable')] }),
    msg({ date: d('02-10'), from: [p('linda@rivertonsupply.com', 'Linda Park')], to: [p('bob@acme.com', 'Bob')] }),
    msg({ date: d('09-10'), from: [p('linda@rivertonmech.com', 'Linda Park')], to: [p('bob@acme.com', 'Bob')] }),
    // Dave emails regularly, then goes quiet in February; Chris emails once (too little to judge).
    msg({ date: d('01-05'), from: [p('dave@rivertonmech.com', 'Dave Ruiz')], to: [p('bob@acme.com', 'Bob')] }),
    msg({ date: d('01-20'), from: [p('dave@rivertonmech.com', 'Dave Ruiz')], to: [p('bob@acme.com', 'Bob')] }),
    msg({ date: d('02-01'), from: [p('dave@rivertonmech.com', 'Dave Ruiz')], to: [p('bob@acme.com', 'Bob')] }),
    msg({ date: d('01-15'), from: [p('chris@rivertonmech.com', 'Chris Novak')], to: [p('bob@acme.com', 'Bob')] }),
    // A list that only receives.
    msg({ date: d('09-20'), from: [p('linda@rivertonmech.com', 'Linda Park')], to: [p('allstaff@rivertonmech.com', 'All Staff')] }),
    msg({ date: d('09-21'), from: [p('linda@rivertonmech.com', 'Linda Park')], to: [p('allstaff@rivertonmech.com', 'All Staff')] }),
    // Several people send as dispatch@.
    msg({ date: d('09-01'), from: [p('desk@rivertonmech.com', 'Maria')], to: [p('bob@acme.com')] }),
    msg({ date: d('09-02'), from: [p('desk@rivertonmech.com', 'Tom')], to: [p('bob@acme.com')] }),
    msg({ date: d('09-03'), from: [p('desk@rivertonmech.com', 'Sam')], to: [p('bob@acme.com')] }),
    msg({ date: d('10-01'), from: [p('bob@acme.com', 'Bob')], to: [p('linda@rivertonmech.com')] }),
  ]
  const rows = buildAddresses(messages, 'Riverton')
  const by = (a: string) => rows.find((r) => r.address === a)!

  test('client domains are internal; others are external', () => {
    expect(by('linda@rivertonmech.com').internal).toBe(true)
    expect(by('bob@acme.com').internal).toBe(false)
  })

  test('a client domain that stopped being used is old, with a reason', () => {
    expect(by('linda@rivertonsupply.com').domainStatus).toBe('old')
    expect(by('linda@rivertonmech.com').domainStatus).toBe('current')
    expect(by('linda@rivertonsupply.com').signals.old_domain).toMatch(/last used 2025-02-10/)
  })

  test('role and shared mailboxes are flagged', () => {
    expect(by('ar@rivertonsupply.com').roleMailbox).toBe(true)
    expect(by('desk@rivertonmech.com').sharedMailbox).toBe(true)
    expect(by('linda@rivertonmech.com').sharedMailbox).toBe(false)
  })

  test('an internal person who used to email and went quiet is possibly former; one email is too little to judge', () => {
    expect(by('dave@rivertonmech.com').possiblyFormer).toBe(true)
    expect(by('chris@rivertonmech.com').possiblyFormer).toBe(false)
    expect(by('linda@rivertonmech.com').possiblyFormer).toBe(false)
    expect(by('bob@acme.com').possiblyFormer).toBe(false)
  })

  test('an old-domain address of someone still active on the new domain is not former', () => {
    expect(by('linda@rivertonsupply.com').possiblyFormer).toBe(false)
  })

  test('group addresses are role mailboxes, not people', () => {
    expect(by('allstaff@rivertonmech.com').roleMailbox).toBe(true)
    expect(by('allstaff@rivertonmech.com').possiblyFormer).toBe(false)
  })

  test('the same person on another domain is linked as a likely alias', () => {
    expect(by('linda@rivertonmech.com').samePersonAs).toEqual(['linda@rivertonsupply.com'])
  })
})

describe('departureNearName', () => {
  test('a departure word close to the full name counts', () => {
    expect(departureNearName('Branch managers report to her. Tom Jablonski is retiring June 30.', 'Tom Jablonski')).toBe(true)
  })
  test('names in the email header block do not count', () => {
    const email = 'From: Linda Marsh <l@x.com>\nTo: Team\nSubject: Holiday\n\nPlease stop leaving dishes in the sink.'
    expect(departureNearName(email, 'Linda Marsh')).toBe(false)
  })
  test('a speaker label is not a mention', () => {
    expect(departureNearName('[09:42] Jim Polk: stop leaving tablets in the trucks', 'Jim Polk')).toBe(false)
  })
  test('far apart does not count', () => {
    expect(departureNearName(`Kevin Doyle ${'word '.repeat(30)} left`, 'Kevin Doyle')).toBe(false)
  })
})
