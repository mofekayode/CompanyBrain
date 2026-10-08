'use client'

import { LogoMark } from '@/components/shell/logo'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type DynamicToolUIPart } from 'ai'
import {
  BookMarked,
  Check,
  ChevronRight,
  Database,
  FileSearch,
  FolderTree,
  ListChecks,
  NotebookPen,
  Loader2,
  ScrollText,
  ScanSearch,
  Search,
  Sparkles,
  BarChart3,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { NextSteps } from '@companybrain/core/workbench/next-steps'
import type { ToolOutputView, WorkbenchUIMessage } from '@companybrain/core/workbench/ui-message'
import { cn } from '@/lib/utils'
import { type ChartSpec, ChartView } from './chart-view'
import { API } from '@/lib/api'

const TOOL_META: Record<string, { icon: LucideIcon; label: string }> = {
  list_sources: { icon: FolderTree, label: 'Sources' },
  search_inventory: { icon: Search, label: 'Search' },
  query_inventory: { icon: Database, label: 'SQL' },
  get_file_profile: { icon: FileSearch, label: 'Profile' },
  read_file: { icon: ScrollText, label: 'Read' },
  list_questions: { icon: ListChecks, label: 'Questions' },
  record_finding: { icon: BookMarked, label: 'Finding' },
  run_profiling: { icon: ScanSearch, label: 'Profile' },
  render_chart: { icon: BarChart3, label: 'Chart' },
}


export interface AgentChatHandle {
  send: (text: string) => void
}

export function AgentChat(props: {
  slug: string
  sessionId: string | null
  initialMessages: WorkbenchUIMessage[]
  nextSteps: NextSteps | null
  onSessionCreated: (id: string) => void
  onFinding: () => void
  onTurnEnd: () => void
  onBusyChange: (busy: boolean) => void
  onTouchedFiles: (ids: string[]) => void
  onOpenFile: (id: string) => void
  registerSend: (send: (text: string) => void) => void
  onSaveNote: (note: { title: string; body: string; sessionId: string | null }) => Promise<void>
}) {
  const sessionRef = useRef<string | null>(props.sessionId)
  const transport = useMemo(
    () =>
      new DefaultChatTransport<WorkbenchUIMessage>({
        api: `${API}/api/t/${props.slug}/chat`,
        // The server owns conversation state; send only the session and the new text.
        prepareSendMessagesRequest: ({ messages }) => {
          const last = messages.at(-1)
          const text = last?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? ''
          return { body: { sessionId: sessionRef.current, text } }
        },
      }),
    [props.slug],
  )

  const { messages, sendMessage, setMessages, status, stop, error } = useChat<WorkbenchUIMessage>({
    messages: props.initialMessages,
    transport,
    onData: (part) => {
      if (part.type === 'data-session') {
        sessionRef.current = part.data.id
        props.onSessionCreated(part.data.id)
      }
      if (part.type === 'data-finding') props.onFinding()
    },
    onFinish: () => props.onTurnEnd(),
    onError: () => props.onTurnEnd(),
  })

  // If this chat remounts for an existing session without its messages (e.g. hot reload), fetch them.
  const { sessionId: initialSessionId, initialMessages, slug } = props
  useEffect(() => {
    if (!initialSessionId || initialMessages.length > 0) return
    fetch(`${API}/api/t/${slug}/sessions/${initialSessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.messages && setMessages(d.messages))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const busy = status === 'submitted' || status === 'streaming'
  // The agent runs on the Claude API; when that's switched off (no API spend) the chat is read-only.
  const [apiOn, setApiOn] = useState(true)
  useEffect(() => {
    fetch(`${API}/api/status`)
      .then((r) => r.json())
      .then((s) => setApiOn(!!s?.claude_api))
      .catch(() => {})
  }, [])
  const { onBusyChange, onTouchedFiles, registerSend } = props
  useEffect(() => onBusyChange(busy), [busy, onBusyChange])
  useEffect(() => registerSend((text) => sendMessage({ text })), [registerSend, sendMessage])

  // Files the agent touched light up in the explorer.
  useEffect(() => {
    const ids = new Set<string>()
    for (const m of messages)
      for (const p of m.parts) {
        if (p.type !== 'dynamic-tool') continue
        const input = p.input as { id?: string; evidence?: { source_object_id: string }[] } | undefined
        if (input?.id) ids.add(input.id)
        for (const e of input?.evidence ?? []) ids.add(e.source_object_id)
      }
    onTouchedFiles([...ids])
  }, [messages, onTouchedFiles])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-5 px-6 py-6">
          {messages.length === 0 ? (
            <EmptyState nextSteps={props.nextSteps} disabled={busy || !apiOn} onPick={(t) => sendMessage({ text: t })} />
          ) : (
            messages.map((m, i) => (
              <ChatMessage
                key={m.id}
                message={m}
                live={busy && i === messages.length - 1}
                onOpenFile={props.onOpenFile}
                onSave={(title, body) => props.onSaveNote({ title, body, sessionId: sessionRef.current })}
              />
            ))
          )}
          {status === 'submitted' && messages.at(-1)?.role === 'user' && (
            <div className="flex items-center gap-2 text-sm">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-signal opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-signal" />
              </span>
              <span className="shimmer-text">Starting…</span>
            </div>
          )}
          {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error.message}</div>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0 px-6 pb-5">
        {messages.length > 0 && !busy && props.nextSteps && props.nextSteps.suggestions.length > 0 && (
          <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-1.5">
            <span className="mr-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Sparkles className="size-3 text-signal" />
              Next
            </span>
            {props.nextSteps.suggestions.slice(0, 3).map((s) => (
              <button
                key={s.label}
                onClick={() => sendMessage({ text: s.prompt })}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                  s.primary ? 'border-signal/40 bg-signal/10 text-foreground hover:bg-signal/20' : 'border-border text-muted-foreground hover:border-signal/30 hover:text-foreground',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        <PromptInput
          className="mx-auto w-full max-w-3xl rounded-2xl shadow-sm"
          onSubmit={({ text }) => {
            if (text.trim() && !busy && apiOn) sendMessage({ text })
          }}
        >
          <PromptInputTextarea
            disabled={!apiOn}
            placeholder={apiOn ? 'Ask the agent to investigate the raw evidence…' : 'The agent is off: Claude API calls are disabled (no API spend). Investigate in a Claude Code session.'}
          />
          <PromptInputFooter>
            <span className={cn('text-[11px]', apiOn ? 'text-muted-foreground' : 'text-stale')}>
              {apiOn ? 'Claude Opus 5.5 · reads files from S3 · every step is saved' : 'Claude API off · set COMPANY_BRAIN_ALLOW_API=1 to enable'}
            </span>
            <PromptInputSubmit status={status} onStop={stop} disabled={!apiOn && !busy} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; streaming: boolean }
  | { kind: 'tools'; parts: DynamicToolUIPart[] }
  | { kind: 'chart'; spec: ChartSpec }

function toBlocks(message: WorkbenchUIMessage, live: boolean): Block[] {
  const blocks: Block[] = []
  message.parts.forEach((p, i) => {
    const last = blocks.at(-1)
    if (p.type === 'text' && p.text) blocks.push({ kind: 'text', text: p.text })
    else if (p.type === 'reasoning' && p.text) blocks.push({ kind: 'reasoning', text: p.text, streaming: live && p.state === 'streaming' && i === message.parts.length - 1 })
    else if (p.type === 'dynamic-tool') {
      const view = p.state === 'output-available' ? (p.output as ToolOutputView) : null
      if (p.toolName === 'render_chart' && view?.full) {
        blocks.push({ kind: 'chart', spec: view.full as ChartSpec })
        return
      }
      if (last?.kind === 'tools') last.parts.push(p)
      else blocks.push({ kind: 'tools', parts: [p] })
    }
  })
  return blocks
}

function ChatMessage({
  message,
  live,
  onOpenFile,
  onSave,
}: {
  message: WorkbenchUIMessage
  live: boolean
  onOpenFile: (id: string) => void
  onSave: (title: string, body: string) => Promise<void>
}) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return (
      <Message from="user">
        <MessageContent>{text}</MessageContent>
      </Message>
    )
  }
  const blocks = toBlocks(message, live)
  return (
    <Message from="assistant" className="max-w-full">
      <div className="flex flex-col gap-3">
        {blocks.map((b, i) => {
          switch (b.kind) {
            case 'text':
              return <MessageResponse key={i}>{b.text}</MessageResponse>
            case 'reasoning':
              return (
                <Reasoning key={i} isStreaming={b.streaming} defaultOpen={false}>
                  <ReasoningTrigger />
                  <ReasoningContent>{b.text}</ReasoningContent>
                </Reasoning>
              )
            case 'chart':
              return <ChartView key={i} spec={b.spec} />
            case 'tools':
              return <ToolGroup key={i} parts={b.parts} live={live && i === blocks.length - 1} onOpenFile={onOpenFile} />
          }
        })}
        {!live && <SaveNote blocks={blocks} onSave={onSave} />}
      </div>
    </Message>
  )
}

/** Saves the reply's text (the last substantial text block, e.g. a summary) as an internal note. */
function SaveNote({ blocks, onSave }: { blocks: Block[]; onSave: (title: string, body: string) => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const texts = blocks.filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text').map((b) => b.text)
  const body = texts.filter((t) => t.length > 300).at(-1) ?? texts.join('\n\n')
  if (body.trim().length < 300) return null
  const title = body.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() ?? body.split('\n').find((l) => l.trim())!.replace(/[#*_`]/g, '').trim().slice(0, 100)
  return (
    <div>
      <button
        disabled={state !== 'idle'}
        onClick={async () => {
          setState('saving')
          await onSave(title, body)
          setState('saved')
        }}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:hover:bg-transparent"
      >
        {state === 'saved' ? <Check className="size-3 text-ok" /> : <NotebookPen className="size-3" />}
        {state === 'saved' ? 'Saved to notes' : state === 'saving' ? 'Saving…' : 'Save to notes'}
      </button>
    </div>
  )
}

function ToolGroup({ parts, live, onOpenFile }: { parts: DynamicToolUIPart[]; live: boolean; onOpenFile: (id: string) => void }) {
  const running = parts.filter((p) => p.state === 'input-streaming' || p.state === 'input-available').length
  const errors = parts.filter((p) => p.state === 'output-error').length
  const total = parts.reduce((n, p) => n + (p.state === 'output-available' ? ((p.output as ToolOutputView).duration_ms ?? 0) : 0), 0)
  // Controlled: open while the agent is working in this group, then leave it as the user sets it.
  const [open, setOpen] = useState(live)
  useEffect(() => {
    if (live) setOpen(true)
  }, [live])
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-xl border border-border bg-muted/30">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/60">
          {running > 0 ? <Loader2 className="size-3.5 animate-spin text-signal" /> : <Check className="size-3.5 text-ok" />}
          <span className={cn('font-medium', running > 0 && 'shimmer-text')}>
            {running > 0 ? `Working · ${parts.length} action${parts.length === 1 ? '' : 's'}` : `Ran ${parts.length} action${parts.length === 1 ? '' : 's'}`}
          </span>
          {errors > 0 && <span className="text-destructive">· {errors} failed</span>}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground tabular-nums">{(total / 1000).toFixed(1)}s</span>
          <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="border-t border-border">
            {parts.map((p) => (
              <ToolRow key={p.toolCallId} part={p} onOpenFile={onOpenFile} />
            ))}
          </ol>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ToolRow({ part, onOpenFile }: { part: DynamicToolUIPart; onOpenFile: (id: string) => void }) {
  const meta = TOOL_META[part.toolName] ?? { icon: Database, label: part.toolName }
  const Icon = meta.icon
  const view = part.state === 'output-available' ? (part.output as ToolOutputView) : null
  const running = part.state === 'input-streaming' || part.state === 'input-available'
  const failed = part.state === 'output-error'
  const fileId = (part.input as { id?: string } | undefined)?.id
  const summary = view?.summary ?? (part.input ? describeInput(part.toolName, part.input) : `${meta.label}…`)
  return (
    <li className="border-b border-border/60 last:border-b-0">
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted/60">
          <span
            className={cn(
              'inline-flex w-[4.75rem] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
              failed ? 'bg-destructive/10 text-destructive' : part.toolName === 'record_finding' ? 'bg-signal/15 text-signal' : 'bg-background text-muted-foreground ring-1 ring-border',
            )}
          >
            {running ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
            {meta.label}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{summary}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{running ? '…' : view ? `${((view.duration_ms ?? 0) / 1000).toFixed(2)}s` : ''}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 bg-background/60 px-3 pt-1 pb-3">
            {fileId && (
              <button onClick={() => onOpenFile(fileId)} className="text-[11px] text-signal underline underline-offset-2">
                Open this file
              </button>
            )}
            <Pre label="Input" value={JSON.stringify(part.input, null, 2)} />
            {view && <Pre label="Result" value={view.preview} />}
            {failed && <Pre label="Error" value={part.errorText} />}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function describeInput(tool: string, input: unknown): string {
  const i = input as Record<string, unknown>
  if (tool === 'query_inventory' && typeof i.sql === 'string') return `SQL: ${i.sql.replace(/\s+/g, ' ').slice(0, 110)}`
  if (tool === 'record_finding') return `Record finding for ${String(i.question_id ?? '')}`
  return TOOL_META[tool]?.label ?? tool
}

function Pre({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[10.5px] leading-snug whitespace-pre-wrap">{value}</pre>
    </div>
  )
}

function EmptyState({ nextSteps, onPick, disabled }: { nextSteps: NextSteps | null; onPick: (t: string) => void; disabled: boolean }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center text-center">
      <LogoMark className="mb-4 size-11" />
      <h1 className="text-lg font-semibold">{nextSteps?.headline ?? 'What do we have here?'}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {nextSteps?.detail ?? 'The agent reads the raw evidence, shows every step, and records findings with the files that prove them.'}
      </p>
      {nextSteps && nextSteps.suggestions.length > 0 && (
        <Suggestions className="mt-6 w-full flex-col items-stretch">
          {nextSteps.suggestions.map((s) => (
            <Suggestion
              key={s.label}
              suggestion={s.prompt}
              disabled={disabled}
              onClick={onPick}
              className={cn('h-auto justify-start rounded-xl px-4 py-2.5 text-left whitespace-normal', s.primary && 'border-signal/40 bg-signal/10 hover:bg-signal/15')}
            >
              {s.primary && <Sparkles className="size-3.5 shrink-0 text-signal" />}
              {s.label}
            </Suggestion>
          ))}
        </Suggestions>
      )}
    </div>
  )
}
