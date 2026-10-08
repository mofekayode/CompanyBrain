# Eval contract (Brain ⇄ eval runner)

Neutral interface between the Company Brain and the Riverton eval runner. This file contains **no answers**: it is safe for
the Brain side to read. The runner (built on the answer-key side) calls the Brain only through what's described here.

## Ownership and blindness

- **Brain side** owns the Brain and these endpoints. It never opens `riverton-truth/`, `RivertonTruth.dmg`, the question
  set, or scorer `--detail` output.
- **Runner side** owns the question set, scoring and judge. It never changes Brain code, prompts, index or ontology.
- The Brain must **not store, index, embed or learn from** questions asked through `/eval/*`. Logging to a run log outside
  the knowledge store is fine (needed for latency and debugging).
- Every eval call carries header `X-Eval-Run: <run_id>`. Answers within a run must be independent: no conversation memory,
  no cache shared across questions.

## 1. Knowledge cutoff (data state)

Each question is asked against a **knowledge cutoff date**. The Brain must answer using only evidence that was available
on or before that date:

| Evidence | Available from |
|---|---|
| `riverton-data/company-as-found/**` | 2026-10-10 (Day 10 snapshot) |
| `riverton-data/fde-captures/audio/**`, `fde-captures/inbox/**` | the recording/receipt date (file name or modified time) |
| Mock API records and events | their own timestamps, as served with `as_of=<cutoff>` |
| Mock API inbox files | their `released_at` |

The cutoff is separate from **asked_on** (the "today" of the question, usually on or after the cutoff). "Current" means
current as of `asked_on`, using only evidence available by the cutoff.

Round 1 uses cutoff 2026-10-10 only. Later cutoffs require the mock-API connector (clock stepping, `updated_since`,
archive/delete tombstones, permission changes, inbox).

## 2. `POST /eval/answer`

Request:
```json
{
  "question": "string",
  "asked_on": "YYYY-MM-DD",
  "knowledge_cutoff": "YYYY-MM-DD",
  "as": {"role": "ROLE-FINANCE"}            // or {"person": {"name": "...", "email": "..."}}
}
```

Response:
```json
{
  "answer": "string (plain text or markdown)",
  "refused": false,                          // true if all or part was withheld for permissions
  "citations": [{"source": "<source id>", "locator": "<locator>", "quote": "optional supporting text"}],
  "retrieved": [{"source": "<source id>", "locator": "<locator>", "rank": 1, "score": 0.83}],
  "latency_ms": 1234,
  "model": "model id used for generation"
}
```
`retrieved` is the ranked candidate list **after access filtering and before generation** (top 50 is enough).

### Roles
Questions are asked as one of these roles, or as a named person. The Brain maps them onto its own access model; how it
does so is the Brain's decision.

| Role id | Role |
|---|---|
| ROLE-CEO-BUYER | CEO / Buyer (new owner) |
| ROLE-OPS-MGR | Operations Manager |
| ROLE-BRANCH-MGR | Branch Manager |
| ROLE-FIELD-TECH | Field Technician |
| ROLE-SALES-MGR | Sales Manager |
| ROLE-SALES | Sales Rep / Account Manager |
| ROLE-FINANCE | Finance |
| ROLE-HR | HR |
| ROLE-DISPATCH | Dispatch / Service Coordination |

`{"person": ...}` is used for a few questions asked as a specific individual (for example someone whose access is
time-limited). Resolve the person through the Brain's own people model.

### Source ids and locators
Citations and retrieval results must be mappable back to evidence, so use these formats:

| Kind | `source` | `locator` |
|---|---|---|
| File | path relative to `riverton-data/`, e.g. `company-as-found/Phone uploads/IMG_6418.MOV` | see below |
| PDF / scan | file path | `page=3` |
| Word / text | file path | `section=<heading>` or `para=12` |
| Spreadsheet / CSV | file path | `sheet=Name;row=42` (CSV: `row=42`) |
| Slides | file path | `slide=5` |
| Email (mbox) | mbox path | `msg=<Message-ID>` (attachment: `msg=<id>;att=<filename>`) |
| Audio / video | file path | `t=12.4-15.0` (seconds) |
| Image | file path | `region=x,y,w,h` (optional) |
| Mock API record | `api:<endpoint>/<record id>` e.g. `api:/api/work-orders/WO-123` | `as_of=YYYY-MM-DD` |
| Mock API inbox file | `api-inbox:<file id>` | as for its file type |

## 3. `GET /eval/ontology?knowledge_cutoff=YYYY-MM-DD`

Returns the ontology export in the format of `riverton-data/ONTOLOGY_EXPORT_FORMAT.md`, built only from evidence available
by the cutoff.

## 4. `GET /eval/components`

Stage outputs for the component benchmarks, keyed by source id:
```json
{
  "transcripts": [{"source": "...", "segments": [{"start": 0.0, "end": 4.2, "speaker": "S1", "text": "..."}]}],
  "ocr":         [{"source": "...", "page": 1, "text": "..."}],
  "video_text":  [{"source": "...", "start": 7.3, "end": 8.3, "text": "..."}],
  "entity_links":[{"source": "...", "locator": "...", "span": "...", "entity_id": "..."}]
}
```
Speaker labels can be anything consistent within a file; the scorer aligns them.

## 5. Run conditions

- Generation at temperature 0 with a fixed model id per run. Report the model in every response.
- The runner calls questions sequentially by default (latency is measured per question).
- Eval runs use the API key and spend rules the user has approved for answering.
