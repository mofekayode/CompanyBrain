# Company Brain: Capstone → Production Roadmap

## Ultimate Goal

Build the Riverton capstone using the same core architecture that will support the first real customer.

The final system should take a messy newly acquired company and turn:

```text
Files
Emails
APIs
Spreadsheets
Scans
Images
Audio
Video
Human interviews
```

into:

```text
Searchable evidence
+
Company ontology
+
Canonical knowledge
+
AI assistant
+
Agentic workflows
+
Useful visual intelligence
```

The Riverton-specific ontology can be thrown away.

The platform used to discover, create, maintain, search and reason over that ontology should become the product.

---

# PHASE 0, Lock the Synthetic World

## Goal

Finish the hidden Riverton truth and evaluation blueprint before working on the Company Brain.

## Tasks

- [x] Final review of Riverton Company Truth
- [x] Fix remaining truth inconsistencies
- [x] Freeze a truth version (encrypted snapshot: RivertonTruth.dmg, 2026-10-04)
- [x] Generate evaluation blueprint
- [x] Define expected answers
- [x] Define what should be unknown at Day 10
- [x] Define what becomes knowable after each interview
- [x] Define permission-sensitive questions
- [x] Define temporal questions
- [x] Define aliases/jargon questions
- [x] Define multimodal questions
- [x] Define agentic/multi-hop questions
- [x] Define business opportunity questions
- [x] Define unanswerable questions

## Exit Criteria

There is a hidden answer key against which the eventual Company Brain can be evaluated.

---

# PHASE 1, Establish Product Architecture

## Goal

Build the reusable multi-tenant foundation.

## Core Technologies

```text
Application
→ TypeScript / Node / Next.js

Canonical semantic database
→ Supabase / Postgres

Original evidence
→ S3

Search
→ Elasticsearch

Documents
→ Docling

Speech
→ AssemblyAI

Video
→ Twelve Labs / visual extraction pipeline
```

## Tasks

### Tenancy

- [x] Create `tenants`
- [x] Every shared record carries `tenant_id`
- [x] Enable Postgres RLS
- [ ] Implement tenant-aware authentication (DB side done via auth.uid() + tenant_members; Next.js login/tenant routing pending)
- [x] Implement tenant-aware authorization

### Shared semantic tables

- [x] `sources`
- [x] `source_objects`
- [x] `documents`
- [x] `document_versions`
- [x] `evidence`
- [x] `entity_types`
- [x] `entities`
- [x] `entity_aliases`
- [x] `relationship_types`
- [x] `relationships`
- [x] `facts`
- [x] `fact_versions`
- [x] `permissions`
- [x] `resource_acl` (implemented as `acls` + `acl_entries`, referenced by `acl_id`)
- [x] `ingestion_jobs`
- [x] `sync_state`

Do NOT create Riverton-specific product tables such as:

```text
riverton_pumps
riverton_customers
riverton_work_orders
```

Riverton business concepts should be tenant ontology/configuration.

## Exit Criteria

A second fictional company could use the platform without requiring a redesign of the core database.

---

# PHASE 2, Build S3 Storage Model

## Goal

Preserve original evidence while supporting machine-processed representations.

## Suggested Structure

```text
company-brain/
└── {tenant_id}/
    ├── raw/
    ├── processed/
    └── derived/
```

---

## `raw/`

Exact evidence received from the company.

Examples:

```text
raw/sharepoint/
raw/email/
raw/quickbooks/
raw/fieldline/
raw/scans/
raw/laptop-backups/
raw/photos/
raw/videos/
```

Rules:

- [x] Never modify raw files (enforced by S3 bucket policy: no deletes, no overwrites under */raw/*)
- [x] Preserve original filename
- [x] Preserve original path
- [x] Preserve source
- [x] Preserve timestamps (as far as the copy we received still has them)
- [x] Compute hash/checksum
- [x] Record permissions
- [x] Store provenance in Postgres

---

## `processed/`

Machine-readable representations.

Examples:

```text
processed/documents/
processed/email/
processed/audio/
processed/video/
processed/api/
```

Possible contents:

```text
structured.json
content.md
chunks.json
ocr.json
transcript.json
tables.json
metadata.json
```

---

## `derived/`

Generated artifacts such as:

```text
video keyframes
thumbnails
cropped OCR images
waveforms
previews
```

## Exit Criteria

Every transformed piece of knowledge can always be traced back to the untouched original evidence.

---

# PHASE 3, Land Riverton Exactly As Found

## Goal

Pretend Customer #1 just gave us access.

Do not use the hidden truth.

## Tasks

- [x] Copy the messy Riverton corpus into the raw S3 zone (273 files, 196 MB, 12 sources, `npm run land:riverton`)
- [x] Preserve original folder hierarchy
- [x] Preserve duplicates (11 duplicated contents kept as separate objects)
- [x] Preserve terrible filenames
- [x] Preserve obsolete files
- [x] Preserve conflicting files
- [x] Preserve permissions (as observed on the handoff copy; source-system ACLs mapped in Phase 4/10)
- [x] Preserve old system exports

Do NOT manually make everything nice first.

---

# PHASE 4, Source Discovery / Data Profiling

## Goal

Understand what we have before trying to understand what it means.

## Build inventory

For every object determine:

```text
source
path
format
size
created time
modified time
owner
permissions
possible content type
processing status
```

## Questions

- [x] Which systems exist?
- [x] Which systems are legacy?
- [x] How far back does data go?
- [x] Which folders contain duplicates?
- [x] What appears corrupted?
- [x] Which data is structured?
- [x] Which is unstructured?
- [x] Where are permission boundaries?
- [x] Which people's files seem unusually important?
- [x] What systems appear authoritative for what?

## Exit Criteria

You have a searchable inventory of the raw mess without yet pretending to understand the company.

> Done 2026-10-05: `public.source_inventory` (RLS-aware) + report `docs/tenants/riverton/phase-4-source-profile.md`. Reusable as skills `land-client-corpus` and `profile-client-sources`.

---

# PHASE 4.5, FDE Workbench (internal product, v0)

## Goal

Make discovery visible and repeatable. Instead of an FDE running SQL in a terminal, an agent works through the phase's questions in a UI where every step (which files it read, which queries it ran, what it concluded) is shown live and stored.

## Tasks

- [x] Next.js app (shadcn/ui, port 4317, localhost only until auth lands)
- [x] Raw file explorer over `source_inventory` (search, filter by source/format/issues, profile detail)
- [x] Discovery question catalog per phase (Phase 4's 10 questions first)
- [x] Agent chat (Claude) with tools: inventory search, file profile, read file content from S3, record finding
- [x] Live step trace: reasoning, tool calls, results streamed to the UI
- [x] Persistence: sessions, messages, steps and findings stored in Postgres (replayable)
- [x] Findings carry status (hypothesis / confirmed / rejected) and evidence links to raw files
- [x] FDE can confirm or reject a finding

## Exit Criteria

An FDE can open a tenant, ask "answer the Phase 4 questions", watch the agent work file by file, and come back later to the stored findings with their evidence.

---

# PHASE 5, Build Generic Ingestion Framework

## Goal

Everything entering the Company Brain follows one reusable lifecycle.

## Entry point: client upload (web, not CLI)

Clients and FDEs upload the handoff on a web upload page during onboarding:
drag and drop folders or zips → the browser uploads directly to S3 `raw/` (signed, write-once, sha256-verified) → Postgres records each file → jobs unpack containers (zip/mbox/pst) and profile each file → the workbench updates live.

Reuse, don't rewrite: `src/lib/storage` (key layout, write-once store, provenance) and `src/lib/profiling` (profiler). `scripts/land-corpus.ts` and `scripts/profile-raw.ts` stay as dev and test tools.

- [x] Split raw landing into put (write-once) + record (verify in S3, write provenance)
- [x] Upload page in the workbench (folders, zips, progress, per-pile source naming); files up to 5 GB, multipart later
- [x] Signed direct-to-S3 uploads with If-None-Match and checksum
- [x] Unpack containers into child raw objects (parent_id): zip done; mbox → messages in Phase 7, pst later
- [x] Profiling runs as a job from the web (Profiling card + agent `run_profiling` tool), with live progress
- [x] Per-file jobs and a dedicated worker (`npm run worker`, or `npm run dev:all` for web + worker)

```text
discover
→ copy raw
→ classify
→ extract
→ normalize
→ create evidence
→ enrich
→ resolve entities
→ update semantic model
→ project to Elasticsearch
```

## Tasks

- [x] Job queue
- [x] Processing status
- [x] Retry handling
- [x] Idempotency
- [x] Checksum deduplication
- [x] Error handling
- [x] Provenance tracking
- [x] Permission propagation (archive → members via acl_id)
- [x] Processing logs (job rows: status/result/last_error; worker stdout)

---

# PHASE 6, Document / Spreadsheet / Scan Ingestion

## Goal

Turn documents into structured evidence.

## Docling pipeline

```text
PDF/DOCX/XLSX/PPTX/scan
↓
Docling / OCR
↓
structured document
↓
sections / tables / pages
↓
chunks
↓
evidence records
```

## Tasks

- [x] PDF extraction (Docling, local service on :5051)
- [x] Word extraction
- [x] PowerPoint extraction (Docling; Office-XML fallback with slide numbers and speaker notes for decks Docling rejects)
- [x] Spreadsheet extraction (CSV/XLSX: report title rows, footers and TOTAL rows kept out of data; header repeated per 40-row block)
- [x] OCR (scans detected at profiling are force-OCR'd)
- [x] Tables (markdown tables as their own evidence, with sheet and row range)
- [x] Page references
- [x] Headings/hierarchy (section_path on every evidence unit)
- [x] Chunking (heading-aware, ~1.8–3k chars)
- [x] Original-document provenance (evidence → document_version → source_object → raw S3 key; extract once per content hash)
- [x] Permission inheritance (acl_id copied to versions, evidence and split-out children)

## Exit Criteria

A search result can return an exact document, page, section or table from which a statement originated.

> Met (2026-10-06). `search_evidence` (Postgres full-text search over `evidence`) returns citations like
> "Safety/SOP-LOTO Rev 3.pdf, p. 1, § 2. Responsibilities" and "dispatch db/WorkOrders.csv, rows 27241–27280".
> Riverton: 1,333 files, 7.7k evidence units, 0 failures.

---

# PHASE 7, Email and Conversational Data

## Goal

Make company communication searchable without destroying its structure.

## Tasks

- [x] Parse email metadata (from/to/cc, dates, Message-ID, In-Reply-To, References)
- [x] Thread reconstruction (`email_threads`: headers first, subject + shared people within 60 days as fallback; missing messages counted). Riverton: 784 unique messages → 546 threads, 113 with more than one message
- [x] Resolve sender/recipient to identities (`email_addresses`, with likely aliases across domains). Linking identities to Person entities is Phase 10
- [x] Remove duplicated quoted content where appropriate (full body kept as an artifact)
- [x] Preserve original MIME (each message is its own write-once raw .eml; the mbox is untouched)
- [x] Process attachments (landed as raw children, profiled and extracted)
- [x] Identify forwarded content (kept as its own evidence with the forwarded header, because the original is often not in the corpus)
- [x] Preserve dates (observed_at on every evidence unit)
- [x] Preserve permissions (ACL inherited; a thread whose messages have mixed ACLs is visible only to ingestion managers)
- [x] Handle old domains (riverton-ind.net flagged old: last used 2020; rivertonindustrial.com current)
- [x] Handle former employees (candidate leads only: went quiet after emailing regularly, or full name near departure words in prose, with evidence. E.g. "Greg Whitfield is no longer with the company", "Tom Jablonski is retiring June 30")
- [x] Handle shared mailboxes (role inboxes such as dispatch@ and billing@, plus group lists such as allstaff@ and branch lists)

---

# PHASE 8, Audio Interviews

## Goal

Capture human knowledge as evidence.

## Pipeline

```text
Interview audio
↓
ElevenLabs Scribe (one speech vendor for the platform)
↓
transcript
↓
speaker diarization
↓
timestamped segments
↓
entity/fact extraction
↓
candidate semantic knowledge
```

## Tasks

- [x] Store original audio in S3
- [x] Transcribe (13 Riverton recordings, 1.5k timestamped segments)
- [x] Detect speakers (diarization; segments split on speaker change or long pause)
- [x] Store timestamps (start_ms/end_ms per segment, word-level kept in the artifact)
- [ ] Extract mentioned entities → moved to Phase 10 (needs the entity types it defines)
- [ ] Extract candidate facts → Phase 10/12
- [ ] Extract uncertainty → Phase 10/12
- [ ] Detect estimates vs confident statements → Phase 10/12
- [ ] Detect contradictions → Phase 12 (the agent can already surface them by searching across sources, e.g. the LOTO Rev 3 video vs Rev 4)
- [x] Link transcript evidence to source audio (citation = file + timestamp + speaker)

Important:

An interview statement is evidence.

It does not automatically become canonical truth.

---

# PHASE 9, Video & Visual Knowledge

## Goal

Make visually encoded knowledge searchable.

## Representation

For each video capture:

```text
speech transcript
scenes
timestamps
visual descriptions
OCR
keyframes
entities
objects
equipment identifiers
```

## Tests

All 8 pass on real Riverton data: `LIVE_DB=1 npx vitest run tests/acceptance` (packages/core).

- [x] Important fact spoken (Mill Creek trip charge waived: said at 0:50 of the billing screen recording, not shown)
- [x] Important identifier only visible (asset EQ-844755 on screen at 0:15, never spoken)
- [x] Important information on whiteboard (IMG_4127: root-cause diagram "NOT alignment")
- [x] Equipment visually demonstrated (IMG_2967.MOV 0:15: multistage pump with residue at its base)
- [x] No useful speech (IMG_5937.MOV: silent impeller clip still found)
- [x] Alias spoken while official ID appears visually ("Revision three" said while "SOP-LOTO Rev 3" is on screen, 0:20)
- [x] Obsolete procedure demonstrated (2024 LOTO training teaches single-tech verification; Rev 4 from 2025-10-15 requires two people for ammonia)
- [x] Answer requiring audio + visual evidence (invoice 61543 on screen + fee waived aloud, same segment)

Pipeline: ffmpeg scene keyframes → Claude vision (what is shown, visible text, identifiers) + ElevenLabs speech per scene → video_segment evidence with timestamps; Twelve Labs Marengo embeddings stored for semantic video search later.

## Exit Criteria

Search can return the correct video and exact timestamp.

> Met (2026-10-06): see the tests above.

---

# PHASE 9.5, People, Sensitivity & Access Scopes

## Goal

A messy handoff arrives with no usable permissions. Part of our job is to organize the company (who exists, which teams, who reports to whom), decide how sensitive each file is, and group files into access scopes that a client admin releases. Copy the access the company intended, not its leaks.

Decisions (2026-10-06): every scope starts **held** (admins only) until a client admin releases it; employees see locked files and can **request access**, except restricted scopes marked **hidden** (titles leak); access is **per file**, inherited by emails, attachments and passages; mock "view as" login until Clerk.

## Tasks

- [x] Company map from directory exports (AI maps columns, pay/identity columns never read; deterministic merge by email/name; HR system wins on titles, managers, employment). Riverton: 108 people (86 active, 17 former, 4 guests, 1 service), 9 departments, 3 branches, 17 groups; 79/86 managers resolved
- [x] Conflicts surfaced (e.g. Dave Brennan terminated in ADP 09/29/2026 but active in M365 and the VDR; Carl Jennings left 2025 but M365 enabled)
- [x] Guests, former staff and service accounts never inherit access through groups (recorded as excluded, e.g. buyer guest Rachel Stein in Mgmt Team)
- [x] Scope proposal from permission exports + folders + mailboxes + company map, every scope and rule with evidence. Riverton: 37 scopes (one per mailbox), 0 unassigned files
- [x] Risks deliberately not copied listed for the client (anonymous pricing link, over-shared OneDrive, stale guest, forwarding rules, admin roles…)
- [x] Personal-data detectors (SSN, bank details, birth dates, pay next to people) escalate files into a restricted scope, flagged
- [x] Release / hold scopes, request access, approve per file or per scope, audit log
- [x] Enforcement in Postgres (RLS): held = admins only; released = audience; hidden = not listed; passages and email threads follow their file
- [x] Mock login / impersonation ("view as" any person, as employee or admin) running under RLS
- [x] FDE review page (People & access): scopes, people, view as, requests, risks, audit; Activity shows the runs
- [ ] Clerk login replaces mock users (map Clerk user → company-map person)
- [ ] Client-facing catalog / request / admin UX → the client app (Phase 24)
- [ ] Passage-level redaction (e.g. a pay column inside an otherwise open sheet)
- [ ] Permission changes from live systems (`acl.changed` events, Phase 21)

## Exit Criteria

For any person, the database returns exactly the files and passages their scopes allow, and nothing from hidden scopes; an admin can release, hold and grant, and every change is audited.

> Met for the mock (tests/access/enforce.test.ts on real migrations; live "view as" on Riverton).

---

# PHASE 10, Discover the Riverton Ontology

## Goal

Learn how Riverton actually works from evidence rather than copying the hidden answer key.

## Start with proposed entity types

AI may suggest:

```text
Employee
Customer
Vendor
Site
Asset
EquipmentType
WorkOrder
Contract
Policy
Process
Invoice
Project
Incident
```

But these are proposals.

## Iterative workflow

```text
sample evidence
↓
AI proposes entities/relationships
↓
FDE reviews
↓
ontology updated
↓
more evidence processed
↓
new concepts discovered
↓
ontology evolves
```

## Discover

- [x] Entity types (AI-proposed from tables + prose + discovery findings; 20 types + Term; FDE accepts/rejects in the model view)
- [x] Relationships (45 types; 375k links loaded from the tables: work orders ↔ customers, sites, assets, technicians, branches, invoices…)
- [x] Aliases (every merged spelling kept: e.g. Mill Creek Rendering = "Mil Creek", "Mill Crek", "MillCreek"…)
- [x] Jargon (Term entities linked to what they name: "J-town" → Louisville branch, "Fifer" → Pfeiffer Brothers Meats, "the cage", "hot job")
- [x] Company vocabulary
- [x] Temporal facts (valid_from/valid_to from prose, e.g. Blue Ridge net 60 from 2025-07-01; $132 standard rate from 2026-01-01)
- [x] Key-person knowledge ("Kyle is a field tech who's also the IT department", "only Rhonda knows all five waivers")
- [ ] Source authority: proposal notes record it (e.g. FieldLine rates.csv authoritative); not yet stored per type/attribute (Phase 12)
- [x] Customer-specific exceptions (dispatch-fee waivers, legacy pricing, PO requirements, consolidated invoicing…)

How it was built (generic, reusable): `packages/core/src/ontology/` (propose → load → resolve → knowledge), jobs in Activity, FDE view at `/t/<slug>/model` (Business map, Explore, Knowledge, Review). Riverton: 10.2k things + 94k activity records, 2,523 duplicates merged, 57 pairs for review. Prose read so far: the 13 interviews and 5 videos (documents and emails next, sample first).

---

# PHASE 11, Entity Resolution

## Goal

Understand that different names may refer to the same real thing.

Examples:

```text
Big Blue
Blue
Blue Ridge Foods
BLUE RIDGE FOOD PROCESSING
Blue Ridge Mills
```

should eventually resolve appropriately.

## Tasks

- [x] Candidate entity matching (trigram similarity + name containment, grouped into small components; small types reviewed whole)
- [x] Exact identifiers (system ids, serial numbers, VINs, emails merge for certain)
- [x] Alias resolution (merged spellings and jargon become aliases)
- [x] Name similarity
- [x] Context resolution (the AI sees systems, ids, addresses and activity for each candidate)
- [x] Human confirmation: unsure pairs are linked `possibly_same_as` (57 for Riverton) and decided in Knowledge review
- [ ] Confidence scores: recorded on facts; not yet on merges
- [x] Collision handling (repeated asset tags get their id appended; ambiguous pairs never auto-merged)
- [x] Historical names (old-domain emails, legacy system spellings kept as aliases)
- [ ] Location-dependent aliases ("North Pump" at Hamilton vs Florence: captured as a term, not yet scoped by location)

Never automatically collapse genuinely ambiguous entities.

---

# PHASE 12, Canonical Knowledge Layer

## Goal

Convert evidence into defensible company knowledge.

## Facts need

```text
subject
predicate
value/object
valid_from
valid_to
observed_at
source
authority
confidence
status
```

## Tasks

- [x] Candidate fact extraction (claims from interviews, videos and 56 official documents, each with its exact quote)
- [x] Evidence linking (claim → passage → file; canonical fact → claims via `fact_claims`)
- [x] Temporal reconciliation (periods become a chain: valid_from/valid_to + supersedes_fact_id)
- [x] Source authority (system of record > document > email > interview; system fields are claims too)
- [x] Conflict detection (canonical fact `disputed`, with the disagreeing sources and a note on who says what)
- [x] Human review (Knowledge review page: accept, correct, unknown, reject; merges: same or different)
- [x] Superseded facts (kept as history, never overwritten)
- [x] Unknown states
- [x] Corrections (a correction is a new accepted version that supersedes the old; every change versioned in fact_versions)

Example:

```text
Blue Ridge payment terms
2022 → Net 30
Jul 2025 → Net 60
```

Do not overwrite history.

---

# PHASE 13, Turn FDE Work Into Configuration

## Goal

Avoid doing everything manually again for Customer #2.

Capture:

- [x] Ontology definitions (types + relationship types; template-able)
- [x] Extraction prompts (generic in code; client context/systems/jargon per tenant in `rules.prompts`)
- [x] Entity-resolution rules (strong id systems, thresholds; judged merges + kept-apart pairs exported)
- [x] Company jargon (vocabulary in prompts + confirmed aliases)
- [x] Aliases (incl. rejected ones, so they never come back)
- [x] Source mappings (table → ontology mappings by path; directory mappings)
- [x] Source-authority rules (`rules.authority.rank`, evidence-kind labels, official-document paths)
- [x] Data-cleaning rules (placeholders, code lists, strong-id columns, legal suffixes)
- [x] Permissions mappings (scopes, audiences, manual file moves; personal-data detectors)
- [x] Validation rules (eval sets with typed data checks; Checks page)

These should be tenant configuration where possible, not hardcoded Riverton logic.

Done (2026-10-06): defaults in `packages/core/src/config/tenant-config.ts`, per-tenant versioned overrides
(`tenant_config_versions`, migration 0014), export/import in `config/export.ts`
(`config/tenants/riverton/tenant.json`, template `config/templates/riverton.json`), API `/api/t/<slug>/config*`,
portal Setup → Configuration and Workflow → Checks. Skill: `capture-client-config`.

This is one of the most important productization steps.

---

# PHASE 14, Elasticsearch Projection

## Goal

Turn evidence and semantic context into extremely fast retrieval.

## Search document might contain

```text
tenant_id
evidence_id
document_id
content
title
source
timestamp
entity_ids
aliases
effective_from
effective_to
is_current
authority
allowed_users
allowed_groups
embedding
provenance
```

## Tasks

- [x] Elasticsearch mappings
- [x] BM25 search
- [x] Vector search
- [x] Hybrid search
- [x] RRF/fusion
- [x] Filters
- [x] ACL filtering
- [x] Entity filtering
- [x] Temporal filtering
- [x] Source filtering
- [x] Reranking

Done (2026-10-06): index `cb-riverton` (alias → `cb-riverton-v1`), 29,372 docs = 19,983 passages + 8,720 entity cards + 669 fact cards.
Local embeddings (bge-small-en-v1.5, 384-d, $0), BM25 + kNN fused with RRF in code, optional local cross-encoder rerank.
Code: packages/core/src/search/*, migration 0015 (search_documents, search_outbox). Skill: search-company.

---



# PHASE 15, Postgres → Elasticsearch Sync

## Goal

Elasticsearch stays consistent with canonical knowledge.

## Architecture

```text
Postgres change
↓
outbox / CDC
↓
projection worker
↓
affected search documents rebuilt
↓
Elasticsearch
```

## Test changes

- [x] Entity renamed
- [x] Alias added
- [x] Fact superseded
- [x] Permission changes
- [x] Source deleted
- [x] New interview added
- [x] New policy uploaded
- [x] Customer renamed

Done: triggers → search_outbox → worker job `project_search` (polls every 10 s). Live check `scripts/search-sync-check.ts`: 11/11
(incl. as-of search returning the superseded value; permission change re-pushed without re-embedding).

---



# PHASE 16, Build Search First

## Goal

Make search excellent before letting an LLM answer questions.

## Search should handle

- [x] Exact lexical search
- [x] Semantic search
- [x] Hybrid search
- [x] Aliases
- [x] Jargon
- [x] Misspellings
- [x] Entity search
- [x] Temporal queries
- [x] Permission filtering
- [x] Multimodal results
- [x] Source previews

Target:

```text
query
→ useful results in hundreds of milliseconds
```

Done: portal Workflow → Search (filters, View as person, BM25/vector ranks per result, timings). Latency p50 ≈ 590 ms hybrid,
≈ 80 ms vector-only, 1.7 s with rerank (most of it is the round trip to Elastic Cloud). Source previews = highlighted snippets + citation.

---



# PHASE 17, Preliminary Retrieval Evals

## Goal

Find retrieval failures before adding AI.

Evaluate:

- [x] Recall
- [x] Precision
- [x] Ranking
- [x] Alias resolution
- [x] Temporal retrieval
- [x] Permission enforcement
- [x] Source diversity
- [x] Audio retrieval
- [x] Video retrieval
- [x] OCR retrieval
- [x] Latency

Fix retrieval before proceeding.

Done: `scripts/search-eval.ts` over 16 eval questions + 25 probes (evals/riverton/retrieval-probes-v1.json).
Final: bm25 39/41 · knn 35/41 · hybrid 37/41 (recall@10 0.74) · hybrid+rerank 40/41 (MRR 0.75). Permission probes 5/5 in every mode.
Precision@5 judged by hand on the 15 answerable eval questions: 64/75 = 0.85 (noise = raw invoice-table rows; generic fee rules crowding a specific list).
Final after fixes (entity linker, codes, broadcast-email access): hybrid+rerank 40/41 · MRR 0.76 · recall@10 0.73; only miss = a probe that was too strict.

---



# PHASE 18, Standard RAG

## Goal

Answer relatively straightforward company questions.

```text
Question
↓
query understanding
↓
entity/time resolution
↓
Elastic retrieval
↓
relevant canonical facts
↓
context construction
↓
LLM
↓
cited answer
```

## Test

- [x] Citations
- [x] Grounded answers
- [x] Current-vs-historical truth
- [x] Correct uncertainty
- [x] No unauthorized evidence
- [x] No unsupported conclusions

Done: `answer/answer.ts` (buildContext → numbered sources labelled Current/Outdated/Disputed/Supports + entity facts with history → prompt; LLM call gated by COMPANY_BRAIN_ALLOW_API).
Run with the API off: a Claude Code session answered the 17 eval questions only from the context packs → 14/17 cover ≥75% of key points (mean 79%), recorded as eval run `answer:rag:…` (evals/riverton/answers-rag-v1.json).
Misses: ZX risk, discount approver (a 2019 rule still marked current on another subject, timeline split across 4 entities), R-stamp successor, all three found by the agent tools.
Access: Jamal (field tech) gets nothing restricted; the eval also caught that All-Staff emails were invisible to staff → fixed (emails readable by their distribution list).

---

# PHASE 19, Agentic RAG

## Goal

Allow the AI to investigate questions requiring multiple steps.

## Initial tools

```text
search_company
get_entity
get_relationships
get_current_facts
get_fact_history
get_timeline
query_business_metrics
open_source
```

Example:

> Why did Pump 17 keep failing and has the issue been resolved?

Agent might:

```text
resolve Pump 17
→ inspect work-order history
→ retrieve technician notes
→ inspect whiteboard/video
→ inspect project work
→ check subsequent failures
→ synthesize
```

Done: all 8 tools in `answer/tools.ts` (access-aware), agent loop `answerWithAgent` (gated), CLI `scripts/ask.ts tool …`, API `/api/t/<slug>/tools/:name`.
Pump 17 run (Claude Code as the agent): get_entity "Pump 17" → TP-17 (Grundfos CR90-3, Blue Ridge Hamilton) → get_timeline across legacy + FieldLine:
6 seal failures Jul 2024–Mar 2026, misdiagnosed as coupling alignment (Jul 2025), Mike Hargrove diagnosed cavitation from an undersized 3" suction (Nov 2025),
$38.4k project upsized to 4" + eccentric reducer (May–Jun 2026), vibration 0.08 in/s (Jul 2026), no failures since → resolved; repeat repairs were free by Dave's July 2025 promise.

---

# PHASE 19.5, Temporal Truth

## Goal

"What was true when, what is true now, and what changed", for every fact, not hand-picked ones, and every answer says when something changed ("Net 60 since Jul 2025, it was Net 30 before").

- [x] Timeline repair for all facts (`consolidateTimelines`): open-ended old versions closed, accepted predecessors superseded, duplicates and same-day corrections folded
- [x] Rules recorded on different subjects linked automatically (`detectTopics`: predicate + meaning, rule vs per-instance attribute, "possibly outdated" flags)
- [x] Runs after every canonicalization (job `canonicalize_facts`)
- [x] Timeline line on every changed fact card + one timeline card per shared rule
- [x] Time in questions (`search/time.ts`): dates, months, years, before/after, last year / N years ago, events ("before the sale closed") dated from the company's own facts, "before <person>" → history; the client's "today" = latest records
- [x] Era-aware ranking applied after fusion and rerank (right era up, wrong era down; "now" questions push replaced facts down; change questions pull timelines up)
- [x] Answers call out changes (context pack "What changed" section + answer rule); Search UI timeline chips
- [x] Evals: Temporal v1 (30 hand-written) + Temporal (all timelines) auto (one question per period of every timeline, generated)

Results (hybrid + rerank): Temporal v1 25/25 · all-timelines 79/79 · temporal data checks 12/12 · no regression on general sets (16/16, 24/25).
Answers from context packs: 23/25 cover ≥75% of key points, mean 97%, each with the change callout.
Data fixed on the way (generally, not per question): discount-authority history across 7 subjects (Northgate policy from Oct 19, 2026, resolved the Sales Manager dispute), 2025 overtime version, legacy QuickBooks item codes merged (adds the 2011 prices to the timelines),
Sarah's President version, reworded duplicates folded, abbreviations (OT = overtime) in entity linking.

---

# PHASE 20, Build Skills

## Goal

Package repeatable useful workflows.

Built as deterministic, cited reports (no Claude API needed) in `packages/core/src/skills/`, facts with their timelines, work orders, money and evidence, all through the reader's access. API `GET/POST /api/t/:slug/skills[/:key]` (`?format=md`), portal **Skills** page (deep links `?skill=&input=&as=`), CLI `scripts/skill.ts`.

- [x] Customer Dossier, Blue Ridge: aliases, sites, contacts, terms in force, what changed (Net 30 → 60, 5% → 8%), risks, $ by year, recent work, contracts
- [x] Key-Person Dependency Audit, ranks Mike Hargrove (ZX pumps, Gary at Ohio Pump Salvage, retiring?), Dave, Hank, Priya, Ray…
- [x] Acquisition Transition Brief, deal, role changes, approvals with no owner (R-stamp, collections override), concentration, conflicts
- [x] Generate SOP, e.g. ammonia lockout: Rev 4 two-person rule, steps, near miss, outdated Rev 3 / 2024 video
- [x] Customer Risk Review, risks ranked by 2025 invoiced revenue
- [x] Pricing Leakage Analysis, dispatch-fee waivers, Kemper escalator never applied, stale rate tables, hot jobs coded T&M (~$180k)
- [x] Incident Investigation, Pump 17: 6 seal failures, misalignment → cavitation diagnosis, $38.4k suction fix, no failures since
- [x] Obsolete Knowledge Detector, unsigned "FINAL" policy, LOTO v3/2024 video, systems disagreeing, rules replaced in last 18 months
- [x] Employee Training Plan, safety, how work is done, site quirks, who to learn from, material
- [x] Seller Interview Planner, Dave: what only he holds, side arrangements to explain (waivers, protected customers, bonuses), hearsay
- [x] Access-aware: run as Jamal (tech) → no money, work orders or bonus lines

---

# PHASE 23, Internal FDE / Debug Interface

## Goal

Make it possible to understand and correct what the system is doing.

Build screens for:

One navigation for the whole workflow (Upload → Profile → Discover → Extract → People & access → Company model → Knowledge review), each step with its status.

- [x] Raw source inspection (file viewer: original)
- [x] Evidence inspection (file viewer: extracted passages, citations, play-from-timestamp)
- [x] Entity browser (Company model: business map + explorer)
- [x] Entity merging (Knowledge review → possible duplicates)
- [x] Aliases (entity panel: also known as, merged records)
- [x] Fact review (Knowledge review)
- [x] Relationship review (Knowledge review → Relationships: learned single-valued links with several targets, triangles that disagree, prose links; right / ended / wrong, never deleted)
- [x] Conflicts (Knowledge review → conflicts)
- [x] Temporal history (timelines on fact cards; History list)
- [x] Permissions (People & access, view as)
- [x] Processing jobs (Activity)
- [x] Search-debug view (Search: BM25 / vector / fused / rerank ranks per hit, timings, time reading, view-as)
- [x] Agent traces (workbench chat step trace)

This UI is extremely important for future FDEs.

---

# PHASE 24, End-User Product UX

## Goal

Make the Company Brain genuinely useful to the operator.

Built as a separate client app: `apps/client` (Next.js, :4320, `npm run dev:client`). It uses the site's design and logo, and is UI only (API `/api/t/:slug/app/*`). Every read carries the signed-in person, so answers, search, files and briefs only show what they can open.

- [x] **Search:** Google-like, with filters by kind, entity/time understanding, highlights, timeline chips, and sources that open in place
- [x] **AI assistant:** Ask → cited answer → follow-ups (pronouns carry the topic: "Who approved *them* in March 2025?")
  - The answer is deterministic when the Claude API is off (`answer/brief.ts`): the best fact for the question's time, its timeline, a "Changed: it was…" callout, supporting facts, numbered source cards, and locked-match notices.
  - A written answer is added when the API is on.
- [x] **Entity pages:** what changed, facts by kind, history, revenue by year, connections, system activity, documents, and "as recorded in the systems"
- [x] **Rich answers:**
  - timelines and source cards;
  - video/audio opening at the cited moment, PDFs at the cited page;
  - revenue bars, tables in briefs, and a dependency graph.
- [x] **Briefs:** the ten skills, each one click from Ask or an entity page
- [x] **File catalog:** open/locked by area; request a file or a whole area
- [x] **Client admin:** release/hold areas, approve/deny requests
- [ ] **Clerk login.** Mocked for now (person picker, `?as=<name>` for demo links); left for when real customers sign in.
- [ ] Relationship maps as a visual (connections are listed as chips today)

---

# PHASE 25, Final Demo Flows

All six run live. Script, setup and expected results are in `docs/demo-flows.md`. Screens are captured by `apps/client/scripts/capture-demos.sh` → `apps/site/screenshots/product/`.

- [x] **Demo 1, Pump 17:**
  - failures (7 of 21 work orders), the misdiagnosis then the cavitation diagnosis;
  - the $38.4k suction fix, the post-fix vibration check, "no failures since";
  - the video, email and interviews as sources.
- [x] **Demo 2, discounts now vs March 2025:** Sarah up to $75k / Northgate committee (with full timeline); then Dave above 10% (2019 policy) via the follow-up
- [x] **Demo 3, Dave leaving:** the key-person brief and a radial dependency graph:
  - **only he holds:** the Walt relationship, bonus records;
  - **others depend on him:** R-stamp sign-off, Kemper, Blue Ridge, the waiver list;
  - **arrangements:** Mill Creek waiver, "talk to Dave first", bonuses by gut.
- [x] **Demo 4, Blue Ridge renewal:** "Prepare me for…" → the dossier and the entity page
- [x] **Demo 5, permissions:**
  - Technician: "The answer is in files you don't have access to" (areas named, request link).
  - Controller, once the admin releases Compensation review: the comp review rows.
  - Even Sarah is told it's locked while the area is held.
- [x] **Demo 6, incremental ingestion** (`scripts/demo-new-policy.ts`, `--undo` restores exactly from fact_versions):
  - upload → extracted in ~4 s → #1 in search → FDE records the change;
  - the answer then shows the new rule with "Changed: it was…" and the memo as source.
- [x] Bugs the demos found, now fixed:
  - new uploads on a live tenant were not extracted;
  - re-uploads reused a deleted copy's extraction;
  - concurrent search syncs deadlocked (now a per-tenant advisory lock);
  - kNN varied between shard replicas (stable `preference`);
  - the rerank pool missed one-leg-only hits;
  - facts crowded documents out of results (30% kept for documents).
  - Retrieval is now 145/146 (hybrid+rerank) across all sets.

---

# PHASE 26, Customer #1 Readiness

Checked on 2026-10-06:

- [x] **Tenant creation takes minutes.** One call (`POST /api/tenants` → `create_tenant`). The search index is created on first projection, and storage is prefixed per tenant.
- [x] **Source connection is generic.** Any upload (folder, archive, mailbox export, media) goes through signed write-once URLs. *Not yet:* live connectors (SharePoint/Google/QuickBooks APIs).
- [~] **S3 isolation.** Every key is under the tenant's prefix, every write is signed per key and checksum-verified, and the API only serves files it resolved for that tenant. *Not yet:* per-tenant IAM / bucket policy (one bucket, server-enforced).
- [x] **Postgres RLS works.** 25 tables with RLS. The tenancy tests pass: cross-tenant rows invisible, inserts blocked, cross-tenant foreign keys blocked even for service_role, suspended tenants hidden.
- [x] **Elastic tenant isolation.** One index per tenant (`cb-<slug>` alias), never shared. Per-person access is filtered inside ES on principals.
- [x] **Ontology is configurable.** Tenant config versions plus the proposed/confirmed entity types per tenant.
- [x] **New entity types require no migration.** Entity types and relationship types are rows.
- [x] **FDE review tools work.** Knowledge review (conflicts, facts, duplicates, relationships, vocabulary), Search debug, Checks, Configuration.
- [x] **Permissions propagate.** Sync check 11/11 (revoke → gone from search in one sync, no re-embedding). Area release/hold reaches answers and briefs.
- [~] **Evidence provenance is complete.**
  - Every passage carries file + locator (page/rows/timestamp).
  - 643/671 facts link to passages.
  - The 28 others come from system exports and trace to their source row via the entity; they don't link a passage yet.
- [x] **Raw sources remain immutable.** S3 `IfNoneMatch` write-once + SHA-256. Deletes are soft (`deleted_at`).
- [x] **Incremental ingestion works.** Demo 6, end to end.
- [x] **Search works before AI.** Everything above runs with the Claude API off.
- [~] **AI cites everything important.** Every brief line and answer is cited. The LLM-written answer path is built and gated, but not exercised in this phase (no API spend).
- [x] **Unknown means unknown.**
  - Disputed/unconfirmed statuses are shown.
  - "No reviewed fact covers this" when only files match.
  - "Locked" only when the best source is one the person can't open.
- [x] **System can operate without Riverton-specific code.**
  - Removed the hard-coded deal regex from the eval runner (now `forbid_text` in eval data) and from the transition brief.
  - Skill placeholders are generic; examples come from each tenant's record.
  - Remaining Riverton names are only in comments and docs.

---

# LATER, after everything above is built

> Moved here on 2026-10-06 at the owner's request: live API ingestion needs the mock API, and the
> ground-truth evaluation needs the sealed Riverton truth, which the owner unlocks once the product is fully built.

# PHASE 21, Incremental Ingestion

## Goal

The Company Brain stays alive after deployment.

## Implement

- [ ] Webhooks
- [ ] Polling
- [ ] API cursors
- [ ] Change data capture
- [ ] Email incremental sync
- [ ] File change detection
- [ ] Deleted files
- [ ] Permissions changes
- [ ] New work orders
- [ ] New invoices
- [ ] New interviews/video

---

# PHASE 22, Full Ground-Truth Evaluation

## Goal

Now compare Company Brain against the hidden Riverton truth.

Evaluate:

### Correctness

- [ ] Exact factual accuracy
- [ ] Temporal correctness
- [ ] Entity resolution
- [ ] Source authority
- [ ] Correct unknown answers

### Retrieval

- [ ] Relevant evidence found
- [ ] Irrelevant evidence avoided
- [ ] Correct source ranked highly

### AI

- [ ] Grounding
- [ ] Citation accuracy
- [ ] Hallucination rate
- [ ] Agent reasoning
- [ ] Tool selection

### Security

- [ ] ACL enforcement
- [ ] Cross-tenant isolation
- [ ] Restricted source protection

### Performance

- [ ] Search latency
- [ ] RAG time-to-first-token
- [ ] Agent completion latency
- [ ] Indexing latency

---

# Final Mental Model

```text
COMPANY AS FOUND
       ↓
Immutable raw evidence
       ↓
Extraction
       ↓
Evidence
       ↓
Ontology discovery
       ↓
Entity resolution
       ↓
Canonical company knowledge
       ↓
Postgres
       ↓
CDC / projection
       ↓
Elasticsearch
       ↓
Search
       ↓
RAG
       ↓
Agents / Skills
       ↓
End-user intelligence
```

## What We Are Ultimately Building

Not:

> AI over company files.

Not:

> a chatbot over SharePoint.

Not:

> Riverton-specific software.

The product is:

> **A reusable system and FDE methodology for walking into a messy business, learning what the company actually knows, converting that knowledge into a continuously maintained semantic model, and making it searchable and actionable before critical knowledge disappears.**