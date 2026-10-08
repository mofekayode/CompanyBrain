'use client'

// Configuration: everything this client runs with and everything the FDE taught the
// system, in one place. Rules are defaults + this client's overrides (versioned);
// the learned work (mappings, vocabulary, merges, access, checks) exports to one
// file that can be re-applied, reviewed in git, or used to start the next client.

import type { RulesOverride, TenantRules } from '@companybrain/core/config/tenant-config'
import { ArrowDownToLine, FileJson, Loader2, RotateCcw, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, PageBody, PageHeader, Pill, Section, Stat } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { API } from '@/lib/api'
import { cn } from '@/lib/utils'

interface ConfigData {
  defaults: TenantRules
  overrides: RulesOverride
  effective: TenantRules
  version: number
  history: { version: number; note: string | null; author: string; created_at: string }[]
}

interface Summary {
  rules_changed: number
  entity_types: number
  relationship_types: number
  table_mappings: number
  directory_mappings: number
  vocabulary: number
  rejected_aliases: number
  merges: number
  kept_separate: number
  scopes: number
  file_moves: number
  eval_items: number
  tables: { path: string; system: string; kind: string; type: string | null; links: number }[]
  vocabulary_sample: { entity_type: string; entity: string; alias: string; kind: string; status: string }[]
  rejected_sample: { entity_type: string; entity: string; alias: string; kind: string; status: string }[]
}

export function ConfigPage({ slug }: { slug: string }) {
  const [cfg, setCfg] = useState<ConfigData | null>(null)
  const [sum, setSum] = useState<Summary | null>(null)
  const [importing, setImporting] = useState(false)
  const [report, setReport] = useState<Record<string, unknown> | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    fetch(`${API}/api/t/${slug}/config`).then((r) => r.json()).then(setCfg).catch(() => {})
    fetch(`${API}/api/t/${slug}/config/summary`).then((r) => r.json()).then(setSum).catch(() => {})
  }, [slug])
  useEffect(load, [load])

  const onImport = async (f: File) => {
    setImporting(true)
    setReport(null)
    try {
      const res = await fetch(`${API}/api/t/${slug}/config/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: await f.text() })
      setReport(await res.json())
      load()
    } finally {
      setImporting(false)
    }
  }

  return (
    <PageBody>
      <PageHeader
        eyebrow="Setup"
        title="Configuration"
        actions={
          <>
            <Button size="sm" variant="outline" nativeButton={false} render={<a href={`${API}/api/t/${slug}/config/export?mode=template`} />}>
              <FileJson /> Template
            </Button>
            <Button size="sm" variant="outline" nativeButton={false} render={<a href={`${API}/api/t/${slug}/config/export`} />}>
              <ArrowDownToLine /> Export
            </Button>
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={importing}>
              {importing ? <Loader2 className="animate-spin" /> : <Upload />} Import
            </Button>
            <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
          </>
        }
      >
        The rules this client runs with, and everything the FDE taught the system about it. <span className="text-foreground">Export</span> keeps all of it (re-apply after a
        rebuild, review in git). <span className="text-foreground">Template</span> keeps only what transfers to the next company: rules and the catalogue of types.
      </PageHeader>

      {report && (
        <Card className="mb-6 p-4">
          <div className="eyebrow">Import result</div>
          <pre className="mt-2 max-h-64 overflow-auto font-mono text-[11px] leading-relaxed">{JSON.stringify(report, null, 2)}</pre>
        </Card>
      )}

      {sum ? (
        <Card className="grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-4">
          <Stat value={sum.entity_types} label={`Types · ${sum.relationship_types} links`} />
          <Stat value={sum.table_mappings + sum.directory_mappings} label="Source mappings" />
          <Stat value={sum.vocabulary} label={`Aliases · ${sum.rejected_aliases} rejected`} />
          <Stat value={sum.merges} label={`Merges · ${sum.kept_separate} kept apart`} />
          <Stat value={sum.scopes} label={`Access scopes · ${sum.file_moves} moves`} />
          <Stat value={sum.eval_items} label="Checks & questions" />
          <Stat value={sum.rules_changed} label="Rules changed" tone={sum.rules_changed ? 'stale' : undefined} />
          <Stat value={cfg ? `v${cfg.version}` : '–'} label="Rules version" />
        </Card>
      ) : (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      )}

      {cfg && <RulesEditor slug={slug} cfg={cfg} onSaved={load} />}

      {sum && (
        <Section title="Source mappings" hint="How each structured export becomes things and events. Reused on rebuild, no AI call needed.">
          <Card className="overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead className="bg-background/60 text-left">
                <tr className="border-b border-border">
                  {['File', 'System', 'Becomes', 'Links'].map((h) => (
                    <th key={h} className="eyebrow-muted px-4 py-2 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sum.tables.map((t) => (
                  <tr key={t.path}>
                    <td className="max-w-80 truncate px-4 py-2 font-mono text-[11.5px]" title={t.path}>
                      {t.path}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{t.system}</td>
                    <td className="px-4 py-2">
                      <Pill tone={t.kind === 'events' ? 'cobalt' : 'neutral'}>
                        {t.type} {t.kind === 'events' ? 'events' : ''}
                      </Pill>
                    </td>
                    <td className="px-4 py-2 font-mono text-muted-foreground">{t.links}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </Section>
      )}

      {sum && (
        <Section title="Company language" hint="Nicknames, jargon and old names the FDE confirmed, and the ones rejected so they never come back.">
          <div className="flex flex-wrap gap-1.5">
            {sum.vocabulary_sample.map((v) => (
              <span key={`${v.entity}|${v.alias}`} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[12px]" title={`${v.kind} · ${v.entity_type}`}>
                <span>“{v.alias}”</span>
                <span className="text-cobalt">→</span>
                <span className="text-muted-foreground">{v.entity}</span>
              </span>
            ))}
            {sum.rejected_sample.map((v) => (
              <span key={`x|${v.entity}|${v.alias}`} className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-[12px] text-muted-foreground" title="rejected">
                <span className="line-through">“{v.alias}”</span>
                <span className="line-through">{v.entity}</span>
              </span>
            ))}
          </div>
        </Section>
      )}

      {cfg && cfg.history.length > 0 && (
        <Section title="Rule history">
          <Card className="divide-y divide-border">
            {cfg.history.map((h) => (
              <div key={h.version} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
                <span className="font-mono text-muted-foreground">v{h.version}</span>
                <span className="min-w-0 flex-1 truncate">{h.note}</span>
                <span className="text-muted-foreground">{h.author}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{new Date(h.created_at).toLocaleString()}</span>
              </div>
            ))}
          </Card>
        </Section>
      )}
    </PageBody>
  )
}

/** Editable rules: the few things people tune by hand, plus raw JSON for the rest. */
function RulesEditor({ slug, cfg, onSaved }: { slug: string; cfg: ConfigData; onSaved: () => void }) {
  const [draft, setDraft] = useState<TenantRules>(cfg.effective)
  const [note, setNote] = useState('')
  const [json, setJson] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  useEffect(() => {
    setDraft(cfg.effective)
    setJson(JSON.stringify(cfg.overrides, null, 2))
  }, [cfg])

  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(cfg.effective), [draft, cfg])
  const set = <S extends keyof TenantRules, K extends keyof TenantRules[S]>(section: S, key: K, value: TenantRules[S][K]) =>
    setDraft((d) => ({ ...d, [section]: { ...d[section], [key]: value } }))
  const isDefault = <S extends keyof TenantRules>(section: S, key: keyof TenantRules[S]) => JSON.stringify(draft[section][key]) === JSON.stringify(cfg.defaults[section][key])

  const save = async () => {
    setSaving(true)
    setProblems([])
    let overrides: unknown = draft
    if (advanced) {
      try {
        overrides = JSON.parse(json)
      } catch (e) {
        setProblems([`JSON: ${(e as Error).message}`])
        setSaving(false)
        return
      }
    }
    const res = await fetch(`${API}/api/t/${slug}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides, note }) })
    const body = await res.json()
    setSaving(false)
    if (!res.ok) return setProblems(body.problems ?? [body.error ?? 'save failed'])
    setNote('')
    onSaved()
  }

  const rank = Object.entries(draft.authority.rank).sort((a, b) => b[1] - a[1])
  return (
    <Section
      title="Rules"
      hint="Defaults come from our playbook; anything changed here applies to this client only and is versioned."
      actions={
        <button type="button" onClick={() => setAdvanced((a) => !a)} className="text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {advanced ? 'Form' : 'Edit as JSON'}
        </button>
      }
    >
      <Card className="p-5">
        {advanced ? (
          <Textarea value={json} onChange={(e) => setJson(e.target.value)} className="min-h-72 font-mono text-[11.5px]" spellCheck={false} />
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            <Field label="About the company" hint="Added to every AI prompt for this client." changed={!isDefault('prompts', 'company_context')}>
              <Textarea
                value={draft.prompts.company_context}
                onChange={(e) => set('prompts', 'company_context', e.target.value)}
                placeholder="What they do, how they're organised, their quirks…"
                className="min-h-20 text-[12.5px]"
              />
            </Field>
            <div className="grid gap-4">
              <Field label="Their systems" hint="Comma-separated, as people say them." changed={!isDefault('prompts', 'system_examples')}>
                <Input value={draft.prompts.system_examples.join(', ')} onChange={(e) => set('prompts', 'system_examples', splitList(e.target.value))} className="text-[12.5px]" />
              </Field>
              <Field label="In-house terms" hint="Examples that help the reader spot jargon." changed={!isDefault('prompts', 'vocabulary_examples')}>
                <Input value={draft.prompts.vocabulary_examples.join(', ')} onChange={(e) => set('prompts', 'vocabulary_examples', splitList(e.target.value))} className="text-[12.5px]" />
              </Field>
            </div>
            <Field label="Which source wins" hint="Higher wins when statements disagree." changed={!isDefault('authority', 'rank')}>
              <div className="grid grid-cols-2 gap-1.5">
                {rank.map(([k, v]) => (
                  <label key={k} className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1 text-[12px]">
                    <span className="truncate">{k.replaceAll('_', ' ')}</span>
                    <input
                      type="number"
                      value={v}
                      onChange={(e) => set('authority', 'rank', { ...draft.authority.rank, [k]: Number(e.target.value) })}
                      className="w-10 bg-transparent text-right font-mono outline-none"
                    />
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Duplicate resolution" hint="Small types are reviewed whole; huge ones only get certain merges." changed={!isDefault('resolution', 'small_type_max') || !isDefault('resolution', 'max_fuzzy') || !isDefault('resolution', 'strong_systems')}>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Review whole type up to" value={draft.resolution.small_type_max} onChange={(v) => set('resolution', 'small_type_max', v)} />
                <NumberField label="Fuzzy review up to" value={draft.resolution.max_fuzzy} onChange={(v) => set('resolution', 'max_fuzzy', v)} />
              </div>
              <Input
                value={draft.resolution.strong_systems.join(', ')}
                onChange={(e) => set('resolution', 'strong_systems', splitList(e.target.value))}
                className="mt-2 text-[12.5px]"
                title="Identifier systems where a shared value means the same thing"
              />
            </Field>
            <Field label="Cleaning patterns" hint="Placeholders, code lists, identifier columns (edit as JSON)." changed={!isDefault('cleaning', 'placeholder_values') || !isDefault('cleaning', 'code_list')}>
              <div className="grid gap-1 font-mono text-[11px] text-muted-foreground">
                <span className="truncate" title={draft.cleaning.placeholder_values.pattern}>
                  placeholder /{draft.cleaning.placeholder_values.pattern}/
                </span>
                <span className="truncate" title={draft.cleaning.code_list.pattern}>
                  code list /{draft.cleaning.code_list.pattern}/
                </span>
                <span>ids: {draft.cleaning.strong_id_columns.map((s) => s.system).join(', ')}</span>
              </div>
            </Field>
            <Field label="People signals" hint='When someone counts as "possibly former".' changed={!isDefault('people', 'former_quiet_days') || !isDefault('people', 'former_min_sent')}>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Quiet for (days)" value={draft.people.former_quiet_days} onChange={(v) => set('people', 'former_quiet_days', v)} />
                <NumberField label="After sending at least" value={draft.people.former_min_sent} onChange={(v) => set('people', 'former_min_sent', v)} />
              </div>
            </Field>
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (required), e.g. “their HR export uses 'ohne' for nobody”" className="max-w-md flex-1 text-[12.5px]" />
          <Button size="sm" onClick={save} disabled={saving || !note.trim() || (!changed && !advanced)}>
            {saving && <Loader2 className="animate-spin" />} Save as v{cfg.version + 1}
          </Button>
          {changed && !advanced && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(cfg.effective)}>
              <RotateCcw /> Undo changes
            </Button>
          )}
          {problems.map((p) => (
            <span key={p} className="text-[12px] text-destructive">
              {p}
            </span>
          ))}
        </div>
      </Card>
    </Section>
  )
}

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

function Field({ label, hint, changed, children }: { label: string; hint?: string; changed?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        {changed && <Pill tone="stale">changed</Pill>}
      </div>
      {children}
      {hint && <p className="mt-1 text-[11.5px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className={cn('flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1 text-[12px]')}>
      <span className="truncate text-muted-foreground">{label}</span>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-14 bg-transparent text-right font-mono outline-none" />
    </label>
  )
}
