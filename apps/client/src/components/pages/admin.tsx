'use client'

// Access, for the people who manage it. Four views:
//   Requests        people asking for an area or a file: approve or deny
//   People & groups who can see what, by person or by group (through the areas they belong to)
//   Areas           each area, who it's for, released or held (releasing asks first)
//   Audit log       every release, hold and decision, with who did it
// Nothing is visible to staff until it's released; answers, search and briefs follow automatically.

import { Check, History, Inbox, Loader2, Lock, Search, ShieldCheck, Unlock, Users, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from '@/components/shell/session'
import { EmptyState, SkeletonList } from '@/components/states'
import { getJSON, postJSON, tenantApi } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Scope {
  id: string
  name: string
  description: string | null
  sensitivity: string
  hidden: boolean
  status: 'released' | 'held'
  files: number
  audience: { id: string; name: string; kind: string }[]
  pending_requests: number
}
interface Req {
  id: string
  status: string
  reason: string | null
  created_at: string
  requester: string
  decided_by: string | null
  file_path: string | null
  scope_name: string | null
  grant_level: string | null
}
interface PersonRow {
  id: string
  name: string
  title: string | null
  department: string | null
  groups: string[]
  status: string
}
interface GroupRow {
  id: string
  name: string
  type: string
  members: number
}
interface AuditRow {
  action: string
  target: { scope?: string; request?: string } | null
  created_at: string
  actor: string | null
}

const TABS = [
  { key: 'requests', label: 'Requests', icon: Inbox },
  { key: 'people', label: 'People & groups', icon: Users },
  { key: 'areas', label: 'Areas', icon: ShieldCheck },
  { key: 'audit', label: 'Audit log', icon: History },
] as const
type Tab = (typeof TABS)[number]['key']

const ACTION: Record<string, string> = { 'scope.released': 'released', 'scope.held': 'put on hold', 'request.approved': 'approved a request for', 'request.denied': 'denied a request for', 'request.created': 'requested' }

export function Admin() {
  const { slug, me } = useSession()
  const [tab, setTab] = useState<Tab>('requests')
  const [scopes, setScopes] = useState<Scope[] | null>(null)
  const [reqs, setReqs] = useState<Req[]>([])
  const [people, setPeople] = useState<PersonRow[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [audit, setAudit] = useState<AuditRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Scope | null>(null)
  const [who, setWho] = useState('')
  const [picked, setPicked] = useState<PersonRow | null>(null)

  const load = useCallback(async () => {
    const [a, r] = await Promise.all([getJSON<{ scopes: Scope[] }>(`${tenantApi(slug)}/access`), getJSON<Req[]>(`${tenantApi(slug)}/access/requests`)])
    setScopes(a.scopes)
    setReqs(r)
  }, [slug])
  useEffect(() => {
    load()
    getJSON<{ people: PersonRow[]; groups: GroupRow[] }>(`${tenantApi(slug)}/access/people`)
      .then((d) => {
        setPeople(d.people.filter((p) => p.status === 'active'))
        setGroups(d.groups)
      })
      .catch(() => {})
  }, [load, slug])
  useEffect(() => {
    if (tab === 'audit' && !audit) getJSON<AuditRow[]>(`${tenantApi(slug)}/access/audit`).then(setAudit).catch(() => setAudit([]))
  }, [tab, audit, slug])

  const pending = reqs.filter((r) => r.status === 'pending')
  const scopeName = useMemo(() => new Map((scopes ?? []).map((s) => [s.id, s.name])), [scopes])
  // An area is visible to someone when they, or a group they're in, is in its audience.
  const areasFor = (names: string[]) => (scopes ?? []).filter((s) => s.audience.some((a) => names.includes(a.name)))
  const matches = who.trim().length >= 1 ? people.filter((p) => p.name.toLowerCase().includes(who.toLowerCase()) || (p.title ?? '').toLowerCase().includes(who.toLowerCase())).slice(0, 8) : []

  if (!me?.admin) return <p className="pt-16 text-sm text-muted-foreground">Only people who manage access can see this page.</p>

  const setStatus = async (s: Scope, status: 'released' | 'held') => {
    setBusy(s.id)
    await postJSON(`${tenantApi(slug)}/access/scopes/${s.id}`, { status, asPrincipalId: me.id }, 'PATCH')
    await load()
    setAudit(null)
    setBusy(null)
  }
  const decide = async (r: Req, approve: boolean, level: 'file' | 'scope' = 'file') => {
    setBusy(r.id)
    await postJSON(`${tenantApi(slug)}/access/requests/${r.id}/decide`, { adminPrincipalId: me.id, approve, level })
    await load()
    setAudit(null)
    setBusy(null)
  }

  const AreaRow = ({ s }: { s: Scope }) => (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[14px] font-medium">
          {s.status === 'held' ? <Lock className="size-3.5 text-stale" /> : <Unlock className="size-3.5 text-verified" />}
          {s.name}
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-normal text-muted-foreground">{s.sensitivity}</span>
          {s.hidden && <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-normal text-muted-foreground">hidden from others</span>}
        </p>
        <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
          {s.files} files · for {s.audience.map((a) => a.name).join(', ') || 'nobody yet'}
        </p>
      </div>
      <button
        onClick={() => (s.status === 'held' ? setConfirm(s) : setStatus(s, 'held'))}
        disabled={busy === s.id}
        className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px]', s.status === 'held' ? 'bg-ink text-white' : 'border border-border bg-white')}
      >
        {busy === s.id && <Loader2 className="size-3.5 animate-spin" />}
        {s.status === 'held' ? 'Release' : 'Hold'}
      </button>
    </li>
  )

  return (
    <div className="pt-10">
      <div className="eyebrow">Access</div>
      <h1 className="mt-2 text-[34px] leading-tight font-semibold tracking-[-0.03em]">Who sees what.</h1>
      <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground">Files are grouped into areas, each meant for a set of people. Nothing is visible until it’s released. Answers, search and briefs follow these rules automatically.</p>

      <nav className="mt-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-[13.5px]', tab === t.key ? 'border-ink font-medium text-ink' : 'border-transparent text-ink/60 hover:text-ink')}>
            <t.icon className="size-3.5" /> {t.label}
            {t.key === 'requests' && pending.length > 0 && <span className="rounded-full bg-cobalt px-1.5 text-[10.5px] text-white">{pending.length}</span>}
          </button>
        ))}
      </nav>

      {!scopes ? (
        <SkeletonList rows={4} className="mt-6" />
      ) : tab === 'requests' ? (
        <div className="mt-6 space-y-8">
          {!pending.length ? (
            <EmptyState icon={Inbox} title="No requests waiting" className="py-8">
              When someone asks for an area or a file, it appears here for you to approve or deny.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border bg-white">
              {pending.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px]">
                      <span className="font-medium">{r.requester}</span> asks for {r.file_path ? <span className="font-mono text-[12.5px]">{r.file_path.split('/').pop()}</span> : <>all of <span className="font-medium">{r.scope_name}</span></>}
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                      {r.scope_name} · {new Date(r.created_at).toLocaleString()}
                      {r.reason && ` · “${r.reason}”`}
                    </p>
                  </div>
                  <button onClick={() => decide(r, true, r.file_path ? 'file' : 'scope')} disabled={busy === r.id} className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-[12.5px] text-white">
                    <Check className="size-3.5" /> Approve
                  </button>
                  <button onClick={() => decide(r, false)} disabled={busy === r.id} className="inline-flex items-center gap-1 rounded-lg border border-border bg-white px-3 py-1.5 text-[12.5px]">
                    <X className="size-3.5" /> Deny
                  </button>
                </li>
              ))}
            </ul>
          )}
          {reqs.some((r) => r.status !== 'pending') && (
            <section>
              <h2 className="eyebrow-muted mb-2">Decided</h2>
              <ul className="space-y-1 text-[12.5px] text-muted-foreground">
                {reqs
                  .filter((r) => r.status !== 'pending')
                  .slice(0, 20)
                  .map((r) => (
                    <li key={r.id}>
                      {r.requester} · {r.file_path?.split('/').pop() ?? r.scope_name} · {r.status} by {r.decided_by}
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </div>
      ) : tab === 'people' ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="eyebrow-muted mb-2">A person</h2>
            <label className="flex items-center gap-2 rounded-xl border border-border bg-white px-3 py-2">
              <Search className="size-4 text-muted-foreground" />
              <input
                value={who}
                onChange={(e) => {
                  setWho(e.target.value)
                  setPicked(null)
                }}
                placeholder="Name or job title"
                className="flex-1 bg-transparent text-[14px] outline-none"
              />
            </label>
            {!picked && matches.length > 0 && (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border bg-white">
                {matches.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => setPicked(p)} className="w-full px-3 py-2 text-left text-[13px] hover:bg-paper">
                      {p.name} <span className="text-muted-foreground">· {p.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {picked && (
              <div className="mt-3 rounded-2xl border border-border bg-white p-4">
                <p className="text-[15px] font-medium">{picked.name}</p>
                <p className="text-[12.5px] text-muted-foreground">
                  {picked.title} · in {picked.groups.length} groups
                </p>
                <ul className="mt-3 space-y-1.5">
                  {areasFor([picked.name, ...picked.groups]).map((s) => (
                    <li key={s.id} className="flex items-center gap-2 text-[13px]">
                      {s.status === 'released' ? <Unlock className="size-3.5 text-verified" /> : <Lock className="size-3.5 text-stale" />}
                      <span className="flex-1">{s.name}</span>
                      <span className="text-[11.5px] text-muted-foreground">{s.status === 'released' ? 'can see' : 'held (not yet)'}</span>
                    </li>
                  ))}
                  {!areasFor([picked.name, ...picked.groups]).length && <li className="text-[13px] text-muted-foreground">No areas yet.</li>}
                </ul>
              </div>
            )}
          </section>
          <section>
            <h2 className="eyebrow-muted mb-2">Groups</h2>
            <ul className="divide-y divide-border rounded-2xl border border-border bg-white">
              {groups
                .filter((g) => areasFor([g.name]).length > 0)
                .sort((a, b) => b.members - a.members)
                .map((g) => {
                  const areas = areasFor([g.name])
                  return (
                    <li key={g.id} className="px-4 py-2.5">
                      <p className="flex items-center justify-between text-[13.5px]">
                        <span className="font-medium">{g.name}</span>
                        <span className="text-[11.5px] text-muted-foreground">{g.members} people</span>
                      </p>
                      <p className="mt-0.5 text-[12px] text-muted-foreground">
                        {areas.map((s) => `${s.name}${s.status === 'held' ? ' (held)' : ''}`).join(' · ')}
                      </p>
                    </li>
                  )
                })}
            </ul>
          </section>
        </div>
      ) : tab === 'areas' ? (
        <div className="mt-6 space-y-8">
          {scopes.some((s) => s.status === 'held') && (
            <section>
              <h2 className="text-[15px] font-semibold">Waiting for release</h2>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">Nobody can see these yet.</p>
              <ul className="mt-3 divide-y divide-border rounded-2xl border border-border bg-white">
                {scopes
                  .filter((s) => s.status === 'held')
                  .map((s) => (
                    <AreaRow key={s.id} s={s} />
                  ))}
              </ul>
            </section>
          )}
          <section>
            <h2 className="text-[15px] font-semibold">Released</h2>
            <ul className="mt-3 divide-y divide-border rounded-2xl border border-border bg-white">
              {scopes
                .filter((s) => s.status === 'released')
                .map((s) => (
                  <AreaRow key={s.id} s={s} />
                ))}
            </ul>
          </section>
        </div>
      ) : (
        <div className="mt-6">
          {!audit ? (
            <SkeletonList rows={4} />
          ) : !audit.length ? (
            <EmptyState icon={History} title="Nothing recorded yet" className="py-8">
              Releases, holds and decisions on requests appear here.
            </EmptyState>
          ) : (
            <ol className="divide-y divide-border rounded-2xl border border-border bg-white">
              {audit.slice(0, 100).map((a, i) => (
                <li key={i} className="flex items-baseline gap-3 px-4 py-2.5 text-[13px]">
                  <span className="w-36 shrink-0 font-mono text-[11px] text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
                  <span>
                    <span className="font-medium">{a.actor ?? 'System'}</span> {ACTION[a.action] ?? a.action} {a.target?.scope ? <span className="font-medium">{scopeName.get(a.target.scope) ?? 'an area'}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 px-4" onClick={() => setConfirm(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <p className="text-[15px] font-semibold">Release “{confirm.name}”?</p>
            <p className="mt-1.5 text-[13.5px] text-ink/75">
              {confirm.files} files become visible to {confirm.audience.map((a) => a.name).join(', ') || 'nobody'}, and answers, search and briefs can use them for those people.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} className="rounded-lg border border-border px-3 py-1.5 text-[13px]">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const s = confirm
                  setConfirm(null)
                  setStatus(s, 'released')
                }}
                className="rounded-lg bg-ink px-3 py-1.5 text-[13px] text-white"
              >
                Release
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
