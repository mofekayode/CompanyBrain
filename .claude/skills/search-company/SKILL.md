---
name: search-company
description: Build, sync, evaluate and debug a client's company search (Elasticsearch hybrid BM25 + local-embedding kNN with RRF, entity/alias-aware, access-filtered) and the answering layer on top (RAG context packs and the agent tools). Use for anything about the search index, projection, embeddings, retrieval quality or evals, "why didn't search find X", answering questions with citations, or Phases 14–19.
---

# Company search and answers

> **Portal:** client rail → **Search**: query, filters, View-as a person, and each result's BM25 rank, vector rank and timings. Run **Checks** for retrieval scores.

## How it fits together
```
Postgres (truth)                          Elasticsearch  cb-<slug> → cb-<slug>-v1
evidence ─cut─► passages ─┐
entities ─────► cards     ├─► search_documents ──embed (local bge-small, 384-d)──► index
facts ────────► cards ────┘        ▲                                               │
triggers ─► search_outbox ─► worker job project_search (every ~10 s) ──────────────┘
```

**Code:** `packages/core/src/search/`
- `project.ts`: chunking, cards, store, indexing
- `linker.ts`: entity and alias spotting
- `embed.ts`: local embeddings and the reranker
- `es.ts`: mapping
- `search.ts`: hybrid query, RRF, dedupe, rerank

**Sync:** `jobs/search.ts`. **Evals:** `evals/retrieval.ts`. **Answers:** `answer/answer.ts` (context pack, RAG, agent loop) and `answer/tools.ts` (the 8 agent tools).

**Chunking:**
- tables: 12-row windows, header repeated
- transcripts: ~90 s windows
- short text and OCR: merged to ~1,000 chars
- email: one passage per message, de-duplicated across mailboxes at query time
- images and video scenes: one passage each
- one card per non-event entity, one per canonical fact (with validity and status)

**Access:**
- Each document carries the principals of its source access lists.
- Every query as a person filters on the person plus all their groups, inside Elasticsearch.
- Fact cards are visible to anyone who can read one of their sources.

**Ranking:**
- BM25 over content and title (English stemming, plus an exact sub-field for codes), the names and aliases of entities each passage mentions, fuzzy matching, and phrase boosts
- kNN on the question (prefixed with bge's retrieval instruction, expanded with the resolved entity names)
- fused with RRF (k = 60) in our own code, so each leg's rank is visible
- at most 3 results per file
- optional cross-encoder rerank (ms-marco MiniLM, local)

## Commands (packages/core)
```
npm run search:project -- <slug> [--recreate]                  # full rebuild (~10–15 min for Riverton; re-embeds only changed text)
npx tsx scripts/ask.ts <slug> search "<q>" [--as "Name"] [--rerank]
npx tsx scripts/ask.ts <slug> context "<question>" [--as "Name"]  # RAG context pack (what the LLM would see)
npx tsx scripts/ask.ts <slug> tool get_timeline '{"entity":"TP-17"}'
npx tsx scripts/search-eval.ts <slug> all [--verbose]          # bm25 vs knn vs hybrid vs rerank
```

## Answering without the Claude API
With `COMPANY_BRAIN_ALLOW_API` off, Claude Code is the answering model:
1. Run `ask.ts context` (RAG) or the tools (agentic).
2. Answer **only** from what they return, with [n] citations.
3. Grade the answer against the eval set's key points.

Never mix in knowledge from outside the context pack. That would hide retrieval failures.

## Debugging "search didn't find X"
1. `ask.ts search` with the exact words. If BM25 ranks it, the problem is fusion or the cap. If kNN alone ranks it, check the wording.
2. Is the entity linked? Check the `understood:` line. If not, the alias is missing or rejected: fix it in Knowledge or Configuration; the sync re-links passages.
3. Is it in the index? `select * from search_documents where content ilike '%…%'`. If not, the evidence was never extracted or the document is deleted.
4. As a person: does their group appear in `acl_entries` for the file's ACL? Check People & access.

## Time (Phase 19.5)
- Data: `ontology/timeline.ts`.
  - `consolidateTimelines` repairs chains.
  - `detectTopics` links one rule recorded on several subjects. A shared rule is only "possibly outdated" by a newer version of the same rule, never by another customer's own terms.
  - Both run after canonicalization.
- Index: changed facts carry a `Timeline:` line, and shared rules get `t:<topic>` cards.
- Query: `search/time.ts` reads the time in a question. An event anchor ("before the sale closed") is dated from fact cards, scoped to the question's entities; a proper name in the anchor must match the fact's own statement. Era scoring runs last.
- A correction (same start date) is not history. A real change has a later start date, even when a reviewer used "correct" to record it.
- To check every timeline: `npx tsx scripts/temporal-auto-eval.ts <slug>` → `npm run eval-set` → `scripts/search-eval.ts --set "Temporal (all timelines) auto"`. A perfect score with a `Timeline:` line in every card is suspicious; the era check ignores history lines on purpose.
