'use client'

import type { ActivityJob, ActivityRun } from '@companybrain/core/workbench/activity'
import { Check, ChevronDown, Clock, Hourglass, Loader2, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { API } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Activity {
  run: ActivityRun | null
  jobs: ActivityJob[]
  queued_more: number
}

const KIND_LABEL: Record<string, string> = { extract: 'Extraction', profile: 'Profiling', upload: 'Upload', access: 'People & access', model: 'Company model' }
const runLabel = (r: ActivityRun) => `${KIND_LABEL[r.kind] ?? r.kind}${r.label ? ` · ${r.label}` : ''}`

const clock = (s: number | null) => {
  if (s == null) return ''
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const name = (p: string | null) => (p ? p.slice(p.lastIndexOf('/') + 1) : null)
const dir = (p: string | null) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/**
 * File-by-file view of a background run: what the worker is doing now, what each
 * file produced and how long it took, and the exact error when something fails.
 */
export function ActivityPanel({ slug, onOpenFile, refreshKey }: { slug: string; onOpenFile: (id: string, list?: string[]) => void; refreshKey: number }) {
  const [runs, setRuns] = useState<ActivityRun[]>([])
  const [runId, setRunId] = useState<string | null>(null) // null = follow the latest run
  const [data, setData] = useState<Activity | null>(null)
  const [onlyFailures, setOnlyFailures] = useState(false)
  const fetchedAt = useRef(Date.now())
  const [, tick] = useState(0)

  const load = useCallback(async () => {
    const [r, a] = await Promise.all([
      fetch(`${API}/api/t/${slug}/runs`).then((x) => x.json() as Promise<ActivityRun[]>),
      fetch(`${API}/api/t/${slug}/activity${runId ? `?run=${runId}` : ''}`).then((x) => x.json() as Promise<Activity>),
    ])
    fetchedAt.current = Date.now()
    setRuns(r)
    setData(a)
  }, [slug, runId])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const live = data?.run?.status === 'running'
  useEffect(() => {
    const t = setInterval(load, live ? 1500 : 6000)
    return () => clearInterval(t)
  }, [live, load])
  // Running timers count up between polls.
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live])

  if (!data) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>
  const run = data.run
  if (!run) return <div className="p-4 text-xs text-muted-foreground">Nothing has run for this client yet. Start profiling or extraction to see each file here.</div>

  const drift = live ? (Date.now() - fetchedAt.current) / 1000 : 0
  const active = data.jobs.filter((j) => j.status === 'running' || j.status === 'waiting' || j.status === 'retrying')
  const finished = data.jobs.filter((j) => j.status === 'succeeded' || j.status === 'failed').filter((j) => !onlyFailures || j.status === 'failed')
  const queued = data.jobs.filter((j) => j.status === 'queued')
  const fileList = data.jobs.map((j) => j.file_id).filter((x): x is string => !!x)
  const pct = run.total ? ((run.done + run.failed) / run.total) * 100 : 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md text-left hover:bg-muted/60">
            <span className={cn('size-2 shrink-0 rounded-full', live ? 'animate-pulse bg-signal' : run.failed ? 'bg-warn' : 'bg-ok')} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{runLabel(run)}</span>
            <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{clock(run.seconds + drift)}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            <DropdownMenuItem onClick={() => setRunId(null)}>
              <span className="text-xs">Follow the latest run</span>
            </DropdownMenuItem>
            {runs.map((r) => (
              <DropdownMenuItem key={r.id} onClick={() => setRunId(r.id)} className="flex flex-col items-start gap-0">
                <span className="w-full truncate text-xs">{runLabel(r)}</span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(r.started_at).toLocaleString()} · {r.done}/{r.total} done{r.failed ? ` · ${r.failed} failed` : ''} · {clock(r.seconds)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full transition-all', run.failed ? 'bg-warn' : 'bg-signal')} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground tabular-nums">
          <span>
            <b className="text-foreground">{run.done}</b>/{run.total} done
          </span>
          {run.running > 0 && <span className="text-signal">{run.running} running</span>}
          {run.queued > 0 && <span>{run.queued} queued</span>}
          {run.failed > 0 && (
            <button onClick={() => setOnlyFailures((v) => !v)} className={cn('text-destructive underline-offset-2 hover:underline', onlyFailures && 'underline')}>
              {run.failed} failed{onlyFailures ? ' (showing only failures)' : ''}
            </button>
          )}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {active.length > 0 && (
            <Section title="Now">
              {active.map((j) => (
                <Row key={j.id} job={j} drift={drift} onOpen={() => j.file_id && onOpenFile(j.file_id, fileList)} />
              ))}
            </Section>
          )}
          {finished.length > 0 && (
            <Section title={onlyFailures ? 'Failed' : 'Finished'}>
              {finished.map((j) => (
                <Row key={j.id} job={j} drift={0} onOpen={() => j.file_id && onOpenFile(j.file_id, fileList)} />
              ))}
            </Section>
          )}
          {!onlyFailures && queued.length > 0 && (
            <Section title={`Up next · ${run.queued}`}>
              {queued.slice(0, 8).map((j) => (
                <Row key={j.id} job={j} drift={0} onOpen={() => j.file_id && onOpenFile(j.file_id, fileList)} />
              ))}
              {run.queued > 8 && <div className="px-2 py-1 text-[10.5px] text-muted-foreground">…and {run.queued - 8} more</div>}
            </Section>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function Row({ job, drift, onOpen }: { job: ActivityJob; drift: number; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  const icon = {
    running: <Loader2 className="size-3.5 animate-spin text-signal" />,
    waiting: <Hourglass className="size-3.5 text-muted-foreground" />,
    retrying: <RotateCcw className="size-3.5 text-warn" />,
    queued: <Clock className="size-3.5 text-muted-foreground/60" />,
    succeeded: <Check className="size-3.5 text-ok" />,
    failed: <X className="size-3.5 text-destructive" />,
  }[job.status]
  const seconds = job.seconds == null ? null : job.seconds + (job.status === 'running' ? drift : 0)
  const label = name(job.file_path) ?? (job.job_type === 'index_email' ? 'All email' : job.job_type)
  const detail =
    job.status === 'waiting'
      ? `waiting: ${job.error}`
      : job.status === 'retrying'
        ? `retrying (attempt ${job.attempts + 1}/${job.max_attempts}): ${job.error}`
        : job.status === 'failed'
          ? job.error
          : job.outcome

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => (job.status === 'failed' ? setOpen((v) => !v) : onOpen())}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className={cn('group flex cursor-pointer gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60', job.status === 'running' && 'bg-signal/5')}
    >
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-xs', job.status === 'queued' ? 'text-muted-foreground' : 'font-medium')} title={job.file_path ?? undefined}>
            {label}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">{job.status === 'queued' ? '' : clock(seconds)}</span>
        </div>
        <div className="truncate text-[10.5px] text-muted-foreground">
          {job.step}
          {dir(job.file_path) && <span className="text-muted-foreground/60"> · {dir(job.file_path)}</span>}
        </div>
        {detail && (
          <div className={cn('mt-0.5 text-[10.5px]', job.status === 'failed' ? 'text-destructive' : job.status === 'retrying' ? 'text-warn' : 'text-foreground/80', !open && 'line-clamp-2')}>
            {detail}
          </div>
        )}
        {job.status === 'failed' && (
          <button onClick={(e) => (e.stopPropagation(), onOpen())} className="mt-0.5 text-[10.5px] text-muted-foreground underline-offset-2 hover:underline">
            Open file
          </button>
        )}
      </div>
    </div>
  )
}
