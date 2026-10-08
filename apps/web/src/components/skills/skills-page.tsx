'use client'

// Skills: repeatable workflows (a customer dossier, a key-person audit, an incident
// investigation…) that turn the company record into a cited report. Every line carries
// its status (Current / Outdated / Disputed / Unconfirmed) and numbered sources, and
// "View as" runs the skill as one person, so a report never shows what they can't read.

import { ArrowRight, Copy, Loader2, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Card, PageBody, PageHeader, Pill } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { API } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Spec {
  key: string
  name: string
  description: string
  input: 'entity' | 'topic' | 'person' | 'none'
  placeholder?: string
}
type Status = 'current' | 'outdated' | 'disputed' | 'unknown' | 'flag'
interface Item {
  text: string
  status?: Status
  when?: string
  cites: number[]
  detail?: string
}
interface Report {
  skill: string
  title: string
  subject: string | null
  generated_at: string
  sections: { heading: string; hint?: string; items: Item[]; table?: { columns: string[]; rows: (string | number)[][] } }[]
  gaps: string[]
  sources: { n: number; id: string; title: string; where: string; kind: string }[]
}

const STATUS: Record<Status, { text: string; tone: 'verified' | 'stale' | 'danger' | 'cobalt' | 'neutral' } | null> = {
  current: null,
  outdated: { text: 'Outdated', tone: 'stale' },
  disputed: { text: 'Disputed', tone: 'danger' },
  unknown: { text: 'Unconfirmed', tone: 'neutral' },
  flag: { text: 'Check', tone: 'stale' },
}


/** "Net 30 (Jul 2022 – Jun 2025) → Net 60 (since Jul 2025)" → chips, the last one current. */
function Timeline({ line }: { line: string }) {
  const steps = line.split(' → ').map((part) => {
    const m = part.match(/^(.*) \(([^()]*)\)$/)
    return m ? { value: m[1], when: m[2] } : { value: part, when: '' }
  })
  if (steps.length < 2) return <p className="mt-1 text-[12px] text-muted-foreground">{line}</p>
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {steps.map((st, i) => {
        const last = i === steps.length - 1
        return (
          <span key={`${st.value}-${i}`} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="h-px w-3 bg-border" />}
            <span className={cn('inline-flex items-baseline gap-1.5 rounded-md border px-2 py-0.5 text-[11.5px]', last ? 'border-cobalt/40 bg-cobalt-soft text-navy' : 'border-border bg-card text-muted-foreground')} title={st.value}>
              {st.when && <span className="font-mono text-[10px]">{st.when}</span>}
              <span className={cn('max-w-72 truncate', !last && 'line-through decoration-muted-foreground/60')}>{st.value}</span>
            </span>
          </span>
        )
      })}
    </div>
  )
}

function Cites({ ns, onPick }: { ns: number[]; onPick: (n: number) => void }) {
  return (
    <span className="ml-1 inline-flex gap-0.5 align-baseline">
      {ns.map((n) => (
        <button key={n} type="button" onClick={() => onPick(n)} className="rounded bg-cobalt-soft px-1 font-mono text-[10px] leading-4 text-cobalt hover:bg-cobalt hover:text-white">
          {n}
        </button>
      ))}
    </span>
  )
}

function ReportView({ r, onCopy }: { r: Report; onCopy: () => void }) {
  const [picked, setPicked] = useState<number | null>(null)
  const pick = (n: number) => {
    setPicked(n)
    document.getElementById(`src-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Report</div>
          <h2 className="mt-1 text-[21px] font-semibold tracking-[-0.02em]">{r.title}</h2>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {r.sections.length} sections · {r.sources.length} sources · {new Date(r.generated_at).toLocaleString()}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onCopy}>
          <Copy className="size-3.5" /> Copy as Markdown
        </Button>
      </div>

      {r.sections.map((s) => (
        <Card key={s.heading} className="mt-5 p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{s.heading}</h3>
          {s.hint && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{s.hint}</p>}
          {s.table && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left">
                    {s.table.columns.map((c) => (
                      <th key={c} className="eyebrow-muted py-1.5 pr-4 font-normal">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {s.table.rows.map((row, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                      {row.map((v, j) => (
                        <td key={j} className={cn('py-1.5 pr-4', j > 0 && 'tabular-nums')}>
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {s.items.length > 0 && (
            <ul className="mt-3 space-y-2.5">
              {s.items.map((it, i) => {
                const st = it.status ? STATUS[it.status] : null
                return (
                  <li key={i} className="border-l-2 border-border pl-3 text-[13.5px] leading-relaxed">
                    {st && (
                      <Pill tone={st.tone} className="mr-1.5 align-[1px]">
                        {st.text}
                      </Pill>
                    )}
                    <span className={cn(it.status === 'outdated' && 'text-muted-foreground')}>{it.text}</span>
                    <Cites ns={it.cites} onPick={pick} />
                    {it.when && <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{it.when}</div>}
                    {it.detail && (it.detail.includes(' → ') ? <Timeline line={it.detail} /> : <p className="mt-1 text-[12px] text-stale">{it.detail}</p>)}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      ))}

      {r.gaps.length > 0 && (
        <Card className="mt-5 border-dashed p-5">
          <h3 className="text-[15px] font-semibold">What the record can't tell us yet</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
            {r.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-8">
        <div className="eyebrow-muted mb-2">Sources</div>
        <ol className="space-y-1">
          {r.sources.map((s) => (
            <li key={s.n} id={`src-${s.n}`} className={cn('flex gap-2 rounded-md px-2 py-1 text-[12.5px] transition-colors', picked === s.n && 'bg-cobalt-soft')}>
              <span className="w-6 shrink-0 text-right font-mono text-[11px] text-cobalt">{s.n}</span>
              <span className="min-w-0">
                <span className="font-medium">{s.title}</span>
                <span className="text-muted-foreground"> · {s.where}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

export function SkillsPage({ slug }: { slug: string }) {
  const [specs, setSpecs] = useState<Spec[]>([])
  const [EXAMPLES, setExamples] = useState<Record<string, string[]>>({})
  const [key, setKey] = useState('customer_dossier')
  const [input, setInput] = useState('')
  const [as, setAs] = useState('')
  const [people, setPeople] = useState<{ id: string; name: string; title: string | null }[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ms, setMs] = useState<number | null>(null)
  const spec = specs.find((s) => s.key === key)

  const run = async (k = key, value = input, who = as) => {
    const sp = specs.find((s) => s.key === k)
    setBusy(true)
    setError(null)
    const t0 = performance.now()
    try {
      const res = await fetch(`${API}/api/t/${slug}/skills/${k}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [sp?.input === 'topic' ? 'topic' : 'entity']: value || undefined, as: who || null }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'failed')
      setReport(body)
      setMs(Math.round(performance.now() - t0))
      const u = new URL(window.location.href)
      u.searchParams.set('skill', k)
      value ? u.searchParams.set('input', value) : u.searchParams.delete('input')
      who ? u.searchParams.set('as', who) : u.searchParams.delete('as')
      window.history.replaceState(null, '', u)
    } catch (e) {
      setError((e as Error).message)
      setReport(null)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    fetch(`${API}/api/t/${slug}/skills`).then((r) => r.json()).then(setSpecs).catch(() => {})
    fetch(`${API}/api/t/${slug}/skills/examples`).then((r) => r.json()).then(setExamples).catch(() => {})
    fetch(`${API}/api/t/${slug}/search/people`).then((r) => r.json()).then(setPeople).catch(() => {})
  }, [slug])

  // Deep links: /skills?skill=customer_dossier&input=Big%20Blue&as=<principal>
  useEffect(() => {
    if (!specs.length) return
    const p = new URLSearchParams(window.location.search)
    const k = p.get('skill')
    if (k && specs.some((s) => s.key === k)) {
      setKey(k)
      setInput(p.get('input') ?? '')
      setAs(p.get('as') ?? '')
      run(k, p.get('input') ?? '', p.get('as') ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs])

  const choose = (k: string) => {
    setKey(k)
    setInput(EXAMPLES[k]?.[0] ?? '')
    setReport(null)
    setError(null)
  }

  const copy = async () => {
    const md = await fetch(`${API}/api/t/${slug}/skills/${key}?format=md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [spec?.input === 'topic' ? 'topic' : 'entity']: input || undefined, as: as || null }),
    }).then((r) => r.text())
    await navigator.clipboard.writeText(md)
  }

  return (
    <PageBody className="max-w-6xl">
      <PageHeader eyebrow="Skills" title="Turn the company record into a brief">
        Each skill runs a fixed workflow over facts, their history, work orders, money and the source files. Every line is cited and marked current, outdated or disputed. Run it as a person to see only what they could.
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <nav className="space-y-1">
          {specs.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => choose(s.key)}
              className={cn('w-full rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:bg-card', key === s.key && 'border-border bg-card shadow-xs')}
            >
              <div className={cn('text-[13px]', key === s.key ? 'font-medium' : 'text-foreground/85')}>{s.name}</div>
              <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{s.description}</div>
            </button>
          ))}
        </nav>

        <div className="min-w-0">
          {spec && (
            <Card className="p-4">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-cobalt" />
                <span className="text-[14px] font-semibold">{spec.name}</span>
              </div>
              <p className="mt-1 text-[12.5px] text-muted-foreground">{spec.description}</p>
              <form
                className="mt-3 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  run()
                }}
              >
                {spec.input !== 'none' && (
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={spec.placeholder}
                    className="h-9 min-w-56 flex-1 rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:border-cobalt"
                  />
                )}
                <select value={as} onChange={(e) => setAs(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-[13px]">
                  <option value="">View as: FDE (everything)</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      View as: {p.name}
                      {p.title ? ` · ${p.title}` : ''}
                    </option>
                  ))}
                </select>
                <Button type="submit" disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />} Run
                </Button>
              </form>
              {(EXAMPLES[spec.key]?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {EXAMPLES[spec.key].map((x) => (
                    <button
                      key={x || 'all'}
                      type="button"
                      onClick={() => {
                        setInput(x)
                        run(spec.key, x)
                      }}
                      className="rounded-full border border-border px-2.5 py-0.5 text-[11.5px] text-muted-foreground hover:border-cobalt hover:text-cobalt"
                    >
                      {x || 'Whole company'}
                    </button>
                  ))}
                </div>
              )}
            </Card>
          )}

          {error && <p className="mt-4 text-[13px] text-destructive">{error}</p>}
          {busy && !report && (
            <p className="mt-6 flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Reading the record…
            </p>
          )}
          {report && (
            <div className={cn('mt-6', busy && 'opacity-50')}>
              {ms !== null && <p className="mb-2 font-mono text-[10.5px] text-muted-foreground">{(ms / 1000).toFixed(1)} s</p>}
              <ReportView r={report} onCopy={copy} />
            </div>
          )}
        </div>
      </div>
    </PageBody>
  )
}
