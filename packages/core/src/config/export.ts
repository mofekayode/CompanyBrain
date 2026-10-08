// Export / import of everything an FDE taught the system about one client, as one
// JSON file (config/tenants/<slug>/tenant.json), so it can be reviewed in git,
// re-applied after a rebuild, or used to start the next client.
//
// Two modes:
// - full:     the client's own work: rules, ontology + table mappings, directory
//             mappings, vocabulary (incl. rejected aliases), merge decisions,
//             access scopes + manual file moves, eval sets.
// - template: only what transfers to a *different* company: rules and the
//             catalogue of entity / relationship types. No names, no files.
//
// Files are referenced by original path (ids differ between tenants and rebuilds).
// Import is idempotent and never deletes; it reports what it could not match.

import type { EvalSpec, EvalSpecItem } from '../evals/load'
import { loadEvalSet } from '../evals/load'
import type { OntologyProposal, TableMapping } from '../ontology/propose'
import { mergeInto } from '../ontology/resolve'
import type { Sql } from '../storage/raw'
import { type RulesOverride, saveOverrides, tenantOverrides } from './tenant-config'

export const TENANT_EXPORT_FORMAT = 'companybrain.tenant/v1'

export interface TenantExport {
  format: typeof TENANT_EXPORT_FORMAT
  mode: 'full' | 'template'
  exported_at: string
  tenant: { slug: string; name: string }
  /** Rule overrides on top of the code defaults (see tenant-config.ts). */
  rules: RulesOverride
  ontology: {
    entity_types: { name: string; description: string | null; status: string; parent: string | null }[]
    relationship_types: { name: string; description: string | null; source_type: string | null; target_type: string | null; status: string }[]
    /** How each structured file maps onto the ontology (by path). */
    table_mappings?: (Omit<TableMapping, 'file_id'> & { path: string })[]
    notes?: string[]
  }
  /** How each directory/HR/permission export maps onto people fields (by path). */
  directory_mappings?: { path: string; mapping: Record<string, unknown> }[]
  /** Jargon, nicknames, former names. Rejected ones stay rejected on re-import. */
  vocabulary?: { entity_type: string; entity: string; alias: string; kind: string; status: string }[]
  /** Duplicate decisions: merged names, and pairs judged to be different things. */
  merges?: { entity_type: string; kept: string; merged: string[] }[]
  separate?: { entity_type: string; a: string; b: string }[]
  access?: {
    scopes: { key: string; name: string; description: string | null; sensitivity: string; hidden: boolean; status: string; rules: unknown; audience: string[] }[]
    /** Files an FDE moved by hand (they override the scope rules). */
    file_moves: { path: string; scope_key: string; note: string | null }[]
  }
  validation?: { eval_sets: EvalSpec[] }
}

export async function exportTenant(sql: Sql, tenantId: string, mode: 'full' | 'template' = 'full'): Promise<TenantExport> {
  const tenant = (await sql.query<{ slug: string; name: string }>(`select slug, name from public.tenants where id = $1`, [tenantId])).rows[0]
  if (!tenant) throw new Error('unknown tenant')
  const overrides = (await tenantOverrides(sql, tenantId))?.overrides ?? {}
  // A template never carries the client's own words (company context, system names, jargon).
  const { prompts: _clientPrompts, ...generic } = overrides
  const rules = mode === 'template' ? generic : overrides
  const entityTypes = (
    await sql.query<{ name: string; description: string | null; status: string; parent: string | null }>(
      `select t.name, t.description, t.status, p.name parent from public.entity_types t left join public.entity_types p on p.id = t.parent_type_id
       where t.tenant_id = $1 and t.status <> 'rejected' order by t.name`,
      [tenantId],
    )
  ).rows
  const relTypes = (
    await sql.query<{ name: string; description: string | null; source_type: string | null; target_type: string | null; status: string }>(
      `select r.name, r.description, s.name source_type, t.name target_type, r.status from public.relationship_types r
       left join public.entity_types s on s.id = r.source_type_id left join public.entity_types t on t.id = r.target_type_id
       where r.tenant_id = $1 and r.status <> 'rejected' and r.name <> 'possibly_same_as' order by r.name`,
      [tenantId],
    )
  ).rows
  const out: TenantExport = {
    format: TENANT_EXPORT_FORMAT,
    mode,
    exported_at: new Date().toISOString(),
    tenant,
    rules,
    ontology: { entity_types: entityTypes, relationship_types: relTypes },
  }
  if (mode === 'template') return out

  // Table mappings from the latest ontology proposal, keyed by path.
  const proposal = (
    await sql.query<{ result: OntologyProposal }>(
      `select result from public.ingestion_jobs where tenant_id = $1 and job_type = 'propose_ontology' and status = 'succeeded' order by finished_at desc limit 1`,
      [tenantId],
    )
  ).rows[0]?.result
  if (proposal) {
    const paths = await pathsById(sql, tenantId, proposal.tables.map((t) => t.file_id))
    out.ontology.table_mappings = proposal.tables.filter((t) => paths.has(t.file_id)).map(({ file_id, ...t }) => ({ path: paths.get(file_id)!, ...t }))
    out.ontology.notes = proposal.notes
  }
  out.directory_mappings = (
    await sql.query<{ path: string; mapping: Record<string, unknown> }>(
      `select original_path path, metadata -> 'directory_mapping' mapping from public.source_objects where tenant_id = $1 and metadata ? 'directory_mapping' order by 1`,
      [tenantId],
    )
  ).rows
  out.vocabulary = (
    await sql.query<{ entity_type: string; entity: string; alias: string; kind: string; status: string }>(
      `select t.name entity_type, e.canonical_name entity, a.alias, a.kind, a.status
       from public.entity_aliases a join public.entities e on e.id = a.entity_id join public.entity_types t on t.id = e.entity_type_id
       where a.tenant_id = $1 and e.status in ('candidate', 'active') and a.kind in ('jargon', 'nickname', 'former_name', 'abbreviation') order by 1, 2, 3`,
      [tenantId],
    )
  ).rows
  // Merges: every merged entity points at its survivor. Certain merges (same name / shared id) redo themselves; keep the judged ones.
  out.merges = (
    await sql.query<{ entity_type: string; kept: string; merged: string[] }>(
      `select t.name entity_type, s.canonical_name kept, array_agg(distinct m.canonical_name order by m.canonical_name) merged
       from public.entities m join public.entities s on s.id = m.merged_into_id join public.entity_types t on t.id = s.entity_type_id
       where m.tenant_id = $1 and m.status = 'merged' and s.status in ('candidate', 'active')
         and lower(m.canonical_name) <> lower(s.canonical_name) and coalesce(m.metadata ->> 'merge_reason', '') <> 'same normalized name or shared identifier'
       group by 1, 2 order by 1, 2`,
      [tenantId],
    )
  ).rows
  out.separate = (
    await sql.query<{ entity_type: string; a: string; b: string }>(
      `select t.name entity_type, a.canonical_name a, b.canonical_name b from public.relationships r
       join public.relationship_types rt on rt.id = r.relationship_type_id and rt.name = 'possibly_same_as'
       join public.entities a on a.id = r.source_entity_id join public.entities b on b.id = r.target_entity_id join public.entity_types t on t.id = a.entity_type_id
       where r.tenant_id = $1 and r.status = 'rejected' order by 1, 2, 3`,
      [tenantId],
    )
  ).rows
  const scopes = (
    await sql.query<{ key: string; name: string; description: string | null; sensitivity: string; hidden: boolean; status: string; rules: unknown; audience: string[] | null }>(
      `select s.key, s.name, s.description, s.sensitivity, s.hidden, s.status, s.rules,
              (select array_agg(p.display_name order by p.display_name) from public.access_scope_audience au join public.principals p on p.id = au.principal_id where au.scope_id = s.id) audience
       from public.access_scopes s where s.tenant_id = $1 order by s.key`,
      [tenantId],
    )
  ).rows
  const moves = (
    await sql.query<{ path: string; scope_key: string; note: string | null }>(
      `select so.original_path path, s.key scope_key, (select r ->> 'text' from jsonb_array_elements(fa.reasons) r where r ->> 'kind' = 'human' order by 1 desc limit 1) note
       from public.file_access fa join public.source_objects so on so.id = fa.source_object_id join public.access_scopes s on s.id = fa.scope_id
       where fa.tenant_id = $1 and fa.origin = 'human' and so.parent_id is null order by 1`,
      [tenantId],
    )
  ).rows
  out.access = { scopes: scopes.map((s) => ({ ...s, audience: s.audience ?? [] })), file_moves: moves }
  out.validation = { eval_sets: await exportEvalSets(sql, tenantId) }
  return out
}

async function pathsById(sql: Sql, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const rows = (await sql.query<{ id: string; path: string }>(`select id, original_path path from public.source_objects where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, ids])).rows
  return new Map(rows.map((r) => [r.id, r.path]))
}

async function idsByPath(sql: Sql, tenantId: string, paths: string[]): Promise<Map<string, string>> {
  const rows = (
    await sql.query<{ id: string; path: string }>(
      `select distinct on (original_path) id, original_path path from public.source_objects where tenant_id = $1 and original_path = any($2::text[]) order by original_path, created_at desc`,
      [tenantId, paths],
    )
  ).rows
  return new Map(rows.map((r) => [r.path, r.id]))
}

async function exportEvalSets(sql: Sql, tenantId: string): Promise<EvalSpec[]> {
  const sets = (await sql.query<{ id: string; name: string; description: string | null; origin: 'ai' | 'human' }>(`select id, name, description, origin from public.eval_sets where tenant_id = $1 order by name`, [tenantId])).rows
  const out: EvalSpec[] = []
  for (const s of sets) {
    const items = (
      await sql.query<{ kind: EvalSpecItem['kind']; category: string; question: string; expected_answer: string | null; difficulty: EvalSpecItem['difficulty']; expected: Record<string, unknown>; persona: string | null; as_of: string | null }>(
        `select i.kind, i.category, i.question, i.expected_answer, i.difficulty, i.expected, p.display_name persona, i.as_of::text
         from public.eval_items i left join public.principals p on p.id = i.persona_id where i.set_id = $1 and i.status = 'active' order by i.created_at`,
        [s.id],
      )
    ).rows
    out.push({
      name: s.name,
      description: s.description ?? '',
      origin: s.origin,
      items: items.map((i) => ({
        kind: i.kind,
        category: i.category,
        question: i.question,
        ...(i.expected_answer ? { expected_answer: i.expected_answer } : {}),
        ...(i.difficulty ? { difficulty: i.difficulty } : {}),
        ...(i.expected.assertion ? { assertion: i.expected.assertion as EvalSpecItem['assertion'] } : {}),
        ...((i.expected.key_points as string[] | undefined)?.length ? { key_points: i.expected.key_points as string[] } : {}),
        ...((i.expected.anchors as EvalSpecItem['anchors'])?.length ? { anchors: i.expected.anchors as EvalSpecItem['anchors'] } : {}),
        ...(i.persona ? { persona: i.persona } : {}),
        ...(i.as_of ? { as_of: i.as_of } : {}),
      })),
    })
  }
  return out
}

export interface ImportReport {
  rules: { version: number; problems: string[] } | 'unchanged'
  entity_types: number
  relationship_types: number
  table_mappings: { applied: number; missing_files: string[] }
  directory_mappings: { applied: number; missing_files: string[] }
  vocabulary: { added: number; updated: number; missing_entities: string[] }
  merges: { merged: number; missing: string[] }
  separate: { recorded: number }
  access: { scopes: number; audience: number; missing_people: string[]; file_moves: number; missing_files: string[] }
  eval_sets: { name: string; items: number; warnings: number }[]
}

/**
 * Applies an export to a tenant. Safe to run repeatedly. Scopes imported into a
 * different tenant arrive held (an admin releases them); nothing is deleted.
 */
export async function importTenant(sql: Sql, tenantId: string, data: TenantExport, opts: { note?: string } = {}): Promise<ImportReport> {
  if (data.format !== TENANT_EXPORT_FORMAT) throw new Error(`unsupported format ${data.format}`)
  const tenant = (await sql.query<{ slug: string }>(`select slug from public.tenants where id = $1`, [tenantId])).rows[0]
  const sameTenant = tenant?.slug === data.tenant.slug
  const report: ImportReport = {
    rules: 'unchanged',
    entity_types: 0,
    relationship_types: 0,
    table_mappings: { applied: 0, missing_files: [] },
    directory_mappings: { applied: 0, missing_files: [] },
    vocabulary: { added: 0, updated: 0, missing_entities: [] },
    merges: { merged: 0, missing: [] },
    separate: { recorded: 0 },
    access: { scopes: 0, audience: 0, missing_people: [], file_moves: 0, missing_files: [] },
    eval_sets: [],
  }

  // Rules: only save when they differ from what is in force.
  const current = (await tenantOverrides(sql, tenantId))?.overrides ?? {}
  if (JSON.stringify(current) !== JSON.stringify(data.rules ?? {})) report.rules = await saveOverrides(sql, tenantId, data.rules ?? {}, opts.note ?? `imported from ${data.tenant.slug} (${data.mode})`, 'import')

  // Ontology types (as proposed, unless already there).
  for (const t of data.ontology.entity_types) {
    const r = await sql.query(
      `insert into public.entity_types (tenant_id, name, description, status, origin, metadata)
       select $1, $2, $3, $4, 'human', '{"imported": true}'::jsonb where not exists (select 1 from public.entity_types where tenant_id = $1 and name = $2) returning 1`,
      [tenantId, t.name, t.description, sameTenant ? t.status : 'proposed'],
    )
    report.entity_types += r.rows.length
  }
  for (const t of data.ontology.entity_types.filter((t) => t.parent)) {
    await sql.query(
      `update public.entity_types c set parent_type_id = p.id from public.entity_types p
       where c.tenant_id = $1 and c.name = $2 and p.tenant_id = $1 and p.name = $3 and c.parent_type_id is null`,
      [tenantId, t.name, t.parent],
    )
  }
  for (const r of data.ontology.relationship_types) {
    const res = await sql.query(
      `insert into public.relationship_types (tenant_id, name, description, source_type_id, target_type_id, status, origin, metadata)
       select $1, $2, $3, (select id from public.entity_types where tenant_id = $1 and name = $4), (select id from public.entity_types where tenant_id = $1 and name = $5), $6, 'human', '{"imported": true}'::jsonb
       where not exists (select 1 from public.relationship_types where tenant_id = $1 and name = $2) returning 1`,
      [tenantId, r.name, r.description, r.source_type, r.target_type, sameTenant ? r.status : 'proposed'],
    )
    report.relationship_types += res.rows.length
  }

  // Table mappings become an ontology proposal the loader can reuse (no AI call needed).
  if (data.ontology.table_mappings?.length) {
    const ids = await idsByPath(sql, tenantId, data.ontology.table_mappings.map((t) => t.path))
    const tables = data.ontology.table_mappings.filter((t) => ids.has(t.path)).map(({ path, ...t }) => ({ file_id: ids.get(path)!, ...t }))
    report.table_mappings = { applied: tables.length, missing_files: data.ontology.table_mappings.filter((t) => !ids.has(t.path)).map((t) => t.path) }
    if (tables.length) {
      const proposal: OntologyProposal = {
        entity_types: data.ontology.entity_types.map((t) => ({ name: t.name, description: t.description ?? '', parent: t.parent, identifier_systems: [], examples: [] })),
        relationship_types: data.ontology.relationship_types
          .filter((r) => r.source_type && r.target_type)
          .map((r) => ({ name: r.name, description: r.description ?? '', source_type: r.source_type!, target_type: r.target_type! })),
        tables,
        notes: data.ontology.notes ?? [],
      }
      const same = (
        await sql.query<{ result: OntologyProposal }>(
          `select result from public.ingestion_jobs where tenant_id = $1 and job_type = 'propose_ontology' and status = 'succeeded' order by finished_at desc limit 1`,
          [tenantId],
        )
      ).rows[0]?.result
      if (JSON.stringify(same?.tables ?? null) !== JSON.stringify(proposal.tables))
        await sql.query(
          `insert into public.ingestion_jobs (tenant_id, job_type, idempotency_key, status, payload, result, started_at, finished_at)
           values ($1, 'propose_ontology', $2, 'succeeded', $3, $4, now(), now())`,
          [tenantId, `propose_ontology:import:${Date.now()}`, JSON.stringify({ imported_from: data.tenant.slug }), JSON.stringify(proposal)],
        )
    }
  }

  if (data.directory_mappings?.length) {
    const ids = await idsByPath(sql, tenantId, data.directory_mappings.map((d) => d.path))
    for (const d of data.directory_mappings) {
      const id = ids.get(d.path)
      if (!id) {
        report.directory_mappings.missing_files.push(d.path)
        continue
      }
      await sql.query(`update public.source_objects set metadata = jsonb_set(metadata, '{directory_mapping}', $2::jsonb) where id = $1`, [id, JSON.stringify({ ...d.mapping, file_id: id })])
      report.directory_mappings.applied++
    }
  }

  const entity = async (type: string, name: string) =>
    (
      await sql.query<{ id: string }>(
        `select e.id from public.entities e join public.entity_types t on t.id = e.entity_type_id and t.name = $2
         where e.tenant_id = $1 and e.status in ('candidate', 'active') and lower(e.canonical_name) = lower($3) limit 1`,
        [tenantId, type, name],
      )
    ).rows[0]?.id

  for (const v of data.vocabulary ?? []) {
    const id = await entity(v.entity_type, v.entity)
    if (!id) {
      report.vocabulary.missing_entities.push(`${v.entity_type}: ${v.entity}`)
      continue
    }
    const upd = await sql.query(`update public.entity_aliases set status = $3 where entity_id = $1 and normalized_alias = lower(btrim($2)) and status <> $3 returning 1`, [id, v.alias, v.status])
    if (upd.rows.length) report.vocabulary.updated++
    const ins = await sql.query(
      `insert into public.entity_aliases (tenant_id, entity_id, alias, kind, status, origin, context)
       select $1, $2, $3, $4, $5, 'human', '{"imported": true}'::jsonb where not exists (select 1 from public.entity_aliases where entity_id = $2 and normalized_alias = lower(btrim($3))) returning 1`,
      [tenantId, id, v.alias, v.kind, v.status],
    )
    report.vocabulary.added += ins.rows.length
  }

  for (const m of data.merges ?? []) {
    const kept = await entity(m.entity_type, m.kept)
    if (!kept) {
      report.merges.missing.push(`${m.entity_type}: ${m.kept}`)
      continue
    }
    const others = (await Promise.all(m.merged.map((n) => entity(m.entity_type, n)))).filter((x): x is string => !!x && x !== kept)
    if (others.length) {
      await mergeInto(sql, tenantId, kept, others, `imported decision (${data.tenant.slug})`)
      report.merges.merged += others.length
    }
  }

  for (const s of data.separate ?? []) {
    const [a, b] = [await entity(s.entity_type, s.a), await entity(s.entity_type, s.b)]
    if (!a || !b) continue
    const r = await sql.query(
      `update public.relationships r set status = 'rejected' from public.relationship_types rt
       where rt.id = r.relationship_type_id and rt.name = 'possibly_same_as' and r.tenant_id = $1 and r.status <> 'rejected'
         and ((r.source_entity_id = $2 and r.target_entity_id = $3) or (r.source_entity_id = $3 and r.target_entity_id = $2)) returning 1`,
      [tenantId, a, b],
    )
    report.separate.recorded += r.rows.length
  }

  if (data.access) await importAccess(sql, tenantId, data, sameTenant, report)

  for (const set of data.validation?.eval_sets ?? []) {
    const r = await loadEvalSet(sql, tenantId, set)
    report.eval_sets.push({ name: set.name, items: r.items, warnings: r.warnings.length })
  }
  return report
}

async function importAccess(sql: Sql, tenantId: string, data: TenantExport, sameTenant: boolean, report: ImportReport) {
  const { applyAccess } = await import('../access/scopes')
  const { moveFiles } = await import('../access/overview')
  const people = new Map(
    (await sql.query<{ id: string; name: string }>(`select id, display_name name from public.principals where tenant_id = $1`, [tenantId])).rows.map((p) => [p.name.toLowerCase(), p.id]),
  )
  for (const s of data.access!.scopes) {
    const status = sameTenant ? s.status : 'held'
    let id = (await sql.query<{ id: string }>(`select id from public.access_scopes where tenant_id = $1 and key = $2`, [tenantId, s.key])).rows[0]?.id
    if (id) {
      await sql.query(`update public.access_scopes set name = $2, description = $3, sensitivity = $4, hidden = $5, rules = $6 where id = $1`, [
        id,
        s.name,
        s.description,
        s.sensitivity,
        s.hidden,
        JSON.stringify(s.rules ?? []),
      ])
    } else {
      const acl = (await sql.query<{ id: string }>(`insert into public.acls (tenant_id, name, origin) values ($1, $2, $3) returning id`, [tenantId, `scope:${s.key}`, JSON.stringify({ scope: s.key })])).rows[0].id
      id = (
        await sql.query<{ id: string }>(
          `insert into public.access_scopes (tenant_id, key, name, description, sensitivity, hidden, status, acl_id, origin, rules, evidence)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'human', $9, '[]') returning id`,
          [tenantId, s.key, s.name, s.description, s.sensitivity, s.hidden, status, acl, JSON.stringify(s.rules ?? [])],
        )
      ).rows[0].id
    }
    report.access.scopes++
    for (const name of s.audience) {
      const pid = people.get(name.toLowerCase())
      if (!pid) {
        report.access.missing_people.push(`${s.key}: ${name}`)
        continue
      }
      const r = await sql.query(
        `insert into public.access_scope_audience (tenant_id, scope_id, principal_id, why) values ($1, $2, $3, 'imported') on conflict do nothing returning 1`,
        [tenantId, id, pid],
      )
      report.access.audience += r.rows.length
    }
  }
  await applyAccess(sql, tenantId)
  const byScope = new Map<string, { paths: string[]; note: string | null }>()
  for (const m of data.access!.file_moves) {
    const e = byScope.get(m.scope_key) ?? { paths: [], note: m.note }
    e.paths.push(m.path)
    byScope.set(m.scope_key, e)
  }
  for (const [key, { paths, note }] of byScope) {
    const scope = (await sql.query<{ id: string }>(`select id from public.access_scopes where tenant_id = $1 and key = $2`, [tenantId, key])).rows[0]
    const ids = await idsByPath(sql, tenantId, paths)
    report.access.missing_files.push(...paths.filter((p) => !ids.has(p)))
    if (!scope || !ids.size) continue
    // Only move files that aren't already there (keeps re-imports quiet).
    const todo = (
      await sql.query<{ id: string }>(`select source_object_id id from public.file_access where tenant_id = $1 and source_object_id = any($2::uuid[]) and scope_id <> $3`, [tenantId, [...ids.values()], scope.id])
    ).rows.map((r) => r.id)
    if (todo.length) {
      await moveFiles(sql, tenantId, todo, scope.id, `imported: ${note ?? ''}`.trim())
      report.access.file_moves += todo.length
    }
  }
}
