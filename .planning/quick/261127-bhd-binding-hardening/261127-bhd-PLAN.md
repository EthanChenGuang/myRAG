---
quick_id: 261127-bhd
alias: quick-311
branch: exec/quick-311-binding-hardening
base: origin/ci/merge-train-39
source: origin/verify/03.1.1 (aae0e6ed) 03.1.1-VERIFICATION.md and 03.1.1-SECURITY.md
---

# Plan: Phase 3.1.1 verification gaps (code only)

Scope is fixed to seven items from the verification and security reports. Nothing else changes.

1. EMB-10 gap 1: `run-binding-compare.mts --base-url` real-deployment mode. It runs the scoped `rag:reembed` on the real project, the three arms through run-eval `--base-url` with per-arm options, then `binding_compare_cli`. Add a test that live mode never fakes the global profile. Correct the plan 15 Task 3 command line and mark it "corrected by quick-311".
2. T-3.1.1-15b: add a CONCURRENTLY note to the 0440 header (comments only).
3. I-1: one `[RAG Config]` startup warning for `RAG_DOMAIN_EMBEDDINGS=on` with `RAG_INGEST_PIPELINE=legacy`, with the existing admin completeness count.
4. I-2: `record-binding-evidence` accepts only a `BindingComparison` with `population: real`. Write the failing tests first.
5. I-3: add a "re-run 0440 then 0442" note to the 0425 headers and the AGENTS.md migration note.
6. Gap 6: fixture-only `leg_weights.domain` sweep at 0.25, 0.5, 0.75 and 1.0, with the report in `eval/reports/phase-03.1.1/`. No default changes; the recommended value goes in the SUMMARY.
7. Gap 2 (docs): `03.1.1-15-LIVE.md`. Task 2 cites the live migration log; Tasks 1 and 3 are `not_done`. No invented data; grep the file for key-shaped strings.

Gates: tsc, typecheck:new, check-config, check-rag-boundary, gen:schemas (no drift), the binding tests in tests/rag-db (both modes), the related vitest, and eval pytest.
