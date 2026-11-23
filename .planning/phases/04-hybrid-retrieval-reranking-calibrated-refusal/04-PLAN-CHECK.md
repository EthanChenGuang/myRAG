# Phase 4 Plan Check (pass 1)

Verdict: ISSUES FOUND (1 blocker, 2 warnings, 2 info)

## Blockers
1. [dependency_correctness / cross-phase] 04-33 relies on `maxInputTokens` in the Phase 3 embedding registry ("plan 03-21 (active embedding profile and its maxInputTokens from the registry)"), but no Phase 3 plan creates that field (grep of all 50 03-*-PLAN.md: 0 hits). 04-33 Task text says "if it has none, add it there ... as a recorded deviation", yet `src/lib/rag/embeddings/registry.ts` is not in 04-33 files_modified, so the D-21 parity truth depends on an undeclared edit to a Phase 3 file.
   Fix (recommended): 04-33 owns it. Add `src/lib/rag/embeddings/registry.ts` (plus its test) to 04-33 files_modified, make adding `maxInputTokens` per provider an explicit step with acceptance (`grep -c maxInputTokens registry.ts` >= provider count, HEAD=0), and drop the "if" hedging. Do not reopen Phase 3 (it is planned and being executed). No same-wave conflict: wave 9 partner 04-39 does not touch registry.ts.

## Warnings
1. [scope_sanity] 37 of 43 plans have 4 tasks (borderline threshold). Acceptable given the per-plan file split, but expect context pressure in 04-19, 04-23, 04-40.
2. [reversibility] 04-07, 04-15, 04-31, 04-42 are one-way (migrations / setup-file folding) without a checkpoint; CONTEXT D-04/D-20 justify, but 04-42 folds migrations into production setup SQL: ensure its acceptance proves both setup files apply cleanly on PGlite single- and multi-tenant before 04-43.

## Info
1. [parallel hazard] Wave 1 runs 04-06/04-07 (migrations 0401-0406) alongside 04-05 (PGlite roles harness). Safe only because executors use separate worktrees; if run in one tree, sequence 04-05 before 04-06/04-07.
2. [checks passed] Requirement coverage 18/18; D-01..D-33 each mapped; waves equal max(dep)+1 and graph acyclic; no same-wave files_modified overlap (computed); 109 automated checks each with fails_when; 04-34 admin routes use checkAdmin/requireAdminOrDeny with 401/403/503 cases; 04-41 two-tenant matrix covers v2 paths; rerank/translation have no shared caches; 04-40 D-28 baseline comparison gates 04-42; 04-43 has three blocking human-verify checkpoints for live items.
