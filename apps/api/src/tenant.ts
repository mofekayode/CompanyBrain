import { tenantBySlug } from '@companybrain/core/workbench/server'
import { createMiddleware } from 'hono/factory'

export interface Tenant {
  id: string
  slug: string
  name: string
}

export type Env = { Variables: { tenant: Tenant } }

/** Resolves `:slug` to the client (tenant) for every /api/t/:slug/* route. */
export const withTenant = createMiddleware<Env>(async (c, next) => {
  const tenant = await tenantBySlug(c.req.param('slug') ?? '')
  if (!tenant) return c.json({ error: 'unknown client' }, 404)
  c.set('tenant', tenant)
  await next()
})
