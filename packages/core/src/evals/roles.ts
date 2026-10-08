// Who the Brain answers as, for questions asked "as a role" or as a named person. A role is a real
// person whose access matches it, or a profile: a stand-in that belongs to exactly a set of the
// company's groups (that access, nobody's personal files). Config: config/tenants/<slug>/eval-roles.json.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sql } from '../storage/raw'

export interface RoleConfig {
  person?: string
  profile?: string[]
  why: string
}
export const roleConfig = (slug: string): Record<string, RoleConfig> =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../config/tenants', slug, 'eval-roles.json'), 'utf8')) as { roles: Record<string, RoleConfig> }).roles

/** The principal for a role profile, created on first use; its memberships are kept to exactly the profile's groups. */
async function profilePrincipal(sql: Sql, tenantId: string, role: string, groups: string[]): Promise<{ id: string; name: string }> {
  const name = `Role profile: ${role}`
  let id = (await sql.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and display_name = $2`, [tenantId, name])).rows[0]?.id
  if (!id)
    id = (
      await sql.query<{ id: string }>(`insert into public.principals (tenant_id, kind, display_name, metadata) values ($1, 'user', $2, $3) returning id`, [
        tenantId,
        name,
        JSON.stringify({ status: 'profile', role_profile: role }),
      ])
    ).rows[0].id
  const want = (await sql.query<{ id: string }>(`select id from public.principals where tenant_id = $1 and kind = 'group' and display_name = any($2::text[])`, [tenantId, groups])).rows.map((r) => r.id)
  await sql.query(`delete from public.principal_members where tenant_id = $1 and member_id = $2 and not (group_id = any($3::uuid[]))`, [tenantId, id, want])
  for (const g of want) await sql.query(`insert into public.principal_members (tenant_id, group_id, member_id) values ($1, $2, $3) on conflict do nothing`, [tenantId, g, id])
  return { id, name }
}

/** A role or a named person → the principal the Brain answers as (null if unknown). */
export async function principalFor(sql: Sql, tenantId: string, slug: string, as: { role?: string; person?: { name?: string; email?: string } }): Promise<{ id: string; name: string } | null> {
  const role = as.role ? roleConfig(slug)[as.role] : undefined
  if (role?.profile) return profilePrincipal(sql, tenantId, as.role!, role.profile)
  const name = role ? role.person : as.person?.name
  const email = as.person?.email?.toLowerCase()
  const rows = (
    await sql.query<{ id: string; name: string }>(
      `select p.id, p.display_name name from public.principals p
       where p.tenant_id = $1 and p.kind = 'user'
         and (lower(p.display_name) = lower($2) or ($3::text is not null and (lower(p.metadata ->> 'email') = $3 or lower(p.external_ref) = $3)))
       order by (coalesce(p.metadata ->> 'status', 'active') = 'active') desc limit 1`,
      [tenantId, name ?? '', email ?? null],
    )
  ).rows
  return rows[0] ?? null
}
