// The timed transcript of an audio or video file: one line per utterance (or video scene), with
// speaker and times, for media players (speaker lanes, live captions, jump to a moment).

import type { Sql } from '../storage/raw'

export interface TranscriptLine {
  start_ms: number
  end_ms: number
  speaker: string | null
  text: string
}

export async function transcriptFor(sql: Sql, tenantId: string, fileId: string): Promise<TranscriptLine[]> {
  const rows = (
    await sql.query<{ start_ms: number; end_ms: number | null; speaker: string | null; content: string; kind: string }>(
      `select e.start_ms, e.end_ms, e.speaker, e.content, e.kind
       from public.evidence e join public.document_versions v on v.id = e.document_version_id
       join public.documents d on d.id = v.document_id and d.current_version_id = v.id
       where e.tenant_id = $1 and v.source_object_id = $2 and e.start_ms is not null and e.kind in ('transcript_segment', 'video_segment')
       order by e.start_ms`,
      [tenantId, fileId],
    )
  ).rows
  return rows.map((r) => {
    // Transcript lines read "[00:00:06] Speaker 2: text"; video scenes "Shows: … Speech: Speaker 2: …".
    const speech = r.kind === 'video_segment' ? (r.content.match(/Speech: (.*)$/s)?.[1] ?? r.content.match(/Shows: ([^.]*\.)/)?.[1] ?? '') : r.content
    const text = speech.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').replace(/^Speaker \d+:\s*/, '').replace(/\s+/g, ' ').trim()
    return { start_ms: Number(r.start_ms), end_ms: Number(r.end_ms ?? r.start_ms), speaker: r.speaker ?? speech.match(/^(Speaker \d+):/)?.[1] ?? null, text }
  })
}
