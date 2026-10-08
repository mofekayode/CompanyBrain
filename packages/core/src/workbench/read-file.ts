import JSZip from 'jszip'
import { chooseDelimiter, parseDelimited } from '../profiling/profile'

/**
 * Turns raw bytes into a bounded text preview an agent can read. This is a
 * discovery-time peek, not extraction: full document extraction (Docling, OCR,
 * transcripts) is Phase 6+.
 */
export async function readableText(bytes: Uint8Array, format: string, opts: { maxChars: number; offset: number }): Promise<{ text: string; note?: string }> {
  const decode = () => new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  let text: string
  let note: string | undefined

  switch (format) {
    case 'csv': {
      const delimiter = decode().split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ','
      const records = parseDelimited(decode(), delimiter, 400)
      text = records.map((r) => r.join(' | ')).join('\n')
      note = `first ${records.length} records (pipe-separated)`
      break
    }
    case 'text':
    case 'markdown':
    case 'ics':
      text = decode()
      break
    case 'html':
      text = decode().replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/(p|tr|li|h\d|div)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ')
      break
    case 'rtf':
      text = decode().replace(/\\par[d]?/g, '\n').replace(/\\[a-z]+-?\d* ?/g, '').replace(/[{}]/g, '')
      break
    case 'mbox':
    case 'eml': {
      // Headers + first lines of each message; bodies can be large.
      const messages = decode().split(/^From .*$/m).filter((m) => m.trim())
      text = messages
        .map((m) => {
          const [head, ...body] = m.split(/\r?\n\r?\n/)
          const keep = head.split(/\r?\n/).filter((l) => /^(date|from|to|cc|subject):/i.test(l)).join('\n')
          return `${keep}\n${body.join('\n\n').trim().slice(0, 400)}`
        })
        .join('\n---\n')
      note = `${messages.length} message(s): headers and first 400 chars of each body`
      break
    }
    case 'docx': {
      const zip = await JSZip.loadAsync(bytes)
      const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''
      text = xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      break
    }
    case 'xlsx':
      text = await xlsxText(bytes)
      note = 'cells per sheet, first 200 rows each (cached values; formulas not evaluated)'
      break
    case 'pptx': {
      const zip = await JSZip.loadAsync(bytes)
      const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
      const parts: string[] = []
      for (const s of slides) parts.push(`# ${s.match(/slide\d+/)![0]}\n` + ((await zip.file(s)!.async('string')).match(/<a:t>([^<]*)<\/a:t>/g) ?? []).map((t) => t.replace(/<\/?a:t>/g, '')).join(' '))
      text = parts.join('\n\n')
      break
    }
    default:
      return { text: '', note: `no text preview for format "${format}" yet (PDF, scan and media text extraction is not available yet); use the profile instead` }
  }

  const total = text.length
  const slice = text.slice(opts.offset, opts.offset + opts.maxChars)
  const truncated = opts.offset + opts.maxChars < total
  return { text: slice, note: [note, `chars ${opts.offset}–${opts.offset + slice.length} of ${total}${truncated ? ' (truncated; pass offset to continue)' : ''}`].filter(Boolean).join('; ') }
}

export interface PreviewTable {
  name: string
  rows: string[][]
  totalRows: number
}

/** Tabular preview for CSV and XLSX: the first rows of each sheet as a grid. */
export async function readableTables(bytes: Uint8Array, format: string, maxRows = 300): Promise<PreviewTable[] | null> {
  if (format === 'csv') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '')
    const all = parseDelimited(text, chooseDelimiter(text))
    // Skip report-title lines above the header (same rule as the profiler; shown separately as the preamble).
    const widths = all.slice(0, 30).map((r) => r.length)
    const widest = Math.max(1, ...widths)
    const records = all.slice(Math.max(0, widths.findIndex((w) => w > 1 && w >= widest * 0.5)))
    return [{ name: 'CSV', rows: records.slice(0, maxRows), totalRows: records.length }]
  }
  if (format === 'xlsx') return (await xlsxSheets(bytes)).map((sh) => ({ name: sh.name, rows: sh.rows.slice(0, maxRows), totalRows: sh.rows.length }))
  return null
}

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, _n, dec, hex) => (dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : XML_ENTITIES[m] ?? m))

async function xlsxSheets(bytes: Uint8Array): Promise<{ name: string; rows: string[][] }[]> {
  const zip = await JSZip.loadAsync(bytes)
  const shared = ((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '')
    .split('</si>')
    .map((si) => (si.match(/<t[^>]*>([^<]*)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''))
  const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? ''
  const names = [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unescapeXml(m[1]))
  const sheetFiles = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  const colIndex = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  const sheets: { name: string; rows: string[][] }[] = []
  for (const [i, file] of sheetFiles.entries()) {
    const xml = await zip.file(file)!.async('string')
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
      const cells: string[] = []
      for (const [, attrs, inner = ''] of row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1]
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? inner.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? ''
        const value = /t="s"/.test(attrs) ? (shared[Number(v)] ?? '') : v
        cells[ref ? colIndex(ref) : cells.length] = unescapeXml(value)
      }
      return Array.from(cells, (c) => c ?? '')
    })
    sheets.push({ name: names[i] ?? file, rows })
  }
  return sheets
}

async function xlsxText(bytes: Uint8Array): Promise<string> {
  return (await xlsxSheets(bytes)).map((sh) => `# sheet: ${sh.name}\n${sh.rows.slice(0, 200).map((r) => r.join(' | ')).join('\n')}`).join('\n\n')
}
