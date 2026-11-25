---
phase: 06-query-layer-llamaindex-langchain
plan: 25
subsystem: rag-query-layer
tags: [rerank, refusal, hyde, sub-question-coverage, d-06, d-07]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: 06-11 RetrievalParams.sub_question_coverage (zod), 06-20 QueryVariant.subQuestionIndex, FusedHit/Candidate.standaloneSimilarity
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: 04-23 rank stage (rerank, threshold gate, similarity floor)
provides:
  - reserveSubQuestionCoverage, MAX_SUB_QUESTION_RESERVATIONS (src/lib/rag/v2/subq-coverage.ts)
  - RankStagesInput.queryPlan and RankStagesInput.coverage; refusal stage count `subq_reserved` (only when decomposition ran)
affects: [06-26, 06-29, 06-44, RET-13 diversify]

actuals:
  tokens: 60000
  tasks: 2
  commits: 6
plan_head_before: aae1f56

tech-stack:
  added: []
  patterns:
    - "Query-layer-only rank inputs are passed only when query.queryLayer exists, so layer-off rank output and trace counts are unchanged"

key-files:
  created:
    - src/lib/rag/v2/subq-coverage.ts
    - tests/rag/v2/subq-coverage.test.ts
    - tests/rag/v2/rerank-standalone.test.ts
  modified:
    - src/lib/rag/v2/stages/rank.ts
    - src/lib/rag/v2/pipeline.ts

key-decisions:
  - "Coverage works on FusedHit.ranks (list ids dense:i / lexical:i → variants[i].subQuestionIndex), the same keys Candidate.legs is built from, because the reservation runs in the rank stage before candidates exist"
  - "Best candidate of a sub-question = the first pool entry in post-rerank order that a list of that sub-question ranked; already-in-top-k chunks are skipped"
  - "A reservation replaces the lowest-ranked top-k entry that is not the only cover of another sub-question; if none qualifies, reservation stops. Reserved chunks fill the freed slots in pool order; displaced entries move to the head of the rest of the list"
  - "max is clamped to 4 whatever the caller passes; sub-questions are served in index order"
  - "Final top-k = params.final_top_k (chat, embed, eval) or the voice match count (voice)"
  - "Under the layer the per-document reranker query (local_bm25 queryByDoc) is the standalone query for every document; translated and generated texts never reach the reranker"
  - "Under the layer the similarity floor (similarity and legacy_rule) reads standaloneSimilarity (0 when the standalone list missed the chunk); the legacy_rule terms come from the standalone query"
  - "Coverage runs inside the refusal stage callback, after the decision, so a refused request reserves nothing and the count lands on the refusal record; RET-13 diversify, when added, goes before reserveSubQuestionCoverage"

requirements-completed: [QRY-03, QRY-04]

duration: ~1h
completed: 2026-11-25
---

# Phase 6 Plan 25: Sub-question coverage and standalone rerank and refusal

**With the query layer on, the rerank query and the refusal floor use only the standalone query. When decomposition ran, the final top-k keeps one chunk for each sub-question. HyDE and other variants can widen recall, but they cannot turn a no-answer item into an answer.**

## Accomplishments

- `reserveSubQuestionCoverage(topK, pool, variants, { enabled, max })` reserves the best pool chunk for each uncovered sub-question. It makes at most 4 reservations, never duplicates a chunk, never displaces the only chunk covering another sub-question, and returns its input unchanged when coverage is off or there are no sub-questions.
- `runRankStages` takes `queryPlan` and `coverage`. When a plan exists:
  - the reranker gets `queryPlan.standalone`, and `queryByDoc` holds the standalone query for every document;
  - the similarity floor reads `standaloneSimilarity`;
  - after the decision, coverage is applied over the final top-k and `subq_reserved` is recorded on the refusal stage.
- The pipeline passes both inputs only when the query layer ran (`coverage.enabled = params.sub_question_coverage`). With the layer off, the rank call is identical to Phase 4's.

## Task Commits

1. Task 1 RED: `012e709` test(06-25): add failing tests for sub-question coverage reservation (5 of 7 failed on assertions, against a pass-through stub)
2. Task 1 GREEN: `ccd8bbe` feat(06-25): reserve the best chunk of each uncovered sub-question in the final top-k
3. Task 2 RED: `ed00a86` test(06-25): add failing tests for standalone rerank, standalone refusal floor and coverage in the rank stage (4 of 5 failed on assertions)
4. Task 2 RED (wiring): `a1fe955` test(06-25): add failing pipeline test for plan and coverage reaching the rank stage (failed on the rerank query assertion)
5. Task 2 GREEN: `976e5a6` feat(06-25): rerank and refuse on the standalone query, reserve sub-question coverage in the rank stage
6. SUMMARY (this commit)

## Tests that failed before the change

- The rank stage sent the raw original query to the reranker even when the plan had a condensed standalone query.
- A no-answer fixture whose only high similarity came from the HyDE dense list was answered (`hit.similarity` 0.95) instead of refused (`standaloneSimilarity` 0.1).
- A compound question whose second sub-question ranked below the final top-k lost that sub-question's chunk.

## Deviations

- **[Rule 2 - wiring] `src/lib/rag/v2/pipeline.ts` modified (not in files_modified).** Without it, `runRankStages` never receives the plan or the coverage settings, so the must-haves would hold only in unit tests. One added pipeline test (`tests/rag/v2/rerank-standalone.test.ts`, second describe) runs `runRetrieval` with a mocked query layer and proves the wiring.
- **Function input type.** The plan names `Candidate.legs`. The function uses `FusedHit.ranks`, which has the same keys, because the reservation runs before candidates are built.
- **Translated variants are excluded from the reranker under the layer**, as the must-have says ("never a HyDE, expanded or translated text"). With the layer off, Phase 4's per-language `queryByDoc` for `local_bm25` is unchanged.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 390 files, 6512 passed, 4 skipped, 0 failed
- `node --import tsx --test tests/*.test.mts`: 172 passed, 0 failed
- `node --import tsx --test tests/rag-db/*.test.mts`: 1964 passed, 0 failed
- RAG boundary check plus its node test: pass
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: pass
- `npm run test-rag -- --out eval/out/06-25` and `npm run test-rag -- --fixture-mode ingest --out eval/out/06-25-ingest`: both pass (exit 0)
- No Python, contract, env or UI changes, so the sidecar and eval pytest, `gen:schemas` and frontend-design gates do not apply.

## Threat model

- T-06-55 (HyDE false answers): mitigated. Rerank and the floor read only the standalone query and its similarity, and the no-answer fixture case covers this.

## Decisions for STATE

- With the query layer on, rerank and refusal read the standalone query only (D-06).
- D-07 coverage runs after refusal inside `runRankStages`. RET-13 diversify must be inserted before `reserveSubQuestionCoverage`.

## Operator actions

None.

## Deferred

None.
