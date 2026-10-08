# Eval contract: the Brain's side

How the Brain implements `docs/eval-contract.md`, written without access to the question set or the answer key.
Endpoints are served by the API (`apps/api`, default `http://localhost:4318`) at the root path.

| Endpoint | Code |
|---|---|
| `POST /eval/answer` | `apps/api/src/routes/eval-contract.ts` |
| `GET /eval/ontology?knowledge_cutoff=` | `packages/core/src/evals/ontology-export.ts` |
| `GET /eval/components` | `packages/core/src/evals/components.ts` |

## Knowledge cutoff

Enforced by a knowledge view (`packages/core/src/access/knowledge-view.ts`) at the same gates as permissions: the search
query, fact lookups and file lookups.

- **When a file became available** comes from the landing manifest (`config/tenants/<slug>/sources.json`). A source
  delivered in a dated batch (`2026-10-10-handoff`) arrived that day. Any other file has its own date: the date in its
  name, else its recording time, else its modified time.
- **Hidden** before availability: the file's passages, facts whose evidence is all in hidden files, records known only
  from them, nicknames that no available evidence uses, and topic timelines built from hidden facts.
- **Facts with mixed evidence** (available and not yet available) keep the statement and its dates; quotes and summaries are
  dropped.
- **"Current"** is recomputed for `asked_on`: a version replaced later by something not yet known counts as current,
  and its history stops where the knowledge does.
- Files not present in the delivered corpus (test uploads, demo files) are never evidence.

For cutoff 2026-10-10 this hides 20 files (14 interview recordings, the inbox screen recording, demo and test files),
179 passages, 190 facts and 86 records, and 7 nicknames.

## Roles

`config/tenants/riverton/eval-roles.json` maps each role to the person whose access best matches it. ROLE-OPS-MGR →
Hank Ostrander is a judgment call (no one holds that title). `{"person": ...}` resolves by display name, then email.

## Run conditions and known limits

- **Model:** `claude-sonnet-5-5` for written answers, reported per response. It does not accept `temperature`
  (the API rejects it as deprecated), so runs are fixed by model id and prompt instead. Each response says so in
  `generation`.
- **No learning:** questions are never stored, indexed or embedded. Each call appends one line (who, dates, latency,
  counts, no question text) to `logs/eval/<X-Eval-Run>.jsonl`, outside the knowledge store.
- **Refusals** return `refused: true` and no citations.
- **Retrieved** is the reranked candidate list after access and cutoff filtering, up to 50, one entry per result (facts
  and records point to the first piece of evidence behind them).
- **Locators:** `page=`, `slide=`, `sheet=…;row=` / `row=`, `t=start-end`, `msg=<Message-ID>`. Word documents have no
  section locator yet (empty string). Attachments are cited as their mailbox without `att=`.
- **Latency:** about 9 to 10 s per answer when warm (three reranked searches share one CPU, then writing). The first
  call after a restart is slower; the Day 10 view is prepared at startup.
- **Later cutoffs** need the mock-API connector (not built): only cutoff 2026-10-10 is meaningful for now.
