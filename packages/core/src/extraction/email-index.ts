// Email index: rebuilds conversations (threads) and the address book from
// extracted email documents. Runs after extraction (job index_email).
//
// Threads: Message-ID / In-Reply-To / References first; messages with no usable
// headers fall back to the same normalized subject with shared participants
// within 60 days. Addresses: internal vs external domain, old domains, role and
// shared mailboxes, people who went quiet (possibly former), and likely aliases
// across domains. Every flag is a candidate with its reason in `signals`.

import { type CompiledRules, DEFAULTS, rulesFor } from '../config/tenant-config'
import { randomUUID } from 'node:crypto'
import type { Sql } from '../storage/raw'

export interface Party {
  name: string
  address: string
}

export interface MessageRow {
  documentId: string
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  subject: string | null
  date: string | null
  from: Party[]
  to: Party[]
  cc: Party[]
  aclId: string | null
  hasAttachments: boolean
  forwarded: boolean
}

export interface Thread {
  key: string
  subject: string | null
  linkedBy: 'headers' | 'subject' | 'single'
  messages: { documentId: string; ordinal: number; depth: number; parentDocumentId: string | null; sentAt: string | null }[]
  firstAt: string | null
  lastAt: string | null
  participants: string[]
  hasAttachments: boolean
  hasForwarded: boolean
  missingMessages: number
  aclId: string | null
  mixedAcl: boolean
}

const SUBJECT_WINDOW_MS = 60 * 24 * 3600 * 1000
const GENERIC_SUBJECTS = new Set(['', 'hi', 'hello', 'question', 'questions', 'update', 'fyi', 'follow up', 'followup', 'quick question', 'thanks', 'thank you', '(no subject)', 'no subject'])

/** "RE: Fwd: [EXT] Kemper pricing " → "kemper pricing" */
export function normalizeSubject(subject: string | null): string {
  let s = (subject ?? '').toLowerCase().trim()
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(/^\s*(re|fw|fwd|aw|wg|sv|tr)\s*(\[\d+\])?\s*:\s*/i, '').replace(/^\s*\[[^\]]{1,20}\]\s*/, '')
  }
  return s.replace(/\s+/g, ' ').trim()
}

const time = (d: string | null) => (d ? new Date(d).getTime() : Number.NaN)
const people = (m: MessageRow) => [...m.from, ...m.to, ...m.cc].map((p) => p.address).filter(Boolean)

class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let r = x
    while (this.parent.get(r) !== r) r = this.parent.get(r)!
    this.parent.set(x, r)
    return r
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

/** Groups messages into conversations. Pure: no I/O. */
export function buildThreads(messages: MessageRow[]): Thread[] {
  const uf = new UnionFind()
  const byMessageId = new Map<string, MessageRow>()
  for (const m of messages) if (m.messageId) byMessageId.set(m.messageId, m)
  const linked = new Set<string>()

  // 1. Headers. Unknown ids (messages not in the corpus) still join everyone who references them.
  for (const m of messages) {
    uf.find(`doc:${m.documentId}`)
    const refs = [...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])]
    for (const r of refs) {
      const other = byMessageId.get(r)
      uf.union(`doc:${m.documentId}`, other ? `doc:${other.documentId}` : `mid:${r}`)
      linked.add(m.documentId)
      if (other) linked.add(other.documentId)
    }
  }

  // 2. Subject fallback for messages the headers did not connect to anything.
  const bySubject = new Map<string, MessageRow[]>()
  for (const m of messages) {
    const s = normalizeSubject(m.subject)
    if (s.length < 4 || GENERIC_SUBJECTS.has(s)) continue
    bySubject.set(s, [...(bySubject.get(s) ?? []), m])
  }
  const subjectLinked = new Set<string>()
  for (const group of bySubject.values()) {
    const sorted = [...group].sort((a, b) => (time(a.date) || 0) - (time(b.date) || 0))
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]
      const b = sorted[i]
      if (linked.has(a.documentId) && linked.has(b.documentId) && uf.find(`doc:${a.documentId}`) === uf.find(`doc:${b.documentId}`)) continue
      const close = !Number.isNaN(time(a.date)) && !Number.isNaN(time(b.date)) && Math.abs(time(b.date) - time(a.date)) <= SUBJECT_WINDOW_MS
      const shared = people(a).some((p) => people(b).includes(p))
      if (close && shared) {
        uf.union(`doc:${a.documentId}`, `doc:${b.documentId}`)
        subjectLinked.add(a.documentId)
        subjectLinked.add(b.documentId)
      }
    }
  }

  // 3. Assemble.
  const groups = new Map<string, MessageRow[]>()
  for (const m of messages) {
    const root = uf.find(`doc:${m.documentId}`)
    groups.set(root, [...(groups.get(root) ?? []), m])
  }
  const threads: Thread[] = []
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => (time(a.date) || Infinity) - (time(b.date) || Infinity))
    const ids = new Map(sorted.filter((m) => m.messageId).map((m) => [m.messageId!, m]))
    const depth = new Map<string, number>()
    const depthOf = (m: MessageRow, seen = new Set<string>()): number => {
      if (depth.has(m.documentId)) return depth.get(m.documentId)!
      const parent = m.inReplyTo ? ids.get(m.inReplyTo) : undefined
      const d = parent && !seen.has(parent.documentId) ? depthOf(parent, new Set([...seen, m.documentId])) + 1 : 0
      depth.set(m.documentId, d)
      return d
    }
    const referenced = new Set(sorted.flatMap((m) => [...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])]))
    const missing = [...referenced].filter((r) => !ids.has(r)).length
    const root = sorted[0]
    // Key: the conversation root's Message-ID (first reference) if known, else the subject.
    const rootRef = sorted.map((m) => m.references[0] ?? m.inReplyTo).find(Boolean) ?? root.messageId
    const linkedBy: Thread['linkedBy'] = sorted.length === 1 ? 'single' : sorted.some((m) => linked.has(m.documentId)) && !sorted.every((m) => subjectLinked.has(m.documentId)) ? 'headers' : 'subject'
    const key = linkedBy === 'subject' || !rootRef ? `subject:${normalizeSubject(root.subject)}:${root.documentId}` : rootRef
    const acls = new Set(sorted.map((m) => m.aclId ?? ''))
    const dates = sorted.map((m) => m.date).filter((d): d is string => !!d)
    threads.push({
      key,
      subject: root.subject,
      linkedBy,
      messages: sorted.map((m, i) => ({
        documentId: m.documentId,
        ordinal: i + 1,
        depth: depthOf(m),
        parentDocumentId: (m.inReplyTo && ids.get(m.inReplyTo)?.documentId) || null,
        sentAt: m.date,
      })),
      firstAt: dates[0] ?? null,
      lastAt: dates.at(-1) ?? null,
      participants: [...new Set(sorted.flatMap(people))].sort(),
      hasAttachments: sorted.some((m) => m.hasAttachments),
      hasForwarded: sorted.some((m) => m.forwarded),
      missingMessages: missing,
      aclId: acls.size === 1 ? sorted[0].aclId : null,
      mixedAcl: acls.size > 1,
    })
  }
  return threads.sort((a, b) => (time(b.lastAt) || 0) - (time(a.lastAt) || 0))
}

export interface AddressRow {
  address: string
  domain: string
  displayNames: string[]
  sent: number
  received: number
  firstSeen: string | null
  lastSeen: string | null
  internal: boolean
  domainStatus: 'current' | 'old' | null
  roleMailbox: boolean
  sharedMailbox: boolean
  possiblyFormer: boolean
  samePersonAs: string[]
  signals: Record<string, unknown>
}

// Role mailboxes, group names and "possibly former" thresholds come from the tenant's people rules.

/** Builds the address book and its candidate signals. Pure: no I/O. */
export function buildAddresses(messages: MessageRow[], clientName: string, rules: CompiledRules = DEFAULTS): AddressRow[] {
  const { roleMailbox: ROLE_LOCAL_PARTS, groupName: GROUP_NAME } = rules.rx
  const { former_min_sent: FORMER_MIN_SENT, former_quiet_days: FORMER_QUIET_DAYS, old_domain_days: OLD_DOMAIN_DAYS } = rules.people
  type Acc = { names: Map<string, number>; sent: number; received: number; first: number; last: number }
  const acc = new Map<string, Acc>()
  const touch = (p: Party, kind: 'sent' | 'received', t: number) => {
    if (!p.address || !p.address.includes('@')) return
    const a = acc.get(p.address) ?? { names: new Map(), sent: 0, received: 0, first: Infinity, last: -Infinity }
    if (p.name) a.names.set(p.name, (a.names.get(p.name) ?? 0) + 1)
    a[kind]++
    if (!Number.isNaN(t)) {
      a.first = Math.min(a.first, t)
      a.last = Math.max(a.last, t)
    }
    acc.set(p.address, a)
  }
  for (const m of messages) {
    const t = time(m.date)
    for (const p of m.from) touch(p, 'sent', t)
    for (const p of [...m.to, ...m.cc]) touch(p, 'received', t)
  }

  // Internal domains: named after the client, or the domain that sends in most messages.
  const domainOf = (a: string) => a.split('@')[1] ?? ''
  const domains = new Map<string, { messages: number; senders: number; first: number; last: number }>()
  for (const m of messages) {
    const t = time(m.date)
    for (const d of new Set(people(m).map(domainOf))) {
      const x = domains.get(d) ?? { messages: 0, senders: 0, first: Infinity, last: -Infinity }
      x.messages++
      if (m.from.some((p) => domainOf(p.address) === d)) x.senders++
      if (!Number.isNaN(t)) {
        x.first = Math.min(x.first, t)
        x.last = Math.max(x.last, t)
      }
      domains.set(d, x)
    }
  }
  const tokens = clientName.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4)
  const total = messages.length || 1
  const internalReason = new Map<string, string>()
  for (const [d, x] of domains) {
    const base = d.split('.').slice(0, -1).join('.')
    if (tokens.some((t) => base.includes(t))) internalReason.set(d, `domain contains "${tokens.find((t) => base.includes(t))}"`)
    else if (x.senders / total >= 0.3) internalReason.set(d, `sends in ${Math.round((x.senders / total) * 100)}% of messages`)
  }
  const internalLast = Math.max(-Infinity, ...[...internalReason.keys()].map((d) => domains.get(d)!.last))
  const corpusEnd = Math.max(-Infinity, ...messages.map((m) => time(m.date)).filter((t) => !Number.isNaN(t)))
  const day = 24 * 3600 * 1000

  const rows: AddressRow[] = []
  for (const [address, a] of acc) {
    const domain = domainOf(address)
    const local = address.split('@')[0]
    const names = [...a.names.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n)
    const internal = internalReason.has(domain)
    const signals: Record<string, unknown> = {}
    if (internal) signals.internal = internalReason.get(domain)
    let domainStatus: AddressRow['domainStatus'] = null
    if (internal) {
      const d = domains.get(domain)!
      domainStatus = internalReason.size > 1 && d.last < internalLast - OLD_DOMAIN_DAYS * day ? 'old' : 'current'
      if (domainStatus === 'old') signals.old_domain = `last used ${new Date(d.last).toISOString().slice(0, 10)}; another client domain is used until ${new Date(internalLast).toISOString().slice(0, 10)}`
    }
    const groupList = names.some((n) => GROUP_NAME.test(n)) || (internal && a.sent === 0 && a.received >= 2 && !/[._-]/.test(local) && local.length > 2 && !names.some((n) => n.trim().includes(' ') && !GROUP_NAME.test(n)))
    const roleMailbox = ROLE_LOCAL_PARTS.test(local) || groupList
    if (ROLE_LOCAL_PARTS.test(local)) signals.role_mailbox = `address "${local}@" is a function, not a person`
    else if (groupList) signals.role_mailbox = `group address (${names[0] ?? local}): only receives or is named like a team, list or branch`
    // A function inbox, or several different people sending as one address = shared inbox.
    const distinctNames = new Set(names.map((n) => n.toLowerCase().replace(/\s+via\s+.*$/, '').trim())).size
    const sharedMailbox = internal && ((ROLE_LOCAL_PARTS.test(local) && !groupList) || (a.sent >= 3 && distinctNames >= 3))
    if (sharedMailbox && !ROLE_LOCAL_PARTS.test(local)) signals.shared_mailbox = `sent under ${distinctNames} different names: ${names.slice(0, 5).join(', ')}`
    if (groupList && internal) signals.group_list = true
    const quietDays = Number.isFinite(a.last) && Number.isFinite(corpusEnd) ? Math.round((corpusEnd - a.last) / day) : null
    // Decided per person below (aliases on other domains count as the same person).
    const possiblyFormer = false
    if (quietDays !== null) signals.quiet_days = quietDays
    rows.push({
      address,
      domain,
      displayNames: names,
      sent: a.sent,
      received: a.received,
      firstSeen: Number.isFinite(a.first) ? new Date(a.first).toISOString() : null,
      lastSeen: Number.isFinite(a.last) ? new Date(a.last).toISOString() : null,
      internal,
      domainStatus,
      roleMailbox,
      sharedMailbox,
      possiblyFormer,
      samePersonAs: [],
      signals,
    })
  }

  // Likely aliases: the same person on another domain (same local part, or same display name).
  const norm = (n: string) => n.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim()
  for (const r of rows) {
    if (r.roleMailbox) continue
    const local = r.address.split('@')[0]
    const myNames = new Set(r.displayNames.map(norm).filter((n) => n.includes(' ')))
    const aliases = rows.filter(
      (o) => o !== r && !o.roleMailbox && o.domain !== r.domain && (o.address.split('@')[0] === local || o.displayNames.some((n) => myNames.has(norm(n)))),
    )
    if (aliases.length) {
      r.samePersonAs = aliases.map((o) => o.address).sort()
      r.signals.same_person_as = 'same mailbox name or display name on another domain'
    }
  }

  // Possibly former: an internal person (with their aliases) who used to email and then went quiet.
  const byAddress = new Map(rows.map((r) => [r.address, r]))
  for (const r of rows) {
    if (!r.internal || r.roleMailbox) continue
    const person = [r, ...r.samePersonAs.map((a) => byAddress.get(a)!).filter(Boolean)]
    const sent = person.reduce((n, x) => n + x.sent, 0)
    const last = Math.max(...person.map((x) => (x.lastSeen ? new Date(x.lastSeen).getTime() : -Infinity)))
    const quiet = Number.isFinite(last) && Number.isFinite(corpusEnd) ? Math.round((corpusEnd - last) / day) : null
    if (sent >= FORMER_MIN_SENT && quiet !== null && quiet >= FORMER_QUIET_DAYS) {
      r.possiblyFormer = true
      r.signals.possibly_former = `sent ${sent} emails, then nothing for the last ${quiet} days of the corpus`
    }
  }
  return rows.sort((a, b) => b.sent + b.received - (a.sent + a.received))
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Loads every extracted email for a client from its current document version. */
async function loadMessages(sql: Sql, tenantId: string): Promise<MessageRow[]> {
  const { rows } = await sql.query<{ document_id: string; acl_id: string | null; m: Record<string, unknown> }>(
    `select d.id document_id, dv.acl_id, dv.metadata m
     from public.documents d join public.document_versions dv on dv.id = d.current_version_id
     where d.tenant_id = $1 and d.kind = 'email' and dv.extraction_status = 'succeeded'`,
    [tenantId],
  )
  // Duplicate copies of one message (same Message-ID) count once; the first copy stands in.
  const seen = new Set<string>()
  const out: MessageRow[] = []
  for (const r of rows) {
    const mid = (r.m.message_id as string | null) ?? null
    if (mid && seen.has(mid)) continue
    if (mid) seen.add(mid)
    out.push({
      documentId: r.document_id,
      messageId: mid,
      inReplyTo: (r.m.in_reply_to as string | null) ?? null,
      references: (r.m.references as string[] | undefined) ?? [],
      subject: (r.m.subject as string | null) ?? null,
      date: (r.m.date as string | null) ?? null,
      from: (r.m.from as Party[] | undefined) ?? [],
      to: (r.m.to as Party[] | undefined) ?? [],
      cc: (r.m.cc as Party[] | undefined) ?? [],
      aclId: r.acl_id,
      hasAttachments: ((r.m.attachments as unknown[] | undefined) ?? []).length > 0,
      forwarded: !!r.m.forwarded,
    })
  }
  return out
}

const DEPARTURE_WORDS = 'left OR leaving OR retired OR retiring OR retirement OR resigned OR resignation OR resigning OR quit OR departure OR departing OR "last day" OR "no longer"'
const DEPARTURE_NEAR = /\b(left|leaving|retired|retiring|retirement|resign(ed|ation|ing)?|quit|depart(ure|ing)|last day|no longer (with|here|at))\b/i
const NEAR_WORDS = 12

/** Drops an email's header block (From/To/Cc lines list everyone) so only the body is searched. */
export function bodyOf(content: string): string {
  return /^From: /.test(content) ? content.slice(content.indexOf('\n\n') + 2) : content
}

/**
 * True when a departure word appears within NEAR_WORDS words of the full name.
 * A name used as a speaker label ("Jim Polk: ...") is not a mention of that person.
 */
export function departureNearName(content: string, name: string): boolean {
  const words = bodyOf(content).split(/\s+/)
  const parts = name.toLowerCase().split(/\s+/)
  for (let i = 0; i <= words.length - parts.length; i++) {
    const hit = parts.every((p, k) => words[i + k].toLowerCase().replace(/[^a-z'.-]/g, '').replace(/'s$/, '') === p)
    if (!hit || words[i + parts.length - 1].endsWith(':')) continue
    const window = words.slice(Math.max(0, i - NEAR_WORDS), i + parts.length + NEAR_WORDS).join(' ')
    if (DEPARTURE_NEAR.test(window)) return true
  }
  return false
}

/**
 * Looks for each internal person's full name close to departure words in emails,
 * interviews and documents. Hits become evidence for (or the reason behind) the
 * "possibly former" lead; they are never treated as proof.
 */
async function addDepartureMentions(sql: Sql, tenantId: string, addresses: AddressRow[]): Promise<void> {
  for (const a of addresses) {
    if (!a.internal || a.roleMailbox) continue
    const name = a.displayNames.find((n) => /^[A-Za-z'.-]+(\s+[A-Za-z'.-]+)+$/.test(n.trim()))?.trim()
    if (!name) continue
    const { rows } = await sql.query<{ id: string; content: string; path: string; page_number: number | null; start_ms: number | null; observed_at: string | null }>(
      `select e.id, e.content, so.original_path path, e.page_number, e.start_ms, e.observed_at
       from (select phraseto_tsquery('english', $2) && websearch_to_tsquery('english', $3) as q) x, public.evidence e
       join public.document_versions dv on dv.id = e.document_version_id
       join public.documents d on d.id = dv.document_id and d.current_version_id = dv.id
       join public.source_objects so on so.id = dv.source_object_id
       -- Prose only: in a 40-row table block a name and a word like "left" co-occur by chance.
       where e.tenant_id = $1 and e.search_tsv @@ x.q and e.kind in ('email_body', 'transcript_segment', 'text', 'ocr', 'video_segment')
       order by ts_rank_cd(e.search_tsv, x.q) desc limit 25`,
      [tenantId, name, DEPARTURE_WORDS],
    )
    const near = rows.filter((r) => departureNearName(r.content, name)).slice(0, 3)
    if (!near.length) continue
    a.signals.departure_mentions = near.map((r) => {
      const words = bodyOf(r.content).split(/\s+/)
      const at = words.findIndex((w, i) => `${w} ${words[i + 1] ?? ''}`.toLowerCase().replace(/[^a-z' ]/g, '').startsWith(name.toLowerCase()))
      return {
        evidence_id: r.id,
        where: [r.path, r.page_number != null ? `p. ${r.page_number}` : null, r.start_ms != null ? `${Math.floor(r.start_ms / 60000)}:${String(Math.floor(r.start_ms / 1000) % 60).padStart(2, '0')}` : null, r.observed_at ? new Date(r.observed_at).toISOString().slice(0, 10) : null]
          .filter(Boolean)
          .join(', '),
        snippet: words.slice(Math.max(0, at - NEAR_WORDS), at + NEAR_WORDS + 2).join(' '),
      }
    })
    if (!a.possiblyFormer) {
      a.possiblyFormer = true
      a.signals.possibly_former = `named near departure words in ${near.length} passage(s); verify`
    }
  }
}

/** Rebuilds threads and addresses for a client. Rows from earlier builds that no longer apply are removed. */
export async function rebuildEmailIndex(sql: Sql, tenantId: string): Promise<{ messages: number; threads: number; multiMessageThreads: number; addresses: number; internal: number; flagged: Record<string, number> }> {
  const tenant = (await sql.query<{ name: string }>(`select name from public.tenants where id = $1`, [tenantId])).rows[0]
  const messages = await loadMessages(sql, tenantId)
  const threads = buildThreads(messages)
  const addresses = buildAddresses(messages, tenant?.name ?? '', await rulesFor(sql, tenantId))
  await addDepartureMentions(sql, tenantId, addresses)
  const buildId = randomUUID()

  for (const t of threads) {
    const threadId = (
      await sql.query<{ id: string }>(
        `insert into public.email_threads (tenant_id, thread_key, subject, first_at, last_at, message_count, participants, has_attachments, has_forwarded, linked_by, missing_messages, acl_id, mixed_acl, build_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         on conflict (tenant_id, thread_key) do update set subject = excluded.subject, first_at = excluded.first_at, last_at = excluded.last_at,
           message_count = excluded.message_count, participants = excluded.participants, has_attachments = excluded.has_attachments,
           has_forwarded = excluded.has_forwarded, linked_by = excluded.linked_by, missing_messages = excluded.missing_messages,
           acl_id = excluded.acl_id, mixed_acl = excluded.mixed_acl, build_id = excluded.build_id
         returning id`,
        [tenantId, t.key, t.subject, t.firstAt, t.lastAt, t.messages.length, t.participants, t.hasAttachments, t.hasForwarded, t.linkedBy, t.missingMessages, t.aclId, t.mixedAcl, buildId],
      )
    ).rows[0].id
    await sql.query(`delete from public.email_thread_messages where thread_id = $1`, [threadId])
    await sql.query(
      `insert into public.email_thread_messages (tenant_id, thread_id, document_id, ordinal, depth, parent_document_id, sent_at)
       select $1, $2, x.document_id, x.ordinal, x.depth, x.parent_document_id, x.sent_at
       from jsonb_to_recordset($3::jsonb) as x(document_id uuid, ordinal int, depth int, parent_document_id uuid, sent_at timestamptz)`,
      [tenantId, threadId, JSON.stringify(t.messages.map((m) => ({ document_id: m.documentId, ordinal: m.ordinal, depth: m.depth, parent_document_id: m.parentDocumentId, sent_at: m.sentAt })))],
    )
  }
  await sql.query(`delete from public.email_threads where tenant_id = $1 and build_id <> $2`, [tenantId, buildId])

  for (let i = 0; i < addresses.length; i += 200) {
    const batch = addresses.slice(i, i + 200)
    await sql.query(
      `insert into public.email_addresses (tenant_id, address, domain, display_names, sent_count, received_count, first_seen_at, last_seen_at, internal, domain_status, role_mailbox, shared_mailbox, possibly_former, same_person_as, signals, build_id)
       select $1, x.address, x.domain, x.display_names, x.sent, x.received, x.first_seen, x.last_seen, x.internal, x.domain_status, x.role_mailbox, x.shared_mailbox, x.possibly_former, x.same_person_as, x.signals, $3
       from jsonb_to_recordset($2::jsonb) as x(address text, domain text, display_names text[], sent int, received int, first_seen timestamptz, last_seen timestamptz,
            internal boolean, domain_status text, role_mailbox boolean, shared_mailbox boolean, possibly_former boolean, same_person_as text[], signals jsonb)
       on conflict (tenant_id, address) do update set domain = excluded.domain, display_names = excluded.display_names, sent_count = excluded.sent_count,
         received_count = excluded.received_count, first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at, internal = excluded.internal,
         domain_status = excluded.domain_status, role_mailbox = excluded.role_mailbox, shared_mailbox = excluded.shared_mailbox,
         possibly_former = excluded.possibly_former, same_person_as = excluded.same_person_as, signals = excluded.signals, build_id = excluded.build_id`,
      [
        tenantId,
        JSON.stringify(
          batch.map((a) => ({
            address: a.address,
            domain: a.domain,
            display_names: a.displayNames,
            sent: a.sent,
            received: a.received,
            first_seen: a.firstSeen,
            last_seen: a.lastSeen,
            internal: a.internal,
            domain_status: a.domainStatus,
            role_mailbox: a.roleMailbox,
            shared_mailbox: a.sharedMailbox,
            possibly_former: a.possiblyFormer,
            same_person_as: a.samePersonAs,
            signals: a.signals,
          })),
        ),
        buildId,
      ],
    )
  }
  await sql.query(`delete from public.email_addresses where tenant_id = $1 and build_id <> $2`, [tenantId, buildId])

  return {
    messages: messages.length,
    threads: threads.length,
    multiMessageThreads: threads.filter((t) => t.messages.length > 1).length,
    addresses: addresses.length,
    internal: addresses.filter((a) => a.internal).length,
    flagged: {
      old_domain: addresses.filter((a) => a.domainStatus === 'old').length,
      shared_mailbox: addresses.filter((a) => a.sharedMailbox).length,
      possibly_former: addresses.filter((a) => a.possiblyFormer).length,
      with_aliases: addresses.filter((a) => a.samePersonAs.length > 0).length,
    },
  }
}
