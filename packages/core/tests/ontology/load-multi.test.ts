import { describe, expect, test } from 'vitest'
import { multi } from '../../src/ontology/load'

describe('multi-valued cells', () => {
  test('comma lists of equipment codes split into separate assets', () => {
    expect(multi('Asset', 'PRESS-106, PRESS-71, PRESS-17')).toEqual(['PRESS-106', 'PRESS-71', 'PRESS-17'])
    expect(multi('Equipment', 'CV-03, TP-10')).toEqual(['CV-03', 'TP-10'])
  })
  test('names with commas stay whole', () => {
    expect(multi('Customer', 'Smith, John')).toEqual(['Smith, John'])
    expect(multi('Customer', 'Acme Pumps, Inc.')).toEqual(['Acme Pumps, Inc.'])
  })
  test('semicolons, initials and placeholders', () => {
    expect(multi('Invoice', '50025; 50433')).toEqual(['50025', '50433'])
    expect(multi('Tech', 'HO/MKH')).toEqual(['HO', 'MKH'])
    expect(multi('Tech', 'UNASSIGNED')).toEqual([])
  })
})
