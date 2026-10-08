// The eval contract's view of evidence: every result or citation as a delivered file path plus a
// locator ("page=3", "sheet=Name;row=42", "t=12.4-15.0", "msg=<id>"), so an external scorer can
// map it back to the files it was given. Facts and records point to the evidence behind them.

import type { FileInfo } from '../access/knowledge-view'
import type { ToolCtx } from '../answer/tools'

export interface Ref {
  source: string
  locator: string
  quote?: string
}

const sec = (ms: unknown) => (Number(ms) / 1000).toFixed(1)

/** A locator from a passage citation or an evidence locator (same fields). */
export function locatorOf(path: string, c: Record<string, unknown>): string {
  if (c.message_id) return `msg=${c.message_id}`
  if (c.start_ms != null) return `t=${sec(c.start_ms)}-${sec(c.end_ms ?? c.start_ms)}`
  if (c.row_start != null) return c.sheet && c.sheet !== 'CSV' ? `sheet=${c.sheet};row=${c.row_start}` : `row=${c.row_start}`
  const page = c.page_start ?? c.page_number
  if (page != null) return /\.pptx?$/i.test(path) ? `slide=${page}` : `page=${page}`
  return ''
}

/** Refs for search documents (passages, facts, records), in the order given; facts expand to their evidence. */
export async function refsFor(ctx: ToolCtx, files: Map<string, FileInfo>, ids: string[], perFact = 3): Promise<Map<string, Ref[]>> {
  const out = new Map<string, Ref[]>()
  if (!ids.length) return out
  const docs = (
    await ctx.sql.query<{ id: string; doc_type: string; source_object_id: string | null; citation: Record<string, unknown>; evidence_ids: string[]; content: string }>(
      `select id, doc_type, source_object_id, citation, evidence_ids, content from public.search_documents where tenant_id = $1 and id = any($2::text[])`,
      [ctx.tenantId, ids],
    )
  ).rows
  const evIds = docs.filter((d) => d.doc_type === 'fact').flatMap((d) => d.evidence_ids.slice(0, 12))
  const ev = evIds.length
    ? (
        await ctx.sql.query<{ id: string; so: string; locator: Record<string, unknown>; page_number: number | null; start_ms: number | null; end_ms: number | null; content: string }>(
          `select e.id, dv.source_object_id so, e.locator, e.page_number, e.start_ms, e.end_ms, left(e.content, 240) content
           from public.evidence e join public.document_versions dv on dv.id = e.document_version_id where e.id = any($1::uuid[])`,
          [evIds],
        )
      ).rows
    : []
  const evById = new Map(ev.map((e) => [e.id, e]))
  const entIds = docs.filter((d) => d.doc_type === 'entity').map((d) => d.id.slice(2))
  const ents = entIds.length
    ? (await ctx.sql.query<{ id: string; file_id: string | null; row: string | null }>(`select id, metadata #>> '{source,file_id}' file_id, metadata #>> '{source,row}' row from public.entities where id = any($1::uuid[])`, [entIds])).rows
    : []
  const entById = new Map(ents.map((e) => [e.id, e]))
  // Under a knowledge view, evidence from files not yet available is never cited.
  const ok = (so: string | null) => !!so && !!files.get(so)?.path && !ctx.view?.hiddenObjects.has(so)

  for (const d of docs) {
    const refs: Ref[] = []
    if (d.doc_type === 'passage' && ok(d.source_object_id)) {
      const path = files.get(d.source_object_id!)!.path!
      refs.push({ source: path, locator: locatorOf(path, d.citation), quote: d.content.slice(0, 240) })
    } else if (d.doc_type === 'fact') {
      const seen = new Set<string>()
      for (const id of d.evidence_ids) {
        const e = evById.get(id)
        if (!e || !ok(e.so)) continue
        const path = files.get(e.so)!.path!
        const locator = locatorOf(path, { ...e.locator, page_number: e.page_number, start_ms: e.start_ms ?? e.locator.start_ms, end_ms: e.end_ms ?? e.locator.end_ms })
        if (seen.has(path + locator)) continue
        seen.add(path + locator)
        refs.push({ source: path, locator, quote: e.content })
        if (refs.length >= perFact) break
      }
    } else if (d.doc_type === 'entity') {
      const e = entById.get(d.id.slice(2))
      if (e?.file_id && ok(e.file_id)) refs.push({ source: files.get(e.file_id)!.path!, locator: e.row ? `row=${e.row}` : '' })
    }
    out.set(d.id, refs)
  }
  return out
}
