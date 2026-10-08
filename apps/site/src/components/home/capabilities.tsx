import type { ReactNode } from 'react'
import { Lock, FileText, Database, ArrowRight } from 'lucide-react'
import { Container, SectionHeading } from '@/components/site/section'

const chip = 'rounded-md border border-border bg-white px-2 py-1 text-[12px]'

const panels: { title: string; body: string; visual: ReactNode }[] = [
  {
    title: 'Understands your language',
    body: 'Nicknames, aliases, old company names, internal jargon and local terminology.',
    visual: (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={chip}>“J-town”</span>
        <ArrowRight className="size-3.5 text-cobalt" />
        <span className={`${chip} border-cobalt/30 bg-cobalt-soft text-navy`}>Louisville branch</span>
      </div>
    ),
  },
  {
    title: 'Knows what changed',
    body: 'Separates old information from current operating truth, and keeps the history.',
    visual: (
      <div className="flex items-center gap-2">
        <span className={`${chip} text-muted-foreground line-through`}>Net 30 · 2022</span>
        <span className="h-px w-4 bg-ink/20" />
        <span className={`${chip} border-cobalt/30 bg-cobalt-soft font-medium text-navy`}>Net 60 · now</span>
      </div>
    ),
  },
  {
    title: 'Resolves conflicting sources',
    body: 'A signed amendment shouldn’t lose to a stale spreadsheet.',
    visual: (
      <div className="flex flex-col gap-1.5">
        <span className={`${chip} flex items-center gap-1.5`}>
          <FileText className="size-3.5 text-verified" /> Signed amendment <span className="ml-auto text-verified">wins</span>
        </span>
        <span className={`${chip} flex items-center gap-1.5 text-muted-foreground`}>
          <Database className="size-3.5" /> Billing system <span className="ml-auto text-stale">outdated</span>
        </span>
      </div>
    ),
  },
  {
    title: 'Keeps the relationships',
    body: 'How customers, people, sites, systems, contracts and processes connect.',
    visual: (
      <svg viewBox="0 0 200 56" className="h-14 w-full max-w-[220px]" aria-hidden>
        <g stroke="var(--cobalt)" strokeOpacity=".5" strokeWidth="1.2">
          <line x1="20" y1="28" x2="80" y2="12" />
          <line x1="20" y1="28" x2="80" y2="44" />
          <line x1="80" y1="12" x2="140" y2="28" />
          <line x1="80" y1="44" x2="140" y2="28" />
          <line x1="140" y1="28" x2="185" y2="28" />
        </g>
        {[
          [20, 28],
          [80, 12],
          [80, 44],
          [140, 28],
          [185, 28],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i === 3 ? 6 : 4.5} fill={i === 3 ? 'var(--cobalt)' : '#fff'} stroke="var(--ink)" strokeOpacity=".35" />
        ))}
      </svg>
    ),
  },
  {
    title: 'Respects access',
    body: 'People only see what they’re allowed to see. Payroll stays with the people who should have it.',
    visual: (
      <div className="flex flex-col gap-1.5">
        <span className={`${chip} flex items-center gap-1.5`}>
          <span className="size-1.5 rounded-full bg-verified" /> Technician: work orders, SOPs
        </span>
        <span className={`${chip} flex items-center gap-1.5 text-muted-foreground`}>
          <Lock className="size-3.5" /> Payroll: owners only
        </span>
      </div>
    ),
  },
  {
    title: 'Shows its work',
    body: 'Important answers trace back to the exact page, row, email or video moment.',
    visual: (
      <div className="flex flex-wrap gap-1.5">
        <span className={`${chip} font-mono text-[11px]`}>SOP-LOTO Rev 4.pdf · p. 1</span>
        <span className={`${chip} font-mono text-[11px]`}>Billing recording · 0:50</span>
      </div>
    ),
  },
]

export function Capabilities() {
  return (
    <section className="border-t border-border bg-white/50 py-24 sm:py-32">
      <Container>
        <SectionHeading
          eyebrow="Why the answers are different"
          title="Finding a file isn’t the same as understanding the company."
          lede="Search can find what was written down. Company Brain reconciles what’s current, what conflicts, what changed and how the pieces of the business relate."
        />
        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3 [&>*]:bg-paper">
          {panels.map((p) => (
            <div key={p.title} className="flex flex-col gap-6 p-6 sm:p-7">
              <div className="flex min-h-16 items-center">{p.visual}</div>
              <div>
                <h3 className="text-[16px] font-semibold tracking-[-0.01em]">{p.title}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">{p.body}</p>
              </div>
            </div>
          ))}
        </div>
      </Container>
    </section>
  )
}
