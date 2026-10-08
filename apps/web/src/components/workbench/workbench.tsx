'use client'

import { History, Plus, Upload } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import type { NextSteps } from '@companybrain/core/workbench/next-steps'
import type { WorkbenchUIMessage } from '@companybrain/core/workbench/ui-message'
import { ActivityPanel } from './activity-panel'
import { AgentChat } from './agent-chat'
import { FileExplorer } from './file-explorer'
import { FileViewer } from './file-viewer'
import { type Note, NotesPanel } from './notes-panel'
import { ExtractionCard } from './extraction-card'
import { ProfilingCard } from './profiling-card'
import { QuestionsPanel } from './questions-panel'
import type { InventoryFile, QuestionRow, SessionRow } from './types'
import { API } from '@/lib/api'

const LAYOUT_KEY = 'workbench.layout.v1'

function setSessionInUrl(id: string | null) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('s', id)
  else url.searchParams.delete('s')
  window.history.replaceState(null, '', url)
}

export function Workbench({ slug }: { slug: string }) {
  const [tenant, setTenant] = useState<{ name: string } | null>(null)
  const [files, setFiles] = useState<InventoryFile[]>([])
  const [questions, setQuestions] = useState<QuestionRow[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Changing the key remounts the chat with a different session's stored messages.
  const [chat, setChat] = useState<{ key: string; messages: WorkbenchUIMessage[] }>({ key: 'new', messages: [] })
  const [busy, setBusy] = useState(false)
  const [viewer, setViewer] = useState<{ id: string; list: string[] } | null>(null)
  const setOpenFile = useCallback((id: string | null, list?: string[]) => setViewer(id ? { id, list: list?.includes(id) ? list : [id] } : null), [])
  const [touched, setTouched] = useState<string[]>([])
  const [hoverEvidence, setHoverEvidence] = useState<string[]>([])
  const sendRef = useRef<(text: string) => void>(() => {})
  const [rightTab, setRightTab] = useState<'questions' | 'notes' | 'activity'>('questions')
  const [activityKey, setActivityKey] = useState(0)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('panel') === 'activity') setRightTab('activity')
  }, [])
  const showActivity = useCallback(() => {
    setRightTab('activity')
    setActivityKey((k) => k + 1)
  }, [])
  const [notes, setNotes] = useState<Note[]>([])
  const loadNotes = useCallback(() => fetch(`${API}/api/t/${slug}/notes`).then((r) => r.json()).then(setNotes), [slug])
  const saveNote = useCallback(
    async (n: { title: string; body: string; sessionId: string | null }) => {
      const kind = /discovery summary|what the handed-over files show/i.test(n.title + n.body.slice(0, 300)) ? 'discovery_summary' : 'note'
      await fetch(`${API}/api/t/${slug}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...n, kind }) })
      await loadNotes()
    },
    [slug, loadNotes],
  )
  // Panel widths are remembered per browser; render panels only once we know them (avoids a size jump).
  const [layout, setLayout] = useState<Record<string, number> | null | undefined>(undefined)
  useEffect(() => {
    try {
      setLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null'))
    } catch {
      setLayout(null)
    }
  }, [])

  const [next, setNext] = useState<NextSteps | null>(null)
  const loadNext = useCallback(() => fetch(`${API}/api/t/${slug}/next-steps`).then((r) => r.json()).then(setNext), [slug])
  // Questions and the workflow stage change together (findings recorded, reviewed, files profiled).
  const loadQuestions = useCallback(
    () => Promise.all([fetch(`${API}/api/t/${slug}/questions`).then((r) => r.json()).then(setQuestions), loadNext()]),
    [slug, loadNext],
  )
  const loadSessions = useCallback(() => fetch(`${API}/api/t/${slug}/sessions`).then((r) => r.json()).then(setSessions), [slug])

  const loadInventory = useCallback(
    () =>
      fetch(`${API}/api/t/${slug}/inventory`)
        .then((r) => r.json())
        .then((d) => {
          setTenant(d.tenant)
          setFiles(d.files ?? [])
        }),
    [slug],
  )

  useEffect(() => {
    loadInventory()
    loadQuestions()
    loadSessions()
    loadNotes()
    // Reopen the session in the URL (?s=…) so a refresh returns to the same conversation.
    const s = new URLSearchParams(window.location.search).get('s')
    if (s) openSession(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, loadInventory, loadQuestions, loadSessions, loadNotes])

  const highlighted = useMemo(() => new Set([...touched, ...hoverEvidence]), [touched, hoverEvidence])

  async function openSession(id: string) {
    const res = await fetch(`${API}/api/t/${slug}/sessions/${id}`)
    if (!res.ok) return setSessionInUrl(null)
    const d = await res.json()
    setSessionId(id)
    setSessionInUrl(id)
    setChat({ key: id, messages: d.messages ?? [] })
  }

  function newSession() {
    setSessionId(null)
    setSessionInUrl(null)
    setChat({ key: `new-${Date.now()}`, messages: [] })
  }

  async function review(findingId: string, status: 'confirmed' | 'rejected' | 'hypothesis') {
    await fetch(`${API}/api/t/${slug}/findings/${findingId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) })
    loadQuestions()
  }

  const stats = useMemo(() => {
    const bytes = files.reduce((n, f) => n + Number(f.size_bytes), 0)
    return { files: files.length, sources: new Set(files.map((f) => f.source_name)).size, mb: (bytes / 1048576).toFixed(0) }
  }, [files])

  const onSessionCreated = useCallback(
    (id: string) => {
      setSessionId(id)
      setSessionInUrl(id)
      loadSessions()
    },
    [loadSessions],
  )
  const onTurnEnd = useCallback(() => {
    loadSessions()
    loadQuestions()
    loadInventory() // the agent may have profiled files
  }, [loadSessions, loadQuestions, loadInventory])
  const onProfiled = useCallback(() => {
    loadInventory()
    loadNext()
  }, [loadInventory, loadNext])
  const registerSend = useCallback((send: (text: string) => void) => {
    sendRef.current = send
  }, [])

  if (layout === undefined) return <div className="h-full bg-background" />

  return (
    <div className="h-full overflow-hidden">
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={layout ?? undefined}
        onLayoutChanged={(l) => {
          try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(l))
          } catch {}
        }}
      >
      {/* Left: raw evidence */}
      <ResizablePanel id="files" defaultSize="20" minSize="12" maxSize="45">
      <aside className="flex h-full min-h-0 flex-col bg-muted/20">
        <div className="border-b border-border px-4 py-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              ['files', stats.files],
              ['sources', stats.sources],
              ['MB', stats.mb],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border bg-background px-2 py-1.5">
                <div className="font-mono text-sm font-semibold tabular-nums">{v}</div>
                <div className="text-[10px] text-muted-foreground">{k}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-2 px-3 pt-3">
          <ProfilingCard slug={slug} onProfiled={onProfiled} onStarted={showActivity} />
          <ExtractionCard slug={slug} onChange={onProfiled} onStarted={showActivity} />
          <Button size="sm" variant="outline" className="w-full" nativeButton={false} render={<Link href={`/t/${slug}/upload`} />}>
            <Upload data-icon="inline-start" />
            Upload files
          </Button>
        </div>
        <div className="px-4 pt-3 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Raw evidence</div>
        <div className="min-h-0 flex-1">
          <FileExplorer files={files} highlighted={highlighted} onOpen={setOpenFile} />
        </div>
      </aside>
      </ResizablePanel>
      <ResizableHandle withHandle className="hover:bg-signal/50 data-[separator=active]:bg-signal" />

      {/* Center: agent */}
      <ResizablePanel id="chat" defaultSize="54" minSize="30">
      <main className="flex h-full min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="truncate text-sm font-medium">{sessions.find((s) => s.id === sessionId)?.title ?? 'New discovery session'}</span>
          {busy && (
            <span className="flex items-center gap-1.5 rounded-full bg-signal/10 px-2 py-0.5 text-[11px] text-signal">
              <span className="size-1.5 animate-pulse rounded-full bg-signal" />
              Agent working
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" disabled={busy} />}>
                <History data-icon="inline-start" />
                History
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                {sessions.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No sessions yet.</div>}
                {sessions.map((s) => (
                  <DropdownMenuItem key={s.id} onClick={() => openSession(s.id)} className="flex flex-col items-start gap-0">
                    <span className="w-full truncate text-xs">{s.title}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(s.updated_at).toLocaleString()} · {s.steps} steps
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" size="sm" onClick={newSession} disabled={busy}>
              <Plus data-icon="inline-start" />
              New
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <AgentChat
            key={chat.key}
            slug={slug}
            sessionId={sessionId}
            initialMessages={chat.messages}
            nextSteps={next}
            onSessionCreated={onSessionCreated}
            onFinding={loadQuestions}
            onTurnEnd={onTurnEnd}
            onBusyChange={setBusy}
            onTouchedFiles={setTouched}
            onOpenFile={setOpenFile}
            registerSend={registerSend}
            onSaveNote={saveNote}
          />
        </div>
      </main>
      </ResizablePanel>
      <ResizableHandle withHandle className="hover:bg-signal/50 data-[separator=active]:bg-signal" />

      {/* Right: the questions */}
      <ResizablePanel id="questions" defaultSize="26" minSize="16" maxSize="55">
      <aside className="flex h-full min-h-0 flex-col bg-muted/20">
        <div className="flex shrink-0 gap-1 border-b border-border px-3 pt-2">
          {(
            [
              ['questions', 'Questions'],
              ['notes', `Notes${notes.length ? ` · ${notes.length}` : ''}`],
              ['activity', 'Activity'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setRightTab(key)}
              className={`-mb-px border-b-2 px-2.5 pb-2 text-xs font-medium transition-colors ${rightTab === key ? 'border-signal text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
        {rightTab === 'activity' ? (
          <ActivityPanel slug={slug} onOpenFile={setOpenFile} refreshKey={activityKey} />
        ) : rightTab === 'notes' ? (
          <NotesPanel notes={notes} />
        ) : (
        <QuestionsPanel
          questions={questions}
          busy={busy}
          onAsk={(q) => sendRef.current(`Investigate question ${q.id}: "${q.question}". Look at the evidence, then record a finding.`)}
          onReview={review}
          onOpenFile={setOpenFile}
          onHoverEvidence={setHoverEvidence}
        />
        )}
        </div>
      </aside>
      </ResizablePanel>
      </ResizablePanelGroup>

      <FileViewer slug={slug} fileId={viewer?.id ?? null} list={viewer?.list ?? []} onNavigate={(id) => setViewer((v) => (v ? { ...v, id } : v))} onClose={() => setOpenFile(null)} onReextract={showActivity} />
    </div>
  )
}
