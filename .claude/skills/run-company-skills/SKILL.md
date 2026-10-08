---
name: run-company-skills
description: Run, debug or extend the product skills (customer dossier, key-person audit, transition brief, SOP, customer risk, pricing leakage, incident investigation, obsolete knowledge, training plan, seller interview planner), cited reports built from the company record. Use when asked for any of these briefs or to add a new one.
---

# Company skills (cited reports)

**Code:** `packages/core/src/skills/report.ts` (Report format, access-aware `facts()`, `factItems`, `evidenceItems`, `events`, `moneyByYear`) and `skills.ts` (the ten skills + `SKILLS` registry + `reportMarkdown`).
**Portal:** client rail → **Skills** (`/t/<slug>/skills?skill=<key>&input=<x>&as=<principal>`).
**API:** `GET /api/t/<slug>/skills`, `POST /api/t/<slug>/skills/<key>` `{entity|topic, as}` (`?format=md`).
**CLI:** `npx tsx scripts/skill.ts <slug> <key> ["input"] [--as "Name"] [--json]`

## Rules
- Deterministic: SQL over canonical facts (with `Timeline:` history), events and evidence search. No Claude API. An LLM write-up, if ever wanted, takes the Report as input and stays gated.
- Every item cites sources; status comes from the fact (current / outdated / disputed / unknown / "check" for possibly outdated).
- A report states each fact once (`b.shown`); pass `{repeat: true}` only on purpose.
- Access: everything goes through `visible()` / `canSeeRecords()`; test new skills `--as` a technician.
- Regexes over fact text: use word boundaries (`\m…\M`), "late" matches "Plating" otherwise; match departures on predicate/value, not summaries.

## Adding a skill
Write `async function x(ctx, input): Promise<Report>` with a `ReportBuilder`, add it to `SKILLS` (key, name, description, input kind, placeholder), add example inputs in `apps/web/src/components/skills/skills-page.tsx`.
