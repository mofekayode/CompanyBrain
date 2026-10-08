'use client'

import { CircleAlert, CircleCheck, Loader2, RefreshCw, ScanSearch } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { API } from '@/lib/api'

interface Status {
  objects: number
  profiled_current: number
  profiler_version: number
  last_profiled_at: string | null
  queue: { queued: number; running: number; failed_recently: number }
  worker_idle: boolean
  job: {
    id: string
    status: 'running' | 'succeeded' | 'failed'
    kind: string
    progress: { total: number; done: number; failed: number; pending: number }
    started_at: string
    finished_at: string | null
    last_error: string | null
  } | null
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Shows profiling state for the client and runs profiling as a background job. */
export function ProfilingCard({ slug, onProfiled, onStarted }: { slug: string; onProfiled: () => void; onStarted?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const wasRunning = useRef(false)

  const load = useCallback(async () => {
    const s = (await fetch(`${API}/api/t/${slug}/profiling`).then((r) => r.json())) as Status
    setStatus(s)
    const running = s.job?.status === 'running' || s.queue.queued + s.queue.running > 0
    if (wasRunning.current && !running) onProfiled() // a run just finished: refresh files
    wasRunning.current = running
  }, [slug, onProfiled])

  useEffect(() => {
    load()
  }, [load])

  const running = !!status && (status.job?.status === 'running' || status.queue.queued + status.queue.running > 0)
  // Fast while running; slower when idle so runs started by the agent (from the chat) show up too.
  useEffect(() => {
    const t = setInterval(load, running ? 1000 : 4000)
    return () => clearInterval(t)
  }, [running, load])

  async function start(force: boolean) {
    await fetch(`${API}/api/t/${slug}/profiling`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force }) })
    wasRunning.current = true
    onStarted?.() // show the file-by-file activity
    load()
  }

  if (!status) return <div className="h-[74px] rounded-lg border border-border bg-background" />

  const job = status.job
  const progress = job?.progress
  const outdated = status.objects - status.profiled_current
  const pct = progress && progress.total > 0 ? ((progress.done + progress.failed) / progress.total) * 100 : 0
  const label = job?.status === 'running' && job.kind === 'upload' ? 'Processing upload…' : 'Profiling files…'

  return (
    <div className="rounded-lg border border-border bg-background p-2.5">
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-signal" />
        ) : job?.status === 'failed' ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : outdated === 0 && status.objects > 0 ? (
          <CircleCheck className="size-3.5 shrink-0 text-ok" />
        ) : (
          <ScanSearch className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">{running ? label : 'Profiling'}</div>
          <div className="truncate text-[10.5px] text-muted-foreground">
            {running && progress && job?.status === 'running'
              ? `${progress.done + progress.failed} of ${progress.total} jobs${progress.failed ? ` · ${progress.failed} failed` : ''}`
              : running
                ? `${status.queue.running} running · ${status.queue.queued} queued`
                : `${status.profiled_current}/${status.objects} profiled · ${ago(status.last_profiled_at)}`}
          </div>
        </div>
        {!running && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="xs" variant={outdated > 0 ? 'default' : 'outline'} />}>
              <RefreshCw data-icon="inline-start" />
              {outdated > 0 ? `Profile ${outdated}` : 'Run'}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => start(false)} disabled={outdated === 0}>
                <div>
                  <div className="text-xs">Profile new files</div>
                  <div className="text-[10.5px] text-muted-foreground">{outdated > 0 ? `${outdated} file(s) not yet profiled` : 'everything is up to date'}</div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => start(true)}>
                <div>
                  <div className="text-xs">Re-profile all {status.objects} files</div>
                  <div className="text-[10.5px] text-muted-foreground">reads every raw file from S3 again</div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {running && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-signal transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {status.worker_idle && (
        <p className="mt-1.5 rounded-md bg-warn/15 px-2 py-1 text-[10.5px] text-foreground">
          Work is queued but no worker is running. Start it with <code className="font-mono">npm run worker</code>.
        </p>
      )}
      {!running && job?.status === 'failed' && <p className="mt-1.5 text-[10.5px] text-destructive">{job.last_error}</p>}
    </div>
  )
}
