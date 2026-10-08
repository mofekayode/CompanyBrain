'use client'

// Company model (FDE view): the business map, a knowledge graph explorer, and
// the review list. Internal and deliberately simple.

import { ChevronLeft, Loader2, Play } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { API } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FileViewer } from '../workbench/file-viewer'
import { BusinessMap, type MapLink, type MapType } from './business-map'
import { typeColor } from './colors'
import { Explorer } from './explorer'

interface ModelData {
  types: MapType[]
  links: MapLink[]
  resolution: { merged: number; rejected: number; unsure: number }
  notes: string[]
  proposed_at: string | null
}

export function ModelPage({ slug }: { slug: string }) {
  const base = `${API}/api/t/${slug}/model`
  const [tab, setTab] = useState<'map' | 'explore' | 'review'>('map')
  const [data, setData] = useState<ModelData | null>(null)
  const [showEvents, setShowEvents] = useState(false)
  const [selected, setSelected] = useState<MapType | null>(null)
  const [top, setTop] = useState<{ id: string; name: string; degree: number }[]>([])
  const [focus, setFocus] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // Deep links: ?focus=<entity id> opens the explorer on that entity.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const t = params.get('tab')
    if (t === 'map' || t === 'explore' || t === 'review') setTab(t)
    const f = params.get('focus')
    if (f) {
      setFocus(f)
      setTab('explore')
    }
  }, [])
  useEffect(() => {
    const url = new URL(window.location.href)
    if (focus && tab === 'explore') url.searchParams.set('focus', focus)
    else url.searchParams.delete('focus')
    window.history.replaceState(null, '', url)
  }, [focus, tab])

  const load = useCallback(() => fetch(base).then((r) => r.json()).then(setData), [base])
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    if (!selected) return setTop([])
    fetch(`${base}/types/${selected.id}/top`).then((r) => r.json()).then(setTop)
  }, [selected, base])

  const explore = (id: string) => {
    setFocus(id)
    setTab('explore')
  }
  async function run(reuse: boolean) {
    setRunning(true)
    await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reuse }) })
    setRunning(false)
    alert('Started. Follow it in the workbench Activity tab; refresh this page when it finishes.')
  }

  const things = data?.types.filter((t) => t.kind === 'thing' && t.entities > 0) ?? []
  const events = data?.types.filter((t) => t.kind === 'event' && t.entities > 0) ?? []
  const total = (xs: MapType[]) => xs.reduce((a, t) => a + t.entities, 0)

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <h1 className="text-sm font-semibold">Company model</h1>
        {data && (
          <span className="text-xs text-muted-foreground">
            {things.length} kinds of things ({total(things).toLocaleString()}) · {events.length} kinds of activity ({total(events).toLocaleString()}) ·{' '}
            {data.resolution.merged.toLocaleString()} duplicates merged · {data.resolution.unsure} to review
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => run(true)} disabled={running}>
            Reload + resolve
          </Button>
          <Button size="sm" variant="outline" onClick={() => run(false)} disabled={running}>
            {running ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}
            Re-propose model
          </Button>
        </div>
      </header>
      <nav className="flex shrink-0 items-center gap-1 border-b border-border px-4 pt-2">
        {(
          [
            ['map', 'Business map'],
            ['explore', 'Explore'],
            ['review', 'Types & notes'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn('-mb-px border-b-2 px-3 pb-2 text-xs font-medium', tab === key ? 'border-signal text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {label}
          </button>
        ))}
        {tab === 'map' && (
          <label className="ml-auto flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} />
            show activity (work orders, invoices, payments…)
          </label>
        )}
      </nav>

      <main className="min-h-0 flex-1">
        {!data ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : !data.types.length ? (
          <div className="p-6 text-sm text-muted-foreground">No company model yet. Click “Re-propose model”.</div>
        ) : tab === 'map' ? (
          <div className="grid h-full grid-cols-[minmax(0,1fr)_22rem]">
            <BusinessMap types={data.types} links={data.links} showEvents={showEvents} selected={selected?.id ?? null} onSelect={setSelected} />
            <aside className="min-h-0 overflow-auto border-l border-border p-4">
              {selected ? (
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="size-2.5 rounded-full" style={{ background: typeColor(selected.name) }} />
                    <h3 className="text-sm font-semibold">{selected.name}</h3>
                    <span className="text-xs text-muted-foreground">{selected.entities.toLocaleString()}</span>
                  </div>
                  <p className="mb-2 text-xs text-muted-foreground">{selected.description}</p>
                  <h4 className="mt-3 mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Most connected</h4>
                  <div className="space-y-0.5">
                    {top.map((e) => (
                      <button key={e.id} onClick={() => explore(e.id)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted">
                        <span className="min-w-0 flex-1 truncate">{e.name}</span>
                        <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{e.degree.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-3 text-xs text-muted-foreground">
                  <p>
                    <b className="text-foreground">How to read this.</b> Each card is a kind of thing in the business, with how many exist. Arrows are how they relate, with how many links back them.
                    Activity (work orders, invoices, payments) is hidden by default and shown as “via work orders” links; tick the box above to see it.
                  </p>
                  <p>Click a card to see its most connected members, then explore any of them.</p>
                  <div className="space-y-1">
                    {things.map((t) => (
                      <button key={t.id} onClick={() => setSelected(t)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted">
                        <span className="size-2 rounded-full" style={{ background: typeColor(t.name) }} />
                        <span className="min-w-0 flex-1 truncate text-foreground">{t.name}</span>
                        <span className="font-mono tabular-nums">{t.entities.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </div>
        ) : tab === 'explore' ? (
          <Explorer slug={slug} focus={focus} onFocus={setFocus} onOpenFile={setFile} />
        ) : (
          <Review base={base} data={data} onChange={load} />
        )}
      </main>
      <FileViewer slug={slug} fileId={file} list={file ? [file] : []} onNavigate={setFile} onClose={() => setFile(null)} />
    </div>
  )
}

function Review({ base, data, onChange }: { base: string; data: ModelData; onChange: () => void }) {
  async function setStatus(id: string, status: string) {
    await fetch(`${base}/types/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) })
    onChange()
  }
  return (
    <div className="grid h-full grid-cols-2 overflow-auto">
      <div className="border-r border-border p-5">
        <h3 className="mb-2 text-sm font-semibold">What the model says about how the business works</h3>
        <ul className="list-disc space-y-1.5 pl-5 text-[12.5px]">
          {data.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
      <div className="p-5">
        <h3 className="mb-2 text-sm font-semibold">Types (accept what is right; reject what is not)</h3>
        <table className="w-full text-[12px]">
          <tbody>
            {data.types.map((t) => (
              <tr key={t.id} className="border-t border-border align-top">
                <td className="py-1.5 pr-2">
                  <span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: typeColor(t.name) }} />
                  <b>{t.name}</b> <span className="text-muted-foreground">{t.kind === 'event' ? '(activity)' : ''}</span>
                  <div className="text-[11px] text-muted-foreground">{t.description}</div>
                </td>
                <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{t.entities.toLocaleString()}</td>
                <td className="py-1.5 whitespace-nowrap">
                  <span className={cn('mr-2 text-[11px]', t.status === 'active' ? 'text-ok' : t.status === 'rejected' ? 'text-destructive' : 'text-muted-foreground')}>{t.status}</span>
                  <Button size="xs" variant="outline" onClick={() => setStatus(t.id, 'active')}>
                    Accept
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setStatus(t.id, 'rejected')}>
                    Reject
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
