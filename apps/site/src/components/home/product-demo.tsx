'use client'

import { useState } from 'react'
import {
  Search,
  MessageSquareText,
  Building2,
  Users,
  FolderOpen,
  ChevronsUpDown,
  ArrowUpRight,
  CornerDownLeft,
} from 'lucide-react'
import { answers } from '@/lib/answers'
import { customers, people, recent, search, sources, sourceTotals, type DemoCustomer } from '@/lib/demo'
import { cn } from '@/lib/utils'
import { AnswerCard, kindIcon } from './answer-card'

type View = 'ask' | 'search' | 'customers' | 'people' | 'sources'

const nav: { id: View; icon: typeof Search; label: string }[] = [
  { id: 'ask', icon: MessageSquareText, label: 'Ask' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'customers', icon: Building2, label: 'Customers' },
  { id: 'people', icon: Users, label: 'People' },
  { id: 'sources', icon: FolderOpen, label: 'Sources' },
]

const label = 'font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase'

/**
 * Clickable product mock: shown until the hero video is ready.
 * Planned swap: once the product is built, replace this with a live, playable demo
 * (visitors type questions against the demo company and get real cited answers).
 */
export function ProductDemo() {
  const [view, setView] = useState<View>('ask')
  const [answerId, setAnswerId] = useState(answers[0].id)
  const answer = answers.find((a) => a.id === answerId) ?? answers[0]
  const railCustomer = customers.find((c) => c.answerId === answer.id)
  const showRail = view === 'ask'

  const ask = (id: string) => {
    setAnswerId(id)
    setView('ask')
  }

  return (
    <div className="overflow-hidden rounded-xl border border-ink/10 bg-white text-left shadow-2xl shadow-navy/10">
      <div className="flex h-10 items-center gap-2 border-b border-border bg-paper/60 px-4">
        <span className="size-2.5 rounded-full bg-ink/10" />
        <span className="size-2.5 rounded-full bg-ink/10" />
        <span className="size-2.5 rounded-full bg-ink/10" />
        <span className="ml-3 truncate font-mono text-[11px] text-muted-foreground">Company Brain · Demo company</span>
      </div>

      <div className="grid grid-cols-1 md:h-[600px] md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[200px_minmax(0,1fr)_260px]">
        <aside className="hidden overflow-y-auto border-r border-border bg-paper/40 p-3 md:block">
          <div className="flex items-center gap-2 rounded-full border border-border bg-white py-1 pr-2.5 pl-1">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-cobalt to-navy text-[11px] font-semibold text-white">
              R
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">Riverton</span>
            <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
          </div>
          <nav className="mt-4 space-y-0.5">
            {nav.map(({ id, icon: Icon, label: text }) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                aria-current={view === id ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                  view === id
                    ? 'bg-white font-medium text-ink shadow-[0_0_0_1px_var(--border)]'
                    : 'text-muted-foreground hover:bg-white/70 hover:text-ink',
                )}
              >
                <Icon className="size-3.5" />
                {text}
              </button>
            ))}
          </nav>
          <p className={cn(label, 'mt-6 px-2.5')}>Recent</p>
          <ul className="mt-1.5 space-y-0.5">
            {recent.map((r) => (
              <li key={r.label}>
                <button
                  type="button"
                  onClick={() => ask(r.answerId)}
                  className={cn(
                    'w-full truncate rounded-md px-2.5 py-1 text-left text-[12.5px] transition-colors hover:bg-white/70 hover:text-ink',
                    view === 'ask' && answerId === r.answerId ? 'text-ink' : 'text-muted-foreground',
                  )}
                >
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className={cn('min-w-0 overflow-y-auto', !showRail && 'lg:col-span-2')}>
          {/* Phone: the sidebar becomes a tab row */}
          <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2 md:hidden">
            {nav.map(({ id, label: text }) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={cn(
                  'shrink-0 rounded-full px-3 py-1 text-[12.5px]',
                  view === id ? 'bg-ink text-white' : 'text-muted-foreground',
                )}
              >
                {text}
              </button>
            ))}
          </div>

          <div key={view + answerId} className="animate-in fade-in p-5 duration-300 sm:p-7">
            {view === 'ask' && (
              <>
                <AnswerCard answer={answer} />
                <p className={cn(label, 'mt-7 mb-2')}>Try asking</p>
                <div className="flex flex-wrap gap-1.5">
                  {answers
                    .filter((a) => a.id !== answer.id)
                    .map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => ask(a.id)}
                        className="rounded-full border border-border bg-white px-3 py-1.5 text-left text-[12.5px] text-ink/80 transition-colors hover:border-cobalt/40 hover:bg-cobalt-soft hover:text-navy"
                      >
                        {a.question}
                      </button>
                    ))}
                </div>
              </>
            )}

            {view === 'search' && <SearchView onOpen={ask} />}
            {view === 'customers' && <CustomersView onOpen={ask} />}
            {view === 'people' && <PeopleView onOpen={ask} />}
            {view === 'sources' && <SourcesView />}
          </div>
        </div>

        {showRail && (
          <aside className="hidden overflow-y-auto border-l border-border bg-paper/40 p-5 lg:block">
            {railCustomer ? <CustomerRail c={railCustomer} /> : <SourcesRail cited={answer.citations.length} />}
          </aside>
        )}
      </div>
    </div>
  )
}

function SearchView({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <div>
      <div className="flex items-center gap-2.5 rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 shadow-sm">
        <Search className="size-4 text-muted-foreground" />
        <span className="text-[14px]">{search.query}</span>
        <span className="ml-auto hidden items-center gap-1 font-mono text-[10.5px] text-muted-foreground sm:flex">
          <CornerDownLeft className="size-3" /> enter
        </span>
      </div>
      <p className="mt-3 text-[12.5px] text-muted-foreground">
        Showing results for <span className="font-medium text-ink">{search.resolved}</span> · also searched{' '}
        {search.alsoSearched.map((s) => `“${s}”`).join(', ')}
      </p>
      <ul className="mt-5 space-y-2">
        {search.hits.map((h) => {
          const Icon = h.kind === 'customer' ? Building2 : kindIcon[h.kind]
          return (
            <li key={h.title}>
              <button
                type="button"
                onClick={() => onOpen('waivers')}
                className="flex w-full items-start gap-3 rounded-lg border border-border bg-white px-3.5 py-3 text-left transition-colors hover:border-ink/25"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{h.title}</span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{h.detail}</span>
                </span>
                <span className="shrink-0 rounded bg-cobalt-soft px-1.5 py-0.5 font-mono text-[10.5px] text-navy">{h.match}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CustomersView({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <div>
      <p className={label}>Customers · names merged across systems</p>
      <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-white">
        {customers.map((c) => (
          <li key={c.name}>
            <button
              type="button"
              onClick={() => c.answerId && onOpen(c.answerId)}
              className="group flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-paper/60"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">{c.name}</span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {c.aliases.map((a) => (
                    <span key={a} className="rounded border border-border bg-paper/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                      {a}
                    </span>
                  ))}
                </span>
                <span className={cn('mt-1.5 block text-[12.5px]', c.tone === 'stale' ? 'text-stale' : 'text-muted-foreground')}>
                  {c.note}
                </span>
              </span>
              <ArrowUpRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PeopleView({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <div>
      <p className={label}>People the business depends on</p>
      <ul className="mt-4 space-y-2">
        {people.map((p) => (
          <li key={p.name}>
            <button
              type="button"
              onClick={() => p.answerId && onOpen(p.answerId)}
              disabled={!p.answerId}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-white px-3.5 py-3 text-left transition-colors enabled:hover:border-ink/25"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-paper text-[12px] font-semibold text-ink">
                {p.name[0]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">
                  {p.name} <span className="font-normal text-muted-foreground">· {p.role}</span>
                </span>
                <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{p.knows}</span>
              </span>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                  p.risk === 'high' ? 'bg-stale-soft text-stale' : 'bg-muted text-muted-foreground',
                )}
              >
                {p.risk === 'high' ? 'Single point' : 'Watch'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SourcesView() {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className={label}>Collected from the handoff</p>
        <p className="font-mono text-[11px] text-muted-foreground">{sourceTotals}</p>
      </div>
      <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-white">
        {sources.map((s) => {
          const Icon = kindIcon[s.kind]
          return (
            <li key={s.name} className="flex items-center gap-3 px-4 py-3">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">{s.name}</span>
                <span className="block text-[12px] text-muted-foreground">{s.detail}</span>
              </span>
              <span className="shrink-0 rounded-full bg-verified-soft px-2 py-0.5 text-[10.5px] font-medium text-verified">Indexed</span>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-[12px] text-muted-foreground">Every original is kept untouched. Every answer points back to one.</p>
    </div>
  )
}

function CustomerRail({ c }: { c: DemoCustomer }) {
  return (
    <>
      <p className={label}>Customer</p>
      <p className="mt-1.5 text-[15px] font-semibold tracking-[-0.01em]">{c.name}</p>
      <p className="mt-3 text-[11.5px] text-muted-foreground">Also known as</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {c.aliases.map((a) => (
          <span key={a} className="rounded border border-border bg-white px-1.5 py-0.5 text-[11px]">
            {a}
          </span>
        ))}
      </div>
      {c.facts && (
        <dl className="mt-5 space-y-2.5 text-[12.5px]">
          {c.facts.map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {c.owner && (
        <div className="mt-5 rounded-lg border border-border bg-white p-3">
          <p className="text-[11.5px] text-muted-foreground">Relationship owner</p>
          <p className="mt-1 text-[12.5px]">
            <span className="text-muted-foreground line-through">On paper: {c.owner.onPaper}</span>
            <br />
            <span className="font-medium">In practice: {c.owner.inPractice}</span>
          </p>
        </div>
      )}
    </>
  )
}

function SourcesRail({ cited }: { cited: number }) {
  return (
    <>
      <p className={label}>How this was answered</p>
      <ul className="mt-3 space-y-2.5 text-[12.5px]">
        <li className="flex justify-between">
          <span className="text-muted-foreground">Passages searched</span>
          <span className="font-medium">7.7k</span>
        </li>
        <li className="flex justify-between">
          <span className="text-muted-foreground">Sources cited</span>
          <span className="font-medium">{cited}</span>
        </li>
        <li className="flex justify-between">
          <span className="text-muted-foreground">Restricted files used</span>
          <span className="font-medium">0</span>
        </li>
      </ul>
      <div className="mt-5 rounded-lg border border-border bg-white p-3 text-[12px] leading-relaxed text-muted-foreground">
        Answers only draw on files the person asking is allowed to see.
      </div>
    </>
  )
}
