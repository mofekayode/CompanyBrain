'use client'

import type { ExtractionStatus } from '@companybrain/core/workbench/extraction-status'
import { Activity, ChevronDown, CircleAlert, CircleCheck, FileText, FlaskConical, Loader2, Play, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { API } from '@/lib/api'

const KIND_LABEL: Record<string, string> = {
  pdf: 'PDFs',
  document: 'Documents',
  presentation: 'Slides',
  spreadsheet: 'Spreadsheets',
  email: 'Emails',
  mailbox: 'Mailboxes',
  transcript: 'Audio transcripts',
  video: 'Videos',
  image: 'Images',
  text: 'Text files',
  web_page: 'Web pages',
  calendar: 'Calendars',
}

/** Reads what is inside every profiled file (text, tables, OCR, email, transcripts, video) as a background job. */
export function ExtractionCard({ slug, onChange, onStarted }: { slug: string; onChange: () => void; onStarted: () => void }) {
  const [status, setStatus] = useState<ExtractionStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const wasRunning = useRef(false)

  const load = useCallback(async () => {
    const s = (await fetch(`${API}/api/t/${slug}/extraction`).then((r) => r.json())) as ExtractionStatus
    setStatus(s)
    const running = s.pending_jobs > 0
    if (running !== wasRunning.current) onChange() // started or finished: refresh the step bar and suggestions
    wasRunning.current = running
  }, [slug, onChange])

  useEffect(() => {
    load()
  }, [load])

  const running = !!status && status.pending_jobs > 0
  // Fast while running; slower when idle so runs started from the chat show up too.
  useEffect(() => {
    const t = setInterval(load, running ? 2000 : 5000)
    return () => clearInterval(t)
  }, [running, load])

  async function start(mode: 'remaining' | 'sample') {
    setStarting(true)
    try {
      await fetch(`${API}/api/t/${slug}/extraction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })
      onStarted() // show the file-by-file activity
      await load()
    } finally {
      setStarting(false)
    }
  }

  if (!status) return <div className="h-[74px] rounded-lg border border-border bg-background" />

  const { files, remaining, run } = status
  const done = files.total - remaining
  const p = run?.progress
  const pct = running && p && p.total > 0 ? ((p.done + p.failed) / p.total) * 100 : files.total > 0 ? (done / files.total) * 100 : 0

  return (
    <div className="rounded-lg border border-border bg-background p-2.5">
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-signal" />
        ) : files.failed > 0 ? (
          <CircleAlert className="size-3.5 shrink-0 text-warn" />
        ) : remaining === 0 && files.total > 0 ? (
          <CircleCheck className="size-3.5 shrink-0 text-ok" />
        ) : (
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">{running ? 'Extracting content…' : 'Extraction'}</div>
          <div className="truncate text-[10.5px] text-muted-foreground">
            {running && p
              ? `${p.done + p.failed} of ${p.total} jobs${p.failed ? ` · ${p.failed} failed` : ''} · ${status.evidence.toLocaleString()} evidence`
              : `${done}/${files.total} files · ${status.evidence.toLocaleString()} evidence${files.failed ? ` · ${files.failed} failed` : ''}`}
          </div>
        </div>
        {running ? (
          <Button size="xs" variant="ghost" onClick={onStarted}>
            <Activity data-icon="inline-start" />
            Watch
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={starting}
              render={<Button size="xs" variant={remaining > 0 ? 'default' : 'outline'} />}
            >
              {starting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}
              {remaining > 0 ? `Extract ${remaining}` : files.failed > 0 ? `Retry ${files.failed}` : 'Run'}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onClick={() => start('sample')}>
                <FlaskConical className="size-3.5" />
                <div>
                  <div className="text-xs">Try a sample</div>
                  <div className="text-[10.5px] text-muted-foreground">~12 files, one of each kind, read again. A few minutes, cents.</div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => start('remaining')} disabled={remaining === 0 && files.failed === 0}>
                {files.failed > 0 && remaining === 0 ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}
                <div>
                  <div className="text-xs">{remaining > 0 ? `Extract all ${remaining} remaining` : files.failed > 0 ? `Retry ${files.failed} failed` : 'Everything is extracted'}</div>
                  <div className="text-[10.5px] text-muted-foreground">files not yet read; failures are retried</div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onStarted}>
                <Activity className="size-3.5" />
                <div className="text-xs">View activity</div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {(running || (done > 0 && remaining > 0)) && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-signal transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {status.by_kind.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group mt-1.5 flex w-full items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground">
            <ChevronDown className="size-3 transition-transform group-data-[panel-open]:rotate-180" />
            What was read
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 space-y-0.5">
              {status.by_kind.map((k) => (
                <div key={k.kind} className="flex items-center justify-between text-[10.5px]">
                  <span>{KIND_LABEL[k.kind] ?? k.kind}</span>
                  <span className="font-mono text-muted-foreground tabular-nums">
                    {k.documents} · {k.evidence.toLocaleString()} ev
                  </span>
                </div>
              ))}
              {files.skipped > 0 && (
                <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
                  <span>Nothing to read (lock files, binaries)</span>
                  <span className="font-mono tabular-nums">{files.skipped}</span>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
