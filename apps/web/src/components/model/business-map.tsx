'use client'

// The business map: every kind of thing in the company model and how they
// connect, with real counts. Hub-and-spoke layout so it reads like a diagram of
// how the business works: the central thing in the middle, what hangs off it around.

import { Background, BackgroundVariant, Controls, type Edge, Handle, type Node, useNodesInitialized, type NodeProps, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { typeColor } from './colors'

export interface MapType {
  id: string
  name: string
  description: string | null
  status: string
  kind: 'thing' | 'event'
  examples: string[] | null
  parent: string | null
  entities: number
}
export interface MapLink {
  id: string
  name: string
  source_type: string
  target_type: string
  n: number
}

const fmt = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

type TypeNodeData = { type: MapType; selected: boolean }

function TypeNode({ data }: NodeProps<Node<TypeNodeData>>) {
  const t = data.type
  const color = typeColor(t.name)
  return (
    <div
      className={cn(
        'flex w-[210px] items-center gap-3 rounded-xl border bg-background px-3.5 py-2.5 shadow-md transition-shadow',
        t.kind === 'event' ? 'border-dashed' : 'border-border',
        data.selected && 'ring-2 ring-offset-1',
      )}
      style={{ ...(data.selected ? { ['--tw-ring-color' as string]: color } : {}) }}
    >
      {/* Edges run centre to centre, behind the card. */}
      <Handle type="target" position={Position.Top} style={{ top: '50%', left: '50%' }} className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent" />
      <span className="h-9 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] leading-tight font-semibold">{t.name}</div>
        <div className="text-[10.5px] text-muted-foreground">
          {t.kind === 'event' ? 'activity' : t.parent ? `kind of ${t.parent}` : 'thing'}
          {t.status === 'proposed' ? ' · proposed' : ''}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-[18px] leading-none font-semibold tabular-nums" style={{ color }}>
          {fmt(t.entities)}
        </div>
      </div>
      <Handle type="source" position={Position.Top} style={{ top: '50%', left: '50%' }} className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent" />
    </div>
  )
}

const nodeTypes = { type: TypeNode }

/**
 * Hub-and-spoke layout: the most connected type in the middle, its direct
 * neighbours on an inner ring (strongest first, spread evenly), everything else
 * on an outer ring next to the inner type it connects to most.
 */
export function radialLayout(ids: string[], edges: { source: string; target: string; n: number }[]): Map<string, { x: number; y: number }> {
  const weight = new Map<string, number>()
  const pair = (a: string, b: string) => edges.filter((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a)).reduce((s, e) => s + Math.log10(e.n + 1), 0)
  for (const e of edges) for (const x of [e.source, e.target]) weight.set(x, (weight.get(x) ?? 0) + Math.log10(e.n + 1))
  const sorted = [...ids].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))
  const hub = sorted[0]
  const pos = new Map<string, { x: number; y: number }>([[hub, { x: 0, y: 0 }]])
  const inner = sorted.slice(1).filter((id) => pair(hub, id) > 0).slice(0, 9)
  const outer = sorted.slice(1).filter((id) => !inner.includes(id))
  const R1 = Math.max(300, inner.length * 50)
  const R2 = R1 + 300
  const angleOf = new Map<string, number>()
  inner.forEach((id, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, inner.length) - Math.PI / 2
    angleOf.set(id, a)
    pos.set(id, { x: Math.cos(a) * R1 * 1.35, y: Math.sin(a) * R1 })
  })
  // Outer types sit near their strongest inner neighbour; spread those sharing one.
  const byAnchor = new Map<string, string[]>()
  for (const id of outer) {
    const anchor = [...inner].sort((a, b) => pair(id, b) - pair(id, a))[0] ?? hub
    byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), id])
  }
  for (const [anchor, group] of byAnchor) {
    const base = angleOf.get(anchor) ?? 0
    group.forEach((id, i) => {
      const a = base + (i - (group.length - 1) / 2) * 0.32
      pos.set(id, { x: Math.cos(a) * R2 * 1.35, y: Math.sin(a) * R2 })
    })
  }
  return pos
}

function MapCanvas({ types, links, showEvents, selected, onSelect }: { types: MapType[]; links: MapLink[]; showEvents: boolean; selected: string | null; onSelect: (t: MapType | null) => void }) {
  const [laid, setLaid] = useState<{ nodes: Node<TypeNodeData>[]; edges: Edge[] } | null>(null)
  const { fitView } = useReactFlow()
  const initialized = useNodesInitialized()
  // Fit once cards are measured (and again whenever the layout changes).
  useEffect(() => {
    if (initialized) fitView({ padding: 0.08, duration: 250 })
  }, [initialized, laid, fitView])

  // Which types and links to draw. Without events, link things that meet through an event (customer ↔ technician via work orders).
  const { visTypes, visLinks } = useMemo(() => {
    const live = types.filter((t) => t.entities > 0 && t.status !== 'rejected')
    const byId = new Map(live.map((t) => [t.id, t]))
    if (showEvents) {
      return { visTypes: live, visLinks: links.filter((l) => byId.has(l.source_type) && byId.has(l.target_type) && l.source_type !== l.target_type) }
    }
    const things = live.filter((t) => t.kind === 'thing')
    const thingIds = new Set(things.map((t) => t.id))
    const direct = links.filter((l) => thingIds.has(l.source_type) && thingIds.has(l.target_type) && l.source_type !== l.target_type)
    // Via events: event → A and event → B become A, B labelled with the event type.
    const derived = new Map<string, MapLink>()
    for (const ev of live.filter((t) => t.kind === 'event')) {
      const outs = links.filter((l) => l.source_type === ev.id && thingIds.has(l.target_type))
      for (let i = 0; i < outs.length; i++)
        for (let j = i + 1; j < outs.length; j++) {
          const [a, b] = [outs[i], outs[j]]
          if (a.target_type === b.target_type) continue
          const key = `${ev.id}|${[a.target_type, b.target_type].sort().join('|')}`
          if (!derived.has(key)) derived.set(key, { id: key, name: `via ${ev.name.toLowerCase()}s`, source_type: a.target_type, target_type: b.target_type, n: Math.min(a.n, b.n) })
        }
    }
    return { visTypes: things, visLinks: [...direct, ...derived.values()] }
  }, [types, links, showEvents])

  useEffect(() => {
    let cancelled = false
    // Several relationships between the same two types become one edge with combined labels.
    const merged = new Map<string, { source: string; target: string; labels: string[]; n: number }>()
    for (const l of visLinks) {
      const k = `${l.source_type}|${l.target_type}`
      const m = merged.get(k) ?? { source: l.source_type, target: l.target_type, labels: [], n: 0 }
      m.labels.push(l.name.replace(/_/g, ' '))
      m.n += l.n
      merged.set(k, m)
    }
    Promise.resolve(radialLayout(visTypes.map((t) => t.id), [...merged.values()])).then((pos) => {
      if (cancelled) return
      const maxN = Math.max(1, ...[...merged.values()].map((m) => m.n))
      // Only the strongest connections are labelled until a card is selected.
      const labelled = new Set([...merged.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 7).map(([k]) => k))
      setLaid({
        nodes: visTypes.map((t) => {
          const p = pos.get(t.id) ?? { x: 0, y: 0 }
          return { id: t.id, type: 'type', position: { x: p.x - 105, y: p.y - 29 }, data: { type: t, selected: selected === t.id } }
        }),
        edges: [...merged.entries()].map(([k, m]) => {
          const dim = !!selected && m.source !== selected && m.target !== selected
          const showLabel = selected ? !dim : labelled.has(k)
          return {
            id: k,
            source: m.source,
            target: m.target,
            label: showLabel ? `${m.labels.slice(0, 2).join(' · ')}${m.labels.length > 2 ? ` +${m.labels.length - 2}` : ''}  ${fmt(m.n)}` : undefined,
            labelStyle: { fontSize: 11, fill: 'var(--foreground)' },
            labelBgStyle: { fill: 'var(--background)' },
            labelBgPadding: [4, 2] as [number, number],
            type: 'straight',
            style: { strokeWidth: 1 + 4 * (Math.log10(m.n + 1) / Math.log10(maxN + 1)), stroke: dim ? 'var(--border)' : typeColor(visTypes.find((t) => t.id === m.source)?.name ?? ''), opacity: dim ? 0.25 : 0.7 },
          }
        }),
      })
    })
    return () => {
      cancelled = true
    }
  }, [visTypes, visLinks, selected, fitView])

  return (
    <ReactFlow
      nodes={laid?.nodes ?? []}
      edges={laid?.edges ?? []}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onSelect(visTypes.find((t) => t.id === n.id) ?? null)}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      minZoom={0.2}
      fitView
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

export function BusinessMap(props: { types: MapType[]; links: MapLink[]; showEvents: boolean; selected: string | null; onSelect: (t: MapType | null) => void }) {
  return (
    <ReactFlowProvider>
      <MapCanvas {...props} />
    </ReactFlowProvider>
  )
}
