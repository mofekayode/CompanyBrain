// Acting as a person, with the database enforcing what they can see.
//
// Until real login (Clerk) exists, any person in the company map can be
// "viewed as": they get a mock auth user (no password, can't sign in) and a
// tenant membership, and their queries run as the `authenticated` role with
// their user id in the JWT claims, so every row-level security policy applies
// exactly as it will for real users.

import { randomUUID } from 'node:crypto'
import type { Sql } from '../storage/raw'
import type { Queryable } from '../workbench/evidence-search'
import { applyAccess } from './scopes'

/** A pg Pool (connect) or a PGlite instance (transaction): both can open a transaction. */
export type Db = Sql & ({ connect: () => Promise<Queryable & { release: () => void }> } | { transaction: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T> })

export type MockRole = 'member' | 'admin'

/** Gives a company-map person a mock login user and a membership with the given role. Returns the auth user id. */
export async function ensureMockUser(sql: Sql, tenantId: string, principalId: string, role: MockRole): Promise<string> {
  const p = (await sql.query<{ user_id: string | null; kind: string }>(`select user_id, kind from public.principals where tenant_id = $1 and id = $2`, [tenantId, principalId])).rows[0]
  if (!p || p.kind !== 'user') throw new Error('not a person in this client’s company map')
  let userId = p.user_id
  if (!userId) {
    userId = randomUUID()
    await sql.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, `mock+${principalId}@companybrain.invalid`])
    await sql.query(`update public.principals set user_id = $2 where id = $1`, [principalId, userId])
  }
  await sql.query(
    `insert into public.tenant_members (tenant_id, user_id, role) values ($1, $2, $3)
     on conflict (tenant_id, user_id) do update set role = excluded.role`,
    [tenantId, userId, role],
  )
  return userId
}

/** Runs fn inside a transaction as that user: role authenticated, JWT sub = user id. Read/write per RLS. */
export async function asUser<T>(db: Db, userId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const setup = async (q: Queryable) => {
    await q.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [userId, JSON.stringify({ sub: userId, role: 'authenticated' })])
    await q.query('set local role authenticated')
  }
  if ('transaction' in db) return db.transaction(async (tx) => (await setup(tx), fn(tx)))
  const client = await db.connect()
  try {
    await client.query('begin')
    await setup(client)
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export interface CatalogFile {
  id: string
  source_name: string
  original_path: string
  original_filename: string
  format: string | null
  size_bytes: number
  scope_id: string
  scope_name: string
  sensitivity: string
  can_open: boolean
  requested: boolean
}

/** What a person sees: files they can open, locked files they may request, nothing from hidden scopes. */
export async function catalogFor(db: Db, tenantId: string, userId: string): Promise<CatalogFile[]> {
  return asUser(db, userId, async (q) => (await q.query(`select * from public.file_catalog($1) order by source_name, original_path`, [tenantId])).rows)
}

/** A person asks for access to a file or a whole scope (inserted as them, so RLS checks they ask for themselves). */
export async function requestAccess(db: Db, tenantId: string, userId: string, target: { fileId?: string; scopeId?: string }, reason: string): Promise<string> {
  const principal = (await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and user_id = $2`, [tenantId, userId])).rows[0]
  if (!principal) throw new Error('unknown user')
  const id = await asUser(db, userId, async (q) => {
    // Only files the person can see in their catalog (open or locked, not hidden) can be requested.
    if (target.fileId) {
      const visible = (await q.query(`select can_open from public.file_catalog($1) where id = $2`, [tenantId, target.fileId])).rows[0]
      if (!visible) throw new Error('file not found')
      if (visible.can_open) throw new Error('you already have access')
    }
    return (
      await q.query(
        `insert into public.access_requests (tenant_id, requester_id, source_object_id, scope_id, reason) values ($1, $2, $3, $4, $5) returning id`,
        [tenantId, principal.id, target.fileId ?? null, target.scopeId ?? null, reason || null],
      )
    ).rows[0].id as string
  })
  await db.query(`insert into public.access_audit (tenant_id, actor_id, action, target, detail) values ($1, $2, 'request.created', $3, $4)`, [
    tenantId,
    principal.id,
    JSON.stringify({ request: id, file: target.fileId ?? null, scope: target.scopeId ?? null }),
    JSON.stringify({ reason }),
  ])
  return id
}

/**
 * An admin decides a request. Approve grants the file (or, with level 'scope', the
 * whole scope) to the requester. The decision runs as the admin, so RLS checks
 * they may manage access.
 */
export async function decideRequest(
  db: Db,
  tenantId: string,
  adminUserId: string,
  requestId: string,
  decision: { approve: boolean; level?: 'file' | 'scope'; note?: string },
): Promise<void> {
  const admin = (await db.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and user_id = $2`, [tenantId, adminUserId])).rows[0]
  await asUser(db, adminUserId, async (q) => {
    const r = (await q.query(`select * from public.access_requests where id = $1 and tenant_id = $2 and status = 'pending'`, [requestId, tenantId])).rows[0]
    if (!r) throw new Error('no such pending request (or you cannot manage access)')
    const level = decision.level ?? (r.scope_id ? 'scope' : 'file')
    const updated = await q.query(
      `update public.access_requests set status = $2, grant_level = $3, decided_by = $4, decided_at = now(), decision_note = $5 where id = $1 returning id`,
      [requestId, decision.approve ? 'approved' : 'denied', decision.approve ? level : null, admin?.id ?? null, decision.note ?? null],
    )
    if (!updated.rows.length) throw new Error('you cannot manage access for this client')
    if (decision.approve) {
      let scopeId: string | null = r.scope_id
      if (level === 'scope' && !scopeId) scopeId = (await q.query(`select scope_id from public.file_access where source_object_id = $1`, [r.source_object_id])).rows[0]?.scope_id
      await q.query(
        `insert into public.access_grants (tenant_id, principal_id, source_object_id, scope_id, request_id, granted_by) values ($1, $2, $3, $4, $5, $6)
         on conflict do nothing`,
        [tenantId, r.requester_id, level === 'file' ? r.source_object_id : null, level === 'scope' ? scopeId : null, requestId, admin?.id ?? null],
      )
    }
    await q.query(`insert into public.access_audit (tenant_id, actor_id, action, target, detail) values ($1, $2, $3, $4, $5)`, [
      tenantId,
      admin?.id ?? null,
      decision.approve ? 'request.approved' : 'request.denied',
      JSON.stringify({ request: requestId }),
      JSON.stringify({ level, note: decision.note ?? null }),
    ])
  })
  if (decision.approve) await applyAccess(db, tenantId)
}

/** Releases (or holds again) a scope. With a user id it runs as that admin under RLS; without, as the FDE pipeline. */
export async function setScopeStatus(db: Db, tenantId: string, scopeId: string, status: 'held' | 'released', adminUserId?: string): Promise<void> {
  const run = async (q: Queryable) => {
    const actor = adminUserId ? (await q.query(`select id from public.principals where tenant_id = $1 and user_id = $2`, [tenantId, adminUserId])).rows[0]?.id ?? null : null
    const r = await q.query(
      `update public.access_scopes set status = $3, released_at = case when $3 = 'released' then now() end, released_by = case when $3 = 'released' then $4::uuid end
       where tenant_id = $1 and id = $2 returning id`,
      [tenantId, scopeId, status, actor],
    )
    if (!r.rows.length) throw new Error('scope not found (or you cannot manage access)')
    await q.query(`insert into public.access_audit (tenant_id, actor_id, action, target) values ($1, $2, $3, $4)`, [tenantId, actor, `scope.${status}`, JSON.stringify({ scope: scopeId })])
  }
  if (adminUserId) await asUser(db, adminUserId, run)
  else await run(db)
  await applyAccess(db, tenantId)
}
