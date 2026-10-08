import { describe, expect, test, vi } from 'vitest'

vi.mock('../../src/workbench/server', () => ({ pool: () => { throw new Error('no db in unit tests') }, store: () => { throw new Error('no s3') } }))

const { normalizePhase, TOOLS } = await import('../../src/workbench/tools')

describe('workbench tools', () => {
  test('phase names the model might use all map to the catalog phase', () => {
    for (const p of [undefined, '4', 'p4', 'P4', 'phase 4', 'Phase 4']) expect(normalizePhase(p)).toBe('4')
    expect(normalizePhase('10')).toBe('10')
  })

  test('every tool exposes a JSON schema object the API accepts', () => {
    for (const t of TOOLS) {
      expect(t.definition.input_schema.type).toBe('object')
      expect(t.definition.description?.length ?? 0).toBeGreaterThan(20)
    }
  })

  test('read_file and get_file_profile name the file once the result is known', () => {
    const read = TOOLS.find((t) => t.definition.name === 'read_file')!
    expect(read.summarizeResult?.({ id: 'x' } as never, { path: 'fields.csv' })).toBe('Read fields.csv')
    const profile = TOOLS.find((t) => t.definition.name === 'get_file_profile')!
    expect(profile.summarizeResult?.({ id: 'x' } as never, { source_name: 'IT exports', original_path: 'users.csv' })).toBe('Profile IT exports / users.csv')
  })

  test('query_inventory allows semicolons inside string literals', async () => {
    const q = TOOLS.find((t) => t.definition.name === 'query_inventory')!
    // Passes validation, then fails only because unit tests have no database.
    await expect(q.run({ sql: "select string_agg(source_name, '; ') from source_inventory" } as never, { tenantId: 't', sessionId: 's' })).rejects.toThrow(/no db/)
  })

  test('query_inventory rejects anything but a single SELECT', async () => {
    const q = TOOLS.find((t) => t.definition.name === 'query_inventory')!
    for (const sql of ['delete from source_objects', 'select 1; drop table x', 'update x set y = 1']) {
      await expect(q.run({ sql } as never, { tenantId: 't', sessionId: 's' })).rejects.toThrow(/Only a single SELECT/)
    }
  })
})
