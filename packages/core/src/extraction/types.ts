// Shared shapes for extraction: every extractor turns one raw object into a
// document version, processed artifacts and citable evidence units.

export type EvidenceKind = 'text' | 'table' | 'ocr' | 'email_body' | 'transcript_segment' | 'video_segment' | 'image' | 'api_record'

/** One citable piece of a document, with an exact locator back into the original. */
export interface EvidenceUnit {
  kind: EvidenceKind
  content: string
  pageNumber?: number | null
  sectionPath?: string[] | null
  startMs?: number | null
  endMs?: number | null
  speaker?: string | null
  observedAt?: Date | null
  /** Extra location detail: bbox, sheet, row range, frame times, message-id, … */
  locator?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

/** A file written to processed/ (machine-readable) or derived/ (generated media). */
export interface Artifact {
  zone: 'processed' | 'derived'
  name: string // path under {tenant}/{zone}/{kind}/{document_version_id}/
  body: Uint8Array
  contentType: string
}

export interface ExtractionResult {
  extractor: string
  extractorVersion: string
  documentKind: string // file, email, transcript, video, image, spreadsheet, …
  title?: string | null
  pageCount?: number | null
  language?: string | null
  units: EvidenceUnit[]
  artifacts: Artifact[]
  /** Facts about the document itself (headers, duration, sheet names, …). */
  metadata?: Record<string, unknown>
}

export const enc = (s: string) => new TextEncoder().encode(s)
export const json = (name: string, value: unknown, zone: Artifact['zone'] = 'processed'): Artifact => ({
  zone,
  name,
  body: enc(JSON.stringify(value, null, 2)),
  contentType: 'application/json',
})
export const markdown = (name: string, text: string): Artifact => ({ zone: 'processed', name, body: enc(text), contentType: 'text/markdown' })
