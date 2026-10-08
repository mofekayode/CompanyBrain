'use client'

// One answer: answer first, investigation available.
//   1. The direct answer (a few sentences), or an honest state: not on record / can't answer
//      from what you can open (never naming what's restricted).
//   2. "Changed …" in one line, when the answer has a history.
//   3. "Why this is the answer" (collapsed): detail, history, disagreements, evidence.
//   4. Related: follow-ups, the records involved, the matching brief.
// Citations in the answer open the explanation and jump to the source.

import { AlertTriangle, ArrowUpRight, BookOpen, Check, ChevronDown, Clock, History, Loader2, Lock, MessageCircleQuestion, SearchX, Sparkles } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { useSession } from '@/components/shell/session'
import { tidy } from '@/lib/text'
import type { Brief, BriefSource, BriefStep } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SourceRow, SourceViewer, StatusPill, Timeline } from './bits'

function Cite({ ns, onPick }: { ns: number[]; onPick: (n: number) => void }) {
  return (
    <span className="ml-1 inline-flex gap-0.5 align-[1px]">
      {ns.slice(0, 4).map((n) => (
        <button key={n} type="button" onClick={() => onPick(n)} className="rounded bg-cobalt-soft px-1 font-mono text-[10px] leading-4 text-cobalt hover:bg-cobalt hover:text-white">
          {n}
        </button>
      ))}
    </span>
  )
}

/** Text with [n] / [n, m] turned into source chips. */
function WithCites({ text, onPick, streaming, className }: { text: string; onPick: (n: number) => void; streaming?: boolean; className?: string }) {
  const parts = tidy(text).split(/(\[\d+(?:\s*,\s*\d+)*\])/g)
  return (
    <div className={cn('whitespace-pre-line', className)}>
      {parts.map((p, i) => {
        const m = p.match(/^\[([\d,\s]+)\]$/)
        return m ? <Cite key={i} ns={m[1].split(',').map((x) => Number(x.trim()))} onPick={onPick} /> : <span key={i}>{p}</span>
      })}
      {streaming && <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-cobalt" aria-hidden />}
    </div>
  )
}

/** The matching brief for what was asked about, if there is one. */
function briefOffer(b: Pick<Brief, 'question' | 'entities'>) {
  const q = b.question.toLowerCase()
  const customer = b.entities.find((e) => e.type === 'Customer')
  const person = b.entities.find((e) => e.type === 'Person')
  const asset = b.entities.find((e) => e.type === 'Asset')
  if (customer && /(prepare|brief|dossier|renewal|meeting|everything about)/.test(q)) return { skill: 'customer_dossier', input: customer.name, label: `Prepare the ${customer.name} dossier`, strong: true }
  if (person && /(leave|leaves|leaving|retire|depend|knows|only one)/.test(q)) return { skill: 'key_person_audit', input: person.name, label: `See everything that depends on ${person.name}`, strong: true }
  if (asset && /(fail|failing|broke|incident|keep)/.test(q)) return { skill: 'incident_investigation', input: asset.name, label: `Investigate ${asset.name}`, strong: true }
  if (customer) return { skill: 'customer_dossier', input: customer.name, label: `${customer.name} dossier`, strong: false }
  if (person) return { skill: 'key_person_audit', input: person.name, label: `What depends on ${person.name}`, strong: false }
  if (asset) return { skill: 'incident_investigation', input: asset.name, label: `${asset.name} incident history`, strong: false }
  return null
}

/** Follow-ups that make sense after this answer. */
function followUps(b: Brief): string[] {
  const e = b.entities[0]
  const out: string[] = []
  if (b.timeline && b.time?.mode !== 'change') out.push('How has this changed over time?')
  if (b.time?.mode === 'current' || !b.time || b.time.mode === 'none') out.push(e ? `What was it for ${e.name} a year ago?` : 'What was it a year ago?')
  if (e?.type === 'Customer') out.push(`What are the risks with ${e.name}?`)
  if (e?.type === 'Person') out.push(`What does ${e.name.split(' ')[0]} know that nobody else does?`)
  if (e && e.type !== 'Person') out.push(`Who knows the most about ${e.name}?`)
  return out.slice(0, 3)
}

/** "Changed Oct 2026 · previously …" from the answer's history. */
function changedLine(b: Brief): { when: string; before: string } | null {
  if (!b.timeline || b.timeline.length < 2) return null
  const i = b.timeline.findIndex((s) => s.current)
  const cur = b.timeline[i]
  const prev = b.timeline[i - 1]
  if (!cur || !prev) return null
  return { when: cur.when.replace(/^since /, ''), before: prev.value }
}

export function AnswerCard({
  brief,
  onAsk,
  writing,
  writtenSources,
  research,
}: {
  brief: Brief
  onAsk?: (q: string) => void
  writing?: string | null
  writtenSources?: BriefSource[] | null
  research?: { steps: BriefStep[]; ms?: number; done: boolean }
}) {
  const { slug } = useSession()
  const [open, setOpen] = useState<BriefSource | null>(null)
  const [why, setWhy] = useState(false)
  const [showResearch, setShowResearch] = useState(false)
  const [all, setAll] = useState(false)

  const written = brief.written
  const streamingText = writing ?? null
  const isWritten = !!written || streamingText != null
  const fullText = written?.text ?? streamingText ?? ''
  const [shortText, detailText] = (() => {
    const m = fullText.split(/\n\s*-{3,}\s*\n?/)
    return [m[0] ?? '', m.slice(1).join('\n').trim()]
  })()

  // Three honest states before anything else.
  const locked = !!brief.restricted?.best_is_locked && !brief.headline && brief.evidence === 'weak'
  const nothing = !locked && !brief.headline && brief.evidence === 'weak'
  const evidence = (isWritten && writtenSources?.length ? writtenSources : brief.sources).map((s) => (nothing ? { ...s, status: 'related' as const } : s))
  const sources = all ? evidence : evidence.slice(0, 6)
  const offer = briefOffer(brief)
  const ups = followUps(brief)
  const changed = changedLine(brief)

  const pick = (n: number) => {
    setWhy(true)
    setTimeout(() => document.getElementById(`source-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Research: live while working, one line once done. */}
      {research &&
        (research.done && !showResearch ? (
          <button type="button" onClick={() => setShowResearch(true)} className="flex w-fit items-center gap-1.5 text-[12px] text-muted-foreground hover:text-ink">
            <Check className="size-3.5 text-verified" /> Checked {evidence.length} sources{research.ms ? ` in ${(research.ms / 1000).toFixed(1)} s` : ''} · <span className="underline-offset-2 hover:underline">View research</span>
          </button>
        ) : (
          <ol className="space-y-1.5" aria-live="polite">
            {research.steps.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-[13px]">
                {s.status === 'done' ? <Check className="mt-0.5 size-3.5 shrink-0 text-verified" /> : <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-cobalt" />}
                <span className={cn(s.status === 'done' ? 'text-ink/80' : 'text-ink')}>
                  {s.label}
                  {s.detail && <span className="text-muted-foreground"> · {s.detail}</span>}
                </span>
              </li>
            ))}
            {research.done && (
              <li>
                <button type="button" onClick={() => setShowResearch(false)} className="text-[12px] text-muted-foreground hover:text-ink">
                  Hide research
                </button>
              </li>
            )}
          </ol>
        ))}

      {/* 1. The answer */}
      <section>
        {brief.time && brief.time.mode !== 'none' && (
          <p className="mb-2 flex w-fit items-center gap-1 rounded-full bg-cobalt-soft px-2 py-0.5 font-mono text-[10.5px] text-cobalt">
            <Clock className="size-3" /> {brief.time.mode === 'as_of' ? `as of ${brief.time.reading}` : brief.time.mode === 'change' ? 'how it changed' : 'in force now'}
          </p>
        )}
        {locked ? (
          <>
            <p className="flex items-start gap-2 text-[19px] leading-snug font-semibold tracking-[-0.015em] text-ink">
              <Lock className="mt-1 size-4.5 shrink-0" /> I can’t answer that from information you have access to.
            </p>
            <p className="mt-1.5 text-[14px] text-ink/75">
              Some potentially relevant sources are restricted.{' '}
              <Link href={`/${slug}/sources`} className="text-cobalt underline-offset-2 hover:underline">
                Request access
              </Link>
            </p>
          </>
        ) : isWritten ? (
          <WithCites text={shortText} onPick={pick} streaming={!written && !detailText} className="text-[17px] leading-relaxed font-medium tracking-[-0.01em] text-ink" />
        ) : brief.headline ? (
          <p className="text-[18px] leading-snug font-semibold tracking-[-0.015em] text-ink text-balance">
            {tidy(brief.headline)}
            <Cite ns={[1]} onPick={pick} />
          </p>
        ) : nothing ? (
          <p className="flex items-start gap-2 text-[18px] leading-snug font-semibold tracking-[-0.015em] text-ink">
            <SearchX className="mt-1 size-4.5 shrink-0 text-muted-foreground" /> Nothing on record answers this.
          </p>
        ) : (
          <p className="text-[18px] leading-snug font-semibold tracking-[-0.015em] text-ink">
            The closest material is in {evidence[0]?.title}
            {evidence.length > 1 && <span className="font-normal text-muted-foreground"> and {evidence.length - 1} other sources</span>}
            <Cite ns={[1]} onPick={pick} />
          </p>
        )}
        {!locked && !isWritten && !brief.headline && !nothing && (
          <p className="mt-2 flex items-start gap-2 text-[13px] text-ink/70">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-stale" /> No reviewed fact covers this yet. Check the source before relying on it.
          </p>
        )}
        {/* Restricted matches alongside a real answer: counted, never named, never characterised. */}
        {!locked && brief.restricted && (
          <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Lock className="size-3.5" /> Some potentially relevant sources are restricted.
            <Link href={`/${slug}/sources`} className="text-cobalt hover:underline">
              Request access
            </Link>
          </p>
        )}
      </section>

      {/* 2. What changed, in one line */}
      {changed && !locked && (
        <p className="flex items-start gap-2 text-[13px] text-ink/80">
          <History className="mt-0.5 size-3.5 shrink-0 text-stale" />
          <span>
            <span className="font-medium">Changed {changed.when}.</span> Previously: {tidy(changed.before)}
          </span>
        </p>
      )}
      {brief.conflicts.length > 0 && (
        <p className="flex items-start gap-2 text-[13px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Sources disagree on this. See why below.
        </p>
      )}

      {/* 3. Why this is the answer */}
      {evidence.length > 0 && (
        <section className="rounded-xl border border-border bg-white">
          <button type="button" onClick={() => setWhy((v) => !v)} aria-expanded={why} className="flex w-full items-center gap-2 px-4 py-3 text-left text-[13.5px]">
            {nothing || locked ? <SearchX className="size-4 text-muted-foreground" /> : <Sparkles className="size-4 text-cobalt" />}
            <span className="flex-1 font-medium">{nothing || locked ? 'Closest related material' : 'Why this is the answer'}</span>
            <span className="text-[12px] text-muted-foreground">{evidence.length} sources</span>
            <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', !why && '-rotate-90')} />
          </button>
          {why && (
            <div className="space-y-4 border-t border-border px-4 py-4">
              {detailText && <WithCites text={detailText} onPick={pick} streaming={!written} className="text-[14px] leading-relaxed text-ink/85" />}
              {brief.timeline && !locked && (
                <div>
                  <p className="eyebrow-muted mb-2">History</p>
                  <Timeline steps={brief.timeline} />
                </div>
              )}
              {brief.conflicts.length > 0 && (
                <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-[13px]">
                  <p className="font-medium text-destructive">Sources disagree</p>
                  <ul className="mt-1 list-disc pl-5 text-ink/80">
                    {brief.conflicts.map((c) => (
                      <li key={c}>{tidy(c)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!isWritten && !nothing && !locked && brief.also.length > 0 && (
                <ul className="space-y-1.5">
                  {brief.also.map((a) => (
                    <li key={a.text} className="flex items-start gap-2 text-[13.5px] leading-relaxed">
                      <StatusPill status={a.status} className="mt-0.5" />
                      <span className={cn(a.status === 'outdated' && 'text-muted-foreground')}>
                        {tidy(a.text)}
                        <Cite ns={a.cites} onPick={pick} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <p className="eyebrow-muted mb-2">{nothing || locked ? 'No supporting evidence found · closest related material' : 'Evidence'}</p>
                <ul className="space-y-1.5">
                  {sources.map((s) => (
                    <SourceRow key={s.id} s={s} onOpen={setOpen} />
                  ))}
                </ul>
                {evidence.length > 6 && (
                  <button onClick={() => setAll((v) => !v)} className="mt-2 text-[12.5px] text-cobalt hover:underline">
                    {all ? 'Fewer sources' : `All ${evidence.length} sources`}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* 4. Related */}
      {(offer || ups.length > 0 || brief.entities.length > 0) && !locked && (
        <section className="space-y-2.5">
          {offer?.strong && (
            <Link href={`/${slug}/briefs?skill=${offer.skill}&input=${encodeURIComponent(offer.input)}`} className="flex items-center justify-between rounded-xl bg-ink px-4 py-3 text-[14px] text-white">
              {offer.label} <ArrowUpRight className="size-4" />
            </Link>
          )}
          <div className="flex flex-wrap gap-1.5">
            {onAsk &&
              !nothing &&
              ups.map((u) => (
                <button key={u} type="button" onClick={() => onAsk(u)} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 text-[12.5px] text-ink/85 hover:border-cobalt hover:text-cobalt">
                  <MessageCircleQuestion className="size-3.5" /> {u}
                </button>
              ))}
            {brief.entities.slice(0, 3).map((e) => (
              <Link key={e.id} href={`/${slug}/e/${e.id}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-3 py-1 text-[12.5px] hover:border-cobalt">
                {e.name} <span className="text-muted-foreground">· {e.type}</span> <ArrowUpRight className="size-3" />
              </Link>
            ))}
            {offer && !offer.strong && (
              <Link href={`/${slug}/briefs?skill=${offer.skill}&input=${encodeURIComponent(offer.input)}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-3 py-1 text-[12.5px] hover:border-cobalt">
                <BookOpen className="size-3.5" /> {offer.label}
              </Link>
            )}
          </div>
        </section>
      )}
      <SourceViewer source={open} onClose={() => setOpen(null)} />
    </div>
  )
}
