import { describe, expect, test } from 'vitest'
import { parseTime } from '../../src/search/time'

const now = new Date('2026-10-25T12:00:00Z')
const t = (q: string) => parseTime(q, now)

describe('time in questions', () => {
  test('absolute dates', () => {
    expect(t('terms as of 2025-03-01')).toMatchObject({ mode: 'as_of', asOf: '2025-03-01' })
    expect(t('who managed Columbus in March 2025')).toMatchObject({ mode: 'as_of', asOf: '2025-03-15' })
    expect(t('what was the fee in 2020?')).toMatchObject({ mode: 'as_of', asOf: '2020-07-01' })
    expect(t('back in 2010 what did a call-out cost')).toMatchObject({ mode: 'as_of', asOf: '2010-07-01' })
  })
  test('before / after a year or month', () => {
    expect(t('what was the OT rate before 2026')).toMatchObject({ asOf: '2025-12-31' })
    expect(t('terms before March 2025').asOf).toBe('2025-02-28')
    expect(t('who handled it after 2024').asOf).toBe('2024-12-31')
  })
  test('relative dates use the client today', () => {
    expect(t('labor rate last year')).toMatchObject({ mode: 'as_of', asOf: '2025-07-01' })
    expect(t('what changed this year').asOf).toBe('2026-10-25')
    expect(t('policy two years ago').asOf).toBe('2024-07-01')
  })
  test('events become anchors resolved from the facts', () => {
    expect(t("Dave's office days before the sale closed").anchor).toEqual({ phrase: 'sale closed', relation: 'before' })
    expect(t('who covered Kroll before Tyler took it over?').anchor).toEqual({ phrase: 'tyler took it over', relation: 'before' })
    expect(t('what changed after the FieldLine switch?').anchor?.relation).toBe('after')
  })
  test('change vs current vs none', () => {
    expect(t('How has the dispatch fee changed over the years?').mode).toBe('change')
    expect(t('When did the labor rate go up?').mode).toBe('change')
    expect(t('what are the payment terms now?').mode).toBe('current')
    expect(t('Who can approve a discount today?').mode).toBe('current')
    expect(t('Big Blue payment terms').mode).toBe('none')
  })
})
