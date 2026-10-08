'use client'

// Search results organised around the thing searched for: an "about" card (what it is, what
// it's also called, where it sits, what changed, the best evidence), then results grouped by
// what they mean to the reader (facts, what changed, documents, conversations, other records),
// each row showing the one sentence that matched rather than a raw extract.

import { ArrowUpRight, Building2, History, MapPin, Sparkles } from 'lucide-react'
import Link from 'next/link'
import { kindIcon, StatusPill, Timeline } from '@/components/answer/bits'
import { cap, humanDate, period, tidy } from '@/lib/text'
import type { BriefSource, PageFact, Step } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface Hit {
  id: string
  doc_type: 'passage' | 'entity' | 'fact'
  kind: string
  title: string
  snippet: string
  content: string
  path: string | null
  source_name: string | null
  source_object_id: string | null
  observed_at: string | null
  valid_from: string | null
  valid_to: string | null
  citation: Record<string, unknown>
  is_current: boolean
}

export interface Card {
  id: string
  name: string
  type: string
  title: string | null
  /** Plain note when a current fact says the record is no longer active ("Former; left after the sale"). */
  status_note: string | null
  aliases: string[]
  context: { id: string; name: string; type: string }[]
  changed: PageFact | null
  facts: PageFact[]
  fact_count: number
}

const KIND: Record<string, string> = { email_body: 'email', transcript_segment: 'interview', video_segment: 'video', image: 'photo', table: 'spreadsheet', text: 'document', ocr: 'document' }
export const kindOf = (h: Hit) => KIND[h.kind] ?? 'document'

// ---------------------------------------------------------------- grouping

export const GROUPS = [
  { key: 'facts', label: 'Facts', short: 'facts' },
  { key: 'changed', label: 'What changed', short: 'changed' },
  { key: 'evidence', label: 'Documents and data', short: 'documents' },
  { key: 'conversations', label: 'Conversations', short: 'conversations' },
  { key: 'records', label: 'Related records', short: 'records' },
] as const
export type GroupKey = (typeof GROUPS)[number]['key']

export const groupOf = (h: Hit): GroupKey => {
  if (h.doc_type === 'fact') return h.is_current ? 'facts' : 'changed'
  if (h.doc_type === 'entity') return 'records'
  const k = kindOf(h)
  return k === 'email' || k === 'interview' || k === 'video' ? 'conversations' : 'evidence'
}

/** Several pages or row blocks of one file are one result: the best-ranked place, plus a count. */
export interface FileHit {
  hit: Hit
  more: number
}
export function byFile(hits: Hit[]): FileHit[] {
  const out: FileHit[] = []
  const at = new Map<string, number>()
  for (const h of hits) {
    const key = h.kind === 'email_body' ? h.id : (h.source_object_id ?? h.path ?? h.id)
    const i = at.get(key)
    if (i === undefined) {
      at.set(key, out.length)
      out.push({ hit: h, more: 0 })
    } else out[i].more++
  }
  return out
}

// ---------------------------------------------------------------- text

/** The words the search engine matched («…» in the snippet). */
const marked = (snippet: string) => [...new Set([...snippet.matchAll(/«([^»]+)»/g)].map((m) => m[1].toLowerCase()))]

/** The readable body of a passage: no email headers, markdown, table pipes or timestamps. */
function body(h: Hit): string {
  let t = h.content
  if (h.kind === 'email_body') {
    const parts = t.split(/\n\s*\n/)
    if (parts.length > 1 && /^(From|To|Subject|Date|Sent):/im.test(parts[0])) t = parts.slice(1).join('\n')
  }
  return t
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?(?:\s*[–-]\s*\d{1,2}:\d{2}(?::\d{2})?)?\]\s*/g, '')
    .replace(/^\s*(Speaker \d+|[A-Z][a-z]+(?: [A-Z][a-z]+)?):\s/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[_=*]{3,}|-{4,}/g, ' ')
    .replace(/[ \t]*\|[ \t]*/g, ' · ')
    .replace(/(?:[ \t]*·[ \t]*){2,}/g, ' · ')
    .replace(/^[ \t]*·[ \t]*|[ \t]*·[ \t]*$/gm, '')
    .replace(/<[^>\s]+@[^>\s]+>/g, '')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '')
const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The one sentence (or table row) that matched, with the match highlighted (HTML). Prefers the
 * place that holds the whole query ("TP-17", "TP17"), then the one with the most matched words,
 * so a spreadsheet block shows the row about TP-17, not the first row that says "TP".
 */
export function matchedSentence(h: Hit, query = '', max = 240): string {
  const terms = marked(h.snippet).filter((t) => t.length > 1)
  const whole = norm(query)
  const sentences = body(h)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 2)
  // A real sentence beats a line that is only the match (a signature, a header): "Dave Brennan".
  const words = (s: string) => s.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length
  const score = (s: string) => (whole.length > 1 && norm(s).includes(whole) ? 100 : 0) + terms.filter((t) => new RegExp(`\\b${reEsc(t)}\\b`, 'i').test(s)).length + (words(s) >= 6 ? 0.5 : -50)
  let pick = sentences.reduce((best, s) => (score(s) > score(best) ? s : best), sentences[0] ?? '')
  // The query as written in this sentence ("TP-17", "TP 17", "TP17"), to highlight as one piece.
  const loose = whole.length > 1 ? new RegExp(whole.split('').map(reEsc).join('[^a-z0-9]?'), 'i').exec(pick)?.[0] : undefined
  // Long sentence (a table row, a run-on line): keep the part around the match.
  if (pick.length > max) {
    const at = loose ? pick.indexOf(loose) : Math.max(0, ...terms.map((t) => pick.toLowerCase().indexOf(t)).filter((x) => x >= 0).slice(0, 1))
    const start = Math.max(0, at - Math.floor(max / 3))
    pick = `${start ? '…' : ''}${pick.slice(start, start + max).trim()}…`
  }
  const mark = '<mark class="rounded-sm bg-cobalt-soft px-0.5 text-navy">$1</mark>'
  let html = esc(tidy(pick))
  if (loose) return html.replace(new RegExp(`(${reEsc(esc(loose))})`, 'gi'), mark)
  for (const t of terms.sort((a, b) => b.length - a.length)) html = html.replace(new RegExp(`\\b(${reEsc(t)})\\b`, 'gi'), mark)
  return html
}

const fileName = (h: Hit) => h.path?.split('/').pop() ?? h.title.split(' · ')[0]
const where = (h: Hit) => {
  const c = h.citation
  const t = (ms: unknown) => `${Math.floor(Number(ms) / 60000)}:${String(Math.floor(Number(ms) / 1000) % 60).padStart(2, '0')}`
  if (c.start_ms != null) return t(c.start_ms)
  if (c.page_start) return `p. ${c.page_start}`
  if (c.row_start) return `rows ${c.row_start}–${c.row_end}`
  return ''
}
const dateOf = (h: Hit) => humanDate((h.observed_at ?? (h.citation.date as string | undefined) ?? '').slice(0, 10))
const sender = (h: Hit) => {
  const from = String(h.citation.from ?? '')
  return from.replace(/\s*<[^>]*>/, '').replace(/"/g, '').trim() || from.split('@')[0]
}

const BADGE: Record<string, string> = { pdf: 'PDF', pptx: 'Slides', ppt: 'Slides', docx: 'Word', doc: 'Word', xlsx: 'Excel', xls: 'Excel', csv: 'CSV', txt: 'Text', md: 'Text' }
function badgeOf(h: Hit): string {
  const k = kindOf(h)
  if (k === 'email') return 'Email'
  if (k === 'interview') return 'Recording'
  if (k === 'video') return 'Video'
  if (k === 'photo') return 'Photo'
  const ext = fileName(h).split('.').pop()?.toLowerCase() ?? ''
  return BADGE[ext] ?? (k === 'spreadsheet' ? 'Data' : 'Document')
}
export function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('inline-flex shrink-0 items-center rounded-md border border-border bg-paper px-1.5 py-px text-[10.5px] font-medium tracking-wide text-ink/70 uppercase', className)}>{children}</span>
}

/** What the source viewer needs to open a passage in place. */
export const toSource = (h: Hit): BriefSource => ({
  n: 0,
  id: h.id,
  title: fileName(h),
  where: [fileName(h), where(h)].filter(Boolean).join(', '),
  kind: kindOf(h),
  status: 'supporting',
  file_id: h.source_object_id,
  start_ms: h.citation.start_ms != null ? Number(h.citation.start_ms) : null,
  quote: null,
})

// ---------------------------------------------------------------- the about card

export function AboutCard({ card, slug, evidence, onOpen, onAsk }: { card: Card; slug: string; evidence: FileHit[]; onOpen: (h: Hit) => void; onAsk: () => void }) {
  const ch = card.changed
  return (
    <section className="rounded-2xl border border-border bg-white">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow-muted">{card.type === 'Asset' ? 'Equipment' : card.type}</div>
            <Link href={`/${slug}/e/${card.id}`} className="mt-1 block text-[24px] leading-tight font-semibold tracking-[-0.02em] text-ink hover:underline">
              {card.name}
            </Link>
            {card.status_note && <p className="mt-1.5 inline-flex rounded-md bg-stale-soft px-2 py-0.5 text-[12.5px] text-stale">{card.status_note}</p>}
            {card.aliases.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
                Also known as
                {card.aliases.map((a) => (
                  <span key={a} className="rounded-md bg-secondary px-1.5 py-0.5 font-medium text-ink/80">
                    {a}
                  </span>
                ))}
              </p>
            )}
            {(card.title || card.context.length > 0) && (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-ink/80">
                {card.title && <span>{card.title}</span>}
                {card.context.map((c, i) => (
                  <Link key={c.id} href={`/${slug}/e/${c.id}`} className="inline-flex items-center gap-1 hover:text-cobalt hover:underline">
                    {(i > 0 || card.title) && <span className="text-muted-foreground">·</span>}
                    {c.type === 'Customer' ? <Building2 className="size-3.5 text-muted-foreground" /> : <MapPin className="size-3.5 text-muted-foreground" />}
                    {c.name}
                  </Link>
                ))}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onAsk} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] hover:border-cobalt">
              <Sparkles className="size-3.5 text-cobalt" /> Ask about it
            </button>
            <Link href={`/${slug}/e/${card.id}`} className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] text-white">
              Open <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
        </div>

        {ch && (
          <div className="mt-5 rounded-xl bg-paper p-4">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-stale">
              <History className="size-3.5" /> {ch.timeline ? 'What changed' : 'Latest'}
              {ch.from && <span className="font-normal text-muted-foreground">· {humanDate(ch.from)}</span>}
            </div>
            <p className="mt-1.5 text-[15px] leading-snug text-ink">
              <span className="text-muted-foreground">{cap(ch.subject ? `${ch.subject} · ${ch.predicate}` : ch.predicate)}: </span>
              {ch.value}
            </p>
            {ch.summary && <p className="mt-1 text-[13px] text-ink/70">{ch.summary}</p>}
            {ch.timeline && ch.timeline.length > 1 && <Timeline steps={ch.timeline.map((s, i, a) => ({ ...s, current: i === a.length - 1 })) as Step[]} className="mt-2.5" />}
          </div>
        )}

        {card.facts.length > 0 && (
          <dl className="mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {card.facts.map((f) => (
              <div key={f.id} className="min-w-0">
                <dt className="text-[11.5px] text-muted-foreground">{cap(f.subject ? `${f.subject} · ${f.predicate}` : f.predicate)}</dt>
                <dd className="line-clamp-2 text-[13.5px] text-ink">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {evidence.length > 0 && (
        <div className="border-t border-border px-5 py-4 sm:px-6">
          <div className="eyebrow-muted mb-2">Best evidence</div>
          <ul className="space-y-1">
            {evidence.map(({ hit: h }) => (
              <li key={h.id}>
                <button type="button" onClick={() => onOpen(h)} className="group -mx-2 flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-paper">
                  <TypeTile h={h} small />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-navy group-hover:underline">{h.kind === 'email_body' ? tidy(String(h.citation.subject ?? h.title)) : fileName(h)}</span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">{h.kind === 'email_body' ? [sender(h), dateOf(h)].filter(Boolean).join(' · ') : dateOf(h)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- rows

function steps(h: Hit): Step[] | null {
  const line = h.content.split('\n').find((l) => l.startsWith('Timeline: '))
  if (!line) return null
  const s = line
    .slice(10)
    .split(' → ')
    .map((p) => {
      const m = p.match(/^(.*) \(([^()]*)\)$/)
      return m ? { value: tidy(m[1]), when: m[2], current: false } : { value: tidy(p), when: '', current: false }
    })
  if (s.length < 2) return null
  s[s.length - 1].current = true
  return s
}

/** "Blue Ridge Food Processing LLC (Customer) · payment terms: Net 60" → subject, label, value. */
function factParts(h: Hit) {
  const first = h.content.split('\n')[0]
  const m = first.match(/^(.*?) \([^()]+\) · ([^:]+): ([\s\S]*)$/)
  return m ? { subject: m[1], label: cap(m[2]), value: tidy(m[3]) } : { subject: '', label: '', value: tidy(first) }
}

// Each kind of result has its own look, so a glance tells them apart: facts read like data,
// documents like a file list (type tile), conversations like messages (who, when, what they said).

const TILE: Record<string, string> = {
  PDF: 'bg-red-50 text-red-700',
  Word: 'bg-blue-50 text-blue-700',
  Slides: 'bg-orange-50 text-orange-700',
  Excel: 'bg-emerald-50 text-emerald-700',
  CSV: 'bg-emerald-50 text-emerald-700',
  Data: 'bg-emerald-50 text-emerald-700',
  Photo: 'bg-amber-50 text-amber-700',
  Video: 'bg-violet-50 text-violet-700',
  Recording: 'bg-violet-50 text-violet-700',
  Email: 'bg-sky-50 text-sky-700',
}
function TypeTile({ h, small }: { h: Hit; small?: boolean }) {
  const b = badgeOf(h)
  const Icon = kindIcon[kindOf(h)] ?? kindIcon.document
  return (
    <span className={cn('grid shrink-0 place-items-center rounded-lg', small ? 'size-7' : 'size-10', TILE[b] ?? 'bg-secondary text-ink/70')} title={b}>
      <Icon className={small ? 'size-3.5' : 'size-[18px]'} />
    </span>
  )
}

/** A group of results: its own card, with a header and rows split by hairlines. */
export function Section({ label, count, onAll, children }: { label: string; count: number; onAll?: () => void; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-white">
      <header className="flex items-baseline justify-between border-b border-border bg-paper/60 px-4 py-2.5 sm:px-5">
        <h2 className="text-[13px] font-semibold text-ink">
          {label} <span className="ml-1 font-normal text-muted-foreground">{count}</span>
        </h2>
        {onAll && (
          <button type="button" onClick={onAll} className="text-[12.5px] text-cobalt hover:underline">
            Show all
          </button>
        )}
      </header>
      {children}
    </section>
  )
}

export function FactRow({ h, hideSubject }: { h: Hit; hideSubject?: string }) {
  const { subject, label, value } = factParts(h)
  const tl = steps(h)
  const status = h.citation.status === 'disputed' ? 'disputed' : h.is_current ? 'current' : 'outdated'
  const when = period(h.valid_from?.slice(0, 10), h.valid_to?.slice(0, 10))
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[12px] font-medium tracking-wide text-muted-foreground uppercase">{[subject && subject !== hideSubject ? subject : null, label].filter(Boolean).join(' · ')}</span>
        {status !== 'current' && <StatusPill status={status} />}
        {when && <span className="ml-auto text-[12px] text-muted-foreground">{cap(when)}</span>}
      </div>
      <p className="mt-1 text-[16px] leading-snug font-medium text-ink">{value}</p>
      {tl && <Timeline steps={tl} className="mt-2.5" />}
    </li>
  )
}

export function FileRow({ f, query, onOpen }: { f: FileHit; query?: string; onOpen: (h: Hit) => void }) {
  const h = f.hit
  const k = kindOf(h)
  const meta = [badgeOf(h), dateOf(h), where(h), f.more ? `+${f.more} more ${k === 'spreadsheet' ? 'places' : 'pages'}` : null].filter(Boolean).join(' · ')
  return (
    <li>
      <button type="button" onClick={() => onOpen(h)} className="group flex w-full gap-3.5 px-4 py-3.5 text-left hover:bg-paper/70 sm:px-5">
        <TypeTile h={h} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-navy group-hover:underline">{fileName(h)}</span>
          <span className="mt-0.5 block text-[12px] text-muted-foreground">{meta}</span>
          <span
            className={cn('mt-1.5 line-clamp-2 block', k === 'spreadsheet' ? 'rounded-md bg-paper px-2 py-1 font-mono text-[12px] leading-relaxed text-ink/75' : 'text-[13.5px] leading-relaxed text-ink/80')}
            dangerouslySetInnerHTML={{ __html: matchedSentence(h, query) }}
          />
        </span>
      </button>
    </li>
  )
}

const initials = (name: string) =>
  name
    .split(/[\s,]+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .map((w) => w[0].toUpperCase())
    .slice(0, 2)
    .join('') || '?'

export function ConversationRow({ f, query, onOpen }: { f: FileHit; query?: string; onOpen: (h: Hit) => void }) {
  const h = f.hit
  const k = kindOf(h)
  const isEmail = k === 'email'
  const speakers = (h.citation.speakers as string[] | undefined)?.filter((s) => !/^Speaker \d+$/.test(s)) ?? []
  const who = isEmail ? sender(h) : speakers.join(', ') || fileName(h).replace(/\.[a-z0-9]+$/i, '')
  const what = isEmail ? tidy(String(h.citation.subject ?? h.title)) : `${k === 'video' ? 'Video' : 'Recording'} · ${fileName(h)}${where(h) ? ` at ${where(h)}` : ''}`
  return (
    <li>
      <button type="button" onClick={() => onOpen(h)} className="group flex w-full gap-3.5 px-4 py-3.5 text-left hover:bg-paper/70 sm:px-5">
        {isEmail ? (
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-navy text-[12px] font-semibold text-white">{initials(who)}</span>
        ) : (
          <TypeTile h={h} />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[14.5px] font-semibold text-ink">{who}</span>
            <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">{dateOf(h)}</span>
          </span>
          <span className="block truncate text-[12.5px] text-muted-foreground group-hover:text-navy group-hover:underline">
            {what}
            {f.more ? ` · +${f.more} more` : ''}
          </span>
          <span className="mt-1.5 line-clamp-2 block border-l-2 border-cobalt/30 pl-2.5 text-[13.5px] leading-relaxed text-ink/85" dangerouslySetInnerHTML={{ __html: matchedSentence(h, query) }} />
        </span>
      </button>
    </li>
  )
}

/** Other records, compact; vocabulary entries collapse into one "also called" line. */
export function Records({ hits, slug }: { hits: Hit[]; slug: string }) {
  const terms = hits.filter((h) => h.kind === 'Term' && !/^[\d\s]+\(/.test(h.title))
  const things = hits.filter((h) => h.kind !== 'Term' && /^[A-Za-z0-9]/.test(h.title))
  const name = (h: Hit) => h.title.replace(/ \([^()]+\)$/, '')
  return (
    <div className="space-y-3">
      {things.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {things.map((h) => (
            <li key={h.id}>
              <Link href={`/${slug}/e/${h.id.slice(2)}`} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 text-[13px] hover:border-cobalt">
                {name(h)}
                <span className="text-[11.5px] text-muted-foreground">{h.kind === 'Asset' ? 'Equipment' : h.kind}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {terms.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
          Company vocabulary
          {terms.map((h) => (
            <Link key={h.id} href={`/${slug}/e/${h.id.slice(2)}`} className="rounded-md bg-secondary px-1.5 py-0.5 font-medium text-ink/80 hover:text-cobalt">
              {name(h)}
            </Link>
          ))}
        </p>
      )}
    </div>
  )
}
