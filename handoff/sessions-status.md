# Executor status at pause (2026-11-27 12:54 UTC)

## Complete (SUMMARY pushed) -> train 37 candidates
- 07-41 exec/07-41 808d25b0. Train note: re-run `npx tsx eval/harness/calibrate-language-confidence.mts` if the train touches fixture golden files, detect.ts or language-packs.json.
- 05.2.1-18 exec/05.2.1-18 7305cd2f. Two pre-existing vitest failures: tool-route "changes nothing" and legacy-post-filter-sentinel.
- 07-20 exec/07-20 dba1664f.
- 05.2.1-19 exec/05.2.1-19 ff4208f.
- 06.2-09 exec/06.2-09 2a707552.
- 04.3-33 exec/04.3-33 3281d4c1.
- 04.3-24 exec/04.3-24 176a0327.
- 06.2-08 exec/06.2-08. Still to run at merge: check-frontend-design-summary.mjs.
- See also ledger/train37-candidates.md (earlier finishers).

## Paused WIP -> relaunch an executor on the branch with /gsd-resume-work
- 07-42 exec/07-42 2f33fe30. Note: phase dir 07-42-continue-here.md. Left: run-red-team test, rag:red-team script, gates, SUMMARY.
- 04.3-23 exec/04.3-23. Note: 04.3 .continue-here.md. All tasks done; gates left: full vitest, rag-db access/grants, test-rag. SUMMARY committed as WIP.
- 06.2-06 exec/06.2-06. Note: 06.2 .continue-here.md. Left: test-rag runs, full vitest rerun, SUMMARY.
- quick-openrouter exec/quick-openrouter-fallback 0b0dd67d (based on ci/merge-train-36). Note: .planning/quick/2026-11-27-openrouter-fallback/.continue-here.md. Left: vitest, node tests, live verify-route probe, SUMMARY, eval-DB vector compare.
- 05.2.1-12 exec/05.2.1-12 755cc1f. Note: 05.2.1-12-WIP.md. Left: node golden-reader tests, eval pytest, SUMMARY.
- 04.3-09 exec/04.3-09 a63650e. Note: .continue-here-04.3-09.md. Left: wider vitest, 2 node .mts tests, test-rag, SUMMARY.

## Failed by its own plan rule -> needs coordinator decision
- 03.3-25 exec/03.3-25 2872cc98. Hand-offs: handoffs/03.3-25-requirement-*.md. There is no SUMMARY.
  - The templated gates fail: variant, quantity and named_document. TPL-01, TPL-03, TPL-06 and TPL-07 have no passing gate.
  - Cause: the v2 ingest-mode similarity floor, the same root cause as the false-refusal 0.3143.
  - Options: (a) an ingest-mode refusal calibration; (b) re-register the gates on pre-refusal candidates. Recommendation: (a), together with the false-refusal fix.

## Still waiting on prerequisites
- 06.3-14 waits for 07-37.
- 07-37 waits for Phase 6.3 to land plus 06.3-VERIFICATION.

## Executors did not write HANDOFF.json
The executor brief forbids touching HANDOFF*, so each one wrote a phase-level continue-here or WIP note instead.
