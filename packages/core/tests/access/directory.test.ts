import { describe, expect, test } from 'vitest'
import { mergeDirectory, SENSITIVE_COLUMN, type SourceRow } from '../../src/access/directory'

let n = 0
const row = (system: string, authority: number, values: SourceRow['values'], role: SourceRow['role'] = 'people'): SourceRow => ({
  file_id: system,
  path: `${system}.csv`,
  system,
  authority,
  role,
  row: ++n,
  values,
})

const rows: SourceRow[] = [
  // Identity provider (M365): emails, enabled flags.
  row('M365', 2, { name: 'Dave Brennan', email: 'david.brennan@acme.com', title: 'President', department: 'Executive', enabled: 'TRUE' }),
  row('M365', 2, { name: 'Greg Whitfield', email: 'greg.whitfield@acme.com', title: 'Sales Manager', enabled: 'TRUE' }),
  row('M365', 2, { name: 'Scanner Oakley', email: 'scanner@acme.com', enabled: 'TRUE' }),
  row('M365', 2, { name: 'Dispatch', email: 'dispatch@acme.com', account_type: 'SharedMailbox' }),
  row('M365', 2, { name: 'Heather Quinn', email: 'heather.quinn@acme.com', account_type: 'SharedMailbox', enabled: 'FALSE' }),
  row('ADP', 1, { name: 'Heather Quinn', email: 'heather.quinn@acme.com', status: 'Terminated', account_type: 'Non-Exempt' }),
  row('M365', 2, { name: 'Linda Marsh', email: 'linda.marsh@acme.com', account_type: 'User', enabled: 'TRUE' }),
  row('VDR', 3, { name: 'Linda Marsh', email: 'linda.marsh@acme.com', account_type: 'Seller - Finance' }),
  // HR system of record: wins on title/manager, decides employment status.
  row('ADP', 1, { first_name: 'David', last_name: 'Brennan', preferred_name: 'Dave', email: 'DAVID.BRENNAN@acme.com', title: 'Founder & President', department: 'Executive', location: 'Oakley', status: 'Active' }),
  row('ADP', 1, { first_name: 'Gregory', last_name: 'Whitfield', email: 'greg.whitfield@acme.com', title: 'Sales Manager', status: 'Terminated', end_date: '2026-02-13', manager: 'Brennan, David', location: 'Oakley' }),
  row('ADP', 1, { name: 'Tyler Brandt', title: 'Field Technician II', manager: 'Dave Brennan', status: 'Active', location: 'Oakley' }),
  // App users without email for Tyler: attaches by exact name.
  row('FieldLine', 3, { name: 'Tyler Brandt', external_id: 'U-1', status: 'Active' }),
  // Guest.
  row('Guests', 3, { name: 'Owen Mercer', email: 'omercer@northgate.com' }, 'guests'),
  // Group membership.
  row('M365', 2, { group: 'Sales', member_email: 'greg.whitfield@acme.com', member_name: 'Greg Whitfield' }, 'group_membership'),
  row('M365', 2, { group: 'Sales', member_name: 'Nobody Known' }, 'group_membership'),
  row('M365', 2, { group: 'Mgmt Team', member_name: 'Owen Mercer' }, 'group_membership'),
]
const map = mergeDirectory(rows, ['acme.com'])
const person = (email: string) => map.people.find((p) => p.emails.includes(email))!

describe('mergeDirectory', () => {
  test('joins the same person across systems by email (case-insensitive), keeping all names', () => {
    const dave = person('david.brennan@acme.com')
    expect(dave.systems.sort()).toEqual(['ADP', 'M365'])
    expect(dave.names).toEqual(expect.arrayContaining(['Dave Brennan', 'Dave Brennan']))
  })

  test('the HR system of record wins on title and is the display name source', () => {
    expect(person('david.brennan@acme.com').title).toBe('Founder & President')
  })

  test('terminated in HR but still enabled elsewhere is former, with a conflict', () => {
    const greg = person('greg.whitfield@acme.com')
    expect(greg.status).toBe('former')
    expect(greg.conflicts.join(' ')).toMatch(/still active in M365/)
  })

  test('rows without email attach to an existing person by exact name', () => {
    const tyler = map.people.find((p) => p.display_name === 'Tyler Brandt')!
    expect(tyler.systems.sort()).toEqual(['ADP', 'FieldLine'])
    expect(tyler.external_ids.FieldLine).toBe('U-1')
  })

  test('managers resolve by name, including "Last, First" and nicknames via unique initial+last', () => {
    const greg = person('greg.whitfield@acme.com')
    const tyler = map.people.find((p) => p.display_name === 'Tyler Brandt')!
    expect(greg.manager_key).toBe(person('david.brennan@acme.com').key)
    expect(tyler.manager_key).toBe(person('david.brennan@acme.com').key)
  })

  test('a former employee whose mailbox became shared is still a (former) person; unrelated "type" values are ignored', () => {
    expect(person('heather.quinn@acme.com').status).toBe('former')
    expect(person('heather.quinn@acme.com').conflicts.join(' ')).toMatch(/mailbox is now a SharedMailbox/)
    expect(person('linda.marsh@acme.com').status).toBe('active')
  })

  test('guests, service accounts and shared mailboxes are not employees', () => {
    expect(person('omercer@northgate.com').status).toBe('guest')
    expect(person('scanner@acme.com').status).toBe('service')
    expect(person('dispatch@acme.com').status).toBe('service')
  })

  test('department/location groups hold active people only; unknown members are reported', () => {
    const oakley = map.groups.find((g) => g.group_type === 'location' && g.name === 'Oakley')!
    expect(oakley.members).not.toContain(person('greg.whitfield@acme.com').key)
    expect(map.groups.find((g) => g.group_type === 'system_group' && g.name === 'Sales')).toBeUndefined() // only member is former
    expect(map.excluded).toContainEqual(expect.objectContaining({ group: 'Sales', status: 'former' }))
    expect(map.unresolved).toContainEqual({ kind: 'member', value: 'Nobody Known', where: 'Sales' })
  })

  test('guests and former staff are not copied into groups (they never inherit access); the skip is recorded', () => {
    expect(map.groups.find((g) => g.name === 'Mgmt Team')).toBeUndefined()
    expect(map.excluded).toContainEqual({ group: 'Mgmt Team', person: 'Owen Mercer', status: 'guest' })
  })

  test('pay and identity columns are recognised as sensitive', () => {
    for (const c of ['Rate', 'Pay Type', 'Salary', 'SSN', 'Date of Birth', 'Bank Routing']) expect(SENSITIVE_COLUMN.test(c), c).toBe(true)
    for (const c of ['Work Email', 'Job Title', 'Home Department', 'Reports To']) expect(SENSITIVE_COLUMN.test(c), c).toBe(false)
  })
})
