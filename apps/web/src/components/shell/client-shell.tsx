'use client'

// One navigation for every FDE page of a client: the workflow itself, as a left rail.
// Each step shows its status and one line of detail; the current page is raised.
// The rail collapses to numbered dots (remembered per browser) so wide pages get room.

import type { NextSteps, WorkflowStep } from '@companybrain/core/workbench/next-steps'
import { Check, ChevronsLeft, ChevronsRight, ChevronsUpDown, Loader2, NotebookText, SlidersHorizontal, Sparkles } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { API } from '@/lib/api'
import { LogoMark } from './logo'
import { cn } from '@/lib/utils'

/** Which page each step lives on (relative to /t/<slug>). */
const HREF: Record<WorkflowStep['key'], string> = {
  upload: '/upload',
  profile: '',
  discover: '',
  extract: '',
  access: '/access',
  model: '/model',
  knowledge: '/knowledge',
  search: '/search',
  checks: '/checks',
}

const COLLAPSE_KEY = 'cb.rail.collapsed'

export function ClientShell({ slug, children }: { slug: string; children: React.ReactNode }) {
  const pathname = usePathname()
  const [next, setNext] = useState<NextSteps | null>(null)
  const [name, setName] = useState<string>(slug)
  const [running, setRunning] = useState(0)
  const [claudeApi, setClaudeApi] = useState<boolean | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch {}
  }, [])
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1')
      } catch {}
      return !c
    })

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [n, a] = await Promise.all([
        fetch(`${API}/api/t/${slug}/next-steps`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/api/t/${slug}/activity`).then((r) => r.json()).catch(() => null),
      ])
      if (!alive) return
      if (n?.steps) setNext(n)
      if (a?.run) setRunning(a.run.status === 'running' ? a.run.running + a.run.queued : 0)
    }
    fetch(`${API}/api/tenants/${slug}`)
      .then((r) => r.json())
      .then((t) => alive && t?.name && setName(t.name))
      .catch(() => {})
    fetch(`${API}/api/status`)
      .then((r) => r.json())
      .then((s) => alive && setClaudeApi(!!s?.claude_api))
      .catch(() => {})
    load()
    const t = setInterval(load, 8000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [slug])

  const here = pathname.replace(`/t/${slug}`, '') || ''
  // Profile, discover and extract share the workbench page: highlight whichever of them is current.
  const steps = next?.steps ?? []
  const onWorkbench = steps.filter((x) => (HREF[x.key] ?? '') === '')
  const activeKey = here === '' ? (onWorkbench.find((x) => x.status === 'current') ?? onWorkbench.at(-1))?.key : steps.find((x) => HREF[x.key] === here)?.key
  const initial = name.trim().charAt(0).toUpperCase() || '·'

  return (
    <div className="flex h-dvh bg-background">
      <aside className={cn('flex shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200', collapsed ? 'w-14' : 'w-60')}>
        <div className={cn('p-2.5', collapsed && 'px-2')}>
          <Link href="/" title="Company Brain · all clients" className={cn('mb-2.5 flex items-center gap-2 px-1 pt-0.5', collapsed && 'justify-center px-0')}>
            <LogoMark className="size-[22px]" />
            {!collapsed && <span className="text-[14px] font-semibold tracking-[-0.02em]">Company Brain</span>}
          </Link>
          <Link
            href="/"
            title="All clients"
            className={cn('flex items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 shadow-xs transition-colors hover:border-input', collapsed && 'justify-center px-0')}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">{initial}</span>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium leading-tight">{name}</span>
                  <span className="block text-[10.5px] leading-tight text-muted-foreground">FDE workspace</span>
                </span>
                <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </Link>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          {!collapsed && <div className="eyebrow-muted px-2 pb-1.5 pt-2">Workflow</div>}
          <ol className="relative">
            {steps.map((s, i) => {
              const active = s.key === activeKey
              const href = `/t/${slug}${HREF[s.key] ?? ''}`
              const dot = (
                <span
                  className={cn(
                    'relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full border font-mono text-[9.5px] font-medium',
                    s.status === 'done' && 'border-verified bg-verified text-white',
                    s.status === 'current' && 'border-cobalt bg-cobalt-soft text-cobalt',
                    s.status === 'available' && 'border-cobalt/50 bg-card text-cobalt',
                    (s.status === 'todo' || s.status === 'later') && 'border-border bg-card text-muted-foreground',
                  )}
                >
                  {s.status === 'done' ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
              )
              const row = (
                <Link
                  href={href}
                  title={collapsed ? `${s.label} · ${s.detail}` : s.detail}
                  className={cn(
                    'group relative flex items-start gap-2.5 rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:bg-card',
                    active && 'border-border bg-card shadow-xs',
                    collapsed && 'justify-center px-0',
                  )}
                >
                  {dot}
                  {!collapsed && (
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className={cn('block text-[13px]', active ? 'font-medium text-foreground' : 'text-foreground/85')}>{s.label}</span>
                      <span className="mt-0.5 block truncate font-mono text-[10.5px] text-muted-foreground">{s.detail}</span>
                    </span>
                  )}
                </Link>
              )
              return (
                <li key={s.key} className="relative py-px">
                  {i < steps.length - 1 && (
                    <span aria-hidden className={cn('absolute top-6 bottom-[-6px] w-px', collapsed ? 'left-1/2' : 'left-[16.5px]', s.status === 'done' ? 'bg-verified/40' : 'bg-border')} />
                  )}
                  {row}
                </li>
              )
            })}
          </ol>

          {!collapsed && <div className="eyebrow-muted px-2 pb-1.5 pt-5">Use</div>}
          <Link
            href={`/t/${slug}/skills`}
            title="Skills"
            className={cn(
              'mt-1 flex items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-[13px] text-foreground/85 transition-colors hover:bg-card',
              here === '/skills' && 'border-border bg-card font-medium text-foreground shadow-xs',
              collapsed && 'justify-center px-0',
            )}
          >
            <NotebookText className="size-4 shrink-0 text-muted-foreground" />
            {!collapsed && 'Skills'}
          </Link>

          {!collapsed && <div className="eyebrow-muted px-2 pb-1.5 pt-5">Setup</div>}
          <Link
            href={`/t/${slug}/config`}
            title="Configuration"
            className={cn(
              'mt-1 flex items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-[13px] text-foreground/85 transition-colors hover:bg-card',
              here === '/config' && 'border-border bg-card font-medium text-foreground shadow-xs',
              collapsed && 'justify-center px-0',
            )}
          >
            <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" />
            {!collapsed && 'Configuration'}
          </Link>
        </nav>

        <div className={cn('space-y-1.5 border-t border-border p-2.5', collapsed && 'px-2')}>
          {running > 0 && (
            <Link
              href={`/t/${slug}?panel=activity`}
              title={`${running} jobs running`}
              className={cn('flex items-center gap-2 rounded-lg bg-cobalt-soft px-2.5 py-1.5 text-[12px] font-medium text-cobalt', collapsed && 'justify-center px-0')}
            >
              <Loader2 className="size-3.5 animate-spin" />
              {!collapsed && `${running} running`}
            </Link>
          )}
          {claudeApi === false && (
            <div
              title="Claude API calls are off: no API spend. AI steps are done in a Claude Code session; set COMPANY_BRAIN_ALLOW_API=1 to turn them on."
              className={cn('flex items-center gap-2 rounded-lg bg-stale-soft px-2.5 py-1.5 text-[11.5px] text-stale', collapsed && 'justify-center px-0')}
            >
              <Sparkles className="size-3.5 shrink-0" />
              {!collapsed && 'Claude API off'}
            </div>
          )}
          <button
            type="button"
            onClick={toggle}
            className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-card hover:text-foreground', collapsed && 'justify-center px-0')}
          >
            {collapsed ? <ChevronsRight className="size-3.5" /> : <ChevronsLeft className="size-3.5" />}
            {!collapsed && 'Collapse'}
          </button>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1">{children}</main>
    </div>
  )
}
