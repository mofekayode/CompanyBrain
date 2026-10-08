// Extractors that need no external service: plain text family and tables.

import JSZip from 'jszip'
import { chooseDelimiter, parseDelimited } from '../profiling/profile'
import { readableTables, readableText } from '../workbench/read-file'
import { chunkBlocks, textToBlocks } from './chunk'
import { type EvidenceUnit, type ExtractionResult, json, markdown } from './types'

export const TEXT_EXTRACTOR = { name: 'text', version: '1' }
export const TABLE_EXTRACTOR = { name: 'table', version: '3' }
export const OFFICE_XML_EXTRACTOR = { name: 'office-xml', version: '1' }

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/**
 * Fallback for .pptx/.docx that Docling cannot convert (e.g. decks with fractional
 * slide sizes): text straight from the Office XML. Slides keep their number as the page.
 */
export async function extractOfficeXml(bytes: Uint8Array, format: string, filename: string, reason: string): Promise<ExtractionResult> {
  const zip = await JSZip.loadAsync(bytes)
  const units: EvidenceUnit[] = []
  let text = ''
  if (format === 'pptx') {
    const slides = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    for (const name of slides) {
      const n = Number(name.match(/\d+/)![0])
      const xml = await zip.file(name)!.async('string')
      const paragraphs = xml
        .split(/<\/a:p>/)
        .map((p) => unxml((p.match(/<a:t>([^<]*)<\/a:t>/g) ?? []).map((t) => t.replace(/<\/?a:t>/g, '')).join('')).trim())
        .filter(Boolean)
      const notesXml = await zip.file(`ppt/notesSlides/notesSlide${n}.xml`)?.async('string')
      const notes = notesXml ? unxml((notesXml.match(/<a:t>([^<]*)<\/a:t>/g) ?? []).map((t) => t.replace(/<\/?a:t>/g, '')).join(' ')).replace(/^\s*\d+\s*$/, '').trim() : ''
      if (!paragraphs.length && !notes) continue
      const content = [`Slide ${n}`, ...paragraphs, notes ? `Speaker notes: ${notes}` : null].filter(Boolean).join('\n')
      text += `${content}\n\n`
      units.push({ kind: 'text', content, pageNumber: n, sectionPath: paragraphs[0] ? [paragraphs[0].slice(0, 120)] : null, locator: { slide: n } })
    }
  } else {
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''
    text = unxml(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, ''))
    units.push(...chunkBlocks(textToBlocks(text)))
  }
  return {
    extractor: OFFICE_XML_EXTRACTOR.name,
    extractorVersion: OFFICE_XML_EXTRACTOR.version,
    documentKind: format === 'pptx' ? 'presentation' : 'document',
    title: filename,
    units,
    artifacts: [markdown('content.md', text)],
    metadata: { fallback_reason: reason.slice(0, 500) },
  }
}

/** text / markdown / html / rtf / ics → cleaned text → section-aware chunks. */
export async function extractText(bytes: Uint8Array, format: string, filename: string): Promise<ExtractionResult> {
  const { text } = await readableText(bytes, format, { maxChars: 50_000_000, offset: 0 })
  const units = chunkBlocks(textToBlocks(text))
  return {
    extractor: TEXT_EXTRACTOR.name,
    extractorVersion: TEXT_EXTRACTOR.version,
    documentKind: format === 'ics' ? 'calendar' : format === 'html' ? 'web_page' : 'text',
    title: filename,
    units,
    artifacts: [markdown('content.md', text)],
  }
}

const ROWS_PER_CHUNK = 40

/**
 * CSV / XLSX → one evidence unit per block of rows, each carrying the header so
 * it is readable on its own. Report title lines, footers and TOTAL rows are
 * kept out of the data (they go into document metadata).
 */
export async function extractTable(bytes: Uint8Array, format: string, filename: string, profile?: { table?: { preamble?: string[]; footer?: string[] } }): Promise<ExtractionResult> {
  type Sheet = { name: string; rows: string[][] }
  let sheets: Sheet[]
  if (format === 'csv') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '')
    const all = parseDelimited(text, chooseDelimiter(text))
    const widths = all.slice(0, 30).map((r) => r.length)
    const widest = Math.max(1, ...widths)
    const headerAt = Math.max(0, widths.findIndex((w) => w > 1 && w >= widest * 0.5))
    let rows = all.slice(headerAt)
    // Drop trailing footer lines (narrower than the header), same rule as the profiler.
    while (rows.length > 1 && (rows.at(-1)!.length <= rows[0].length / 2 || rows.at(-1)!.filter((c) => c.trim()).length <= 1)) rows = rows.slice(0, -1)
    sheets = [{ name: 'CSV', rows }]
  } else {
    sheets = ((await readableTables(bytes, format, Number.MAX_SAFE_INTEGER)) ?? []).map((t) => ({ name: t.name, rows: t.rows }))
  }

  const units: EvidenceUnit[] = []
  const tablesJson: { sheet: string; columns: string[]; rows: number; title_rows?: string[] }[] = []
  for (const sheet of sheets) {
    const nonEmpty = sheet.rows.filter((r) => r.some((c) => c?.trim()))
    if (nonEmpty.length === 0) continue
    // Report sheets (QuickBooks AR aging, P&L) start with title rows: the header is the first row
    // with at least half as many filled cells as the widest row.
    const filled = nonEmpty.slice(0, 30).map((r) => r.filter((c) => c?.trim()).length)
    const widest = Math.max(1, ...filled)
    const headerAt = Math.max(0, filled.findIndex((n) => n > 1 && n >= widest * 0.5))
    const titleRows = nonEmpty.slice(0, headerAt).map((r) => r.filter((c) => c?.trim()).join(' '))
    const [header, ...data] = nonEmpty.slice(headerAt)
    tablesJson.push({ sheet: sheet.name, columns: header, rows: data.length, ...(titleRows.length ? { title_rows: titleRows } : {}) })
    const summary = (r: string[]) => /^\s*(grand\s+)?total\b/i.test(r[0] ?? '')
    for (let i = 0; i < data.length; i += ROWS_PER_CHUNK) {
      const slice = data.slice(i, i + ROWS_PER_CHUNK)
      const lines = [header.join(' | '), ...slice.map((r) => r.join(' | '))]
      units.push({
        kind: 'table',
        content: `${[sheets.length > 1 ? `Sheet: ${sheet.name}` : null, titleRows.length ? titleRows.join(' · ') : null].filter(Boolean).join('\n')}${sheets.length > 1 || titleRows.length ? '\n' : ''}${lines.join('\n')}`,
        sectionPath: sheets.length > 1 ? [sheet.name] : null,
        locator: { sheet: sheet.name, row_start: i + 1, row_end: i + slice.length },
        metadata: slice.some(summary) ? { contains_summary_row: true } : undefined,
      })
    }
  }
  return {
    extractor: TABLE_EXTRACTOR.name,
    extractorVersion: TABLE_EXTRACTOR.version,
    documentKind: 'spreadsheet',
    title: filename,
    units,
    artifacts: [json('tables.json', tablesJson)],
    metadata: { sheets: tablesJson, preamble: profile?.table?.preamble ?? null, footer: profile?.table?.footer ?? null },
  }
}
