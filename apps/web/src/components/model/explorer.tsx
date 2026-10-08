'use client'

// Knowledge graph explorer: search for anything, see it in the middle with what
// it connects to around it. Big collections (a customer's 2,000 work orders)
// are counted clusters; things reached through those events (the technicians
// who did the work) are shown with derived, counted edges.

import { Loader2, Search } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { API } from '@/lib/api'
import { cn } from '@/lib/utils'
import { typeColor } from './colors'
import { EntityPanel } from './entity-panel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the library's generics don't survive next/dynamic
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false }) as unknown as React.ComponentType<any>

interface GNode {
  id: string
  label: string
  type: string
  kind: 'thing' | 'event' | 'cluster'
  count?: number
  focus?: boolean
  x?: number
  y?: number
  fx?: number
  fy?: number
}
interface GEdge {
  source: string | GNode
  target: string | GNode
  label: string
  count?: number
  derived?: boolean
}

export function Explorer({ slug, focus, onFocus, onOpenFile }: { slug: string; focus: string | null; onFocus: (id: string) => void; onOpenFile: (fileId: string) => void }) {
  const base = `${API}/api/t/${slug}/model`
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ id: string; name: string; type: string; kind: string }[]>([])
  const [graph, setGraph] = useState<{ nodes: GNode[]; links: GEdge[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [trail, setTrail] = useState<{ id: string; label: string }[]>([])
  const [cluster, setCluster] = useState<{ node: GNode; members: { id: string; name: string; date: string | null; amount: string | null }[] } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg = useRef<any>(null)

  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const t = setTimeout(async () => {
      if (q.trim().length < 2) return setResults([])
      setResults(await fetch(`${base}/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()))
    }, 200)
    return () => clearTimeout(t)
  }, [q, base])

  const load = useCallback(
    async (id: string) => {
      setLoading(true)
      setCluster(null)
      const g = (await fetch(`${base}/entities/${id}/graph`).then((r) => r.json())) as { nodes: GNode[]; edges: GEdge[] }
      const center = g.nodes.find((n) => n.focus)
      if (center) {
        center.fx = 0
        center.fy = 0
        setTrail((t) => [...t.filter((x) => x.id !== id).slice(-6), { id, label: center.label }])
      }
      setGraph({ nodes: g.nodes, links: g.edges })
      setLoading(false)
    },
    [base],
  )
  // Spread nodes out (repulsion + longer links), then fit, never zooming in so far that labels collide.
  useEffect(() => {
    if (!graph) return
    const timers: ReturnType<typeof setTimeout>[] = []
    // The graph component loads lazily: wait for it before tuning forces.
    const apply = (tries = 0) => {
      const f = fg.current
      if (!f) return tries < 40 && timers.push(setTimeout(() => apply(tries + 1), 100))
      f.d3Force('charge')?.strength(-320)
      f.d3Force('link')?.distance((l: GEdge) => (l.derived ? 170 : 120))
      f.d3ReheatSimulation?.()
      timers.push(
        setTimeout(() => {
          f.zoomToFit?.(400, 70)
          timers.push(setTimeout(() => f.zoom?.() > 1.6 && f.zoom(1.6, 300), 450))
        }, 1200),
      )
    }
    apply()
    return () => timers.forEach(clearTimeout)
  }, [graph])
  const dark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  useEffect(() => {
    if (focus) load(focus)
  }, [focus, load])

  const degree = useMemo(() => {
    const d = new Map<string, number>()
    for (const l of graph?.links ?? []) {
      const s = typeof l.source === 'string' ? l.source : l.source.id
      const t = typeof l.target === 'string' ? l.target : l.target.id
      d.set(s, (d.get(s) ?? 0) + 1)
      d.set(t, (d.get(t) ?? 0) + 1)
    }
    return d
  }, [graph])

  async function openCluster(node: GNode) {
    const [, rel, dir, type] = node.id.split(':')
    const members = await fetch(`${base}/entities/${focus}/cluster?rel=${encodeURIComponent(rel)}&dir=${dir}&type=${encodeURIComponent(type)}`).then((r) => r.json())
    setCluster({ node, members })
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[17rem_minmax(0,1fr)_24rem]">
      {/* Search */}
      <aside className="flex min-h-0 flex-col border-r border-border">
        <div className="p-3">
          <div className="relative">
            <Search className="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, person, asset, WO #…" className="h-8 pl-8 text-xs" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {results.map((r) => (
            <button key={r.id} onClick={() => onFocus(r.id)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted', focus === r.id && 'bg-muted')}>
              <span className="size-2 shrink-0 rounded-full" style={{ background: typeColor(r.type) }} />
              <span className="min-w-0 flex-1 truncate text-xs">{r.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{r.type}</span>
            </button>
          ))}
          {!results.length && (
            <p className="px-2 pt-2 text-[11px] text-muted-foreground">Search for anything in the company model, or click a type on the business map and pick one of its top entities.</p>
          )}
        </div>
      </aside>

      {/* Graph */}
      <div className="relative min-h-0 min-w-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-[length:18px_18px]" ref={box}>
        {trail.length > 1 && (
          <div className="absolute top-2 left-3 z-10 flex flex-wrap items-center gap-1 text-[11px]">
            {trail.map((t, i) => (
              <button key={t.id} onClick={() => onFocus(t.id)} className={cn('rounded-full border border-border bg-background px-2 py-0.5 hover:bg-muted', i === trail.length - 1 && 'font-medium')}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        {loading && <Loader2 className="absolute top-3 right-3 z-10 size-4 animate-spin text-muted-foreground" />}
        {!focus ? (
          <div className="flex size-full items-center justify-center text-sm text-muted-foreground">Pick something to explore.</div>
        ) : (
          graph && (
            <ForceGraph2D
              ref={fg}
              width={size.w}
              height={size.h}
              graphData={graph}
              nodeId="id"
              cooldownTicks={120}
              d3VelocityDecay={0.35}
              linkColor={(l: GEdge) => ((l as GEdge).derived ? 'rgba(148,163,184,0.45)' : 'rgba(100,116,139,0.6)')}
              linkWidth={(l: GEdge) => (l.count ? 1 + Math.log10(l.count) : 1)}
              linkLineDash={(l: GEdge) => (l.derived ? [4, 3] : null)}
              linkDirectionalArrowLength={(l: GEdge) => (l.derived ? 0 : 3)}
              linkDirectionalArrowRelPos={0.92}
              onNodeClick={(n: GNode) => (n.kind === 'cluster' ? openCluster(n) : n.focus ? null : onFocus(n.id))}
              nodeCanvasObject={(n: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
                const color = typeColor(n.type)
                const r = n.focus ? 9 : n.kind === 'cluster' ? 7 : 4 + Math.min(4, degree.get(n.id) ?? 0)
                ctx.beginPath()
                if (n.kind === 'cluster') {
                  const w = r * 2.4
                  ctx.roundRect((n.x ?? 0) - w / 2, (n.y ?? 0) - r, w, r * 2, r)
                  ctx.fillStyle = `${color}22`
                  ctx.fill()
                  ctx.strokeStyle = color
                  ctx.setLineDash([2, 2])
                  ctx.lineWidth = 1
                  ctx.stroke()
                  ctx.setLineDash([])
                } else {
                  ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI)
                  ctx.fillStyle = color
                  ctx.fill()
                  if (n.focus) {
                    ctx.lineWidth = 3
                    ctx.strokeStyle = `${color}55`
                    ctx.stroke()
                  }
                }
                const fontSize = Math.max(10 / scale, 2.5)
                ctx.font = `${n.focus ? 600 : 400} ${fontSize}px ui-sans-serif, system-ui`
                ctx.textAlign = 'center'
                ctx.textBaseline = 'top'
                const text = n.label.length > 34 ? `${n.label.slice(0, 32)}…` : n.label
                const tw = ctx.measureText(text).width
                ctx.fillStyle = dark ? 'rgba(10,10,10,0.7)' : 'rgba(255,255,255,0.8)'
                ctx.fillRect((n.x ?? 0) - tw / 2 - 1, (n.y ?? 0) + r + 1, tw + 2, fontSize + 1)
                ctx.fillStyle = dark ? '#e5e7eb' : '#111827'
                ctx.fillText(text, n.x ?? 0, (n.y ?? 0) + r + 1.5)
              }}
              nodePointerAreaPaint={(n: GNode, color: string, ctx: CanvasRenderingContext2D) => {
                ctx.fillStyle = color
                ctx.beginPath()
                ctx.arc(n.x ?? 0, n.y ?? 0, 10, 0, 2 * Math.PI)
                ctx.fill()
              }}
              linkCanvasObjectMode={() => 'after'}
              linkCanvasObject={(l: GEdge, ctx: CanvasRenderingContext2D, scale: number) => {
                if (scale < 1.1 && !l.derived) return
                const s = l.source as GNode
                const t = l.target as GNode
                if (s.x == null || t.x == null) return
                const fontSize = Math.max(8 / scale, 2)
                ctx.font = `${fontSize}px ui-sans-serif, system-ui`
                ctx.fillStyle = dark ? 'rgba(148,163,184,0.85)' : l.derived ? 'rgba(71,85,105,0.9)' : 'rgba(100,116,139,0.9)'
                ctx.textAlign = 'center'
                ctx.textBaseline = 'middle'
                ctx.fillText(l.label.replace(/_/g, ' '), (s.x + t.x) / 2, ((s.y ?? 0) + (t.y ?? 0)) / 2)
              }}
            />
          )
        )}
        <div className="pointer-events-none absolute bottom-2 left-3 text-[10.5px] text-muted-foreground">
          solid = direct link · dashed = through events (e.g. work orders) · rounded = a counted collection (click it)
        </div>
      </div>

      {/* Detail */}
      <aside className="min-h-0 overflow-auto border-l border-border">
        {cluster ? (
          <div className="p-4">
            <button onClick={() => setCluster(null)} className="mb-2 text-[11px] text-muted-foreground hover:text-foreground">
              ← back to the entity
            </button>
            <h3 className="text-sm font-semibold">{cluster.node.label}</h3>
            <p className="mb-2 text-[11px] text-muted-foreground">Newest first (up to 100). Click one to explore it.</p>
            <div className="space-y-0.5">
              {cluster.members.map((m) => (
                <button key={m.id} onClick={() => onFocus(m.id)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted">
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="text-[10.5px] text-muted-foreground">{m.date}</span>
                  {m.amount && <span className="font-mono text-[10.5px] tabular-nums">${Number(m.amount).toLocaleString()}</span>}
                </button>
              ))}
            </div>
          </div>
        ) : focus ? (
          <EntityPanel slug={slug} id={focus} onFocus={onFocus} onOpenFile={onOpenFile} />
        ) : null}
      </aside>
    </div>
  )
}
