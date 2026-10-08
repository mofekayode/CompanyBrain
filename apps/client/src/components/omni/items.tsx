'use client'

// The shared result model for the ⌘K palette and the page inputs (Ask, Search): what can be
// picked, grouped, with one highlighted row. Enter runs the highlighted row; ⌘/Ctrl+Enter
// opens links in a new tab.

import {
  ArrowRight,
  AudioLines,
  Building2,
  Clock,
  Cog,
  Database,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  type LucideIcon,
  Mail,
  MapPin,
  MessageCircleQuestion,
  Search,
  Sparkles,
  Truck,
  User,
  Video,
} from 'lucide-react'
import type { Recent } from '@/lib/recents'
import { cn } from '@/lib/utils'
import type { Suggestions } from './use-suggest'

export interface OmniItem {
  key: string
  group: string
  icon: LucideIcon
  title: string
  subtitle?: string | null
  /** Shown on the highlighted row: "Open", "Ask", "Search". */
  action: string
  href?: string
  run: () => void
}

const TYPE_ICON: Record<string, LucideIcon> = { Customer: Building2, Person: User, 'Customer Contact': User, Site: MapPin, Asset: Cog, Vendor: Truck, Branch: MapPin }
const FILE_ICON: Record<string, LucideIcon> = { video: Video, interview: AudioLines, photo: ImageIcon, spreadsheet: FileSpreadsheet, email: Mail, document: FileText }
const PLURAL: Record<string, string> = { Person: 'People', 'Customer Contact': 'Customer contacts', Branch: 'Branches', Asset: 'Equipment' }
export const groupOf = (type: string) => PLURAL[type] ?? `${type}s`

export interface BuildArgs {
  slug: string
  q: string
  data: Suggestions | null
  mode: 'ask' | 'search' | 'palette'
  questionFirst: boolean
  go: (href: string) => void
  ask: (q: string) => void
  search: (q: string) => void
}

/** Typed query → actions first (ask / search, in the order the wording suggests), then matches. */
export function queryItems({ slug, q, data, mode, questionFirst, go, ask, search }: BuildArgs): OmniItem[] {
  const query = q.trim()
  const askItem: OmniItem = { key: 'ask', group: 'Actions', icon: Sparkles, title: `Ask Company Brain: “${query}”`, subtitle: 'A cited answer, with what changed', action: 'Ask', run: () => ask(query) }
  const searchItem: OmniItem = { key: 'search', group: 'Actions', icon: Search, title: `Search everything for “${query}”`, subtitle: 'Documents, email, interviews, records', action: 'Search', run: () => search(query) }
  const actions = mode === 'ask' ? [askItem, searchItem] : mode === 'search' ? [searchItem, askItem] : questionFirst ? [askItem, searchItem] : [searchItem, askItem]
  const items: OmniItem[] = []
  // A noun that names a record ("dave", "big bl") most likely means "take me there": that record
  // goes first and Enter opens it. A question keeps Ask first.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const covers = (text: string | null | undefined) => !!text && (text.toLowerCase().startsWith(query.toLowerCase()) || words.every((w) => text.toLowerCase().split(/[\s()“”"',.-]+/).some((t) => t.startsWith(w))))
  const destination = !questionFirst && words.length <= 4 ? data?.entities.find((e) => covers(e.name) || covers(e.matched)) : undefined
  if (destination)
    items.push({ key: `e:${destination.id}`, group: 'Best match', icon: TYPE_ICON[destination.type] ?? Database, title: destination.name, subtitle: [destination.type, destination.detail].filter(Boolean).join(' · '), action: 'Open', href: `/${slug}/e/${destination.id}`, run: () => go(`/${slug}/e/${destination.id}`) })
  // A lookup that names a file exactly → offer the file before anything else.
  const exactFile = data?.files.find((f) => f.name.toLowerCase().replace(/\.[a-z0-9]+$/, '') === query.toLowerCase() || f.name.toLowerCase() === query.toLowerCase())
  if (exactFile) items.push({ key: `xf:${exactFile.id}`, group: 'Actions', icon: FILE_ICON[exactFile.kind] ?? FileText, title: `Open ${exactFile.name}`, subtitle: exactFile.path, action: 'Open', href: `/${slug}/sources?open=${exactFile.id}`, run: () => go(`/${slug}/sources?open=${exactFile.id}`) })
  items.push(...actions)
  for (const e of data?.entities ?? [])
    if (e.id !== destination?.id)
      items.push({ key: `e:${e.id}`, group: groupOf(e.type), icon: TYPE_ICON[e.type] ?? Database, title: e.name, subtitle: e.detail, action: 'Open', href: `/${slug}/e/${e.id}`, run: () => go(`/${slug}/e/${e.id}`) })
  for (const f of data?.files ?? [])
    if (f.id !== exactFile?.id)
      items.push({ key: `f:${f.id}`, group: 'Files', icon: FILE_ICON[f.kind] ?? FileText, title: f.name, subtitle: f.path.split('/').slice(0, -1).join(' / ') || null, action: 'Open', href: `/${slug}/sources?open=${f.id}`, run: () => go(`/${slug}/sources?open=${f.id}`) })
  for (const m of data?.emails ?? [])
    if (m.file_id)
      items.push({ key: `m:${m.id}`, group: 'Email', icon: Mail, title: m.subject, subtitle: m.date, action: 'Open', href: `/${slug}/sources?open=${m.file_id}`, run: () => go(`/${slug}/sources?open=${m.file_id}`) })
  return items
}

/** Nothing typed yet → recents first, then starting points. */
export function recentItems(slug: string, recents: Recent[], go: (href: string) => void, ask: (q: string) => void, search: (q: string) => void): OmniItem[] {
  return recents.map((r) =>
    r.kind === 'ask'
      ? { key: `ra:${r.ref}`, group: 'Recent', icon: MessageCircleQuestion, title: r.label, subtitle: 'Asked', action: 'Ask', run: () => ask(r.ref) }
      : r.kind === 'search'
        ? { key: `rs:${r.ref}`, group: 'Recent', icon: Clock, title: r.label, subtitle: 'Searched', action: 'Search', run: () => search(r.ref) }
        : r.kind === 'entity'
          ? { key: `re:${r.ref}`, group: 'Recently viewed', icon: TYPE_ICON[r.detail ?? ''] ?? Database, title: r.label, subtitle: r.detail, action: 'Open', href: `/${slug}/e/${r.ref}`, run: () => go(`/${slug}/e/${r.ref}`) }
          : { key: `rf:${r.ref}`, group: 'Recently viewed', icon: FileText, title: r.label, subtitle: r.detail, action: 'Open', href: `/${slug}/sources?open=${r.ref}`, run: () => go(`/${slug}/sources?open=${r.ref}`) },
  )
}

/** Grouped list with one highlighted row (keyboard or hover). */
export function OmniList({ items, active, onActive, idPrefix, dense }: { items: OmniItem[]; active: number; onActive: (i: number) => void; idPrefix: string; dense?: boolean }) {
  let last = ''
  return (
    <ul role="listbox" id={`${idPrefix}-list`} className="py-1">
      {items.map((it, i) => {
        const header = it.group !== last ? it.group : null
        last = it.group
        const Icon = it.icon
        return (
          <li key={it.key} role="presentation">
            {header && <div className="eyebrow-muted px-3 pt-2.5 pb-1">{header}</div>}
            <a
              role="option"
              id={`${idPrefix}-opt-${i}`}
              aria-selected={i === active}
              href={it.href}
              onMouseMove={() => i !== active && onActive(i)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) return // let the browser open a new tab
                e.preventDefault()
                it.run()
              }}
              className={cn('mx-1.5 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 text-left', dense ? 'py-1.5' : 'py-2', i === active ? 'bg-cobalt-soft text-navy' : 'text-ink')}
            >
              <Icon className={cn('size-4 shrink-0', i === active ? 'text-cobalt' : 'text-muted-foreground')} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px]">{it.title}</span>
                {it.subtitle && <span className="block truncate text-[11.5px] text-muted-foreground">{it.subtitle}</span>}
              </span>
              {i === active && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-cobalt">
                  {it.action} <ArrowRight className="size-3" />
                </span>
              )}
            </a>
          </li>
        )
      })}
    </ul>
  )
}

/** Keyboard handling shared by every list: ↑/↓ move, Enter runs, Esc backs out. */
export function listKeys(e: React.KeyboardEvent, items: OmniItem[], active: number, setActive: (i: number) => void, opts: { onEnter?: () => boolean; onEscape?: () => void } = {}) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    setActive(items.length ? (active + 1) % items.length : 0)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    setActive(items.length ? (active - 1 + items.length) % items.length : 0)
  } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
    if (opts.onEnter?.()) return e.preventDefault()
    const it = items[active]
    if (!it) return
    e.preventDefault()
    if ((e.metaKey || e.ctrlKey) && it.href) window.open(it.href, '_blank')
    else it.run()
  } else if (e.key === 'Escape') {
    opts.onEscape?.()
  }
}
