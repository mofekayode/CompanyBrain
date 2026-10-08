'use client'

import type { WorkflowStep } from '@companybrain/core/workbench/next-steps'
import { Check } from 'lucide-react'
import Link from 'next/link'
import { Fragment } from 'react'
import { cn } from '@/lib/utils'

/** The client's workflow at a glance: Upload → Profile → Discover → Extract → Company model. */
export function StepBar({ steps, slug }: { steps: WorkflowStep[]; slug: string }) {
  return (
    <ol className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-4 py-2">
      {steps.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && <li aria-hidden className={cn('h-px w-4 shrink-0', s.status === 'done' ? 'bg-ok/60' : 'bg-border')} />}
          <li className="flex shrink-0 items-center gap-1.5" title={s.detail}>
            <span
              className={cn(
                'flex size-4 items-center justify-center rounded-full border text-[9px] font-semibold',
                s.status === 'done' && 'border-ok bg-ok text-background',
                s.status === 'current' && 'border-signal bg-signal/15 text-signal',
                s.status === 'available' && 'border-signal/50 text-signal',
                (s.status === 'todo' || s.status === 'later') && 'border-border text-muted-foreground',
              )}
            >
              {s.status === 'done' ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
            </span>
            {s.href ? (
              <Link href={`/t/${slug}/${s.href}`} className={cn('text-[11px] underline-offset-2 hover:underline', s.status === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                {s.label}
              </Link>
            ) : (
              <span className={cn('text-[11px]', s.status === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{s.label}</span>
            )}
            <span className="hidden text-[10px] text-muted-foreground/70 xl:inline">{s.status === 'later' ? 'later' : s.detail}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  )
}
