'use client'

// Briefs: one click from the record to a document you would otherwise spend a day on, // a customer dossier, who the business depends on, an incident investigation… Every line
// is cited and marked current, outdated or disputed, built only from what you can open.

import { ArrowRight, Check, Clock, Copy, FileDown, FileText, Link2, Loader2, Printer } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { StatusPill, Timeline } from '@/components/answer/bits'
import { DependencyGraph } from '@/components/answer/dependency-graph'
import { useSession } from '@/components/shell/session'
import { HowItWorks, SkeletonAnswer } from '@/components/states'
import { getJSON, tenantApi } from '@/lib/api'
import type { Step } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Spec {
  key: string
  name: string
  description: string
  input: 'entity' | 'topic' | 'person' | 'none'
  placeholder?: string
}
interface Item {
  text: string
  status?: 'current' | 'outdated' | 'disputed' | 'unknown' | 'flag'
  when?: string
  cites: number[]
  detail?: string
}
interface Report {
  skill: string
  subject: string | null
  title: string
  generated_at: string
  sections: { heading: string; hint?: string; items: Item[]; table?: { columns: string[]; rows: (string | number)[][] } }[]
  gaps: string[]
  sources: { n: number; title: string; where: string; kind: string }[]
}

/** When to reach for each brief, and what's in it (UI copy; the brief itself comes from the API). */
const GUIDE: Record<string, { when: string; get: string[]; ask: string }> = {
  customer_dossier: { when: 'Before a renewal, a pricing conversation or a first meeting with a customer.', get: ['Every name they go by, sites and contacts', 'Terms in force, and what changed (with dates)', 'Risks and open questions', 'Revenue by year and recent work', 'The contracts and conversations behind it'], ask: 'Which customer? Any name works, including nicknames.' },
  key_person_audit: { when: 'When someone is leaving, retiring or is the only one who can do something.', get: ['What only they know or hold', 'Who and what depends on them', 'Arrangements that exist because of them', 'When they leave, in their own words', 'A graph of all of it'], ask: 'Which person? Leave it empty to rank the whole company.' },
  transition_brief: { when: 'In the first weeks after the acquisition, to see what needs owners now.', get: ['The deal and its dates', 'Roles that changed', 'Approvals with no owner', 'People the business can’t lose', 'Customer concentration and conflicts to settle'], ask: 'Covers the whole company, just press Prepare.' },
  generate_sop: { when: 'When a task is done from memory and needs writing down, or training needs a source.', get: ['The rules that apply', 'How it is actually done', 'Steps from the documents and video', 'Exceptions', 'Outdated versions not to use'], ask: 'Which task? e.g. a lockout, closing out a job.' },
  customer_risk_review: { when: 'Monthly, or before forecasting revenue.', get: ['Customers with credit, margin, rebid or relationship risk', 'Ranked by what is at stake (last year’s revenue)', 'The facts behind each risk'], ask: 'Covers every customer, just press Prepare.' },
  pricing_leakage: { when: 'When margins look thin, or before a price increase.', get: ['Fees waived by habit', 'Discounts outside policy', 'Prices that never went up', 'Systems still billing old rates', 'Work that was never billed'], ask: 'Covers the whole company, just press Prepare.' },
  incident_investigation: { when: 'When equipment or a site keeps having the same problem.', get: ['Every failure on record', 'How the diagnosis changed', 'The fix and what it cost', 'Whether it has stopped', 'What people said, with photos and video'], ask: 'Which asset, site or customer?' },
  obsolete_knowledge: { when: 'Before training new hires or publishing procedures.', get: ['Rules replaced elsewhere', 'Drafts treated as final, wrong training material', 'Systems that disagree with the facts', 'What changed in the last 18 months'], ask: 'Covers the whole company, just press Prepare.' },
  training_plan: { when: 'When someone starts in a role.', get: ['Safety and non-negotiables', 'How the work is done here', 'Customer and site quirks', 'Who to learn from', 'Training material'], ask: 'Which role? e.g. technician, dispatcher.' },
  seller_interview_planner: { when: 'Before a session with someone whose knowledge is about to leave.', get: ['Conflicts to settle', 'Single-person knowledge to capture', 'Side arrangements to explain', 'Hearsay to confirm', 'Rules that may be outdated'], ask: 'Whose knowledge? Leave empty for everyone.' },
}

const steps = (line: string): Step[] => {
  const s = line.split(' → ').map((p) => {
    const m = p.match(/^(.*) \(([^()]*)\)$/)
    return m ? { value: m[1], when: m[2], current: false } : { value: p, when: '', current: false }
  })
  s[s.length - 1].current = true
  return s
}

export function Briefs({ initial }: { initial: { skill?: string; input?: string } }) {
  const { slug, me } = useSession()
  const [specs, setSpecs] = useState<Spec[]>([])
  const [examples, setExamples] = useState<Record<string, string[]>>({})
  const [copied, setCopied] = useState(false)
  const [key, setKey] = useState(initial.skill ?? 'customer_dossier')
  const [input, setInput] = useState(initial.input ?? '')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const spec = specs.find((s) => s.key === key)
  const article = useRef<HTMLElement>(null)
  const [shared, setShared] = useState(false)
  // Recent briefs (this browser, this person) and whether the how-to has been seen.
  const store = `cb.briefs.${slug}.${me?.id ?? 'anon'}`
  const [recent, setRecent] = useState<{ skill: string; input: string; title: string; at: number }[]>([])
  const [seen, setSeen] = useState(false)
  const [howOpen, setHowOpen] = useState(false)
  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(store) ?? '[]'))
      setSeen(localStorage.getItem('cb.briefs.seen') === '1')
    } catch {}
  }, [store])
  const remember = (r: Report, k: string, v: string) => {
    try {
      const next = [{ skill: k, input: v, title: r.title, at: Date.now() }, ...recent.filter((x) => !(x.skill === k && x.input.toLowerCase() === v.toLowerCase()))].slice(0, 8)
      setRecent(next)
      localStorage.setItem(store, JSON.stringify(next))
      localStorage.setItem('cb.briefs.seen', '1')
    } catch {}
  }
  const ago = (t: number) => {
    const d = Math.floor((Date.now() - t) / 864e5)
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  const body = (k: string, v: string) => JSON.stringify({ [specs.find((s) => s.key === k)?.input === 'topic' ? 'topic' : 'entity']: v || undefined, as: me?.id ?? null })
  const run = async (k = key, v = input) => {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`${tenantApi(slug)}/skills/${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(k, v) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error)
      setReport(j)
      remember(j, k, v)
      const u = new URL(window.location.href)
      u.searchParams.set('skill', k)
      v ? u.searchParams.set('input', v) : u.searchParams.delete('input')
      window.history.replaceState(null, '', u)
    } catch (e) {
      setError((e as Error).message)
      setReport(null)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    getJSON<Spec[]>(`${tenantApi(slug)}/skills`).then(setSpecs)
    getJSON<Record<string, string[]>>(`${tenantApi(slug)}/skills/examples`).then(setExamples).catch(() => {})
  }, [slug])
  useEffect(() => {
    if (specs.length && initial.skill) run(initial.skill, initial.input ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs.length, me?.id])

  const copy = async () => {
    const md = await fetch(`${tenantApi(slug)}/skills/${key}?format=md`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(key, input) }).then((r) => r.text())
    await navigator.clipboard.writeText(md)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const share = async () => {
    await navigator.clipboard.writeText(window.location.href)
    setShared(true)
    setTimeout(() => setShared(false), 1800)
  }
  /** Word opens HTML saved as .doc, keeping headings, lists and tables. */
  const exportWord = () => {
    if (!article.current || !report) return
    const html = `<html><head><meta charset="utf-8"><title>${report.title}</title></head><body style="font-family:Calibri,Arial,sans-serif">${article.current.innerHTML}</body></html>`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([html], { type: 'application/msword' }))
    a.download = `${report.title.replace(/[^\w\s-]/g, '').trim()}.doc`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="pt-10">
      <div className="eyebrow print:hidden">Briefs</div>
      <h1 className="mt-2 text-[34px] leading-tight font-semibold tracking-[-0.03em] print:hidden">A day of digging, in a minute.</h1>
      <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground print:hidden">A brief is a ready-made document for a job you’d otherwise spend a day on: it pulls together the facts, their history, the systems and the source files.</p>
      {/* The how-to shows until the first brief, then shrinks to a link. */}
      {seen && (
        <button type="button" onClick={() => setHowOpen((v) => !v)} className="mt-3 text-[12.5px] text-cobalt hover:underline print:hidden">
          {howOpen ? 'Hide how briefs work' : 'How briefs work'}
        </button>
      )}
      {recent.length > 0 && (
        <section className="mt-6 print:hidden">
          <div className="eyebrow-muted mb-2 flex items-center gap-1.5">
            <Clock className="size-3" /> Recent briefs
          </div>
          <div className="flex flex-wrap gap-1.5">
            {recent.map((r) => (
              <button
                key={r.skill + r.input}
                type="button"
                onClick={() => {
                  setKey(r.skill)
                  setInput(r.input)
                  run(r.skill, r.input)
                }}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-3 py-1 text-[12.5px] hover:border-cobalt"
              >
                {r.title} <span className="text-muted-foreground">· {ago(r.at)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {(!seen || howOpen) && <HowItWorks
        className="mt-6 print:hidden"
        steps={[
          { title: 'Pick a brief', body: 'Choose the job on the left: a customer dossier, who the business depends on, an incident…' },
          { title: 'Say who or what', body: 'Type a customer, person, asset, task or role (any name or nickname), or leave it empty where it covers the whole company.' },
          { title: 'Check and share', body: 'Every line is numbered to its source and marked if it’s outdated or disputed. Copy it, export it as PDF or Word, or share the link. It only uses files you can open.' },
        ]}
      />}

      <div className="mt-8 grid gap-8 lg:grid-cols-[270px_1fr] print:block">
        <nav className="space-y-1 print:hidden">
          {specs.map((s) => (
            <button
              key={s.key}
              onClick={() => {
                setKey(s.key)
                setInput('')
                setReport(null)
              }}
              className={cn('w-full rounded-xl px-3 py-2.5 text-left transition-colors', key === s.key ? 'bg-ink text-white' : 'hover:bg-white')}
            >
              <div className="text-[13.5px] font-medium">{s.name}</div>
              <div className={cn('mt-0.5 line-clamp-2 text-[11.5px] leading-snug', key === s.key ? 'text-white/70' : 'text-muted-foreground')}>{s.description}</div>
            </button>
          ))}
        </nav>

        <div className="min-w-0">
          {spec && GUIDE[spec.key] && (
            <div className="mb-3 print:hidden">
              <h2 className="text-[18px] font-semibold tracking-[-0.01em]">{spec.name}</h2>
              <p className="mt-0.5 text-[13.5px] text-muted-foreground">
                <span className="font-medium text-ink/80">Use it </span>
                {GUIDE[spec.key].when.replace(/^./, (c) => c.toLowerCase())}
              </p>
            </div>
          )}
          {spec && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                run()
              }}
              className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-white p-1.5 shadow-xs print:hidden"
            >
              {spec.input !== 'none' ? (
                <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={spec.placeholder} className="min-w-48 flex-1 bg-transparent px-3 text-[14px] outline-none" />
              ) : (
                <span className="flex-1 px-3 text-[14px] text-muted-foreground">{spec.name} for the whole company</span>
              )}
              <button className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-[13px] text-white" disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />} Prepare
              </button>
            </form>
          )}
          {spec && GUIDE[spec.key] && <p className="mt-2 text-[12.5px] text-muted-foreground print:hidden">{GUIDE[spec.key].ask}</p>}
          {spec && (examples[spec.key]?.length ?? 0) > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 print:hidden">
              <span className="text-[12px] text-muted-foreground">Try:</span>
              {examples[spec.key].map((x) => (
                <button
                  key={x || 'all'}
                  type="button"
                  onClick={() => {
                    setInput(x)
                    run(spec.key, x)
                  }}
                  className="rounded-full border border-border bg-white px-2.5 py-0.5 text-[12px] text-ink/80 hover:border-cobalt hover:text-cobalt"
                >
                  {x || 'Whole company'}
                </button>
              ))}
            </div>
          )}
          {error && <p className="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">{error}</p>}
          {busy && !report && (
            <div className="mt-8">
              <SkeletonAnswer label="Preparing, reading facts, their history, the systems and the files (can take up to half a minute)…" />
            </div>
          )}
          {!busy && !report && !error && spec && GUIDE[spec.key] && (
            <div className="mt-8 rounded-2xl border border-dashed border-border bg-white/60 p-5">
              <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
                <FileText className="size-4 text-cobalt" /> What you’ll get
              </p>
              <ul className="mt-3 grid gap-x-6 gap-y-1.5 text-[13.5px] text-ink/80 sm:grid-cols-2">
                {GUIDE[spec.key].get.map((g) => (
                  <li key={g} className="flex gap-2">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-cobalt" /> {g}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report && (
            <article ref={article} className={cn('mt-8 print:mt-0', busy && 'opacity-50')}>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-[24px] font-semibold tracking-[-0.02em]">{report.title}</h2>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {report.sources.length} sources · prepared for {me?.name} · {new Date(report.generated_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5 print:hidden">
                  <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-[12.5px]">
                    {copied ? <Check className="size-3.5 text-verified" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-[12.5px]" title="Save as PDF from the print dialog">
                    <Printer className="size-3.5" /> PDF
                  </button>
                  <button onClick={exportWord} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-[12.5px]">
                    <FileDown className="size-3.5" /> Word
                  </button>
                  <button onClick={share} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-[12.5px]">
                    {shared ? <Check className="size-3.5 text-verified" /> : <Link2 className="size-3.5" />} {shared ? 'Link copied' : 'Share link'}
                  </button>
                </div>
              </div>
              {report.skill === 'key_person_audit' && report.subject && (
                <div className="mt-6">
                  <DependencyGraph person={report.subject} sections={report.sections} />
                </div>
              )}
              {report.sections.map((s) => (
                <section key={s.heading} className="mt-6 rounded-2xl border border-border bg-white p-5">
                  <h3 className="text-[15px] font-semibold">{s.heading}</h3>
                  {s.hint && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{s.hint}</p>}
                  {s.table && (
                    <table className="mt-3 w-full text-[13px]">
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
                        {s.table.rows.map((r, i) => (
                          <tr key={i} className="border-b border-border/60 last:border-0">
                            {r.map((v, j) => (
                              <td key={j} className={cn('py-1.5 pr-4', j > 0 && 'tabular-nums')}>
                                {v}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <ul className="mt-3 space-y-3">
                    {s.items.map((it, i) => (
                      <li key={i} className="text-[14px] leading-relaxed">
                        <div className="flex items-start gap-2">
                          {it.status && it.status !== 'current' && <StatusPill status={it.status === 'flag' ? 'check' : it.status} className="mt-0.5" />}
                          <span className={cn(it.status === 'outdated' && 'text-muted-foreground')}>
                            {it.text}
                            {it.cites.map((n) => (
                              <a key={n} href={`#src-${n}`} className="ml-1 rounded bg-cobalt-soft px-1 font-mono text-[10px] text-cobalt">
                                {n}
                              </a>
                            ))}
                          </span>
                        </div>
                        {it.when && <p className="text-[11.5px] text-muted-foreground">{it.when}</p>}
                        {it.detail && (it.detail.includes(' → ') ? <Timeline steps={steps(it.detail)} className="mt-1.5" /> : <p className="mt-1 text-[12.5px] text-stale">{it.detail}</p>)}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {report.gaps.length > 0 && (
                <section className="mt-6 rounded-2xl border border-dashed border-border p-5">
                  <h3 className="text-[15px] font-semibold">Not on record yet</h3>
                  <ul className="mt-2 list-disc pl-5 text-[13px] text-muted-foreground">
                    {report.gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </section>
              )}
              <ol className="mt-8 space-y-1">
                <li className="eyebrow-muted mb-2">Sources</li>
                {report.sources.map((s) => (
                  <li key={s.n} id={`src-${s.n}`} className="flex gap-2 text-[12.5px] target:bg-cobalt-soft">
                    <span className="w-6 shrink-0 text-right font-mono text-[11px] text-cobalt">{s.n}</span>
                    <span>
                      <span className="font-medium">{s.title}</span> <span className="text-muted-foreground">· {s.where}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </article>
          )}
        </div>
      </div>
    </div>
  )
}
