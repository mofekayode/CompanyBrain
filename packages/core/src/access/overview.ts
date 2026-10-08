// Read models and FDE edits for the People & access stage (service role: the
// FDE workbench sees everything; client-facing reads go through enforce.ts).

import type { Sql } from '../storage/raw'
import { applyAccess } from './scopes'

export async function accessOverview(sql: Sql, tenantId: string) {
  const scopes = (
    await sql.query(
      `select sc.id, sc.key, sc.name, sc.description, sc.sensitivity, sc.hidden, sc.status, sc.origin, sc.rules, sc.evidence, sc.released_at,
              count(fa.source_object_id)::int files, count(fa.source_object_id) filter (where fa.flagged)::int flagged,
              coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'kind', p.kind, 'why', a.why) order by p.kind desc, p.display_name)
                        from public.access_scope_audience a join public.principals p on p.id = a.principal_id where a.scope_id = sc.id), '[]') audience,
              (select count(*)::int from public.access_requests r where r.scope_id = sc.id and r.status = 'pending')
              + (select count(*)::int from public.access_requests r join public.file_access f2 on f2.source_object_id = r.source_object_id
                 where f2.scope_id = sc.id and r.status = 'pending') pending_requests
       from public.access_scopes sc left join public.file_access fa on fa.scope_id = sc.id
       where sc.tenant_id = $1 group by sc.id
       order by case sc.sensitivity when 'internal' then 0 when 'confidential' then 1 else 2 end, sc.name`,
      [tenantId],
    )
  ).rows
  type AuditRow = { detail: Record<string, any>; created_at: string }
  const proposal = (
    await sql.query<AuditRow>(`select detail, created_at from public.access_audit where tenant_id = $1 and action = 'scopes.proposed' order by created_at desc limit 1`, [tenantId])
  ).rows[0]
  const map = (
    await sql.query<AuditRow>(`select detail, created_at from public.access_audit where tenant_id = $1 and action = 'company_map.built' order by created_at desc limit 1`, [tenantId])
  ).rows[0]
  const people = (
    await sql.query<{ status: string; n: number }>(
      `select metadata ->> 'status' status, count(*)::int n from public.principals
       where tenant_id = $1 and kind = 'user' and metadata ->> 'origin' = 'company_map' and not metadata ? 'stale' group by 1`,
      [tenantId],
    )
  ).rows
  const unassigned = (
    await sql.query<{ n: number }>(
      `select count(*)::int n from public.source_objects so where so.tenant_id = $1 and not exists (select 1 from public.file_access fa where fa.source_object_id = so.id)`,
      [tenantId],
    )
  ).rows[0].n
  const pending = (await sql.query<{ n: number }>(`select count(*)::int n from public.access_requests where tenant_id = $1 and status = 'pending'`, [tenantId])).rows[0].n
  return {
    people: Object.fromEntries(people.map((p) => [p.status, p.n])),
    company_map: map ? { built_at: map.created_at, ...map.detail } : null,
    proposal: proposal ? { proposed_at: proposal.created_at, notes: proposal.detail.notes ?? [], escalated: proposal.detail.escalated ?? 0 } : null,
    scopes,
    unassigned_files: unassigned,
    pending_requests: pending,
  }
}

export async function companyMap(sql: Sql, tenantId: string) {
  const people = (
    await sql.query(
      `select p.id, p.display_name name, p.metadata ->> 'status' status, p.metadata ->> 'title' title, p.metadata ->> 'department' department,
              p.metadata ->> 'location' location, p.metadata -> 'emails' emails, p.metadata -> 'systems' systems, p.metadata -> 'conflicts' conflicts,
              p.metadata ->> 'manager_id' manager_id, m.display_name manager, p.user_id is not null as has_login,
              coalesce((select jsonb_agg(g.display_name order by g.display_name) from public.principal_members pm join public.principals g on g.id = pm.group_id where pm.member_id = p.id), '[]') groups
       from public.principals p left join public.principals m on m.id::text = p.metadata ->> 'manager_id'
       where p.tenant_id = $1 and p.kind = 'user' and p.metadata ->> 'origin' = 'company_map' and not p.metadata ? 'stale'
       order by case p.metadata ->> 'status' when 'active' then 0 when 'former' then 1 when 'guest' then 2 else 3 end, p.metadata ->> 'department', p.display_name`,
      [tenantId],
    )
  ).rows
  const groups = (
    await sql.query(
      `select g.id, g.display_name name, g.metadata ->> 'group_type' type, g.metadata ->> 'system' system, count(pm.member_id)::int members
       from public.principals g left join public.principal_members pm on pm.group_id = g.id
       where g.tenant_id = $1 and g.kind = 'group' and g.metadata ->> 'origin' = 'company_map' and not g.metadata ? 'stale'
       group by g.id order by 3, 2`,
      [tenantId],
    )
  ).rows
  return { people, groups }
}

export async function scopeFiles(sql: Sql, tenantId: string, scopeId: string) {
  return (
    await sql.query(
      `select so.id, s.name source, so.original_path path, so.metadata -> 'profile' ->> 'format' format, fa.sensitivity, fa.origin, fa.flagged, fa.reasons
       from public.file_access fa join public.source_objects so on so.id = fa.source_object_id join public.sources s on s.id = so.source_id
       where fa.tenant_id = $1 and fa.scope_id = $2
       order by fa.flagged desc, so.parent_id is not null, s.name, so.original_path limit 2000`,
      [tenantId, scopeId],
    )
  ).rows
}

/** FDE edits a scope's settings (name, sensitivity, hidden). Marks it human-owned so a re-proposal won't overwrite it. */
export async function updateScope(sql: Sql, tenantId: string, scopeId: string, patch: { name?: string; sensitivity?: string; hidden?: boolean; audience?: string[] }) {
  await sql.query(
    `update public.access_scopes set name = coalesce($3, name), sensitivity = coalesce($4, sensitivity), hidden = coalesce($5, hidden), origin = 'human'
     where tenant_id = $1 and id = $2`,
    [tenantId, scopeId, patch.name ?? null, patch.sensitivity ?? null, patch.hidden ?? null],
  )
  if (patch.audience) {
    await sql.query(`delete from public.access_scope_audience where scope_id = $1 and not (principal_id = any($2::uuid[]))`, [scopeId, patch.audience])
    await sql.query(
      `insert into public.access_scope_audience (tenant_id, scope_id, principal_id, why) select $1, $2, unnest($3::uuid[]), 'set by FDE' on conflict do nothing`,
      [tenantId, scopeId, patch.audience],
    )
  }
  if (patch.sensitivity) await sql.query(`update public.file_access set sensitivity = $3 where tenant_id = $1 and scope_id = $2`, [tenantId, scopeId, patch.sensitivity])
  await sql.query(`insert into public.access_audit (tenant_id, action, target, detail) values ($1, 'scope.edited', $2, $3)`, [tenantId, JSON.stringify({ scope: scopeId }), JSON.stringify(patch)])
  return applyAccess(sql, tenantId)
}

/** FDE moves files to another scope (a human decision: never overwritten by a re-proposal). Children move with their container. */
export async function moveFiles(sql: Sql, tenantId: string, fileIds: string[], scopeId: string, note: string) {
  const scope = (await sql.query<{ acl_id: string; sensitivity: string; name: string }>(`select acl_id, sensitivity, name from public.access_scopes where tenant_id = $1 and id = $2`, [tenantId, scopeId])).rows[0]
  if (!scope) throw new Error('unknown scope')
  const { rows } = await sql.query<{ id: string }>(
    `with recursive tree (id) as (select id from public.source_objects where tenant_id = $1 and id = any($2::uuid[])
       union select c.id from public.source_objects c join tree on c.parent_id = tree.id)
     update public.file_access fa set scope_id = $3, acl_id = $4, sensitivity = $5, origin = 'human', flagged = false,
       reasons = fa.reasons || jsonb_build_array(jsonb_build_object('kind', 'human', 'text', $6::text))
     from tree where fa.source_object_id = tree.id returning fa.source_object_id id`,
    [tenantId, fileIds, scopeId, scope.acl_id, scope.sensitivity, `moved to ${scope.name} by FDE${note ? `: ${note}` : ''}`],
  )
  await sql.query(`insert into public.access_audit (tenant_id, action, target, detail) values ($1, 'files.moved', $2, $3)`, [tenantId, JSON.stringify({ scope: scopeId }), JSON.stringify({ files: rows.length, note })])
  await applyAccess(sql, tenantId)
  return { moved: rows.length }
}

export async function listRequests(sql: Sql, tenantId: string) {
  return (
    await sql.query(
      `select r.id, r.status, r.reason, r.created_at, r.decided_at, r.grant_level, r.decision_note,
              req.display_name requester, dec.display_name decided_by,
              so.original_path file_path, so.id file_id, coalesce(sc.name, fsc.name) scope_name, coalesce(sc.id, fsc.id) scope_id
       from public.access_requests r
       join public.principals req on req.id = r.requester_id
       left join public.principals dec on dec.id = r.decided_by
       left join public.source_objects so on so.id = r.source_object_id
       left join public.access_scopes sc on sc.id = r.scope_id
       left join public.file_access fa on fa.source_object_id = r.source_object_id
       left join public.access_scopes fsc on fsc.id = fa.scope_id
       where r.tenant_id = $1 order by r.status <> 'pending', r.created_at desc limit 200`,
      [tenantId],
    )
  ).rows
}

export async function auditLog(sql: Sql, tenantId: string) {
  return (
    await sql.query(
      `select a.action, a.target, a.detail, a.created_at, p.display_name actor
       from public.access_audit a left join public.principals p on p.id = a.actor_id
       where a.tenant_id = $1 order by a.created_at desc limit 200`,
      [tenantId],
    )
  ).rows
}
