// Page building blocks in the product's visual language (shared with the marketing site):
// a cobalt mono eyebrow, a tight heading, muted lede; bordered white cards; small pills
// for status ("Current" green, "Outdated" amber, neutral "Supports").

import { cn } from '@/lib/utils'

export function PageHeader({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="max-w-2xl">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        {children && <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground text-pretty">{children}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn('mx-auto max-w-5xl px-8 py-8', className)}>{children}</div>
    </div>
  )
}

export function Section({ title, hint, actions, children, className }: { title: string; hint?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('mt-8', className)}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {hint && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('rounded-xl border border-border bg-card shadow-xs', className)}>{children}</div>
}

type Tone = 'verified' | 'stale' | 'neutral' | 'cobalt' | 'danger'
const TONE: Record<Tone, string> = {
  verified: 'bg-verified-soft text-verified',
  stale: 'bg-stale-soft text-stale',
  neutral: 'bg-muted text-muted-foreground',
  cobalt: 'bg-cobalt-soft text-cobalt',
  danger: 'bg-destructive/10 text-destructive',
}

export function Pill({ tone = 'neutral', children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', TONE[tone], className)}>{children}</span>
}

/** A big number with a mono caption, for summary rows. */
export function Stat({ value, label, tone }: { value: React.ReactNode; label: string; tone?: Tone }) {
  return (
    <div>
      <div className={cn('text-[22px] font-semibold tabular-nums tracking-[-0.02em]', tone === 'verified' && 'text-verified', tone === 'stale' && 'text-stale', tone === 'danger' && 'text-destructive')}>{value}</div>
      <div className="eyebrow-muted mt-0.5">{label}</div>
    </div>
  )
}
