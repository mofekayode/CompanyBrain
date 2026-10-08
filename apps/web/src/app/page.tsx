import { ArrowRight, FileStack, MessagesSquare } from 'lucide-react'
import { Logo } from '@/components/shell/logo'
import Link from 'next/link'
import { AddClient } from '@/components/workbench/add-client'
import type { ClientRow, RecentSession } from '@companybrain/core/workbench/portal'
import { apiGet } from '@/lib/api'

export const dynamic = 'force-dynamic'

async function load() {
  return (await apiGet<{ clients: ClientRow[]; recent: RecentSession[] }>('/api/portal')) ?? { clients: [], recent: [] }
}

function ago(iso: string | null): string {
  if (!iso) return '-'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function mb(bytes: string | null): string {
  return bytes ? `${Math.round(Number(bytes) / 1048576)} MB` : '0 MB'
}

export default async function Portal() {
  const { clients, recent } = await load()
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2.5 px-6">
          <Logo suffix={<span className="ml-1 rounded-full bg-cobalt-soft px-2 py-0.5 text-[11px] font-medium text-cobalt">FDE portal</span>} />
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-10 px-6 py-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section>
          <div className="mb-4 flex items-baseline justify-between">
            <h1 className="text-xl font-semibold">Clients</h1>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">{clients.length} active</span>
              <AddClient />
            </div>
          </div>
          <ul className="grid gap-3">
            {clients.map((c) => {
              const open = c.questions - c.confirmed - c.hypotheses
              return (
                <li key={c.slug}>
                  <Link
                    href={`/t/${c.slug}`}
                    className="group block rounded-2xl border border-border bg-card p-5 transition-colors hover:border-signal/40 hover:bg-signal/[0.03]"
                  >
                    <div className="flex items-start gap-4">
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-lg font-semibold">{c.name.slice(0, 1)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h2 className="truncate text-base font-semibold">{c.name}</h2>
                          <span className="font-mono text-[11px] text-muted-foreground">{c.slug}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">Last activity {ago(c.last_activity)}</p>
                      </div>
                      <span className="flex items-center gap-1 text-sm font-medium text-signal opacity-0 transition-opacity group-hover:opacity-100">
                        Open workbench <ArrowRight className="size-4" />
                      </span>
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-5 sm:grid-cols-[1fr_1.4fr]">
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          ['files', c.files],
                          ['sources', c.sources],
                          ['size', mb(c.bytes)],
                        ].map(([k, v]) => (
                          <div key={k} className="rounded-lg border border-border px-2.5 py-2">
                            <div className="font-mono text-sm font-semibold tabular-nums">{v}</div>
                            <div className="text-[10px] text-muted-foreground">{k}</div>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="mb-1.5 flex items-baseline justify-between text-xs">
                          <span className="font-medium">Source discovery</span>
                          <span className="font-mono text-muted-foreground tabular-nums">
                            {c.confirmed + c.hypotheses}/{c.questions}
                          </span>
                        </div>
                        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="bg-ok" style={{ width: `${(c.confirmed / Math.max(1, c.questions)) * 100}%` }} />
                          <div className="bg-signal" style={{ width: `${(c.hypotheses / Math.max(1, c.questions)) * 100}%` }} />
                        </div>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {c.confirmed} confirmed · {c.hypotheses} to review · {open} open · {c.issues} file issues · {c.duplicates} duplicates · {c.sessions} sessions
                        </p>
                      </div>
                    </div>
                  </Link>
                </li>
              )
            })}
            {clients.length === 0 && (
              <li className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                No clients yet. Use Add client to create one and upload their files.
              </li>
            )}
          </ul>
        </section>

        <aside>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Recent work</h2>
            <span className="text-xs text-muted-foreground">all clients</span>
          </div>
          <ol className="space-y-1">
            {recent.map((s) => (
              <li key={s.id}>
                <Link href={`/t/${s.slug}?s=${s.id}`} className="block rounded-xl px-3 py-2.5 transition-colors hover:bg-muted">
                  <div className="flex items-start gap-2.5">
                    <MessagesSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="line-clamp-2 text-[13px] leading-snug">{s.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">{s.client}</span>· {ago(s.updated_at)} · {s.steps} steps
                        {s.findings > 0 && (
                          <span className="inline-flex items-center gap-1 text-signal">
                            · <FileStack className="size-3" /> {s.findings} findings
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
            {recent.length === 0 && <li className="px-3 text-sm text-muted-foreground">No sessions yet.</li>}
          </ol>
        </aside>
      </main>
    </div>
  )
}
