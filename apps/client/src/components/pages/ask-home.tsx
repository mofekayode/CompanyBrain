'use client'

import { ChevronRight, Clock, History } from 'lucide-react'
import { EmptyState, SkeletonList } from '@/components/states'
import { Skeleton } from '@/components/ui/skeleton'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Omnibox } from '@/components/omni/omnibox'
import { type Recent, recentOf } from '@/lib/recents'
import { Timeline } from '@/components/answer/bits'
import { KeyHint } from '@/components/key-hint'
import { useSession } from '@/components/shell/session'
import { getJSON, money, tenantApi } from '@/lib/api'
import type { PageFact } from '@/lib/types'

interface Home {
  changed: (PageFact & { subject: string })[]
  top_customers: { id: string; name: string; total: number }[]
  asks: string[]
  discover: string[]
}

function Suggestion({ q, onAsk }: { q: string; onAsk: (q: string) => void }) {
  return (
    <button onClick={() => onAsk(q)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-white px-4 py-3 text-left text-[14px] transition-colors hover:border-ink/30">
      {q}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

export function AskHome() {
  const { slug, company, me } = useSession()
  const router = useRouter()
  const [home, setHome] = useState<Home | null>(null)
  useEffect(() => {
    setHome(null)
    getJSON<Home>(`${tenantApi(slug)}/app/home?as=${me?.id ?? ''}`).then(setHome).catch(() => {})
  }, [slug, me?.id])
  const ask = (q: string) => router.push(`/${slug}/ask?q=${encodeURIComponent(q)}`)
  const [recent, setRecent] = useState<Recent[]>([])
  useEffect(() => {
    const load = () => setRecent(recentOf(slug, me?.id, ['ask'], 5))
    load()
    window.addEventListener('cb-recents', load)
    return () => window.removeEventListener('cb-recents', load)
  }, [slug, me?.id])
  return (
    <div className="pt-14">
      <div className="eyebrow">{company}</div>
      <h1 className="mt-3 text-[40px] leading-[1.05] font-semibold tracking-[-0.035em] text-ink sm:text-[52px]">Ask the company.</h1>
      <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-muted-foreground text-pretty">
        Answers from the company’s own records, documents, email and interviews, with every source, what’s current and what changed. You see only what you have access to.
      </p>
      <div className="mt-8 max-w-3xl">
        <Omnibox mode="ask" onSubmit={ask} big autoFocus />
        <KeyHint id="ask" className="mt-2">↵ ask · ⇧↵ new line · ↑↓ pick a match · esc clear · ⌘K anywhere</KeyHint>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.1fr] [&>*]:min-w-0">
        <div className="space-y-8">
          {!home && (
            <section>
              <Skeleton className="mb-3 h-3 w-40" />
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-xl" />
                ))}
              </div>
            </section>
          )}
          {home && home.asks.length > 0 && (
            <section>
              <div className="eyebrow-muted mb-3">Answers you need now</div>
              <div className="space-y-2">
                {home.asks.map((q) => (
                  <Suggestion key={q} q={q} onAsk={ask} />
                ))}
              </div>
            </section>
          )}
          {home && (
            <section>
              <div className="eyebrow-muted mb-3">Questions worth asking</div>
              <div className="space-y-2">
                {home.discover.map((q) => (
                  <Suggestion key={q} q={q} onAsk={ask} />
                ))}
              </div>
            </section>
          )}
          {recent.length > 0 && (
            <section>
              <div className="eyebrow-muted mb-3 flex items-center gap-1.5">
                <Clock className="size-3" /> Recently asked
              </div>
              <div className="divide-y divide-border rounded-xl border border-border bg-white">
                {recent.map((r) => (
                  <button key={r.ref} type="button" onClick={() => ask(r.ref)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-[13.5px] hover:bg-paper">
                    <span className="truncate">{r.label}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </section>
          )}
          {home && home.top_customers.length > 0 && (
            <section>
              <div className="eyebrow-muted mb-3">Largest customers · last 12 months</div>
              <div className="divide-y divide-border rounded-xl border border-border bg-white">
                {home.top_customers.map((c) => (
                  <Link key={c.id} href={`/${slug}/e/${c.id}`} className="flex items-center justify-between px-4 py-2.5 text-[13.5px] hover:bg-paper">
                    {c.name}
                    <span className="font-mono text-[12px] text-muted-foreground tabular-nums">{money(c.total)}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>

        <section>
          <div className="eyebrow-muted mb-3 flex items-center gap-1.5">
            <History className="size-3" /> What changed recently
          </div>
          {!home ? (
            <SkeletonList rows={3} />
          ) : !home.changed.length ? (
            <EmptyState icon={History} title="No recent changes you can see">
              When a rule, price, owner or role changes, it shows up here with what it was before. Some changes may be in areas you don’t have access to.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {home.changed.map((f) => (
                <div key={f.id} className="rounded-xl border border-border bg-white p-4">
                  <p className="text-[12px] text-muted-foreground">
                    {f.subject} · {f.predicate}
                  </p>
                  <p className="mt-1 text-[14px] leading-snug font-medium text-ink">{f.value}</p>
                  {f.timeline && <Timeline steps={f.timeline} className="mt-3" />}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
