# Demo flows: what to film and screenshot

Six product moments, all running live on the demo company (Riverton Industrial Services, a field-service business that was just acquired by Northgate). Everything shown is real output from the system: no mock screens, nothing hand-edited.

## Before you start

| What | Where |
|---|---|
| Client app (what customers use) | `npm run dev:client` → http://localhost:4320/riverton |
| API + FDE portal | `npm run dev` (API :4318, portal :4317) |
| Worker (needed for Demo 6) | `cd apps/worker && npx tsx src/worker.ts` |
| Signed in as | the person menu at the top right, or add `?as=<Full Name>` to any URL. Sign-in is mocked until real accounts exist. |
| Screenshots of every screen below | `apps/client/scripts/capture-demos.sh [width] [scale]` → `apps/site/screenshots/product/` |

**People to use:**
- Sarah Okafor: President (sees nearly everything, manages access).
- Jamal Whitaker: field technician (sees company-wide documents only).
- Linda Marsh: Controller (finance and payroll).

Answers take 3–8 s; the first question after a restart takes longer while models load. **Warm up first:** ask one question before recording.

**Video timestamps.** Every source card opens the file in place. Video and audio start at the cited moment, PDFs open at the cited page, and photos show full size.

---

## Demo 1: "Why did Pump 17 keep failing?"

**Story:** one pump failed six times across two dispatch systems. The first diagnosis (misalignment) was wrong; a senior tech from another branch found the real cause (cavitation from an undersized suction line). A $38,400 fix stopped it.

1. Ask → `Why did Pump 17 keep failing?` (as Sarah).
   - **Answer:** "TP-17, recurring failure: known problem pump; seal leaks repeatedly under the coupling guard".
   - **Supporting facts:** Mike Hargrove diagnosed cavitation from the undersized 3 in suction line; the suction fix was completed with no comebacks since.
   - **Sources:** the leak video (IMG_2967.MOV, opens at the cited moment), the interview with Sarah, and the email thread with the customer.
2. Click **Investigate TP-17** (the dark button in the answer) → the Incident investigation brief:
   - **Failure history:** 7 failure-related work orders of 21, from 2024-07-02 to 2026-03-10.
   - **Diagnosis over time:** "Believe misalignment was cause" (Jul 2025) → "Mike H. diagnosed cavitation; suction line undersized" (Nov 2025).
   - **The fix:** suction upsized 3 in → 4 in, $38,400.
   - **Has it stopped?** "No failures recorded since the fix", plus the post-fix vibration check (0.08 in/s, no cavitation noise).
   - **What people said:** the customer's complaint email, Dave's "no charge til we fix it", the night-shift "seal faces chewed up again", photos and video.

Screens: `01-pump17-answer.png`, `01-pump17-investigation.png`

## Demo 2: "Who approves discounts?" now vs. March 2025 (temporal truth)

1. Ask → `Who approves discounts now?`
   - **Answer:** Sarah Okafor approves deals up to $75,000; above that goes to the Northgate deal committee. Pill: **in force now**.
   - **Timeline chips:** Up to 15% (Jun–Sep 2025) → all discounts under $50k (Sep 2025 – Oct 2026) → **$75k / Northgate committee (since Oct 2026)**.
   - **Callout:** "Changed: it was all discounts and pricing exceptions on deals under $50,000…"
2. Follow-up in the same conversation → `Who approved them in March 2025?`
   - The app carries the topic forward.
   - **Answer:** "Discounts above 10% require Dave", Feb 2019 – May 2025. Pill: **as of march 2025**.
   - **Callout:** "Changed since: Discounts above 15% require Dave (Jun 2025 – Sep 2025)".
   - **Supporting:** the 2019 policy (Sales Manager up to 10%) and the memo that moved the line.

Screens: `02-discounts-now.png`, `02-discounts-march-2025.png`. The direct-URL version of step 2 uses the full question.

## Demo 3: "What knowledge disappears when Dave leaves?"

1. Ask → `What knowledge disappears when Dave leaves?` → **See everything that depends on Dave Brennan**.
2. The Key-person brief opens with a **dependency graph**, Dave in the centre:
   - **Blue, only he holds:** the Walt Pruitt relationship to hand over; bonus records on his legal pads.
   - **Navy, others depend on him:**
     - the R-stamp QC sign-off (nobody can sign R work after Dec 29);
     - Kemper's owner "very loyal to Dave";
     - Blue Ridge's executive relationship (quarterly lunches, not in the CRM);
     - the fee-waiver list that lives only in people's memory;
     - the retention bonus agreement.
   - **Amber, arrangements that exist because of him:**
     - Mill Creek's waived dispatch fee;
     - "talk to Dave first" before any Kemper price increase;
     - bonuses set "by gut";
     - "no overtime without Dave's OK".
3. Scroll: every node is a cited line, plus his own words from interviews and email.

Screen: `03-dave-dependencies.png`

## Demo 4: "Prepare me for the Blue Ridge renewal"

1. Ask → `Prepare me for the Blue Ridge renewal` → **Prepare the Blue Ridge Food Processing LLC dossier**.
2. The dossier:
   - **Who they are:** also called "Big Blue", "Blue Ridge Mills", "BRM"; Hamilton and Florence plants; Walt Pruitt and Donna Keel.
   - **What changed:** Net 30 → **Net 60**; Blue Book −5% → **−8%**; the 2022 → 2025 agreement term, each with a timeline.
   - **Risks:**
     - largest customer and a concentration question from the sale;
     - the new parent may rebid;
     - Walt is retiring;
     - QuickBooks still says Net 30.
   - **Money by year:** $1.80M / $1.85M / $1.57M invoiced (2024–2026).
   - Recent work, and the executed renewal PDF and Amendment No. 1 (open at the page).
3. Optional: the **entity page** (`/riverton/e/Big Blue`) shows the same customer as a living page: revenue bars, 612 assets, the four people listed as "account owner" across systems, and what the systems still say vs. the reviewed facts.

Screens: `04-blue-ridge-dossier.png`, `04-blue-ridge-entity.png`

## Demo 5: Permissions (technician vs. finance)

The same question, asked by two people.

1. As **Jamal Whitaker** (technician): `What are everyone's salaries?`
   - **"The answer is in files you don't have access to."**
   - It lists which areas matched (names only, never content), with a **Request access** link.
   - Everything shown is from documents he can open (the handbook's pay schedule).
2. As **Linda Marsh** (Controller): same question.
   - **"Found in comp 2026 v3.xlsx and 3 other files."**
   - The excerpt shows the comp review rows, starting with her own line.
   - The ADP employee export is also a source.
   - The remaining interview matches stay locked.
3. Optional: **Files** as Jamal shows 64 of 1,054 files open, and locked areas with **Request access**. As Sarah, **Access** shows the request, plus the areas waiting for release (Approve / Deny, Release / Hold).

**Setup:** salary data lives in two areas that start **held**: nobody sees them until an admin releases them. Even Sarah's "salaries" answer says it's locked until then.
- Before step 2, sign in as Sarah → **Access** → **Release** "Compensation review 2026" (audience: Andrea, Karen, Linda, Marcus) and "Payroll" (audience: Linda, Beth Ann).
- Click **Hold** on both afterwards.
- Filming the release itself is a strong shot: the client's admin decides who sees what, and answers follow immediately (one search sync, seconds).

Screens: `05-salaries-technician.png`, `05-salaries-controller.png`, `07-files-technician.png`, `08-access-admin.png`

## Demo 6: Incremental ingestion (a new policy changes the answer)

Run from `packages/core` with the worker running:

```
AWS_PROFILE=companybrain npx tsx scripts/demo-new-policy.ts riverton          # run, with timings per stage
AWS_PROFILE=companybrain npx tsx scripts/demo-new-policy.ts riverton --undo   # restore the record exactly
```

| Stage | What happens | Typical time |
|---|---|---|
| Before | "Who approves overtime now?" → dispatch lead or branch manager (2021 policy) | 0 s |
| Upload | A memo marked **DEMO** goes up through the same signed-URL path as the web upload (write-once, checksum-verified) | ~2 s |
| Extract | The worker profiles and extracts it automatically (live tenants extract new files on arrival) | ~4 s |
| Release | The admin puts it in the company-wide area → search sync | seconds, or up to ~2 min if a large sync is already running |
| Search | "overtime approval branch manager FieldLine" → the memo is result #1 | immediately after the sync |
| Fact changes | The FDE records the change; the old rule becomes history | ~30 s incl. sync |
| After | "Who approves overtime now?" → **branch manager in FieldLine before the shift; dispatch leads can no longer approve**, with "Changed: it was … dispatch lead or branch manager (Jan 2021 – Oct 2026)", and the memo is a source | 0 s |

For video, keep the client app open on the Ask page and re-ask after each stage. Search for the memo after "Release".

The memo is fictional and labelled DEMO. **Always run `--undo` afterwards**; it restores the original rule from its version history.

---

## Honesty notes for the landing page

- **Answers in the screens are built without a language model.** The headline is the best-matching fact for the question's point in time, plus its history and sources. With the AI write-up switched on, a written paragraph appears above the same sources. Don't caption the screens as "AI-written".
- **Numbers:** quote only what the screens show. The retrieval and temporal eval results live in `task.md`; quote them only with their scope ("on our demo company").
- The demo company is fictional. Don't present it as a customer.
