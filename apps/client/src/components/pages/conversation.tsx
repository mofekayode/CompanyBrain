'use client'

// A conversation with the company record. Each question streams: the real steps as they happen
// (searching, choosing the fact, its history, opening files, checking access), the answer as
// soon as its headline is known, then sources. Esc or Stop cancels. Follow-ups that point back
// ("them", "that", "and in 2024?") carry the previous topic, minus its time words.

import { Check, ChevronDown, Loader2, MessageCircleQuestion, RotateCcw, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnswerCard } from '@/components/answer/answer-card'
import { Timeline } from '@/components/answer/bits'
import { Omnibox } from '@/components/omni/omnibox'
import { KeyHint } from '@/components/key-hint'
import { useSession } from '@/components/shell/session'
import { EmptyState } from '@/components/states'
import { Skeleton } from '@/components/ui/skeleton'
import { tenantApi } from '@/lib/api'
import { pushRecent } from '@/lib/recents'
import { postSSE } from '@/lib/sse'
import type { Brief, BriefPartial, BriefSource, BriefStep } from '@/lib/types'
import { cn } from '@/lib/utils'

const POINTS_BACK = /\b(them|it|its|they|their|that|those|this|he|she|his|her|before|after|then)\b|^(and|what about|how about)\b/i
const TIME_WORDS = /\b(now|today|currently|current|these days|right now|at the moment)\b/gi

interface Turn {
  q: string
  steps: BriefStep[]
  partial?: BriefPartial
  brief?: Brief
  /** Streaming written answer and the sources it cites. */
  writing?: string
  wsources?: BriefSource[]
  done?: boolean
  error?: string
  stopped?: boolean
  started: number
  ms?: number
}

function Steps({ steps, done, ms }: { steps: BriefStep[]; done: boolean; ms?: number }) {
  const [open, setOpen] = useState(false)
  if (done && !open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-ink">
        <Check className="size-3.5 text-verified" /> {steps.length} steps{ms ? ` · ${(ms / 1000).toFixed(1)} s` : ''} <ChevronDown className="size-3" />
      </button>
    )
  return (
    <ol className="space-y-1.5" aria-live="polite">
      {steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2 text-[13px]">
          {s.status === 'done' ? <Check className="mt-0.5 size-3.5 shrink-0 text-verified" /> : <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-cobalt" />}
          <span className={cn(s.status === 'done' ? 'text-ink/80' : 'text-ink')}>
            {s.label}
            {s.detail && <span className="text-muted-foreground"> · {s.detail}</span>}
          </span>
        </li>
      ))}
      {!done && steps.length === 0 && (
        <li className="flex items-center gap-2 text-[13px] text-ink">
          <Loader2 className="size-3.5 animate-spin text-cobalt" /> Starting…
        </li>
      )}
    </ol>
  )
}

export function Conversation({ initial }: { initial?: string }) {
  const { slug, me } = useSession()
  const [turns, setTurns] = useState<Turn[]>([])
  const asked = useRef(false)
  const end = useRef<HTMLDivElement>(null)
  const ctrl = useRef<AbortController | null>(null)
  const count = useRef(0)
  count.current = turns.length
  const update = (i: number, f: (t: Turn) => Turn) => setTurns((ts) => ts.map((t, k) => (k === i ? f(t) : t)))

  const ask = useCallback(
    async (q: string, retryIndex?: number) => {
      const prev = retryIndex === undefined ? turns.at(-1)?.q : turns[retryIndex - 1]?.q
      const sent = prev && POINTS_BACK.test(q) && q.split(' ').length < 12 ? `${q} (about: ${prev.replace(TIME_WORDS, '').replace(/\?/g, '').trim()})` : q
      pushRecent(slug, me?.id, { kind: 'ask', label: q, ref: q })
      const index = retryIndex ?? count.current
      count.current = Math.max(count.current, index + 1)
      const fresh: Turn = { q, steps: [], started: Date.now() }
      setTurns((ts) => (retryIndex !== undefined ? ts.map((x, k) => (k === retryIndex ? fresh : x)) : [...ts, fresh]))
      ctrl.current?.abort()
      const c = new AbortController()
      ctrl.current = c
      try {
        await postSSE(
          `${tenantApi(slug)}/app/ask/stream`,
          { q: sent, as: me?.id ?? null },
          (event, data) => {
            if (event === 'step') {
              const s = data as BriefStep
              update(index, (t) => ({ ...t, steps: [...t.steps.filter((x) => x.id !== s.id), s] }))
            } else if (event === 'partial') update(index, (t) => ({ ...t, partial: { ...(data as BriefPartial), question: q } }))
            else if (event === 'brief') update(index, (t) => ({ ...t, brief: { ...(data as Brief), question: q } }))
            else if (event === 'sources') update(index, (t) => ({ ...t, wsources: data as BriefSource[], writing: '' }))
            else if (event === 'delta') update(index, (t) => ({ ...t, writing: (t.writing ?? '') + (data as string) }))
            else if (event === 'done') update(index, (t) => ({ ...t, brief: { ...(data as Brief), question: q }, done: true, ms: Date.now() - t.started }))
            else if (event === 'error') update(index, (t) => ({ ...t, error: (data as { message: string }).message }))
          },
          c.signal,
        )
      } catch (e) {
        if (c.signal.aborted) update(index, (t) => (t.done ? t : t.brief ? { ...t, done: true, writing: undefined } : { ...t, stopped: true }))
        else update(index, (t) => ({ ...t, error: (e as Error).message === 'Failed to fetch' ? 'Can’t reach Company Brain. Check your connection.' : (e as Error).message }))
      }
      const u = new URL(window.location.href)
      u.searchParams.set('q', q)
      window.history.replaceState(null, '', u)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [turns, slug, me?.id],
  )
  const stop = () => ctrl.current?.abort()

  useEffect(() => {
    if (initial && !asked.current) {
      asked.current = true
      ask(initial)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length])

  const busy = turns.some((t) => !t.done && !t.error && !t.stopped)
  // Esc stops an answer in progress, from anywhere on the page.
  useEffect(() => {
    if (!busy) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stop()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])

  return (
    <div className="mx-auto max-w-3xl pt-10">
      {!turns.length && (
        <EmptyState icon={MessageCircleQuestion} title="Ask a question about the company" className="mb-8">
          Ask in plain words about a customer, a person, a rule, an asset or a date. Add a time to ask about the past (“in 2023”, “before the sale”). Follow-ups keep the topic.
        </EmptyState>
      )}
      <div className="space-y-14">
        {turns.map((t, i) => (
          <div key={i} className="flex flex-col gap-4">
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[14px] whitespace-pre-line text-white">{t.q}</p>
            </div>
            {!t.error && !t.stopped && !t.brief && <Steps steps={t.steps} done={false} ms={t.ms} />}
            {t.brief ? (
              <AnswerCard brief={t.brief} onAsk={busy ? undefined : (q) => ask(q)} writing={t.done ? null : t.writing} writtenSources={t.wsources} research={{ steps: t.steps, ms: t.ms, done: !!t.done }} />
            ) : t.error ? (
              <div className="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-[13.5px]">
                <WifiOff className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="flex-1">
                  <p className="font-medium text-destructive">Couldn’t get an answer</p>
                  <p className="text-ink/75">{t.error}</p>
                </div>
                <button type="button" onClick={() => ask(t.q, i)} className="inline-flex items-center gap-1 rounded-lg border border-border bg-white px-2.5 py-1 text-[12.5px]">
                  <RotateCcw className="size-3.5" /> Retry
                </button>
              </div>
            ) : t.stopped ? (
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                Stopped.
                <button type="button" onClick={() => ask(t.q, i)} className="text-cobalt hover:underline">
                  Ask again
                </button>
              </p>
            ) : t.partial ? (
              <div className="space-y-3">
                {t.partial.headline ? (
                  <>
                    <p className="text-[19px] leading-snug font-semibold tracking-[-0.015em] text-ink text-balance">{t.partial.headline}</p>
                    {t.partial.detail && <p className="text-[14.5px] leading-relaxed text-ink/75">{t.partial.detail}</p>}
                    {t.partial.timeline && <Timeline steps={t.partial.timeline} />}
                  </>
                ) : (
                  <p className="text-[14px] text-muted-foreground">No single reviewed fact answers this. Gathering the files that do…</p>
                )}
                <div className="space-y-1.5 pt-2">
                  {[0, 1, 2].map((k) => (
                    <Skeleton key={k} className="h-14 w-full rounded-lg" />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {/* Room for the docked composer, so the last answer can scroll clear of it. */}
      <div ref={end} className="h-48" aria-hidden />
      <div className="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background from-75% to-transparent pt-8 pb-5">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <Omnibox mode="ask" dropUp onSubmit={(q) => ask(q)} busy={busy} onStop={stop} clearOnSubmit autoFocus={!initial} placeholder={turns.length ? 'Ask a follow-up…' : undefined} />
          <KeyHint id="ask" className="mt-1.5 text-center">↵ ask · ⇧↵ new line · ↑↓ pick a match · esc {busy ? 'stop' : 'clear'} · ⌘K anywhere</KeyHint>
        </div>
      </div>
    </div>
  )
}
