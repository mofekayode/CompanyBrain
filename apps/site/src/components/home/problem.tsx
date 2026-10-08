import { Users, Server, Files, ClipboardPen, ArrowDown } from 'lucide-react'
import { Container, SectionHeading } from '@/components/site/section'
import { LogoMark } from '@/components/site/logo'

const streams = [
  { icon: Users, title: 'People', items: 'Founder, operators, finance, sales, technicians' },
  { icon: Server, title: 'Systems', items: 'QuickBooks, CRM, ERP, field service, email' },
  { icon: Files, title: 'Files', items: 'Contracts, spreadsheets, PDFs, old folders, scans' },
  { icon: ClipboardPen, title: 'What isn’t digital', items: 'Paper files, whiteboards, labels, handwritten SOPs' },
]

const lines = [
  'The signed contracts are somewhere.',
  'The customer history is somewhere else.',
  'The operating systems know part of the truth.',
  'The spreadsheets know another part.',
]

export function Problem() {
  return (
    <section className="py-24 sm:py-32">
      <Container className="grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-16">
        <div>
          <SectionHeading eyebrow="The problem" title="The company you bought isn’t all in the data room." />
          <ul className="mt-8 space-y-2 text-[17px] text-muted-foreground">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="mt-6 max-w-lg text-pretty text-[17px] leading-relaxed text-ink">
            And twenty years of exceptions, relationships, workarounds, terminology and judgment are still sitting in
            people’s heads.
          </p>
          <p className="mt-6 text-[17px] font-medium text-cobalt">We help you capture it before the transition ends.</p>
        </div>

        <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[minmax(0,1fr)_96px_auto] md:gap-0">
          <ul className="grid gap-3">
            {streams.map(({ icon: Icon, title, items }) => (
              <li key={title} className="flex items-start gap-3.5 rounded-xl border border-border bg-white p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-paper text-ink">
                  <Icon className="size-4.5" />
                </span>
                <div>
                  <p className="text-[15px] font-semibold tracking-[-0.01em]">{title}</p>
                  <p className="mt-0.5 text-[13.5px] text-muted-foreground">{items}</p>
                </div>
              </li>
            ))}
          </ul>

          <svg className="hidden h-full w-full md:block" viewBox="0 0 96 400" preserveAspectRatio="none" aria-hidden>
            {[50, 150, 250, 350].map((y) => (
              <path
                key={y}
                d={`M0 ${y} C 52 ${y}, 44 200, 96 200`}
                fill="none"
                stroke="var(--cobalt)"
                strokeOpacity="0.45"
                strokeWidth="1.25"
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          <ArrowDown className="mx-auto size-5 text-cobalt md:hidden" aria-hidden />

          <div className="rounded-2xl bg-navy p-5 text-white shadow-xl shadow-navy/20 md:w-44">
            <LogoMark className="size-8" />
            <p className="mt-4 text-[15px] font-semibold tracking-[-0.01em]">Company Brain</p>
            <p className="mt-1 text-[12.5px] leading-snug text-white/65">One reconciled picture of how the business runs.</p>
          </div>
        </div>
      </Container>
    </section>
  )
}
