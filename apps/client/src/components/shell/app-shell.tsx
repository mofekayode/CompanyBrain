'use client'

import { Search, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { CommandPalette } from '@/components/omni/command-palette'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getJSON, tenantApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SkeletonAnswer } from '@/components/states'
import { LogoMark } from './logo'
import { useSession } from './session'

const NAV = [
  { href: '', label: 'Ask' },
  { href: '/search', label: 'Search' },
  { href: '/briefs', label: 'Briefs' },
  { href: '/sources', label: 'Sources' },
]

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

export function AppShell({ children }: { children: React.ReactNode }) {
  const { slug, company, me } = useSession()
  const path = usePathname()
  const here = path.replace(`/${slug}`, '')
  const [palette, setPalette] = useState(false)
  const [pending, setPending] = useState(0)

  // ⌘K / Ctrl+K anywhere opens the palette; "/" focuses this page's main input (or opens the palette).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      } else if (e.key === '/' && !typing(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const input = document.querySelector<HTMLElement>('[data-primary-input]')
        if (input) input.focus()
        else setPalette(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Requests waiting for the people who manage access.
  useEffect(() => {
    if (!me?.admin) return setPending(0)
    getJSON<{ status: string }[]>(`${tenantApi(slug)}/access/requests`)
      .then((r) => setPending(r.filter((x) => x.status === 'pending').length))
      .catch(() => {})
  }, [slug, me?.admin, path])

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 sm:h-14 sm:flex-nowrap sm:px-6 sm:py-0">
          <Link href={`/${slug}`} className="flex items-center gap-2 font-semibold tracking-[-0.02em] text-ink">
            <LogoMark />
            <span className="hidden text-[15px] lg:inline">{company}</span>
          </Link>
          <nav className="order-last -mx-1 flex w-full items-center gap-1 overflow-x-auto sm:order-none sm:mx-0 sm:w-auto">
            {NAV.map((n) => {
              const active = n.href === '' ? here === '' || here.startsWith('/ask') : here.startsWith(n.href) || (n.href === '/sources' && here.startsWith('/files'))
              return (
                <Link
                  key={n.href}
                  href={`/${slug}${n.href}`}
                  className={cn('rounded-md px-2.5 py-1.5 text-[13.5px] transition-colors', active ? 'bg-ink text-white' : 'text-ink/70 hover:bg-secondary hover:text-ink')}
                >
                  {n.label}
                </Link>
              )
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPalette(true)}
              className="hidden h-9 w-56 items-center gap-2 rounded-full border border-border bg-white px-3 text-left text-[13px] text-muted-foreground shadow-xs transition-colors hover:border-ink/25 md:flex"
            >
              <Search className="size-3.5" />
              <span className="flex-1">Search or ask…</span>
              <kbd className="rounded border border-border px-1.5 font-mono text-[10px]">⌘K</kbd>
            </button>
            <button type="button" onClick={() => setPalette(true)} className="grid size-9 place-items-center rounded-full border border-border bg-white md:hidden" aria-label="Search or ask">
              <Search className="size-4" />
            </button>
            {me?.admin && (
              <Link
                href={`/${slug}/admin`}
                title={pending ? `Access · ${pending} request${pending === 1 ? '' : 's'} waiting` : 'Access'}
                aria-label="Access"
                className={cn('relative grid size-9 place-items-center rounded-full border border-border bg-white text-ink/75 hover:border-ink/25', here.startsWith('/admin') && 'border-ink bg-ink text-white')}
              >
                <ShieldCheck className="size-4" />
                {pending > 0 && <span className="absolute -top-1 -right-1 grid min-w-4 place-items-center rounded-full bg-cobalt px-1 text-[10px] font-semibold text-white">{pending}</span>}
              </Link>
            )}
            <PersonSwitcher />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">{me ? children : <SkeletonAnswer label="Signing in…" />}</main>
      {me && <CommandPalette open={palette} onClose={() => setPalette(false)} />}
    </div>
  )
}

const initials = (name: string) =>
  name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')

/** Who you're signed in as (a demo stand-in for real sign-in): people who manage access first. */
function PersonSwitcher() {
  const { me, people, signInAs } = useSession()
  const admins = people.filter((p) => p.admin)
  const others = people.filter((p) => !p.admin)
  const Row = ({ p }: { p: (typeof people)[number] }) => (
    <SelectItem value={p.id} className="py-1.5">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-navy text-[10px] font-semibold !text-white">{initials(p.name)}</span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[13px]">{p.name}</span>
        {p.title && <span className="block truncate text-[11px] text-muted-foreground">{p.title}</span>}
      </span>
    </SelectItem>
  )
  return (
    <Select value={me?.id ?? null} onValueChange={(v) => v && signInAs(v as string)} items={people.map((p) => ({ value: p.id, label: p.name }))}>
      <SelectTrigger aria-label="Signed in as" className="h-9 gap-2 rounded-full border-border bg-white pr-2.5 pl-1 shadow-xs">
        <span className="grid size-7 place-items-center rounded-full bg-navy text-[10.5px] font-semibold text-white">{me ? initials(me.name) : '·'}</span>
        <span className="hidden max-w-44 flex-col items-start leading-tight sm:flex">
          <span className="text-[10px] text-muted-foreground">Signed in as</span>
          <SelectValue className="text-[13px] font-medium text-ink" />
        </span>
        {me?.admin && <ShieldCheck className="size-3.5 text-cobalt" aria-label="manages access" />}
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false} className="max-h-[min(28rem,var(--available-height))] w-72">
        <SelectGroup>
          <SelectLabel className="text-[11px]">Manage access</SelectLabel>
          {admins.map((p) => (
            <Row key={p.id} p={p} />
          ))}
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel className="text-[11px]">Everyone else</SelectLabel>
          {others.map((p) => (
            <Row key={p.id} p={p} />
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
