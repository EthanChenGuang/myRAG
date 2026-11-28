---
phase: 06-query-layer-llamaindex-langchain
plan: 20
subsystem: rag-query-layer
tags: [query-variants, rrf, hyde, dense-only, caps, d-06, d-08]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: 06-13 plan.ts / planToVariants and widened QueryVariant kind, 06-14 query params (max_searches and group limits)
  - phase: 04-hybrid-retrieval-reranking
    provides: 04-24 variants.ts and the translation seam, 04-29 last edit of search.ts
  - phase: 05.1-prompt-injection-defense
    provides: 05.1-06 last Phase 5.1 edit of types.ts
provides:
  - buildQueryVariantSet, buildQueryVariants (limits argument), queryLayerVariantLimits, QUERY_LAYER_VARIANT_ORDER, PHASE4_VARIANT_LIMITS, variantDenseTexts (src/lib/rag/query/variants.ts)
  - QueryVariant.legs ('both' | 'dense') and QueryVariant.denseText; Candidate.standaloneSimilarity; FusedHit.standaloneSimilarity
  - SearchStagesInput.trackStandalone; fusedToCandidate exported from src/lib/rag/v2/stages/context.ts
affects: [06-19, 06-24, 06-25, 06-32, 04.1.1-07]

actuals:
  tokens: 70000
  tasks: 2
  commits: 5
plan_head_before: 18beab3

tech-stack:
  added: []
  patterns:
    - "Variant limits are data ({ cap, order, groupLimits }); the layer passes the query-params limits, everything else the Phase 4 defaults"
    - "Query-layer-only fields are set only when the layer ran, so layer-off candidates and traces are byte-identical"

key-files:
  created:
    - tests/rag/v2/variants-fusion.test.ts
  modified:
    - src/lib/rag/types.ts
    - src/lib/rag/query/variants.ts
    - src/lib/rag/query/plan.ts
    - src/lib/rag/v2/stages/query.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/v2/stages/context.ts
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/fusion/rrf.ts

key-decisions:
  - "QueryVariant.legs is 'both' | 'dense' (research Pattern 5, matching the hyde/expand/decompose modules); the 06-13 Array<'dense'|'lexical'> form had no users and was replaced"
  - "Group limits: translated <= max_translations, sub_question <= max_sub_questions, expanded + hyde <= max_llm_variants (default 2 = the plan's 'at most 2 together'); condensed is not counted in the builder (06-19 enforces max_llm_variants at generation)"
  - "Duplicates (same text after NFKC/lowercase/trim) keep the first in preference order and are not recorded as cuts; each capped variant adds one { transform, reason: 'cap' } entry (condensed->condense_history, translated->translate, sub_question->decompose, expanded->expand, hyde->hyde)"
  - "Cuts are appended to queryLayer.plan.skipped as a new plan object; the layer's plan object is not mutated"
  - "standaloneSimilarity is set only with the query layer on (pipeline passes trackStandalone when query.queryLayer exists): condensed dense list, else original, 0 when the chunk is missing from it"

requirements-completed: [QRY-02, QRY-03, QRY-05, LAT-03]

duration: ~1h
completed: 2026-11-25
---

# Phase 6 Plan 20: Variant caps, dense-only HyDE, one embedding batch, one fusion

**Query-layer variants now flow through the Phase 4 parallel-variant seam with the D-08 caps and order. All dense texts go into one embed batch. HyDE searches the dense leg only. Fusion is still a single `rrf` call.**

## Accomplishments

- `buildQueryVariantSet(query, language, translated, provided, limits)` returns `{ variants, cuts }`. With the layer on, `runQueryStages` passes `queryLayerVariantLimits(effectiveQueryParams(...))`: cap `max_searches` (8), order original, condensed, translated, sub_question, expanded, hyde, and the group limits. Every cut goes onto the plan's `skipped` list with reason `cap`. With the layer off, the Phase 4 cap of 3 and the caller order are unchanged: the translation-seam tests pass without edits.
- `planToVariants` maps `hyde` to `legs: 'dense'` and every other kind to `'both'`, and keeps `subQuestionIndex`.
- The embed stage embeds `variantDenseTexts(variants)` (`denseText ?? text`) in its existing single `embedQueries` call. That is one provider batch call when the profile's provider has one.
- `runSearchStages` sends no lexical tokens for a `legs: 'dense'` variant, so RRF gets `dense:i` but no `lexical:i` for HyDE. Translated variants keep `lexicalLanguages`. All variants are still searched in parallel under the stage signal and fused by one `rrf` call.
- With the layer on, fused hits carry `standaloneSimilarity`, taken from the condensed variant's dense list (or the original's when there is no condensed variant). It is copied onto `Candidate` in `fusedToCandidate` and in the eval pre-refusal candidates, ready for the rerank and refusal rules of 06-25.

## Task Commits

1. Task 1 RED: `574b3e3` test(06-20): add failing tests for query-layer variant caps, order and legs
2. Task 1 GREEN: `ee24d3f` feat(06-20): cap query-layer variants at max_searches in D-08 preference order
3. Task 2 RED: `cdfb24a` test(06-20): add failing tests for one embed batch, dense-only HyDE and standalone similarity
4. Task 2 GREEN: `cca09e7` feat(06-20): dense-only HyDE, denseText embedding and standalone similarity in v2 search
5. SUMMARY (this commit)

Both RED commits failed on assertions (9/11, then 6/21), not on missing modules.

## Deviations

- **The embedding stays in the pipeline's embed stage, not in `runSearchStages`.** The plan's Task 2 action says to embed inside `runSearchStages`. At HEAD the v2 pipeline already embeds every variant in one `embed` stage call (`embedForRetrieval` → `embedQueries`), and moving it would change the stage trace and timing. The change is in `pipeline.ts`, which now passes `variantDenseTexts`. The "one batch call of 5 texts" test runs at the `embedQueriesForEvalProfile` seam with a batch-capable profile. With embedding profiles off, the legacy embedder still embeds texts in parallel, one call per text, as in Phase 4.
- **`buildQueryVariants` keeps its array return type**, and the new `buildQueryVariantSet` returns the cuts. This keeps the Phase 4 callers and tests unchanged.
- **Files outside `files_modified`:** `src/lib/rag/v2/stages/query.ts` (passes the limits and appends the cuts), `src/lib/rag/v2/pipeline.ts` (dense texts, `trackStandalone`, pre-refusal candidates), `src/lib/rag/v2/stages/context.ts` (copies the field onto `Candidate`; `fusedToCandidate` is now exported for the test) and `src/lib/rag/fusion/rrf.ts` (type-only: optional `FusedHit.standaloneSimilarity`; there is still only one fusion function).
- The plan's 10-variant fixture (1 + 1 + 2 + 4 + 1 + 1) would cut both expanded and hyde at cap 8. So the "hyde cut" case uses 3 sub-questions (9 variants), and a separate case checks that both are cut with 4.
- `query-params.ts` is imported dynamically inside the layer branch, like `run-layer.ts`, so the layer-off path loads no new module.

## Phase 4.1.1 slot

`QUERY_LAYER_VARIANT_ORDER` is a plain list. 04.1.1-07 can insert `terminology` between `sub_question` and `expanded` and add a group without changing the builder's algorithm. Kinds that are not listed sort last in caller order. No terminology stage exists on this branch yet: 04.1.1 has not been executed.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 373 files, 6264 passed, 4 skipped
- `node --import tsx --test tests/*.test.mts`: 172 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 1863 pass, 0 fail, 4 skipped (includes query-layer-tracer and v2-tracer)
- `check-rag-boundary` ok, plus its node test (52 pass); `check-config` ok (190 variables); `check-workflows` OK
- `npm run test-rag -- --out eval/out/06-20`: gate PASS (7 skipped); `--fixture-mode ingest --out eval/out/06-20-ingest`: gate PASS (7 skipped)
- No Python, contract or UI changes, so the sidecar/eval pytest, `gen:schemas` and frontend-design gates do not apply.

## Threats

- T-06-43: the hard cap comes from `max_searches`, whose ceiling of 8 is enforced by the schema validator, and every cut is traced in `plan.skipped`.
- T-06-44: variants carry text and legs only. Scope, filters and the signal come from the request and are shared by every backend call (unchanged).

## Operator actions / deferred

None. 06-19 (layer orchestration) supplies the expanded, hyde and sub-question variants into the seam that this plan caps. 06-24 sets `denseText` for the R2 date suffix. 06-25 reads `standaloneSimilarity`.
