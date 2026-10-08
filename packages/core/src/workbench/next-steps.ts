import { PROFILER_VERSION } from '../profiling/profile'
import { extractionStatus } from './extraction-status'
import { pool } from './server'

export type Stage = 'upload' | 'profile' | 'discover' | 'review' | 'extract' | 'access' | 'done'

export interface Suggestion {
  label: string
  prompt: string
  primary?: boolean
}

export interface WorkflowStep {
  key: 'upload' | 'profile' | 'discover' | 'extract' | 'access' | 'model' | 'knowledge' | 'search' | 'checks'
  label: string
  status: 'done' | 'current' | 'available' | 'todo' | 'later'
  detail: string
  /** Where this step is worked on, when it has its own page. */
  href?: string
}

export interface NextSteps {
  stage: Stage
  steps: WorkflowStep[]
  headline: string
  detail: string
  suggestions: Suggestion[]
}

/**
 * Works out where a client is in the discovery workflow and what to do next:
 * files → profile → answer the questions → review → summarize.
 */
export async function nextSteps(tenantId: string): Promise<NextSteps> {
  const db = pool()
  const files = (
    await db.query<{ objects: number; profiled: number }>(
      `select count(*)::int objects,
              count(*) filter (where coalesce((metadata -> 'profile' ->> 'profiler_version')::int, 0) >= $2)::int profiled
       from public.source_objects where tenant_id = $1 and deleted_at is null`,
      [tenantId, PROFILER_VERSION],
    )
  ).rows[0]
  const questions = (
    await db.query<{ id: string; question: string; status: string | null }>(
      `select q.id, q.question, f.status
       from public.discovery_questions q
       left join lateral (
         select status from public.discovery_findings f
         where f.tenant_id = $1 and f.question_id = q.id and f.status <> 'superseded'
         order by created_at desc limit 1) f on true
       where q.phase = '4' order by q.ordinal`,
      [tenantId],
    )
  ).rows

  const ext = await extractionStatus(tenantId)
  const confirmed = questions.length > 0 && questions.every((q) => q.status === 'confirmed')
  const extracted = ext.files.total > 0 && ext.remaining === 0 && ext.pending_jobs === 0
  const acc = (
    await db.query<{ scopes: number; released: number; people: number }>(
      `select (select count(*)::int from public.access_scopes where tenant_id = $1) scopes,
              (select count(*)::int from public.access_scopes where tenant_id = $1 and status = 'released') released,
              (select count(*)::int from public.principals where tenant_id = $1 and kind = 'user' and metadata ->> 'origin' = 'company_map' and not metadata ? 'stale') people`,
      [tenantId],
    )
  ).rows[0]
  const model = (
    await db.query<{ types: number; entities: number }>(
      `select (select count(*)::int from public.entity_types where tenant_id = $1 and status <> 'rejected') types,
              (select count(*)::int from public.entities where tenant_id = $1 and status in ('candidate', 'active')) entities`,
      [tenantId],
    )
  ).rows[0]
  const know = (
    await db.query<{ facts: number; to_review: number; merges: number }>(
      `select (select count(*)::int from public.facts where tenant_id = $1 and metadata ->> 'layer' = 'canonical') facts,
              (select count(*)::int from public.facts where tenant_id = $1 and metadata ->> 'layer' = 'canonical' and ((reviewed_at is null and status in ('candidate', 'unknown')) or status = 'disputed')) to_review,
              (select count(*)::int from public.relationships r join public.relationship_types rt on rt.id = r.relationship_type_id
               join public.entities a on a.id = r.source_entity_id and a.status in ('candidate', 'active') join public.entities b on b.id = r.target_entity_id and b.status in ('candidate', 'active') and b.id <> a.id
               where r.tenant_id = $1 and rt.name = 'possibly_same_as' and r.status = 'candidate') merges`,
      [tenantId],
    )
  ).rows[0]
  const checks = (
    await db.query<{ sets: number; total: number; passed: number }>(
      `select count(*)::int sets, coalesce(sum((r.summary ->> 'total')::int), 0)::int total, coalesce(sum((r.summary ->> 'passed')::int), 0)::int passed
       from public.eval_sets s left join lateral (select summary from public.eval_runs where set_id = s.id and target = 'data' and finished_at is not null order by started_at desc limit 1) r on true
       where s.tenant_id = $1`,
      [tenantId],
    )
  ).rows[0]
  const idx = (
    await db.query<{ docs: number; pending: number }>(
      `select (select count(*)::int from public.search_documents where tenant_id = $1) docs,
              (select count(*)::int from public.search_outbox where tenant_id = $1 and processed_at is null) pending`,
      [tenantId],
    )
  ).rows[0]
  const steps: WorkflowStep[] = [
    { key: 'upload', label: 'Upload', status: files.objects > 0 ? 'done' : 'current', detail: `${files.objects} files` },
    { key: 'profile', label: 'Profile', status: files.objects === 0 ? 'todo' : files.profiled >= files.objects ? 'done' : 'current', detail: `${files.profiled}/${files.objects} profiled` },
    {
      key: 'discover',
      label: 'Discover',
      status: confirmed ? 'done' : files.objects > 0 && files.profiled >= files.objects ? 'current' : 'todo',
      detail: `${questions.filter((q) => q.status === 'confirmed').length}/${questions.length} confirmed`,
    },
    {
      key: 'extract',
      label: 'Extract',
      status: extracted ? 'done' : ext.pending_jobs > 0 || confirmed ? 'current' : files.profiled > 0 ? 'available' : 'todo',
      detail: ext.pending_jobs > 0 ? `${ext.pending_jobs} jobs running` : `${ext.files.total - ext.remaining}/${ext.files.total} files`,
    },
    {
      key: 'access',
      label: 'People & access',
      status: acc.scopes > 0 && acc.released > 0 ? 'done' : acc.scopes > 0 ? 'current' : extracted ? 'current' : files.profiled > 0 ? 'available' : 'todo',
      detail: acc.scopes ? `${acc.people} people · ${acc.released}/${acc.scopes} scopes released` : 'company map + scopes',
      href: 'access',
    },
    {
      key: 'model',
      label: 'Company model',
      status: model.entities > 0 ? 'done' : acc.scopes > 0 ? 'available' : 'todo',
      detail: model.entities > 0 ? `${model.types} types · ${model.entities.toLocaleString()} entities` : 'ontology + knowledge graph',
      href: 'model',
    },
    {
      key: 'knowledge',
      label: 'Knowledge review',
      status: know.facts > 0 && know.to_review + know.merges === 0 ? 'done' : know.facts > 0 ? 'current' : model.entities > 0 ? 'available' : 'todo',
      detail: know.facts > 0 ? `${know.to_review + know.merges} to review` : 'facts, conflicts, merges',
      href: 'knowledge',
    },
    {
      key: 'search',
      label: 'Search',
      status: idx.docs > 0 ? (idx.pending > 0 ? 'current' : 'done') : know.facts > 0 ? 'available' : 'todo',
      detail: idx.docs > 0 ? `${idx.docs.toLocaleString()} indexed${idx.pending ? ` · ${idx.pending} pending` : ''}` : 'Elasticsearch projection',
      href: 'search',
    },
    {
      key: 'checks',
      label: 'Checks',
      status: checks.total > 0 && checks.passed === checks.total ? 'done' : checks.sets > 0 ? 'current' : know.facts > 0 ? 'available' : 'todo',
      detail: checks.total > 0 ? `${checks.passed}/${checks.total} data checks pass` : checks.sets > 0 ? 'not run yet' : 'evidence-derived evals',
      href: 'checks',
    },
  ]
  const result = (r: Omit<NextSteps, 'steps'>): NextSteps => ({ ...r, steps })

  if (files.objects === 0) {
    return result({
      stage: 'upload',
      headline: 'No files yet',
      detail: 'Once the client’s handoff is uploaded, the agent can profile it.',
      suggestions: [],
    })
  }

  const unprofiled = files.objects - files.profiled
  if (unprofiled > 0) {
    return result({
      stage: 'profile',
      headline: `${unprofiled} of ${files.objects} files not profiled yet`,
      detail: 'Profiling reads every raw file and finds formats, duplicates, integrity issues, scans, dates and people. Discovery works on top of it.',
      suggestions: [
        { label: `Profile the ${unprofiled} files and tell me what you find`, prompt: `Profile the ${unprofiled} unprofiled files, then give me a short overview of what the client handed over: piles, formats, duplicates, integrity issues and scans. Include a chart.`, primary: true },
        { label: 'What did the client hand over?', prompt: 'Before profiling, list the piles the client handed over and what each one appears to be, from the source names and the handoff notes.' },
      ],
    })
  }

  const open = questions.filter((q) => !q.status)
  const rejected = questions.filter((q) => q.status === 'rejected')
  const toReview = questions.filter((q) => q.status === 'hypothesis')

  if (open.length > 0 || rejected.length > 0) {
    const pending = [...open, ...rejected]
    return result({
      stage: 'discover',
      headline: `${pending.length} discovery question${pending.length === 1 ? '' : 's'} to answer`,
      detail: 'Files are profiled. Next: answer the discovery questions with evidence.',
      suggestions: [
        {
          label: pending.length === questions.length ? `Work through all ${questions.length} discovery questions` : `Work through the ${pending.length} remaining discovery questions`,
          prompt: `Work through these discovery questions and record a finding for each: ${pending.map((q) => `${q.id} (${q.question})`).join('; ')}.`,
          primary: true,
        },
        ...rejected.slice(0, 2).map((q) => ({ label: `Re-investigate: ${q.question}`, prompt: `My review rejected the finding for ${q.id}: "${q.question}". Re-investigate it from the evidence and record a corrected finding.` })),
        ...open.slice(0, 2).map((q) => ({ label: q.question, prompt: `Investigate question ${q.id}: "${q.question}". Look at the evidence, then record a finding.` })),
        { label: 'Chart files and rows per source', prompt: 'Chart how many files and rows each source holds.' },
      ].slice(0, 4),
    })
  }

  if (toReview.length > 0) {
    return result({
      stage: 'review',
      headline: `${toReview.length} finding${toReview.length === 1 ? '' : 's'} awaiting your review`,
      detail: 'Every question has an answer. Review each finding in the panel on the right and confirm or reject it.',
      suggestions: [
        {
          label: `Double-check the ${toReview.length} findings before I review them`,
          prompt: `Double-check the findings awaiting review (${toReview.map((q) => q.id).join(', ')}). Re-verify every number, date and path against the inventory and files. Where something is wrong or unsupported, record a corrected finding and tell me what changed.`,
          primary: true,
        },
        { label: 'Summarize what we learned and what is still unknown', prompt: 'Summarize what discovery has established so far, what is still a hypothesis, and what is unknown. Keep it short.' },
        { label: 'Which risks should we flag to the client now?', prompt: 'From the findings, which security, access or transition risks should we flag to the client now? Cite the evidence.' },
      ],
    })
  }

  if (!extracted) {
    const remaining = ext.remaining
    return result({
      stage: 'extract',
      headline: ext.pending_jobs > 0 ? `Extracting content · ${ext.pending_jobs} jobs running` : `Extract the content of ${remaining} file${remaining === 1 ? '' : 's'}`,
      detail: 'Discovery is confirmed. Next: read what is inside the files: document text and tables, OCR for scans, email messages and attachments, interview transcripts, video and photo readings.',
      suggestions:
        ext.pending_jobs > 0
          ? [{ label: 'How is extraction going?', prompt: 'How is the extraction going? Summarize what has been extracted so far by kind, and anything that failed.' }]
          : [
              { label: `Extract the content of ${remaining} files`, prompt: `Start the extraction stage for this client (run_extraction), then tell me what will be extracted and roughly how long it takes.`, primary: true },
              { label: 'What can’t we read yet?', prompt: 'Which files still have unreadable content (PDF text, scans, audio, video) and which of them matter most for what we still need to learn?' },
            ],
    })
  }

  if (acc.scopes === 0 || acc.released === 0) {
    return result({
      stage: 'access',
      headline: acc.scopes === 0 ? 'Organize people and access' : `Review ${acc.scopes} access scopes, then release them`,
      detail:
        acc.scopes === 0
          ? 'Next: build the company map from the directory exports and propose who should see what (sensitivity + scopes). Everything stays held until an admin releases it. Open People & access.'
          : 'Scopes are proposed and held: nobody but admins can see the files yet. Review them in People & access, check the risks the AI did not copy, and release scopes as the client admin.',
      suggestions: [],
    })
  }

  return result({
    stage: 'done',
    headline: 'Discovery confirmed and content extracted',
    detail: 'Every file has been read. Ask about what the documents, emails and interviews say, or write up the internal summary.',
    suggestions: [
      { label: 'Where do the documents and interviews disagree?', prompt: 'Search the extracted documents, emails and interview transcripts for the topics our discovery findings flagged (pricing, safety procedures, systems, key people). Where do the sources disagree or show something has changed over time? Cite each side with exact page, email date or timestamp.', primary: true },
      { label: 'What do the email threads tell us?', prompt: 'Using the email index: which conversations are the longest or most important, who are the internal people and shared mailboxes, which domains are old, and who might have left? Treat the address signals as leads and cite threads.' },
      { label: 'What is only visible in photos and video?', prompt: 'What information appears only in photos and video (equipment tags, whiteboards, posted procedures, demonstrations) and not in any document? Cite file and timestamp.' },
      { label: 'Write the internal discovery summary', prompt: 'Write an internal discovery summary for the FDE team from the confirmed findings and the extracted content: systems, history, data quality, permission risks, key people, open questions and recommended next steps. Cite files with page or timestamp. This is internal working material, not a client deliverable.' },
    ],
  })
}
