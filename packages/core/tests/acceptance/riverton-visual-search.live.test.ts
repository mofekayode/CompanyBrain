// Visual knowledge acceptance on the real Riverton corpus: search must return the
// right video or photo and the exact timestamp. Needs the live database with
// Riverton extracted. Run: LIVE_DB=1 npx vitest run tests/acceptance

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { type EvidenceKind, getEvidence, searchEvidence } from '../../src/workbench/evidence-search'
import { pool } from '../../src/workbench/server'

const live = process.env.LIVE_DB === '1'
let tenantId = ''

beforeAll(async () => {
  if (!live) return
  tenantId = (await pool().query<{ id: string }>(`select id from public.tenants where slug = 'riverton'`)).rows[0].id
})
afterAll(async () => {
  if (live) await pool().end()
})

/** Top hit for a query, restricted to visual evidence unless kinds are given. */
async function top(query: string, kinds: EvidenceKind[] = ['video_segment']) {
  const r = await searchEvidence(tenantId, query, { kinds, limit: 5 })
  expect(r.hits.length, `no hits for "${query}"`).toBeGreaterThan(0)
  return r.hits[0]
}
const seconds = (ms: number | null) => (ms ?? -1) / 1000
/** The part of a video segment's content after "Speech:" (what was said) vs before it (what was shown). */
async function parts(evidenceId: string) {
  const rows = (await getEvidence(tenantId, evidenceId, 0))!
  const content = String(rows[0].content)
  const i = content.indexOf('Speech:')
  return { shown: i >= 0 ? content.slice(0, i) : content, said: i >= 0 ? content.slice(i) : '' }
}

describe.skipIf(!live)('Riverton visual knowledge search', () => {
  test('important fact spoken: the Mill Creek trip charge is waived (said, not shown)', async () => {
    const hit = await top('trip charge')
    expect(hit.file_path).toMatch(/Screen Recording 2026-10-19/)
    expect(seconds(hit.start_ms)).toBeGreaterThanOrEqual(50)
    expect(seconds(hit.start_ms)).toBeLessThan(70)
    const { said, shown } = await parts(hit.evidence_id)
    expect(said).toMatch(/trip charge/i)
    expect(shown).not.toMatch(/trip charge/i)
  })

  test('important identifier only visible: asset EQ-844755 appears on screen but is never spoken', async () => {
    const hit = await top('EQ-844755')
    expect(hit.file_path).toMatch(/Screen Recording 2026-10-19/)
    expect(seconds(hit.start_ms)).toBeGreaterThanOrEqual(15)
    expect(seconds(hit.start_ms)).toBeLessThan(50)
    const { said, shown } = await parts(hit.evidence_id)
    expect(shown).toMatch(/EQ-844755/)
    expect(said).not.toMatch(/844755/)
  })

  test('important information on a whiteboard: the root-cause diagram says NOT alignment', async () => {
    const hit = await top('NOT alignment suction', ['image', 'video_segment'])
    expect(hit.file_path).toMatch(/IMG_4127/)
  })

  test('equipment visually demonstrated: the multistage pump with residue at its base', async () => {
    const hit = await top('vertical multistage pump residue')
    expect(hit.file_path).toMatch(/IMG_2967\.MOV/)
    expect(seconds(hit.start_ms)).toBeGreaterThanOrEqual(15)
    expect(seconds(hit.start_ms)).toBeLessThan(35)
  })

  test('no useful speech: a clip with no words (only a sound) of a worn impeller is still found', async () => {
    const hit = await top('impeller')
    expect(hit.file_path).toMatch(/IMG_5937\.MOV/)
    expect(seconds(hit.start_ms)).toBe(0)
    // Sound tags like [chime] and speaker labels are not words.
    const words = (await parts(hit.evidence_id)).said.replace(/Speech:|Speaker \d+:|\[[^\]]*\]/g, '').trim()
    expect(words).toBe('')
  })

  test('alias spoken while official ID appears: "Revision three" said while SOP-LOTO Rev 3 is on screen', async () => {
    // The ID alone finds the video (it is on several slides); the spoken alias alone finds it too.
    expect((await top('SOP-LOTO Rev 3')).file_path).toMatch(/LOTO training March 2024/)
    expect((await top('revision three')).file_path).toMatch(/LOTO training March 2024/)
    // Together they pin the moment both happen.
    const hit = await top('SOP-LOTO Rev 3 revision three')
    expect(hit.file_path).toMatch(/LOTO training March 2024/)
    expect(seconds(hit.start_ms)).toBeGreaterThanOrEqual(20)
    expect(seconds(hit.start_ms)).toBeLessThan(35)
    const { said, shown } = await parts(hit.evidence_id)
    expect(shown).toMatch(/SOP-LOTO Rev 3/)
    expect(said).toMatch(/Revision three/i)
  })

  test('obsolete procedure demonstrated: the training (Rev 3, verify yourself) vs Rev 4 two-person verification', async () => {
    const video = await top('verify zero energy')
    expect(video.file_path).toMatch(/LOTO training March 2024/)
    const newer = await searchEvidence(tenantId, 'two-person verification ammonia', { limit: 10 })
    const rev4 = newer.hits.find((h) => /SOP-LOTO Rev 4/.test(h.file_path) || /Rev 4/.test(h.snippet))
    expect(rev4, 'Rev 4 evidence that supersedes the video').toBeTruthy()
  })

  test('answer needs audio + visual: the Mill Creek hot-job invoice (61543 on screen, fee waived aloud)', async () => {
    const hit = await top('trip charge 61543')
    expect(hit.file_path).toMatch(/Screen Recording 2026-10-19/)
    const { said, shown } = await parts(hit.evidence_id)
    expect(shown).toMatch(/61543/)
    expect(said).toMatch(/trip charge/i)
  })
})
