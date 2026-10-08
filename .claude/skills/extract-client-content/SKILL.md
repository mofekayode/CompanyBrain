---
name: extract-client-content
description: Extract what is inside a client's profiled files (documents, spreadsheets, scans, email, interview audio, video, photos) into searchable evidence with exact citations, build the email thread/address index, and verify it. Use after profiling and discovery (profile-client-sources), when asked to "extract", "read the files", "make the content searchable", or do Phases 6–9 for a tenant.
---

# Extract client content

Turns profiled raw files into `evidence` rows that each cite their exact origin: file + page/section, sheet rows, email date, or audio/video timestamp and speaker. Raw files are never changed. Identical bytes are extracted once.

> **Primary path is the portal.** Workbench → **Extraction** card → **Extract N**, or ask the chat agent ("extract the content of the files", which uses its `run_extraction` tool). Progress shows in the card and the step bar. Pressing it again retries failures and upgrades files extracted with an older extractor version.
>
> **Start with a sample.** On a new client, use **Extraction → Try a sample** first: about 12 representative files (one of each kind), extracted even if done before, for a few minutes and cents. Watch the **Activity** tab (it opens automatically). It shows each file as it is read, the step ("Reading PDF with Docling", "Transcribing audio"…), how long it took, what came out ("42 passages · 12 pages") and the exact error on failure. Open any file and switch to **Extracted** to check its passages and citations (audio/video passages play from their timestamp). Fix problems, then run all remaining files. One file can be redone with **Re-extract** in the file viewer.

## Before you start

- Profiling is complete for the client (Profile step done) and discovery is at least drafted.
- Services running: `npm run dev` (API :4318, worker, portal :4317) and `npm run docling` (:5051). Without Docling, PDF/Office jobs retry and then fail.
- `.env` has `ANTHROPIC_API_KEY` (vision), `ELEVENLABS_API_KEY` (speech) and optionally `TWELVE_LABS_API_KEY` (video embeddings).
- Cost check: tell the user before a big run. Roughly a few dollars of Claude vision per few hundred images or video scenes, plus ElevenLabs per audio hour. Riverton (1,333 files, about 3.7 h of audio) cost a few dollars plus the transcription.

## What runs (one job per file, on the queue)

| Input | Job | How | Evidence |
|---|---|---|---|
| PDF, DOCX, PPTX | `extract_document` | Docling (OCR forced for scans); Office-XML fallback if Docling rejects a deck | `text`/`ocr`/`table`, page + section |
| CSV, XLSX | `extract_table` | own parser; title rows, footers and TOTAL rows kept out | `table`, sheet + row range |
| TXT, MD, HTML, RTF, ICS | `extract_text` | | `text` |
| MBOX | `unpack_mailbox` | each message → raw `.eml` child, profiled inline | (children) |
| EML | `extract_email` | quoted history removed, forwarded content kept, attachments → raw children | `email_body` |
| JPG, PNG, HEIC | `describe_image` | Claude vision: what is shown, visible text, identifiers | `image` |
| MP3, M4A, WAV | `transcribe_audio` | ElevenLabs Scribe, diarized | `transcript_segment`, timestamp + speaker |
| MP4, MOV | `analyze_video` (+ `embed_video`) | scene keyframes → vision + speech per scene; Twelve Labs embeddings | `video_segment`, timestamp |
| after the run | `index_email` | threads + address book with candidate signals | `email_threads`, `email_addresses` |

Code: `packages/core/src/extraction/*`, `packages/core/src/jobs/extraction.ts`. Search: `packages/core/src/workbench/evidence-search.ts`.

## Steps

1. **Start** extraction from the portal (or `POST /api/t/<slug>/extraction`).
2. **Watch** the card. If it stalls, read the worker log for `✗` lines. Jobs waiting on another job log `… waiting` and do not use up attempts.
3. **When it finishes**, check: `remaining 0`, `failed 0` on the card. For failures, fix the cause and press **Retry N failed**.
4. **Spot-check citations** in the workbench chat: ask a content question the discovery findings raised, and check that answers cite pages and timestamps that open to the right place.
5. **Check the email index** (ask the agent "what do the email threads tell us?"). Read the address signals as leads: old domains, shared/group mailboxes, possibly former people. Each flag carries its reason and evidence in `signals`.
6. **Visual acceptance:** write the client's own version of `packages/core/tests/acceptance/riverton-visual-search.live.test.ts`. For each of the 8 cases (spoken fact, identifier only visible, whiteboard, equipment shown, no speech, alias spoken while ID shown, obsolete procedure, audio + visual), pick a real moment and assert search returns that file and timestamp.

## Gotchas already handled (don't re-fix)

- Docling rejects some PPTX decks with fractional slide sizes ("invalid literal for int()"). These fall back to the Office XML reader automatically.
- Mailbox messages are profiled when split out. If a client was extracted before that change, run **Profile** once to profile them.
- The same email appears in several people's mailboxes. The index dedupes by Message-ID.
- Departure detection uses prose only. Table blocks, email header lines and chat speaker labels ("Jim Polk: …") gave false positives.
- A bulk upgrade (new extractor version) re-extracts only when you start extraction again. It is idempotent per file + extractor version.
