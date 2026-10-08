import { describe, expect, test } from 'vitest'
import { messageLog } from '../../src/search/project'

describe('message-log tables', () => {
  test('a text column with sender and date reads as one line per message', () => {
    const f = messageLog('chat_session | message_date | service | type | sender_name | sender_id | text | attachment')!
    expect(f('Oakley Techs | 2026-08-10 08:10:00 | iMessage | Incoming | Josh Hensley | (513) 555-0101 | so we got sold | ')).toBe('2026-08-10 08:10 Josh Hensley: so we got sold')
  })
  test('ordinary tables are left alone', () => {
    expect(messageLog('Asset ID | Customer | Serial # | Install Date')).toBeNull()
  })
})
