---
name: capture-client-config
description: Capture and reuse a client's configuration: the rules the pipeline runs with (cleaning, resolution, source authority, people/personal-data detectors, prompt context) and everything the FDE taught the system (ontology + table mappings, directory mappings, vocabulary, merge decisions, access scopes, eval sets). Use when asked to export/import/back up a client's setup, start a new client from a previous one, tune a rule for one client, or about "tenant configuration", "templates" or Phase 13.
---

# Capture and reuse client configuration

> **Portal:** client rail → **Setup → Configuration**. It shows what was captured, has a form for the rules people tune (plus raw JSON), the rule history, and Export / Template / Import.

## Two layers
1. **Rules** (packages/core/src/config/tenant-config.ts)
   - `DEFAULT_RULES` is the playbook: cleaning patterns, resolution thresholds, the source-authority order, people and personal-data detectors, and prompt context.
   - A client stores only its **overrides**, versioned in `tenant_config_versions` (each save is a new version, with a required note).
   - The pipeline reads `rulesFor(sql, tenantId)` (cached for 30s).
   - Improving a default improves every client that hasn't overridden that rule. So put a lesson in the defaults when it's general, and in the client's overrides when it's specific to that client.
2. **Learned work** (packages/core/src/config/export.ts)
   - Exported to `config/tenants/<slug>/tenant.json`, with files referenced **by path**.
   - Contents:
     - ontology types and table mappings, which the loader reuses without an AI call
     - directory mappings
     - vocabulary, **including rejected aliases**, so they stay rejected
     - judged merges and pairs kept separate
     - access scopes, audiences and manual file moves
     - eval sets

## Commands (packages/core)
```
npx tsx scripts/tenant-config.ts export <slug>              # → config/tenants/<slug>/tenant.json (commit it)
npx tsx scripts/tenant-config.ts export <slug> --template   # → config/templates/<slug>.json (rules minus prompts, + type catalogue)
npx tsx scripts/tenant-config.ts import <slug> <file.json>  # idempotent; never deletes; reports what didn't match
```
The API offers the same: `GET/PUT /api/t/<slug>/config`, `GET /config/summary`, `GET /config/export?mode=template`, and `POST /config/import`.

## When to export
Export after every milestone: discovery confirmed, access released, model resolved, facts reviewed, eval set written. Commit the file. Job results are not a safe home: Riverton lost its ontology proposal from `ingestion_jobs` and it had to be rebuilt from a transcript dump. Now it lives in `tenant.json`.

## Starting a new client
1. Import a template (`config/templates/<previous>.json`). Types arrive as *proposed*, and the rules apply at once.
2. Fill in **About the company**, **Their systems** and **In-house terms** on the Configuration page. They go into every AI prompt for this client. Keep client names out of code prompts.
3. Run the pipeline. Tune rules with a note when the data needs it (e.g. a placeholder word like "ohne", a different strong-id column, more whole-type review).

## Re-applying after a rebuild
Import the client's `tenant.json` after re-landing and re-extracting. Run it in this order:
1. Import (this restores the table mappings).
2. `load_ontology` with `reuse`.
3. Resolve.
4. Import again, so vocabulary and merges attach to the new entities.
5. Run the checks.

Expect re-imports to apply old merge decisions to fresh duplicates. On Riverton they caught "Blue Ridge Mills" and "Hartwell Castings" leftovers.
