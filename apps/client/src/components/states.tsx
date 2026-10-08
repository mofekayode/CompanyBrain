// Shared loading, empty and guidance states, so every page says what's happening and what to do next.

import type { LucideIcon } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Nothing here (yet): what this place is for and the next step. */
export function EmptyState({ icon: Icon, title, children, action, className }: { icon: LucideIcon; title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center rounded-2xl border border-dashed border-border bg-white/60 px-6 py-12 text-center', className)}>
      <span className="grid size-10 place-items-center rounded-xl bg-cobalt-soft text-cobalt">
        <Icon className="size-5" />
      </span>
      <p className="mt-3 text-[15px] font-semibold text-ink">{title}</p>
      {children && <div className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted-foreground text-pretty">{children}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}

/** A short "how this works" strip: numbered steps, used at the top of Briefs and Files. */
export function HowItWorks({ steps, className }: { steps: { title: string; body: React.ReactNode }[]; className?: string }) {
  return (
    <ol className={cn('grid gap-3 sm:grid-cols-3', className)}>
      {steps.map((s, i) => (
        <li key={s.title} className="rounded-xl border border-border bg-white p-4">
          <span className="font-mono text-[11px] text-cobalt">0{i + 1}</span>
          <p className="mt-1 text-[14px] font-medium text-ink">{s.title}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{s.body}</p>
        </li>
      ))}
    </ol>
  )
}

/** Placeholder rows in the shape of a list of cards. */
export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2.5', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-xl border border-border bg-white p-4">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="mt-2.5 h-4 w-4/5" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ))}
    </div>
  )
}

/** The shape of an answer while it's being put together. */
export function SkeletonAnswer({ label = 'Reading the record…' }: { label?: string }) {
  return (
    <div className="space-y-3.5" aria-busy="true">
      <p className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase">
        <span className="size-1.5 animate-pulse rounded-full bg-cobalt" /> {label}
      </p>
      <Skeleton className="h-5 w-11/12" />
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-3.5 w-4/5" />
      <div className="flex gap-2 pt-1">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-7 w-48" />
      </div>
      <div className="space-y-1.5 pt-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </div>
  )
}
