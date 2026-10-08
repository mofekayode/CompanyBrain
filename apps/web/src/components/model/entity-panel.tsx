'use client'

// Everything the company model knows about one entity, and where each part came from.

import { FileText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { API } from '@/lib/api'
import { typeColor } from './colors'

interface Detail {
  id: string
  name: string
  type: string
  kind: string
  status: string
  description: string | null
  properties: Record<string, unknown>
  metadata: Record<string, unknown>
  aliases: { alias: string; kind: string; context: { source_system?: string } }[]
  identifiers: { system: string; value: string }[]
  facts: { id: string; predicate: string; value: unknown; object: string | null; valid_from: string | null; valid_to: string | null; authority: string | null; status: string; evidence: { quote: string; evidence_id: string }[] }[]
  merged_from: { id: string; name: string; system: string | null; why: string | null }[]
  evidence: { quote: string | null; citation: string; file_id: string; kind: string }[]
  connections: { rel: string; type: string; n: number }[]
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="border-t border-border px-4 py-3">
    <h4 className="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
    {children}
  </section>
)

export function EntityPanel({ slug, id, onOpenFile }: { slug: string; id: string; onFocus: (id: string) => void; onOpenFile: (fileId: string) => void }) {
  const [d, setD] = useState<Detail | null>(null)
  useEffect(() => {
    setD(null)
    fetch(`${API}/api/t/${slug}/model/entities/${id}`)
      .then((r) => r.json())
      .then(setD)
  }, [slug, id])
  if (!d) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>
  const color = typeColor(d.type)
  const props = Object.entries(d.properties).filter(([k, v]) => k !== 'source_system' && v !== null && v !== '')
  // Several merged records can carry the same spelling: show each name once.
  const aliases = [...new Map(d.aliases.filter((a) => a.alias.toLowerCase() !== d.name.toLowerCase()).map((a) => [a.alias.toLowerCase(), a])).values()]
  return (
    <div>
      <div className="px-4 pt-4 pb-3">
        <div className="mb-1 flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: color }} />
          <span className="text-[11px] font-medium" style={{ color }}>
            {d.type}
          </span>
          <Badge variant="outline" className="text-[10px]">
            {d.status}
          </Badge>
        </div>
        <h3 className="text-base leading-snug font-semibold">{d.name}</h3>
        {d.merged_from.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            One {d.type.toLowerCase()} across {new Set([d.properties.source_system, ...d.merged_from.map((m) => m.system)].filter(Boolean)).size} systems ({d.merged_from.length + 1} records merged)
          </p>
        )}
      </div>

      {aliases.length > 0 && (
        <Section title="Also known as">
          <div className="flex flex-wrap gap-1">
            {aliases.map((a) => (
              <span key={a.alias} title={`${a.kind}${a.context?.source_system ? ` · ${a.context.source_system}` : ''}`} className="rounded-full border border-border px-2 py-0.5 text-[11px]">
                {a.alias}
              </span>
            ))}
          </div>
        </Section>
      )}

      {d.connections.length > 0 && (
        <Section title="Connections">
          <div className="space-y-0.5">
            {d.connections.slice(0, 12).map((c) => (
              <div key={`${c.rel}-${c.type}`} className="flex items-center gap-2 text-[11.5px]">
                <span className="size-1.5 rounded-full" style={{ background: typeColor(c.type) }} />
                <span className="min-w-0 flex-1 truncate">
                  {c.rel.replace(/_/g, ' ')} <span className="text-muted-foreground">· {c.type}</span>
                </span>
                <span className="font-mono text-[11px] tabular-nums">{c.n.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {props.length > 0 && (
        <Section title="Properties">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
            {props.slice(0, 16).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-words">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {d.identifiers.length > 0 && (
        <Section title="Identifiers by system">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
            {d.identifiers.slice(0, 20).map((i) => (
              <div key={`${i.system}${i.value}`} className="contents">
                <dt className="text-muted-foreground">{i.system}</dt>
                <dd className="font-mono text-[11px]">{i.value}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {d.merged_from.length > 0 && (
        <Section title="Merged records">
          <ul className="space-y-1 text-[11.5px]">
            {d.merged_from.map((m) => (
              <li key={m.id}>
                <span className="font-medium">{m.name}</span> <span className="text-muted-foreground">({m.system ?? 'link'})</span>
                {m.why && <div className="text-[10.5px] text-muted-foreground">{m.why}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {d.facts.length > 0 && (
        <Section title="Facts">
          <ul className="space-y-1.5 text-[11.5px]">
            {d.facts.map((f) => (
              <li key={f.id}>
                <span className="font-medium">{f.predicate.replace(/_/g, ' ')}</span>: {f.object ?? (typeof f.value === 'string' ? f.value : JSON.stringify(f.value))}
                <span className="text-[10.5px] text-muted-foreground">
                  {f.valid_from ? ` · from ${f.valid_from}` : ''}
                  {f.valid_to ? ` to ${f.valid_to}` : ''} · {f.authority ?? 'unknown source'} · {f.status}
                </span>
                {f.evidence[0]?.quote && <div className="mt-0.5 border-l-2 border-border pl-2 text-[10.5px] text-muted-foreground italic">“{f.evidence[0].quote}”</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {d.evidence.length > 0 && (
        <Section title={`Evidence (${d.evidence.length})`}>
          <ul className="space-y-2">
            {d.evidence.slice(0, 30).map((e, i) => (
              <li key={i} className="text-[11px]">
                <button onClick={() => onOpenFile(e.file_id)} className="flex items-start gap-1 text-left text-signal hover:underline">
                  <FileText className="mt-0.5 size-3 shrink-0" />
                  <span className="font-mono text-[10.5px]">{e.citation}</span>
                </button>
                {e.quote && <div className="mt-0.5 line-clamp-3 font-mono text-[10px] text-muted-foreground">{e.quote}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
