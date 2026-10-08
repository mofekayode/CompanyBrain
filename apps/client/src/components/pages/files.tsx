'use client'

// The file catalog: everything the company handed over, grouped by who it's for. Files you
// can open, open in place; locked ones show what they are (unless their area is hidden)
// and can be requested, one file, or the whole area. Admins decide in Access.

import { Check, ChevronDown, FileText, FolderSearch, Lock, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { SourceViewer } from '@/components/answer/bits'
import { useSession } from '@/components/shell/session'
import { EmptyState, HowItWorks, SkeletonList } from '@/components/states'
import { getJSON, postJSON, tenantApi } from '@/lib/api'
import type { BriefSource } from '@/lib/types'
import { cn } from '@/lib/utils'

interface CatalogFile {
  id: string
  original_path: string
  original_filename: string
  format: string
  size_bytes: string
  scope_id: string
  scope_name: string
  sensitivity: string
  can_open: boolean
  requested: boolean
}
interface Catalog {
  total_files: number
  listed: number
  open: number
  scopes: { scope_id: string; name: string; sensitivity: string; open: number; locked: number; requested: number }[]
  files: CatalogFile[]
}

const JUNK = /^(thumbs\.db|desktop\.ini|\.ds_store|~\$.*)$/i
const KIND = (f: string) => (/(mp4|mov|m4v)/.test(f) ? 'video' : /(m4a|mp3|wav)/.test(f) ? 'interview' : /(jpg|jpeg|png|heic)/.test(f) ? 'photo' : /(xlsx|xls|csv)/.test(f) ? 'spreadsheet' : /eml/.test(f) ? 'email' : 'document')

export function Files({ openId }: { openId?: string }) {
  const { slug, me } = useSession()
  const [cat, setCat] = useState<Catalog | null>(null)
  const [q, setQ] = useState('')
  const [showRequestable, setShowRequestable] = useState(false)
  // The how-to shows until someone has used the page (opened or requested something).
  const [seen, setSeen] = useState(true)
  useEffect(() => {
    try {
      setSeen(localStorage.getItem('cb.sources.seen') === '1')
    } catch {}
  }, [])
  const markSeen = () => {
    try {
      localStorage.setItem('cb.sources.seen', '1')
    } catch {}
  }
  const [openScopes, setOpenScopes] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<BriefSource | null>(null)
  const [sent, setSent] = useState<Set<string>>(new Set())
  const base = `${tenantApi(slug)}/access/catalog/${me?.id}?role=${me?.admin ? 'admin' : 'member'}`

  useEffect(() => {
    setCat(null)
    if (me) getJSON<Catalog>(base).then(setCat)
  }, [base, me])

  // Opened from ⌘K or typeahead: /sources?open=<file id>
  const [notOpenable, setNotOpenable] = useState(false)
  useEffect(() => {
    if (!cat || !openId) return
    const f = cat.files.find((x) => x.id === openId)
    if (f?.can_open) setViewing({ n: 0, id: f.id, title: f.original_filename, where: f.original_path, kind: KIND(f.format), status: 'supporting', file_id: f.id, start_ms: null, quote: null })
    else {
      setNotOpenable(true)
      if (f) setOpenScopes((x) => new Set(x).add(f.scope_id))
    }
  }, [cat, openId])

  // Asking for access: a small form (what, why) instead of a browser prompt.
  const [asking, setAsking] = useState<{ fileId?: string; scopeId?: string; label: string } | null>(null)
  const [reason, setReason] = useState('')
  const [sending, setSending] = useState(false)
  const request = (body: { fileId?: string; scopeId?: string }, label: string) => {
    setReason('')
    setAsking({ ...body, label })
  }
  const send = async () => {
    if (!asking) return
    setSending(true)
    await postJSON(`${tenantApi(slug)}/access/view-as/${me?.id}/requests?role=${me?.admin ? 'admin' : 'member'}`, { fileId: asking.fileId, scopeId: asking.scopeId, reason })
    setSent((s) => new Set(s).add(asking.fileId ?? asking.scopeId!))
    markSeen()
    setSending(false)
    setAsking(null)
  }

  // Only files you can open are listed (and searchable by name): a locked file's name can be
  // confidential too. Locked areas show their name and size, and can be requested as a whole.
  const files = useMemo(() => (cat?.files ?? []).filter((f) => f.can_open && !JUNK.test(f.original_filename) && (!q || f.original_path.toLowerCase().includes(q.toLowerCase()))), [cat, q])
  const yours = (cat?.scopes ?? []).filter((s) => s.open > 0).map((s) => ({ ...s, files: files.filter((f) => f.scope_id === s.scope_id) })).filter((s) => s.files.length).sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
  const requestable = (cat?.scopes ?? []).filter((s) => s.open === 0 && s.locked > 0).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="pt-10">
      <div className="eyebrow">Sources</div>
      <h1 className="mt-2 text-[34px] leading-tight font-semibold tracking-[-0.03em]">Everything answers come from.</h1>
      <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground">
        Documents, spreadsheets, email, recordings, photos and system exports you can open, grouped into areas.
      </p>
      {notOpenable && (
        <p className="mt-4 rounded-lg border border-border bg-white px-3 py-2 text-[13px]">
          That file is in an area you don’t have access to. Use <b>Request access</b> on its area below.
        </p>
      )}
      {!seen && <HowItWorks
        className="mt-6"
        steps={[
          { title: 'Open what’s yours', body: 'Open an area, then click a file to read it here: PDFs, spreadsheets, photos, recordings. Answers and briefs use the same files.' },
          { title: 'Ask for more', body: <>Need something you can’t see? Use <b>Show areas you can request</b> below and say why you need it.</> },
          { title: 'Wait for a yes', body: 'The people who manage access approve or deny it. Once approved, the files open here and in answers.' },
        ]}
      />}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <label className="flex min-w-64 flex-1 items-center gap-2 rounded-xl border border-border bg-white px-3 py-2">
          <Search className="size-4 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or folder" className="flex-1 bg-transparent text-[14px] outline-none" />
        </label>
        {cat && <span className="text-[13px] text-muted-foreground">{cat.open.toLocaleString()} sources</span>}
      </div>
      {!cat ? (
        <SkeletonList rows={6} className="mt-6" />
      ) : (
        <>
          {!yours.length ? (
            <EmptyState icon={FolderSearch} title={q ? 'No sources match' : 'Nothing is open to you yet'} className="mt-6" action={q ? <button onClick={() => setQ('')} className="rounded-lg border border-border bg-white px-3 py-1.5 text-[13px]">Clear filter</button> : undefined}>
              {q ? 'Try part of a file or folder name.' : 'Ask the people who manage access, or request an area below.'}
            </EmptyState>
          ) : (
            <div className="mt-6 space-y-3">
              {yours.map((s) => {
                const expanded = openScopes.has(s.scope_id) || !!q
                return (
                  <section key={s.scope_id} className="rounded-2xl border border-border bg-white">
                    <button
                      onClick={() =>
                        setOpenScopes((x) => {
                          const n = new Set(x)
                          n.has(s.scope_id) ? n.delete(s.scope_id) : n.add(s.scope_id)
                          return n
                        })
                      }
                      className="flex w-full items-center gap-2 px-4 py-3 text-left"
                    >
                      <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !expanded && '-rotate-90')} />
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{s.name}</span>
                      <span className="font-mono text-[11.5px] text-muted-foreground">{s.files.length}</span>
                    </button>
                    {expanded && (
                      <ul className="divide-y divide-border border-t border-border">
                        {s.files.slice(0, 300).map((f) => (
                          <li key={f.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                            <button
                              onClick={() => {
                                markSeen()
                                setViewing({ n: 0, id: f.id, title: f.original_filename, where: f.original_path, kind: KIND(f.format), status: 'supporting', file_id: f.id, start_ms: null, quote: null })
                              }}
                              className="min-w-0 flex-1 truncate text-left hover:text-cobalt"
                            >
                              {f.original_path}
                            </button>
                            <span className="font-mono text-[10.5px] text-muted-foreground">{f.format}</span>
                          </li>
                        ))}
                        {s.locked > 0 && (
                          <li className="flex items-center gap-3 px-4 py-2 text-[12.5px] text-muted-foreground">
                            <Lock className="size-3.5" /> {s.locked} more in this area you can request
                            {s.requested || sent.has(s.scope_id) ? (
                              <span className="ml-auto flex items-center gap-1 text-verified">
                                <Check className="size-3.5" /> Requested
                              </span>
                            ) : (
                              <button onClick={() => request({ scopeId: s.scope_id }, `everything in “${s.name}”`)} className="ml-auto text-cobalt hover:underline">
                                Request access
                              </button>
                            )}
                          </li>
                        )}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
          )}

          {requestable.length > 0 && (
            <section className="mt-8">
              <button type="button" onClick={() => setShowRequestable((v) => !v)} className="flex items-center gap-1.5 text-[13px] text-ink/80 hover:text-ink">
                <ChevronDown className={cn('size-4 transition-transform', !showRequestable && '-rotate-90')} /> Show areas you can request ({requestable.length})
              </button>
              {showRequestable && (
                <ul className="mt-3 divide-y divide-border rounded-2xl border border-border bg-white">
                  {requestable.map((s) => (
                    <li key={s.scope_id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                      <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{s.locked} files</span>
                      {s.requested || sent.has(s.scope_id) ? (
                        <span className="flex items-center gap-1 text-[12px] text-verified">
                          <Check className="size-3.5" /> Requested
                        </span>
                      ) : (
                        <button onClick={() => request({ scopeId: s.scope_id }, `everything in “${s.name}”`)} className="rounded-lg border border-border px-2.5 py-1 text-[12px] hover:border-cobalt">
                          Request access
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
      <SourceViewer source={viewing} onClose={() => setViewing(null)} />
      {asking && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 px-4" onClick={() => setAsking(null)}>
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
            className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[15px] font-semibold">Request access</p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">to {asking.label}</p>
              </div>
              <button type="button" onClick={() => setAsking(null)} className="rounded-md p-1 hover:bg-muted" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
            <label className="mt-4 block text-[12.5px] font-medium">Why do you need it?</label>
            <textarea
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Preparing the Blue Ridge renewal; need the signed agreement."
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-[13.5px] outline-none focus:border-cobalt"
            />
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">Sent to the people who manage access. You’ll see the files here once it’s approved.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setAsking(null)} className="rounded-lg border border-border px-3 py-1.5 text-[13px]">
                Cancel
              </button>
              <button type="submit" disabled={sending} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] text-white disabled:opacity-60">
                {sending ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
