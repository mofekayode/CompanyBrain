import type { ReactNode } from 'react'
import { Check, ArrowRight, ArrowDown, MapPin, Video, Camera, Database, Mic, Lightbulb } from 'lucide-react'
import { Container, SectionHeading } from '@/components/site/section'

const systems = [
  'Google Workspace',
  'Microsoft 365',
  'SharePoint',
  'QuickBooks',
  'HubSpot',
  'Salesforce',
  'ERP',
  'Field service',
  'File servers',
  'Spreadsheets',
  'PDFs & scans',
  'Databases & APIs',
]

const stages: { n: string; title: string; body: ReactNode; visual: ReactNode }[] = [
  {
    n: '01',
    title: 'Start with the people who know the business',
    body: (
      <>
        <p>
          We begin with the buyer and seller. We learn what’s changing, what still depends on the seller, which
          relationships matter, who the critical employees are and where knowledge is most at risk.
        </p>
        <p>This can start virtually. When being onsite matters, we come to the business.</p>
      </>
    ),
    visual: (
      <div className="rounded-xl border border-border bg-white p-5">
        <p className="font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase">Transition kickoff</p>
        <ul className="mt-4 space-y-2.5 text-[14px]">
          {[
            'What changes after close',
            'What the seller personally owns',
            'Relationships that depend on the seller',
            'Employees the business can’t lose',
            'Where knowledge is most at risk',
          ].map((t) => (
            <li key={t} className="flex items-center gap-2.5">
              <span className="grid size-4.5 place-items-center rounded-full bg-verified-soft text-verified">
                <Check className="size-3" strokeWidth={3} />
              </span>
              {t}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex gap-2 text-[12px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1">
            <Video className="size-3.5" /> Virtual
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1">
            <MapPin className="size-3.5" /> Onsite
          </span>
        </div>
      </div>
    ),
  },
  {
    n: '02',
    title: 'Connect and collect the company record',
    body: (
      <>
        <p>
          We securely connect the systems the company already runs on, and collect the files that never made it into
          one.
        </p>
        <p>
          Have information that isn’t digital? We help capture scans, photos and handwritten records too.
        </p>
      </>
    ),
    visual: (
      <div className="rounded-xl border border-border bg-white p-5">
        <p className="font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase">Sources</p>
        <ul className="mt-4 flex flex-wrap gap-1.5">
          {systems.map((s) => (
            <li key={s} className="rounded-md border border-border bg-paper/60 px-2.5 py-1 text-[13px]">
              {s}
            </li>
          ))}
          <li className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-cobalt/40 bg-cobalt-soft/60 px-2.5 py-1 text-[13px] text-navy">
            <Camera className="size-3.5" /> Paper, labels, whiteboards
          </li>
        </ul>
      </div>
    ),
  },
  {
    n: '03',
    title: 'Build a working model of the company',
    body: (
      <>
        <p>
          We map the people, customers, sites, equipment, contracts, processes and terminology behind the data, and
          how they relate.
        </p>
      </>
    ),
    visual: (
      <div className="rounded-xl border border-border bg-white p-5">
        <p className="font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase">Same customer?</p>
        <div className="mt-4 grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <ul className="space-y-1.5">
            {['Big Blue', 'Blue Ridge Mills', 'BLUE RIDGE FOOD PROCESSING', 'Blue Ridge Foods'].map((n) => (
              <li key={n} className="truncate rounded-md border border-border bg-paper/60 px-2 py-1 font-mono text-[11.5px]">
                {n}
              </li>
            ))}
          </ul>
          <ArrowRight className="mx-auto size-4 rotate-90 text-cobalt sm:rotate-0" />
          <div className="rounded-lg border border-cobalt/30 bg-cobalt-soft p-3">
            <p className="text-[13.5px] font-semibold text-navy">Blue Ridge Foods</p>
            <p className="mt-1 text-[11.5px] text-navy/70">1 customer · 4 names · 3 systems</p>
          </div>
        </div>
        <p className="mt-4 text-[12.5px] text-muted-foreground">
          Matches we aren’t sure of go to a person to decide. Nothing ambiguous is merged automatically.
        </p>
      </div>
    ),
  },
  {
    n: '04',
    title: 'Interview the team where the data stops',
    body: (
      <>
        <p className="text-ink">The data tells us what to ask next.</p>
        <p>
          Once we’ve mapped what the company already knows, we interview the people who fill the gaps, virtually or
          onsite. We walk the facility, look at physical records and capture context that doesn’t exist in any
          software system.
        </p>
      </>
    ),
    visual: <GapClosing />,
  },
  {
    n: '05',
    title: 'Validate it, hand it over, keep it alive',
    body: (
      <>
        <p>
          Before handoff, we resolve the contradictions that matter with your team. Your Company Brain stays connected
          to the business, so it doesn’t become another transition binder that’s obsolete in six months.
        </p>
        <p className="text-ink">
          We don’t disappear at handoff. Keep working with us as the company changes and new needs come up.
        </p>
      </>
    ),
    visual: (
      <div className="rounded-xl border border-border bg-white p-5">
        <ol className="relative space-y-5 pl-6 before:absolute before:top-1.5 before:bottom-1.5 before:left-[7px] before:w-px before:bg-border">
          {[
            ['Transition', 'Capture, connect, interview', false],
            ['Handoff', 'Contradictions resolved, key areas validated', false],
            ['After', 'Stays connected and current as the business changes', true],
          ].map(([t, d, live]) => (
            <li key={t as string} className="relative">
              <span
                className={`absolute top-1 -left-6 size-[15px] rounded-full border-2 border-white ${live ? 'bg-verified ring-4 ring-verified-soft' : 'bg-ink/20'}`}
              />
              <p className="text-[14px] font-semibold">{t}</p>
              <p className="text-[13px] text-muted-foreground">{d}</p>
            </li>
          ))}
        </ol>
      </div>
    ),
  },
]

export function Process() {
  return (
    <section id="how-it-works" className="scroll-mt-16 border-t border-border bg-white/50 py-24 sm:py-32">
      <Container>
        <SectionHeading
          eyebrow="How we build it"
          title="Five stages, run alongside your transition."
          lede="This is not a software install. From the first week, someone from our team works alongside you, the seller and your staff, and learns your business the way an operator would."
        />
        <ol className="mt-16">
          {stages.map((s) => (
            <li key={s.n} className="grid grid-cols-1 gap-8 border-t border-border py-12 lg:grid-cols-2 lg:gap-16">
              <div className="space-y-4">
                <p className="font-mono text-[13px] text-cobalt">{s.n}</p>
                <h3 className="text-balance text-[26px] leading-tight font-semibold tracking-[-0.025em] sm:text-[30px]">
                  {s.title}
                </h3>
                <div className="max-w-lg space-y-4 text-[16px] leading-relaxed text-muted-foreground">{s.body}</div>
              </div>
              <div className="lg:pt-9">{s.visual}</div>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  )
}

/**
 * Stage 4 visual: how an interview closes a gap the data can't.
 * Illustrative, from the demo company. Swap in a real onsite photo after the first engagement.
 */
function GapClosing() {
  const step = 'rounded-xl border border-border bg-white p-4'
  const head = 'flex items-center gap-2 font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase'
  const arrow = <ArrowDown className="mx-auto size-4 text-cobalt/60" aria-hidden />
  return (
    <div className="space-y-2">
      <div className={step}>
        <p className={head}>
          <Database className="size-3.5" /> What the systems say
        </p>
        <p className="mt-2.5 text-[14px] font-medium">Pump 17 · 38 work orders since 2023</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Most repairs coded as “alignment”. It keeps coming back.</p>
      </div>
      {arrow}
      <div className={step}>
        <p className={head}>
          <Mic className="size-3.5" /> What the interview adds
          <span className="ml-auto normal-case tracking-normal">Maintenance lead · 14:32</span>
        </p>
        <p className="mt-2.5 font-serif text-[17px] leading-snug text-ink italic">
          “Everybody calls it the north pump. And it was never alignment. We drew the real problem on the whiteboard.”
        </p>
      </div>
      {arrow}
      <div className="rounded-xl border border-cobalt/30 bg-cobalt-soft/60 p-4">
        <p className={head}>
          <Lightbulb className="size-3.5 text-cobalt" /> What Company Brain learns
        </p>
        <ul className="mt-2.5 space-y-1.5 text-[13.5px] text-navy">
          <li>
            <span className="font-mono text-[12px]">“north pump”</span> → Pump 17 at Hamilton
          </li>
          <li>Repair codes disagree with the people doing the repairs. Flagged.</li>
          <li>
            Whiteboard photo <span className="font-mono text-[12px]">IMG_4127</span> linked as evidence
          </li>
        </ul>
        <p className="mt-3 border-t border-cobalt/20 pt-3 text-[13px] text-navy">
          <span className="font-medium">Next question:</span> what actually fixed it, and did the failures stop?
        </p>
      </div>
    </div>
  )
}
