'use client'

// Search: the FDE's view of company search. Results look like the answer sources on the
// site (numbered, with Current / Outdated / Disputed / Supports), and every result shows
// why it ranked: its BM25 rank, its vector rank and the fused position. "View as" runs
// the same search as one person, so access rules are visible, not assumed.

import { ArrowRight, AudioLines, Database, FileText, Image as ImageIcon, Loader2, Mail, MessagesSquare, Search, Sparkles, Table2, Video } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Card, PageBody, PageHeader, Pill } from '@/components/shell/page'
import { FileViewer } from '@/components/workbench/file-viewer'
import { Button } from '@/components/ui/button'
import { API } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Hit {
  id: string
  doc_type: 'passage' | 'entity' | 'fact'
  kind: string
  title: string
  snippet: string
  content: string
  path: string | null
  source_object_id?: string | null
  citation: Record<string, unknown>
  is_current: boolean
  valid_from: string | null
  valid_to: string | null
  authority: string | null
  ranks: { bm25: number | null; knn: number | null; fused: number; rerank?: number }
}
interface Result {
  understood: { entities: { name: string; type: string; matched: string }[]; asOf: string | null; preferCurrent: boolean; time?: { mode: string; reading: string; anchor_date?: string | null } }
  hits: Hit[]
  timings: Record<string, number>
  counts: { bm25: number; knn: number; fused: number }
}
interface Status {
  documents: { doc_type: string; kind: string; n: number; unindexed: number }[]
  pending_changes: number
  last_sync: { finished_at: string | null } | null
  answers_enabled: boolean
}

const FILTERS: { key: string; label: string; types?: string; kinds?: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'facts', label: 'Facts', types: 'fact' },
  { key: 'things', label: 'Customers, people, sites', types: 'entity' },
  { key: 'docs', label: 'Documents', kinds: 'text,ocr' },
  { key: 'email', label: 'Email', kinds: 'email_body' },
  { key: 'audio', label: 'Interviews', kinds: 'transcript_segment' },
  { key: 'video', label: 'Video & photos', kinds: 'video_segment,image' },
  { key: 'tables', label: 'Spreadsheets & exports', kinds: 'table' },
]

const EXAMPLES = ['Big Blue payment terms', 'who rebuilds the Kessler ZX pumps', 'Kentuckianna Plateing', 'current standard labor rate', 'Mill Creek dispatch fee', 'TP-17 seal leak']

function KindIcon({ hit }: { hit: Hit }) {
  const c = 'size-3.5 shrink-0 text-muted-foreground'
  if (hit.doc_type === 'fact') return <Sparkles className={c} />
  if (hit.doc_type === 'entity') return <Database className={c} />
  return (
    {
      email_body: <Mail className={c} />,
      transcript_segment: <AudioLines className={c} />,
      video_segment: <Video className={c} />,
      image: <ImageIcon className={c} />,
      table: <Table2 className={c} />,
    }[hit.kind] ?? <FileText className={c} />
  )
}

function where(h: Hit) {
  const c = h.citation
  const base = h.path?.split('/').pop() ?? (h.doc_type === 'fact' ? 'canonical fact' : 'company model')
  const t = (ms: unknown) => {
    const s = Math.floor(Number(ms) / 1000)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  if (c.start_ms != null) return `${base} · ${t(c.start_ms)}–${t(c.end_ms ?? c.start_ms)}`
  if (c.page_start) return `${base} · p. ${c.page_start}`
  if (c.row_start) return `${base} · rows ${c.row_start}–${c.row_end}`
  if (c.date) return `${base} · ${String(c.date).slice(0, 16)}`
  return base
}

/** "Net 30 (Jul 2022 – Jun 2025) → Net 60 (since Jul 2025)" → chips, oldest first; the last one is current. */
function timelineSteps(h: Hit): { value: string; when: string }[] {
  const line = h.content.split('\n').find((l) => l.startsWith('Timeline: '))
  if (!line) return []
  return line
    .slice(10)
    .split(' → ')
    .map((part) => {
      const m = part.match(/^(.*) \(([^()]*)\)$/)
      return m ? { value: m[1], when: m[2] } : { value: part, when: '' }
    })
}

function TimelineChips({ h }: { h: Hit }) {
  const steps = timelineSteps(h)
  if (steps.length < 2) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {steps.map((st, i) => {
        const last = i === steps.length - 1
        return (
          <span key={`${st.value}-${i}`} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="h-px w-3 bg-border" />}
            <span
              className={cn(
                'inline-flex items-baseline gap-1.5 rounded-md border px-2 py-0.5 text-[11.5px]',
                last ? 'border-cobalt/40 bg-cobalt-soft text-navy' : 'border-border bg-card text-muted-foreground',
              )}
              title={st.value}
            >
              <span className="font-mono text-[10px]">{st.when}</span>
              <span className={cn('max-w-56 truncate', !last && 'line-through decoration-muted-foreground/60')}>{st.value}</span>
            </span>
          </span>
        )
      })}
    </div>
  )
}

function label(h: Hit): { text: string; tone: 'verified' | 'stale' | 'neutral' | 'danger' } {
  if (h.doc_type === 'fact') {
    if (h.citation.status === 'disputed') return { text: 'Disputed', tone: 'danger' }
    return h.is_current ? { text: 'Current', tone: 'verified' } : { text: 'Outdated', tone: 'stale' }
  }
  return { text: h.doc_type === 'entity' ? 'Record' : 'Supports', tone: 'neutral' }
}

export function SearchPage({ slug }: { slug: string }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<{ id: string; ms: number | null } | null>(null)
  const [filter, setFilter] = useState('all')
  const [as, setAs] = useState('')
  const [rerank, setRerank] = useState(false)
  const [people, setPeople] = useState<{ id: string; name: string; title: string | null }[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [res, setRes] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch(`${API}/api/t/${slug}/search/people`).then((r) => r.json()).then(setPeople).catch(() => {})
    fetch(`${API}/api/t/${slug}/search/status`).then((r) => r.json()).then(setStatus).catch(() => {})
    input.current?.focus()
    // Deep links (demos, sharing): /search?q=…&as=<principal>&rerank=1
    const params = new URLSearchParams(window.location.search)
    const q0 = params.get('q')
    if (q0) {
      setQ(q0)
      setAs(params.get('as') ?? '')
      setRerank(params.get('rerank') === '1')
      run(q0, 'all', params.get('as') ?? '', params.get('rerank') === '1')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  const run = async (query = q, f = filter, who = as, rr = rerank) => {
    if (!query.trim()) return
    setBusy(true)
    setError(null)
    const fl = FILTERS.find((x) => x.key === f)
    const params = new URLSearchParams({ q: query, ...(who ? { as: who } : {}), ...(fl?.types ? { types: fl.types } : {}), ...(fl?.kinds ? { kinds: fl.kinds } : {}), ...(rr ? { rerank: '1' } : {}) })
    try {
      const r = await fetch(`${API}/api/t/${slug}/search?${params}`)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? 'search failed')
      setRes(body)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const total = status?.documents.reduce((n, d) => n + d.n, 0) ?? 0
  return (
    <PageBody className="max-w-6xl">
      <PageHeader eyebrow="Find" title="Search">
        Hybrid search over everything the company gave us: words and names (BM25) plus meaning (local embeddings), fused, with nicknames resolved and access enforced per person.
        {status && (
          <span className="mt-2 block font-mono text-[11.5px]">
            {total.toLocaleString()} documents indexed · {status.pending_changes} changes waiting
            {status.last_sync?.finished_at ? ` · last sync ${new Date(status.last_sync.finished_at).toLocaleTimeString()}` : ''}
          </span>
        )}
      </PageHeader>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          run()
        }}
        className="flex items-center gap-2 rounded-xl border border-border bg-card p-1.5 pl-3 shadow-xs focus-within:border-ring"
      >
        <Search className="size-4 text-muted-foreground" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask the company… e.g. what does Big Blue pay?" className="min-w-0 flex-1 bg-transparent py-1.5 text-[14px] outline-none" />
        <select
          value={as}
          onChange={(e) => {
            setAs(e.target.value)
            if (res) run(q, filter, e.target.value)
          }}
          className="max-w-48 rounded-md border border-border bg-background px-2 py-1 text-[12px]"
          title="Search as this person: only what they may open"
        >
          <option value="">View as: FDE (everything)</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.title ? ` · ${p.title}` : ''}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={busy || !q.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />} Search
        </Button>
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => {
              setFilter(f.key)
              if (res) run(q, f.key)
            }}
            className={cn('rounded-full border px-2.5 py-1 text-[12px] transition-colors', filter === f.key ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground')}
          >
            {f.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-muted-foreground" title="Re-score the top 40 with a cross-encoder (slower, sometimes sharper)">
          <input
            type="checkbox"
            checked={rerank}
            onChange={(e) => {
              setRerank(e.target.checked)
              if (res) run(q, filter, as, e.target.checked)
            }}
          />
          Rerank
        </label>
      </div>

      {!res && !busy && (
        <div className="mt-8">
          <div className="eyebrow-muted mb-2">Try</div>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => {
                  setQ(x)
                  run(x)
                }}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] hover:border-input"
              >
                {x}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && <Card className="mt-6 p-4 text-[13px] text-destructive">{error}</Card>}

      {res && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="eyebrow">
                {res.hits.length} results · {res.timings.total_ms} ms
              </span>
              {res.understood.entities.map((e) => (
                <span key={e.name} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-[12px]">
                  “{e.matched}” <span className="text-cobalt">→</span> {e.name}
                  <span className="text-muted-foreground">{e.type}</span>
                </span>
              ))}
            </div>
            <div className="grid gap-2">
              {res.hits.map((h, i) => {
                const l = label(h)
                return (
                  <Card key={h.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-cobalt-soft font-mono text-[10px] text-cobalt">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <KindIcon hit={h} />
                          {h.source_object_id ? (
                            <button
                              type="button"
                              onClick={() => setOpen({ id: h.source_object_id!, ms: h.citation.start_ms != null ? Number(h.citation.start_ms) : null })}
                              className="truncate text-left text-[13.5px] font-medium hover:text-cobalt hover:underline"
                              title="Open the file here"
                            >
                              {h.title}
                            </button>
                          ) : (
                            <span className="truncate text-[13.5px] font-medium">{h.title}</span>
                          )}
                          <Pill tone={l.tone} className="ml-auto shrink-0">
                            {l.text}
                          </Pill>
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {where(h)}
                          {h.valid_from || h.valid_to ? ` · valid ${h.valid_from ?? '…'} → ${h.valid_to ?? 'now'}` : ''}
                        </div>
                        <p className="mt-1.5 text-[12.5px] leading-relaxed text-foreground/85">
                          {h.snippet.split(/(«[^»]*»)/g).map((part, k) =>
                            part.startsWith('«') ? (
                              <mark key={k} className="rounded-sm bg-cobalt-soft px-0.5 text-navy">
                                {part.slice(1, -1)}
                              </mark>
                            ) : (
                              <span key={k}>{part}</span>
                            ),
                          )}
                        </p>
                        <TimelineChips h={h} />
                        <div className="mt-1.5 flex gap-3 font-mono text-[10.5px] text-muted-foreground">
                          <span title="Rank in the keyword (BM25) list">bm25 {h.ranks.bm25 ? `#${h.ranks.bm25}` : '-'}</span>
                          <span title="Rank in the vector (meaning) list">vector {h.ranks.knn ? `#${h.ranks.knn}` : '-'}</span>
                          {h.ranks.rerank !== undefined && <span>rerank {h.ranks.rerank.toFixed(2)}</span>}
                        </div>
                      </div>
                    </div>
                  </Card>
                )
              })}
              {res.hits.length === 0 && <Card className="p-5 text-[13px] text-muted-foreground">Nothing found{as ? ' that this person can open' : ''}.</Card>}
            </div>
          </div>

          <aside className="space-y-4">
            <Card className="p-4">
              <div className="eyebrow-muted">How this was found</div>
              <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1 text-[12px]">
                <dt className="text-muted-foreground">Keyword (BM25) hits</dt>
                <dd className="font-mono">{res.counts.bm25}</dd>
                <dt className="text-muted-foreground">Vector (kNN) hits</dt>
                <dd className="font-mono">{res.counts.knn}</dd>
                <dt className="text-muted-foreground">Fused (RRF)</dt>
                <dd className="font-mono">{res.counts.fused}</dd>
                {Object.entries(res.timings).map(([k, v]) => (
                  <Fragment key={k}>
                    <dt className="text-muted-foreground">
                      {k.replace('_ms', '').replace('_', ' ')}
                    </dt>
                    <dd className="font-mono">{v} ms</dd>
                  </Fragment>
                ))}
              </dl>
              {res.understood.time?.reading && (
                <p className="mt-2 text-[12px]">
                  Time: <span className="font-medium">{res.understood.time.reading}</span>
                  {res.understood.asOf ? ` → facts as of ${res.understood.asOf}` : res.understood.time.mode === 'change' ? ' → showing history' : ''}
                </p>
              )}
            </Card>
            {status && (
              <Card className="p-4">
                <div className="eyebrow-muted">Index</div>
                <div className="mt-2 grid gap-1 text-[12px]">
                  {status.documents.map((d) => (
                    <div key={`${d.doc_type}-${d.kind}`} className="flex justify-between gap-2">
                      <span className="truncate text-muted-foreground">
                        {d.doc_type === 'passage' ? d.kind.replace('_', ' ') : `${d.doc_type}: ${d.kind}`}
                      </span>
                      <span className="font-mono">{d.n.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            <Card className="p-4 text-[12px] leading-relaxed text-muted-foreground">
              <MessagesSquare className="mb-1.5 size-4" />
              {status?.answers_enabled ? 'Answers are on: ask in plain language from the workbench.' : 'Answers need the Claude API (off: no spend). Search, facts and the context an answer would use all work.'}
            </Card>
          </aside>
        </div>
      )}
      <FileViewer slug={slug} fileId={open?.id ?? null} list={open ? [open.id] : []} onNavigate={(id) => setOpen({ id, ms: null })} onClose={() => setOpen(null)} seekMs={open?.ms} />
    </PageBody>
  )
}
