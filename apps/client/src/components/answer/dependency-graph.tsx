'use client'

// What depends on one person, as a radial graph: the person in the middle; around them what
// only they know (cobalt), who depends on them (navy) and arrangements that exist because of
// them (amber). Built from the key-person brief's sections, so every node is a cited line.

const RING: { match: RegExp; color: string; label: string }[] = [
  { match: /^What only/, color: 'var(--cobalt)', label: 'Only they know' },
  { match: /^Where others depend/, color: 'var(--navy)', label: 'Others depend on them' },
  { match: /^Arrangements/, color: 'var(--stale)', label: 'Arrangements tied to them' },
]

const short = (t: string, person: string) => {
  const [head, rest] = / [-·] /.test(t) ? t.split(/ [-·] /) : [null, t]
  const what = rest.split(':')[0]
  const s = head && head !== person ? `${head.replace(/ (LLC|Inc\.?|Corp\.?)$/, '')}: ${what}` : what
  return s.length > 32 ? `${s.slice(0, 31)}…` : s
}

export function DependencyGraph({ person, sections }: { person: string; sections: { heading: string; items: { text: string; cites: number[] }[] }[] }) {
  const nodes = RING.flatMap((r) => (sections.find((s) => r.match.test(s.heading))?.items.slice(0, 8) ?? []).map((it) => ({ ...it, color: r.color })))
  if (nodes.length < 3) return null
  const W = 1040
  const H = 600
  const cx = W / 2
  const cy = H / 2
  const R = 225
  return (
    <figure className="rounded-2xl border border-border bg-white p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`What depends on ${person}`}>
        {nodes.map((n, i) => {
          const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2
          const x = cx + Math.cos(a) * R
          const y = cy + Math.sin(a) * R * 0.86
          const right = Math.cos(a) >= 0
          return (
            <g key={i}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke={n.color} strokeOpacity={0.35} strokeWidth={1.4} />
              <circle cx={x} cy={y} r={7} fill={n.color} />
              <text x={x + (right ? 12 : -12)} y={y + 4} textAnchor={right ? 'start' : 'end'} fontSize={13} fill="var(--ink)">
                {short(n.text, person)}
                {n.cites[0] && <tspan fill="var(--cobalt)" fontSize={10} fontFamily="var(--font-geist-mono)">{` ${n.cites[0]}`}</tspan>}
              </text>
            </g>
          )
        })}
        <circle cx={cx} cy={cy} r={54} fill="var(--ink)" />
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={14} fontWeight={600} fill="#fff">
          {person.split(' ')[0]}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize={11} fill="#fff" fillOpacity={0.7}>
          {nodes.length} dependencies
        </text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-[12px] text-muted-foreground">
        {RING.map((r) => (
          <span key={r.label} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: r.color }} /> {r.label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
