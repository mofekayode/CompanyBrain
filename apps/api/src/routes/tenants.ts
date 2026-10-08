import { portalOverview } from '@companybrain/core/workbench/portal'
import { pool } from '@companybrain/core/workbench/server'
import { slugify } from '@companybrain/core/workbench/uploads'
import { Hono } from 'hono'

export const tenants = new Hono()

/** Portal home: clients with progress and recent sessions. */
tenants.get('/portal', async (c) => c.json(await portalOverview()))

tenants.get('/tenants', async (c) => {
  const { rows } = await pool().query(
    `select t.slug, t.name, (select count(*)::int from public.source_objects o where o.tenant_id = t.id) as files
     from public.tenants t where t.status = 'active' order by t.name`,
  )
  return c.json(rows)
})

tenants.get('/tenants/:slug', async (c) => {
  const { rows } = await pool().query(`select slug, name from public.tenants where slug = $1 and status = 'active'`, [c.req.param('slug')])
  return rows[0] ? c.json(rows[0]) : c.json({ error: 'unknown client' }, 404)
})

/** Add a client (tenant). */
tenants.post('/tenants', async (c) => {
  const { name } = (await c.req.json().catch(() => ({}))) as { name?: string }
  if (!name?.trim()) return c.json({ error: 'name required' }, 400)
  const base = slugify(name).slice(0, 50) || 'client'
  const db = pool()
  const taken = new Set((await db.query<{ slug: string }>(`select slug from public.tenants`)).rows.map((r) => r.slug))
  let slug = base.length >= 2 ? base : `${base}-co`
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`
  await db.query(`select public.create_tenant($1, $2, null)`, [slug, name.trim()])
  return c.json({ slug, name: name.trim() })
})
