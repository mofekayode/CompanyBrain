import { describe, expect, test } from 'vitest'
import { availableOn, deliveredPath } from '../../src/access/knowledge-view'
import { locatorOf } from '../../src/evals/contract'

const handoff = { name: 'Phone uploads', root: 'company-as-found/Phone uploads', batch: '2026-10-10-handoff' }
const captures = { name: 'FDE interview recordings', root: 'fde-captures/audio', batch: 'fde-captures' }
const file = (original_path: string, extra: { source_modified_at?: string; captured_at?: string } = {}) => ({ original_path, source_modified_at: extra.source_modified_at ?? null, captured_at: extra.captured_at ?? null })

describe('knowledge cutoff: when a file became available', () => {
  test('a dated delivery batch dates every file in it', () => {
    expect(availableOn(handoff, file('IMG_6418.MOV', { source_modified_at: '2023-05-09T00:00:00Z' }))).toBe('2026-10-10')
  })
  test('otherwise the date in the name, else the recording time, else the modified time', () => {
    expect(availableOn(captures, file('2026-10-16 09.42 Dee - dispatch.m4a', { source_modified_at: '2026-11-01T00:00:00Z' }))).toBe('2026-10-16')
    expect(availableOn(captures, file('Sarah O.m4a', { captured_at: '2026-10-21T15:00:00Z', source_modified_at: '2026-11-01T00:00:00Z' }))).toBe('2026-10-21')
    expect(availableOn(captures, file('Dave 2.m4a', { source_modified_at: '2026-10-28T09:00:00Z' }))).toBe('2026-10-28')
  })
  test('a file from no delivered source is never available', () => {
    expect(availableOn(undefined, file('DEMO memo.txt'))).toBeNull()
  })
})

describe('delivered paths', () => {
  test('folder sources prefix the path; single-file sources are the file', () => {
    expect(deliveredPath(handoff, 'texts/Marcus.csv')).toBe('company-as-found/Phone uploads/texts/Marcus.csv')
    expect(deliveredPath({ name: 'README', root: 'company-as-found/README_FROM_NORTHGATE.txt' }, 'README_FROM_NORTHGATE.txt')).toBe('company-as-found/README_FROM_NORTHGATE.txt')
  })
})

describe('locators', () => {
  test('pages, slides, rows, times and messages', () => {
    expect(locatorOf('a/Policy.pdf', { page_start: 3 })).toBe('page=3')
    expect(locatorOf('a/QBR.pptx', { page_start: 5 })).toBe('slide=5')
    expect(locatorOf('a/x.xlsx', { sheet: 'Hamilton 2026', row_start: 42 })).toBe('sheet=Hamilton 2026;row=42')
    expect(locatorOf('a/x.csv', { sheet: 'CSV', row_start: 42 })).toBe('row=42')
    expect(locatorOf('a/Dave.m4a', { start_ms: 12400, end_ms: 15000 })).toBe('t=12.4-15.0')
    expect(locatorOf('a/linda.mbox', { message_id: 'abc@x' })).toBe('msg=abc@x')
  })
})
