'use client'

import { Check, ChevronRight, Circle, CircleDashed, FileText, Sparkles, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { QuestionRow } from './types'

const STATUS: Record<string, { label: string; className: string; icon: typeof Circle }> = {
  open: { label: 'Open', className: 'text-muted-foreground', icon: CircleDashed },
  hypothesis: { label: 'Hypothesis', className: 'text-signal', icon: Sparkles },
  confirmed: { label: 'Confirmed', className: 'text-ok', icon: Check },
  rejected: { label: 'Rejected', className: 'text-destructive', icon: X },
}

export function QuestionsPanel(props: {
  questions: QuestionRow[]
  busy: boolean
  onAsk: (q: QuestionRow) => void
  onReview: (findingId: string, status: 'confirmed' | 'rejected' | 'hypothesis') => void
  onOpenFile: (id: string, list?: string[]) => void
  onHoverEvidence: (ids: string[]) => void
}) {
  const answered = props.questions.filter((q) => q.status && q.status !== 'rejected').length
  const confirmed = props.questions.filter((q) => q.status === 'confirmed').length
  const total = props.questions.length || 1
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-border px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Source discovery</h2>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {answered}/{props.questions.length}
          </span>
        </div>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="bg-ok transition-all" style={{ width: `${(confirmed / total) * 100}%` }} />
          <div className="bg-signal transition-all" style={{ width: `${((answered - confirmed) / total) * 100}%` }} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {confirmed} confirmed · {answered - confirmed} awaiting review · {props.questions.length - answered} open
        </p>
      </div>
      <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {props.questions.map((q) => (
          <QuestionCard key={q.id} q={q} {...props} />
        ))}
      </ol>
    </div>
  )
}

function QuestionCard({ q, busy, onAsk, onReview, onOpenFile, onHoverEvidence }: { q: QuestionRow } & Parameters<typeof QuestionsPanel>[0]) {
  const s = STATUS[q.status ?? 'open']
  const Icon = s.icon
  return (
    <li onMouseEnter={() => onHoverEvidence(q.evidence.map((e) => e.id))} onMouseLeave={() => onHoverEvidence([])}>
      <Collapsible>
        <div className={cn('rounded-xl border bg-card transition-colors', q.status === 'hypothesis' ? 'border-signal/30' : 'border-border')}>
          <CollapsibleTrigger className="group flex w-full items-start gap-2.5 px-3 py-2.5 text-left">
            <span className="mt-px font-mono text-[10px] text-muted-foreground tabular-nums">{String(q.ordinal).padStart(2, '0')}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-snug font-medium">{q.question}</span>
              <span className={cn('mt-1 inline-flex items-center gap-1 text-[11px]', s.className)}>
                <Icon className="size-3" />
                {s.label}
                {q.status && q.evidence.length > 0 && <span className="text-muted-foreground">· {q.evidence.length} file{q.evidence.length === 1 ? '' : 's'}</span>}
                {q.confidence && <span className="text-muted-foreground">· {Math.round(Number(q.confidence) * 100)}%</span>}
              </span>
            </span>
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 border-t border-border px-3 py-3">
              {q.answer ? (
                <div className="prose-workbench text-xs leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{q.answer}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{q.guidance}</p>
              )}

              {q.evidence.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Evidence</div>
                  <ul className="space-y-1">
                    {q.evidence.map((e) => (
                      <li key={e.id}>
                        <button onClick={() => onOpenFile(e.id, q.evidence.map((x) => x.id))} className="group/ev flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted">
                          <FileText className="mt-0.5 size-3 shrink-0 text-muted-foreground group-hover/ev:text-signal" />
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-[10.5px]">{e.path}</span>
                            {e.note && <span className="block text-[10.5px] text-muted-foreground">{e.note}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-1.5">
                <Button size="xs" variant="outline" disabled={busy} onClick={() => onAsk(q)}>
                  <Sparkles data-icon="inline-start" />
                  {q.answer ? 'Re-investigate' : 'Investigate'}
                </Button>
                {q.finding_id && q.status !== 'confirmed' && (
                  <Button size="xs" variant="secondary" onClick={() => onReview(q.finding_id!, 'confirmed')}>
                    <Check data-icon="inline-start" />
                    Confirm
                  </Button>
                )}
                {q.finding_id && q.status !== 'rejected' && (
                  <Button size="xs" variant="ghost" onClick={() => onReview(q.finding_id!, 'rejected')}>
                    <X data-icon="inline-start" />
                    Reject
                  </Button>
                )}
                {q.finding_id && (q.status === 'confirmed' || q.status === 'rejected') && (
                  <Button size="xs" variant="ghost" onClick={() => onReview(q.finding_id!, 'hypothesis')}>
                    Reopen
                  </Button>
                )}
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </li>
  )
}
