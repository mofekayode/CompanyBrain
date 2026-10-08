// Email: mbox → one raw .eml per message (unpacked like a zip), then each .eml
// → headers, thread key, body without quoted history, attachments as raw children.

import { type AddressObject, simpleParser } from 'mailparser'
import { chunkBlocks, textToBlocks } from './chunk'
import { enc, type ExtractionResult, markdown } from './types'

export const EMAIL_EXTRACTOR = { name: 'email', version: '2' }

/** Splits an mbox into raw message byte arrays (handles mboxrd ">From " escaping). */
export function splitMbox(bytes: Uint8Array): Uint8Array[] {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const parts = text.split(/^From .*\r?\n/m)
  return parts
    .filter((p) => p.trim().length > 0)
    .map((p) => enc(p.replace(/^>(>*From )/gm, '$1')))
}

const addresses = (a: AddressObject | AddressObject[] | undefined): { name: string; address: string }[] =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => ({ name: v.name ?? '', address: (v.address ?? '').toLowerCase() })))

const fmt = (list: { name: string; address: string }[]) => list.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ')

const bracket = (id: string | undefined | null) => (id ? id.trim().replace(/^<|>$/g, '') : null)

const FORWARD_MARKERS = [/^-{2,}\s*Forwarded message\s*-{2,}/i, /^Begin forwarded message:/i]
const REPLY_MARKERS = [/^On .{3,200} wrote:\s*$/, /^-{2,}\s*Original Message\s*-{2,}/i, /^From: .+$/]

export interface SplitBody {
  /** What this message added. */
  fresh: string
  /** True when quoted reply history was removed (it lives in the earlier message). */
  quoted: boolean
  /**
   * Forwarded content, kept as evidence: the original forwarded message is often
   * not in the corpus at all. `header` holds its From/Date/Subject lines if present.
   */
  forwarded: { header: Record<string, string>; text: string } | null
}

/**
 * Splits a body into what this message added, quoted reply history (dropped from
 * evidence; the full body is kept as an artifact) and forwarded content (kept).
 * A "-----Original Message-----" block under a "Fwd:"/"FW:" subject counts as forwarded.
 */
export function stripQuoted(body: string, subject = ''): SplitBody {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const isForwardSubject = /^\s*(fw|fwd)\s*:/i.test(subject)
  let cut = lines.length
  let forward = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    // "From:" only counts as a reply header when followed shortly by Sent:/Date:/To:
    if (/^From: /.test(l) && !lines.slice(i + 1, i + 4).some((x) => /^(Sent|Date|To):/i.test(x.trim()))) continue
    if (FORWARD_MARKERS.some((m) => m.test(l))) {
      cut = i
      forward = true
      break
    }
    if (REPLY_MARKERS.some((m) => m.test(l))) {
      cut = i
      forward = isForwardSubject && !/ wrote:\s*$/.test(l)
      break
    }
  }
  const kept = lines.slice(0, cut).filter((l) => !/^\s*>/.test(l))
  const fresh = kept.join('\n').trim()
  let forwarded: SplitBody['forwarded'] = null
  if (forward) {
    const rest = lines.slice(cut).map((l) => l.replace(/^\s*>\s?/, ''))
    if (FORWARD_MARKERS.some((m) => m.test(rest[0]?.trim() ?? '')) || /^-{2,}/.test(rest[0]?.trim() ?? '')) rest.shift()
    const header: Record<string, string> = {}
    let i = 0
    for (; i < Math.min(rest.length, 12); i++) {
      const m = rest[i].trim().match(/^(From|Date|Sent|To|Cc|Subject):\s*(.*)$/i)
      if (m) header[m[1].toLowerCase() === 'sent' ? 'date' : m[1].toLowerCase()] = m[2]
      else if (rest[i].trim() === '' && Object.keys(header).length > 0) break
      else if (rest[i].trim() !== '' && Object.keys(header).length === 0) break
    }
    const text = rest.slice(Object.keys(header).length ? i : 0).join('\n').trim()
    if (text) forwarded = { header, text }
  }
  return {
    fresh: fresh || (forwarded ? '' : body.trim()),
    quoted: !forward && (cut < lines.length || kept.length < lines.slice(0, cut).length),
    forwarded,
  }
}

export interface ParsedEmail {
  result: ExtractionResult
  attachments: { filename: string; contentType: string; bytes: Uint8Array }[]
}

export async function extractEmail(bytes: Uint8Array, filename: string): Promise<ParsedEmail> {
  const m = await simpleParser(Buffer.from(bytes))
  const from = addresses(m.from)
  const to = addresses(m.to)
  const cc = addresses(m.cc)
  const messageId = bracket(m.messageId)
  const inReplyTo = bracket(typeof m.inReplyTo === 'string' ? m.inReplyTo : undefined)
  const references = (Array.isArray(m.references) ? m.references : m.references ? [m.references] : []).map((r) => bracket(r)!).filter(Boolean)
  // Thread key: the root of the conversation if known, else this message.
  const threadKey = references[0] ?? inReplyTo ?? messageId ?? `${m.subject ?? filename}`.toLowerCase().replace(/^(re|fw|fwd):\s*/gi, '')
  const body = m.text ?? (m.html ? m.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ') : '')
  const { fresh, quoted, forwarded } = stripQuoted(body, m.subject ?? '')
  const date = m.date && !Number.isNaN(m.date.getTime()) ? m.date : null

  const header = [`From: ${fmt(from)}`, `To: ${fmt(to)}`, cc.length ? `Cc: ${fmt(cc)}` : null, date ? `Date: ${date.toISOString()}` : null, `Subject: ${m.subject ?? '(no subject)'}`]
    .filter(Boolean)
    .join('\n')

  // Short emails are one unit; long ones are chunked, each chunk carrying the header line.
  const split = (t: string) => (t.length > 2500 ? chunkBlocks(textToBlocks(t), 'email_body').map((u) => u.content) : [t])
  const fwdChunks = forwarded ? split(forwarded.text) : []
  // A message with no body of its own still gets one unit, so its headers are searchable.
  const chunks = fresh || fwdChunks.length === 0 ? split(fresh) : []
  const fwdHeader = forwarded ? Object.entries(forwarded.header).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v}`).join('\n') : ''
  const attachments = (m.attachments ?? [])
    .filter((a) => a.content?.length)
    .map((a, i) => ({ filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType, bytes: new Uint8Array(a.content) }))

  return {
    attachments,
    result: {
      extractor: EMAIL_EXTRACTOR.name,
      extractorVersion: EMAIL_EXTRACTOR.version,
      documentKind: 'email',
      title: m.subject ?? '(no subject)',
      units: [
        ...chunks.map((c, i) => ({
          kind: 'email_body' as const,
          content: `${header}\n\n${c}`,
          observedAt: date,
          locator: { message_id: messageId, part: chunks.length > 1 ? i + 1 : undefined },
          metadata: { thread_key: threadKey, quoted_removed: quoted },
        })),
        // Forwarded content is its own evidence, attributed to the forward (who passed it on, when).
        ...fwdChunks.map((c, i) => ({
          kind: 'email_body' as const,
          content: `${header}\n\nForwarded content${fwdHeader ? `:\n${fwdHeader}` : ''}\n\n${c}`,
          observedAt: date,
          locator: { message_id: messageId, part: 'forwarded', forwarded_part: fwdChunks.length > 1 ? i + 1 : undefined },
          metadata: { thread_key: threadKey, forwarded: true, forwarded_header: forwarded!.header },
        })),
      ],
      artifacts: [markdown('message.md', `${header}\n\n${body}`)],
      metadata: {
        message_id: messageId,
        in_reply_to: inReplyTo,
        references,
        thread_key: threadKey,
        from,
        to,
        cc,
        date: date?.toISOString() ?? null,
        subject: m.subject ?? null,
        forwarded: forwarded ? forwarded.header : null,
        attachments: attachments.map((a) => ({ filename: a.filename, content_type: a.contentType, size: a.bytes.byteLength })),
      },
    },
  }
}
