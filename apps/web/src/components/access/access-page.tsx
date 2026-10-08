'use client'

// People & access, FDE view (internal and deliberately plain). The client-facing
// experience (catalog, request access, admin queue) is a separate app later; this
// page is for building, checking and demonstrating the access model.

import { ChevronLeft, Eye, EyeOff, Loader2, Lock, LockOpen, Play, ShieldAlert, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { API } from '@/lib/api'
import { cn } from '@/lib/utils'

type Tab = 'scopes' | 'people' | 'view-as' | 'requests' | 'risks' | 'audit'

interface Scope {
  id: string
  key: string
  name: string
  description: string | null
  sensitivity: 'internal' | 'confidential' | 'restricted'
  hidden: boolean
  status: 'held' | 'released'
  origin: string
  files: number
  flagged: number
  pending_requests: number
  audience: { id: string; name: string; kind: string; why: string | null }[]
  evidence: string[]
}
interface Overview {
  people: Record<string, number>
  company_map: { built_at: string; excluded?: { group: string; person: string; status: string }[]; unresolved?: { kind: string; value: string; where: string }[] } | null
  proposal: { proposed_at: string; notes: string[]; escalated: number } | null
  scopes: Scope[]
  unassigned_files: number
  pending_requests: number
}
interface Person {
  id: string
  name: string
  status: string
  title: string | null
  department: string | null
  location: string | null
  manager: string | null
  emails: string[]
  systems: string[]
  conflicts: string[]
  groups: string[]
  has_login: boolean
}

const SENS = {
  internal: 'bg-ok/15 text-ok',
  confidential: 'bg-warn/15 text-foreground',
  restricted: 'bg-destructive/15 text-destructive',
} as const

const json = (r: Response) => r.json()
const post = (url: string, body: unknown, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json)

export function AccessPage({ slug }: { slug: string }) {
  const base = `${API}/api/t/${slug}/access`
  const [tab, setTab] = useState<Tab>('scopes')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [actingAdmin, setActingAdmin] = useState<string>('') // person who releases/decides as admin
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    const [o, p] = await Promise.all([fetch(base).then(json), fetch(`${base}/people`).then(json)])
    setOverview(o)
    setPeople(p.people)
    setActingAdmin((cur) => cur || p.people.find((x: Person) => /president|ceo|owner/i.test(x.title ?? '') && x.status === 'active')?.id || '')
  }, [base])
  useEffect(() => {
    load()
  }, [load])

  async function run() {
    setRunning(true)
    await post(`${base}/run`, {})
    // The run happens in the background; poll until a new proposal lands.
    const before = overview?.proposal?.proposed_at
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      const o = await fetch(base).then(json)
      if (o.proposal?.proposed_at !== before) break
    }
    await load()
    setRunning(false)
  }

  const admins = people.filter((p) => p.status === 'active')

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <h1 className="text-sm font-semibold">People & access</h1>
        {overview && (
          <span className="text-xs text-muted-foreground">
            {overview.people.active ?? 0} active · {overview.people.former ?? 0} former · {overview.people.guest ?? 0} guests · {overview.scopes.length} scopes ·{' '}
            {overview.scopes.filter((s) => s.status === 'released').length} released · {overview.unassigned_files} unassigned files
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Acting admin</label>
          <select value={actingAdmin} onChange={(e) => setActingAdmin(e.target.value)} className="h-7 rounded-md border border-border bg-background px-2 text-xs">
            <option value="">FDE (no person)</option>
            {admins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.title ? ` (${p.title})` : ''}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={run} disabled={running}>
            {running ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}
            {running ? 'Running… (see Activity)' : overview?.scopes.length ? 'Rebuild map + re-propose' : 'Build map + propose scopes'}
          </Button>
        </div>
      </header>
      <nav className="flex shrink-0 gap-1 border-b border-border px-4 pt-2">
        {(
          [
            ['scopes', `Scopes${overview ? ` · ${overview.scopes.length}` : ''}`],
            ['people', `People${people.length ? ` · ${people.length}` : ''}`],
            ['view-as', 'View as'],
            ['requests', `Requests${overview?.pending_requests ? ` · ${overview.pending_requests} pending` : ''}`],
            ['risks', `Risks${overview?.proposal ? ` · ${overview.proposal.notes.length}` : ''}`],
            ['audit', 'Audit'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn('-mb-px border-b-2 px-3 pb-2 text-xs font-medium', tab === key ? 'border-signal text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {label}
          </button>
        ))}
      </nav>
      <main className="min-h-0 flex-1 overflow-auto">
        {!overview ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : tab === 'scopes' ? (
          <Scopes base={base} scopes={overview.scopes} people={people} actingAdmin={actingAdmin} onChange={load} />
        ) : tab === 'people' ? (
          <People people={people} overview={overview} />
        ) : tab === 'view-as' ? (
          <ViewAs base={base} people={people} onChange={load} />
        ) : tab === 'requests' ? (
          <Requests base={base} actingAdmin={actingAdmin} onChange={load} />
        ) : tab === 'risks' ? (
          <Risks overview={overview} />
        ) : (
          <Audit base={base} />
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Scopes({ base, scopes, people, actingAdmin, onChange }: { base: string; scopes: Scope[]; people: Person[]; actingAdmin: string; onChange: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id)
    const r = await post(`${base}/scopes/${id}`, { ...body, asPrincipalId: actingAdmin || undefined }, 'PATCH')
    if (r.error) alert(r.error)
    await onChange()
    setBusy(null)
  }
  if (!scopes.length) return <div className="p-6 text-sm text-muted-foreground">No scopes yet. Click “Build map + propose scopes”.</div>
  return (
    <div className="divide-y divide-border">
      {scopes.map((s) => (
        <div key={s.id} className="px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setOpen(open === s.id ? null : s.id)} className="text-left text-sm font-medium hover:underline">
              {s.name}
            </button>
            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', SENS[s.sensitivity])}>{s.sensitivity}</span>
            {s.hidden && (
              <Badge variant="outline" className="text-[10px]">
                <EyeOff className="size-3" /> hidden
              </Badge>
            )}
            {s.origin === 'human' && <Badge variant="secondary" className="text-[10px]">edited by FDE</Badge>}
            <span className="text-xs text-muted-foreground">
              {s.files} files{s.flagged ? ` · ${s.flagged} flagged` : ''}
              {s.pending_requests ? ` · ${s.pending_requests} requests` : ''}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <select
                value={s.sensitivity}
                onChange={(e) => patch(s.id, { sensitivity: e.target.value })}
                className="h-7 rounded-md border border-border bg-background px-1.5 text-xs"
              >
                <option value="internal">internal</option>
                <option value="confidential">confidential</option>
                <option value="restricted">restricted</option>
              </select>
              <Button size="xs" variant="outline" onClick={() => patch(s.id, { hidden: !s.hidden })} disabled={busy === s.id}>
                {s.hidden ? <Eye data-icon="inline-start" /> : <EyeOff data-icon="inline-start" />}
                {s.hidden ? 'Show locked' : 'Hide'}
              </Button>
              <Button
                size="xs"
                onClick={() => patch(s.id, { status: s.status === 'released' ? 'held' : 'released' })}
                disabled={busy === s.id}
                variant={s.status === 'released' ? 'outline' : 'default'}
              >
                {busy === s.id ? <Loader2 data-icon="inline-start" className="animate-spin" /> : s.status === 'released' ? <Lock data-icon="inline-start" /> : <LockOpen data-icon="inline-start" />}
                {s.status === 'released' ? 'Hold' : 'Release'}
              </Button>
              <span className={cn('w-16 text-right text-[11px] font-medium', s.status === 'released' ? 'text-ok' : 'text-muted-foreground')}>{s.status}</span>
            </div>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{s.description}</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {s.audience.map((a) => (
              <span key={a.id} title={a.why ?? ''} className={cn('rounded-full border border-border px-2 py-0.5 text-[10.5px]', a.kind === 'group' && 'bg-muted')}>
                {a.name}
              </span>
            ))}
            {!s.audience.length && <span className="text-[10.5px] text-destructive">no audience: admins only even when released</span>}
          </div>
          {open === s.id && <ScopeDetail base={base} scope={s} scopes={[]} people={people} onChange={onChange} />}
        </div>
      ))}
    </div>
  )
}

function ScopeDetail({ base, scope, people, onChange }: { base: string; scope: Scope; scopes: Scope[]; people: Person[]; onChange: () => void }) {
  const [files, setFiles] = useState<{ id: string; source: string; path: string; format: string; origin: string; flagged: boolean; reasons: { kind: string; text: string }[] }[] | null>(null)
  const [allScopes, setAllScopes] = useState<Scope[]>([])
  const [audience, setAudience] = useState<string[]>(scope.audience.map((a) => a.id))
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    fetch(`${base}/scopes/${scope.id}/files`).then(json).then(setFiles)
    fetch(base).then(json).then((o) => setAllScopes(o.scopes))
    fetch(`${base}/people`).then(json).then((p) => setGroups(p.groups))
  }, [base, scope.id])
  async function move(fileId: string, scopeId: string) {
    const note = prompt('Why? (kept in the file’s reasons)') ?? ''
    await post(`${base}/files/move`, { fileIds: [fileId], scopeId, note })
    setFiles(await fetch(`${base}/scopes/${scope.id}/files`).then(json))
    onChange()
  }
  const options = [...groups.map((g) => ({ id: g.id, label: `group: ${g.name}` })), ...people.filter((p) => p.status === 'active').map((p) => ({ id: p.id, label: p.name }))]
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      {scope.evidence.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          <b>Based on:</b> {scope.evidence.join(' · ')}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <b>Audience:</b>
        <select multiple value={audience} onChange={(e) => setAudience([...e.target.selectedOptions].map((o) => o.value))} className="h-24 min-w-72 rounded-md border border-border bg-background px-1 text-[11px]">
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <Button size="xs" variant="outline" onClick={async () => (await post(`${base}/scopes/${scope.id}`, { audience }, 'PATCH'), onChange())}>
          Save audience
        </Button>
      </div>
      {!files ? (
        <div className="text-xs text-muted-foreground">Loading files…</div>
      ) : (
        <table className="w-full text-[11px]">
          <tbody>
            {files.map((f) => (
              <tr key={f.id} className={cn('border-t border-border align-top', f.flagged && 'bg-destructive/5')}>
                <td className="py-1 pr-2">
                  {f.flagged && <ShieldAlert className="mr-1 inline size-3 text-destructive" />}
                  <span className="text-muted-foreground">{f.source} / </span>
                  {f.path}
                </td>
                <td className="py-1 pr-2 text-muted-foreground">{f.reasons.map((r) => r.text).join(' · ')}</td>
                <td className="py-1">
                  <select defaultValue="" onChange={(e) => e.target.value && move(f.id, e.target.value)} className="h-6 rounded border border-border bg-background text-[10.5px]">
                    <option value="">Move to…</option>
                    {allScopes
                      .filter((s) => s.id !== scope.id)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function People({ people, overview }: { people: Person[]; overview: Overview }) {
  const [filter, setFilter] = useState('active')
  const shown = people.filter((p) => filter === 'all' || (filter === 'conflicts' ? p.conflicts?.length : p.status === filter))
  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap gap-1">
        {['active', 'former', 'guest', 'service', 'conflicts', 'all'].map((f) => (
          <Button key={f} size="xs" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)}>
            {f} ({f === 'all' ? people.length : f === 'conflicts' ? people.filter((p) => p.conflicts?.length).length : people.filter((p) => p.status === f).length})
          </Button>
        ))}
      </div>
      {overview.company_map?.excluded?.length ? (
        <p className="mb-3 text-[11px] text-muted-foreground">
          Not copied into groups (guests, service accounts and former staff never inherit access): {overview.company_map.excluded.map((e) => `${e.person} → ${e.group}`).join(', ')}
        </p>
      ) : null}
      <table className="w-full text-[11.5px]">
        <thead className="text-left text-[10px] text-muted-foreground uppercase">
          <tr>
            <th className="py-1">Name</th>
            <th>Title</th>
            <th>Department</th>
            <th>Location</th>
            <th>Manager</th>
            <th>Systems</th>
            <th>Groups</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.id} className="border-t border-border align-top">
              <td className="py-1 pr-2">
                <div className="font-medium">{p.name}</div>
                <div className="text-[10.5px] text-muted-foreground">{p.emails?.[0]}</div>
                {p.conflicts?.map((c) => (
                  <div key={c} className="text-[10.5px] text-destructive">
                    {c}
                  </div>
                ))}
              </td>
              <td className="pr-2">{p.title}</td>
              <td className="pr-2">{p.department}</td>
              <td className="pr-2">{p.location}</td>
              <td className="pr-2">{p.manager}</td>
              <td className="pr-2 text-muted-foreground">{p.systems?.join(', ')}</td>
              <td className="text-muted-foreground">{p.groups?.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface CatalogFile {
  id: string
  source_name: string
  original_path: string
  scope_id: string
  scope_name: string
  sensitivity: string
  can_open: boolean
  requested: boolean
}

function ViewAs({ base, people, onChange }: { base: string; people: Person[]; onChange: () => void }) {
  const [who, setWho] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [data, setData] = useState<{ total_files: number; listed: number; open: number; scopes: { scope_id: string; name: string; sensitivity: string; open: number; locked: number; requested: number }[]; files: CatalogFile[] } | null>(null)
  const [scopeFilter, setScopeFilter] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ citation: string; snippet: string }[] | null>(null)
  const load = useCallback(async () => {
    if (!who) return
    setData(null)
    setData(await fetch(`${base}/view-as/${who}?role=${role}`).then(json))
  }, [base, who, role])
  useEffect(() => {
    load()
    setHits(null)
  }, [load])
  async function request(target: { fileId?: string; scopeId?: string }) {
    const reason = prompt('Reason for the request?')
    if (reason === null) return
    const r = await post(`${base}/view-as/${who}/requests?role=${role}`, { ...target, reason })
    if (r.error) alert(r.error)
    await load()
    onChange()
  }
  const person = people.find((p) => p.id === who)
  const files = useMemo(() => (data?.files ?? []).filter((f) => !scopeFilter || f.scope_id === scopeFilter), [data, scopeFilter])
  return (
    <div className="p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={who} onChange={(e) => setWho(e.target.value)} className="h-8 min-w-72 rounded-md border border-border bg-background px-2 text-xs">
          <option value="">Pick a person…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.title ?? p.status} {p.status !== 'active' ? `(${p.status})` : ''}
            </option>
          ))}
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')} className="h-8 rounded-md border border-border bg-background px-2 text-xs">
          <option value="member">as employee</option>
          <option value="admin">as client admin (sees everything)</option>
        </select>
        {person && (
          <span className="text-xs text-muted-foreground">
            {person.department} · {person.location} · groups: {person.groups?.join(', ') || 'none'}
          </span>
        )}
      </div>
      {!who ? (
        <p className="text-sm text-muted-foreground">Pick someone to see exactly what the database lets them see. Everything runs as that person under row-level security.</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
          <div>
            <div className="mb-2 text-xs">
              Can open <b>{data.open}</b> · locked <b>{data.listed - data.open}</b> · hidden <b>{data.total_files - data.listed}</b> of {data.total_files} files
            </div>
            <div className="space-y-0.5">
              <button onClick={() => setScopeFilter(null)} className={cn('w-full rounded px-2 py-1 text-left text-xs hover:bg-muted', !scopeFilter && 'bg-muted')}>
                All listed scopes
              </button>
              {data.scopes.map((s) => (
                <div key={s.scope_id} className={cn('flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted', scopeFilter === s.scope_id && 'bg-muted')}>
                  <button className="min-w-0 flex-1 truncate text-left" onClick={() => setScopeFilter(s.scope_id)}>
                    {s.open ? <ShieldCheck className="mr-1 inline size-3 text-ok" /> : <Lock className="mr-1 inline size-3 text-muted-foreground" />}
                    {s.name}
                  </button>
                  <span className="text-muted-foreground tabular-nums">
                    {s.open}/{s.open + s.locked}
                  </span>
                  {s.locked > 0 && (
                    <button className="text-[10.5px] text-signal hover:underline" onClick={() => request({ scopeId: s.scope_id })}>
                      request all
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="min-w-0">
            <form
              className="mb-3 flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault()
                if (q.trim()) setHits((await post(`${base}/view-as/${who}/search?role=${role}`, { q })).hits ?? [])
              }}
            >
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search the content as ${person?.name ?? 'this person'}…`} className="h-8 text-xs" />
              <Button size="sm" type="submit">
                Search
              </Button>
            </form>
            {hits && (
              <div className="mb-4 space-y-1.5 rounded-lg border border-border p-2">
                <div className="text-[11px] text-muted-foreground">{hits.length ? `${hits.length} passages this person may read` : 'Nothing this person is allowed to read matches.'}</div>
                {hits.map((h, i) => (
                  <div key={i} className="text-[11px]">
                    <div className="font-mono text-[10.5px] text-muted-foreground">{h.citation}</div>
                    <div dangerouslySetInnerHTML={{ __html: h.snippet.replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') }} />
                  </div>
                ))}
              </div>
            )}
            <table className="w-full text-[11px]">
              <tbody>
                {files.slice(0, 400).map((f) => (
                  <tr key={f.id} className="border-t border-border">
                    <td className="py-1 pr-2">{f.can_open ? <LockOpen className="size-3 text-ok" /> : <Lock className="size-3 text-muted-foreground" />}</td>
                    <td className={cn('py-1 pr-2', !f.can_open && 'text-muted-foreground')}>
                      <span className="text-muted-foreground">{f.source_name} / </span>
                      {f.original_path}
                    </td>
                    <td className="py-1 pr-2 text-muted-foreground">{f.scope_name}</td>
                    <td className="py-1 text-right">
                      {!f.can_open &&
                        (f.requested ? (
                          <span className="text-[10.5px] text-muted-foreground">requested</span>
                        ) : (
                          <button className="text-[10.5px] text-signal hover:underline" onClick={() => request({ fileId: f.id })}>
                            Request access
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {files.length > 400 && <p className="mt-2 text-[11px] text-muted-foreground">Showing 400 of {files.length}; pick a scope on the left.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Requests({ base, actingAdmin, onChange }: { base: string; actingAdmin: string; onChange: () => void }) {
  const [rows, setRows] = useState<{ id: string; status: string; reason: string | null; created_at: string; requester: string; decided_by: string | null; file_path: string | null; scope_name: string; grant_level: string | null }[]>([])
  const load = useCallback(() => fetch(`${base}/requests`).then(json).then(setRows), [base])
  useEffect(() => {
    load()
  }, [load])
  async function decide(id: string, approve: boolean, level?: 'file' | 'scope') {
    if (!actingAdmin) return alert('Pick an acting admin (top right): decisions are made as a person.')
    const r = await post(`${base}/requests/${id}/decide`, { adminPrincipalId: actingAdmin, approve, level })
    if (r.error) alert(r.error)
    await load()
    onChange()
  }
  if (!rows.length) return <div className="p-6 text-sm text-muted-foreground">No requests yet. Use “View as” to request access as someone.</div>
  return (
    <table className="m-4 w-[calc(100%-2rem)] text-[11.5px]">
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-t border-border align-top">
            <td className="py-2 pr-3">
              <div className="font-medium">{r.requester}</div>
              <div className="text-[10.5px] text-muted-foreground">{new Date(r.created_at).toLocaleString()}</div>
            </td>
            <td className="py-2 pr-3">
              <div>{r.file_path ?? <i>whole scope</i>}</div>
              <div className="text-[10.5px] text-muted-foreground">scope: {r.scope_name}</div>
              {r.reason && <div className="text-[10.5px]">“{r.reason}”</div>}
            </td>
            <td className="py-2 text-right whitespace-nowrap">
              {r.status === 'pending' ? (
                <div className="flex justify-end gap-1">
                  {r.file_path && (
                    <Button size="xs" onClick={() => decide(r.id, true, 'file')}>
                      Approve file
                    </Button>
                  )}
                  <Button size="xs" variant="outline" onClick={() => decide(r.id, true, 'scope')}>
                    Approve whole scope
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => decide(r.id, false)}>
                    Deny
                  </Button>
                </div>
              ) : (
                <span className={cn('text-[11px]', r.status === 'approved' ? 'text-ok' : 'text-muted-foreground')}>
                  {r.status}
                  {r.grant_level ? ` (${r.grant_level})` : ''} by {r.decided_by ?? 'FDE'}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Risks({ overview }: { overview: Overview }) {
  return (
    <div className="max-w-4xl space-y-4 p-5">
      <p className="text-xs text-muted-foreground">Access found in the source systems that was deliberately not copied, and decisions for the client. Each is a lead to raise with the client, not a fact.</p>
      <ul className="list-disc space-y-1.5 pl-5 text-[12.5px]">
        {(overview.proposal?.notes ?? []).map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {overview.company_map?.unresolved?.length ? (
        <div className="text-xs text-muted-foreground">Unresolved in the company map: {overview.company_map.unresolved.map((u) => `${u.kind} “${u.value}” (${u.where})`).join('; ')}</div>
      ) : null}
    </div>
  )
}

function Audit({ base }: { base: string }) {
  const [rows, setRows] = useState<{ action: string; actor: string | null; created_at: string; detail: Record<string, unknown>; target: Record<string, unknown> }[]>([])
  useEffect(() => {
    fetch(`${base}/audit`).then(json).then(setRows)
  }, [base])
  return (
    <table className="m-4 w-[calc(100%-2rem)] text-[11px]">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-border align-top">
            <td className="py-1 pr-3 whitespace-nowrap text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
            <td className="py-1 pr-3 font-medium">{r.action}</td>
            <td className="py-1 pr-3">{r.actor ?? 'FDE / pipeline'}</td>
            <td className="py-1 font-mono text-[10px] text-muted-foreground">{JSON.stringify({ ...r.target, ...r.detail }).slice(0, 200)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
