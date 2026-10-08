# Riverton, Phase 4 source profile

Profiled 2026-10-05 · profiler v3 · 273 raw objects, 196 MB, 12 sources.
Everything below comes from `public.source_inventory`. It describes the files' form (format, dates, metadata), not their meaning. Statements marked *hypothesis* are things to test in Phase 10, not facts.

Re-run with `npx tsx scripts/profile-raw.ts riverton`. To query: `select * from source_inventory where tenant_id = '81fafe8a-0148-4bcd-b07f-371cb12200a2'`.

## Inventory at a glance

| Source | Files | Content dates | Shape |
|---|---|---|---|
| SharePoint - Shared Documents (copy) | 110 | 2016 → 2027* | mostly docs/PDFs, 13 scans, 3 lock files |
| Phone uploads | 38 | 2023 → 2026 | photos/video with EXIF |
| IT exports 10-2 | 36 | 1998 → 2026 | system exports: FieldLine, CRM, M365, mail |
| Ridgeline VDR download | 29 | 2022 → 2026 | curated diligence copies |
| fileserver2 (old S drive) | 17 | 2006 → 2025 | legacy dispatch DB, QuickBooks Desktop, intranet |
| From Linda - USB | 15 | 2003 → 2026 | QuickBooks Online reports, ADP payroll |
| FDE interview recordings | 13 | Oct–Nov 2026 | audio, 102 MB |
| OneDrive exports | 8 | 2023 → 2026 | personal copies |
| Dave - OneDrive + old laptop | 4 | 2024 → 2026 | personal docs |
| handoff note, mock-api, FDE inbox | 3 | Oct 2026 | notes / screen recording |

\* Future dates are expiry or end dates mentioned in the content. Use the earliest date for "how far back".

## Answers to the Phase 4 questions

**1. Which systems exist?** Each system was identified from the exports' column layouts, preambles and email domains.
- **FieldLine** (field-service platform, current): work orders `export.csv` (22,883 jobs, 2025-01 → 2026-10), assets `export (1).csv` (4,508), locations `export (2).csv` (172), users, rates, field definitions. `fieldlineapp.com` appears in the mail.
- **QuickBooks Online** (current accounting): Linda's USB has invoice lines (55,182), payments (18,620), bills (37,507), customers, vendors, chart of accounts, AR aging and P&L, all 2024 → 2026-10-09.
- **QuickBooks Desktop** (legacy): `fileserver2/QB/*`, `QBD exports/ItemList_2011.csv`.
- **Legacy dispatch database** (pre-FieldLine): `fileserver2/dispatch db/` with WorkOrders (34,243 rows from 2008), Equipment (4,104), Customers, Techs.
- **HubSpot-style CRM**: `crm/all-companies|contacts|deals|notes|owner changes.csv`.
- **Microsoft 365 / Entra / SharePoint**: users, groups, admin roles, guests, mailbox permissions, SharePoint permissions, sharing links, 17 mailboxes (`.mbox`) and one calendar.
- **ADP payroll**: employee detail (102, hire dates back to 2003), payroll register 2024–2026, census.
- **Old intranet**: `fileserver2/intranet/*.htm` (phone list dated 2014).

**2. Which systems are legacy?** *Hypothesis:* the dispatch DB, QuickBooks Desktop, the S: drive and the intranet were replaced by FieldLine, QuickBooks Online and SharePoint. SharePoint docs say most of the S: drive moved in 2023. The dispatch DB overlaps FieldLine; the date where it hands over is to be confirmed.

**3. How far back does data go?** Content: 1998 (asset install dates), 2003 (hire dates), 2006 (price list), 2008 (first dispatch work order), 2009 (Dave's archived mail 2009–2020). The current systems hold detail from 2024–2025 onward only. Older detail lives only in the legacy piles.

**4. Which folders contain duplicates?** 11 identical contents at more than one path:
- **VDR ↔ SharePoint (6):** lease, Harmon payment plan, Kemper PM contract, handbook, safety manual, QC manual. Same bytes, different names.
- **OneDrive ↔ SharePoint:** Pricing Policy 2025 FINAL. **Linda USB ↔ SharePoint:** Credit and Collections Policy (named "2016" on the USB).
- **Within a pile:** Tom's notes (laptop image and Documents), and `IMG_4127.jpg` / `IMG_4127 (1).jpg`.

Near-duplicates and versions with different bytes (for example "v3 SIGNED scan" vs the docx) are not covered by hash matching. That's Phase 10/11.

**5. What appears corrupted?** No unreadable files. One QuickBooks export has a ragged footer row. Not corruption but needs care:
- 13 image-only PDFs, which need OCR in Phase 6.
- 3 Office lock files: Karen Liu had the 2026 comp review open, and Sarah Okafor had the 2026 pricing book and a scratch doc open, when the SharePoint copy was taken.
- 2 Windows `Thumbs.db` files.

**6. Structured vs unstructured.** Structured: 39 CSV exports plus 1 calendar, holding nearly all the volume (about 200k rows). Semi-structured: 30 spreadsheets and 17 mailboxes. Unstructured: about 110 documents, PDFs, decks and pages. Media: 52 photos, audio and video.

**7. Where are the permission boundaries?** From `IT exports/sharepoint_permissions.csv` (41 entries):
- **Folders with their own permissions (not inherited):** HR (*Highly Confidential – HR*), HR/Comp review 2026 (permissions changed 2026-07-24 by Karen Liu), Owners & Execs (*Highly Confidential – Deal*), Accounting (*Confidential – Finance*), Pricing (*Confidential*), Dave, Columbus, Louisville, Operations, Sales.
- **Personal OneDrives:** Dave Brennan's, Greg Whitfield's (archived) and Tom Jablonski's (transferred to Andrea Reyes).
- **External access:** 2 guests (Northgate, a law firm) and "Anyone with the link" sharing links.
- **Mailbox delegation and admin roles:** in their own exports.

These map directly onto `principals` / `acls`, which is Phase 10 work.

**8. Whose files seem unusually important?** From metadata, ranked by how often each person appears:
- **Dave Brennan:** most mail (130 messages, plus an archive from 2009–2020), his own folder, laptop and calendar, and the largest metadata footprint.
- **Sarah Okafor:** 150 messages, and she had the pricing book open.
- **Linda Marsh:** 108 messages, and she holds the finance and payroll exports.
- **Karen Liu:** HR, and she owns the comp-review permissions.
- **Also active:** Priya Shah, Marcus Bell, Lauren Pike.

*Hypothesis:* Dave is the key-person risk, which matters for Demo 3.

**9. What systems appear authoritative for what?** *Hypotheses to confirm:*
- FieldLine for work orders, assets and sites from 2025.
- The dispatch DB for history before that.
- QuickBooks Online for invoices, payments and terms.
- ADP for employment facts.
- Entra / SharePoint exports for identity and permissions.
- The CRM for account ownership.
- The VDR for the versions presented to buyers.
- SharePoint for working documents.

Conflicts between these are expected. The same customer appears in four systems with different IDs and names.

## Notes for later phases
- **Phase 6:** the OCR queue is the 13 image-only PDFs. Lock files and `Thumbs.db` should be skipped for extraction but kept as evidence.
- **Phase 7:** 17 mailboxes. Old domains seen: `riverton-ind.net` vs `rivertonindustrial.com`.
- **Phase 10/11:** customer and asset identifiers exist in every system (FieldLine `C-…`/`L-…`, QuickBooks IDs, dispatch `CustID`, CRM record IDs), so identifiers should drive resolution.
