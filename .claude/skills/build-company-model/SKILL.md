---
name: build-company-model
description: Build a client's company model (ontology + knowledge graph): propose entity/relationship types and table roles, load entities and events from structured exports, resolve duplicates across systems, read prose for vocabulary, exceptions and facts, and review it visually. Use after extraction and access scoping, when asked for the ontology, knowledge graph, "how the business works", entity resolution, or Phases 10-11.
---

# Build the company model

> **Portal path:** Workbench → **Company model** (left panel, or the step bar). "Re-propose model" runs propose → load → resolve. "Read interviews" reads prose. Both show in Activity. Review in **Business map** (types and how they connect, with counts), **Explore** (any entity's neighbourhood, with aliases, ids, merges and evidence), **Knowledge** (exceptions, risks, key people, practices, vocabulary, with quotes) and **Review** (notes; accept or reject types).

## Steps
1. **Propose** (`propose_ontology`, one AI call, about 4 min). Inputs: every business table (header + 3 rows; pay/identity columns withheld), a prose sample, the confirmed discovery findings, and company-map branches. Output: types, relationship types, and per table its role: entities (a master list), events (a log: work orders, invoices, payments) or ignore. Check the role of the big tables and the notes (they usually describe how the business works and where systems disagree).
2. **Load** (`load_ontology`, deterministic, a few minutes).
   - People and branches come from the company map.
   - Each list row becomes an entity with its system id and serial/VIN.
   - Events are entities linked to their participants.
   - Missing link targets are created as candidates.
   - Matching: id → name/alias → unique initials or first name. Placeholders like "UNASSIGNED" are skipped.
3. **Resolve** (`resolve_entities`).
   - Certain merges (same normalized name, shared serial/VIN/email) are done set-based.
   - Similar or contained names are grouped, and the AI partitions each group and flags placeholders ("Cash cust").
   - Unsure pairs become `possibly_same_as` for the FDE.
   - Small types (≤25, e.g. branches) are reviewed whole, which catches jargon like "J-town".
4. **Read prose, sample first** (`extract_knowledge`, about 90s per interview). Start with interviews (richest). Then documents, then emails. Estimate cost first: roughly 1 call per 14k characters.
5. **Canonical facts (Phase 12):**
   - **Knowledge review → "Re-group statements"** (job `canonicalize_facts`) groups claims into canonical facts. It ranks sources by authority, builds timelines and flags conflicts. It waits until reading jobs finish.
   - Review in this order: **Conflicts** (sources disagree), then **Facts to review** by kind, then **Possible duplicates**.
   - Accept, correct, mark unknown or reject. A correction is a new version and the old one stays as history.
   - Read more sources from the same page: "+ documents" reads official documents (policies, SOPs, contracts, pricing, memos); "+ emails" reads email.
6. **Review visually.**
   - The map should tell the business story at a glance.
   - Spot-check big customers in Explore: are merges right, and are links plausible?
   - Read every exception and risk in Knowledge, and reject wrong ones.
   - Accept types.
7. **Test it**: see the `evaluate-company-model` skill. Write an evidence-derived eval set and make the data checks pass by fixing data, not by editing expectations.

## Claude API is off by default
App code calls the Claude API only when `COMPANY_BRAIN_ALLOW_API=1` (see `assertApiAllowed` in packages/core/src/claude.ts). Never set it without the user's go-ahead. The steps marked "AI" above (propose, prose reading, canonicalize, AI review) then fail with a clear error. Do the judgement in the Claude Code session instead:
- Dump what needs judging to the scratchpad with a short script, for example unreviewed canonical facts with their claim quotes.
- Read it and decide.
- Write decisions back with a one-off script that calls the core functions: `reviewFact(..., { reviewer: 'ai', note })`, `mergeInto`, and alias status updates. Delete the script afterwards.
- Prefer marking things `rejected` (aliases, relationships, entities) over deleting rows. It's reversible and keeps the audit trail.

## Review checklist (what went wrong on Riverton)
- **Same-surname people.** Riverton had two "Mike H"s: Hargis (Oakley, Field Tech II) and Hargrove (Louisville, ex-Falls City, the ZX specialist). Prose facts were attached to the wrong one. For any person-heavy fact, check it against HR's branch and title before accepting. Never keep an ambiguous short alias like "Mike H".
- **Aliases on the wrong level.** Asset nicknames ("P17", "Seventeen", "Pump 17") were put on the customer and site. Move them to the asset; "P17" was TP-17 at Blue Ridge Hamilton, not PUMP-17 at a distillery.
- **Junk aliases.** Sentence fragments ("Kemper is Kemper", "Plan Balance"), product or person names on a vendor ("ZX parts", "Gary"), surname-only aliases that clash with a product ("Kessler"), and combined aliases ("J-town / Jeffersontown" should be split into two).
- **Facts on the wrong subject.** Competitor "Commonwealth" (Mechanical) was linked to the customer Commonwealth Steel Drum. Reject it; the claim stays on the right subject.
- **Same number from two systems.** Open balances from a QuickBooks snapshot and from a dated aging email disagree. Dispute them; never pick one silently.

## Gotchas already handled
- **Don't run the worker in watch mode while editing core code.** Each restart left orphaned workers holding job locks, and reading stalled for about 30 minutes. Run `npx tsx src/worker.ts` (apps/worker) as a plain process during development sessions.
- **Prose → entity matching must use indexed lookups** (exact name, alias, trigram `%`). A similarity scan over 57k work orders per mention made each document take minutes.
- **Clearing a previous load:** do it in chunks, dependents first. A single cascade delete of 100k entities times out.
- **Certain merges must be set-based.** Per-entity merging ran at about 60 a minute, so thousands of asset serial merges would have taken hours.
- **Unnamed assets:** assets without a customer tag are named from their type/manufacturer/model. Repeated names in a table get their id appended (tags like "PMP-070" repeat across customers).
- **Multi-value cells** are split: "50025; 50433", "Asset ID(s)", comma lists of equipment codes ("PRESS-106, PRESS-71"), and slash-joined legacy initials ("HO/MKH"). Before the code-list rule existed, Riverton got 1,665 fake assets named after lists. Check for them with `canonical_name ~ '^[A-Z]+-\d+, '`.
- **Rejected aliases are ignored** by matching, search and eval checks (`status <> 'rejected'`).
- **The business map aggregates every link**, so it's cached for 2 minutes (`?fresh` to force).
- **Prose statements are evidence, not truth.** Facts are candidates with authority, certainty and the exact quote. Expect a few wrong vocabulary links, e.g. "Big Blue" was linked to the wrong customer on Riverton.
