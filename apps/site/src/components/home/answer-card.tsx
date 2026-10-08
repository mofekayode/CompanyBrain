import { FileText, Database, Mail, PlayCircle, Mic, Sheet, Camera, Sparkles } from 'lucide-react'
import type { Answer, Citation, SourceKind, SourceStatus } from '@/lib/answers'
import { cn } from '@/lib/utils'

export const kindIcon: Record<SourceKind, typeof FileText> = {
  document: FileText,
  system: Database,
  email: Mail,
  video: PlayCircle,
  interview: Mic,
  spreadsheet: Sheet,
  photo: Camera,
}

const statusStyle: Record<SourceStatus, { label: string; className: string }> = {
  current: { label: 'Current', className: 'bg-verified-soft text-verified' },
  outdated: { label: 'Outdated', className: 'bg-stale-soft text-stale' },
  supporting: { label: 'Supports', className: 'bg-muted text-muted-foreground' },
}

export function CitationRow({ c, index }: { c: Citation; index: number }) {
  const Icon = kindIcon[c.kind]
  const status = statusStyle[c.status]
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-white px-3 py-2.5">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-cobalt-soft font-mono text-[10px] font-semibold text-cobalt">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-[13px] font-medium text-ink">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{c.title}</span>
        </p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {c.locator}
          {c.note && <span className="text-stale"> · {c.note}</span>}
        </p>
      </div>
      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium', status.className)}>
        {status.label}
      </span>
    </li>
  )
}

export function Timeline({ steps }: { steps: NonNullable<Answer['timeline']> }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {steps.map((s, i) => (
        <li key={s.when} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-5 bg-ink/20" aria-hidden />}
          <span
            className={cn(
              'flex items-baseline gap-1.5 rounded-md border px-2 py-1 text-[12px]',
              s.current ? 'border-cobalt/30 bg-cobalt-soft text-navy' : 'border-border bg-white text-muted-foreground line-through decoration-ink/25',
            )}
          >
            <span className="font-mono text-[10.5px] no-underline opacity-80">{s.when}</span>
            <span className={cn(s.current && 'font-medium')}>{s.value}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

/** One answered question as it appears in the product. */
export function AnswerCard({ answer, className }: { answer: Answer; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[13.5px] text-white">{answer.question}</p>
      </div>
      <div className="space-y-3.5">
        <p className="flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase">
          <Sparkles className="size-3 text-cobalt" />
          Answer · {answer.citations.length} sources
        </p>
        <p className="text-[17px] leading-snug font-semibold tracking-[-0.015em] text-ink">{answer.summary}</p>
        {answer.detail && <p className="text-[13.5px] leading-relaxed text-ink/75">{answer.detail}</p>}
        {answer.timeline && <Timeline steps={answer.timeline} />}
        <ul className="space-y-1.5 pt-1">
          {answer.citations.map((c, i) => (
            <CitationRow key={c.title + i} c={c} index={i} />
          ))}
        </ul>
      </div>
    </div>
  )
}
