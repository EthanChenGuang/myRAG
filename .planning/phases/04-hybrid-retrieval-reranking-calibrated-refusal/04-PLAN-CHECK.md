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

## Re-check (pass 2)

Checked at 08ecb01 (45 plans). Verdict: ISSUES FOUND (0 blockers, 1 warning, 1 info). No revision of existing tasks needed beyond warning 1.

### Pass-1 items
- Blocker 1 (04-33 maxInputTokens): RESOLVED. registry.ts and registry.test.ts are in 04-33 files_modified; truth line 35 gives 8191/32000/32768 unconditionally; acceptance `grep -cE "maxInputTokens:[[:space:]]*[0-9]+" registry.ts` >= 3; validate.ts uses maxInputTokensFor.
- Warning 1 (size): RESOLVED. Every plan has 2-3 tasks; 04-44 (w3) and 04-45 (w3) split out; 04-19/23/40 have 2 tasks.
- Warning 2 (04-42 setup proof): RESOLVED. Per-mode `--test-name-pattern` runs requiring `# fail 0` and >= 3 passes.
- Info 1: RESOLVED (note present in 04-05/06/07).

### Deep checks
- Acceptance at HEAD: ran all 177 grep/test acceptance lines from every plan (waves 1-14). All fail today. Only three exit 0, and each fails its threshold: 04-34 admin-guard count prints 0 (needs >= 3), 04-37 doc_type count 0 (needs >= 13), 04-38 no_answer 12 (needs >= 24). The four `test -f && grep -v | grep -c` gates now exit 1.
- Legacy gating: 04-21 reads retrievalFilters only under isV2Pipeline; 04-31 dual-write only when `pipeline === 'v2'`, with a named case `RAG_PIPELINE=legacy skips dual-write`. The two locked exceptions have legacy-unchanged proofs: 04-03 (D-07/D-08) runs both legacy smoke tiers with `.paired.all_zero == true` and sends only whole/joined id forms to exact-id; 04-01 (D-33) runs tests/rag-legacy-differential + two-tenant with a guard mutation. Operator CLIs, admin routes and the Config UI are explicit actions.
- Security re-scan: no Access-Control-Allow-Origin, no key value printed, no query or chunk text logged in any plan.
- Structural (computed): every depends_on exists; wave > every dependency's wave; acyclic; no files_modified overlap between any two plans unless one is an ancestor of the other (covers same-wave and cross-wave). 111 automated checks, 111 fails_when. RET/RNK/CHK/LAT/XLG/DATA: 18/18 covered; D-01..D-33 each cited.

### Dual-write judgment
Acceptable: D-23 is locked, and the 04-33 `incomplete` refusal stops a profile missing documents from being activated. One gap remains (warning 1).

### Warnings
1. [context_compliance / reversibility] Required property: a v2 deployment with a non-legacy active chunking profile never silently drops current documents from retrieval. Evidence: 04-31 truth line 30: "a document uploaded meanwhile is missing from that profile until rag:rechunk". `incomplete` is checked only at activation (04-33 line 109). If an operator activates under v2, switches RAG_PIPELINE to legacy (the documented rollback), uploads documents and returns to v2, those documents have no children in the active profile, and nothing in 04-15/04-17/04-34/04-36 detects this. Example fix (non-binding): add a coverage check (v2 startup or the admin status route) that reports documents with no children in the active profile, plus a 04-31 test for this sequence, or have hybrid_search_chunks fall back to legacy rows for those documents.

### Info
1. [acceptance grounding] Many gates fail at HEAD only because Phase 3 files are absent (e.g. src/lib/rag/embeddings/registry.ts, src/lib/rag/types.ts). Their HEAD notations are measured on that state. Re-baseline them after Phase 3 lands, before execution.
