'use client'

import { CheckCircle2, ChevronLeft, CircleAlert, FolderUp, Loader2, Trash2, Upload, X } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { formatBytes } from './types'
import { API } from '@/lib/api'

type Status = 'staged' | 'hashing' | 'uploading' | 'verifying' | 'done' | 'exists' | 'error'

interface Item {
  key: string
  file: File
  pile: string // top-level folder as dropped (becomes a source)
  relativePath: string // path inside the pile
  status: Status
  progress: number
  error?: string
}

const CONCURRENCY = 3
const LOOSE = 'Uploads'

// ---- reading dropped folders -------------------------------------------------

async function readEntry(entry: FileSystemEntry, prefix: string, out: { file: File; path: string }[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    out.push({ file, path: prefix + entry.name })
    return
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
    if (batch.length === 0) break
    for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out)
  }
}

function split(path: string): { pile: string; relativePath: string } {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? { pile: parts[0], relativePath: parts.slice(1).join('/') } : { pile: LOOSE, relativePath: parts[0] }
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function put(url: string, headers: Record<string, string>, file: File, onProgress: (p: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => resolve(xhr.status)
    xhr.onerror = () => reject(new Error('network error during upload'))
    xhr.send(file)
  })
}

// ---- component ---------------------------------------------------------------

export function Uploader({ slug, clientName }: { slug: string; clientName: string }) {
  const [items, setItems] = useState<Item[]>([])
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<'staging' | 'uploading' | 'finished'>('staging')
  const [dragging, setDragging] = useState(false)
  const folderInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  function stage(found: { file: File; path: string }[]) {
    setItems((prev) => {
      const seen = new Set(prev.map((i) => i.key))
      const next = [...prev]
      for (const { file, path } of found) {
        const { pile, relativePath } = split(path)
        const key = `${pile}/${relativePath}`
        if (!seen.has(key)) next.push({ key, file, pile, relativePath, status: 'staged', progress: 0 })
      }
      return next
    })
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (phase !== 'staging') return
    const out: { file: File; path: string }[] = []
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x)
    for (const entry of entries) await readEntry(entry, '', out)
    stage(out)
  }

  const piles = useMemo(() => {
    const m = new Map<string, { count: number; bytes: number; done: number }>()
    for (const i of items) {
      const p = m.get(i.pile) ?? { count: 0, bytes: 0, done: 0 }
      p.count++
      p.bytes += i.file.size
      if (i.status === 'done' || i.status === 'exists') p.done++
      m.set(i.pile, p)
    }
    return [...m.entries()]
  }, [items])

  const totals = useMemo(() => {
    const bytes = items.reduce((n, i) => n + i.file.size, 0)
    const sent = items.reduce((n, i) => n + (i.status === 'done' || i.status === 'exists' ? i.file.size : i.status === 'uploading' ? i.file.size * i.progress : 0), 0)
    return {
      files: items.length,
      bytes,
      pct: bytes ? (sent / bytes) * 100 : 0,
      done: items.filter((i) => i.status === 'done' || i.status === 'exists').length,
      errors: items.filter((i) => i.status === 'error').length,
    }
  }, [items])

  const update = (key: string, patch: Partial<Item>) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)))

  async function uploadOne(runId: string, item: Item) {
    const api = `${API}/api/t/${slug}/uploads/${runId}`
    const call = async (step: string, body: unknown) => {
      const r = await fetch(`${api}/${step}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `${step} failed (${r.status})`)
      return j
    }
    try {
      update(item.key, { status: 'hashing', error: undefined })
      const descriptor = {
        sourceName: renames[item.pile]?.trim() || item.pile,
        relativePath: item.relativePath,
        size: item.file.size,
        sha256: await sha256Hex(item.file),
        contentType: item.file.type || undefined,
        lastModified: item.file.lastModified,
      }
      const signed = await call('sign', descriptor)
      if (signed.status === 'upload') {
        update(item.key, { status: 'uploading', progress: 0 })
        const status = await put(signed.url, signed.headers, item.file, (p) => update(item.key, { progress: p }))
        // 412 = these bytes are already at this key (e.g. a retried upload); completing verifies them.
        if (status !== 200 && status !== 412) throw new Error(status === 400 ? 'storage rejected the bytes (checksum mismatch)' : `upload failed (HTTP ${status})`)
      }
      update(item.key, { status: 'verifying', progress: 1 })
      await call('complete', descriptor)
      update(item.key, { status: signed.status === 'exists' ? 'exists' : 'done' })
    } catch (error) {
      update(item.key, { status: 'error', error: (error as Error).message })
    }
  }

  async function start() {
    setPhase('uploading')
    const { runId } = await fetch(`${API}/api/t/${slug}/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())
    await run(runId, items)
    await fetch(`${API}/api/t/${slug}/uploads/${runId}/finish`, { method: 'POST' })
    setPhase('finished')
  }

  async function run(runId: string, list: Item[]) {
    const queue = [...list]
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let it = queue.shift(); it; it = queue.shift()) await uploadOne(runId, it)
      }),
    )
  }

  return (
    <div className="h-full overflow-auto bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-6">
          <Link href={`/t/${slug}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" />
            {clientName}
          </Link>
          <span className="text-sm text-muted-foreground">/</span>
          <span className="text-sm font-medium">Upload files</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold">Upload the client’s files</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drop folders exactly as the client gave them. Each top-level folder becomes a source. Files are stored untouched (write-once, checksum-verified); zips are
            unpacked and everything is profiled automatically.
          </p>
        </div>

        {phase === 'staging' && (
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors',
              dragging ? 'border-signal bg-signal/5' : 'border-border',
            )}
          >
            <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-signal/10 text-signal">
              <FolderUp className="size-6" />
            </div>
            <div className="text-sm font-medium">Drag folders, files or zips here</div>
            <div className="mt-1 text-xs text-muted-foreground">Nothing is cleaned or renamed. Duplicates and odd filenames are kept as evidence.</div>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" size="sm" onClick={() => folderInput.current?.click()}>
                Choose folder
              </Button>
              <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()}>
                Choose files
              </Button>
            </div>
            <input
              ref={folderInput}
              type="file"
              className="hidden"
              multiple
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(e) => {
                stage([...(e.target.files ?? [])].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })))
                e.target.value = ''
              }}
            />
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              multiple
              onChange={(e) => {
                stage([...(e.target.files ?? [])].map((f) => ({ file: f, path: f.name })))
                e.target.value = ''
              }}
            />
          </div>
        )}

        {items.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">
                  {totals.files} files · {formatBytes(totals.bytes)} · {piles.length} source{piles.length === 1 ? '' : 's'}
                </h2>
                {phase !== 'staging' && (
                  <p className="text-xs text-muted-foreground">
                    {totals.done}/{totals.files} stored{totals.errors ? ` · ${totals.errors} failed` : ''}
                  </p>
                )}
              </div>
              {phase === 'staging' && (
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setItems([])}>
                    Clear
                  </Button>
                  <Button size="sm" onClick={start}>
                    <Upload data-icon="inline-start" />
                    Upload {totals.files} files
                  </Button>
                </div>
              )}
              {phase === 'finished' && (
                <div className="flex gap-2">
                  {totals.errors > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        setPhase('uploading')
                        const { runId } = await fetch(`${API}/api/t/${slug}/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())
                        await run(runId, items.filter((i) => i.status === 'error'))
                        await fetch(`${API}/api/t/${slug}/uploads/${runId}/finish`, { method: 'POST' })
                        setPhase('finished')
                      }}
                    >
                      Retry {totals.errors} failed
                    </Button>
                  )}
                  <Button size="sm" nativeButton={false} render={<Link href={`/t/${slug}`} />}>
                    Open workbench
                  </Button>
                </div>
              )}
            </div>

            {phase !== 'staging' && (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-signal transition-all" style={{ width: `${totals.pct}%` }} />
              </div>
            )}
            {phase === 'finished' && (
              <p className="rounded-lg bg-ok/10 px-3 py-2 text-xs">
                Upload finished. The worker is now unpacking zips and profiling every file. Follow progress in the workbench’s Profiling card.
              </p>
            )}

            <div className="space-y-2">
              {piles.map(([pile, info]) => (
                <details key={pile} className="group rounded-xl border border-border bg-card" open={piles.length <= 3}>
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                    <FolderUp className="size-4 shrink-0 text-muted-foreground" />
                    {phase === 'staging' ? (
                      <Input
                        value={renames[pile] ?? pile}
                        onChange={(e) => setRenames((r) => ({ ...r, [pile]: e.target.value }))}
                        onClick={(e) => e.preventDefault()}
                        className="h-7 max-w-xs text-sm font-medium"
                        aria-label="Source name"
                      />
                    ) : (
                      <span className="text-sm font-medium">{renames[pile]?.trim() || pile}</span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {phase === 'staging' ? `${info.count} files · ${formatBytes(info.bytes)}` : `${info.done}/${info.count}`}
                    </span>
                    {phase === 'staging' && (
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          setItems((prev) => prev.filter((i) => i.pile !== pile))
                        }}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="Remove source"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </summary>
                  <ul className="max-h-80 overflow-y-auto border-t border-border">
                    {items
                      .filter((i) => i.pile === pile)
                      .map((i) => (
                        <li key={i.key} className="flex items-center gap-3 border-b border-border/50 px-4 py-1.5 text-xs last:border-b-0">
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={i.relativePath}>
                            {i.relativePath}
                          </span>
                          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">{formatBytes(i.file.size)}</span>
                          <StatusBadge item={i} />
                          {phase === 'staging' && (
                            <button onClick={() => setItems((prev) => prev.filter((x) => x.key !== i.key))} className="text-muted-foreground hover:text-destructive" aria-label="Remove file">
                              <X className="size-3.5" />
                            </button>
                          )}
                        </li>
                      ))}
                  </ul>
                </details>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function StatusBadge({ item }: { item: Item }) {
  switch (item.status) {
    case 'staged':
      return null
    case 'hashing':
      return <span className="flex w-24 items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" />hashing</span>
    case 'uploading':
      return (
        <span className="flex w-24 items-center gap-1.5">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full bg-signal" style={{ width: `${item.progress * 100}%` }} />
          </span>
          <span className="w-7 text-right tabular-nums text-muted-foreground">{Math.round(item.progress * 100)}%</span>
        </span>
      )
    case 'verifying':
      return <span className="flex w-24 items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" />verifying</span>
    case 'done':
      return <span className="flex w-24 items-center gap-1 text-ok"><CheckCircle2 className="size-3" />stored</span>
    case 'exists':
      return <span className="flex w-24 items-center gap-1 text-muted-foreground"><CheckCircle2 className="size-3" />already there</span>
    case 'error':
      return (
        <span className="flex w-48 items-center gap-1 truncate text-destructive" title={item.error}>
          <CircleAlert className="size-3 shrink-0" />
          {item.error}
        </span>
      )
  }
}
