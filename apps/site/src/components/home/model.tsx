import { Building2, MapPin, Cog, ClipboardList, UserRound, FileSignature, BadgePercent, Mail } from 'lucide-react'
import { Container, SectionHeading } from '@/components/site/section'
import { cn } from '@/lib/utils'

type Node = { id: string; type: string; label: string; icon: typeof Building2; x: number; y: number; hub?: boolean }

const nodes: Node[] = [
  { id: 'customer', type: 'Customer', label: 'Blue Ridge Foods', icon: Building2, x: 50, y: 50, hub: true },
  { id: 'site', type: 'Site', label: 'Hamilton plant', icon: MapPin, x: 20, y: 20 },
  { id: 'asset', type: 'Equipment', label: 'Pump 17', icon: Cog, x: 13, y: 60 },
  { id: 'wo', type: 'Work orders', label: '38 since 2023', icon: ClipboardList, x: 27, y: 88 },
  { id: 'person', type: 'Key person', label: 'Service manager', icon: UserRound, x: 56, y: 88 },
  { id: 'contract', type: 'Contract', label: 'MSA + Amendment 2', icon: FileSignature, x: 76, y: 16 },
  { id: 'exception', type: 'Pricing exception', label: 'Trip charge waived', icon: BadgePercent, x: 88, y: 52 },
  { id: 'email', type: 'Email', label: '212 messages', icon: Mail, x: 82, y: 86 },
]

const edges: [string, string, string?][] = [
  ['customer', 'site', 'operates'],
  ['site', 'asset', 'houses'],
  ['asset', 'wo', 'serviced by'],
  ['wo', 'person', 'assigned to'],
  ['person', 'customer', 'actually calls'],
  ['customer', 'contract', 'signed'],
  ['contract', 'exception', 'not in'],
  ['customer', 'exception'],
  ['customer', 'email'],
]

const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))

export function Model() {
  return (
    <section className="py-24 sm:py-32">
      <Container>
        <SectionHeading
          eyebrow="Built for your business"
          title="No two companies work the same way."
          lede="Your Company Brain is built around how your company actually operates: its terminology, customers, equipment, people, processes, exceptions, systems and history. We’re done when the people running the business can rely on it, not when the data is imported."
        />

        <div className="relative mt-14 overflow-hidden rounded-2xl border border-border bg-white">
          <div className="bg-grid absolute inset-0 opacity-60" aria-hidden />

          {/* Desktop: positioned map */}
          <div className="relative hidden aspect-[16/8] md:block">
            <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              {edges.map(([a, b]) => (
                <line
                  key={a + b}
                  x1={byId[a].x}
                  y1={byId[a].y}
                  x2={byId[b].x}
                  y2={byId[b].y}
                  stroke="var(--cobalt)"
                  strokeOpacity={b === 'customer' ? 0.9 : 0.4}
                  strokeWidth={b === 'customer' ? 1.6 : 1.1}
                  strokeDasharray={b === 'customer' ? '4 4' : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            {edges
              .filter((e) => e[2])
              .map(([a, b, label]) => (
                <span
                  key={'l' + a + b}
                  className={cn(
                    'absolute -translate-x-1/2 -translate-y-1/2 rounded bg-white px-1.5 font-mono text-[10.5px] whitespace-nowrap',
                    b === 'customer' ? 'text-cobalt' : 'text-muted-foreground',
                  )}
                  style={{ left: `${(byId[a].x + byId[b].x) / 2}%`, top: `${(byId[a].y + byId[b].y) / 2}%` }}
                >
                  {label}
                </span>
              ))}
            {nodes.map((n) => (
              <NodeCard key={n.id} n={n} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${n.x}%`, top: `${n.y}%` }} />
            ))}
          </div>

          {/* Mobile: the same relationships as a list */}
          <div className="relative space-y-2 p-4 md:hidden">
            <NodeCard n={byId.customer} />
            <ul className="space-y-2 border-l border-cobalt/40 pl-4">
              {nodes.slice(1).map((n) => (
                <li key={n.id}>
                  <NodeCard n={n} />
                </li>
              ))}
            </ul>
          </div>
        </div>

        <blockquote className="mx-auto mt-20 max-w-3xl text-center font-serif text-[30px] leading-[1.2] font-normal tracking-[-0.02em] text-ink sm:text-[40px]">
          By the end of the transition, you should understand the company better than it has ever understood itself.
        </blockquote>
      </Container>
    </section>
  )
}

function NodeCard({ n, className, style }: { n: Node; className?: string; style?: React.CSSProperties }) {
  const Icon = n.icon
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-xl border px-3 py-2 shadow-sm',
        n.hub ? 'border-navy bg-navy text-white shadow-lg shadow-navy/20' : 'border-border bg-white',
        className,
      )}
      style={style}
    >
      <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', n.hub ? 'bg-white/10' : 'bg-cobalt-soft text-cobalt')}>
        <Icon className="size-3.5" />
      </span>
      <span className="leading-tight whitespace-nowrap">
        <span className={cn('block font-mono text-[10px] tracking-[0.06em] uppercase', n.hub ? 'text-white/60' : 'text-muted-foreground')}>
          {n.type}
        </span>
        <span className="text-[13px] font-medium">{n.label}</span>
      </span>
    </div>
  )
}
