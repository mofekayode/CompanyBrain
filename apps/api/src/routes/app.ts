import { briefAnswer } from '@companybrain/core/answer/brief'
import { writeAnswer } from '@companybrain/core/answer/write'
import { answer, buildContext } from '@companybrain/core/answer/answer'
import { entityCard, entityPage, home, passageDetail } from '@companybrain/core/app/client'
import { answersAllowed, apiAllowed } from '@companybrain/core/claude'
import { rerankScores } from '@companybrain/core/search/embed'
import { principalsOf, search, type SearchResult } from '@companybrain/core/search/search'
import { pool } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { streamSSE } from 'hono/streaming'
import { directory, suggest } from '@companybrain/core/app/suggest'
import { serveRaw } from '../media'
import { transcriptFor } from '@companybrain/core/workbench/transcript'
import type { Env } from '../tenant'

/**
 * The client app's API. Every call carries `as` (the signed-in person's principal) and
 * answers only from what that person can open. Until Clerk, the app picks the person.
 */
export const app = new Hono<Env>()

// The client app rewrites questions into the documents' words before searching (search/rewrite.ts).
const ctx = (c: { get: (k: 'tenant') => { id: string } }, as?: string | null) => ({ sql: pool(), tenantId: c.get('tenant').id, as: as || null, rewrite: true })

/** People who can sign in (mock until Clerk), with whether they manage access. */
app.get('/app/people', async (c) =>
  c.json(
    (
      await pool().query<{ id: string; name: string; title: string | null; admin: boolean }>(
        `select p.id, p.display_name name, p.metadata ->> 'title' title,
                coalesce(p.metadata ->> 'title', '') ~* '(president|ceo|owner|general manager|controller)' admin
         from public.principals p where p.tenant_id = $1 and p.kind = 'user' and coalesce(p.metadata ->> 'status', 'active') = 'active' order by p.display_name`,
        [c.get('tenant').id],
      )
    ).rows,
  ),
)

/** Home per person: served from memory, refreshed in the background once it's a few minutes old. */
const homeCache = new Map<string, { at: number; data: Promise<unknown> }>()
app.get('/app/home', async (c) => {
  const key = `${c.get('tenant').id}:${c.req.query('as') ?? ''}`
  const hit = homeCache.get(key)
  const fresh = () => {
    const data = home(ctx(c, c.req.query('as')))
    homeCache.set(key, { at: Date.now(), data })
    data.catch(() => homeCache.delete(key))
    return data
  }
  if (!hit) return c.json(await fresh())
  if (Date.now() - hit.at > 3 * 60_000) {
    hit.at = Date.now() // one refresh at a time
    fresh().catch(() => {})
  }
  return c.json(await hit.data)
})

/** Ask: the brief, cited answer; plus a written answer when the Claude API is on. */
app.post('/app/ask', async (c) => {
  const { q, as } = (await c.req.json()) as { q?: string; as?: string | null }
  if (!q?.trim()) return c.json({ error: 'q required' }, 400)
  const brief = await briefAnswer(ctx(c, as), q.trim())
  const written = apiAllowed() ? await answer(pool(), c.get('tenant').id, q.trim(), { as: as || null }).then((r) => (r.answer ? { text: r.answer.answer.replace(/\s*\[\d+(?:,\s*\d+)*\]/g, '') } : null)).catch(() => null) : null
  return c.json({ ...brief, written })
})

/**
 * Ask, streamed. Each real step as it happens; the instant answer (best fact, history, access);
 * then, when the API is on, the written answer word by word ("delta"), citing its own
 * numbered sources ("sources"), and "done" with the full text, model, tokens and time.
 */
app.post('/app/ask/stream', async (c) => {
  const { q, as } = (await c.req.json()) as { q?: string; as?: string | null }
  if (!q?.trim()) return c.json({ error: 'q required' }, 400)
  const KIND: Record<string, string> = { email_body: 'email', transcript_segment: 'interview', video_segment: 'video', image: 'photo', table: 'spreadsheet', text: 'document', ocr: 'document' }
  return streamSSE(c, async (stream) => {
    const ac = new AbortController()
    stream.onAbort(() => ac.abort())
    const send = (event: string, data: unknown) => (ac.signal.aborted ? Promise.resolve() : stream.writeSSE({ event, data: JSON.stringify(data) }))
    try {
      // The writer's context is built from the same search, while the brief is still checking files and access.
      let packed: ReturnType<typeof buildContext> | undefined
      const raw = await briefAnswer(ctx(c, as), q.trim(), {
        onStep: (s) => void send('step', s),
        onPartial: (p) => void send('partial', p),
        onSearch: (r) => {
          if (answersAllowed()) (packed = buildContext(pool(), c.get('tenant').id, q.trim(), { as: as || null, prefetched: r })).catch(() => {})
        },
      })
      // Restricted areas are counted, never named: their names can be confidential too.
      const brief = { ...raw, restricted: raw.restricted ? { ...raw.restricted, scopes: [] } : null }
      await send('brief', brief)
      // The best sources are ones this person can't open and what they can open is weak: say so,
      // and don't ask a model to write around it (it might imply the information doesn't exist).
      // Same when nothing relevant is on record at all: the honest answer is fixed, no model needed.
      const locked = !brief.headline && brief.evidence === 'weak'
      if (!answersAllowed() || locked || ac.signal.aborted) return void (await send('done', { ...brief, written: null }))

      await send('step', { id: 'write', label: 'Writing the answer from these sources', status: 'active' })
      const pack = await (packed ?? buildContext(pool(), c.get('tenant').id, q.trim(), { as: as || null, rewrite: true }))
      await send('sources', pack.sources.map((s) => ({
        n: s.n,
        id: s.id,
        title: s.type === 'passage' ? (s.path?.split('/').pop() ?? s.title) : s.title,
        where: s.where,
        kind: s.type === 'fact' ? 'fact' : s.type === 'entity' ? 'system' : (KIND[s.kind] ?? 'document'),
        status: s.label === 'Supports' ? 'supporting' : s.label.toLowerCase(),
        file_id: s.file_id,
        start_ms: s.start_ms,
        quote: null,
      })))
      const w = await writeAnswer(pack, (t) => void send('delta', t), { signal: ac.signal, restricted: !!brief.restricted })
      await send('step', { id: 'write', label: 'Writing the answer from these sources', status: 'done', detail: w ? `${(w.ms / 1000).toFixed(1)} s` : undefined })
      // Which model wrote it stays server-side (logs, evals): people see the answer, not the machinery.
      await send('done', { ...brief, written: w ? { text: w.text, ms: w.ms } : null })
    } catch (e) {
      if (!ac.signal.aborted) await send('error', { message: (e as Error).message })
    }
  })
})

/** Everything this person can look up by name, for instant in-browser typeahead (cached briefly per person). */
const dirCache = new Map<string, { at: number; data: unknown }>()
app.get('/app/directory', compress(), async (c) => {
  const key = `${c.get('tenant').id}:${c.req.query('as') ?? ''}`
  const hit = dirCache.get(key)
  if (hit && Date.now() - hit.at < 5 * 60_000) return c.json(hit.data)
  const data = await directory(ctx(c, c.req.query('as')))
  dirCache.set(key, { at: Date.now(), data })
  return c.json(data)
})

/** Typeahead: entities by name/nickname, files by name, email by subject, grouped, access-aware, fast. */
app.get('/app/suggest', async (c) => c.json(await suggest(ctx(c, c.req.query('as')), c.req.query('q') ?? '', { skipEntities: c.req.query('only') === 'files' })))

app.get('/app/search', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'q required' }, 400)
  // Fast hybrid ranking for the list (~0.6 s); the cross-encoder only checks the top few to tell
  // whether anything matches at all (vector search always returns neighbours, even for gibberish):
  // real queries score ≥ ~1 at the top, nonsense ≤ ~-5.
  const r = await search(pool(), c.get('tenant').id, q, { as: c.req.query('as') || null, limit: 40, asOf: c.req.query('as_of') || undefined, rewrite: true })
  const scores = r.hits.length ? await rerankScores(q, r.hits.slice(0, 3).map((h) => `${h.title}\n${h.content}`)) : []
  const weak = !scores.length || Math.max(...scores) < -3
  return c.json({ ...r, weak, hits: weak ? [] : r.hits })
})

/** A cited passage or fact, exactly (access-checked): for the source viewer. */
app.get('/app/passages/:id', async (c) => {
  const d = await passageDetail(ctx(c, c.req.query('as')), decodeURIComponent(c.req.param('id')))
  return d ? c.json(d) : c.json({ error: 'not found' }, 404)
})

app.get('/app/entities/:id/card', async (c) => {
  const card = await entityCard(ctx(c, c.req.query('as')), c.req.param('id'))
  return card ? c.json(card) : c.json({ error: 'not found' }, 404)
})

app.get('/app/entities/:ref', async (c) => {
  const p = await entityPage(ctx(c, c.req.query('as')), decodeURIComponent(c.req.param('ref')))
  return p ? c.json(p) : c.json({ error: 'not found' }, 404)
})

/** Can this person open the file? (Its access list includes them or one of their groups; null = FDE.) */
async function canOpen(tenantId: string, aclId: string | null, as: string | null) {
  if (!as) return true
  const principals = await principalsOf(pool(), tenantId, as)
  return (await pool().query(`select 1 from public.acl_entries where acl_id = $1 and principal_id = any($2::uuid[]) limit 1`, [aclId, principals])).rows.length > 0
}

/** Timed transcript of an audio or video file the person can open. */
app.get('/app/files/:id/transcript', async (c) => {
  const tenantId = c.get('tenant').id
  const acl = (await pool().query<{ acl_id: string | null }>(`select coalesce(fa.acl_id, so.acl_id) acl_id from public.source_objects so left join public.file_access fa on fa.source_object_id = so.id where so.tenant_id = $1 and so.id = $2`, [tenantId, c.req.param('id')])).rows[0]
  if (!acl) return c.json([], 404)
  if (!(await canOpen(tenantId, acl.acl_id, c.req.query('as') || null))) return c.json([], 403)
  return c.json(await transcriptFor(pool(), tenantId, c.req.param('id')))
})

/** A source file, only if this person can open it (its access list includes them or one of their groups). */
app.get('/app/files/:id/raw', async (c) => {
  const tenantId = c.get('tenant').id
  const as = c.req.query('as') || null
  const file = (
    await pool().query<{ s3_key: string; mime_type: string | null; original_filename: string; acl_id: string | null }>(
      `select so.s3_key, so.mime_type, so.original_filename, coalesce(fa.acl_id, so.acl_id) acl_id
       from public.source_objects so left join public.file_access fa on fa.source_object_id = so.id
       where so.tenant_id = $1 and so.id = $2 and so.deleted_at is null`,
      [tenantId, c.req.param('id')],
    )
  ).rows[0]
  if (!file) return c.text('unknown file', 404)
  if (!(await canOpen(tenantId, file.acl_id, as))) return c.text('You do not have access to this file. Request access from the catalog.', 403)
  return serveRaw(c.req.raw, file)
})
