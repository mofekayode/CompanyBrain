import { catalogFor, type Db, decideRequest, ensureMockUser, type MockRole, requestAccess, setScopeStatus, asUser } from '@companybrain/core/access/enforce'
import { accessOverview, auditLog, companyMap, listRequests, moveFiles, scopeFiles, updateScope } from '@companybrain/core/access/overview'
import { startAccessRun } from '@companybrain/core/jobs/access'
import { searchEvidence } from '@companybrain/core/workbench/evidence-search'
import { pool } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/**
 * People & access. The FDE endpoints run with full access; the /view-as endpoints
 * act as one person (mock login) so the database's row-level security decides
 * what they see, exactly as it will for real users.
 */
export const access = new Hono<Env>()
const db = () => pool() as unknown as Db

access.get('/access', async (c) => c.json(await accessOverview(pool(), c.get('tenant').id)))
access.get('/access/people', async (c) => c.json(await companyMap(pool(), c.get('tenant').id)))
access.get('/access/scopes/:id/files', async (c) => c.json(await scopeFiles(pool(), c.get('tenant').id, c.req.param('id'))))
access.get('/access/requests', async (c) => c.json(await listRequests(pool(), c.get('tenant').id)))
access.get('/access/audit', async (c) => c.json(await auditLog(pool(), c.get('tenant').id)))

/** Build the company map and propose scopes (background run; watch it in Activity). Body: { mapOnly?, remap? } */
access.post('/access/run', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { mapOnly?: boolean; remap?: boolean }
  return c.json(await startAccessRun(pool(), c.get('tenant').id, body))
})

/** Edit a scope. { status: 'released' | 'held', asPrincipalId? } releases/holds (as that admin if given); other fields edit settings. */
access.patch('/access/scopes/:id', async (c) => {
  const tenantId = c.get('tenant').id
  const body = (await c.req.json()) as { status?: 'released' | 'held'; asPrincipalId?: string; name?: string; sensitivity?: 'internal' | 'confidential' | 'restricted'; hidden?: boolean; audience?: string[] }
  if (body.status) {
    const adminUser = body.asPrincipalId ? await ensureMockUser(pool(), tenantId, body.asPrincipalId, 'admin') : undefined
    await setScopeStatus(db(), tenantId, c.req.param('id'), body.status, adminUser)
  }
  if (body.name || body.sensitivity || body.hidden !== undefined || body.audience) await updateScope(pool(), tenantId, c.req.param('id'), body)
  return c.json({ ok: true })
})

/** Move files (and everything inside them) to another scope. */
access.post('/access/files/move', async (c) => {
  const { fileIds, scopeId, note } = (await c.req.json()) as { fileIds: string[]; scopeId: string; note?: string }
  if (!fileIds?.length || !scopeId) return c.json({ error: 'fileIds and scopeId required' }, 400)
  return c.json(await moveFiles(pool(), c.get('tenant').id, fileIds, scopeId, note ?? ''))
})

const role = (r: string | undefined): MockRole => (r === 'admin' ? 'admin' : 'member')

/** What one person sees: their catalog (open / locked; hidden scopes omitted), grouped by scope. */
access.get('/access/view-as/:principalId', async (c) => {
  const tenantId = c.get('tenant').id
  const userId = await ensureMockUser(pool(), tenantId, c.req.param('principalId'), role(c.req.query('role')))
  const files = await catalogFor(db(), tenantId, userId)
  const scopes = new Map<string, { scope_id: string; name: string; sensitivity: string; open: number; locked: number; requested: number }>()
  for (const f of files) {
    const s = scopes.get(f.scope_id) ?? { scope_id: f.scope_id, name: f.scope_name, sensitivity: f.sensitivity, open: 0, locked: 0, requested: 0 }
    if (f.can_open) s.open++
    else s.locked++
    if (f.requested) s.requested++
    scopes.set(f.scope_id, s)
  }
  const total = (await pool().query<{ n: number }>(`select count(*)::int n from public.file_access where tenant_id = $1`, [tenantId])).rows[0].n
  return c.json({ total_files: total, listed: files.length, open: files.filter((f) => f.can_open).length, scopes: [...scopes.values()], files })
})

/**
 * The client app's catalog: the same as view-as, but files the person can't open are counted per
 * area, never listed (their names can be confidential too).
 */
access.get('/access/catalog/:principalId', async (c) => {
  const tenantId = c.get('tenant').id
  const userId = await ensureMockUser(pool(), tenantId, c.req.param('principalId'), role(c.req.query('role')))
  const files = await catalogFor(db(), tenantId, userId)
  const scopes = new Map<string, { scope_id: string; name: string; sensitivity: string; open: number; locked: number; requested: number }>()
  for (const f of files) {
    const s = scopes.get(f.scope_id) ?? { scope_id: f.scope_id, name: f.scope_name, sensitivity: f.sensitivity, open: 0, locked: 0, requested: 0 }
    if (f.can_open) s.open++
    else s.locked++
    if (f.requested) s.requested++
    scopes.set(f.scope_id, s)
  }
  const open = files.filter((f) => f.can_open)
  return c.json({ total_files: files.length, listed: files.length, open: open.length, scopes: [...scopes.values()], files: open })
})

/** Search the extracted content as that person: only passages from files they can open come back. */
access.post('/access/view-as/:principalId/search', async (c) => {
  const tenantId = c.get('tenant').id
  const { q } = (await c.req.json()) as { q?: string }
  if (!q?.trim()) return c.json({ error: 'empty query' }, 400)
  const userId = await ensureMockUser(pool(), tenantId, c.req.param('principalId'), role(c.req.query('role')))
  return c.json(await asUser(db(), userId, (tx) => searchEvidence(tenantId, q, { db: tx, limit: 15 })))
})

/** The person asks for a file or a whole scope. */
access.post('/access/view-as/:principalId/requests', async (c) => {
  const tenantId = c.get('tenant').id
  const body = (await c.req.json()) as { fileId?: string; scopeId?: string; reason?: string }
  const userId = await ensureMockUser(pool(), tenantId, c.req.param('principalId'), role(c.req.query('role')))
  try {
    return c.json({ id: await requestAccess(db(), tenantId, userId, { fileId: body.fileId, scopeId: body.scopeId }, body.reason ?? '') })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400)
  }
})

/** An admin (a person from the company map, acting with the admin role) approves or denies a request. */
access.post('/access/requests/:id/decide', async (c) => {
  const tenantId = c.get('tenant').id
  const body = (await c.req.json()) as { adminPrincipalId: string; approve: boolean; level?: 'file' | 'scope'; note?: string }
  if (!body.adminPrincipalId) return c.json({ error: 'adminPrincipalId required (who is deciding)' }, 400)
  const adminUser = await ensureMockUser(pool(), tenantId, body.adminPrincipalId, 'admin')
  try {
    await decideRequest(db(), tenantId, adminUser, c.req.param('id'), body)
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400)
  }
})
