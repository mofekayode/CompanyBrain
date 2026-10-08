---
name: profile-client-sources
description: Phase 4 of the Company Brain roadmap, profile a client's landed raw evidence (format, integrity, embedded dates/people, duplicates, permission exports) into the searchable source_inventory and write the Phase 4 source-profile report. Use after a client's corpus has been landed (land-client-corpus), when asked to "profile", "inventory", "do discovery / data profiling" or "do Phase 4" for a tenant.
---

# Profile client sources (Phase 4)

Goal (task.md): *a searchable inventory of the raw mess without yet pretending to understand the company.* Describe the files' form, not their meaning. Anything about meaning is labeled *hypothesis* and left for Phase 10.

## Inputs you need
- Tenant slug, with its corpus already landed (`source_objects` rows exist, status `landed` or `profiled`).
- AWS profile `companybrain` (account 787137578043). Never use the default AWS profile (see memory `aws-account-boundary`).
- DB access: `.env` holds `DATABASE_PASSWORD`, and `packages/core/src/db.ts` reads only that key. Check it with `npm run db:check`.

## Reusable code (don't rewrite it)
| What | Where |
|---|---|
| Format detection from bytes | `packages/core/src/profiling/detect.ts` |
| Profiler (one function per format) | `packages/core/src/profiling/profile.ts` (`profileObject`, `PROFILER_VERSION`) |
| Run over a tenant, reading from S3 | `npm run profile -- <slug>` (`packages/core/scripts/profile-raw.ts`) |
| Dry run on local folders, no DB or S3 | `npm run profile:local -- <dir> [<dir>...] --odd` |
| Inventory view (RLS-aware) + path trigram index | migration `20261005000004_source_inventory.sql` |
| Review queries for the 10 questions | `references/inventory-review.sql` |
| Report shape | `references/report-template.md`; the Riverton example is `docs/tenants/riverton/phase-4-source-profile.md` |

## Steps

1. **Dry run locally, if the files are on disk.** Run `npm run profile:local -- <dirs> --odd`. Expect `crashed 0`. Every `ODD` line is either a real finding or a profiler gap.
2. **Profile from S3.** Run `npm run profile -- <slug>`. It only re-profiles objects older than the current `PROFILER_VERSION`, so it's safe to rerun.
3. **Review the inventory.** Run each query in `references/inventory-review.sql`, using the Supabase MCP `execute_sql` or the service pool. Look hard at anything that seems too clean or too dramatic. A suspicious number is usually a profiler gap, not a fact about the company.
4. **Fix profiler gaps in the shared code, never in a one-off script.** For each gap:
   - add a unit test in `tests/profiling/profile.test.ts` that reproduces it with a synthetic fixture (never commit client data)
   - fix `profile.ts` / `detect.ts`
   - bump `PROFILER_VERSION`
   - run `npm test`, then `npm run profile -- <slug>`
   - repeat from step 3
5. **Read the permission exports.** Query Q7 finds them. Summarize folders with their own permissions, sensitivity labels, personal drives, guests, "anyone" links and mailbox delegation. Record them as boundaries; don't create ACLs yet (Phase 10).
6. **Write the report** at `docs/tenants/<slug>/phase-4-source-profile.md`, following `references/report-template.md`. Answer all 10 questions, cite file paths and counts, and mark interpretations as *hypothesis*.
7. **Tick Phase 4 in task.md** and update the `company-brain-phase-status` memory.

## Patterns already handled (each one bit us on Riverton)
- **The extension lies.** Detection runs on bytes. A mismatch is an integrity issue, and `unknown` content is always flagged.
- **Office lock files `~$name.docx` (162 bytes).** The first byte is a length, followed by the user's name. They are evidence of who had which document open when the copy was taken. Keep them as `system_file`; don't extract them.
- **Windows `Thumbs.db`** is an OLE2 thumbnail cache, a `system_file`.
- **Report exports (QuickBooks and similar)** put title lines above the header: company name, report name, date range. These become `table.preamble`, which tells you which system produced the file and what period it covers.
- **Report footers and TOTAL rows** (QuickBooks: `TOTAL,,…,39,423,059.01` then `"Exported Friday, … - Accrual Basis"`) go into `table.footer` and `table.summary_rows`. They are not integrity issues. Flagging the footer as a "broken row" once led the agent to invent a cause. Loaders must skip summary rows.
- **Quoted newlines in CSV fields** (technician notes) need a real RFC 4180 parser (`parseDelimited`). Splitting on lines produced thousands of fake "ragged rows".
- **Delimiter choice.** Pick the delimiter that gives a *consistent* column count, not the most frequent character. Lists like `Rice; Teller; Stroud` inside comma CSVs fooled the frequency approach.
- **Placeholder timestamps** (`2000-01-01T00:00:00` from PDF generators, 1980 from zip, 1601 from Windows/ICS) are ignored and noted. Otherwise "how far back" lies.
- **Future dates in content** are expiries and end dates. Use the earliest date for "how far back".
- **Likely-scanned PDFs** (fonts absent, images present) are the Phase 6 OCR queue.

## When something new shows up
Add a detector or profiler branch with a test. If the new pattern teaches something general, add one line to the list above. Client-specific conclusions belong in that client's report, not in this skill.

## Done when
- Every object has `profiler_version = PROFILER_VERSION` (`select count(*) from source_inventory where tenant_id = … and profiler_version < N` returns 0).
- Each remaining integrity issue is explained in the report.
- The report answers all 10 questions with evidence.
