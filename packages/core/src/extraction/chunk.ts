import type { EvidenceUnit } from './types'

const TARGET = 1800
const MAX = 3000

/** A block of text with where it came from (one paragraph, list item, heading, …). */
export interface TextBlock {
  text: string
  page?: number | null
  headingPath?: string[]
  isHeading?: boolean
}

/**
 * Packs consecutive blocks into ~TARGET-character evidence chunks without
 * crossing a heading boundary, so each chunk has one section path and a page
 * range. Long single blocks are split on sentence boundaries.
 */
export function chunkBlocks(blocks: TextBlock[], kind: EvidenceUnit['kind'] = 'text'): EvidenceUnit[] {
  const units: EvidenceUnit[] = []
  let buf: TextBlock[] = []

  const flush = () => {
    const text = buf.map((b) => b.text).join('\n\n').trim()
    if (text) {
      const pages = buf.map((b) => b.page).filter((p): p is number => typeof p === 'number')
      const section = buf.find((b) => b.headingPath?.length)?.headingPath ?? null
      units.push({
        kind,
        content: text,
        pageNumber: pages.length ? Math.min(...pages) : null,
        sectionPath: section,
        locator: pages.length ? { page_start: Math.min(...pages), page_end: Math.max(...pages) } : {},
      })
    }
    buf = []
  }

  for (const block of blocks) {
    const text = block.text.trim()
    if (!text) continue
    const size = buf.reduce((n, b) => n + b.text.length, 0)
    const sectionChanged = block.isHeading || (buf.length > 0 && (block.headingPath ?? []).join('>') !== (buf.at(-1)!.headingPath ?? []).join('>'))
    if (buf.length && (sectionChanged || size + text.length > TARGET)) flush()
    if (text.length > MAX) {
      for (const piece of splitLong(text)) {
        buf.push({ ...block, text: piece })
        flush()
      }
      continue
    }
    buf.push({ ...block, text })
  }
  flush()
  return units
}

function splitLong(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (cur && cur.length + s.length > TARGET) {
      out.push(cur)
      cur = ''
    }
    cur = cur ? `${cur} ${s}` : s
    while (cur.length > MAX) {
      out.push(cur.slice(0, MAX))
      cur = cur.slice(MAX)
    }
  }
  if (cur) out.push(cur)
  return out
}

/** Plain text → paragraph blocks, tracking markdown-style headings as section paths. */
export function textToBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = []
  const path: string[] = []
  for (const para of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const t = para.trim()
    if (!t) continue
    const h = t.match(/^(#{1,6})\s+(.+)$/)
    if (h && !t.includes('\n')) {
      path.splice(h[1].length - 1)
      path[h[1].length - 1] = h[2].trim()
      blocks.push({ text: t, headingPath: [...path], isHeading: true })
    } else blocks.push({ text: t, headingPath: [...path] })
  }
  return blocks
}
