// Dev tool: live check of every extractor on a handful of real files, in a
// separate test client (archived afterwards). Runs jobs inline, no worker.
//
// Usage: npx tsx scripts/extract-sample.ts

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { companyBrainStore } from '../src/aws'
import { createServicePool } from '../src/db'
import { EXTRACTION_HANDLERS, startExtraction } from '../src/jobs/extraction'
import { claim, complete, fail } from '../src/jobs/queue'
import { profileObject } from '../src/profiling/profile'
import { landRawObject } from '../src/storage/raw'

const ROOT = join(import.meta.dirname, '../../../riverton-data')
const SP = 'company-as-found/SharePoint - Shared Documents (copy)'
const FILES = [
  `${SP}/Safety/Safety Program Manual Rev C 2025.pdf`, // text PDF with tables
  `${SP}/Pricing/Pricing Policy v3 SIGNED scan.pdf`, // scan → OCR
  `${SP}/Dave/transition list.docx`,
  `${SP}/random/untitled.pptx`,
  'company-as-found/From Linda - USB/AR_Aging_Summary_2026-09-30.xlsx',
  'company-as-found/IT exports 10-2/rates.csv',
  'company-as-found/IT exports 10-2/mail/louisville.mbox', // 6 messages
  'company-as-found/Phone uploads/IMG_4490.jpg',
  'fde-captures/inbox/Screen Recording 2026-10-19 at 2.14.07 PM.mov',
  'fde-captures/audio/New Recording 16.m4a', // ~6 min interview
]

async function main() {
  const store = await companyBrainStore()
  const sql = createServicePool(4)
  try {
    const slug = 'extraction-live-check'
    let tenantId = (await sql.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0]?.id
    tenantId ??= (await sql.query<{ id: string }>(`select public.create_tenant($1, 'Extraction live check (temp)', null) as id`, [slug])).rows[0].id
    const src = (
      await sql.query<{ id: string }>(
        `insert into public.sources (tenant_id, kind, name, config) values ($1, 'upload', 'Sample', '{"slug":"sample"}')
         on conflict (tenant_id, name) do update set name = excluded.name returning id`,
        [tenantId],
      )
    ).rows[0].id

    for (const rel of FILES) {
      const bytes = new Uint8Array(await readFile(join(ROOT, rel)))
      const landed = await landRawObject({ tenantId, source: { id: src, slug: 'sample' }, batch: 'live-check', originalPath: basename(rel), bytes }, { store, sql })
      const profile = { ...(await profileObject(bytes, basename(rel))), profiled_at: new Date().toISOString() }
      await sql.query(`update public.source_objects set metadata = jsonb_set(metadata, '{profile}', $2::jsonb), status = 'profiled' where id = $1`, [landed.id, JSON.stringify(profile)])
    }

    const run = await startExtraction(sql, tenantId)
    console.log(`queued ${run.queued}, skipped ${run.skipped}`)
    for (let round = 0; round < 10; round++) {
      const jobs = await claim(sql, 'live-check', 50, Object.keys(EXTRACTION_HANDLERS))
      if (!jobs.length) break
      await Promise.all(
        jobs.map(async (j) => {
          const t = Date.now()
          try {
            const out = await EXTRACTION_HANDLERS[j.job_type](j, { sql, store })
            await complete(sql, j, out)
            console.log(`✓ ${j.job_type.padEnd(17)} ${((Date.now() - t) / 1000).toFixed(1).padStart(6)}s ${JSON.stringify(out)}`)
          } catch (e) {
            await fail(sql, { ...j, max_attempts: 1 }, e)
            console.log(`✗ ${j.job_type.padEnd(17)} ${(e as Error).message.slice(0, 200)}`)
          }
        }),
      )
    }

    const { rows } = await sql.query<{ path: string; kind: string; status: string; evidence: number; sample: string | null; loc: string | null }>(
      `select so.original_path path, d.kind, dv.extraction_status status, count(e.id)::int evidence,
              (array_agg(left(e.content, 160) order by e.ordinal))[1] sample,
              (array_agg(concat_ws(' ', 'page=' || e.page_number, 'start_ms=' || e.start_ms, 'section=' || array_to_string(e.section_path, '>')) order by e.ordinal))[1] loc
       from public.document_versions dv join public.documents d on d.id = dv.document_id
       join public.source_objects so on so.id = dv.source_object_id
       left join public.evidence e on e.document_version_id = dv.id
       where dv.tenant_id = $1 group by 1, 2, 3 order by 1`,
      [tenantId],
    )
    console.log('\n--- results')
    for (const r of rows) console.log(`${r.status.padEnd(9)} ${r.kind.padEnd(12)} ${String(r.evidence).padStart(3)} ev  ${r.path}\n            ${r.loc ?? ''} | ${(r.sample ?? '').replace(/\s+/g, ' ')}`)
  } finally {
    await sql.end()
  }
}

await main()
