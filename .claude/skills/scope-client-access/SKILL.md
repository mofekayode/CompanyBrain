---
name: scope-client-access
description: Organize a client's people and decide who may see which files. Build the company map from directory exports, propose access scopes with sensitivity from permission exports and folders, escalate personal data, review with the FDE, and release as the client admin. Use after extraction, when asked about permissions, access, sensitivity, org chart / company map, "who can see what", or Phase 9.5.
---

# Scope client access

A handoff arrives with no usable permissions. We organize the company and propose access, the FDE reviews it, and a **client admin releases** it. We copy the access the company *intended*, never its leaks.

> **Portal path:** Workbench → **People & access** (or the step in the step bar) → **Build map + propose scopes**. The run shows in Activity. Review on the page, then release as the client admin (pick them in "Acting admin").

## Model (decided with the user, 2026-10-06)

- **Company map:** people and groups as `principals`, merged from every directory export. The HR system wins on titles, managers and employment.
- **Scopes:** named buckets with a sensitivity (internal / confidential / restricted), an audience, and a hidden flag. Every file has exactly one scope.
- **Held by default:** a held scope is visible to admins only. Releasing it opens it to its audience.
- **Locked vs hidden:** employees see locked files and can request access. Files in hidden scopes aren't listed at all, because their titles leak.
- **Per-file grants:** an approved request gives that file its own ACL (scope audience + grantees). "Approve whole scope" grants the scope instead.
- **Enforcement:** Postgres RLS. Passages, documents and email threads follow their file.

## Steps

1. **Company map** (job `build_company_map`):
   - The AI maps each directory file's columns; mappings are saved on the file in `metadata.directory_mapping`, so correct one there if it's wrong.
   - Check People: status counts, **conflicts** (left but still enabled), unresolved managers, and memberships that were not copied (guests and former staff never inherit access through groups).
2. **Scope proposal** (job `propose_access`):
   - The AI reads the folder tree, every mailbox, the permission exports and the company map.
   - Every pile gets a rule, every mailbox gets its own scope, and every scope and rule cites its evidence.
   - Detectors move files with SSNs, bank details, birth dates or people's pay into the restricted personal-data scope and flag them.
3. **Review** (Scopes tab):
   - Open each restricted scope and every **flagged** file.
   - Fix audiences, sensitivity and hidden. Move misplaced files; human edits are never overwritten by a re-proposal.
   - Read the **Risks** tab: the leaks that were not copied go to the client as recommendations.
4. **Check with "View as":**
   - Pick people from different branches and departments, as employee.
   - Confirm counts per scope, search the content as them, and confirm nothing from hidden scopes appears.
5. **Release** as the client admin, scope by scope. Test a request → approve flow.

## Gotchas already handled

- **Guests in internal groups:** the buyer's guest was in Mgmt Team. Never copy guests into groups.
- **Folder ≠ audience:** a file in `HR/` isn't always HR-only. Employee handbooks and all-staff policies belong in the company-wide scope. The Riverton eval caught a tech locked out of the handbook. Check `person_access` evals for an "everyone" file.
- **Former staff still in groups**, and terminated in HR but enabled in M365: excluded from groups and listed as conflicts.
- **Mailboxes:** the folder summary collapsed `mail/` into one line, so the AI made a single "unassigned mailboxes" scope. The proposal now lists each mailbox with its likely owner.
- **AI column mapping varies between runs:** it's cached per file. Only `account_type` values that literally say shared, room or resource make an account a non-person, and anyone in the HR system is always a person.
- **Pay detection** requires a pay column next to a person column. Price lists ("Service | Rate") are not personal data.

Code: `packages/core/src/access/` (directory.ts, scopes.ts, enforce.ts, overview.ts), jobs in `packages/core/src/jobs/access.ts`, migration `20261006000010_access_scopes.sql`, tests in `packages/core/tests/access/`.
