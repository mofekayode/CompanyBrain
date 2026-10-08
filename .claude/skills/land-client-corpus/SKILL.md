---
name: land-client-corpus
description: Phase 3 of the Company Brain roadmap, land a new client's handed-over files into S3 raw/ exactly as found (immutable, hashed, provenance recorded in Postgres), via a per-client sources manifest. Use when onboarding a new tenant's data, "landing" or "ingesting the raw corpus", or doing Phase 3. Run before profile-client-sources.
---

# Land a client corpus (Phase 3)

> **Primary path is the web (Phase 5).** Start the API, worker and portal with `npm run dev`. In the portal, click **Add client**, then upload the handoff at `/t/<slug>/upload` (drag the folders in as delivered; each top-level folder becomes a source). The browser hashes each file and uploads it write-once to S3; the server verifies it and queues unpack and profile jobs. The manifest and script below are the developer fallback (bulk or local loads, tests).

Goal (task.md): *pretend the customer just gave us access.* Copy everything into the raw zone **exactly as found**: the hierarchy, duplicates, terrible filenames, obsolete and conflicting files, and old system exports. **Do not clean anything first.** Never use hidden truth or answer keys.

## Safety checks first
- **AWS:** only the `companybrain` profile (account 787137578043). `companyBrainStore()` in `packages/core/src/aws.ts` refuses any other account. Never fall back to the machine's default AWS profile: it belongs to an unrelated organization (memory `aws-account-boundary`).
- **DB:** run `npm run db:check`. It uses `DATABASE_PASSWORD` from `.env`, read key by key. Never load the whole `.env`.
- **Bucket:** `company-brain-787137578043`. Its policy (`infra/s3/bucket-policy.json`) makes `*/raw/*` impossible to delete or overwrite. Raw writes must use If-None-Match, which `S3ObjectStore.putIfAbsent` does.
- **Test files are forever.** Anything landed under `raw/` is permanent, so don't land test files under a real tenant. Use `_smoke/` for checks.

## Reusable code
| What | Where |
|---|---|
| Key layout `{tenant}/raw/{source}/{batch}/{original path}` | `packages/core/src/storage/layout.ts` |
| Write-once S3 store (+ in-memory one for tests) | `packages/core/src/storage/object-store.ts` |
| Land one object: hash → S3 → `source_objects` | `packages/core/src/storage/raw.ts` (`landRawObject`, `landLocalFile`) |
| Land a whole corpus from a manifest | `npm run land -- <slug> [--dry-run] [--create-tenant]` (`packages/core/scripts/land-corpus.ts`) |
| Example manifest | `config/tenants/riverton/sources.json` |

## Steps
1. **Read the handoff.** List the top-level piles with file counts and sizes, and read any cover note (e.g. `README_FROM_…`). Don't open the files themselves yet; that's Phase 4.
2. **Write the manifest** at `config/tenants/<slug>/sources.json`, with one entry per pile *as delivered*:
   - `slug`: lowercase, `[a-z0-9._-]`
   - `name`: the pile's real name, spaces and all
   - `kind`: e.g. `sharepoint`, `fileserver`, `onedrive`, `personal_device`, `removable_media`, `system_export`, `data_room`, `phone`, `api`, `interview`, `handoff_note`
   - `root`: path relative to `corpus_root`. A single file is fine for cover notes.
   - `batch`: delivery date plus a label, e.g. `2026-10-10-handoff`. A later delivery of the same pile gets a new batch, so it never collides with the immutable first copy.
   - FDE captures (interviews, screen recordings) are sources too, in their own batch.
3. **Dry run** with `npm run land -- <slug> --dry-run`. Check the per-source counts and total size against the folder listing.
4. **Land** with `npm run land -- <slug> --create-tenant`. Then run it again: the second run must report `0 new, N already landed`, which proves it's idempotent.
5. **Verify.** S3 object count under `{tenant}/raw/` must equal the `source_objects` rows. Then download 2–3 random files from S3 and compare their sha256 with the originals.
6. **Record.** Tick Phase 3 in task.md, update the `company-brain-phase-status` memory, then continue with **profile-client-sources**.

## Decisions already made (keep them)
- **Keep everything, junk included.** `Thumbs.db`, Office lock files `~$…` and duplicates are evidence. The lock files turned out to show who had which document open.
- **Mock or live API docs** found in the handoff are landed as files. The live systems are connected later as their own sources.
- **Permissions:** a handoff copy only shows file modes. Record them in `source_permissions` and map the real ACLs later, from the client's permission exports (Phase 4 finds them, Phase 10 maps them).
- **Timestamps:** record what the copy still has (`mtime`/`birthtime`). They may be copy times, so Phase 4 dates files from their content and metadata instead.
