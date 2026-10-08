// Stage outputs for component benchmarks (eval contract §4): what speech-to-text, OCR, video
// reading and entity linking produced, keyed by delivered file path, so each stage can be scored
// on its own (word error rate, character error rate, on-screen text, linking accuracy).

import { tenantFiles } from '../access/knowledge-view'
import { linkText, loadDictionary } from '../search/linker'
import type { Sql } from '../storage/raw'
import { locatorOf } from './contract'

const sec = (ms: number | null | undefined) => Math.round((Number(ms ?? 0) / 1000) * 10) / 10

export async function exportComponents(sql: Sql, tenantId: string, slug: string) {
  const files = await tenantFiles(sql, tenantId, slug)
  const pathOf = (so: string) => files.get(so)?.path ?? null
  const ev = (
    await sql.query<{ so: string; kind: string; content: string; speaker: string | null; page_number: number | null; locator: Record<string, unknown>; ordinal: number }>(
      `select dv.source_object_id so, e.kind, e.content, e.speaker, e.page_number, e.locator, e.ordinal
       from public.evidence e join public.document_versions dv on dv.id = e.document_version_id
       where e.tenant_id = $1 and e.kind in ('transcript_segment', 'ocr', 'video_segment') order by dv.source_object_id, e.ordinal`,
      [tenantId],
    )
  ).rows

  const transcripts = new Map<string, { start: number; end: number; speaker: string; text: string }[]>()
  const ocr: { source: string; page: number; text: string }[] = []
  const video: { source: string; start: number; end: number; text: string }[] = []
  for (const e of ev) {
    const source = pathOf(e.so)
    if (!source) continue
    if (e.kind === 'transcript_segment') {
      const text = e.content.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/^[^:\n]{1,40}:\s/, '')
      transcripts.set(source, [...(transcripts.get(source) ?? []), { start: sec(e.locator.start_ms as number), end: sec(e.locator.end_ms as number), speaker: e.speaker ?? 'S1', text }])
    } else if (e.kind === 'ocr') {
      // Heading marks ("## ") come from our converter, not the page.
      ocr.push({ source, page: e.page_number ?? Number(e.locator.page_start ?? 1), text: e.content.replace(/^#{1,6}\s+/gm, '') })
    } else {
      // Video segments carry a description and, when there is any, the text visible on screen.
      const visible = e.content.match(/^Visible text:\s*([\s\S]*?)(?:\n[A-Z][a-z]+:|$)/m)?.[1]?.trim()
      if (visible) video.push({ source, start: sec(e.locator.start_ms as number), end: sec(e.locator.end_ms as number), text: visible })
    }
  }

  // Entity linking: every known name the linker finds in each passage, with where it is.
  const dict = await loadDictionary(sql, tenantId)
  const passages = (
    await sql.query<{ so: string | null; content: string; citation: Record<string, unknown> }>(
      `select source_object_id so, content, citation from public.search_documents where tenant_id = $1 and doc_type = 'passage' and source_object_id is not null`,
      [tenantId],
    )
  ).rows
  const entity_links: { source: string; locator: string; span: string; entity_id: string }[] = []
  for (const p of passages) {
    const source = pathOf(p.so!)
    if (!source) continue
    const locator = locatorOf(source, p.citation)
    for (const l of linkText(dict, p.content)) if (l.type !== 'Term') entity_links.push({ source, locator, span: l.matched, entity_id: l.id })
  }

  return {
    transcripts: [...transcripts].map(([source, segments]) => ({ source, segments })),
    ocr,
    video_text: video,
    entity_links,
  }
}
