// Timelines: what a fact was, when, and what replaced it.
//
// consolidateTimelines repairs the chain of each (subject, predicate) after canonicalization
// and reviews, so "as of" questions get exactly one answer per date:
//   - an older version with no end date ends where the next version starts
//   - an older accepted version that a later accepted version replaces becomes superseded
//   - an exact duplicate (same value, overlapping period) folds into the later one
// A fact's `metadata.topic` groups versions that live on different subjects (the discount
// approval limit was recorded on Dave, Sarah, the policy and the branch): timelines are
// built per subject+predicate AND per topic.

import type { Sql } from '../storage/raw'

interface Version {
  id: string
  subject_id: string
  subject: string
  predicate: string
  topic: string | null
  value: string
  valid_from: string | null
  valid_to: string | null
  status: string
  authority: string | null
}

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9$.%]+/g, ' ').trim()

export async function consolidateTimelines(sql: Sql, tenantId: string, opts: { dryRun?: boolean } = {}): Promise<{ closed: number; superseded: number; folded: number; changes: string[] }> {
  const rows = (
    await sql.query<Version>(
      `select f.id, f.subject_entity_id subject_id, s.canonical_name subject, f.predicate, f.metadata ->> 'topic' topic, f.value #>> '{}' value,
              f.valid_from::text, f.valid_to::text, f.status, f.authority
       from public.facts f join public.entities s on s.id = f.subject_entity_id
       where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status in ('accepted', 'superseded')`,
      [tenantId],
    )
  ).rows
  const groups = new Map<string, Version[]>()
  for (const r of rows) {
    const k = `${r.subject_id}|${r.predicate}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const changes: string[] = []
  const exec = (q: string, p: unknown[]) => (opts.dryRun ? Promise.resolve() : sql.query(q, p))
  let closed = 0
  let superseded = 0
  let folded = 0
  for (const vs of groups.values()) {
    if (vs.length < 2) continue
    // Dated versions in order; undated ones can't be placed in time and are left alone.
    const dated = vs.filter((v) => v.valid_from).sort((a, b) => a.valid_from!.localeCompare(b.valid_from!))
    const folding = new Set<string>()
    for (let i = 0; i < dated.length - 1; i++) {
      const cur = dated[i]
      if (folding.has(cur.id)) continue
      const next = dated.slice(i + 1).find((n) => n.valid_from! > cur.valid_from! && !folding.has(n.id))
      // Same value, or the same statement reworded on the same start date ("Weekly Monday review…").
      const overlap = (a: string, b: string) => jaccard(words(a), words(b))
      const same = dated
        .slice(i + 1)
        .find((n) => (norm(n.value) === norm(cur.value) && (!cur.valid_to || n.valid_from! <= cur.valid_to)) || (n.valid_from === cur.valid_from && overlap(n.value, cur.value) >= 0.6))
      const dup = same ? (cur.status === 'superseded' ? cur : same.status === 'superseded' ? same : null) : null
      if (dup && !folding.has(dup.id)) {
        // A duplicate version (the same "Former" status with two start dates, the same rule reworded).
        folding.add(dup.id)
        await exec(`update public.facts set status = 'rejected', note = coalesce(note || ' · ', '') || 'duplicate of another version (timeline consolidation)' where id = $1`, [dup.id])
        changes.push(`fold ${dup.subject} · ${dup.predicate}: duplicate "${dup.value.slice(0, 40)}" from ${dup.valid_from}`)
        folded++
        if (dup === cur) continue
      }
      if (!next) continue
      if (!cur.valid_to || cur.valid_to > next.valid_from!) {
        await exec(`update public.facts set valid_to = $2::date where id = $1`, [cur.id, next.valid_from])
        changes.push(`close ${cur.subject} · ${cur.predicate}: "${cur.value.slice(0, 40)}" ends ${next.valid_from} (next: "${next.value.slice(0, 40)}")`)
        closed++
      }
      if (cur.status === 'accepted' && norm(cur.value) !== norm(next.value)) {
        await exec(`update public.facts set status = 'superseded', note = coalesce(note || ' · ', '') || 'superseded by a later version (timeline consolidation)' where id = $1`, [cur.id])
        await exec(`update public.facts set supersedes_fact_id = coalesce(supersedes_fact_id, $2) where id = $1`, [next.id, cur.id])
        changes.push(`supersede ${cur.subject} · ${cur.predicate}: "${cur.value.slice(0, 40)}" → "${next.value.slice(0, 40)}" from ${next.valid_from}`)
        superseded++
      }
    }
  }
  return { closed, superseded, folded, changes }
}

export interface TimelineStep {
  fact_id: string
  subject: string
  predicate: string
  value: string
  valid_from: string | null
  valid_to: string | null
  status: string
  authority: string | null
}

/** Every timeline with at least two dated versions: per subject+predicate and per topic. */
export async function timelines(sql: Sql, tenantId: string): Promise<{ key: string; label: string; subject_ids: string[]; steps: TimelineStep[] }[]> {
  const rows = (
    await sql.query<Version>(
      `select f.id, f.subject_entity_id subject_id, s.canonical_name subject, f.predicate, f.metadata ->> 'topic' topic, f.value #>> '{}' value,
              f.valid_from::text, f.valid_to::text, f.status, f.authority
       from public.facts f join public.entities s on s.id = f.subject_entity_id
       where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status in ('accepted', 'superseded', 'disputed')`,
      [tenantId],
    )
  ).rows
  // A version replaced by a correction with the same start date was never true in time: it is a
  // fix, not history. (A "correction" that starts later is a real change and stays.)
  const corrected = new Set(
    (
      await sql.query<{ id: string }>(
        `select o.id from public.facts o join public.facts n on n.supersedes_fact_id = o.id
         where o.tenant_id = $1 and o.status = 'superseded' and n.valid_from is not distinct from o.valid_from`,
        [tenantId],
      )
    ).rows.map((r) => r.id),
  )
  const by = new Map<string, Version[]>()
  for (const r of rows.filter((x) => !corrected.has(x.id))) {
    const keys = [`sp:${r.subject_id}:${r.predicate}`, ...(r.topic ? [`topic:${r.topic}`] : [])]
    for (const k of keys) by.set(k, [...(by.get(k) ?? []), r])
  }
  const out: { key: string; label: string; subject_ids: string[]; steps: TimelineStep[] }[] = []
  for (const [key, vs] of by) {
    const dated = vs.filter((v) => v.valid_from || v.valid_to)
    if (dated.length < 2) continue
    // A topic timeline makes the per-subject ones of its members redundant only when identical; keep both (they answer different phrasings).
    // Unknown start but a known end = an earlier version; unknown both = can't place, goes last.
    const order = (v: Version) => v.valid_from ?? (v.valid_to ? `0000|${v.valid_to}` : '9999')
    const steps = [...vs].sort((a, b) => order(a).localeCompare(order(b)))
    const first = steps[0]
    out.push({
      key,
      label: key.startsWith('topic:') ? key.slice(6).replaceAll('_', ' ') : `${first.subject} · ${first.predicate.replaceAll('_', ' ')}`,
      subject_ids: [...new Set(steps.map((s) => s.subject_id))],
      steps: steps.map((s) => ({ fact_id: s.id, subject: s.subject, predicate: s.predicate, value: s.value, valid_from: s.valid_from, valid_to: s.valid_to, status: s.status, authority: s.authority })),
    })
  }
  return out
}

const month = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')

/** "Net 30 (Jul 2022 – Jun 2025) → Net 60 (since Jul 2025)" */
export function timelineText(steps: TimelineStep[]): string {
  return steps
    .map((s, i) => {
      const last = i === steps.length - 1
      const span = s.valid_from && s.valid_to ? `${month(s.valid_from)} – ${month(s.valid_to)}` : s.valid_from ? `${last && s.status !== 'superseded' ? 'since ' : 'from '}${month(s.valid_from)}` : s.valid_to ? `until ${month(s.valid_to)}` : 'undated'
      return `${s.value} (${span}${s.status === 'disputed' ? ', disputed' : ''})`
    })
    .join(' → ')
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((w) => b.has(w)).length
  return inter / Math.max(1, new Set([...a, ...b]).size)
}

/** Types whose facts describe one instance (a customer's terms), not a company-wide rule. */
const INSTANCE_TYPES = new Set(['Customer', 'Vendor', 'Site', 'Asset', 'Customer Contact', 'Vehicle', 'Fixed Asset', 'PM Agreement'])
const STOP = new Set(['the', 'a', 'of', 'to', 'for', 'and', 'on', 'in', 'is', 'by', 'at', 'up', 'or', 'per', 'with', 'from', 'over', 'under', 'above', 'all', 'any', 'each', 'goes', 'go', 'require', 'requires'])
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w)))

/**
 * Finds facts that describe the same thing on different subjects (the discount limit recorded on
 * Dave, on Sarah, on the policy and on the branch) and gives them a shared `metadata.topic`.
 * Then flags "possibly outdated" facts: still current, but another current fact in the same topic
 * started later and says something different. Flags only, a person (or an AI review) decides.
 * Uses the local embedding model; no API calls.
 */
export async function detectTopics(
  sql: Sql,
  tenantId: string,
  opts: { threshold?: number; dryRun?: boolean } = {},
): Promise<{ topics: { topic: string; kind: 'rule' | 'attribute'; facts: { subject: string; predicate: string; value: string; from: string | null; to: string | null }[] }[]; stale: string[] }> {
  const { embedPassages } = await import('../search/embed')
  const rows = (
    await sql.query<Version & { manual: boolean; subject_type: string }>(
      `select f.id, f.subject_entity_id subject_id, s.canonical_name subject, st.name subject_type, f.predicate, f.metadata ->> 'topic' topic, f.value #>> '{}' value,
              f.valid_from::text, f.valid_to::text, f.status, f.authority, coalesce((f.metadata ->> 'topic_manual')::boolean, f.metadata ? 'topic' and not f.metadata ? 'topic_auto') manual
       from public.facts f join public.entities s on s.id = f.subject_entity_id join public.entity_types st on st.id = s.entity_type_id
       where f.tenant_id = $1 and f.metadata ->> 'layer' = 'canonical' and f.status in ('accepted', 'superseded', 'disputed')`,
      [tenantId],
    )
  ).rows
  const texts = rows.map((r) => `${r.predicate.replaceAll('_', ' ')}: ${r.value}`)
  const vec = await embedPassages(texts)
  const valueVec = await embedPassages(rows.map((r) => r.value))
  const sim = (a: number[], b: number[]) => a.reduce((n, x, k) => n + x * b[k], 0)
  const threshold = opts.threshold ?? 0.86
  const parent = rows.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const wordSets = rows.map((r) => words(r.predicate.replaceAll('_', ' ')))
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].subject_id === rows[j].subject_id && rows[i].predicate === rows[j].predicate) continue // same chain already
      // Versions of one rule differ in value by definition, so the main signal is the predicate:
      // "discount approval authority" on Dave and on Sarah is the same kind of statement.
      const samePredicate = jaccard(wordSets[i], wordSets[j]) >= 0.6
      let linked = samePredicate
      if (!linked) {
        // Differently named predicates: the whole statement must read alike and share a content word.
        let dot = 0
        for (let k = 0; k < vec[i].length; k++) dot += vec[i][k] * vec[j][k]
        linked = dot >= threshold && [...wordSets[i]].some((w) => wordSets[j].has(w))
      }
      if (linked) parent[find(i)] = find(j)
    }
  const clusters = new Map<number, number[]>()
  rows.forEach((_, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]))
  const topics: { topic: string; kind: 'rule' | 'attribute'; facts: { subject: string; predicate: string; value: string; from: string | null; to: string | null }[] }[] = []
  const stale: string[] = []
  const today = new Date().toISOString().slice(0, 10)
  for (const idx of clusters.values()) {
    const members = idx.map((i) => rows[i])
    const subjects = new Set(members.map((m) => m.subject_id))
    const dated = members.filter((m) => m.valid_from || m.valid_to)
    if (subjects.size < 2 || dated.length < 2) continue
    // Name: the most common content word across the predicates, plus the runner-up.
    const count = new Map<string, number>()
    for (const m of members) for (const w of words(m.predicate.replaceAll('_', ' '))) count.set(w, (count.get(w) ?? 0) + 1)
    const name = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w]) => w).join('_')
    const existing = members.find((m) => m.manual && m.topic)?.topic
    const topic = existing ?? name
    // A shared rule (a policy, a rate, a branch practice) vs the same attribute of many instances
    // (each customer's own terms). Only shared rules can make each other outdated.
    const types = new Set(members.map((m) => m.subject_type))
    // People and branches are instances too (everyone has their own role); a rule needs a rule-like subject.
    const kind = [...types].some((t) => !INSTANCE_TYPES.has(t) && t !== 'Person' && t !== 'Branch') ? 'rule' : 'attribute'
    topics.push({ topic, kind, facts: members.map((m) => ({ subject: m.subject, predicate: m.predicate, value: m.value.slice(0, 80), from: m.valid_from, to: m.valid_to })) })
    if (!opts.dryRun)
      await sql.query(
        `update public.facts set metadata = metadata || jsonb_build_object('topic', $2::text, 'topic_auto', true, 'topic_kind', $3::text) where id = any($1::uuid[]) and not (metadata ? 'topic' and not metadata ? 'topic_auto')`,
        [members.map((m) => m.id), topic, kind],
      )
    // Possibly outdated: current, but a later-starting current fact in the topic says otherwise.
    if (kind !== 'rule') continue
    const current = idx.filter((i) => (rows[i].status === 'accepted' || rows[i].status === 'disputed') && (!rows[i].valid_to || rows[i].valid_to! > today))
    for (const i of current) {
      const m = rows[i]
      // Newer, and actually saying something different (not the same rule in other words).
      if (INSTANCE_TYPES.has(m.subject_type) || m.subject_type === 'Branch') continue
      const j = current.find(
        (o) =>
          o !== i &&
          !INSTANCE_TYPES.has(rows[o].subject_type) &&
          rows[o].subject_type !== 'Branch' &&
          // two different attributes of one subject (after-hours vs standard rate) are not versions of each other
          !(rows[o].subject_id === m.subject_id && rows[o].predicate !== m.predicate) &&
          jaccard(wordSets[i], wordSets[o]) >= 0.5 &&
          rows[o].valid_from &&
          (!m.valid_from || rows[o].valid_from! > m.valid_from) &&
          sim(valueVec[i], valueVec[o]) < 0.85,
      )
      const newer = j === undefined ? undefined : rows[j]
      if (!newer) continue
      stale.push(`${m.subject} · ${m.predicate} = "${m.value.slice(0, 50)}" (from ${m.valid_from ?? '?'}) vs newer ${newer.subject} · ${newer.predicate} = "${newer.value.slice(0, 50)}" (from ${newer.valid_from})`)
      if (!opts.dryRun)
        await sql.query(`update public.facts set metadata = metadata || jsonb_build_object('possibly_outdated_by', $2::text) where id = $1`, [m.id, newer.id])
    }
  }
  return { topics, stale }
}
