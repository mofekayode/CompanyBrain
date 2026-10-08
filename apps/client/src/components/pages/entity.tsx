'use client'

import { ArrowRight, FileText, Sparkles } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { kindIcon, SourceViewer, StatusPill, Timeline } from '@/components/answer/bits'
import { useSession } from '@/components/shell/session'
import { pushRecent } from '@/lib/recents'
import { EmptyState, SkeletonList } from '@/components/states'
import { Skeleton } from '@/components/ui/skeleton'
import { FileQuestion } from 'lucide-react'
import { getJSON, money, tenantApi } from '@/lib/api'
import type { BriefSource, PageFact } from '@/lib/types'
import { period } from '@/lib/text'
import { cn } from '@/lib/utils'

interface Entity {
  id: string
  name: string
  type: string
  description: string | null
  aliases: string[]
  identifiers: number
  properties: Record<string, string | number | boolean>
  facts: PageFact[]
  mentioned_in: (PageFact & { subject: string })[]
  connections: { rel: string; dir: 'in' | 'out'; other_type: string; n: number; sample: { id: string; name: string }[] }[]
  activity: { type: string; n: number; first: string | null; last: string | null }[]
  recent: { id: string; name: string; type: string; day: string | null; note: string | null; amount: string | null }[]
  money: { year: string; invoiced: number; invoices: number; paid: number }[]
  documents: { id: string; title: string; kind: string; snippet: string; file_id: string | null; citation: Record<string, unknown> }[]
}

const KIND_LABEL: Record<string, string> = {
  policy: 'Rules & policies',
  practice: 'How it’s really done',
  exception: 'Exceptions',
  risk: 'Risks',
  key_person: 'Who knows what',
  term: 'Terms',
  history: 'History',
  other: 'Other facts',
}
const BRIEF: Record<string, { skill: string; label: string }> = {
  Customer: { skill: 'customer_dossier', label: 'Prepare a customer dossier' },
  Person: { skill: 'key_person_audit', label: 'What depends on this person' },
  Asset: { skill: 'incident_investigation', label: 'Investigate its incidents' },
  Site: { skill: 'incident_investigation', label: 'Investigate incidents here' },
}
const KIND: Record<string, string> = { email_body: 'email', transcript_segment: 'interview', video_segment: 'video', image: 'photo', table: 'spreadsheet' }

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-white p-5">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      {hint && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function FactLine({ f }: { f: PageFact }) {
  return (
    <li className="py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-muted-foreground">{f.subject ? `${f.subject} · ${f.predicate}` : f.predicate}</p>
          <p className="text-[14px] leading-snug text-ink">{f.value}</p>
        </div>
        {f.status !== 'current' && <StatusPill status={f.status} />}
      </div>
      {f.timeline && <Timeline steps={f.timeline} className="mt-2" />}
      {!f.timeline && (f.from || f.to) && <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{period(f.from, f.to)}</p>}
    </li>
  )
}

/** Bars without a chart library: invoiced per year, paid as an inner bar. */
function MoneyBars({ rows }: { rows: Entity['money'] }) {
  const max = Math.max(...rows.map((r) => r.invoiced), 1)
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.year} className="grid grid-cols-[3rem_1fr_7rem] items-center gap-3 text-[12.5px]">
          <span className="font-mono text-muted-foreground">{r.year}</span>
          <div className="relative h-5 rounded bg-cobalt-soft">
            <div className="absolute inset-y-0 left-0 rounded bg-cobalt/25" style={{ width: `${(r.invoiced / max) * 100}%` }} />
            <div className="absolute inset-y-1 left-0 rounded bg-cobalt" style={{ width: `${(r.paid / max) * 100}%` }} />
          </div>
          <span className="text-right tabular-nums">{money(r.invoiced)}</span>
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">Light: invoiced · dark: paid · {rows.reduce((n, r) => n + r.invoices, 0).toLocaleString()} invoices</p>
    </div>
  )
}

/** What someone looking a record up most likely needs first. */
const PRIORITY = ['payment terms', 'role', 'title', 'account owner', 'branch manager', 'credit hold', 'discount', 'agreement term', 'markup', 'rate', 'relationship', 'contact']
const rank = (f: PageFact) => {
  const i = PRIORITY.findIndex((k) => f.predicate.includes(k))
  return i < 0 ? PRIORITY.length + (f.kind === 'risk' ? 5 : 0) : i
}
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'facts', label: 'Facts & history' },
  { key: 'connected', label: 'Connected' },
  { key: 'sources', label: 'Sources' },
] as const
type Tab = (typeof TABS)[number]['key']

function Facts({ items, empty }: { items: PageFact[]; empty?: string }) {
  if (!items.length) return empty ? <p className="text-[13px] text-muted-foreground">{empty}</p> : null
  return (
    <ul className="divide-y divide-border">
      {items.map((f) => (
        <FactLine key={f.id} f={f} />
      ))}
    </ul>
  )
}

export function EntityPage({ id }: { id: string }) {
  const { slug, me } = useSession()
  const [e, setE] = useState<Entity | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<BriefSource | null>(null)
  const [tab, setTabState] = useState<Tab>('overview')
  const setTab = (t: Tab) => {
    setTabState(t)
    const u = new URL(window.location.href)
    t === 'overview' ? u.searchParams.delete('tab') : u.searchParams.set('tab', t)
    window.history.replaceState(null, '', u)
  }
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null
    if (t && TABS.some((x) => x.key === t)) setTabState(t)
  }, [])
  useEffect(() => {
    setE(null)
    getJSON<Entity>(`${tenantApi(slug)}/app/entities/${encodeURIComponent(id)}?as=${me?.id ?? ''}`)
      .then((x: Entity) => {
        setE(x)
        pushRecent(slug, me?.id, { kind: 'entity', label: x.name, ref: x.id, detail: x.type })
      })
      .catch((x) => setError((x as Error).message))
  }, [slug, id, me?.id])

  if (error)
    return (
      <EmptyState icon={FileQuestion} title={error === 'not found' ? 'Nothing to show here' : 'This page didn’t load'} className="mt-16" action={<Link href={`/${slug}/search`} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] text-white">Search instead</Link>}>
        {error === 'not found' ? 'It doesn’t exist in the company record, or you don’t have access to it.' : error}
      </EmptyState>
    )
  if (!e)
    return (
      <div className="pt-10" aria-busy="true">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-3 h-9 w-2/3" />
        <Skeleton className="mt-3 h-4 w-1/3" />
        <div className="mt-6 flex gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 w-28 rounded-full" />
          ))}
        </div>
        <div className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_1fr]">
          <SkeletonList rows={3} />
          <SkeletonList rows={2} />
        </div>
      </div>
    )

  // Current / Changed / Superseded: one vocabulary for every fact.
  const current = e.facts.filter((f) => f.status !== 'outdated')
  const changed = current.filter((f) => f.timeline)
  const steady = current.filter((f) => !f.timeline)
  const superseded = e.facts.filter((f) => f.status === 'outdated')
  const truth = [...steady].sort((a, b) => rank(a) - rank(b))
  const risks = current.filter((f) => f.kind === 'risk' || f.status === 'disputed')
  const byKind = new Map<string, PageFact[]>()
  for (const f of steady) byKind.set(f.kind ?? 'other', [...(byKind.get(f.kind ?? 'other') ?? []), f])
  const brief = BRIEF[e.type]
  const counts: Record<Tab, number | null> = { overview: null, facts: e.facts.length, connected: e.connections.length + e.activity.length, sources: e.documents.length }

  return (
    <div className="pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <div className="eyebrow">{e.type}</div>
          <h1 className="mt-2 text-[34px] leading-tight font-semibold tracking-[-0.03em] text-ink">{e.name}</h1>
          {e.aliases.length > 0 && <p className="mt-1.5 text-[13.5px] text-muted-foreground">Also called {e.aliases.map((a) => `“${a}”`).join(', ')}</p>}
          {e.description && <p className="mt-2 text-[14.5px] leading-relaxed text-ink/80">{e.description}</p>}
        </div>
        <div className="flex gap-2">
          <Link href={`/${slug}/ask?q=${encodeURIComponent(`What should I know about ${e.name}?`)}`} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-white px-4 py-2 text-[13px] hover:border-cobalt">
            <Sparkles className="size-3.5 text-cobalt" /> Ask about it
          </Link>
          {brief && (
            <Link href={`/${slug}/briefs?skill=${brief.skill}&input=${encodeURIComponent(e.name)}`} className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-[13px] text-white">
              {brief.label} <ArrowRight className="size-3.5" />
            </Link>
          )}
        </div>
      </div>

      <nav className="mt-6 flex gap-1 border-b border-border" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn('-mb-px border-b-2 px-3 pb-2.5 text-[13.5px] transition-colors', tab === t.key ? 'border-ink font-medium text-ink' : 'border-transparent text-ink/60 hover:text-ink')}
          >
            {t.label}
            {counts[t.key] ? <span className="ml-1.5 text-[11.5px] text-muted-foreground">{counts[t.key]}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_1fr]">
          <div className="space-y-5">
            <Card title="Current truth" hint={`What is in force now. ${steady.length > 6 ? `${steady.length - 6} more under Facts & history.` : ''}`}>
              <Facts items={truth.slice(0, 6)} empty="No reviewed facts yet." />
              {steady.length > 6 && (
                <button type="button" onClick={() => setTab('facts')} className="mt-2 text-[12.5px] text-cobalt hover:underline">
                  All current facts
                </button>
              )}
            </Card>
            {changed.length > 0 && (
              <Card title="Changed" hint="In force now, replacing an earlier version.">
                <Facts items={changed.slice(0, 3)} />
                {changed.length > 3 && (
                  <button type="button" onClick={() => setTab('facts')} className="mt-2 text-[12.5px] text-cobalt hover:underline">
                    {changed.length - 3} more changes
                  </button>
                )}
              </Card>
            )}
            {risks.length > 0 && (
              <Card title="Risks">
                <Facts items={risks.slice(0, 3)} />
              </Card>
            )}
          </div>
          <div className="space-y-5">
            {e.money.length > 0 && (
              <Card title="Revenue by year">
                <MoneyBars rows={e.money} />
              </Card>
            )}
            {e.connections.length > 0 && (
              <Card title="Key relationships">
                <div className="space-y-2.5">
                  {e.connections
                    .filter((c) => c.n <= 20 || c.other_type === 'Person')
                    .slice(0, 4)
                    .map((c) => (
                      <div key={`${c.rel}-${c.dir}-${c.other_type}`}>
                        <p className="text-[11.5px] text-muted-foreground">
                          {c.other_type} · {c.rel.replaceAll('_', ' ')}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {c.sample.slice(0, 5).map((s) => (
                            <Link key={s.id} href={`/${slug}/e/${s.id}`} className="rounded-full border border-border px-2.5 py-0.5 text-[12px] hover:border-cobalt">
                              {s.name}
                            </Link>
                          ))}
                        </div>
                      </div>
                    ))}
                  <button type="button" onClick={() => setTab('connected')} className="text-[12.5px] text-cobalt hover:underline">
                    Everything connected
                  </button>
                </div>
              </Card>
            )}
            {e.recent.length > 0 && (
              <Card title="Recent activity">
                <ol className="space-y-2 border-l border-border pl-3">
                  {e.recent.slice(0, 3).map((r) => (
                    <li key={r.id} className="text-[12.5px]">
                      <span className="font-mono text-[11px] text-muted-foreground">{r.day}</span> · {r.name}
                      {r.note && <span className="block text-muted-foreground">{r.note.slice(0, 120)}</span>}
                    </li>
                  ))}
                </ol>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'facts' && (
        <div className="mt-6 space-y-5">
          {changed.length > 0 && (
            <Card title={`Changed (${changed.length})`} hint="In force now, replacing an earlier version. The history is under each.">
              <Facts items={changed} />
            </Card>
          )}
          {[...byKind.entries()].map(([k, fs]) => (
            <Card key={k} title={`${KIND_LABEL[k] ?? k} (${fs.length})`} hint="Current">
              <Facts items={fs} />
            </Card>
          ))}
          {superseded.length > 0 && (
            <Card title={`Superseded (${superseded.length})`} hint="No longer true. Kept for the record; answers about the past use these.">
              <Facts items={superseded} />
            </Card>
          )}
          {e.mentioned_in.length > 0 && (
            <Card title="Mentioned elsewhere">
              <Facts items={e.mentioned_in} />
            </Card>
          )}
        </div>
      )}

      {tab === 'connected' && (
        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          {e.connections.length > 0 && (
            <Card title="Connected to">
              <div className="space-y-3">
                {e.connections.map((c) => (
                  <div key={`${c.rel}-${c.dir}-${c.other_type}`}>
                    <p className="text-[11.5px] text-muted-foreground">
                      {c.other_type} · {c.rel.replaceAll('_', ' ')} · {c.n.toLocaleString()}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {c.sample.map((s) => (
                        <Link key={s.id} href={`/${slug}/e/${s.id}`} className="rounded-full border border-border px-2.5 py-0.5 text-[12px] hover:border-cobalt">
                          {s.name}
                        </Link>
                      ))}
                      {c.n > c.sample.length && <span className="px-1 text-[12px] text-muted-foreground">+{(c.n - c.sample.length).toLocaleString()} more</span>}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {e.activity.length > 0 && (
            <Card title="Activity in the systems">
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {e.activity.slice(0, 6).map((a) => (
                  <div key={a.type}>
                    <div className="text-[20px] font-semibold tabular-nums tracking-[-0.02em]">{a.n.toLocaleString()}</div>
                    <div className="eyebrow-muted">{a.type}s</div>
                  </div>
                ))}
              </div>
              {e.recent.length > 0 && (
                <ol className="mt-4 space-y-2 border-l border-border pl-3">
                  {e.recent.map((r) => (
                    <li key={r.id} className="text-[12.5px]">
                      <span className="font-mono text-[11px] text-muted-foreground">{r.day}</span> · {r.name}
                      {r.note && <span className="block text-muted-foreground">{r.note.slice(0, 140)}</span>}
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}
          {e.money.length > 0 && (
            <Card title="Revenue by year">
              <MoneyBars rows={e.money} />
            </Card>
          )}
          {!e.connections.length && !e.activity.length && <p className="text-[13px] text-muted-foreground">Nothing connected on record.</p>}
        </div>
      )}

      {tab === 'sources' && (
        <div className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_1fr]">
          <Card title="Documents and conversations">
            {e.documents.length ? (
              <ul className="space-y-1.5">
                {e.documents.map((d) => {
                  const Icon = kindIcon[KIND[d.kind] ?? 'document'] ?? FileText
                  return (
                    <li key={d.id}>
                      <button
                        onClick={() => setOpen({ n: 0, id: d.id, title: d.title, where: d.title, kind: KIND[d.kind] ?? 'document', status: 'supporting', file_id: d.file_id, start_ms: d.citation.start_ms != null ? Number(d.citation.start_ms) : null, quote: d.snippet })}
                        className="w-full rounded-lg border border-border px-3 py-2 text-left hover:border-cobalt/50"
                      >
                        <span className="flex items-center gap-1.5 text-[13px] font-medium">
                          <Icon className="size-3.5 text-muted-foreground" /> {d.title}
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-muted-foreground">{d.snippet}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">No documents you can open mention it.</p>
            )}
          </Card>
          {Object.keys(e.properties).length > 0 && (
            <Card title="As recorded in the systems" hint={`${e.identifiers} system records. Where these disagree with the facts, the facts are the reviewed version.`}>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
                {Object.entries(e.properties).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="truncate">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
        </div>
      )}
      <SourceViewer source={open} onClose={() => setOpen(null)} />
    </div>
  )
}
