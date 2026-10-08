// Ontology proposal: from what the handoff contains, propose how the business is
// structured: entity types, relationship types, and what each table is (a list
// of things, a log of events, or noise). Everything is a proposal for an FDE.

import { rulesFor, withContext } from '../config/tenant-config'
import { readTableFile } from '../access/directory'
import { structured } from '../claude'
import type { ObjectStore } from '../storage/object-store'
import type { Sql } from '../storage/raw'

export interface TypeProposal {
  name: string // singular, e.g. "Customer"
  description: string
  parent: string | null // e.g. "Asset" for "Pump"
  identifier_systems: string[] // e.g. ["FieldLine", "QuickBooks"]
  examples: string[]
}

export interface RelationshipTypeProposal {
  name: string // verb phrase, snake_case, e.g. "located_at"
  description: string
  source_type: string
  target_type: string
}

/** How one column of a table connects a row to another entity. */
export interface LinkColumn {
  column: string
  target_type: string
  relationship: string // relationship type name (from row entity / event to target)
  match: 'id' | 'name'
  system: string | null // identifier system when match = id
}

export interface TableMapping {
  file_id: string
  kind: 'entities' | 'events' | 'ignore'
  why: string
  system: string // source system, e.g. "FieldLine"
  // entities: one row per thing
  entity_type: string | null
  name_column: string | null
  id_column: string | null
  property_columns: string[]
  // events: one row per event (work order, invoice line, payment)
  event_type: string | null
  date_column: string | null
  amount_column: string | null
  event_id_column: string | null
  links: LinkColumn[]
}

export interface OntologyProposal {
  entity_types: TypeProposal[]
  relationship_types: RelationshipTypeProposal[]
  tables: TableMapping[]
  notes: string[]
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entity_types', 'relationship_types', 'tables', 'notes'],
  properties: {
    entity_types: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'parent', 'identifier_systems', 'examples'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          parent: { type: ['string', 'null'] },
          identifier_systems: { type: 'array', items: { type: 'string' } },
          examples: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    relationship_types: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'source_type', 'target_type'],
        properties: { name: { type: 'string' }, description: { type: 'string' }, source_type: { type: 'string' }, target_type: { type: 'string' } },
      },
    },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file_id', 'kind', 'why', 'system', 'entity_type', 'name_column', 'id_column', 'property_columns', 'event_type', 'date_column', 'amount_column', 'event_id_column', 'links'],
        properties: {
          file_id: { type: 'string' },
          kind: { type: 'string', enum: ['entities', 'events', 'ignore'] },
          why: { type: 'string' },
          system: { type: 'string' },
          entity_type: { type: ['string', 'null'] },
          name_column: { type: ['string', 'null'] },
          id_column: { type: ['string', 'null'] },
          property_columns: { type: 'array', items: { type: 'string' } },
          event_type: { type: ['string', 'null'] },
          date_column: { type: ['string', 'null'] },
          amount_column: { type: ['string', 'null'] },
          event_id_column: { type: ['string', 'null'] },
          links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['column', 'target_type', 'relationship', 'match', 'system'],
              properties: {
                column: { type: 'string' },
                target_type: { type: 'string' },
                relationship: { type: 'string' },
                match: { type: 'string', enum: ['id', 'name'] },
                system: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

export interface CatalogTable {
  file_id: string
  source: string
  path: string
  rows: number
  header: string[]
  sample: string[][]
}

/** Business tables in the handoff: CSV/XLSX, deduplicated, not directory/permission exports. Pay/identity columns are withheld. */
export async function tableCatalog(sql: Sql, store: ObjectStore, tenantId: string, limit = 60): Promise<CatalogTable[]> {
  const rules = await rulesFor(sql, tenantId)
  const { rows } = await sql.query<{ id: string; source: string; path: string; s3_key: string; format: string }>(
    `select so.id, s.name source, so.original_path path, so.s3_key, so.metadata -> 'profile' ->> 'format' format
     from public.source_objects so join public.sources s on s.id = so.source_id
     where so.tenant_id = $1 and so.metadata -> 'profile' ->> 'format' in ('csv', 'xlsx')
       and so.original_path !~ '/(messages|attachments)/'
       and coalesce(so.metadata -> 'directory_mapping' ->> 'role', 'none') = 'none'
       and so.original_path !~* '(permission|sharing_links|admin_roles|guest_users|access_report|activity_log|payroll|census|comp )'
       and not exists (select 1 from public.source_objects d where d.tenant_id = so.tenant_id and d.sha256 = so.sha256 and d.id < so.id)
     order by coalesce((so.metadata -> 'profile' -> 'table' ->> 'rows')::int, 0) desc
     limit $2`,
    [tenantId, limit],
  )
  const out: CatalogTable[] = []
  for (const r of rows) {
    const bytes = await store.get(r.s3_key)
    if (!bytes) continue
    const t = await readTableFile(bytes, r.format, r.id, r.path)
    const sheet = t.sheets.find((s) => s.header.filter(Boolean).length > 1 && s.rows.length > 0)
    if (!sheet) continue
    const withheld = new Set(sheet.header.map((h, i) => (rules.rx.sensitiveColumn.test(h) && !/^(rate|amount|price|total)/i.test(h) ? i : -1)).filter((i) => i >= 0))
    out.push({
      file_id: r.id,
      source: r.source,
      path: r.path,
      rows: sheet.rows.length,
      header: sheet.header,
      sample: sheet.rows.slice(0, 3).map((row) => row.map((c, i) => (withheld.has(i) ? '[withheld]' : String(c ?? '').slice(0, 50)))),
    })
  }
  return out
}

/** A cross-section of prose evidence: documents, emails, interviews, video and photo readings. */
async function proseSample(sql: Sql, tenantId: string): Promise<string> {
  const { rows } = await sql.query<{ kind: string; path: string; content: string }>(
    `select kind, path, content from (
       select e.kind, so.original_path path, left(e.content, 700) content,
              row_number() over (partition by e.kind order by md5(e.id::text)) n
       from public.evidence e
       join public.document_versions dv on dv.id = e.document_version_id
       join public.documents d on d.id = dv.document_id and d.current_version_id = dv.id
       join public.source_objects so on so.id = dv.source_object_id
       where e.tenant_id = $1 and e.kind in ('text', 'ocr', 'email_body', 'transcript_segment', 'video_segment', 'image') and length(e.content) > 200) x
     where n <= case kind when 'transcript_segment' then 14 when 'email_body' then 12 when 'text' then 12 else 4 end`,
    [tenantId],
  )
  return rows.map((r) => `[${r.kind}] ${r.path}\n${r.content.replace(/\s+/g, ' ')}`).join('\n\n')
}

export async function proposeOntology(sql: Sql, store: ObjectStore, tenantId: string): Promise<OntologyProposal> {
  const rules = await rulesFor(sql, tenantId)
  const tables = await tableCatalog(sql, store, tenantId)
  const prose = await proseSample(sql, tenantId)
  const findings = (
    await sql.query<{ question: string; answer: string }>(
      `select q.question, left(f.answer, 1500) answer from public.discovery_findings f join public.discovery_questions q on q.id = f.question_id
       where f.tenant_id = $1 and f.status = 'confirmed' order by q.ordinal`,
      [tenantId],
    )
  ).rows
  const groups = (
    await sql.query<{ name: string; type: string }>(
      `select display_name name, metadata ->> 'group_type' type from public.principals
       where tenant_id = $1 and kind = 'group' and metadata ->> 'origin' = 'company_map' and metadata ->> 'group_type' in ('department', 'location')`,
      [tenantId],
    )
  ).rows
  const tableText = tables
    .map((t) => `### file ${t.file_id}: ${t.source} / ${t.path} (${t.rows} rows)\ncolumns: ${JSON.stringify(t.header)}\nsample: ${JSON.stringify(t.sample)}`)
    .join('\n\n')

  return structured<OntologyProposal>({
    system: `You are a forward-deployed engineer modelling how an acquired company actually works, from its own data. Propose a compact, practical ontology: the real things the business deals with and how they connect. Prefer the company's own concepts and names over generic ones. People are already modelled (type "Person", with departments and branches); include "Person" and "Branch" as types and link to them.${withContext(rules)}`,
    prompt: `## What discovery established (confirmed findings)
${findings.map((f) => `- ${f.question}\n${f.answer}`).join('\n\n')}

## Departments and branches already known
${groups.map((g) => `- ${g.name} [${g.type}]`).join('\n')}

## Tables in the handoff (header + 3 sample rows; pay/identity columns withheld)
${tableText}

## A sample of documents, emails, interviews, video and photo readings
${prose}

## Output
- entity_types: 8 to 20 types (singular names). Include Person and Branch. Each with a description, parent type (or null), the systems that carry identifiers for it, and 2-4 real examples from the data.
- relationship_types: snake_case verbs between types (source_type → target_type), e.g. Site located_at Branch? No: think about how this business really works (customer has sites, assets sit at sites, work orders are performed on assets by technicians, invoices bill customers…).
- tables: one entry per table above, by file_id. kind:
  - "entities": one row per real thing (customer list, asset register, vendor list, location list, tech list). Give entity_type, name_column, id_column (the row's identifier in that system, or null), up to 8 useful property_columns, and links: columns that point to other entities (with the relationship from this row's entity to the target, whether to match the target by its id in a system or by name).
  - "events": one row per business event (work order, invoice line, payment, bill, deal, CRM note). Give event_type (e.g. "Work order"), date_column, amount_column (or null), event_id_column, and links: the columns naming the participants (customer, site, asset, technician, vendor, branch), each with target_type, relationship (from the event to the participant, e.g. "for_customer", "performed_by"), match and system.
  - "ignore": duplicates of better sources, reports/summaries, templates, chat logs, anything not a list of things or events.
  Use exact column names. When two systems describe the same things (e.g. a legacy and a current system), map both; resolution merges them later. Give each table's system (e.g. the field-service app, "Legacy dispatch DB", the accounting system, the CRM, use the names the files use).
- notes: important observations about how the business works, and doubts (e.g. which system is authoritative for what).`,
    schema: SCHEMA,
    effort: 'high',
    maxTokens: 64000,
  })
}
