import { pool } from './server'

export interface ClientRow {
  slug: string
  name: string
  created_at: string
  files: number
  sources: number
  bytes: string | null
  issues: number
  duplicates: number
  questions: number
  confirmed: number
  hypotheses: number
  sessions: number
  last_activity: string | null
}

export interface RecentSession {
  id: string
  title: string
  updated_at: string
  slug: string
  client: string
  steps: number
  findings: number
}

/** Portal home: every active client with progress, and the most recent work sessions. */
export async function portalOverview(): Promise<{ clients: ClientRow[]; recent: RecentSession[] }> {
  const db = pool()
  const clients = (
    await db.query<ClientRow>(
      `select t.slug, t.name, t.created_at,
              coalesce(inv.files, 0)::int files, coalesce(inv.sources, 0)::int sources, inv.bytes::text bytes,
              coalesce(inv.issues, 0)::int issues, coalesce(inv.duplicates, 0)::int duplicates,
              (select count(*)::int from public.discovery_questions) questions,
              coalesce(f.confirmed, 0)::int confirmed, coalesce(f.hypotheses, 0)::int hypotheses,
              coalesce(s.sessions, 0)::int sessions, greatest(s.last_session, f.last_finding, t.created_at) last_activity
       from public.tenants t
       left join lateral (
         select count(*) files, count(distinct source_id) sources, sum(size_bytes) bytes,
                count(*) filter (where not integrity_ok) issues, count(*) filter (where duplicate_copies > 1) duplicates
         from public.source_inventory i where i.tenant_id = t.id) inv on true
       left join lateral (
         select count(distinct question_id) filter (where status = 'confirmed') confirmed,
                count(distinct question_id) filter (where status = 'hypothesis') hypotheses,
                max(updated_at) last_finding
         from public.discovery_findings df where df.tenant_id = t.id and df.status <> 'superseded') f on true
       left join lateral (
         select count(*) sessions, max(updated_at) last_session
         from public.workbench_sessions ws where ws.tenant_id = t.id
           and exists (select 1 from public.workbench_messages m where m.session_id = ws.id)) s on true
       where t.status = 'active'
       order by last_activity desc nulls last`,
    )
  ).rows
  const recent = (
    await db.query<RecentSession>(
      `select s.id, s.title, s.updated_at, t.slug, t.name client,
              (select count(*)::int from public.workbench_steps st where st.session_id = s.id) steps,
              (select count(*)::int from public.discovery_findings df where df.session_id = s.id) findings
       from public.workbench_sessions s join public.tenants t on t.id = s.tenant_id
       where exists (select 1 from public.workbench_messages m where m.session_id = s.id)
       order by s.updated_at desc limit 12`,
    )
  ).rows
  return { clients, recent }
}
