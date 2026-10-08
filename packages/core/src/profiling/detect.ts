// Format detection from content, not from the filename. Messy corpora have
// wrong and missing extensions; the bytes are the evidence.

export type DetectedFormat =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'zip'
  | 'ole2' // legacy Office (.doc/.xls) and Windows Thumbs.db
  | 'sqlite'
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'heic'
  | 'mp4' // ISO base media: .mp4 / .m4a / .mov
  | 'quicktime'
  | 'mp3'
  | 'wav'
  | 'rtf'
  | 'html'
  | 'mbox'
  | 'eml'
  | 'ics'
  | 'json'
  | 'csv'
  | 'markdown'
  | 'text'
  | 'office_lock'
  | 'empty'
  | 'unknown'

const EXPECTED_EXTENSIONS: Partial<Record<DetectedFormat, string[]>> = {
  pdf: ['pdf'],
  docx: ['docx', 'docm'],
  xlsx: ['xlsx', 'xlsm'],
  pptx: ['pptx', 'pptm'],
  zip: ['zip'],
  ole2: ['doc', 'xls', 'ppt', 'msg', 'db'],
  sqlite: ['db', 'sqlite', 'sqlite3'],
  jpeg: ['jpg', 'jpeg'],
  png: ['png'],
  gif: ['gif'],
  heic: ['heic', 'heif'],
  mp4: ['mp4', 'm4a', 'm4v', 'mov'],
  quicktime: ['mov'],
  mp3: ['mp3'],
  wav: ['wav'],
  rtf: ['rtf'],
  html: ['htm', 'html'],
  mbox: ['mbox'],
  eml: ['eml'],
  ics: ['ics'],
  json: ['json'],
  csv: ['csv', 'tsv'],
  markdown: ['md', 'markdown'],
  text: ['txt', 'log', 'md', 'csv'],
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v)
const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end))

function looksLikeText(sample: Uint8Array): boolean {
  if (sample.length === 0) return false
  let control = 0
  for (const c of sample) {
    if (c === 0) return false
    if (c < 9 || (c > 13 && c < 32)) control++
  }
  return control / sample.length < 0.02
}

function zipMemberNames(bytes: Uint8Array): string {
  // Central-directory-free sniff: OOXML packages name their main part early in the archive.
  return ascii(bytes, 0, Math.min(bytes.length, 4096))
}

export function detectFormat(bytes: Uint8Array, filename: string): DetectedFormat {
  if (bytes.length === 0) return 'empty'
  if (isOfficeLockFile(bytes, filename)) return 'office_lock'
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf'
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    const head = zipMemberNames(bytes)
    if (head.includes('word/')) return 'docx'
    if (head.includes('xl/')) return 'xlsx'
    if (head.includes('ppt/')) return 'pptx'
    return 'zip'
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole2'
  if (ascii(bytes, 0, 15) === 'SQLite format 3') return 'sqlite'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'png'
  if (ascii(bytes, 0, 4) === 'GIF8') return 'gif'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'heic'
    if (brand === 'qt  ') return 'quicktime'
    return 'mp4'
  }
  if (ascii(bytes, 0, 3) === 'ID3' || startsWith(bytes, [0xff, 0xfb])) return 'mp3'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'wav'
  if (ascii(bytes, 0, 5) === '{\\rtf') return 'rtf'

  const sample = bytes.subarray(0, 8192)
  if (!looksLikeText(sample)) return 'unknown'
  const text = new TextDecoder('utf-8', { fatal: false }).decode(sample).replace(/^﻿/, '')
  const trimmed = text.trimStart()
  const lower = trimmed.slice(0, 512).toLowerCase()
  const ext = extensionOf(filename)

  if (/^from \S+/i.test(trimmed) && /\n(date|from|subject):/i.test(text)) return 'mbox'
  if (lower.startsWith('begin:vcalendar')) return 'ics'
  if (lower.startsWith('<!doctype html') || lower.startsWith('<html') || /<html[\s>]/.test(lower)) return 'html'
  if (/^(received|return-path|message-id|mime-version|from|date|subject|to):/im.test(trimmed.slice(0, 400)) && /\n\r?\n/.test(text)) {
    if (ext !== 'txt' && ext !== 'md') return 'eml'
  }
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && ext === 'json') return 'json'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (looksDelimited(text, ext === 'csv' || ext === 'tsv')) return 'csv'
  return 'text'
}

/** Delimiters outside double quotes. */
export function countUnquoted(line: string, delimiter: string): number {
  let n = 0
  let quoted = false
  for (const c of line) {
    if (c === '"') quoted = !quoted
    else if (c === delimiter && !quoted) n++
  }
  return n
}

function looksDelimited(text: string, namedAsTable: boolean): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 20)
  if (lines.length < (namedAsTable ? 1 : 2)) return false
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => countUnquoted(l, d))
    // A file named .csv only needs some delimited rows: report exports put title lines above the
    // header, and ragged rows are an integrity finding, not a different format.
    if (namedAsTable && counts.some((c) => c >= 1)) return true
    if (counts[0] < 1) continue
    if (counts.filter((c) => c === counts[0]).length >= Math.ceil(lines.length * 0.8)) return true
  }
  return false
}

/**
 * Office owner/lock file ("~$name.docx"): left behind when a document was open
 * as it was copied. Layout: 1 byte name length, then the user's name.
 */
export function isOfficeLockFile(bytes: Uint8Array, filename: string): boolean {
  return /^~\$/.test(filename.split('/').pop() ?? '') && bytes.length >= 2 && bytes.length <= 512 && bytes[0] > 0 && bytes[0] < 60
}

export function officeLockOwner(bytes: Uint8Array): string | null {
  const name = String.fromCharCode(...bytes.subarray(1, 1 + bytes[0])).trim()
  return /^[\x20-\x7e]+$/.test(name) ? name : null
}

export function extensionOf(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

export function extensionMatches(format: DetectedFormat, filename: string): boolean {
  const ext = extensionOf(filename)
  if (format === 'unknown' || format === 'empty' || format === 'office_lock') return true
  return (EXPECTED_EXTENSIONS[format] ?? []).includes(ext)
}

export const MIME_BY_FORMAT: Partial<Record<DetectedFormat, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  ole2: 'application/x-ole-storage',
  sqlite: 'application/vnd.sqlite3',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  heic: 'image/heic',
  mp4: 'video/mp4',
  quicktime: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  rtf: 'application/rtf',
  html: 'text/html',
  mbox: 'application/mbox',
  eml: 'message/rfc822',
  ics: 'text/calendar',
  json: 'application/json',
  csv: 'text/csv',
  markdown: 'text/markdown',
  text: 'text/plain',
}
