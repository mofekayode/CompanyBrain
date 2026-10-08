'use client'

// Search: find the thing. One input with typeahead. Before typing: recent searches, people,
// things you opened. After: what the search is about (an "about" card: what it is, what it's
// also called, where it sits, what changed, the best evidence), a count line that doubles as
// filters, then results grouped by meaning (facts, what changed, documents and data,
// conversations, related records). One Time control: any time · current · historical · as of a
// date · updated within.

import { ArrowRight, Clock, Database, History, MessageCircleQuestion, Search as SearchIcon, SearchX, Sparkles, User, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SourceViewer } from '@/components/answer/bits'
import { AboutCard, byFile, type Card, ConversationRow, FactRow, FileRow, GROUPS, type GroupKey, groupOf, type Hit, Records, Section, toSource } from '@/components/search/results'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { KeyHint } from '@/components/key-hint'
import { Omnibox, type OmniboxHandle } from '@/components/omni/omnibox'
import { useSession } from '@/components/shell/session'
import { EmptyState, SkeletonList } from '@/components/states'
import { Skeleton } from '@/components/ui/skeleton'
import { getJSON, tenantApi } from '@/lib/api'
import { pushRecent, type Recent, recentOf } from '@/lib/recents'
import type { BriefSource } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Import debris ("(No owner)", "· CT") is not a record worth showing. */
const realName = (t: string) => /^[A-Za-z0-9]/.test(t) && !/^\(/.test(t)

interface Result {
  weak?: boolean
  understood: { entities: { id: string; name: string; type: string }[]; time?: { mode: string; reading: string } }
  hits: Hit[]
  timings: { total_ms: number }
}

type Time = { mode: 'any' | 'current' | 'historical' | 'asof' | 'updated'; date?: string; within?: number }
const dateOf = (h: Hit) => (h.observed_at ?? h.valid_from)?.slice(0, 10) ?? null
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
function timeKeeps(t: Time, h: Hit) {
  const d = dateOf(h)
  if (t.mode === 'current') return h.doc_type !== 'fact' || h.is_current
  if (t.mode === 'historical') return h.doc_type === 'fact' ? !h.is_current : !!d && d < daysAgo(365)
  if (t.mode === 'asof' && t.date) return h.doc_type !== 'fact' || ((!h.valid_from || h.valid_from.slice(0, 10) <= t.date) && (!h.valid_to || h.valid_to.slice(0, 10) >= t.date))
  if (t.mode === 'updated' && t.within) return !!d && d >= daysAgo(t.within)
  return true
}
const TIME_OPTIONS = [
  { value: 'any', label: 'Any time' },
  { value: 'current', label: 'Current' },
  { value: 'historical', label: 'Historical' },
  { value: 'asof', label: 'As of a date…' },
  { value: 'updated:30', label: 'Updated within 30 days' },
  { value: 'updated:90', label: 'Updated within 3 months' },
  { value: 'updated:365', label: 'Updated within 12 months' },
]
const timeLabel = (t: Time) =>
  t.mode === 'current' ? 'Current' : t.mode === 'historical' ? 'Historical' : t.mode === 'asof' ? `As of ${t.date}` : t.mode === 'updated' ? `Updated within ${t.within === 30 ? '30 days' : t.within === 90 ? '3 months' : '12 months'}` : 'Any time'

export function SearchPage({ initial }: { initial?: string }) {
  const { slug, me } = useSession()
  const router = useRouter()
  const box = useRef<OmniboxHandle>(null)
  const [q, setQ] = useState(initial ?? '')
  const [res, setRes] = useState<Result | null>(null)
  const [card, setCard] = useState<Card | null>(null)
  const [cardLoading, setCardLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'all' | GroupKey>('all')
  const [time, setTime] = useState<Time>({ mode: 'any' })
  const [open, setOpen] = useState<BriefSource | null>(null)
  const [people, setPeople] = useState<{ id: string; name: string; title: string | null }[] | null>(null)
  const [recents, setRecents] = useState<Recent[]>([])

  const run = async (query: string, t: Time = time) => {
    const text = query.trim()
    if (!text) return
    setQ(text)
    box.current?.set(text)
    setBusy(true)
    setError(null)
    setTab('all')
    pushRecent(slug, me?.id, { kind: 'search', label: text, ref: text })
    try {
      const r = await getJSON<Result>(`${tenantApi(slug)}/app/search?q=${encodeURIComponent(text)}&as=${me?.id ?? ''}${t.mode === 'asof' && t.date ? `&as_of=${t.date}` : ''}`)
      setRes(r)
      // The record this search is about: what the query names, else the top record result.
      // Only when the query names it, or it's the very top result: a search for a topic ("lockout
      // two person") isn't about whichever record happens to rank first among the records.
      const top = r.hits[0]
      const best = r.understood.entities.find((e) => e.type !== 'Term')?.id ?? (top?.doc_type === 'entity' && top.kind !== 'Term' && realName(top.title) ? top.id.slice(2) : undefined)
      setCard(null)
      if (best && !r.weak) {
        setCardLoading(true)
        getJSON<Card>(`${tenantApi(slug)}/app/entities/${best}/card?as=${me?.id ?? ''}`)
          .then(setCard)
          .catch(() => {})
          .finally(() => setCardLoading(false))
      }
      const u = new URL(window.location.href)
      u.searchParams.set('q', text)
      window.history.replaceState(null, '', u)
    } catch (e) {
      setError((e as Error).message === 'Failed to fetch' ? 'Can’t reach Company Brain. Check your connection.' : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (initial) run(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id])
  useEffect(() => {
    getJSON<{ people: { id: string; name: string; title: string | null }[] }>(`${tenantApi(slug)}/app/home?as=${me?.id ?? ''}`)
      .then((h) => setPeople(h.people ?? []))
      .catch(() => setPeople([]))
    const load = () => setRecents(recentOf(slug, me?.id, ['search', 'entity', 'file'], 12))
    load()
    window.addEventListener('cb-recents', load)
    return () => window.removeEventListener('cb-recents', load)
  }, [slug, me?.id])

  const setTimeAndRun = (t: Time) => {
    const refetch = t.mode === 'asof' || time.mode === 'asof'
    setTime(t)
    if (refetch && q) run(q, t)
  }

  // The card covers the record itself and its nicknames: those don't repeat as results.
  const inCard = new Set(card ? [card.id, ...card.facts.map((f) => f.id), ...(card.changed ? [card.changed.id] : [])] : [])
  const coveredByCard = (h: Hit) => !!card && (inCard.has(h.id.slice(2)) || (h.kind === 'Term' && h.content.includes(`: ${card.name}`)))
  const kept = useMemo(() => (res?.hits ?? []).filter((h) => !coveredByCard(h) && timeKeeps(time, h)), [res, time, card]) // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = (res?.hits ?? []).filter((h) => !coveredByCard(h)).length - kept.length
  // The card's "best evidence": the top three files; the lists below don't repeat them.
  const best = useMemo(() => (card ? byFile(kept.filter((h) => h.doc_type === 'passage')).slice(0, 3) : []), [kept, card])
  const grouped = useMemo(() => {
    const shown = new Set(best.map((f) => f.hit.source_object_id ?? f.hit.id))
    const m = new Map<GroupKey, Hit[]>()
    for (const h of kept) {
      if (h.doc_type === 'passage' && shown.has(h.source_object_id ?? h.id)) continue
      // Import debris and bare numbers aren't records worth listing (and shouldn't be counted).
      if (h.doc_type === 'entity' && (!realName(h.title) || /^[\d\s]+\(/.test(h.title))) continue
      m.set(groupOf(h), [...(m.get(groupOf(h)) ?? []), h])
    }
    return m
  }, [kept, best])
  const count = (k: GroupKey) => (k === 'evidence' || k === 'conversations' ? byFile(grouped.get(k) ?? []).length : (grouped.get(k)?.length ?? 0))
  const labelOf = (k: GroupKey) => (k === 'facts' && card ? `About ${card.name}` : GROUPS.find((g) => g.key === k)!.label)
  const openHit = (h: Hit) => setOpen(toSource(h))
  const rows = (k: GroupKey, limit?: number) => {
    const hs = grouped.get(k) ?? []
    if (k === 'records')
      return (
        <div className="px-4 py-3.5 sm:px-5">
          <Records hits={tab === 'all' ? hs.slice(0, card ? 8 : 12) : hs} slug={slug} />
        </div>
      )
    if (k === 'facts' || k === 'changed')
      return (
        <ol className="divide-y divide-border">
          {(limit ? hs.slice(0, limit) : hs).map((h) => (
            <FactRow key={h.id} h={h} hideSubject={card?.name} />
          ))}
        </ol>
      )
    const files = byFile(hs)
    const Row = k === 'conversations' ? ConversationRow : FileRow
    return (
      <ol className="divide-y divide-border">
        {(limit ? files.slice(0, limit) : files).map((f) => (
          <Row key={f.hit.id} f={f} query={q} onOpen={openHit} />
        ))}
      </ol>
    )
  }
  const group = (k: GroupKey, limit?: number) => (
    <Section key={k} label={labelOf(k)} count={count(k)} onAll={limit && count(k) > limit ? () => setTab(k) : undefined}>
      {rows(k, limit)}
    </Section>
  )
  const recentSearches = recents.filter((r) => r.kind === 'search').slice(0, 6)
  const recentViewed = recents.filter((r) => r.kind !== 'search').slice(0, 6)
  const askIt = () => {
    pushRecent(slug, me?.id, { kind: 'ask', label: q, ref: q })
    router.push(`/${slug}/ask?q=${encodeURIComponent(q)}`)
  }

  return (
    <div className="mx-auto max-w-3xl pt-10">
      <Omnibox ref={box} mode="search" initial={initial} onSubmit={(t) => run(t)} busy={busy} autoFocus big />
      <KeyHint id="search" className="mt-2">↵ search · ↑↓ pick a match · esc clear · ⌘K anywhere</KeyHint>

      {error && <p className="mt-6 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">{error}</p>}
      {busy && !res && (
        <div className="mt-6 space-y-6">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <SkeletonList rows={4} />
        </div>
      )}

      {!res && !busy && (
        <div className="mt-8 grid gap-8 sm:grid-cols-2">
          <section>
            <div className="eyebrow-muted mb-2.5 flex items-center gap-1.5">
              <Clock className="size-3" /> Recent searches
            </div>
            {recentSearches.length ? (
              <ul className="space-y-1">
                {recentSearches.map((r) => (
                  <li key={r.ref}>
                    <button type="button" onClick={() => run(r.ref)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px] hover:bg-white">
                      <SearchIcon className="size-3.5 text-muted-foreground" /> {r.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {['the cage', 'Kemper escalator', 'TP-17 seal leak', 'lockout two person'].map((x) => (
                  <button key={x} type="button" onClick={() => run(x)} className="rounded-full border border-border bg-white px-3 py-1 text-[12.5px] text-ink/80 hover:border-cobalt hover:text-cobalt">
                    {x}
                  </button>
                ))}
              </div>
            )}
          </section>
          <section>
            <div className="eyebrow-muted mb-2.5 flex items-center gap-1.5">
              <User className="size-3" /> People
            </div>
            {!people ? (
              <SkeletonList rows={2} />
            ) : (
              <ul className="space-y-1">
                {people.map((p) => (
                  <li key={p.id}>
                    <Link href={`/${slug}/e/${p.id}`} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white">
                      <span className="grid size-6 place-items-center rounded-full bg-navy text-[9.5px] font-semibold text-white">
                        {p.name
                          .split(' ')
                          .map((w) => w[0])
                          .slice(0, 2)
                          .join('')}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px]">{p.name}</span>
                        {p.title && <span className="block truncate text-[11.5px] text-muted-foreground">{p.title}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {recentViewed.length > 0 && (
            <section className="sm:col-span-2">
              <div className="eyebrow-muted mb-2.5">Recently viewed</div>
              <div className="flex flex-wrap gap-1.5">
                {recentViewed.map((r) => (
                  <Link
                    key={r.kind + r.ref}
                    href={r.kind === 'entity' ? `/${slug}/e/${r.ref}` : `/${slug}/sources?open=${r.ref}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 text-[12.5px] hover:border-cobalt"
                  >
                    {r.kind === 'entity' ? <Database className="size-3.5 text-muted-foreground" /> : <SearchIcon className="size-3.5 text-muted-foreground" />}
                    <span className="truncate">{r.label}</span>
                    {r.detail && r.kind === 'entity' && <span className="text-muted-foreground">· {r.detail}</span>}
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {res && (
        <div className={cn('mt-6 transition-opacity', busy && 'pointer-events-none opacity-50')}>
          {/* What this search is about: the record, its nicknames, where it sits, what changed, the best evidence. */}
          {cardLoading && !card ? (
            <Skeleton className="h-56 w-full rounded-2xl" />
          ) : card ? (
            <AboutCard card={card} slug={slug} evidence={best} onOpen={openHit} onAsk={askIt} />
          ) : (
            <button type="button" onClick={askIt} className="flex w-full items-center gap-3 rounded-xl border border-cobalt/25 bg-cobalt-soft px-4 py-2.5 text-left text-[13.5px] text-navy hover:border-cobalt/60">
              <Sparkles className="size-4 text-cobalt" />
              <span className="flex-1">
                Ask Company Brain: <span className="font-medium">“{q}”</span>
              </span>
              <ArrowRight className="size-4 text-cobalt" />
            </button>
          )}

          {/* Counts that double as filters, plus one Time control. */}
          <div className="mt-5 flex flex-wrap items-center gap-x-1 gap-y-2 text-[13px]">
            <button type="button" onClick={() => setTab('all')} className={cn('rounded-full px-2.5 py-1', tab === 'all' ? 'bg-ink text-white' : 'text-ink/75 hover:bg-white')}>
              All
            </button>
            {GROUPS.map((g) =>
              count(g.key) ? (
                <button key={g.key} type="button" onClick={() => setTab(g.key)} className={cn('rounded-full px-2.5 py-1', tab === g.key ? 'bg-ink text-white' : 'text-ink/75 hover:bg-white')}>
                  {count(g.key)} {count(g.key) === 1 ? g.short.replace(/s$/, '') : g.short}
                </button>
              ) : null,
            )}
            <span className="ml-auto flex items-center gap-1.5">
              <History className="size-3.5 text-muted-foreground" />
              <Select
                value={time.mode === 'updated' ? `updated:${time.within}` : time.mode}
                items={TIME_OPTIONS}
                onValueChange={(v) => {
                  const val = String(v)
                  if (val.startsWith('updated:')) setTimeAndRun({ mode: 'updated', within: Number(val.split(':')[1]) })
                  else if (val === 'asof') setTimeAndRun({ mode: 'asof', date: time.date ?? daysAgo(365) })
                  else setTimeAndRun({ mode: val as Time['mode'] })
                }}
              >
                <SelectTrigger aria-label="Time" className="h-8 min-w-40 rounded-full border-border bg-white text-[13px] shadow-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" alignItemWithTrigger={false}>
                  {TIME_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-[13px]">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {time.mode === 'asof' && (
                <input type="date" value={time.date} onChange={(e) => e.target.value && setTimeAndRun({ mode: 'asof', date: e.target.value })} className="rounded-full border border-border bg-white px-3 py-1" aria-label="As of date" />
              )}
            </span>
          </div>
          {time.mode !== 'any' && (
            <p className="mt-2 flex items-center gap-2 text-[12.5px] text-muted-foreground">
              Showing <span className="font-medium text-ink">{timeLabel(time)}</span>
              {hidden > 0 && <span>· {hidden} hidden</span>}
              <button type="button" onClick={() => setTimeAndRun({ mode: 'any' })} className="inline-flex items-center gap-1 text-cobalt hover:underline">
                <X className="size-3.5" /> Any time
              </button>
            </p>
          )}

          <div className="mt-5 space-y-5">{tab === 'all' ? GROUPS.map((g) => (count(g.key) ? group(g.key, g.key === 'records' ? undefined : 4) : null)) : group(tab)}</div>

          {!kept.length && !card && (
            <EmptyState
              icon={SearchX}
              title={res.hits.length ? 'The time filter hides every result' : res.weak ? 'Nothing matches that well' : 'Nothing you can open matches'}
              className="mt-8"
              action={
                res.hits.length ? (
                  <button type="button" onClick={() => setTimeAndRun({ mode: 'any' })} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] text-white">
                    Show any time
                  </button>
                ) : (
                  <button type="button" onClick={askIt} className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] text-white">
                    <MessageCircleQuestion className="size-3.5" /> Ask it as a question
                  </button>
                )
              }
            >
              {res.hits.length ? `${res.hits.length} results exist outside “${timeLabel(time)}”.` : 'Try fewer or different words, a nickname, or a part number. Some files may be restricted for you.'}
            </EmptyState>
          )}
          <p className="mt-8 text-[11.5px] text-muted-foreground">{(res.timings.total_ms / 1000).toFixed(1)} s</p>
        </div>
      )}
      <SourceViewer source={open} onClose={() => setOpen(null)} />
    </div>
  )
}
