import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { chunkBlocks, textToBlocks } from '../../src/extraction/chunk'
import { extractTable, extractText } from '../../src/extraction/extract-basic'
import { extractEmail, splitMbox, stripQuoted } from '../../src/extraction/extract-email'
import { segmentWords } from '../../src/extraction/extract-media'
import { EXTRACTION_HANDLERS, routeFor, startExtraction } from '../../src/jobs/extraction'
import { claim, complete, fail, NotReadyError } from '../../src/jobs/queue'
import { profileObject } from '../../src/profiling/profile'
import { MemoryObjectStore } from '../../src/storage/object-store'
import { landRawObject } from '../../src/storage/raw'
import { createDb, one } from '../db/harness'

const enc = (s: string) => new TextEncoder().encode(s)

const EML = (id: string, inReplyTo: string | null, body: string, attach = false) =>
  [
    'From: Linda Marsh <linda@acme.com>',
    'To: Dave <dave@acme.com>',
    'Subject: Re: Kemper pricing',
    'Date: Tue, 04 Mar 2025 10:00:00 -0500',
    `Message-ID: <${id}>`,
    inReplyTo ? `In-Reply-To: <${inReplyTo}>\nReferences: <${inReplyTo}>` : null,
    'MIME-Version: 1.0',
    attach ? 'Content-Type: multipart/mixed; boundary="b1"' : 'Content-Type: text/plain',
    '',
    attach ? `--b1\nContent-Type: text/plain\n\n${body}\n--b1\nContent-Type: text/csv; name="rates.csv"\nContent-Disposition: attachment; filename="rates.csv"\n\nbranch,rate\nOakley,125\n--b1--` : body,
  ]
    .filter((l) => l !== null)
    .join('\n')

describe('chunking', () => {
  test('chunks respect headings and carry the section path', () => {
    const units = chunkBlocks(textToBlocks('# Policy\n\nIntro para.\n\n## Discounts\n\nOver 10% needs Dave.\n\n## Rates\n\nOakley is 125.'))
    expect(units.map((u) => u.sectionPath)).toEqual([['Policy'], ['Policy', 'Discounts'], ['Policy', 'Rates']])
    expect(units[1].content).toContain('Over 10% needs Dave.')
  })
})

describe('basic extractors', () => {
  test('tables: header repeated per chunk, report footer and title excluded', async () => {
    const rows = Array.from({ length: 85 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, '0')},Cust ${i},${i}`).join('\n')
    const csv = `"Acme"\nInvoice Detail\n\nDate,Customer,Amount\n${rows}\nTOTAL,,999\n\n"Exported Friday, October 9, 2026 - Accrual Basis"\n`
    const r = await extractTable(enc(csv), 'csv', 'inv.csv')
    expect(r.units).toHaveLength(3) // 86 data rows incl. TOTAL / 40 per chunk
    expect(r.units.every((u) => u.content.startsWith('Date | Customer | Amount'))).toBe(true)
    expect(r.units.some((u) => u.content.includes('Exported'))).toBe(false)
    expect(r.units.at(-1)!.metadata).toEqual({ contains_summary_row: true })
    expect(r.units[1].locator).toEqual({ sheet: 'CSV', row_start: 41, row_end: 80 })
  })

  test('text: html is cleaned and chunked', async () => {
    const r = await extractText(enc('<html><body><h1>Phone list</h1><p>Dispatch: 555-0100</p><script>x()</script></body></html>'), 'html', 'phone.htm')
    expect(r.units[0].content).toContain('Dispatch: 555-0100')
    expect(r.units[0].content).not.toContain('x()')
  })
})

describe('email', () => {
  test('mbox splits into messages (mboxrd escaping undone)', () => {
    const mbox = `From a@x Mon Jan  1 00:00:00 2025\n${EML('1@x', null, 'Hello\n>From the desk')}\nFrom b@x Mon Jan  1 00:00:00 2025\n${EML('2@x', '1@x', 'Reply')}\n`
    const parts = splitMbox(enc(mbox))
    expect(parts).toHaveLength(2)
    expect(new TextDecoder().decode(parts[0])).toContain('\nFrom the desk')
  })

  test('quoted history is removed from evidence but kept in the artifact', async () => {
    const body = 'Agreed, keep Kemper at 8%.\n\nOn Mon, Mar 3, 2025 at 9:00 AM Dave <dave@acme.com> wrote:\n> leave Kemper alone on price\n> I will explain'
    expect(stripQuoted(body).fresh).toBe('Agreed, keep Kemper at 8%.')
    const { result } = await extractEmail(enc(EML('2@x', '1@x', body)), 'm.eml')
    expect(result.units[0].content).toContain('Agreed, keep Kemper at 8%.')
    expect(result.units[0].content).not.toContain('leave Kemper alone')
    expect(result.metadata).toMatchObject({ message_id: '2@x', in_reply_to: '1@x', thread_key: '1@x', subject: 'Re: Kemper pricing' })
    expect(result.units[0].observedAt?.toISOString()).toBe('2025-03-04T15:00:00.000Z')
  })

  test('forwarded content is kept as its own evidence with the original header', () => {
    const body = 'FYI see below.\n\n---------- Forwarded message ---------\nFrom: Linda <linda@rivertonsupply.com>\nDate: Tue, Feb 4, 2025\nSubject: AR export\n\nThe Q4 AR export is on the USB.'
    const split = stripQuoted(body, 'Fwd: AR export')
    expect(split.fresh).toBe('FYI see below.')
    expect(split.quoted).toBe(false)
    expect(split.forwarded).toEqual({ header: { from: 'Linda <linda@rivertonsupply.com>', date: 'Tue, Feb 4, 2025', subject: 'AR export' }, text: 'The Q4 AR export is on the USB.' })
  })

  test('an Original Message block under a FW: subject counts as forwarded, under RE: as quoted', () => {
    const body = 'Passing this on.\n\n-----Original Message-----\nFrom: Dave\nSent: Monday\nTo: Ops\n\nPump 7 seal is leaking.'
    expect(stripQuoted(body, 'FW: pump').forwarded?.text).toBe('Pump 7 seal is leaking.')
    const reply = stripQuoted(body, 'RE: pump')
    expect(reply.forwarded).toBeNull()
    expect(reply.quoted).toBe(true)
  })
})

describe('speech segmentation', () => {
  test('splits on speaker change and long pauses, labels speakers from 1', () => {
    const w = (text: string, start: number, end: number, speaker: string) => [
      { text, type: 'word' as const, start, end, speaker_id: speaker },
      { text: ' ', type: 'spacing' as const, start: end, end, speaker_id: speaker },
    ]
    const segs = segmentWords([...w('Pump', 0, 0.4, 'speaker_0'), ...w('seventeen', 0.5, 1, 'speaker_0'), ...w('Yes.', 1.2, 1.5, 'speaker_1'), ...w('Later', 5, 5.5, 'speaker_1')])
    expect(segs.map((s) => [s.speaker, s.text, s.startMs])).toEqual([
      ['Speaker 1', 'Pump seventeen', 0],
      ['Speaker 2', 'Yes.', 1200],
      ['Speaker 2', 'Later', 5000],
    ])
  })
})

describe('routing', () => {
  test('each format goes to the right extractor; system files are skipped', () => {
    expect(routeFor({ format: 'pdf', category: 'document' })?.jobType).toBe('extract_document')
    expect(routeFor({ format: 'mp4', category: 'audio' })?.jobType).toBe('transcribe_audio')
    expect(routeFor({ format: 'quicktime', category: 'video' })?.jobType).toBe('analyze_video')
    expect(routeFor({ format: 'mbox', category: 'email_archive' })?.jobType).toBe('unpack_mailbox')
    expect(routeFor({ format: 'office_lock', category: 'system_file' })).toBeNull()
  })
})

describe('extraction stage end to end (no external services)', () => {
  let db: PGlite
  let tenantId: string
  const store = new MemoryObjectStore('t')

  beforeAll(async () => {
    db = await createDb()
    tenantId = (await one<{ id: string }>(db, `select public.create_tenant('acme', 'Acme', null) as id`)).id
    const src = (await one<{ id: string }>(db, `insert into sources (tenant_id, kind, name, config) values ($1, 'upload', 'IT', '{"slug":"it"}') returning id`, [tenantId])).id
    const files: [string, string][] = [
      ['mail/linda.mbox', `From a@x Mon Jan  1 00:00:00 2025\n${EML('1@x', null, 'Original note')}\nFrom b@x Mon Jan  1 00:00:00 2025\n${EML('2@x', '1@x', 'See attached rates.', true)}\n`],
      ['notes/a.txt', '# Notes\n\nKyle edits the rates table.'],
      ['notes/copy of a.txt', '# Notes\n\nKyle edits the rates table.'],
      ['Thumbs.db', '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1rest'],
    ]
    for (const [path, content] of files) {
      const bytes = path === 'Thumbs.db' ? new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2]) : enc(content)
      const landed = await landRawObject({ tenantId, source: { id: src, slug: 'it' }, batch: 'b1', originalPath: path, bytes }, { store, sql: db })
      const profile = await profileObject(bytes, path.split('/').pop()!)
      await db.query(`update source_objects set metadata = jsonb_set(metadata, '{profile}', $2::jsonb), status = 'profiled' where id = $1`, [landed.id, JSON.stringify(profile)])
    }
  })

  test('runs mailbox → messages → attachment, text, duplicate and skip, writing evidence', async () => {
    const started = await startExtraction(db, tenantId)
    expect(started).toMatchObject({ queued: 4, skipped: 1 }) // mbox, a.txt, copy of a.txt, email index; Thumbs.db skipped
    let waited = 0
    for (let i = 0; i < 10; i++) {
      const jobs = await claim(db, 'w', 20, Object.keys(EXTRACTION_HANDLERS))
      if (!jobs.length) break
      for (const j of jobs) {
        try {
          await complete(db, j, await EXTRACTION_HANDLERS[j.job_type](j, { sql: db, store }))
        } catch (e) {
          // The email index waits for the mailbox's messages; make it claimable again right away.
          if (!(e instanceof NotReadyError)) throw e
          waited++
          await fail(db, j, e)
          await db.query(`update ingestion_jobs set run_after = now() where id = $1`, [j.id])
        }
      }
    }
    expect(waited).toBeGreaterThan(0)
    const docs = await db.query<{ path: string; kind: string; status: string; evidence: number; dup: string | null }>(
      `select so.original_path path, d.kind, dv.extraction_status status, (select count(*)::int from evidence e where e.document_version_id = dv.id) evidence,
              dv.metadata ->> 'same_content_as' dup
       from document_versions dv join documents d on d.id = dv.document_id join source_objects so on so.id = dv.source_object_id
       where dv.tenant_id = $1 order by so.original_path`,
      [tenantId],
    )
    const byPath = Object.fromEntries(docs.rows.map((r) => [r.path, r]))
    expect(byPath['mail/linda.mbox/messages/00001.eml']).toMatchObject({ kind: 'email', status: 'succeeded', evidence: 1 })
    expect(byPath['mail/linda.mbox/messages/00002.eml/attachments/rates.csv']).toMatchObject({ kind: 'spreadsheet', status: 'succeeded', evidence: 1 })
    expect(byPath['notes/a.txt']).toMatchObject({ status: 'succeeded', evidence: 1 })
    expect(byPath['notes/copy of a.txt'].dup).toBeTruthy() // extracted once
    expect(byPath['notes/copy of a.txt'].evidence).toBe(0)
    expect(byPath['Thumbs.db'].status).toBe('skipped')
    const run = await one<{ status: string }>(db, `select status from ingestion_jobs where job_type = 'run' and tenant_id = $1`, [tenantId])
    expect(run.status).toBe('succeeded')
    // The two messages form one thread (00002 replies to 00001); both addresses are indexed.
    const threads = await db.query<{ message_count: number; linked_by: string }>(`select message_count, linked_by from email_threads where tenant_id = $1`, [tenantId])
    expect(threads.rows).toEqual([{ message_count: 2, linked_by: 'headers' }])
    expect((await one<{ n: number }>(db, `select count(*)::int n from email_addresses where tenant_id = $1`, [tenantId])).n).toBeGreaterThan(0)
    // Processed artifacts written outside raw/.
    expect([...store.objects.keys()].some((k) => k.includes('/processed/email/'))).toBe(true)
  })

  test('a forced run on chosen files extracts them again as a new version; others are untouched', async () => {
    const a = await one<{ id: string }>(db, `select id from source_objects where tenant_id = $1 and original_path = 'notes/a.txt'`, [tenantId])
    const before = await one<{ n: number }>(db, `select count(*)::int n from document_versions where tenant_id = $1`, [tenantId])
    const started = await startExtraction(db, tenantId, { objectIds: [a.id], force: true, label: 'test' })
    expect(started.queued).toBe(1)
    const jobs = await claim(db, 'w', 10, Object.keys(EXTRACTION_HANDLERS))
    expect(jobs).toHaveLength(1)
    const out = (await EXTRACTION_HANDLERS[jobs[0].job_type](jobs[0], { sql: db, store })) as { evidence?: number; already?: boolean }
    await complete(db, jobs[0], out)
    expect(out.already).toBeUndefined()
    expect(out.evidence).toBe(1)
    const after = await one<{ n: number }>(db, `select count(*)::int n from document_versions where tenant_id = $1`, [tenantId])
    expect(after.n).toBe(before.n + 1)
    // Without force, the same file is already done.
    expect((await startExtraction(db, tenantId, { objectIds: [a.id] })).queued).toBe(0)
  })
})
