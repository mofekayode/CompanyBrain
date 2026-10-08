import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, test } from 'vitest'
import { detectFormat } from '../../src/profiling/detect'
import { parseLooseDate, profileObject } from '../../src/profiling/profile'

const enc = (s: string) => new TextEncoder().encode(s)

async function docx(core: string, body: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/document.xml', `<w:document><w:body>${body}</w:body></w:document>`)
  zip.file('docProps/core.xml', core)
  zip.file('docProps/app.xml', '<Properties><Application>Microsoft Office Word</Application><Pages>3</Pages></Properties>')
  return zip.generateAsync({ type: 'uint8array' })
}

describe('format detection uses bytes, not the extension', () => {
  test('a PDF named .docx is detected as PDF and flagged', async () => {
    const pdf = await (await PDFDocument.create()).save()
    const p = await profileObject(pdf, 'contract FINAL.docx')
    expect(p.format).toBe('pdf')
    expect(p.extension_matches).toBe(false)
    expect(p.integrity.issues[0]).toMatch(/does not match/)
  })

  test('csv vs plain text', () => {
    expect(detectFormat(enc('a,b,c\n1,2,3\n4,5,6\n'), 'x.csv')).toBe('csv')
    expect(detectFormat(enc('Meeting notes\nCall Bob back.\n'), 'notes.txt')).toBe('text')
  })

  test('binary garbage is unknown, empty is empty', () => {
    expect(detectFormat(new Uint8Array([0, 1, 2, 3, 0, 9]), 'x.bin')).toBe('unknown')
    expect(detectFormat(new Uint8Array(), 'x.pdf')).toBe('empty')
  })
})

describe('profilers', () => {
  test('docx: author, editor, dates, pages, content dates', async () => {
    const bytes = await docx(
      '<cp:coreProperties><dc:title>Discount policy</dc:title><dc:creator>Pat Doe</dc:creator><cp:lastModifiedBy>Sam Roe</cp:lastModifiedBy><dcterms:created>2018-02-01T10:00:00Z</dcterms:created><dcterms:modified>2023-07-15T09:00:00Z</dcterms:modified></cp:coreProperties>',
      '<w:p><w:t>Effective March 4, 2021 approvals change.</w:t></w:p>',
    )
    const p = await profileObject(bytes, 'policy.docx')
    expect(p).toMatchObject({ format: 'docx', category: 'document', structure: 'unstructured', integrity: { ok: true } })
    expect(p.document).toMatchObject({ title: 'Discount policy', author: 'Pat Doe', last_modified_by: 'Sam Roe', pages: 3 })
    expect(p.people).toEqual(['Pat Doe', 'Sam Roe'])
    expect(p.dates).toEqual({ earliest: '2018-02-01', latest: '2023-07-15', basis: ['content', 'document_metadata'] })
  })

  test('a truncated docx is reported as unparseable', async () => {
    const bytes = (await docx('<x/>', '<w:p/>')).slice(0, 60)
    const p = await profileObject(bytes, 'broken.docx')
    expect(p.integrity.ok).toBe(false)
    expect(p.integrity.issues.join()).toMatch(/could not be parsed/)
  })

  test('pdf: pages, metadata, truncation', async () => {
    const doc = await PDFDocument.create()
    doc.addPage(); doc.addPage()
    doc.setAuthor('Ops Team'); doc.setCreationDate(new Date('2016-05-05T00:00:00Z')); doc.setModificationDate(new Date('2016-05-06T00:00:00Z'))
    const bytes = await doc.save()
    const p = await profileObject(bytes, 'manual.pdf')
    expect(p.document).toMatchObject({ pages: 2, author: 'Ops Team' })
    expect(p.dates.earliest).toBe('2016-05-05')
    const cut = await profileObject(bytes.slice(0, bytes.length - 40), 'manual.pdf')
    expect(cut.integrity.issues.join()).toMatch(/truncated/)
  })

  test('mbox: message count, date range, senders, domains, attachments', async () => {
    const mbox = [
      'From a@x Mon Jan  1 00:00:00 2019', 'From: Ann <ann@old-domain.com>', 'Date: Tue, 01 Jan 2019 10:00:00 -0500', 'Subject: hi', '', 'body',
      'From b@x Mon Jan  1 00:00:00 2019', 'From: bob@riverco.com', 'Date: Fri, 03 Mar 2023 10:00:00 -0500', 'Subject: re', 'Content-Type: multipart/mixed', '', 'Content-Disposition: attachment; filename=a.pdf',
      'From c@x Mon Jan  1 00:00:00 2019', 'From: Ann <ann@old-domain.com>', 'Date: Sat, 04 Mar 2023 10:00:00 -0500', '', 'x',
    ].join('\n')
    const p = await profileObject(enc(mbox), 'dave.mbox')
    expect(p.email).toMatchObject({
      messages: 3, first_date: '2019-01-01', last_date: '2023-03-04', with_attachments: 1,
      domains: ['old-domain.com', 'riverco.com'], top_senders: [{ sender: 'ann@old-domain.com', count: 2 }, { sender: 'bob@riverco.com', count: 1 }],
    })
  })

  test('csv: columns, rows, date columns, ragged rows', async () => {
    const csv = 'id,customer,invoice_date,amount\n1,"Acme, Inc",2021-01-05,10\n2,Beta,3/7/2024,20\n3,Gamma,2022-02-02\n'
    const p = await profileObject(enc(csv), 'invoices.csv')
    expect(p.table).toMatchObject({ columns: ['id', 'customer', 'invoice_date', 'amount'], rows: 3, date_columns: [{ column: 'invoice_date', min: '2021-01-05', max: '2024-03-07' }] })
    expect(p.integrity.issues).toEqual(['1 row(s) with a different column count than the header'])
    expect(p.structure).toBe('structured')
  })

  test('Thumbs.db is a system file, not a document', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
    expect(await profileObject(ole, 'Thumbs.db')).toMatchObject({ format: 'ole2', category: 'system_file', structure: 'system' })
  })

  test('Office lock files are system files that name who had the document open', async () => {
    const name = 'Jane Q'
    const bytes = new Uint8Array(162); bytes[0] = name.length; bytes.set(enc(name), 1)
    const p = await profileObject(bytes, '~$ice Book.xlsx')
    expect(p).toMatchObject({ format: 'office_lock', category: 'system_file', people: ['Jane Q'], integrity: { ok: true } })
    expect(p.notes?.[0]).toMatch(/Jane Q had/)
  })

  test('unrecognized content is an integrity issue', async () => {
    expect((await profileObject(new Uint8Array([0, 1, 2, 3, 0, 9]), 'data.xlsx')).integrity.issues[0]).toMatch(/unrecognized/)
  })

  test('report exports: title lines above the header become a preamble', async () => {
    const csv = '"Acme Corp"\r\nInvoice Detail\r\n"January 1, 2024 - October 9, 2026"\r\n\r\nDate,Customer,Amount\r\n01/02/2024,Beta,5\r\n02/03/2025,Gamma,7\r\n'
    const p = await profileObject(enc(csv), 'Invoices.csv')
    expect(p.table).toMatchObject({ columns: ['Date', 'Customer', 'Amount'], rows: 2, preamble: ['Acme Corp', 'Invoice Detail', 'January 1, 2024 - October 9, 2026'] })
    expect(p.dates).toMatchObject({ earliest: '2024-01-01', latest: '2026-10-09' })
  })

  test('quoted fields may contain newlines and delimiters (work-order notes)', async () => {
    const csv = 'WO #,Created,Tech Notes\nFL-1,2025-01-18,"Replaced seal.\nCustomer says ""leaks again"", see WO FL-0"\nFL-2,2025-02-01,ok\n'
    const p = await profileObject(enc(csv), 'export.csv')
    expect(p.table).toMatchObject({ columns: ['WO #', 'Created', 'Tech Notes'], rows: 2 })
    expect(p.table?.preamble).toBeUndefined()
    expect(p.integrity.ok).toBe(true)
  })

  test('delimiter is chosen by consistency, not frequency (semicolon lists inside comma CSV)', async () => {
    const csv = 'WO #,Technician(s),Hrs\nFL-1,Rice; Teller; Stroud; Whitaker,8\nFL-2,Polk,2\nFL-3,Vega; Pace,4\n'
    const p = await profileObject(enc(csv), 'export.csv')
    expect(p.table).toMatchObject({ delimiter: ',', columns: ['WO #', 'Technician(s)', 'Hrs'], rows: 3 })
    expect(p.integrity.ok).toBe(true)
  })

  test('tool placeholder timestamps are ignored, not treated as history', async () => {
    const doc = await PDFDocument.create(); doc.addPage()
    doc.setCreationDate(new Date('2000-01-01T00:00:00Z')); doc.setModificationDate(new Date('2000-01-01T00:00:00Z'))
    const p = await profileObject(await doc.save(), 'generated.pdf')
    expect(p.dates.earliest).toBeNull()
    expect(p.notes?.join()).toMatch(/placeholder/)
  })

  test('report footers and TOTAL rows are report artefacts, not integrity issues', async () => {
    for (const footer of ['"Exported Friday, October 9, 2026 10:42 AM GMT-04:00 - Accrual Basis"', 'Exported Friday, October 9, 2026 10:42 AM GMT-04:00 - Accrual Basis']) {
      const csv = `"Acme"\nInvoice Detail\n\nDate,Customer,Amount,Memo\n01/02/2024,Beta,5,x\n02/03/2025,Gamma,7,y\nTOTAL,,12,\n\n${footer}\n`
      const p = await profileObject(enc(csv), 'Invoices.csv')
      expect(p.integrity.ok).toBe(true)
      expect(p.table).toMatchObject({ rows: 3, summary_rows: 1 })
      expect(p.table?.footer?.join(', ')).toMatch(/^Exported Friday, October 9, 2026/)
      expect(p.notes?.join()).toMatch(/summary row/)
    }
  })

  test('a header-only csv is still a csv', async () => {
    expect((await profileObject(enc('id,name,date\n'), 'empty-export.csv')).table).toMatchObject({ columns: ['id', 'name', 'date'], rows: 0 })
  })

  test('zip: member listing', async () => {
    const zip = new JSZip(); zip.file('a/b.txt', 'hello'); zip.file('c.csv', 'x,y\n1,2\n')
    const p = await profileObject(await zip.generateAsync({ type: 'uint8array' }), 'export.zip')
    expect(p.archive).toEqual({ entries: 2, members: [{ name: 'a/b.txt', size: 5 }, { name: 'c.csv', size: 8 }] })
    expect(p.structure).toBe('container')
  })

  test('loose dates', () => {
    expect(parseLooseDate('2021-03-04')).toBe('2021-03-04')
    expect(parseLooseDate('3/4/21')).toBe('2021-03-04')
    expect(parseLooseDate('Sept 4, 2019')).toBe('2019-09-04')
    expect(parseLooseDate('Pump 17')).toBeNull()
    expect(parseLooseDate('1850-01-01')).toBeNull()
  })
})
