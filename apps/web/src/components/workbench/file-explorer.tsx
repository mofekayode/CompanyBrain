'use client'

import { ChevronRight, Copy, ScanLine, Search, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { formatBytes, formatIcon, type InventoryFile } from './types'

type Filter = 'all' | 'issues' | 'duplicates' | 'scans'

const FILTERS: { key: Filter; label: string; test: (f: InventoryFile) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'issues', label: 'Issues', test: (f) => !f.integrity_ok },
  { key: 'duplicates', label: 'Duplicates', test: (f) => f.duplicate_copies > 1 },
  { key: 'scans', label: 'Scans', test: (f) => !!f.likely_scanned },
]

export function FileExplorer(props: { files: InventoryFile[]; highlighted: Set<string>; onOpen: (id: string, list?: string[]) => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const test = FILTERS.find((f) => f.key === filter)!.test
    const bySource = new Map<string, InventoryFile[]>()
    for (const f of props.files) {
      if (!test(f)) continue
      if (q && !f.original_path.toLowerCase().includes(q) && !f.format.includes(q)) continue
      bySource.set(f.source_name, [...(bySource.get(f.source_name) ?? []), f])
    }
    return [...bySource.entries()]
  }, [props.files, query, filter])

  // The files currently visible (search + filter applied), in display order: the viewer steps through these.
  const visibleIds = useMemo(() => groups.flatMap(([, files]) => files.map((f) => f.id)), [groups])
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, props.files.filter(f.test).length])), [props.files])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search paths…" className="h-8 pl-8 text-xs" />
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                filter === f.key ? 'border-foreground/20 bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label} <span className="tabular-nums opacity-60">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        {groups.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No files match.</p>}
        {groups.map(([source, files]) => (
          // Keyed by filter state so the default open state applies on remount instead of changing in place.
          <Collapsible key={`${source}|${filter}|${query ? 'q' : ''}`} defaultOpen={groups.length <= 3 || !!query || filter !== 'all'}>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-medium hover:bg-muted">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
              <span className="truncate">{source}</span>
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{files.length}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mb-1 ml-3 border-l border-border/60 pl-1">
                {files.map((f) => (
                  <FileRow key={f.id} file={f} highlighted={props.highlighted.has(f.id)} onOpen={(id) => props.onOpen(id, visibleIds)} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    </div>
  )
}

function FileRow({ file, highlighted, onOpen }: { file: InventoryFile; highlighted: boolean; onOpen: (id: string) => void }) {
  const Icon = formatIcon(file.format, file.category)
  const dir = file.original_path.includes('/') ? file.original_path.slice(0, file.original_path.lastIndexOf('/')) : ''
  return (
    <li>
      <button
        onClick={() => onOpen(file.id)}
        title={file.original_path}
        className={cn(
          'group flex w-full items-start gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted',
          highlighted && 'bg-signal/10 ring-1 ring-signal/30',
        )}
      >
        <Icon className={cn('mt-0.5 size-3.5 shrink-0', highlighted ? 'text-signal' : 'text-muted-foreground')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">{file.original_filename}</span>
          {dir && <span className="block truncate font-mono text-[10px] text-muted-foreground/70">{dir}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1 pt-0.5">
          {!file.integrity_ok && <TriangleAlert className="size-3 text-warn" />}
          {file.duplicate_copies > 1 && <Copy className="size-3 text-muted-foreground" />}
          {file.likely_scanned && <ScanLine className="size-3 text-muted-foreground" />}
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{formatBytes(file.size_bytes)}</span>
        </span>
      </button>
    </li>
  )
}
