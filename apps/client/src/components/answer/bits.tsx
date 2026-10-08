'use client'

import { Camera, Database, FileText, Mail, Mic, PlayCircle, Sheet, Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AudioPlayer } from '@/components/media/audio-player'
import { useSession } from '@/components/shell/session'
import { pushRecent } from '@/lib/recents'
import { getJSON, tenantApi } from '@/lib/api'
import type { BriefSource, FactStatus, Step } from '@/lib/types'
import { cap, period } from '@/lib/text'
import { cn } from '@/lib/utils'

export const kindIcon: Record<string, typeof FileText> = {
  document: FileText,
  system: Database,
  fact: Sparkles,
  email: Mail,
  video: PlayCircle,
  interview: Mic,
  spreadsheet: Sheet,
  photo: Camera,
}

const PILL: Record<string, { label: string; className: string }> = {
  current: { label: 'Current', className: 'bg-verified-soft text-verified' },
  outdated: { label: 'Outdated', className: 'bg-stale-soft text-stale' },
  disputed: { label: 'Disputed', className: 'bg-destructive/10 text-destructive' },
  unknown: { label: 'Unconfirmed', className: 'bg-muted text-muted-foreground' },
  check: { label: 'May be outdated', className: 'bg-stale-soft text-stale' },
  supporting: { label: 'Supports', className: 'bg-muted text-muted-foreground' },
  related: { label: 'Related', className: 'border border-dashed border-border text-muted-foreground' },
}

export function StatusPill({ status, className }: { status: FactStatus | BriefSource['status']; className?: string }) {
  const s = PILL[status] ?? PILL.supporting
  return <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium', s.className, className)}>{s.label}</span>
}

export function Timeline({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    <ol className={cn('flex flex-wrap items-center gap-x-2 gap-y-2', className)}>
      {steps.map((s, i) => (
        <li key={`${s.when}-${i}`} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-5 bg-ink/20" aria-hidden />}
          <span
            className={cn(
              'flex max-w-[22rem] items-baseline gap-1.5 rounded-md border px-2 py-1 text-[12px]',
              s.current ? 'border-cobalt/30 bg-cobalt-soft text-navy' : 'border-border bg-white text-muted-foreground line-through decoration-ink/25',
            )}
            title={s.value}
          >
            {s.when && <span className="shrink-0 font-mono text-[10.5px] no-underline opacity-80">{s.when}</span>}
            <span className={cn('truncate', s.current && 'font-medium')}>{s.value}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

interface Detail {
  id: string
  doc_type: string
  kind: string
  title: string
  content: string
  citation: Record<string, unknown>
  file_id: string | null
  path: string | null
  valid_from: string | null
  valid_to: string | null
  is_current: boolean | null
  supporting: { id: string; title: string; kind: string; content: string; citation: Record<string, unknown>; file_id: string | null; path: string | null }[]
}

const KIND_OF: Record<string, string> = { email_body: 'email', transcript_segment: 'interview', video_segment: 'video', image: 'photo', table: 'spreadsheet', text: 'document', ocr: 'document' }
const mmss = (ms: unknown) => `${Math.floor(Number(ms) / 60000)}:${String(Math.floor(Number(ms) / 1000) % 60).padStart(2, '0')}`
const locator = (c: Record<string, unknown>) =>
  c.start_ms != null ? `${mmss(c.start_ms)}–${mmss(c.end_ms ?? c.start_ms)}` : c.page_start ? `page ${c.page_start}${c.page_end && c.page_end !== c.page_start ? `–${c.page_end}` : ''}` : c.row_start ? `rows ${c.row_start}–${c.row_end}` : c.date ? String(c.date).slice(0, 16).replace('T', ' ') : ''

/** Spreadsheet passages ("a | b | c" lines) as a real table. */
function Rows({ text }: { text: string }) {
  const lines = text.split('\n').filter((l) => l.includes(' | '))
  if (lines.length < 2) return <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap">{text}</p>
  const [head, ...rows] = lines.map((l) => l.split(' | '))
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-[12px]">
        <thead className="bg-paper">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b border-border px-2 py-1.5 text-left font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1 whitespace-nowrap">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The cited passage itself, shaped by what it is. */
function Passage({ d, quote }: { d: Detail; quote: string | null }) {
  const body = d.kind === 'table' ? <Rows text={d.content} /> : <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-ink">{d.content}</p>
  return (
    <div className="space-y-2">
      <p className="eyebrow-muted">
        Cited {d.kind === 'table' ? 'rows' : d.kind === 'email_body' ? 'message' : d.kind === 'transcript_segment' ? 'moment' : d.kind === 'video_segment' ? 'scene' : 'passage'}
        {locator(d.citation) && ` · ${locator(d.citation)}`}
      </p>
      {quote && d.kind !== 'table' && <p className="rounded-lg border-l-2 border-cobalt bg-cobalt-soft px-3 py-2 font-serif text-[15px] leading-relaxed text-navy italic">“{quote}”</p>}
      <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-border bg-white p-3">{body}</div>
    </div>
  )
}

/** The original file, opened at the cited place. */
function Original({ fileId, title, page, startMs }: { fileId: string; title: string; page?: string | number | null; startMs?: number | null }) {
  const { slug, me } = useSession()
  const [type, setType] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const url = `${tenantApi(slug)}/app/files/${fileId}/raw?as=${me?.id ?? ''}`
  useEffect(() => {
    setType(null)
    setError(null)
    pushRecent(slug, me?.id, { kind: 'file', label: title, ref: fileId, detail: null })
    fetch(url, { method: 'HEAD' })
      .then((r) => (r.ok ? setType(r.headers.get('content-type')) : setError(r.status === 403 ? 'You don’t have access to this file.' : 'File unavailable.')))
      .catch(() => setError('File unavailable.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])
  const t = startMs != null ? Math.floor(startMs / 1000) : 0
  if (error) return <p className="p-4 text-sm text-muted-foreground">{error}</p>
  if (!type) return <p className="p-4 text-sm text-muted-foreground">Opening the original…</p>
  if (type.startsWith('video')) return <video src={`${url}#t=${t}`} controls autoPlay className="max-h-[60vh] w-full rounded-lg bg-black object-contain" />
  if (type.startsWith('audio'))
    return <AudioPlayer src={url} title={title} transcriptUrl={`${tenantApi(slug)}/app/files/${fileId}/transcript?as=${me?.id ?? ''}`} startMs={startMs ?? null} autoPlay />
  // eslint-disable-next-line @next/next/no-img-element
  if (type.startsWith('image')) return <img src={url} alt={title} className="max-h-[70vh] w-full rounded-lg object-contain" />
  if (type.includes('pdf')) return <iframe src={`${url}${page ? `#page=${page}` : ''}`} className="h-[70vh] w-full rounded-lg border border-border bg-white" title={title} />
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-[13px] text-cobalt">
      Open the original {title}
    </a>
  )
}

/**
 * Opens a citation exactly: the cited passage (rows as a table, the message, the moment), then the
 * original at that place (PDF page, audio/video timestamp). A fact shows its statement, period and
 * status, and the passages where it is said, each one click away.
 */
export function SourceViewer({ source, onClose }: { source: BriefSource | null; onClose: () => void }) {
  const { slug, me } = useSession()
  const [stack, setStack] = useState<string[]>([])
  const [detail, setDetail] = useState<Detail | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => setStack(source ? [source.id] : []), [source])
  const current = stack.at(-1)
  useEffect(() => {
    setDetail(null)
    setMissing(false)
    if (!current || !/^[pfe]:/.test(current)) return
    getJSON<Detail>(`${tenantApi(slug)}/app/passages/${encodeURIComponent(current)}?as=${me?.id ?? ''}`)
      .then(setDetail)
      .catch(() => setMissing(true))
  }, [current, slug, me?.id])
  useEffect(() => {
    if (!source) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [source, onClose])
  if (!source) return null

  const top = stack.length === 1
  const fileId = detail?.file_id ?? (top ? source.file_id : null)
  const page = (detail?.citation.page_start as number | undefined) ?? (top ? source.where.match(/p\. (\d+)/)?.[1] : undefined)
  const startMs = detail?.citation.start_ms != null ? Number(detail.citation.start_ms) : top ? source.start_ms : null
  const title = detail ? (detail.path?.split('/').pop() ?? detail.title) : source.title

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" onClick={onClose}>
      <div role="dialog" aria-label={title} className="flex h-full w-full max-w-3xl flex-col bg-paper shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-border bg-white px-5 py-3">
          {!top && (
            <button type="button" onClick={() => setStack((s) => s.slice(0, -1))} className="mt-0.5 rounded-md px-1.5 py-0.5 text-[12px] text-cobalt hover:bg-cobalt-soft">
              ← Back
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium">{title}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{detail ? [detail.path, locator(detail.citation)].filter(Boolean).join(' · ') : source.where}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-muted" aria-label="Close (Esc)">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {missing && <p className="text-sm text-muted-foreground">You don’t have access to this source.</p>}
          {!detail && !missing && /^[pfe]:/.test(current ?? '') && <p className="text-sm text-muted-foreground">Opening…</p>}
          {detail?.doc_type === 'fact' && (
            <>
              <div className="rounded-xl border border-border bg-white p-4">
                <p className="eyebrow-muted">Fact on record</p>
                <p className="mt-1.5 text-[16px] leading-snug font-medium text-ink">{detail.content.split('\n')[0].replace(/ \([A-Z][A-Za-z ]+\) [·—] /, ' · ')}</p>
                {detail.content.split('\n')[1] && !/^(Valid|Status|Timeline)/.test(detail.content.split('\n')[1]) && <p className="mt-1 text-[13.5px] text-ink/75">{detail.content.split('\n')[1]}</p>}
                <p className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
                  {cap(period(detail.valid_from, detail.valid_to)) || 'Dates not on record'}
                  <StatusPill status={detail.is_current ? 'current' : 'outdated'} />
                </p>
              </div>
              <div>
                <p className="eyebrow-muted mb-2">Where it’s said</p>
                {detail.supporting.length ? (
                  <ul className="space-y-1.5">
                    {detail.supporting.map((p) => {
                      const Icon = kindIcon[KIND_OF[p.kind] ?? 'document'] ?? FileText
                      return (
                        <li key={p.id}>
                          <button type="button" onClick={() => setStack((s) => [...s, p.id])} className="w-full rounded-lg border border-border bg-white px-3 py-2 text-left hover:border-cobalt/50">
                            <span className="flex items-center gap-1.5 text-[13px] font-medium">
                              <Icon className="size-3.5 text-muted-foreground" /> {p.path?.split('/').pop() ?? p.title}
                              <span className="font-mono text-[11px] font-normal text-muted-foreground">{locator(p.citation)}</span>
                            </span>
                            <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-muted-foreground">{p.content.replace(/\s+/g, ' ').slice(0, 220)}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="text-[13px] text-muted-foreground">Its sources are in files you can’t open.</p>
                )}
              </div>
            </>
          )}
          {detail && detail.doc_type === 'passage' && <Passage d={detail} quote={top ? source.quote : null} />}
          {!detail && !missing && !/^[pfe]:/.test(current ?? '') && source.quote && <p className="font-serif text-[15px] italic">“{source.quote}”</p>}
          {fileId && (detail?.doc_type !== 'fact') && (
            <div>
              <p className="eyebrow-muted mb-2">Original{page ? ` · page ${page}` : startMs != null ? ` · from ${mmss(startMs)}` : ''}</p>
              <Original key={`${fileId}:${page}:${startMs}`} fileId={fileId} title={title} page={page} startMs={startMs} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function SourceRow({ s, onOpen }: { s: BriefSource; onOpen: (s: BriefSource) => void }) {
  const Icon = kindIcon[s.kind] ?? FileText
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(s)}
        id={`source-${s.n}`}
        className="flex w-full items-start gap-3 rounded-lg border border-border bg-white px-3 py-2.5 text-left transition-colors hover:border-cobalt/50"
      >
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-cobalt-soft font-mono text-[10px] font-semibold text-cobalt">{s.n}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{s.title}</span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
            {s.where}
            {s.quote && s.kind !== 'fact' && <span> · “{s.quote.slice(0, 120)}”</span>}
          </span>
        </span>
        <StatusPill status={s.status} />
      </button>
    </li>
  )
}
