'use client'

// The page input for Ask and Search. As you type, matching customers, people, files and email
// appear underneath; the first row is this page's own action, so Enter always does what you'd
// expect (ask / search). ↑/↓ pick a match instead. In Ask, Shift+Enter is a new line.
// Esc closes the list, then clears, then leaves the field. "/" focuses it from anywhere.

import { ArrowUp, Loader2, Search, Square } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useSession } from '@/components/shell/session'
import { pushRecent } from '@/lib/recents'
import { cn } from '@/lib/utils'
import { OmniList, listKeys, queryItems } from './items'
import { looksLikeQuestion, useSuggest } from './use-suggest'

export interface OmniboxHandle {
  focus: () => void
  set: (q: string) => void
}

export const Omnibox = forwardRef<OmniboxHandle, {
  mode: 'ask' | 'search'
  onSubmit: (q: string) => void
  initial?: string
  big?: boolean
  busy?: boolean
  /** While an answer is being prepared: shows Stop instead of send. */
  onStop?: () => void
  placeholder?: string
  autoFocus?: boolean
  clearOnSubmit?: boolean
  /** Docked at the bottom of the window: suggestions open upward. */
  dropUp?: boolean
  className?: string
}>(function Omnibox({ mode, onSubmit, initial = '', big, busy, onStop, placeholder, autoFocus, clearOnSubmit, dropUp, className }, ref) {
  const { slug, me } = useSession()
  const router = useRouter()
  const [q, setQ] = useState(initial)
  const [focused, setFocused] = useState(false)
  // Arriving with text already in the box (a deep link, a re-run) shouldn't pop the list open.
  const [dismissed, setDismissed] = useState(!!initial)
  const [active, setActive] = useState(0)
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const { data, loading } = useSuggest(focused && !dismissed ? q : '')

  useImperativeHandle(ref, () => ({ focus: () => field.current?.focus(), set: (v: string) => setQ(v) }))
  useEffect(() => {
    setQ(initial)
    setDismissed(true)
  }, [initial])

  const submit = (text: string) => {
    const t = text.trim()
    if (!t) return
    setDismissed(true)
    if (clearOnSubmit) setQ('')
    onSubmit(t)
  }
  const other = (text: string) => {
    pushRecent(slug, me?.id, { kind: mode === 'ask' ? 'search' : 'ask', label: text, ref: text })
    router.push(mode === 'ask' ? `/${slug}/search?q=${encodeURIComponent(text)}` : `/${slug}/ask?q=${encodeURIComponent(text)}`)
  }
  const items = useMemo(
    () => (q.trim().length >= 2 ? queryItems({ slug, q, data, mode, questionFirst: mode === 'ask' ? looksLikeQuestion(q) : false, go: (h) => router.push(h), ask: mode === 'ask' ? submit : other, search: mode === 'search' ? submit : other }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, data, mode, slug],
  )
  useEffect(() => setActive(0), [q, data])
  const open = focused && !dismissed && items.length > 0

  // Grow the Ask box with its text (up to a few lines).
  useEffect(() => {
    const el = field.current
    if (mode !== 'ask' || !el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [q, mode])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submit(q)
      } else if (e.key === 'Escape') {
        if (busy && onStop) onStop()
        else if (q) setQ('')
        else field.current?.blur()
      } else if (e.key === 'ArrowDown' && items.length) {
        setDismissed(false)
      }
      return
    }
    listKeys(e, items, active, setActive, {
      onEscape: () => {
        e.preventDefault()
        setDismissed(true)
      },
    })
  }

  const Field = mode === 'ask' ? 'textarea' : 'input'
  return (
    <div className={cn('relative', className)}>
      <div className={cn('flex items-end gap-2 rounded-2xl border border-border bg-white p-1.5 pl-4 shadow-xs transition-colors focus-within:border-cobalt/60', big && 'p-2 pl-5', open && (dropUp ? 'rounded-t-none' : 'rounded-b-none'))}>
        {mode === 'search' && (loading ? <Loader2 className="mb-2.5 size-4 shrink-0 animate-spin text-muted-foreground" /> : <Search className="mb-2.5 size-4 shrink-0 text-muted-foreground" />)}
        <Field
          ref={field}
          data-primary-input
          rows={1}
          value={q}
          autoFocus={autoFocus}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) => {
            setQ(e.target.value)
            setDismissed(false)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? (mode === 'ask' ? 'Ask about a customer, a person, a policy, an asset…' : 'Search names, nicknames, part numbers, phrases…')}
          role="combobox"
          aria-expanded={open}
          aria-controls={`omni-${mode}-list`}
          aria-activedescendant={open ? `omni-${mode}-opt-${active}` : undefined}
          className={cn('min-w-0 flex-1 resize-none self-center bg-transparent py-1.5 leading-snug outline-none placeholder:text-muted-foreground', big ? 'text-[16px]' : 'text-[14.5px]')}
        />
        {busy && onStop ? (
          <button type="button" onClick={onStop} className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink text-white" aria-label="Stop" title="Stop (Esc)">
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button type="button" onClick={() => submit(q)} disabled={!q.trim() || busy} className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink text-white disabled:opacity-35" aria-label={mode === 'ask' ? 'Ask' : 'Search'} title="Enter">
            {busy ? <Loader2 className="size-4 animate-spin" /> : mode === 'ask' ? <ArrowUp className="size-4" /> : <Search className="size-4" />}
          </button>
        )}
      </div>
      {open && (
        <div
          className={cn(
            'absolute inset-x-0 z-40 max-h-[min(55vh,26rem)] overflow-y-auto border border-border bg-white shadow-lg',
            dropUp ? 'bottom-full rounded-t-2xl border-b-0' : 'top-full rounded-b-2xl border-t-0',
          )}
        >
          <OmniList items={items} active={active} onActive={setActive} idPrefix={`omni-${mode}`} dense />
          <div className="flex gap-4 border-t border-border bg-paper px-4 py-1.5 font-mono text-[10.5px] text-muted-foreground">
            <span>↵ {mode === 'ask' ? 'ask' : 'search'}</span>
            <span>↑↓ pick a match</span>
            {mode === 'ask' && <span>⇧↵ new line</span>}
            <span>esc close</span>
          </div>
        </div>
      )}
    </div>
  )
})
