'use client'

// Knowledge review (FDE): settle what the company model believes.
// Left: the queue (conflicts first). Main: one card per canonical fact, with its
// timeline, how sure we are, and the sources behind it (collapsed until needed).

import { Check, ChevronDown, CircleHelp, FileText, GitMerge, Loader2, Pencil, Play, ShieldAlert, X } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { API } from '@/lib/api'
import { cn } from '@/lib/utils'
import { typeColor } from '../model/colors'
import { FileViewer } from '../workbench/file-viewer'

type View = { kind: 'facts'; filter: 'conflicts' | 'to_review' | 'accepted' | 'history'; factKind?: string } | { kind: 'merges' } | { kind: 'vocabulary' } | { kind: 'relationships' }

interface Summary {
  conflicts: number
  to_review: number
  accepted: number
  history: number
  total: number
  merges: number
  claims: number
  by_kind: { kind: string; n: number; open: number }[]
}
interface Claim {
  id: string
  stance: 'supports' | 'contradicts' | 'context'
  predicate: string
  value: string | null
  authority: string
  certainty: string | null
  quote: string | null
  citation: string | null
  file_id: string | null
}
interface Fact {
  id: string
  predicate: string
  value: string | null
  valid_from: string | null
  valid_to: string | null
  status: string
  authority: string | null
  confidence: number | null
  kind: string | null
  agreement: string | null
  summary: string | null
  conflict_note: string | null
  subject_id: string
  subject: string
  subject_type: string
  previous_value: string | null
  previous_from: string | null
  note: string | null
  claims: Claim[]
}

const KIND_LABEL: Record<string, string> = {
  exception: 'Customer exceptions',
  risk: 'Risks',
  key_person: 'Key people',
  practice: 'How it’s really done',
  policy: 'Policies & rules',
  history: 'History & changes',
  other: 'Other',
}
const AUTH_LABEL: Record<string, string> = { system_of_record: 'system', document: 'document', official_document: 'document', email: 'email', interview: 'interview', video: 'video', photo: 'photo', fde: 'FDE' }
const d = (s: string | null) => (s ? String(s).slice(0, 10) : '')
/** Drops the AI's internal source codes ("(c3_3, c3_7)") from notes; the sources are listed on the card. */
const clean = (s: string | null) => (s ?? '').replace(/\s*\((?:\s*[cs]\d+_\d+\s*,?)+\)/g, '').replace(/\b[cs]\d+_\d+\b,?\s*/g, '').trim()

export function KnowledgeReview({ slug }: { slug: string }) {
  const base = `${API}/api/t/${slug}`
  const [summary, setSummary] = useState<Summary | null>(null)
  const [view, setView] = useState<View>({ kind: 'facts', filter: 'conflicts' })
  const [file, setFile] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // Deep link: ?view=relationships | merges | vocabulary
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('view')
    if (v === 'relationships' || v === 'merges' || v === 'vocabulary') setView({ kind: v })
  }, [])
  const loadSummary = useCallback(() => fetch(`${base}/knowledge`).then((r) => r.json()).then(setSummary), [base])
  useEffect(() => {
    loadSummary()
  }, [loadSummary])
  // Start on what needs attention: conflicts, else facts to review, else merges.
  useEffect(() => {
    if (!summary) return
    setView((v) => (v.kind === 'facts' && v.filter === 'conflicts' && !v.factKind && summary.conflicts === 0 ? (summary.to_review ? { kind: 'facts', filter: 'to_review' } : summary.merges ? { kind: 'merges' } : v) : v))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.total])

  async function read(scope: 'interviews' | 'official' | 'emails') {
    const r = await fetch(`${base}/model/knowledge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope }) }).then((x) => x.json())
    alert(`Reading ${r.files} files for facts and vocabulary. Follow it in Activity; then click “Re-group statements”.`)
  }

  async function canonicalize() {
    setRunning(true)
    await fetch(`${base}/model/canonical`, { method: 'POST' })
    alert('Grouping claims into canonical facts. Follow it in Activity (top right); refresh when it finishes.')
    setRunning(false)
  }

  const Item = ({ active, onClick, label, n, accent }: { active: boolean; onClick: () => void; label: string; n?: number; accent?: boolean }) => (
    <button onClick={onClick} className={cn('flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted', active && 'bg-muted font-medium')}>
      <span className="flex-1">{label}</span>
      {n !== undefined && <span className={cn('font-mono text-[11px] tabular-nums', accent && n > 0 ? 'font-semibold text-destructive' : 'text-muted-foreground')}>{n}</span>}
    </button>
  )
  const is = (v: View) => JSON.stringify(v) === JSON.stringify(view)

  return (
    <div className="grid h-full grid-cols-[15.5rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-border">
        <div className="space-y-0.5 overflow-auto p-3">
          <div className="px-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Needs a decision</div>
          <Item active={is({ kind: 'facts', filter: 'conflicts' })} onClick={() => setView({ kind: 'facts', filter: 'conflicts' })} label="Conflicts" n={summary?.conflicts} accent />
          <Item active={is({ kind: 'facts', filter: 'to_review' })} onClick={() => setView({ kind: 'facts', filter: 'to_review' })} label="Facts to review" n={summary?.to_review} />
          {summary?.by_kind
            .filter((k) => k.open > 0)
            .map((k) => (
              <div key={k.kind} className="pl-3">
                <Item active={is({ kind: 'facts', filter: 'to_review', factKind: k.kind })} onClick={() => setView({ kind: 'facts', filter: 'to_review', factKind: k.kind })} label={KIND_LABEL[k.kind] ?? k.kind} n={k.open} />
              </div>
            ))}
          <Item active={view.kind === 'merges'} onClick={() => setView({ kind: 'merges' })} label="Possible duplicates" n={summary?.merges} />
          <Item active={view.kind === 'relationships'} onClick={() => setView({ kind: 'relationships' })} label="Relationships" />
          <div className="px-2 pt-3 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Settled</div>
          <Item active={is({ kind: 'facts', filter: 'accepted' })} onClick={() => setView({ kind: 'facts', filter: 'accepted' })} label="Accepted" n={summary?.accepted} />
          <Item active={is({ kind: 'facts', filter: 'history' })} onClick={() => setView({ kind: 'facts', filter: 'history' })} label="History (superseded)" n={summary?.history} />
          <Item active={view.kind === 'vocabulary'} onClick={() => setView({ kind: 'vocabulary' })} label="Company vocabulary" />
        </div>
        <div className="mt-auto space-y-2 border-t border-border p-3 text-[10.5px] text-muted-foreground">
          <p>
            {summary ? `${summary.claims.toLocaleString()} statements from interviews and documents → ${summary.total.toLocaleString()} facts.` : ''} Sources rank: system → document → email → interview.
          </p>
          <div className="flex gap-1">
            <Button size="xs" variant="ghost" className="flex-1 px-1" onClick={() => read('interviews')}>
              + interviews
            </Button>
            <Button size="xs" variant="ghost" className="flex-1 px-1" onClick={() => read('official')}>
              + documents
            </Button>
            <Button size="xs" variant="ghost" className="flex-1 px-1" onClick={() => read('emails')}>
              + emails
            </Button>
          </div>
          <Button size="xs" variant="outline" className="w-full" onClick={canonicalize} disabled={running}>
            {running ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}
            Re-group statements
          </Button>
        </div>
      </aside>
      <main className="min-h-0 overflow-auto">
        {view.kind === 'facts' ? (
          <Facts base={base} slug={slug} filter={view.filter} factKind={view.factKind} onChanged={loadSummary} onOpenFile={setFile} />
        ) : view.kind === 'merges' ? (
          <Merges base={base} slug={slug} onChanged={loadSummary} />
        ) : view.kind === 'relationships' ? (
          <Relationships base={base} slug={slug} />
        ) : (
          <Vocabulary base={base} slug={slug} />
        )}
      </main>
      <FileViewer slug={slug} fileId={file} list={file ? [file] : []} onNavigate={setFile} onClose={() => setFile(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------

function Facts({ base, slug, filter, factKind, onChanged, onOpenFile }: { base: string; slug: string; filter: string; factKind?: string; onChanged: () => void; onOpenFile: (id: string) => void }) {
  const [facts, setFacts] = useState<Fact[] | null>(null)
  const [q, setQ] = useState('')
  const load = useCallback(async () => {
    setFacts(null)
    const p = new URLSearchParams({ filter, ...(factKind ? { kind: factKind } : {}), ...(q ? { q } : {}) })
    setFacts(await fetch(`${base}/knowledge/facts?${p}`).then((r) => r.json()))
  }, [base, filter, factKind, q])
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, q])

  async function review(id: string, body: Record<string, unknown>) {
    await fetch(`${base}/knowledge/facts/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    setFacts((fs) => fs?.filter((f) => f.id !== id) ?? null)
    onChanged()
  }

  const title = { conflicts: 'Conflicts: sources disagree', to_review: factKind ? (KIND_LABEL[factKind] ?? factKind) : 'Facts to review', accepted: 'Accepted facts', history: 'History: earlier values' }[filter]
  const hint = {
    conflicts: 'Pick the true value (Correct), accept the proposed one, or mark it unknown. The disagreeing sources are listed on each card.',
    to_review: 'Accept what is right, reject what is wrong, correct the rest. Each card shows how many independent sources back it.',
    accepted: 'What the company model now treats as known. Corrections create a new version; nothing is erased.',
    history: 'Values that were true for an earlier period, kept so questions like “what were Blue Ridge’s terms in 2024?” stay answerable.',
  }[filter]

  return (
    <div className="mx-auto max-w-4xl p-5">
      <div className="mb-4 flex items-end gap-3">
        <div className="flex-1">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by customer, person, topic…" className="h-8 w-64 text-xs" />
      </div>
      {!facts ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !facts.length ? (
        <p className="text-sm text-muted-foreground">Nothing here. {filter === 'conflicts' ? 'No open conflicts.' : ''}</p>
      ) : (
        <div className="space-y-3">
          {facts.map((f) => (
            <FactCard key={f.id} fact={f} slug={slug} editable={filter === 'conflicts' || filter === 'to_review'} onReview={(b) => review(f.id, b)} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  )
}

function FactCard({ fact: f, slug, editable, onReview, onOpenFile }: { fact: Fact; slug: string; editable: boolean; onReview: (b: Record<string, unknown>) => void; onOpenFile: (id: string) => void }) {
  const [open, setOpen] = useState(f.status === 'disputed')
  const [correcting, setCorrecting] = useState(false)
  const [value, setValue] = useState(f.value ?? '')
  const [from, setFrom] = useState(d(f.valid_from))
  const supports = f.claims.filter((c) => c.stance === 'supports')
  const contradicts = f.claims.filter((c) => c.stance === 'contradicts')
  const conf = Math.round((f.confidence ?? 0) * 100)
  return (
    <div className={cn('rounded-xl border bg-background', f.status === 'disputed' ? 'border-destructive/40' : 'border-border')}>
      <div className="p-4">
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <Link href={`/t/${slug}/model?focus=${f.subject_id}`} className="font-semibold hover:underline" style={{ color: typeColor(f.subject_type) }}>
            {f.subject}
          </Link>
          <span className="text-muted-foreground">{f.predicate.replace(/_/g, ' ')}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {f.status === 'disputed' && (
              <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                <ShieldAlert className="size-3" /> conflict
              </span>
            )}
            {f.agreement === 'agreed' && <span className="rounded-full bg-ok/15 px-2 py-0.5 text-ok">{supports.length} sources agree</span>}
            {f.agreement === 'single_source' && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">1 source</span>}
            {f.status === 'unknown' && <span className="rounded-full bg-warn/15 px-2 py-0.5">unknown</span>}
            <span className="rounded-full border border-border px-2 py-0.5">{AUTH_LABEL[f.authority ?? ''] ?? f.authority}</span>
            <span className="flex items-center gap-1 text-muted-foreground" title="confidence">
              <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
                <span className="block h-full bg-signal" style={{ width: `${conf}%` }} />
              </span>
              {conf}%
            </span>
          </span>
        </div>
        <p className="text-[14px] leading-snug">{clean(f.summary ?? f.value)}</p>
        {(f.previous_value || f.valid_from) && (
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            {f.previous_value ? (
              <>
                <span className="line-through">{f.previous_value}</span> → <b className="text-foreground">{f.value}</b>
              </>
            ) : (
              <b className="text-foreground">{f.value}</b>
            )}
            {f.valid_from ? ` since ${d(f.valid_from)}` : ''}
            {f.valid_to ? ` until ${d(f.valid_to)}` : ''}
          </p>
        )}
        {f.conflict_note && <p className="mt-1.5 rounded-md bg-destructive/5 px-2 py-1 text-[12px]">{clean(f.conflict_note)}</p>}
        {f.note && <p className="mt-1 text-[11.5px] text-muted-foreground italic">Note: {f.note}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
            {supports.length} supporting{contradicts.length ? ` · ${contradicts.length} contradicting` : ''}
          </button>
          {editable && !correcting && (
            <div className="ml-auto flex gap-1">
              <Button size="xs" onClick={() => onReview({ action: 'accept' })}>
                <Check data-icon="inline-start" /> Accept
              </Button>
              <Button size="xs" variant="outline" onClick={() => setCorrecting(true)}>
                <Pencil data-icon="inline-start" /> Correct
              </Button>
              <Button size="xs" variant="outline" onClick={() => onReview({ action: 'unknown' })}>
                <CircleHelp data-icon="inline-start" /> Unknown
              </Button>
              <Button size="xs" variant="ghost" onClick={() => onReview({ action: 'reject', note: prompt('Why is this wrong? (optional)') ?? undefined })}>
                <X data-icon="inline-start" /> Reject
              </Button>
            </div>
          )}
        </div>
        {correcting && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-2">
            <Input value={value} onChange={(e) => setValue(e.target.value)} className="h-7 min-w-64 flex-1 text-xs" placeholder="Correct value" />
            <Input value={from} onChange={(e) => setFrom(e.target.value)} className="h-7 w-32 text-xs" placeholder="since YYYY-MM-DD" />
            <Button size="xs" onClick={() => onReview({ action: 'correct', value, valid_from: from || null, note: 'corrected by FDE' })}>
              Save correction
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setCorrecting(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      {open && (
        <ul className="space-y-2 border-t border-border bg-muted/20 px-4 py-3">
          {[...contradicts, ...supports].map((c) => (
            <li key={c.id} className="text-[12px]">
              <div className="flex items-center gap-1.5">
                {c.stance === 'contradicts' ? <X className="size-3 text-destructive" /> : <Check className="size-3 text-ok" />}
                <span className="rounded border border-border px-1.5 text-[10.5px]">{AUTH_LABEL[c.authority] ?? c.authority}</span>
                <span className="text-muted-foreground">
                  {c.predicate.replace(/_/g, ' ')}: <span className="text-foreground">{c.value}</span>
                  {c.certainty && c.certainty !== 'stated' ? ` (${c.certainty})` : ''}
                </span>
              </div>
              {c.quote && <div className="mt-0.5 ml-4.5 border-l-2 border-border pl-2 text-muted-foreground italic">“{c.quote}”</div>}
              {c.citation &&
                (c.file_id ? (
                  <button onClick={() => onOpenFile(c.file_id!)} className="mt-0.5 ml-4.5 flex items-center gap-1 font-mono text-[10.5px] text-signal hover:underline">
                    <FileText className="size-3" /> {c.citation}
                  </button>
                ) : (
                  <div className="mt-0.5 ml-4.5 font-mono text-[10.5px] text-muted-foreground">{c.citation}</div>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface Pair {
  id: string
  why: string | null
  type: string
  a_id: string
  a_name: string
  a_props: Record<string, unknown>
  a_ids: string[]
  a_links: number
  b_id: string
  b_name: string
  b_props: Record<string, unknown>
  b_ids: string[]
  b_links: number
}

function Merges({ base, slug, onChanged }: { base: string; slug: string; onChanged: () => void }) {
  const [pairs, setPairs] = useState<Pair[] | null>(null)
  useEffect(() => {
    fetch(`${base}/knowledge/merges`)
      .then((r) => r.json())
      .then(setPairs)
  }, [base])
  async function decide(id: string, decision: 'merge' | 'separate') {
    await fetch(`${base}/knowledge/merges/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) })
    setPairs((ps) => ps?.filter((p) => p.id !== id) ?? null)
    onChanged()
  }
  const Side = ({ name, id, props, ids, links, type }: { name: string; id: string; props: Record<string, unknown>; ids: string[]; links: number; type: string }) => (
    <div className="min-w-0 flex-1 rounded-lg border border-border p-3">
      <Link href={`/t/${slug}/model?focus=${id}`} className="text-sm font-semibold hover:underline" style={{ color: typeColor(type) }}>
        {name}
      </Link>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {String(props.source_system ?? 'link')} · {links.toLocaleString()} links
      </div>
      <div className="mt-1 space-y-0.5 font-mono text-[10.5px] text-muted-foreground">
        {ids.slice(0, 3).map((i) => (
          <div key={i} className="truncate">
            {i}
          </div>
        ))}
        {Object.entries(props)
          .filter(([k, v]) => k !== 'source_system' && v)
          .slice(0, 3)
          .map(([k, v]) => (
            <div key={k} className="truncate">
              {k}: {String(v)}
            </div>
          ))}
      </div>
    </div>
  )
  return (
    <div className="mx-auto max-w-4xl p-5">
      <h2 className="text-base font-semibold">Possible duplicates</h2>
      <p className="mb-4 text-xs text-muted-foreground">Resolution was not sure these are the same thing. Merging keeps every name as an alias and moves all links; keeping them separate is remembered.</p>
      {!pairs ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !pairs.length ? (
        <p className="text-sm text-muted-foreground">No open pairs.</p>
      ) : (
        <div className="space-y-3">
          {pairs.map((p) => (
            <div key={p.id} className="rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center gap-2 text-[11px]">
                <span className="font-medium" style={{ color: typeColor(p.type) }}>
                  {p.type}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.why}</span>
              </div>
              <div className="flex gap-2">
                <Side name={p.a_name} id={p.a_id} props={p.a_props} ids={p.a_ids} links={p.a_links} type={p.type} />
                <Side name={p.b_name} id={p.b_id} props={p.b_props} ids={p.b_ids} links={p.b_links} type={p.type} />
              </div>
              <div className="mt-2 flex justify-end gap-1">
                <Button size="xs" onClick={() => decide(p.id, 'merge')}>
                  <GitMerge data-icon="inline-start" /> Same: merge
                </Button>
                <Button size="xs" variant="outline" onClick={() => decide(p.id, 'separate')}>
                  Different: keep separate
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Vocabulary({ base, slug }: { base: string; slug: string }) {
  const [terms, setTerms] = useState<{ id: string; term: string; meaning: string | null; refers_to: { id: string; name: string; type: string } | null; quote: string | null }[] | null>(null)
  useEffect(() => {
    fetch(`${base}/model/knowledge`)
      .then((r) => r.json())
      .then((d) => setTerms(d.terms))
  }, [base])
  return (
    <div className="mx-auto max-w-5xl p-5">
      <h2 className="text-base font-semibold">Company vocabulary</h2>
      <p className="mb-4 text-xs text-muted-foreground">How people at the company talk: jargon, nicknames and internal terms, and what they refer to.</p>
      {!terms ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {terms.map((t) => (
            <div key={t.id} className="rounded-lg border border-border p-3">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold">“{t.term}”</span>
                {t.refers_to && (
                  <Link href={`/t/${slug}/model?focus=${t.refers_to.id}`} className="text-[11px] hover:underline" style={{ color: typeColor(t.refers_to.type) }}>
                    → {t.refers_to.name}
                  </Link>
                )}
              </div>
              <div className="mt-0.5 text-xs">{t.meaning}</div>
              {t.quote && <div className="mt-1 text-[11px] text-muted-foreground italic">“{t.quote}”</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface Ref {
  id: string
  name: string
  type: string
}
interface RelIssue {
  kind: 'several_targets' | 'triangle'
  key: string
  title: string
  detail: string
  source: Ref
  links: { relationship_id: string; type: string; target: Ref; origin: string | null; valid_from: string | null }[]
}
interface RelReview {
  summary: { type: string; source_type: string; target_type: string; source_kind: string | null; total: number; candidate: number; accepted: number; rejected: number; origin: string | null }[]
  issues: RelIssue[]
  prose: { relationship_id: string; type: string; status: string; source: Ref; target: Ref; origin: string | null; why: string | null }[]
}

/** Exceptions to the link patterns the data itself shows, plus links read from prose. */
function Relationships({ base, slug }: { base: string; slug: string }) {
  const [data, setData] = useState<RelReview | null>(null)
  const [done, setDone] = useState<Record<string, string>>({})
  const [showTypes, setShowTypes] = useState(false)
  useEffect(() => {
    fetch(`${base}/knowledge/relationships`)
      .then((r) => r.json())
      .then(setData)
  }, [base])
  async function decide(id: string, action: 'accept' | 'reject' | 'end') {
    await fetch(`${base}/knowledge/relationships/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
    setDone((d) => ({ ...d, [id]: action === 'accept' ? 'kept' : action === 'reject' ? 'rejected' : 'ended' }))
  }
  const E = ({ r }: { r: Ref }) => (
    <Link href={`/t/${slug}/model?focus=${r.id}`} className="font-medium hover:underline" style={{ color: typeColor(r.type) }}>
      {r.name}
    </Link>
  )
  const Actions = ({ id }: { id: string }) =>
    done[id] ? (
      <span className="font-mono text-[10.5px] text-muted-foreground">{done[id]}</span>
    ) : (
      <span className="flex gap-1">
        <Button size="xs" variant="outline" onClick={() => decide(id, 'accept')} title="This link is right">
          <Check data-icon="inline-start" /> Right
        </Button>
        <Button size="xs" variant="outline" onClick={() => decide(id, 'end')} title="It was true, but no longer (ends it yesterday)">
          Ended
        </Button>
        <Button size="xs" variant="outline" onClick={() => decide(id, 'reject')} title="This link was never true">
          <X data-icon="inline-start" /> Wrong
        </Button>
      </span>
    )
  if (!data)
    return (
      <div className="mx-auto max-w-4xl p-5 text-sm text-muted-foreground">
        <Loader2 className="mr-1 inline size-4 animate-spin" /> Checking every link against the patterns in the data…
      </div>
    )
  // Group exceptions by the pattern they break.
  const groups = new Map<string, RelIssue[]>()
  for (const i of data.issues) {
    const g = i.kind === 'several_targets' ? `${i.source.type} with several “${i.links[0].type.replaceAll('_', ' ')}”` : i.detail.replace(/^.*?\(/, '').replace(/\).*$/, '') + ` · ${i.source.type}`
    groups.set(g, [...(groups.get(g) ?? []), i])
  }
  const total = data.summary.reduce((n, r) => n + r.total, 0)
  return (
    <div className="mx-auto max-w-4xl p-5">
      <h2 className="text-base font-semibold">Relationships</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        {total.toLocaleString()} links across {data.summary.length} kinds, almost all from system exports. Instead of reviewing them one by one, this shows the exceptions: links that are single in
        almost every record but doubled here, and chains that usually agree but don&apos;t. Mark each link right, ended (it was true once) or wrong, nothing is deleted.
      </p>

      <button onClick={() => setShowTypes((v) => !v)} className="mb-2 flex items-center gap-1 text-xs font-medium">
        <ChevronDown className={cn('size-3.5 transition-transform', !showTypes && '-rotate-90')} /> Link kinds
      </button>
      {showTypes && (
        <table className="mb-6 w-full text-[11.5px]">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">From</th>
              <th className="font-normal">Link</th>
              <th className="font-normal">To</th>
              <th className="text-right font-normal">Links</th>
              <th className="text-right font-normal">Kept / wrong</th>
              <th className="pl-3 font-normal">Origin</th>
            </tr>
          </thead>
          <tbody>
            {data.summary.map((r) => (
              <tr key={`${r.type}-${r.source_type}-${r.target_type}`} className="border-t border-border/60">
                <td className="py-1" style={{ color: typeColor(r.source_type) }}>
                  {r.source_type}
                </td>
                <td className="font-mono text-[10.5px]">{r.type}</td>
                <td style={{ color: typeColor(r.target_type) }}>{r.target_type}</td>
                <td className="text-right tabular-nums">{r.total.toLocaleString()}</td>
                <td className="text-right tabular-nums text-muted-foreground">
                  {r.accepted} / {r.rejected}
                </td>
                <td className="pl-3 text-muted-foreground">{r.origin ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="mt-4 mb-2 text-sm font-semibold">Exceptions to the pattern ({data.issues.length})</h3>
      <div className="space-y-4">
        {[...groups.entries()].map(([g, items]) => (
          <details key={g} open={items.length <= 12} className="rounded-xl border border-border">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs">
              <ShieldAlert className="size-3.5 text-stale" />
              <span className="flex-1 font-medium">{g}</span>
              <span className="font-mono text-muted-foreground">{items.length}</span>
            </summary>
            <div className="divide-y divide-border border-t border-border">
              {items.map((i) => (
                <div key={i.key} className="px-3 py-2.5">
                  <div className="text-[12.5px]">
                    <E r={i.source} />
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{i.detail}</div>
                  <div className="mt-1.5 space-y-1">
                    {i.links.map((l) => (
                      <div key={l.relationship_id} className="flex items-center gap-2 text-[12px]">
                        <span className="w-44 shrink-0 truncate font-mono text-[10.5px] text-muted-foreground">{l.type.replaceAll('_', ' ')}</span>
                        <span className="min-w-0 flex-1 truncate">
                          <E r={l.target} />
                          {l.valid_from && <span className="ml-1 font-mono text-[10px] text-muted-foreground">since {l.valid_from}</span>}
                          {l.origin && <span className="ml-1 text-[10px] text-muted-foreground">· {l.origin}</span>}
                        </span>
                        <Actions id={l.relationship_id} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>

      <h3 className="mt-8 mb-1 text-sm font-semibold">Links read from interviews and documents ({data.prose.length})</h3>
      <p className="mb-2 text-xs text-muted-foreground">Nicknames and jargon pointing at a customer, site or asset. These drive search: a wrong one sends questions to the wrong record.</p>
      <div className="divide-y divide-border rounded-xl border border-border">
        {data.prose.map((p) => (
          <div key={p.relationship_id} className="flex items-center gap-3 px-3 py-2 text-[12px]">
            <span className="min-w-0 flex-1">
              <span className="font-medium">“{p.source.name}”</span> <span className="text-muted-foreground">→</span> <E r={p.target} />
              {p.why && <span className="block truncate text-[11px] text-muted-foreground">{p.why}</span>}
            </span>
            <Actions id={p.relationship_id} />
          </div>
        ))}
      </div>
    </div>
  )
}
