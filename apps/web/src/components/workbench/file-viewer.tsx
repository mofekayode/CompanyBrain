'use client'

import { ChevronLeft, ChevronRight, Copy, Download, Loader2, Play, RefreshCw, TriangleAlert } from 'lucide-react'
import { AudioPlayer } from '../media/audio-player'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatBytes, formatIcon } from './types'
import { API } from '@/lib/api'

interface PreviewTable {
  name: string
  rows: string[][]
  totalRows: number
}

interface FileDetail {
  id: string
  source_name: string
  original_path: string
  original_filename: string
  format: string
  category: string
  mime_type: string | null
  size_bytes: number
  sha256: string
  duplicate_copies: number
  integrity_ok: boolean
  integrity_issues: string[]
  profile: Record<string, unknown> & {
    dates?: { earliest: string | null; latest: string | null; basis: string[] }
    people?: string[]
    notes?: string[]
    document?: Record<string, unknown>
    media?: Record<string, unknown>
    email?: Record<string, unknown>
    table?: { columns: string[]; rows: number; preamble?: string[] }
  }
  preview: { text: string; note?: string }
  tables: PreviewTable[] | null
}

interface Extraction {
  versions: {
    id: string
    extractor: string
    extractor_version: string
    status: string
    page_count: number | null
    created_at: string
    current: boolean
    document_kind: string
    same_content_as: string | null
    reason: string | null
    fallback_reason: string | null
    twelvelabs: { model: string; segments: number; dimensions: number } | null
    evidence: number
  }[]
  evidence: { evidence_id: string; kind: string; content: string; citation: string; start_ms: number | null; end_ms: number | null; speaker: string | null }[]
  children: number
}

const KIND_LABEL: Record<string, string> = {
  text: 'Text',
  table: 'Table',
  ocr: 'OCR',
  email_body: 'Email',
  transcript_segment: 'Transcript',
  video_segment: 'Video scene',
  image: 'Photo reading',
}
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

export function FileViewer({
  slug,
  fileId,
  list,
  onNavigate,
  onClose,
  onReextract,
  seekMs,
}: {
  slug: string
  /** Open media at this moment (e.g. the cited timestamp of a search result). */
  seekMs?: number | null
  fileId: string | null
  list: string[]
  onNavigate: (id: string) => void
  onClose: () => void
  /** Called after a re-extraction is queued (e.g. to show the activity panel). */
  onReextract?: () => void
}) {
  const [file, setFile] = useState<FileDetail | null>(null)
  const [extraction, setExtraction] = useState<Extraction | null>(null)
  const [view, setView] = useState<'original' | 'extracted'>('original')
  const [seek, setSeek] = useState<number | null>(null)

  useEffect(() => {
    if (!fileId) return
    let cancelled = false
    setFile(null)
    setExtraction(null)
    setSeek(seekMs != null ? seekMs / 1000 : null)
    fetch(`${API}/api/t/${slug}/files/${fileId}`)
      .then((r) => r.json())
      .then((f) => !cancelled && setFile(f))
    fetch(`${API}/api/t/${slug}/files/${fileId}/extraction`)
      .then((r) => r.json())
      .then((x) => !cancelled && setExtraction(x))
    return () => {
      cancelled = true
    }
  }, [slug, fileId])

  async function reextract() {
    if (!fileId) return
    await fetch(`${API}/api/t/${slug}/extraction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'files', fileIds: [fileId] }) })
    onReextract?.()
  }

  const index = fileId ? list.indexOf(fileId) : -1
  const prev = index > 0 ? list[index - 1] : null
  const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null

  // ← / → step through the list (ignored while typing in a field).
  useEffect(() => {
    if (!fileId) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) return
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev)
      if (e.key === 'ArrowRight' && next) onNavigate(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fileId, prev, next, onNavigate])

  const raw = fileId ? `${API}/api/t/${slug}/files/${fileId}/raw` : ''
  const Icon = file ? formatIcon(file.format, file.category) : null
  const dir = file?.original_path.includes('/') ? file.original_path.slice(0, file.original_path.lastIndexOf('/')) : ''

  return (
    <Dialog open={!!fileId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[90vh] w-[94vw] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[94vw]">
        {/* Header */}
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-3.5 pr-12">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">{Icon && <Icon className="size-4.5 text-muted-foreground" />}</div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base font-semibold">{file?.original_filename ?? 'Loading…'}</DialogTitle>
            <DialogDescription className="mt-0.5 flex min-w-0 items-center gap-1 truncate font-mono text-[11px]">
              {file && (
                <>
                  <span className="shrink-0">{file.source_name}</span>
                  {dir && (
                    <>
                      <ChevronRight className="size-3 shrink-0" />
                      <span className="truncate">{dir}</span>
                    </>
                  )}
                </>
              )}
            </DialogDescription>
          </div>
          {list.length > 1 && (
            <div className="flex shrink-0 items-center gap-1">
              <Button size="icon-sm" variant="outline" disabled={!prev} onClick={() => prev && onNavigate(prev)} aria-label="Previous file">
                <ChevronLeft />
              </Button>
              <span className="min-w-14 text-center font-mono text-[11px] text-muted-foreground tabular-nums">
                {index + 1} / {list.length}
              </span>
              <Button size="icon-sm" variant="outline" disabled={!next} onClick={() => next && onNavigate(next)} aria-label="Next file">
                <ChevronRight />
              </Button>
            </div>
          )}
          {file && (
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="outline" className="font-mono">
                {file.format}
              </Badge>
              <Badge variant="outline" className="font-mono">
                {formatBytes(Number(file.size_bytes))}
              </Badge>
              {file.duplicate_copies > 1 && (
                <Badge variant="secondary">
                  <Copy className="size-3" /> {file.duplicate_copies} copies
                </Badge>
              )}
              {!file.integrity_ok && (
                <Badge variant="destructive">
                  <TriangleAlert className="size-3" /> issues
                </Badge>
              )}
              <Button size="sm" variant="outline" nativeButton={false} render={<a href={`${raw}?download`} />}>
                <Download data-icon="inline-start" />
                Original
              </Button>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_21rem]">
          <div className="flex min-h-0 min-w-0 flex-col bg-muted/30">
            <div className="flex shrink-0 items-center gap-1 border-b border-border bg-background px-3 py-1.5">
              {(
                [
                  ['original', 'Original'],
                  ['extracted', `Extracted${extraction ? ` · ${extraction.evidence.length} passage${extraction.evidence.length === 1 ? '' : 's'}` : ''}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setView(key)}
                  className={cn('rounded-md px-2.5 py-1 text-xs font-medium', view === key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {view === 'extracted' ? (
                <ExtractedView
                  extraction={extraction}
                  onReextract={reextract}
                  onPlay={(ms) => {
                    setSeek(ms / 1000)
                    setView('original')
                  }}
                />
              ) : file ? (
                <Preview key={seek ?? 'start'} file={file} raw={raw} seek={seek} />
              ) : (
                <Loading />
              )}
            </div>
          </div>
          <aside className="min-h-0 overflow-y-auto border-l border-border p-4">{file ? <Details file={file} /> : <Loading />}</aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Loading() {
  return (
    <div className="space-y-2 p-5">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

function ExtractedView({ extraction, onReextract, onPlay }: { extraction: Extraction | null; onReextract: () => Promise<void>; onPlay: (ms: number) => void }) {
  const [queued, setQueued] = useState<'idle' | 'busy' | 'done'>('idle')
  if (!extraction) return <Loading />
  const v = extraction.versions.find((x) => x.current) ?? extraction.versions[0]
  return (
    <div className="size-full overflow-auto">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background/95 px-5 py-2.5 text-[11px] backdrop-blur">
        {v ? (
          <>
            <Badge variant="outline" className="font-mono">
              {v.extractor} v{v.extractor_version}
            </Badge>
            <span className={cn(v.status === 'succeeded' ? 'text-ok' : v.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{v.status}</span>
            <span className="text-muted-foreground">{new Date(v.created_at).toLocaleString()}</span>
            {v.page_count ? <span className="text-muted-foreground">{v.page_count} pages</span> : null}
            {extraction.versions.length > 1 && <span className="text-muted-foreground">{extraction.versions.length} versions</span>}
            {v.same_content_as && <span className="text-muted-foreground">same bytes as another file: its extraction is reused</span>}
            {v.reason && <span className="text-muted-foreground">{v.reason}</span>}
            {v.fallback_reason && <span className="text-warn">Docling could not read it; read from the Office XML instead</span>}
            {v.twelvelabs && (
              <span className="text-muted-foreground">
                Twelve Labs {v.twelvelabs.model}: {v.twelvelabs.segments} segments × {v.twelvelabs.dimensions}
              </span>
            )}
            {extraction.children > 0 && <span className="text-muted-foreground">{extraction.children} files split out (see the explorer)</span>}
          </>
        ) : (
          <span className="text-muted-foreground">Not extracted yet.</span>
        )}
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={queued !== 'idle'}
          onClick={async () => {
            setQueued('busy')
            await onReextract()
            setQueued('done')
          }}
        >
          {queued === 'busy' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
          {queued === 'done' ? 'Queued: see Activity' : v ? 'Re-extract' : 'Extract'}
        </Button>
      </div>
      <div className="mx-auto max-w-4xl space-y-3 p-5">
        {extraction.evidence.length === 0 && v && <p className="text-xs text-muted-foreground">No passages for this file{v.reason ? ` (${v.reason})` : ''}.</p>}
        {extraction.evidence.map((e) => (
          <div key={e.evidence_id} className="rounded-lg border border-border bg-background">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <Badge variant="secondary" className="text-[10px]">
                {KIND_LABEL[e.kind] ?? e.kind}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground" title={e.citation}>
                {e.citation}
              </span>
              {e.start_ms != null && (
                <Button size="xs" variant="ghost" onClick={() => onPlay(e.start_ms!)}>
                  <Play data-icon="inline-start" />
                  {mmss(e.start_ms)}
                </Button>
              )}
            </div>
            <pre className="max-h-96 overflow-auto px-3 py-2 font-sans text-[12px] leading-relaxed whitespace-pre-wrap">{e.content}</pre>
          </div>
        ))}
        {extraction.evidence.length >= 500 && <p className="text-xs text-muted-foreground">Showing the first 500 passages.</p>}
      </div>
    </div>
  )
}

function Preview({ file, raw, seek }: { file: FileDetail; raw: string; seek?: number | null }) {
  // Media fragment (#t=) starts playback at a passage's timestamp.
  const media = seek != null ? `${raw}#t=${seek}` : raw
  if (file.format === 'pdf') return <iframe src={raw} title={file.original_filename} className="size-full border-0 bg-background" />

  if (file.category === 'image')
    return (
      <div className="flex size-full items-center justify-center overflow-auto bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)] bg-[length:20px_20px] p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={raw} alt={file.original_filename} className="max-h-full max-w-full rounded-md object-contain shadow-lg" />
      </div>
    )

  if (file.category === 'audio')
    return (
      <div className="size-full overflow-y-auto bg-paper p-6">
        <AudioPlayer
          className="mx-auto max-w-3xl"
          src={raw}
          title={file.original_filename}
          subtitle={file.profile.media?.duration_seconds ? `${Math.round(Number(file.profile.media.duration_seconds) / 60)} min recording` : 'Audio recording'}
          transcriptUrl={raw.replace(/\/raw$/, '/transcript')}
          startMs={seek != null ? seek * 1000 : null}
          autoPlay={seek != null}
        />
      </div>
    )

  if (file.category === 'video')
    return (
      <div className="flex size-full items-center justify-center bg-black p-4">
        <video controls autoPlay={seek != null} src={media} className="max-h-full max-w-full" />
      </div>
    )

  if (file.tables) return <Tables tables={file.tables} preamble={file.profile.table?.preamble} />

  if (file.preview.text)
    return (
      <div className="size-full overflow-auto p-6">
        {file.preview.note && <p className="mb-3 text-xs text-muted-foreground">{file.preview.note}</p>}
        <pre className="mx-auto max-w-4xl font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{file.preview.text}</pre>
      </div>
    )

  return (
    <div className="flex size-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
      {file.preview.note ?? 'No preview for this format yet. Download the original or see the profile.'}
    </div>
  )
}

function Tables({ tables, preamble }: { tables: PreviewTable[]; preamble?: string[] }) {
  const [active, setActive] = useState(0)
  const t = tables[active]
  const width = Math.max(1, ...t.rows.map((r) => r.length))
  const [header, ...body] = t.rows
  return (
    <div className="flex size-full min-h-0 flex-col">
      {(tables.length > 1 || preamble) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
          {tables.length > 1 &&
            tables.map((tb, i) => (
              <button
                key={tb.name}
                onClick={() => setActive(i)}
                className={cn('rounded-md px-2.5 py-1 text-xs', i === active ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}
              >
                {tb.name}
              </button>
            ))}
          {preamble && <span className="ml-auto truncate text-[11px] text-muted-foreground">Report header: {preamble.join(' · ')}</span>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse font-mono text-[11.5px]">
          <thead className="sticky top-0 z-10 bg-background shadow-[0_1px_0_var(--border)]">
            <tr>
              <th className="sticky left-0 z-20 bg-background px-2 py-1.5 text-right text-[10px] font-normal text-muted-foreground">#</th>
              {Array.from({ length: width }, (_, c) => (
                <th key={c} className="max-w-80 border-l border-border/60 px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">
                  {header?.[c] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="odd:bg-background/60 hover:bg-signal/5">
                <td className="sticky left-0 bg-muted/80 px-2 py-1 text-right text-[10px] text-muted-foreground tabular-nums">{r + 1}</td>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c} title={row[c]} className="max-w-80 truncate border-l border-border/40 px-2.5 py-1">
                    {row[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        Showing {Math.max(0, t.rows.length - 1).toLocaleString()} of {Math.max(0, t.totalRows - 1).toLocaleString()} rows · {width} columns
      </div>
    </div>
  )
}

function Details({ file }: { file: FileDetail }) {
  const p = file.profile
  const facts: [string, string | undefined][] = [
    ['Content dates', p.dates?.earliest ? `${p.dates.earliest} → ${p.dates.latest}` : 'none found'],
    ['Dated by', p.dates?.basis?.join(', ')],
    ['Author', p.document?.author as string | undefined],
    ['Last edited by', p.document?.last_modified_by as string | undefined],
    ['Application', p.document?.application as string | undefined],
    ['Pages', p.document?.pages ? String(p.document.pages) : undefined],
    ['Messages', p.email?.messages ? String(p.email.messages) : undefined],
    ['Rows', p.table?.rows ? Number(p.table.rows).toLocaleString() : undefined],
    ['Captured', (p.media?.captured_at as string | undefined)?.slice(0, 16).replace('T', ' ')],
    ['Camera', p.media?.camera as string | undefined],
    ['Duplicates', file.duplicate_copies > 1 ? `${file.duplicate_copies} identical copies` : 'unique'],
    ['MIME', file.mime_type ?? undefined],
  ]
  return (
    <div className="space-y-5 text-xs">
      {(!file.integrity_ok || (p.notes?.length ?? 0) > 0) && (
        <section className="space-y-1.5">
          {file.integrity_issues.map((i) => (
            <div key={i} className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-destructive">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {i}
            </div>
          ))}
          {p.notes?.map((n) => (
            <div key={n} className="rounded-md bg-muted px-2 py-1.5 text-muted-foreground">
              {n}
            </div>
          ))}
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Profile</h3>
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5">
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
        </dl>
      </section>

      {(p.people?.length ?? 0) > 0 && (
        <section>
          <h3 className="mb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">People in metadata</h3>
          <div className="flex flex-wrap gap-1">
            {p.people!.slice(0, 20).map((x) => (
              <Badge key={x} variant="secondary" className="font-normal">
                {x}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {p.table?.columns && (
        <section>
          <h3 className="mb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Columns ({p.table.columns.length})</h3>
          <div className="flex flex-wrap gap-1">
            {p.table.columns.map((c, i) => (
              <code key={`${c}-${i}`} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px]">
                {c}
              </code>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Provenance</h3>
        <dl className="space-y-1.5">
          <dt className="text-muted-foreground">Original path</dt>
          <dd className="font-mono text-[10.5px] break-all">{file.original_path}</dd>
          <dt className="text-muted-foreground">SHA-256</dt>
          <dd className="font-mono text-[10.5px] break-all">{file.sha256}</dd>
        </dl>
      </section>

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground">
          <ChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
          Raw profile JSON
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-2 font-mono text-[10px] leading-snug">{JSON.stringify(p, null, 2)}</pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
