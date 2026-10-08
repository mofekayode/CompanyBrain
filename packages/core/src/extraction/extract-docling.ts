// Documents (PDF, DOCX, PPTX, scans) via a local docling-serve instance:
// layout-aware text with headings and pages, tables as grids, OCR for scans.

import { readEnv } from '../env'
import { chunkBlocks, type TextBlock } from './chunk'
import { type EvidenceUnit, type ExtractionResult, json, markdown } from './types'

export const DOCLING_EXTRACTOR = { name: 'docling', version: '1' }

const DOCLING_FORMATS: Record<string, string> = { pdf: 'pdf', docx: 'docx', pptx: 'pptx' }

export function doclingUrl(): string {
  return readEnv(['DOCLING_URL'] as const).DOCLING_URL ?? 'http://127.0.0.1:5051'
}

interface DoclingProv {
  page_no: number
  bbox?: { l: number; t: number; r: number; b: number }
}
interface DoclingText {
  self_ref: string
  label: string // section_header, title, text, list_item, caption, page_header, page_footer, footnote, …
  text: string
  level?: number
  prov?: DoclingProv[]
}
interface DoclingTable {
  self_ref: string
  label: string
  prov?: DoclingProv[]
  data: { num_rows: number; num_cols: number; grid: { text: string }[][] }
}
interface DoclingDocument {
  body: { children: { $ref: string }[] }
  groups: { self_ref: string; children: { $ref: string }[] }[]
  texts: DoclingText[]
  tables: DoclingTable[]
  pages: Record<string, unknown>
}

const SKIP_LABELS = new Set(['page_header', 'page_footer'])

/** Converts with docling-serve. `forceOcr` for image-only PDFs (scans). */
export async function convertWithDocling(bytes: Uint8Array, filename: string, format: string, forceOcr: boolean): Promise<{ md: string; doc: DoclingDocument; status: string; errors: unknown[]; seconds: number }> {
  const form = new FormData()
  form.append('files', new Blob([new Uint8Array(bytes)]), filename)
  form.append('from_formats', DOCLING_FORMATS[format] ?? format)
  form.append('to_formats', 'md')
  form.append('to_formats', 'json')
  form.append('do_ocr', 'true')
  form.append('force_ocr', String(forceOcr))
  form.append('table_mode', 'accurate')
  form.append('image_export_mode', 'placeholder')
  form.append('document_timeout', '600')
  const r = await fetch(`${doclingUrl()}/v1/convert/file`, { method: 'POST', body: form, signal: AbortSignal.timeout(15 * 60_000) })
  if (!r.ok) throw new Error(`docling-serve failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
  const out = (await r.json()) as { status: string; errors: unknown[]; processing_time: number; document: { md_content: string; json_content: DoclingDocument } }
  if (out.status === 'failure') throw new Error(`docling could not convert ${filename}: ${JSON.stringify(out.errors).slice(0, 300)}`)
  return { md: out.document.md_content, doc: out.document.json_content, status: out.status, errors: out.errors, seconds: out.processing_time }
}

/** Walks the document body in reading order, yielding text items and tables. */
function readingOrder(doc: DoclingDocument): (DoclingText | DoclingTable)[] {
  const byRef = new Map<string, DoclingText | DoclingTable | { children: { $ref: string }[] }>()
  for (const t of doc.texts) byRef.set(t.self_ref, t)
  for (const t of doc.tables) byRef.set(t.self_ref, t)
  for (const g of doc.groups) byRef.set(g.self_ref, g)
  const out: (DoclingText | DoclingTable)[] = []
  const seen = new Set<string>()
  const visit = (ref: string) => {
    if (seen.has(ref)) return
    seen.add(ref)
    const node = byRef.get(ref)
    if (!node) return
    if ('label' in node) out.push(node)
    for (const c of ('children' in node && node.children) || []) visit(c.$ref)
  }
  for (const c of doc.body.children) visit(c.$ref)
  return out
}

const isTable = (x: DoclingText | DoclingTable): x is DoclingTable => 'data' in x

function tableMarkdown(t: DoclingTable): string {
  const rows = t.data.grid.map((r) => r.map((c) => (c.text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()))
  if (rows.length === 0) return ''
  const [head, ...rest] = rows
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rest.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

export async function extractWithDocling(bytes: Uint8Array, filename: string, format: string, opts: { likelyScanned: boolean }): Promise<ExtractionResult> {
  const { md, doc, status, errors, seconds } = await convertWithDocling(bytes, filename, format, opts.likelyScanned)

  const units: EvidenceUnit[] = []
  const blocks: TextBlock[] = []
  const headingPath: string[] = []
  let title: string | null = null

  const flushBlocks = () => {
    units.push(...chunkBlocks(blocks.splice(0), opts.likelyScanned ? 'ocr' : 'text'))
  }

  for (const item of readingOrder(doc)) {
    const page = item.prov?.[0]?.page_no ?? null
    if (isTable(item)) {
      flushBlocks()
      const mdTable = tableMarkdown(item)
      if (mdTable) {
        units.push({
          kind: 'table',
          content: `${headingPath.length ? `${headingPath.join(' > ')}\n\n` : ''}${mdTable}`,
          pageNumber: page,
          sectionPath: headingPath.length ? [...headingPath] : null,
          locator: { page, table_ref: item.self_ref, rows: item.data.num_rows, cols: item.data.num_cols, bbox: item.prov?.[0]?.bbox ?? null },
        })
      }
      continue
    }
    if (SKIP_LABELS.has(item.label) || !item.text?.trim()) continue
    if (item.label === 'title' || item.label === 'section_header') {
      const level = Math.max(1, item.label === 'title' ? 1 : (item.level ?? 1))
      headingPath.splice(level - 1)
      headingPath[level - 1] = item.text.trim()
      title ??= item.text.trim()
      blocks.push({ text: `${'#'.repeat(level + 1)} ${item.text.trim()}`, page, headingPath: [...headingPath], isHeading: true })
      continue
    }
    blocks.push({ text: item.label === 'list_item' ? `- ${item.text}` : item.text, page, headingPath: [...headingPath] })
  }
  flushBlocks()

  return {
    extractor: DOCLING_EXTRACTOR.name,
    extractorVersion: DOCLING_EXTRACTOR.version,
    documentKind: format === 'pptx' ? 'presentation' : 'document',
    title: title ?? filename,
    pageCount: Object.keys(doc.pages ?? {}).length || null,
    units,
    artifacts: [markdown('content.md', md), json('docling.json', doc)],
    metadata: { docling_status: status, docling_errors: errors, docling_seconds: seconds, ocr_forced: opts.likelyScanned, tables: doc.tables.length },
  }
}
