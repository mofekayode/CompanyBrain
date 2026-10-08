'use client'

// Checks: the client's evidence-derived eval sets. Data checks (aliases, counts,
// timelines, links, who can open what) run in seconds with no AI; questions wait
// for search and are listed with the answer we expect and the files it rests on.

import { ChevronDown, CircleCheck, CircleX, FileText, Loader2, Play } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Card, PageBody, PageHeader, Pill, Section, Stat } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { API } from '@/lib/api'
import { cn } from '@/lib/utils'

interface EvalSet {
  id: string
  name: string
  description: string | null
  checks: number
  questions: number
  runs: { id: string; started_at: string; total: number; passed: number }[]
  latest: { total: number; passed: number; by_category: Record<string, { passed: number; total: number }> } | null
  results: { category: string; question: string; passed: boolean; detail: string; kind: string }[]
  question_items: { category: string; question: string; expected_answer: string | null; files: string[] }[]
}

const CATEGORY: Record<string, string> = {
  alias: 'Company language',
  aggregation: 'Counts',
  temporal: 'What changed',
  lookup: 'Facts',
  key_person: 'Key people',
  resolution: 'Relationships',
  permission: 'Access',
  exception: 'Policy vs practice',
  multi_hop: 'Joined-up answers',
  multimodal: 'Video & photos',
  unanswerable: 'Should say "not found"',
}
const label = (c: string) => CATEGORY[c] ?? c

export function ChecksPage({ slug }: { slug: string }) {
  const [sets, setSets] = useState<EvalSet[] | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const load = useCallback(() => {
    fetch(`${API}/api/t/${slug}/evals`)
      .then((r) => r.json())
      .then(setSets)
      .catch(() => setSets([]))
  }, [slug])
  useEffect(load, [load])

  const run = async (id: string) => {
    setRunning(id)
    await fetch(`${API}/api/t/${slug}/evals/${id}/run`, { method: 'POST' }).catch(() => {})
    setRunning(null)
    load()
  }

  return (
    <PageBody>
      <PageHeader eyebrow="Validate" title="Checks">
        Tests written from the company&apos;s own evidence, the way we&apos;d check a real handoff. Data checks prove the model is right: names resolve, timelines hold, people only open what
        they should. Questions are scored once search is in place.
      </PageHeader>
      {sets === null && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {sets?.length === 0 && (
        <Card className="p-6 text-[13px] text-muted-foreground">
          No eval set yet. Write one from the evidence (see the <span className="font-mono">evaluate-company-model</span> skill) and load it with{' '}
          <span className="font-mono">npm run eval-set</span>.
        </Card>
      )}
      {sets?.map((s) => (
        <SetView key={s.id} set={s} running={running === s.id} onRun={() => run(s.id)} />
      ))}
    </PageBody>
  )
}

function SetView({ set, running, onRun }: { set: EvalSet; running: boolean; onRun: () => void }) {
  const [showPassing, setShowPassing] = useState(false)
  const failing = set.results.filter((r) => !r.passed)
  const passing = set.results.filter((r) => r.passed)
  const latest = set.latest
  const allPass = latest && latest.total > 0 && latest.passed === latest.total
  return (
    <>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-xl">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold">{set.name}</h2>
              {latest ? <Pill tone={allPass ? 'verified' : 'stale'}>{allPass ? 'All passing' : `${latest.total - latest.passed} failing`}</Pill> : <Pill>Not run</Pill>}
            </div>
            {set.description && <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{set.description}</p>}
          </div>
          <Button size="sm" onClick={onRun} disabled={running}>
            {running ? <Loader2 className="animate-spin" /> : <Play />}
            Run data checks
          </Button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-6 border-t border-border pt-5 sm:grid-cols-4">
          <Stat value={latest ? `${latest.passed}/${latest.total}` : '–'} label="Data checks pass" tone={allPass ? 'verified' : latest ? 'stale' : undefined} />
          <Stat value={set.questions} label="Search questions" />
          <Stat value={set.runs.length} label="Runs kept" />
          <div>
            <div className="flex h-[33px] items-end gap-1">
              {[...set.runs].reverse().map((r) => (
                <span
                  key={r.id}
                  title={`${new Date(r.started_at).toLocaleString()} · ${r.passed}/${r.total}`}
                  className={cn('w-2 rounded-sm', r.passed === r.total ? 'bg-verified' : 'bg-stale')}
                  style={{ height: `${Math.max(18, (r.passed / Math.max(1, r.total)) * 100)}%` }}
                />
              ))}
            </div>
            <div className="eyebrow-muted mt-0.5">History</div>
          </div>
        </div>
        {latest && (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {Object.entries(latest.by_category).map(([c, v]) => (
              <span key={c} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11.5px]">
                {label(c)}
                <span className={cn('font-mono', v.passed === v.total ? 'text-verified' : 'text-stale')}>
                  {v.passed}/{v.total}
                </span>
              </span>
            ))}
          </div>
        )}
      </Card>

      <Section title="Data checks" hint={failing.length ? 'Failures first. Fix the data, not the expectation, unless the expectation was wrong.' : 'Every check passed on the latest run.'}>
        <Card className="divide-y divide-border">
          {failing.map((r) => (
            <ResultRow key={r.question} r={r} />
          ))}
          {!showPassing && passing.length > 0 && (
            <button type="button" onClick={() => setShowPassing(true)} className="flex w-full items-center gap-2 px-4 py-2.5 text-[12.5px] text-muted-foreground hover:text-foreground">
              <ChevronDown className="size-3.5" /> Show {passing.length} passing checks
            </button>
          )}
          {showPassing && passing.map((r) => <ResultRow key={r.question} r={r} />)}
          {set.results.length === 0 && <div className="px-4 py-3 text-[12.5px] text-muted-foreground">Run the checks to see results.</div>}
        </Card>
      </Section>

      <Section title="Search questions" hint="What a good answer must say, and the sources it should cite. Scored when search and answers exist.">
        <div className="grid gap-2">
          {set.question_items.map((q) => (
            <QuestionRow key={q.question} q={q} />
          ))}
        </div>
      </Section>
    </>
  )
}

function ResultRow({ r }: { r: EvalSet['results'][number] }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      {r.passed ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-verified" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-stale" />}
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{r.question}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={r.detail}>
          {r.detail}
        </div>
      </div>
      <Pill className="shrink-0">{label(r.category)}</Pill>
    </div>
  )
}

function QuestionRow({ q }: { q: EvalSet['question_items'][number] }) {
  const [open, setOpen] = useState(false)
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="min-w-0 flex-1 text-[13.5px]">{q.question}</span>
        <Pill tone={q.category === 'permission' ? 'stale' : 'cobalt'} className="shrink-0">
          {label(q.category)}
        </Pill>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-border bg-background/60 px-4 py-3">
          <div className="eyebrow">Expected answer</div>
          <p className="mt-1.5 text-[13px] leading-relaxed">{q.expected_answer}</p>
          {q.files.length > 0 && (
            <div className="mt-3 grid gap-1.5">
              {q.files.slice(0, 8).map((f, i) => (
                <div key={f} className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-1.5">
                  <span className="flex size-5 items-center justify-center rounded-full bg-cobalt-soft font-mono text-[10px] text-cobalt">{i + 1}</span>
                  <FileText className="size-3.5 text-muted-foreground" />
                  <span className="truncate font-mono text-[11.5px]">{f}</span>
                </div>
              ))}
              {q.files.length > 8 && <div className="font-mono text-[11px] text-muted-foreground">+ {q.files.length - 8} more sources</div>}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
