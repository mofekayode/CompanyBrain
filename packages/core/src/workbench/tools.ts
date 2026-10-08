import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { EVIDENCE_KINDS, getEmailThread, getEvidence, searchEvidence } from './evidence-search'
import { readableText } from './read-file'
import { pool, store } from './server'

export interface ToolContext {
  tenantId: string
  sessionId: string
}

interface WorkbenchTool<S extends z.ZodType> {
  definition: Anthropic.Tool
  schema: S
  /** One-line description of a call, shown in the step trace. */
  summarize: (input: z.infer<S>) => string
  /** Optional better one-liner once the result is known (e.g. the file path). */
  summarizeResult?: (input: z.infer<S>, output: unknown) => string | undefined
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>
}

function tool<S extends z.ZodType>(t: Omit<WorkbenchTool<S>, 'definition'> & { name: string; description: string }): WorkbenchTool<S> {
  return {
    ...t,
    definition: {
      name: t.name,
      description: t.description,
      input_schema: z.toJSONSchema(t.schema, { target: 'draft-7' }) as Anthropic.Tool.InputSchema,
    },
  }
}

const INVENTORY_COLUMNS = `id, source_name, original_path, format, category, structure, size_bytes, integrity_ok,
  integrity_issues, content_earliest, content_latest, duplicate_copies, document_author, likely_scanned,
  coalesce(profile -> 'table' ->> 'rows', profile -> 'email' ->> 'messages') as rows_or_messages`

export const TOOLS = [
  tool({
    name: 'list_sources',
    description: 'List the piles/systems the client handed over, with file counts, sizes, formats and content date span. Start here.',
    schema: z.object({}),
    summarize: () => 'List sources',
    run: async (_input, ctx) =>
      (
        await pool().query(
          `select source_name, source_kind, count(*)::int files, pg_size_pretty(sum(size_bytes)) size,
                  min(content_earliest) earliest, max(content_latest) latest,
                  count(*) filter (where not integrity_ok)::int issues, string_agg(distinct format, ', ') formats
           from public.source_inventory where tenant_id = $1 group by 1, 2 order by 1`,
          [ctx.tenantId],
        )
      ).rows,
  }),

  tool({
    name: 'search_inventory',
    description:
      'Find raw files in the profiled inventory. Filters combine with AND. Returns id (use it with get_file_profile/read_file/record_finding), path, format, size, content dates, integrity and duplicate info.',
    schema: z.object({
      path_contains: z.string().optional().describe('Case-insensitive substring of the original path, e.g. "permission" or "comp review"'),
      source: z.string().optional().describe('Exact source name from list_sources'),
      format: z.string().optional().describe('Detected format, e.g. csv, pdf, docx, xlsx, mbox'),
      category: z.string().optional().describe('e.g. tabular_export, document, spreadsheet, email_archive, image, audio, system_file'),
      issues_only: z.boolean().optional(),
      duplicates_only: z.boolean().optional(),
      scanned_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    summarize: (i) => `Search files${i.path_contains ? ` matching "${i.path_contains}"` : ''}${i.source ? ` in ${i.source}` : ''}${i.format ? ` (${i.format})` : ''}${i.issues_only ? ' with issues' : ''}${i.duplicates_only ? ' that are duplicates' : ''}${i.scanned_only ? ' that are scans' : ''}`,
    run: async (i, ctx) =>
      (
        await pool().query(
          `select ${INVENTORY_COLUMNS} from public.source_inventory
           where tenant_id = $1
             and ($2::text is null or original_path ilike '%' || $2 || '%')
             and ($3::text is null or source_name = $3)
             and ($4::text is null or format = $4)
             and ($5::text is null or category = $5)
             and (not $6 or not integrity_ok)
             and (not $7 or duplicate_copies > 1)
             and (not $8 or coalesce(likely_scanned, false))
           order by source_name, original_path limit $9`,
          [ctx.tenantId, i.path_contains ?? null, i.source ?? null, i.format ?? null, i.category ?? null, !!i.issues_only, !!i.duplicates_only, !!i.scanned_only, i.limit ?? 50],
        )
      ).rows,
  }),

  tool({
    name: 'query_inventory',
    description:
      'Run one read-only SQL SELECT for aggregates the other tools cannot do: grouping, counting, ranking people, duplicate pairs, thread statistics. Already scoped to this client. Tables: `source_inventory` (and `sources`/`source_objects`); after extraction also `documents` (kind, title, current_version_id), `document_versions` (source_object_id, extractor, extraction_status, page_count, metadata), `evidence` (document_version_id, kind, content, page_number, section_path, start_ms, end_ms, speaker, observed_at, locator), `email_threads` (subject, first_at, last_at, message_count, participants, linked_by, missing_messages), `email_thread_messages` (thread_id, document_id, ordinal, depth), `email_addresses` (address, domain, display_names, sent_count, received_count, first_seen_at, last_seen_at, internal, domain_status, role_mailbox, shared_mailbox, possibly_former, same_person_as, signals). For finding passages by content use search_evidence instead. source_inventory columns: source_name, source_kind, original_path, format, category, structure, size_bytes, sha256, integrity_ok, integrity_issues, content_earliest, content_latest, duplicate_copies, document_author, document_last_modified_by, likely_scanned, people (jsonb array), profile (jsonb: email.{messages,first_date,last_date,top_senders,domains}, table.{columns,rows,preamble,date_columns}, document.{application,pages,...}, notes). Max 200 rows, 5s timeout.',
    schema: z.object({ sql: z.string().describe('A single SELECT (or WITH ... SELECT) statement, no semicolons') }),
    summarize: (i) => `SQL: ${i.sql.replace(/\s+/g, ' ').slice(0, 110)}`,
    run: async (i, ctx) => {
      const sql = i.sql.trim()
      // Ignore semicolons inside string literals and comments (e.g. string_agg(x, '; ')).
      const code = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
      if (!/^(select|with)\b/i.test(sql) || code.includes(';')) throw new Error('Only a single SELECT/WITH statement without semicolons is allowed')
      const client = await pool().connect()
      try {
        await client.query('begin read only')
        await client.query(`select set_config('app.tenant_id', $1, true)`, [ctx.tenantId])
        await client.query(`set local statement_timeout = '5s'`)
        await client.query('set local role workbench_agent') // read-only: inventory and extracted content, only this tenant (RLS)
        const { rows } = await client.query(`select * from (${sql}) q limit 200`)
        return rows
      } finally {
        await client.query('rollback').catch(() => {})
        client.release()
      }
    },
  }),

  tool({
    name: 'get_file_profile',
    description: 'Full profile of one raw file: embedded metadata, table columns/preamble/date columns, email senders/domains, archive members, people, notes.',
    schema: z.object({ id: z.string().uuid() }),
    summarize: () => 'Open file profile',
    summarizeResult: (_i, out) => {
      const o = out as { source_name?: string; original_path?: string }
      return o.original_path ? `Profile ${o.source_name} / ${o.original_path}` : undefined
    },
    run: async (i, ctx) =>
      (
        await pool().query(
          `select id, source_name, original_path, format, size_bytes, source_modified_at, duplicate_copies, profile
           from public.source_inventory where tenant_id = $1 and id = $2`,
          [ctx.tenantId, i.id],
        )
      ).rows[0] ?? { error: 'no such file for this client' },
  }),

  tool({
    name: 'read_file',
    description:
      'Read the content of a raw file from S3 as text (CSV/text/HTML/RTF/DOCX/XLSX/PPTX/ICS, and mailbox headers). PDFs, scans and media have no text yet: use get_file_profile. Use offset to page through long files.',
    schema: z.object({
      id: z.string().uuid(),
      max_chars: z.number().int().min(200).max(20000).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    summarize: () => 'Read file',
    summarizeResult: (i, out) => {
      const o = out as { path?: string }
      return o.path ? `Read ${o.path}${i.offset ? ` (from char ${i.offset})` : ''}` : undefined
    },
    run: async (i, ctx) => {
      const obj = (
        await pool().query<{ s3_key: string; format: string; original_path: string }>(
          `select s3_key, format, original_path from public.source_inventory where tenant_id = $1 and id = $2`,
          [ctx.tenantId, i.id],
        )
      ).rows[0]
      if (!obj) return { error: 'no such file for this client' }
      const bytes = await (await store()).get(obj.s3_key)
      if (!bytes) return { error: 'raw object missing from S3' }
      return { path: obj.original_path, format: obj.format, ...(await readableText(bytes, obj.format, { maxChars: i.max_chars ?? 6000, offset: i.offset ?? 0 })) }
    },
  }),

  tool({
    name: 'list_questions',
    description: 'The discovery questions for this phase and the current finding (if any) for each.',
    schema: z.object({ phase: z.string().optional().describe('Roadmap phase number, e.g. "4" (default)') }),
    summarize: () => 'Review question checklist',
    run: async (i, ctx) =>
      (
        await pool().query(
          `select q.id, q.question, q.guidance, f.status, f.answer
           from public.discovery_questions q
           left join lateral (
             select status, left(answer, 300) answer from public.discovery_findings f
             where f.tenant_id = $1 and f.question_id = q.id and f.status <> 'superseded'
             order by created_at desc limit 1) f on true
           where q.phase = $2 order by q.ordinal`,
          [ctx.tenantId, normalizePhase(i.phase)],
        )
      ).rows,
  }),

  tool({
    name: 'record_finding',
    description:
      'Store your answer to one discovery question, with the raw files that support it. Replaces the previous unreviewed finding for that question. Write the answer in concise markdown with concrete counts and paths; mark interpretation as a hypothesis. Only cite file ids you actually looked at.',
    schema: z.object({
      question_id: z.string().describe('e.g. p4.systems'),
      answer: z.string().min(20),
      confidence: z.number().min(0).max(1),
      evidence: z.array(z.object({ source_object_id: z.string().uuid(), note: z.string().describe('What in this file supports the answer') })).min(1).max(25),
    }),
    summarize: (i) => `Record finding for ${i.question_id}`,
    run: async (i, ctx) => {
      const client = await pool().connect()
      try {
        await client.query('begin')
        await client.query(
          `update public.discovery_findings set status = 'superseded'
           where tenant_id = $1 and question_id = $2 and status = 'hypothesis'`,
          [ctx.tenantId, i.question_id],
        )
        const { rows } = await client.query<{ id: string }>(
          `insert into public.discovery_findings (tenant_id, question_id, answer, confidence, session_id)
           values ($1, $2, $3, $4, $5) returning id`,
          [ctx.tenantId, i.question_id, i.answer, i.confidence, ctx.sessionId],
        )
        for (const e of i.evidence) {
          await client.query(
            `insert into public.discovery_finding_evidence (tenant_id, finding_id, source_object_id, note)
             values ($1, $2, $3, $4) on conflict do nothing`,
            [ctx.tenantId, rows[0].id, e.source_object_id, e.note],
          )
        }
        await client.query('commit')
        return { finding_id: rows[0].id, status: 'hypothesis', evidence_files: i.evidence.length }
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    },
  }),

  tool({
    name: 'render_chart',
    description:
      'Show a chart to the engineer in the chat (bar, horizontal_bar, line or pie). Use it when a comparison or distribution is clearer as a picture: files per source, rows per system, records per year, mail volume per person. Only chart numbers you obtained from tools in this session. For diagrams (system landscapes, timelines, flows) write a ```mermaid code block in your reply instead.',
    schema: z
      .object({
        title: z.string().min(3).max(120),
        kind: z.enum(['bar', 'horizontal_bar', 'line', 'pie']),
        labels: z.array(z.string().max(80)).min(1).max(60),
        series: z.array(z.object({ name: z.string().max(60), values: z.array(z.number()) })).min(1).max(4),
        unit: z.string().max(30).optional().describe('e.g. "files", "rows", "MB"'),
        caption: z.string().max(300).optional().describe('One sentence on what the chart shows and where the numbers came from'),
      })
      .refine((c) => c.series.every((s) => s.values.length === c.labels.length), { message: 'every series needs one value per label' })
      .refine((c) => c.kind !== 'pie' || c.series.length === 1, { message: 'pie charts take exactly one series' }),
    summarize: (i) => `Chart: ${i.title}`,
    run: async (i) => i,
  }),

  tool({
    name: 'run_profiling',
    description:
      'Profile the raw files: read each from S3, detect its real format, check integrity, find exact duplicates, detect scans, and extract embedded dates, people, table columns and mail metadata into the inventory. Run this FIRST when files are not yet profiled (search_inventory and query_inventory return little until it has run). Takes about a minute per few hundred files. Returns what it found.',
    schema: z.object({
      reprofile_all: z.boolean().optional().describe('true = re-profile every file even if already profiled (only when asked)'),
    }),
    summarize: (i) => (i.reprofile_all ? 'Re-profile all files' : 'Profile files'),
    run: async (i, ctx) => {
      const { profilingStatus, startProfiling } = await import('./profiling-job')
      await startProfiling(ctx.tenantId, !!i.reprofile_all)
      const deadline = Date.now() + 15 * 60_000
      let status = await profilingStatus(ctx.tenantId)
      while (status.job?.status === 'running' && Date.now() < deadline) {
        if (status.worker_idle) {
          return { error: 'Profiling is queued but no ingestion worker is running. Ask the engineer to start it (npm run worker), then try again.' }
        }
        await new Promise((r) => setTimeout(r, 1500))
        status = await profilingStatus(ctx.tenantId)
      }
      const db = pool()
      const summary = (
        await db.query(
          `select count(*)::int files,
                  count(*) filter (where not integrity_ok)::int integrity_issues,
                  count(*) filter (where duplicate_copies > 1)::int files_with_exact_duplicates,
                  count(*) filter (where coalesce(likely_scanned, false))::int scanned_pdfs,
                  count(*) filter (where format = 'office_lock')::int office_lock_files,
                  min(content_earliest) earliest_content_date, max(content_latest) latest_content_date
           from public.source_inventory where tenant_id = $1`,
          [ctx.tenantId],
        )
      ).rows[0]
      const byStructure = (
        await db.query(`select coalesce(structure, 'unprofiled') structure, count(*)::int files from public.source_inventory where tenant_id = $1 group by 1 order by 2 desc`, [ctx.tenantId])
      ).rows
      return { job: status.job?.status, profiled: `${status.profiled_current}/${status.objects}`, failed_jobs: status.job?.progress.failed ?? 0, summary, by_structure: byStructure }
    },
  }),

  tool({
    name: 'run_extraction',
    description:
      'Start the extraction stage: read what is inside every profiled file (documents and tables via Docling with OCR for scans, emails split into messages with attachments, interview transcripts, video and photo readings). Runs in the background on the job queue; progress shows in the Extract card. Returns how many jobs were queued; the FDE can watch each file in the Activity tab. Use when asked to extract, or after discovery is confirmed.',
    schema: z.object({
      mode: z.enum(['remaining', 'sample']).optional().describe("'remaining' (default): every file not yet extracted. 'sample': re-extract about a dozen representative files, a cheap preview"),
    }),
    summarize: (i) => (i.mode === 'sample' ? 'Start a sample extraction' : 'Start extraction'),
    run: async (i, ctx) => {
      const { startTenantExtraction } = await import('./extraction-status')
      const r = await startTenantExtraction(ctx.tenantId, { mode: i.mode })
      const kinds = (
        await pool().query(
          `select j.job_type, count(*)::int jobs from public.ingestion_jobs j where j.parent_job_id = $1 group by 1 order by 2 desc`,
          [r.runId],
        )
      ).rows
      return { queued_jobs: r.queued, skipped_files: r.skipped, by_job_type: kinds, note: 'Runs in the background. Audio and video take longest; documents need the local Docling service.' }
    },
  }),

  tool({
    name: 'search_evidence',
    description:
      'Search what is INSIDE the files (extracted text, tables, OCR of scans, email bodies, interview transcripts, video scene readings, photo readings). Returns ranked passages, each with an exact citation: file path plus page, section, sheet rows, email date, or audio/video timestamp and speaker. Use this to answer questions about what the documents, emails and recordings say, and always quote the citation. Words are matched in English stemmed form; all words must match, falling back to any word. Filter by kind or a single file.',
    schema: z.object({
      query: z.string().min(2).describe('Words or a quoted phrase, e.g. "lockout procedure" valve, or <customer> discount'),
      kinds: z.array(z.enum(EVIDENCE_KINDS)).optional().describe('Restrict to evidence kinds, e.g. ["transcript_segment","video_segment"]'),
      file_id: z.string().uuid().optional().describe('Search inside one file only'),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    summarize: (i) => `Search evidence: ${i.query}${i.kinds?.length ? ` (${i.kinds.join(', ')})` : ''}`,
    summarizeResult: (i, out) => {
      const o = out as { total?: number; hits?: { citation: string }[] }
      return `Search “${i.query}”: ${o.total ?? 0} passages${o.hits?.[0] ? ` · top: ${o.hits[0].citation}` : ''}`
    },
    run: async (i, ctx) => {
      const r = await searchEvidence(ctx.tenantId, i.query, { kinds: i.kinds, fileId: i.file_id, limit: i.limit })
      return { ...r, hits: r.hits.map(({ locator: _l, rank: _r, ...h }) => h) }
    },
  }),

  tool({
    name: 'get_evidence',
    description: 'Read one evidence passage in full (from search_evidence), with neighbouring passages from the same document for context. Returns each passage with its citation.',
    schema: z.object({ evidence_id: z.string().uuid(), context: z.number().int().min(0).max(5).optional().describe('Passages before/after to include (default 1)') }),
    summarize: () => 'Read evidence passage',
    summarizeResult: (_i, out) => {
      const rows = out as { is_target: boolean; citation: string }[] | null
      return rows?.find((r) => r.is_target)?.citation ? `Read ${rows.find((r) => r.is_target)!.citation}` : undefined
    },
    run: async (i, ctx) => {
      const rows = await getEvidence(ctx.tenantId, i.evidence_id, i.context ?? 1)
      if (!rows) throw new Error('unknown evidence id')
      return rows.map((r) => ({ ...r, content: String(r.content).slice(0, 6000) }))
    },
  }),

  tool({
    name: 'email_thread',
    description:
      'Show a whole email conversation in order: who wrote each message, when, what it added (quoted history removed), attachments and forwarded content. Give the thread id, an email document id, or the raw file id of one message (.eml) in the thread.',
    schema: z.object({ thread_id: z.string().uuid().optional(), document_id: z.string().uuid().optional(), file_id: z.string().uuid().optional() }),
    summarize: () => 'Open email thread',
    summarizeResult: (_i, out) => {
      const o = out as { thread?: { subject?: string; message_count?: number } } | null
      return o?.thread ? `Thread “${o.thread.subject ?? '(no subject)'}” · ${o.thread.message_count} messages` : undefined
    },
    run: async (i, ctx) => {
      const r = await getEmailThread(ctx.tenantId, { threadId: i.thread_id, documentId: i.document_id, fileId: i.file_id })
      if (!r) throw new Error('no thread found (has the email index been built? it runs after extraction)')
      return r
    },
  }),
] as const

/** Accepts "4", "p4", "P4", "phase 4", "Phase 4". */
export function normalizePhase(phase: string | undefined): string {
  return (phase ?? '4').replace(/^\s*(phase|p)\s*/i, '').trim() || '4'
}

export const TOOL_DEFINITIONS: Anthropic.Tool[] = TOOLS.map((t) => t.definition)

export function findTool(name: string) {
  return TOOLS.find((t) => t.definition.name === name)
}
