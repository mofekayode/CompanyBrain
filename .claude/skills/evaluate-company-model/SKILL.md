---
name: evaluate-company-model
description: Write and run an evidence-derived eval set for a client (data checks on the ontology, canonical facts and permissions, plus search/answer questions with cited sources). Use after the company model and canonical facts exist, before building search, or when asked "is the data right?", "write evals", "test the model", or how we'd know answers are correct.
---

# Evaluate the company model

We never see the client's real truth. So, as with a real company, the eval set is written from the client's own evidence: interviews, documents, email and system exports. It's written by a person or a Claude Code session, never by the API. Later the client (or a sealed truth set) grades it.

## Write the set
JSON file at `evals/<client>/<name>.json`. Format: `EvalSpec` in packages/core/src/evals/load.ts.

**Data checks** (`kind: data_check`) carry a typed `assertion`; code turns it into SQL (never hand-written SQL). Types:
- `alias_resolves`: jargon → exactly one entity of a type. Include nicknames, old names, branch slang and asset nicknames.
- `entity_count`: a range for each important type. Branches are exact; customers, vendors and people get a plausible band after de-duplication.
- `fact_value`: subject (name or alias) + predicate substring + value substring, optionally `as_of` for timelines (old rate vs new rate).
- `relation_exists`: who is based where, who reports to whom, which asset is at which site.
- `person_access`: run *as that person* through RLS. Cover the owner of a mailbox, a tech who must not see payroll, comp or the deal, cross-branch denial, and an everyone-file such as the handbook.

**Questions** (`kind: question`) are for search and answers: `expected_answer`, `key_points` (what a grader checks), and `anchors` (the subject and predicate of the canonical facts the answer rests on). The loader turns anchors into evidence ids and file paths, so every expected answer cites its sources. Cover these categories:
- key_person: single points of failure
- temporal: what was true when
- exception: policy vs practice
- alias
- multi_hop
- multimodal: video/photo evidence
- permission: a persona who must NOT get the answer
- unanswerable: must say "not found"

Write expectations from what the evidence says, **not from what the database currently returns**. A failing check is the point: it finds a defect.

## Run
```
cd packages/core
npm run eval-set -- <tenant-slug> ../../evals/<client>/<name>.json            # load + run data checks
npm run eval-set -- <tenant-slug> ../../evals/<client>/<name>.json --run-only # re-run after fixes
```
Warnings list anchors with no canonical fact behind them. Either the fact is missing (a gap in the model) or the anchor is wrong.

## Fix failures in the data
Fix the data, not the expectation, unless the expectation was wrong. Typical fixes:
- Move files to the right scope with `moveFiles`. On Riverton the Employee Handbook sat in restricted HR; it moved to company-wide.
- Reject or move aliases, relink facts to the right subject, or merge duplicate entities. See the `build-company-model` review checklist.

Results land in `eval_runs` / `eval_results`, so runs stay comparable over time.

## Riverton baseline
`evals/riverton/evidence-derived-v1.json`: 43 data checks and 17 questions. Data checks pass 43/43 after the fixes. The questions are scored once search exists (retrieval: are the anchored files in the top results? answer: are the key points covered, and does the permission persona get nothing?).
