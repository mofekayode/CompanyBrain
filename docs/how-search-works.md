# How Company Brain search works, and what we learned making it better

Written for the people who build and sell Company Brain: what happens when someone asks a question, where it goes
wrong, and what each fix bought, with numbers. Measurements are on Riverton, a fictional company with about 1,300 real-
looking files (contracts, email, spreadsheets, scans, recordings, chat exports).

## 1. What happens when someone asks a question

```
question ─► understand ─► search (two ways) ─► merge ─► rerank ─► access + time filters ─► answer
```

1. **Understand.** Our own code reads the question for names it knows ("Big Blue" is the customer Blue Ridge Food
   Processing; "TP-17" is a pump) and for time ("in March 2025", "now"). It knows these names because, while building
   the company model, we collected every nickname, former name and system spelling from the company's own records.
2. **Search two ways at once**, inside Elasticsearch:
   - **Keyword search (BM25)** finds documents that share words with the question. Excellent for exact things:
     "TP-17", "Net 60", invoice numbers, people's names. Weak when the question uses different words than the
     document ("being sold" vs "acquisition").
   - **Meaning search (embeddings)** turns the question and every document into lists of numbers (vectors) so that
     texts that mean similar things sit close together. A small model does this on our own server (no API cost).
     Good when the words differ; weak on codes and exact names.
3. **Merge** the two ranked lists (reciprocal rank fusion: a document near the top of either list ends up high).
4. **Rerank.** A second small model reads the question and each top candidate *together* and scores how well the
   candidate answers it. It is slower but more precise than either search alone.
5. **Access and time.** Every search runs with the asker's permissions inside Elasticsearch (you never even retrieve
   what you can't open), and facts are marked current or replaced as of the date asked about.
6. **Answer.** The best facts and passages go to the writing model (Claude Sonnet), which answers only from them, with
   a citation on every claim.

The intelligence that makes answers good mostly comes *before* any question: reading every file, pulling out facts,
working out how they changed over time, which source wins, and who is allowed to see what. Search finds that work;
the writer phrases it.

## 2. How we measure it

A test set of 24 facts whose source files we know, each asked five ways:

| Style | Example |
|---|---|
| **doc**: the document's own words | "Kemper Plastics site rules sign-in lockout program" |
| **casual**: how a person asks | "do we follow Kemper's lockout or ours?" |
| **typo** | "kemper plastic lock out rules" |
| **nickname**: company jargon | "KEPER safety rules for techs" |
| **indirect**: the situation, not the topic | "a tech's tools got stolen from the van, are we covered?" |

A phrasing passes if a file holding the answer is in the top 10 results. For every miss we record **where** it was
lost: never found by either search, found but too deep, dropped while merging, or pushed down by the reranker. That
tells you what to fix.

(Script: `packages/core/scripts/robustness-eval.ts`; set: `evals/riverton/robustness-dev-v1.json`.)

## 3. What we found

**Search is excellent when people use the documents' words and weak when they describe their situation.**

| Style | Right file in top 10 (before any fix) |
|---|---|
| doc | 24 / 24 |
| typo | 22 / 24 |
| nickname | 21 / 24 |
| casual | 20 / 24 |
| **indirect** | **13 / 24** |

Most misses were *never found* by either search, which means the first step failed, not the reranker. Customers ask
indirectly all the time ("customer is upset about the after-hours charge, can we drop it?"), so this is the weakness
that would disappoint them most.

Other lessons:

- **Casual questions get pulled toward casual recordings.** Chatty interview transcripts rank high for chatty
  questions because they *sound* similar, even when they're off topic.
- **Chat exports must be stored as readable messages.** A table of chat rows with IDs and phone numbers buried the one
  line that mattered ("so we got sold"). We now store one line per message in small groups.
- **The small reranker is web-trained.** It scores "so we got sold" as irrelevant to "Is Riverton being sold?" and
  sometimes pushes a #1 keyword hit down to #15. On balance it still helps (103 vs 97 right without it), so we keep it
  and treat a better reranker as a later upgrade.
- **Some "misses" are a narrow answer key**: "who do I report a near-miss to?" found "Jim Polk receives near-miss
  reports", a good answer from a different file. We still count it as a miss so the numbers never flatter us.

## 4. What each fix bought

| Setup | Cost | Right file in top 10 (of 120) | Situation questions (of 24) |
|---|---|---|---|
| Where we started | | 100 | 13 |
| Look deeper in meaning search (100 results from 1,000 candidates, was 60 from 400) | free, no slowdown | 103 | 15 |
| Rewrite with a free local model (Qwen 1.5B), old embedding model | free, ~3 s per question on a laptop | | 17 |
| Rewrite with Claude Haiku, grounded in our own name list, old embedding model | ~0.02 cents, ~0.6 s per question | 108 | 19 |
| **Bigger embedding model (bge-base) for meaning search** | free, ~7 ms per question, one index rebuild (~50 min) | **108** | **17** |
| **Bigger model + grounded rewriting (what's live now)** | ~0.02 cents, ~0.6 s per question | **115** | **22** |

Every other phrasing style is at 23 or 24 of 24 with both on. The regular checks didn't move: retrieval eval 143/146,
per-step checks all pass, access 33/33, and 0 leaks across all roles.

How to read the rewriting rows: the question is rewritten into the words a company document would use ("tools stolen
from the van, are we covered?" → "insurance coverage tools equipment theft vehicle inland marine") and we search with
the original *plus* the rewrite, so a bad rewrite can't lose what the original found. The time ("now", "in March
2025") and the names are read from the original question only, so a rewrite can't invent them.

**Grounding matters.** Ungrounded, Haiku didn't know "Lunken" was a customer: it guessed "Lunken Airport" or replied
"I need more context". Given our own name matches ("Lunken" = Lunken Aerospace Components, a customer), it wrote
useful queries. The company's own vocabulary is the knowledge a general model lacks, and we already have it. Only the
matched names go to the model (about 140 words in, 13 out), never the company's facts.

**Don't let the rewriter add the company's own name.** Every document says "Riverton"; adding it pulled contracts to
the top of unrelated searches.

**The reranker earns its cost.** It occasionally pushes a right answer down, but switching it off loses more (97 vs 103
right), so we keep it; a stronger reranker is a later upgrade (a larger open one was 6x slower and only somewhat better).

## 5. What's live, and how to bring the cost down

Live now:

1. Deeper meaning search.
2. bge-base embeddings (index version 2; switching back is one command:
   `npx tsx scripts/search-rebuild.ts <slug> 1 --swap-only`).
3. Grounded question rewriting with Claude Haiku (`packages/core/src/search/rewrite.ts`), on in the client app and the
   eval endpoint, off in dev scripts. It falls back to the plain question if the API is off, slow or failing.

Cost: rewriting is about 0.02 cents per question (10,000 questions ≈ $2). The written answer (about 2 cents) is where
the money goes. To bring rewriting to zero later, train a small open model on Haiku's own question → query pairs and
run it on our own server; that requires keeping customers' questions, which their agreement has to allow (and the eval
endpoint must never do).

## 6. Tools to keep doing this

| Tool | What it answers |
|---|---|
| `scripts/robustness-eval.ts` | Does search find the right file however people phrase it, and where is each miss lost? |
| `scripts/embed-bench.ts` | Which embedding model finds more, offline, without touching the live index? |
| `scripts/search-rebuild.ts` | Rebuild the index on another model next to the live one; swap when it's proven. |
| `scripts/search-eval.ts`, `steps-eval.ts`, `access-check.ts`, `eval-leak-check.ts` | Did anything else get worse? |
