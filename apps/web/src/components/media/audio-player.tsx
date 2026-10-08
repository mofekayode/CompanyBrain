'use client'

// An audio player built for interviews: who is speaking along the timeline (one colour per
// speaker), the cited moment highlighted, live captions from the transcript, and a clickable
// transcript. Click or drag the timeline to seek; space plays/pauses, ←/→ skip 5 s.

import { ChevronDown, Pause, Play, RotateCcw, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface Line {
  start_ms: number
  end_ms: number
  speaker: string | null
  text: string
}

const COLORS = ['var(--cobalt)', 'var(--stale)', 'var(--verified)', '#8b5cf6', '#db2777', 'var(--navy)']
const BARS = 140
const SPEEDS = [1, 1.25, 1.5, 2, 0.75]

const clock = (s: number) => {
  if (!Number.isFinite(s)) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`
}

/** Stable pseudo-random heights when there is no transcript (decorative only). */
function seeded(seed: string, n: number) {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return Array.from({ length: n }, (_, i) => {
    h = Math.imul(h ^ (h >>> 13), 1274126177) + i
    const r = ((h >>> 0) % 1000) / 1000
    return 0.25 + 0.6 * Math.abs(Math.sin(i / 5 + r * 3)) * (0.6 + 0.4 * r)
  })
}

export function AudioPlayer({
  src,
  title,
  subtitle,
  transcriptUrl,
  startMs,
  endMs,
  autoPlay,
  className,
}: {
  src: string
  title: string
  subtitle?: string
  transcriptUrl?: string
  startMs?: number | null
  endMs?: number | null
  autoPlay?: boolean
  className?: string
}) {
  const audio = useRef<HTMLAudioElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [hover, setHover] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!transcriptUrl) return
    fetch(transcriptUrl)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Line[]) => setLines(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [transcriptUrl])

  const total = duration || (lines.at(-1)?.end_ms ?? 0) / 1000
  const speakers = useMemo(() => [...new Set(lines.map((l) => l.speaker ?? 'Speaker'))], [lines])
  const colorOf = useCallback((sp: string | null) => COLORS[Math.max(0, speakers.indexOf(sp ?? 'Speaker')) % COLORS.length], [speakers])

  // One bar per time slice: height = how much of the slice is speech, colour = who speaks most.
  const bars = useMemo(() => {
    if (!total) return []
    if (!lines.length) return seeded(src, BARS).map((h) => ({ h, color: 'var(--ink)' as string, speaker: null as string | null }))
    const slice = total / BARS
    const raw = Array.from({ length: BARS }, (_, i) => {
      const a = i * slice
      const b = a + slice
      const by = new Map<string, number>()
      let words = 0
      for (const l of lines) {
        const s = l.start_ms / 1000
        const e = Math.max(l.end_ms / 1000, s + 0.5)
        const o = Math.min(b, e) - Math.max(a, s)
        if (o > 0) {
          by.set(l.speaker ?? 'Speaker', (by.get(l.speaker ?? 'Speaker') ?? 0) + o)
          words += (l.text.split(' ').length / Math.max(1, e - s)) * o
        }
      }
      const spoken = [...by.values()].reduce((x, y) => x + y, 0)
      const speaker = [...by.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null
      return { spoken, words, color: speaker ? colorOf(speaker) : 'var(--muted-foreground)', speaker }
    })
    // Heights relative to the busiest stretch, so quiet and intense parts of the talk look different.
    const max = Math.max(...raw.map((r) => r.words), 1)
    return raw.map((r) => ({ h: r.spoken ? 0.16 + 0.84 * Math.pow(r.words / max, 0.85) : 0.06, color: r.color, speaker: r.speaker }))
  }, [lines, total, src, colorOf])

  const current = useMemo(() => {
    const ms = time * 1000
    let idx = -1
    for (let i = 0; i < lines.length; i++) if (lines[i].start_ms <= ms + 250) idx = i
    return idx
  }, [lines, time])

  // Start at the cited moment.
  useEffect(() => {
    const a = audio.current
    if (!a) return
    const go = () => {
      setDuration(a.duration)
      if (startMs != null) a.currentTime = startMs / 1000
      if (autoPlay) a.play().catch(() => {})
    }
    if (a.readyState >= 1) go()
    else a.addEventListener('loadedmetadata', go, { once: true })
  }, [src, startMs, autoPlay])

  // Keep the current transcript line in view.
  useEffect(() => {
    if (!showAll || current < 0) return
    list.current?.querySelector(`[data-i="${current}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [current, showAll])

  const seekTo = (sec: number) => {
    const a = audio.current
    if (!a || !total) return
    a.currentTime = Math.max(0, Math.min(total, sec))
    setTime(a.currentTime)
  }
  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    return (Math.max(0, Math.min(1, (clientX - r.left) / r.width)) || 0) * total
  }
  const toggle = () => {
    const a = audio.current
    if (!a) return
    if (a.paused) a.play().catch((e) => setError(String(e.message ?? e)))
    else a.pause()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault()
      toggle()
    } else if (e.key === 'ArrowRight') seekTo(time + 5)
    else if (e.key === 'ArrowLeft') seekTo(time - 5)
  }

  const pct = total ? time / total : 0
  const hoverLine = hover != null ? lines.findLast((l) => l.start_ms / 1000 <= hover) : null
  const cited = startMs != null && total ? { a: startMs / 1000 / total, b: Math.max(startMs + 3000, endMs ?? startMs) / 1000 / total } : null
  const line = current >= 0 ? lines[current] : null

  return (
    <div tabIndex={0} onKeyDown={onKey} className={cn('rounded-2xl border border-border bg-white p-4 shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40', className)}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onTimeUpdate={(e) => !dragging && setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onError={() => setError('This recording could not be played.')}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play'}
          className="grid size-12 shrink-0 place-items-center rounded-full bg-ink text-white shadow-sm transition-transform hover:scale-105 active:scale-95"
        >
          {playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{title}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {clock(time)} / {clock(total)}
            {subtitle ? ` · ${subtitle}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => seekTo(time - 15)} className="grid size-8 place-items-center rounded-full text-ink/70 hover:bg-muted" aria-label="Back 15 seconds" title="Back 15 s">
            <RotateCcw className="size-4" />
          </button>
          <button type="button" onClick={() => seekTo(time + 15)} className="grid size-8 place-items-center rounded-full text-ink/70 hover:bg-muted" aria-label="Forward 15 seconds" title="Forward 15 s">
            <RotateCw className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
              setSpeed(next)
              if (audio.current) audio.current.playbackRate = next
            }}
            className="ml-1 rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-ink/80 hover:border-cobalt"
            title="Playback speed"
          >
            {speed}×
          </button>
        </div>
      </div>

      {/* Timeline: speech activity per speaker; click or drag to seek. */}
      <div
        ref={track}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(time)}
        className="relative mt-6 h-14 cursor-pointer touch-none select-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
          setTime(at(e.clientX))
        }}
        onPointerMove={(e) => {
          setHover(at(e.clientX))
          if (dragging) setTime(at(e.clientX))
        }}
        onPointerUp={(e) => {
          setDragging(false)
          seekTo(at(e.clientX))
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div className="absolute inset-0 flex items-center gap-px">
          {bars.map((b, i) => (
            <span
              key={i}
              className="flex-1 rounded-full transition-opacity"
              style={{ height: `${Math.round(b.h * 100)}%`, background: b.color, opacity: (i + 0.5) / bars.length <= pct ? 0.95 : 0.28 }}
            />
          ))}
        </div>
        {cited && (
          <div className="pointer-events-none absolute -inset-y-1 rounded-md bg-cobalt/10 ring-2 ring-cobalt/70" style={{ left: `${cited.a * 100}%`, width: `${Math.max(0.8, (cited.b - cited.a) * 100)}%` }}>
            <span className="absolute -top-4 left-0 rounded bg-cobalt px-1 font-mono text-[9px] tracking-wide whitespace-nowrap text-white uppercase">cited</span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 rounded bg-ink" style={{ left: `${pct * 100}%` }} />
        {hover != null && (
          <div className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded-md bg-ink px-1.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-white" style={{ left: `${(hover / (total || 1)) * 100}%` }}>
            {clock(hover)}
            {hoverLine?.speaker ? ` · ${hoverLine.speaker}` : ''}
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {speakers.map((s) => (
          <span key={s} className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: colorOf(s) }} /> {s}
          </span>
        ))}
        {startMs != null && (
          <button type="button" onClick={() => seekTo(startMs / 1000)} className="ml-auto rounded-full bg-cobalt-soft px-2.5 py-0.5 text-[11.5px] text-cobalt hover:bg-cobalt hover:text-white">
            Jump to cited moment · {clock(startMs / 1000)}
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-[12.5px] text-destructive">{error}</p>}

      {lines.length > 0 && (
        <>
          <div className="mt-3 min-h-14 rounded-xl bg-paper px-3.5 py-2.5">
            {line ? (
              <p className="text-[14px] leading-relaxed text-ink">
                <span className="mr-1.5 text-[11.5px] font-medium" style={{ color: colorOf(line.speaker) }}>
                  {line.speaker}
                </span>
                {line.text}
              </p>
            ) : (
              <p className="text-[13px] text-muted-foreground">Press play. The conversation appears here as it’s spoken.</p>
            )}
          </div>
          <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 flex items-center gap-1 text-[12.5px] text-cobalt">
            <ChevronDown className={cn('size-3.5 transition-transform', !showAll && '-rotate-90')} /> {showAll ? 'Hide transcript' : `Full transcript · ${lines.length} lines`}
          </button>
          {showAll && (
            <ol ref={list} className="mt-2 max-h-72 space-y-0.5 overflow-y-auto pr-1">
              {lines.map((l, i) => (
                <li key={i} data-i={i}>
                  <button
                    type="button"
                    onClick={() => seekTo(l.start_ms / 1000)}
                    className={cn('flex w-full gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] leading-relaxed hover:bg-muted', i === current && 'bg-cobalt-soft')}
                  >
                    <span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">{clock(l.start_ms / 1000)}</span>
                    <span>
                      <span className="mr-1.5 text-[11.5px] font-medium" style={{ color: colorOf(l.speaker) }}>
                        {l.speaker}
                      </span>
                      {l.text}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  )
}
