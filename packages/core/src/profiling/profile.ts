// Phase 4 profiling: what each raw object *is* (format, integrity, embedded
// metadata, shape), never what it *means*. Output is stored on
// source_objects.metadata.profile and powers the source inventory.

import exifr from 'exifr'
import JSZip from 'jszip'
import { parseBuffer } from 'music-metadata'
import { PDFDocument } from 'pdf-lib'
import { type DetectedFormat, detectFormat, extensionMatches, extensionOf, MIME_BY_FORMAT, officeLockOwner } from './detect'

export const PROFILER_VERSION = 4

export type Structure = 'structured' | 'semi_structured' | 'unstructured' | 'media' | 'container' | 'system' | 'unknown'
export type Category =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'tabular_export'
  | 'email_archive'
  | 'email'
  | 'calendar'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'web_page'
  | 'text'
  | 'database'
  | 'system_file'
  | 'unknown'

export interface Profile {
  profiler_version: number
  format: DetectedFormat
  mime_type: string | null
  extension: string
  extension_matches: boolean
  category: Category
  structure: Structure
  integrity: { ok: boolean; issues: string[] }
  /** Dates found in embedded metadata or content, ISO yyyy-mm-dd. */
  dates: { earliest: string | null; latest: string | null; basis: string[] }
  /** Names or addresses found in metadata (authors, editors, senders). Hints, not identities. */
  people: string[]
  document?: {
    title?: string
    author?: string
    last_modified_by?: string
    created?: string
    modified?: string
    application?: string
    company?: string
    pages?: number
    slides?: number
    sheets?: string[]
    encrypted?: boolean
    likely_scanned?: boolean
  }
  email?: { messages: number; first_date: string | null; last_date: string | null; top_senders: { sender: string; count: number }[]; domains: string[]; with_attachments: number }
  table?: { delimiter: string; columns: string[]; rows: number; date_columns: { column: string; min: string; max: string }[]; preamble?: string[]; footer?: string[]; summary_rows?: number }
  text?: { lines: number; words: number }
  media?: { duration_seconds?: number; has_video?: boolean; codec?: string; captured_at?: string; camera?: string; gps?: { lat: number; lon: number }; width?: number; height?: number }
  archive?: { entries: number; members: { name: string; size: number }[] }
  calendar?: { events: number }
  notes?: string[]
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function isoDay(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  if (y < 1970 || y > 2100) return null
  return d.toISOString().slice(0, 10)
}

/**
 * Tool defaults that look like dates but carry no information: PDF generators in
 * "invariant" mode stamp 2000-01-01T00:00:00, zip/FAT tools 1980-01-01, Windows 1601.
 */
export function isPlaceholderTimestamp(d: Date | null | undefined): boolean {
  if (!d || Number.isNaN(d.getTime())) return false
  const iso = d.toISOString()
  return iso.startsWith('2000-01-01T00:00:00') || iso.startsWith('1980-01-01T00:00:00') || d.getUTCFullYear() < 1970
}

const realDay = (d: Date | null | undefined, p: Profile, what: string) => {
  if (isPlaceholderTimestamp(d)) {
    ;(p.notes ??= []).push(`${what} is a tool placeholder (${d!.toISOString().slice(0, 10)}), ignored`)
    return null
  }
  return isoDay(d)
}

/** Parses one date-looking string (ISO, US m/d/y, "Mar 4, 2021", RFC 2822). */
export function parseLooseDate(value: string): string | null {
  const v = value.trim()
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return isoDay(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])))
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/)
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    return isoDay(new Date(Date.UTC(year, +m[1] - 1, +m[2])))
  }
  m = v.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/)
  if (m && MONTHS.includes(m[1].toLowerCase())) return isoDay(new Date(Date.UTC(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2])))
  if (/\d{4}/.test(v) && /[A-Za-z]{3}/.test(v)) return isoDay(new Date(v))
  return null
}

const CONTENT_DATE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4})\b/g

function datesInText(text: string, limit = 5000): string[] {
  const out: string[] = []
  for (const m of text.matchAll(CONTENT_DATE)) {
    const d = parseLooseDate(m[1])
    if (d) out.push(d)
    if (out.length >= limit) break
  }
  return out
}

class DateRange {
  private values: string[] = []
  readonly basis = new Set<string>()
  add(basis: string, ...dates: (string | null | undefined)[]) {
    for (const d of dates) {
      if (d) {
        this.values.push(d)
        this.basis.add(basis)
      }
    }
  }
  result() {
    const sorted = [...this.values].sort()
    return { earliest: sorted[0] ?? null, latest: sorted.at(-1) ?? null, basis: [...this.basis].sort() }
  }
}

// ---------------------------------------------------------------------------
// Per-format profilers
// ---------------------------------------------------------------------------

const xmlTag = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))
  return m ? m[1].trim() || undefined : undefined
}

async function profileOoxml(bytes: Uint8Array, format: 'docx' | 'xlsx' | 'pptx', p: Profile, dates: DateRange) {
  const zip = await JSZip.loadAsync(bytes)
  const core = (await zip.file('docProps/core.xml')?.async('string')) ?? ''
  const app = (await zip.file('docProps/app.xml')?.async('string')) ?? ''
  const doc: NonNullable<Profile['document']> = {
    title: xmlTag(core, 'dc:title'),
    author: xmlTag(core, 'dc:creator'),
    last_modified_by: xmlTag(core, 'cp:lastModifiedBy'),
    created: xmlTag(core, 'dcterms:created'),
    modified: xmlTag(core, 'dcterms:modified'),
    application: xmlTag(app, 'Application'),
    company: xmlTag(app, 'Company'),
  }
  if (format === 'docx') {
    const pages = xmlTag(app, 'Pages')
    if (pages) doc.pages = Number(pages)
    const body = (await zip.file('word/document.xml')?.async('string')) ?? ''
    const text = body.replace(/<[^>]+>/g, ' ')
    p.text = { lines: (body.match(/<w:p[ >]/g) ?? []).length, words: text.split(/\s+/).filter(Boolean).length }
    dates.add('content', ...datesInText(text))
  }
  if (format === 'xlsx') {
    const wb = (await zip.file('xl/workbook.xml')?.async('string')) ?? ''
    doc.sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => m[1])
  }
  if (format === 'pptx') {
    doc.slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length
  }
  p.document = doc
  dates.add('document_metadata', realDay(doc.created ? new Date(doc.created) : null, p, 'created date'), realDay(doc.modified ? new Date(doc.modified) : null, p, 'modified date'))
  p.people.push(...[doc.author, doc.last_modified_by].filter((x): x is string => !!x))
}

async function profilePdf(bytes: Uint8Array, p: Profile, dates: DateRange) {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)))
  if (!tail.includes('%%EOF')) p.integrity.issues.push('pdf_missing_eof_marker (possibly truncated)')
  const raw = new TextDecoder('latin1').decode(bytes)
  const hasFont = raw.includes('/Font')
  const hasImage = raw.includes('/Image')
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })
  const doc: NonNullable<Profile['document']> = {
    pages: pdf.getPageCount(),
    title: pdf.getTitle() || undefined,
    author: pdf.getAuthor() || undefined,
    application: [pdf.getCreator(), pdf.getProducer()].filter(Boolean).join(' / ') || undefined,
    created: pdf.getCreationDate()?.toISOString(),
    modified: pdf.getModificationDate()?.toISOString(),
    encrypted: pdf.isEncrypted || undefined,
    likely_scanned: !hasFont && hasImage ? true : undefined,
  }
  p.document = doc
  dates.add('document_metadata', realDay(pdf.getCreationDate(), p, 'created date'), realDay(pdf.getModificationDate(), p, 'modified date'))
  if (doc.author) p.people.push(doc.author)
}

interface MailHeaders { date?: string; from?: string; hasAttachment: boolean }

function parseMessages(text: string, isMbox: boolean): MailHeaders[] {
  const chunks = isMbox ? text.split(/^From .*$/m).filter((c) => c.trim()) : [text]
  return chunks.map((chunk) => {
    const header = chunk.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ')
    const field = (name: string) => header.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'))?.[1]?.trim()
    return { date: field('Date'), from: field('From'), hasAttachment: /content-disposition:\s*attachment/i.test(chunk) }
  })
}

function profileMail(bytes: Uint8Array, isMbox: boolean, p: Profile, dates: DateRange) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const messages = parseMessages(text, isMbox)
  const days = messages.map((m) => (m.date ? isoDay(new Date(m.date)) : null)).filter((d): d is string => !!d).sort()
  const senders = new Map<string, number>()
  const domains = new Set<string>()
  for (const m of messages) {
    if (!m.from) continue
    const address = (m.from.match(/<([^>]+)>/)?.[1] ?? m.from).toLowerCase().trim()
    senders.set(address, (senders.get(address) ?? 0) + 1)
    const domain = address.split('@')[1]
    if (domain) domains.add(domain)
  }
  p.email = {
    messages: messages.length,
    first_date: days[0] ?? null,
    last_date: days.at(-1) ?? null,
    top_senders: [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([sender, count]) => ({ sender, count })),
    domains: [...domains].sort(),
    with_attachments: messages.filter((m) => m.hasAttachment).length,
  }
  dates.add('email_dates', days[0], days.at(-1))
  p.people.push(...p.email.top_senders.map((s) => s.sender))
}

/** RFC 4180-style records: quoted fields may contain delimiters, quotes ("") and newlines. */
export function parseDelimited(text: string, delimiter: string, maxRecords = Infinity): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  for (let i = 0; i < text.length && records.length < maxRecords; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === delimiter) {
      record.push(field.trim())
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      record.push(field.trim())
      if (record.some((f) => f !== '')) records.push(record)
      record = []
      field = ''
    } else field += c
  }
  if (field !== '' || record.length > 0) {
    record.push(field.trim())
    if (record.some((f) => f !== '')) records.push(record)
  }
  return records
}

/**
 * The delimiter that splits records into the most consistent column count, not the
 * most frequent character: free text like "Rice; Teller; Stroud" is full of semicolons.
 */
export function chooseDelimiter(text: string): string {
  let best = { delimiter: ',', score: -1 }
  for (const delimiter of [',', '\t', ';', '|']) {
    const widths = parseDelimited(text, delimiter, 50).map((r) => r.length)
    const freq = new Map<number, number>()
    for (const w of widths) if (w > 1) freq.set(w, (freq.get(w) ?? 0) + 1)
    const [width, count] = [...freq.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0] ?? [0, 0]
    const score = count * 1000 + width // consistency first, then width
    if (score > best.score) best = { delimiter, score }
  }
  return best.delimiter
}

function profileTable(bytes: Uint8Array, p: Profile, dates: DateRange) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '')
  if (text.trim() === '') return
  const delimiter = chooseDelimiter(text)
  const records = parseDelimited(text, delimiter)
  // Report exports (QuickBooks etc.) put title lines above the header. Title lines are
  // single fields; the header is the first record with real columns.
  const widths = records.slice(0, 30).map((r) => r.length)
  const widest = Math.max(...widths)
  const headerIndex = Math.max(0, widths.findIndex((w) => w > 1 && w >= widest * 0.5))
  const columns = records[headerIndex]
  let rows = records.slice(headerIndex + 1)
  // Report exports also add footer lines after the data ("Exported Friday, October 9, 2026 … Accrual Basis").
  // Trailing lines much narrower than the header are a footer, not broken rows.
  let footerStart = rows.length
  const FOOTER_WORDS = /^\s*(exported|generated|printed|run on|run date|report (run|date)|created on|page \d+|(accrual|cash) basis)\b/i
  const isFooter = (r: string[]) => r.length <= 1 || r.length <= columns.length / 2 || r.filter((c) => c.trim()).length <= 1 || FOOTER_WORDS.test(r[0] ?? '')
  while (footerStart > 0 && columns.length > 2 && isFooter(rows[footerStart - 1])) footerStart--
  const footer = rows.slice(footerStart).map((r) => r.join(', ')).filter((l) => l.trim())
  rows = rows.slice(0, footerStart)
  // Summary rows (TOTAL / Grand total) are report artefacts: anyone loading the data must skip them.
  const summaryRows = rows.filter((r) => /^\s*(grand\s+)?total\b/i.test(r[0] ?? '')).length
  const raggedRows = rows.filter((r) => r.length !== columns.length).length
  if (raggedRows > 0) p.integrity.issues.push(`${raggedRows} row(s) with a different column count than the header`)
  const dateColumns: { column: string; min: string; max: string }[] = []
  columns.forEach((column, i) => {
    const values = rows.map((r) => r[i]).filter((v) => v)
    const parsed = values.map(parseLooseDate).filter((d): d is string => !!d).sort()
    if (values.length > 0 && parsed.length / values.length >= 0.8) {
      dateColumns.push({ column, min: parsed[0], max: parsed.at(-1)! })
      dates.add('table_date_columns', parsed[0], parsed.at(-1))
    }
  })
  p.table = { delimiter: delimiter === '\t' ? 'tab' : delimiter, columns, rows: rows.length, date_columns: dateColumns }
  if (footer.length > 0) {
    p.table.footer = footer
    dates.add('table_footer', ...datesInText(footer.join('\n')))
  }
  if (summaryRows > 0) {
    p.table.summary_rows = summaryRows
    ;(p.notes ??= []).push(`${summaryRows} summary row(s) (e.g. TOTAL) inside the data: skip them when loading or totals double-count`)
  }
  if (headerIndex > 0) {
    p.table.preamble = records.slice(0, headerIndex).map((r) => r.join(', '))
    dates.add('table_preamble', ...datesInText(p.table.preamble.join('\n')))
  }
}

function profileText(bytes: Uint8Array, p: Profile, dates: DateRange, stripMarkup = false) {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (stripMarkup) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>|\\[a-z]+-?\d* ?|[{}]/g, ' ')
  p.text = { lines: text.split(/\r?\n/).length, words: text.split(/\s+/).filter(Boolean).length }
  dates.add('content', ...datesInText(text))
}

async function profileImage(bytes: Uint8Array, p: Profile, dates: DateRange) {
  const exif = await exifr.parse(bytes, { gps: true, tiff: true, exif: true }).catch(() => null)
  const captured = exif?.DateTimeOriginal ?? exif?.CreateDate
  p.media = {
    captured_at: captured instanceof Date ? captured.toISOString() : undefined,
    camera: [exif?.Make, exif?.Model].filter(Boolean).join(' ') || undefined,
    gps: typeof exif?.latitude === 'number' ? { lat: exif.latitude, lon: exif.longitude } : undefined,
    width: exif?.ExifImageWidth ?? exif?.ImageWidth,
    height: exif?.ExifImageHeight ?? exif?.ImageHeight,
  }
  if (!exif) (p.notes ??= []).push('no EXIF metadata')
  dates.add('exif', isoDay(captured instanceof Date ? captured : null))
}

async function profileAudioVideo(bytes: Uint8Array, mimeType: string, p: Profile, dates: DateRange) {
  const meta = await parseBuffer(bytes, { mimeType }, { duration: true, skipCovers: true })
  const hasVideo = meta.format.trackInfo?.some((t) => t.video) ?? false
  p.media = {
    duration_seconds: meta.format.duration ? Math.round(meta.format.duration * 10) / 10 : undefined,
    has_video: hasVideo,
    codec: meta.format.codec,
    captured_at: meta.format.creationTime?.toISOString(),
  }
  dates.add('media_metadata', realDay(meta.format.creationTime, p, 'media creation time'))
}

async function profileZip(bytes: Uint8Array, p: Profile) {
  const zip = await JSZip.loadAsync(bytes)
  const files = Object.values(zip.files).filter((f) => !f.dir)
  p.archive = {
    entries: files.length,
    // _data.uncompressedSize is set by JSZip for loaded archives
    members: files.slice(0, 100).map((f) => ({ name: f.name, size: (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0 })),
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const CATEGORY: Record<DetectedFormat, [Category, Structure]> = {
  pdf: ['document', 'unstructured'],
  docx: ['document', 'unstructured'],
  rtf: ['document', 'unstructured'],
  xlsx: ['spreadsheet', 'semi_structured'],
  pptx: ['presentation', 'unstructured'],
  csv: ['tabular_export', 'structured'],
  json: ['tabular_export', 'structured'],
  sqlite: ['database', 'structured'],
  mbox: ['email_archive', 'semi_structured'],
  eml: ['email', 'semi_structured'],
  ics: ['calendar', 'structured'],
  jpeg: ['image', 'media'],
  png: ['image', 'media'],
  gif: ['image', 'media'],
  heic: ['image', 'media'],
  mp4: ['video', 'media'],
  quicktime: ['video', 'media'],
  mp3: ['audio', 'media'],
  wav: ['audio', 'media'],
  zip: ['archive', 'container'],
  html: ['web_page', 'unstructured'],
  markdown: ['text', 'unstructured'],
  text: ['text', 'unstructured'],
  ole2: ['document', 'unstructured'],
  office_lock: ['system_file', 'system'],
  empty: ['unknown', 'unknown'],
  unknown: ['unknown', 'unknown'],
}

export async function profileObject(bytes: Uint8Array, filename: string): Promise<Profile> {
  const format = detectFormat(bytes, filename)
  const extension = extensionOf(filename)
  let [category, structure] = CATEGORY[format]
  let mimeType = MIME_BY_FORMAT[format] ?? null
  if (format === 'mp4' && ['m4a', 'mp3', 'aac'].includes(extension)) {
    category = 'audio'
    mimeType = 'audio/mp4'
  }
  if (format === 'ole2' && filename.toLowerCase() === 'thumbs.db') {
    category = 'system_file'
    structure = 'system'
  }

  const p: Profile = {
    profiler_version: PROFILER_VERSION,
    format,
    mime_type: mimeType,
    extension,
    extension_matches: extensionMatches(format, filename),
    category,
    structure,
    integrity: { ok: true, issues: [] },
    dates: { earliest: null, latest: null, basis: [] },
    people: [],
  }
  if (!p.extension_matches) p.integrity.issues.push(`extension .${extension || '(none)'} does not match detected format ${format}`)
  if (format === 'empty') p.integrity.issues.push('empty file')
  if (format === 'unknown') p.integrity.issues.push(`unrecognized content for .${extension || '(none)'} (corrupt, encrypted or unsupported)`)

  const dates = new DateRange()
  try {
    switch (format) {
      case 'docx':
      case 'xlsx':
      case 'pptx':
        await profileOoxml(bytes, format, p, dates)
        break
      case 'pdf':
        await profilePdf(bytes, p, dates)
        break
      case 'mbox':
      case 'eml':
        profileMail(bytes, format === 'mbox', p, dates)
        break
      case 'csv':
        profileTable(bytes, p, dates)
        break
      case 'text':
      case 'markdown':
        profileText(bytes, p, dates)
        break
      case 'html':
      case 'rtf':
        profileText(bytes, p, dates, true)
        break
      case 'ics': {
        const text = new TextDecoder().decode(bytes)
        p.calendar = { events: (text.match(/BEGIN:VEVENT/g) ?? []).length }
        dates.add('calendar', ...[...text.matchAll(/DTSTART[^:]*:(\d{4})(\d{2})(\d{2})/g)].map((m) => isoDay(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])))))
        break
      }
      case 'jpeg':
      case 'png':
      case 'gif':
      case 'heic':
        await profileImage(bytes, p, dates)
        break
      case 'mp4':
      case 'quicktime':
      case 'mp3':
      case 'wav':
        await profileAudioVideo(bytes, mimeType ?? 'video/mp4', p, dates)
        break
      case 'zip':
        await profileZip(bytes, p)
        break
      case 'office_lock': {
        const owner = officeLockOwner(bytes)
        if (owner) p.people.push(owner)
        ;(p.notes ??= []).push(`Office lock file: ${owner ?? 'someone'} had "${filename.replace(/^~\$/, '…')}" open when this copy was made`)
        break
      }
      case 'ole2':
        ;(p.notes ??= []).push(category === 'system_file' ? 'Windows thumbnail cache (Thumbs.db)' : 'legacy OLE2 container (e.g. .doc/.xls)')
        break
    }
  } catch (error) {
    p.integrity.issues.push(`could not be parsed as ${format}: ${(error as Error).message.slice(0, 200)}`)
  }

  p.people = [...new Set(p.people.map((x) => x.trim()).filter(Boolean))]
  p.dates = dates.result()
  p.integrity.ok = p.integrity.issues.length === 0
  return p
}
