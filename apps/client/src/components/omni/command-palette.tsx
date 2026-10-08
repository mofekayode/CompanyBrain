'use client'

// ⌘K / Ctrl+K from anywhere: one input, results as you type, grouped (actions, customers,
// people, files, email…). Before typing: recent questions and searches, things you opened,
// questions worth asking, and where to go. ↑/↓ move · Enter opens · ⌘Enter new tab · Esc
// clears, then closes.

import { BookOpen, FolderOpen, Loader2, MessageCircleQuestion, Search, ShieldCheck, Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '@/components/shell/session'
import { getJSON, tenantApi } from '@/lib/api'
import { pushRecent, recentOf } from '@/lib/recents'
import { type OmniItem, OmniList, listKeys, queryItems, recentItems } from './items'
import { looksLikeQuestion, useSuggest } from './use-suggest'

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { slug, me } = useSession()
  const router = useRouter()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [questions, setQuestions] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const { data, loading } = useSuggest(open ? q : '')

  useEffect(() => {
    if (!open) return
    setQ('')
    setActive(0)
    setTimeout(() => input.current?.focus(), 0)
    if (!questions.length)
      getJSON<{ asks: string[]; discover: string[] }>(`${tenantApi(slug)}/app/home?as=${me?.id ?? ''}`)
        .then((h) => setQuestions([...h.discover, ...h.asks].slice(0, 4)))
        .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const go = useCallback(
    (href: string) => {
      onClose()
      router.push(href)
    },
    [onClose, router],
  )
  const ask = useCallback(
    (text: string) => {
      pushRecent(slug, me?.id, { kind: 'ask', label: text, ref: text })
      go(`/${slug}/ask?q=${encodeURIComponent(text)}`)
    },
    [go, slug, me?.id],
  )
  const search = useCallback(
    (text: string) => {
      pushRecent(slug, me?.id, { kind: 'search', label: text, ref: text })
      go(`/${slug}/search?q=${encodeURIComponent(text)}`)
    },
    [go, slug, me?.id],
  )

  const items: OmniItem[] = useMemo(() => {
    if (q.trim().length >= 1) return queryItems({ slug, q, data: q.trim().length >= 2 ? data : null, mode: 'palette', questionFirst: looksLikeQuestion(q), go, ask, search })
    const recent = recentItems(slug, [...recentOf(slug, me?.id, ['ask', 'search'], 4), ...recentOf(slug, me?.id, ['entity', 'file'], 4)], go, ask, search)
    const suggested: OmniItem[] = questions.map((x) => ({ key: `sq:${x}`, group: 'Questions worth asking', icon: MessageCircleQuestion, title: x, action: 'Ask', run: () => ask(x) }))
    const pages: OmniItem[] = [
      { key: 'p:ask', group: 'Go to', icon: Sparkles, title: 'Ask', subtitle: 'Questions answered from the record', action: 'Open', href: `/${slug}`, run: () => go(`/${slug}`) },
      { key: 'p:search', group: 'Go to', icon: Search, title: 'Search', subtitle: 'Everything, filtered by kind', action: 'Open', href: `/${slug}/search`, run: () => go(`/${slug}/search`) },
      { key: 'p:briefs', group: 'Go to', icon: BookOpen, title: 'Briefs', subtitle: 'Dossiers, key people, incidents…', action: 'Open', href: `/${slug}/briefs`, run: () => go(`/${slug}/briefs`) },
      { key: 'p:sources', group: 'Go to', icon: FolderOpen, title: 'Sources', subtitle: 'Files, email, recordings: open or request', action: 'Open', href: `/${slug}/sources`, run: () => go(`/${slug}/sources`) },
      ...(me?.admin ? [{ key: 'p:access', group: 'Go to', icon: ShieldCheck, title: 'Access', subtitle: 'Release areas, approve requests', action: 'Open', href: `/${slug}/admin`, run: () => go(`/${slug}/admin`) }] : []),
    ]
    return [...recent, ...suggested, ...pages]
  }, [q, data, slug, me, questions, go, ask, search])

  useEffect(() => setActive(0), [q, data])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-ink/25 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div role="dialog" aria-label="Search Company Brain" onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-white shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          {loading ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <Search className="size-4 shrink-0 text-muted-foreground" />}
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) =>
              listKeys(e, items, active, setActive, {
                onEscape: () => {
                  e.preventDefault()
                  if (q) setQ('')
                  else onClose()
                },
              })
            }
            placeholder="Search or ask: customers, people, files, questions…"
            role="combobox"
            aria-expanded
            aria-controls="cmdk-list"
            aria-activedescendant={`cmdk-opt-${active}`}
            className="h-13 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 font-mono text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <div className="max-h-[min(60vh,28rem)] overflow-y-auto">
          {items.length ? <OmniList items={items} active={active} onActive={setActive} idPrefix="cmdk" /> : <p className="px-4 py-6 text-[13px] text-muted-foreground">No matches.</p>}
        </div>
        <div className="flex items-center gap-4 border-t border-border bg-paper px-4 py-2 font-mono text-[10.5px] text-muted-foreground">
          <span>↑↓ select</span>
          <span>↵ open</span>
          <span>⌘↵ new tab</span>
          <span className="ml-auto">⌘K anywhere · / focuses the page</span>
        </div>
      </div>
    </div>
  )
}
