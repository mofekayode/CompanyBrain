'use client'

import { BarChart3 } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts'
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'

export interface ChartSpec {
  title: string
  kind: 'bar' | 'horizontal_bar' | 'line' | 'pie'
  labels: string[]
  series: { name: string; values: number[] }[]
  unit?: string
  caption?: string
}

const PALETTE = ['var(--signal)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-1)']

export function ChartView({ spec }: { spec: ChartSpec }) {
  const keys = spec.series.map((_, i) => `s${i}`)
  const data = spec.labels.map((label, i) => Object.fromEntries([['label', label], ...spec.series.map((s, j) => [keys[j], s.values[i]])]))
  const config: ChartConfig = Object.fromEntries(spec.series.map((s, i) => [keys[i], { label: s.name, color: PALETTE[i % PALETTE.length] }]))
  const many = spec.labels.length > 8
  const height = spec.kind === 'horizontal_bar' ? Math.max(180, spec.labels.length * 28 + 40) : 280

  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-card">
      <figcaption className="flex items-start gap-2 border-b border-border px-4 py-2.5">
        <BarChart3 className="mt-0.5 size-4 shrink-0 text-signal" />
        <div className="min-w-0">
          <div className="text-sm font-medium">{spec.title}</div>
          {spec.caption && <div className="text-xs text-muted-foreground">{spec.caption}</div>}
        </div>
        {spec.unit && <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{spec.unit}</span>}
      </figcaption>
      <div className="p-3">
        <ChartContainer config={config} className="w-full" style={{ height }}>
          {spec.kind === 'pie' ? (
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey="label" />} />
              <Pie data={data} dataKey={keys[0]} nameKey="label" innerRadius={60} strokeWidth={2}>
                {data.map((_, i) => (
                  <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
            </PieChart>
          ) : spec.kind === 'line' ? (
            <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} interval={many ? 'preserveStartEnd' : 0} />
              <YAxis tickLine={false} axisLine={false} fontSize={11} width={48} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
              {keys.map((k) => (
                <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} dot={!many} />
              ))}
            </LineChart>
          ) : (
            <BarChart data={data} layout={spec.kind === 'horizontal_bar' ? 'vertical' : 'horizontal'} margin={{ left: 4, right: 12, top: 8 }}>
              <CartesianGrid vertical={spec.kind === 'horizontal_bar'} horizontal={spec.kind !== 'horizontal_bar'} />
              {spec.kind === 'horizontal_bar' ? (
                <>
                  <XAxis type="number" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} fontSize={11} width={170} />
                </>
              ) : (
                <>
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} interval={0} angle={many ? -35 : 0} textAnchor={many ? 'end' : 'middle'} height={many ? 70 : 30} />
                  <YAxis tickLine={false} axisLine={false} fontSize={11} width={48} />
                </>
              )}
              <ChartTooltip content={<ChartTooltipContent />} />
              {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
              {keys.map((k) => (
                <Bar key={k} dataKey={k} fill={`var(--color-${k})`} radius={4} />
              ))}
            </BarChart>
          )}
        </ChartContainer>
      </div>
    </figure>
  )
}
