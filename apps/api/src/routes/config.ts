import { exportTenant, importTenant, type TenantExport } from '@companybrain/core/config/export'
import { DEFAULT_RULES, mergeRules, type RulesOverride, saveOverrides, tenantOverrides } from '@companybrain/core/config/tenant-config'
import { pool } from '@companybrain/core/workbench/server'
import { Hono } from 'hono'
import type { Env } from '../tenant'

/** A client's configuration: the rules it runs with and what the FDE taught the system. */
export const config = new Hono<Env>()

/** Rules in force (defaults + overrides), the overrides alone, and the version history. */
config.get('/config', async (c) => {
  const tenantId = c.get('tenant').id
  const current = await tenantOverrides(pool(), tenantId)
  const history = (
    await pool().query<{ version: number; note: string | null; author: string; created_at: string }>(
      `select version, note, author, created_at::text from public.tenant_config_versions where tenant_id = $1 order by version desc limit 50`,
      [tenantId],
    )
  ).rows
  return c.json({ defaults: DEFAULT_RULES, overrides: current?.overrides ?? {}, effective: mergeRules(DEFAULT_RULES, current?.overrides), version: current?.version ?? 0, history })
})

/** Save a new version of the overrides. Body: { overrides, note }. */
config.put('/config', async (c) => {
  const body = (await c.req.json()) as { overrides?: RulesOverride; note?: string }
  if (!body.overrides || !body.note?.trim()) return c.json({ error: 'overrides and a note are required' }, 400)
  const r = await saveOverrides(pool(), c.get('tenant').id, body.overrides, body.note.trim())
  return r.problems.length ? c.json(r, 400) : c.json(r)
})

/** What the FDE has captured so far (counts per kind), for the configuration page. */
config.get('/config/summary', async (c) => {
  const data = await exportTenant(pool(), c.get('tenant').id, 'full')
  return c.json({
    rules_changed: Object.values(data.rules).reduce((n, s) => n + Object.keys(s ?? {}).length, 0),
    entity_types: data.ontology.entity_types.length,
    relationship_types: data.ontology.relationship_types.length,
    table_mappings: data.ontology.table_mappings?.length ?? 0,
    directory_mappings: data.directory_mappings?.length ?? 0,
    vocabulary: data.vocabulary?.filter((v) => v.status !== 'rejected').length ?? 0,
    rejected_aliases: data.vocabulary?.filter((v) => v.status === 'rejected').length ?? 0,
    merges: data.merges?.reduce((n, m) => n + m.merged.length, 0) ?? 0,
    kept_separate: data.separate?.length ?? 0,
    scopes: data.access?.scopes.length ?? 0,
    file_moves: data.access?.file_moves.length ?? 0,
    eval_items: data.validation?.eval_sets.reduce((n, s) => n + s.items.length, 0) ?? 0,
    tables: data.ontology.table_mappings?.map((t) => ({ path: t.path, system: t.system, kind: t.kind, type: t.kind === 'events' ? t.event_type : t.entity_type, links: t.links.length })) ?? [],
    vocabulary_sample: data.vocabulary?.filter((v) => v.status !== 'rejected').slice(0, 200) ?? [],
    rejected_sample: data.vocabulary?.filter((v) => v.status === 'rejected').slice(0, 100) ?? [],
  })
})

/** Download the configuration. ?mode=template leaves out everything specific to this client. */
config.get('/config/export', async (c) => {
  const mode = c.req.query('mode') === 'template' ? 'template' : 'full'
  const data = await exportTenant(pool(), c.get('tenant').id, mode)
  c.header('Content-Disposition', `attachment; filename="${data.tenant.slug}-${mode}.json"`)
  return c.json(data)
})

/** Apply an exported configuration (idempotent; never deletes). */
config.post('/config/import', async (c) => {
  const data = (await c.req.json()) as TenantExport
  return c.json(await importTenant(pool(), c.get('tenant').id, data))
})
