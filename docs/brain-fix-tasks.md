# Company Brain: fix list

Working list, in order. Each task is checked on our own free tests before it's ticked. One paid benchmark
run (about $10) at the end measures everything together.

## Done
- [x] Permissions: cards split by reader group; independent permission checker; guests out of labelled areas
- [x] Customer records: ids matched across systems (loader fix + repair of 56 rows); 6 missed duplicates merged

## To do
1. [x] **Current vs outdated.** Questions about "now" filter out replaced facts and superseded documents instead of
   only ranking them lower; history questions still see everything. Check: temporal evals, "outdated above current".
2. [x] **Which source wins depends on the question.** Authority per kind of fact (QuickBooks for what was billed, the
   signed contract for agreed terms, HR for employment) instead of one global ranking.
3. [x] **Result list lanes.** Separate quotas for records, facts and files, and each fact brings the files that prove it,
   so an answer has all the evidence it needs. Check: evidence recall on our evals.
4. [x] **Refusals.** "Refused" means the asker can't see the answer; partial answers say what's withheld. Check: access
   and leak checks, refusal items.
5. [x] **Email questions.** Thread-aware retrieval (whole conversation, newest reply) for email answers.
6. [ ] **Multi-step questions.** Break a question into parts, search each, combine; bounded to a few steps.
7. [ ] **Calculations.** Deterministic tools (totals, comparisons, date math) so answers can compute from cited
   records instead of refusing to.
8. [ ] **Speed.** Answer time back under about 5 s typical.
9. [ ] **RAGFlow comparison.** Free side test of its parsing and retrieval on the same files and evals.
10. [ ] **Update the engineering doc** with what changed and the numbers.

## Needs you
- [ ] Approve one paid benchmark run (about $10) once 1 to 8 are done.
- [ ] Optional, free: ask the truth agent for the breakdown of leaks and restricted candidates by source and role.
