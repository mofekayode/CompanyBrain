# <Client>, Phase 4 source profile

Profiled <date> · profiler v<N> · <objects> raw objects, <size>, <n> sources.
Everything below comes from `public.source_inventory`. It describes the files' form, not their meaning. Statements marked *hypothesis* are to be tested in Phase 10.

Re-run: `npm run profile -- <slug>`. Query: `select * from source_inventory where tenant_id = '<tenant id>'`.

## Inventory at a glance
| Source | Files | Content dates | Shape |
|---|---|---|---|

## Answers to the Phase 4 questions
**1. Which systems exist?** Name each system, the evidence that identifies it (column layout, preamble, email domain, producing app), its files and row counts, and its date span.

**2. Which systems are legacy?** *Hypothesis.* What replaced what, and roughly when they overlap.

**3. How far back does data go?** The oldest evidence per kind, and which file dates it. Note where current systems stop holding detail.

**4. Which folders contain duplicates?** Group by pile pairs, e.g. data room ↔ SharePoint. Note that near-duplicates aren't covered by hash matching.

**5. What appears corrupted?** Integrity issues with explanations, plus files that need care: scans needing OCR, lock files, system files.

**6. Structured vs unstructured.** Counts and where the volume (rows) is.

**7. Where are permission boundaries?** From the permission exports: folders with their own permissions, sensitivity labels, personal drives, guests, external links and mailbox delegation.

**8. Whose files seem unusually important?** People ranked by metadata footprint (mail volume, authorship, lock files, personal piles). *Hypothesis* about key-person risk.

**9. What systems appear authoritative for what?** *Hypotheses*, per domain: work, money, people, identity, accounts, documents.

## Notes for later phases
- **Phase 6:** the OCR queue, plus files to skip for extraction (keeping them as evidence).
- **Phase 7:** the mailboxes, plus old domains and aliases seen.
- **Phase 10/11:** identifier systems available for entity resolution.
