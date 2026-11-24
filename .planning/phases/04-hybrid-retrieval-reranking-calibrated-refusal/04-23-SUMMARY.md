---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 23
subsystem: rag
tags: [rerank, v2-pipeline, refusal-gate, deadline, cohere, local-bm25]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: resolveReranker and rerankText (04-45), Cohere and Voyage adapters (04-09), local_bm25 and fake reranker (04-10), rank group with gate and floor (04-20), run configs (04-21), context stage rerank hook (04-22)
provides:
  - rerank stage in the v2 rank group, ahead of the refusal stage, with a request-deadline-capped timeout
  - fail-safe skip on timeout, HTTP error, partial response, missing key and exhausted budget (fused order kept, run degraded, threshold refusal off for the request)
  - rerank outcome (scores, spans, prefix lengths) threaded from runRankStages through runV2Pipeline into the context stage; candidates carry rerank_score
  - retrieval_config_hash built from the resolved rerank model
affects: [04-24, 04-25, 04-28, 04-30, 04-34, 04-39]

actuals:
  tokens: 9800
  tasks: 2
  commits: 3
plan_head_before: 96ec63378737fb89a435888b7ab2c257a6ae57ae
plan_head_after: 2df19e684e8e16e3f562887b177b00832626ebc5

tech-stack:
  added: []
  patterns:
    - "The rerank StageSpec is built at call time: timeout = min(stage timeout, deadline - elapsed - reserve), skipped below the floor"
    - "applyRefusal returns the final record plus the threshold gate's own record, so a not_applied gate reason stays visible when the similarity floor decides"

key-files:
  created:
    - tests/rag/v2/rerank-stage.test.ts
  modified:
    - src/lib/rag/v2/stages/rank.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/v2/stages/context.ts
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/v2/result.ts
    - src/lib/rag/rerank/select.ts

key-decisions:
  - "Missing key, unresolved factory and budget exhaustion record the stage as skipped (so the run is degraded, as D-11 requires) and hand the gate a reranker descriptor with status skipped, giving not_applied reranker_unavailable; none and a disabled stage hand it null, giving reranker_disabled"
  - "The final refusal decision stays the similarity-floor record when the gate is not applied; the gate's own record is exposed as RankStagesOutput.gate (reason reranker_unavailable etc.)"
  - "Rerank usage from the vendor is recorded as stage counts usage_<key> (Cohere: usage_search_units)"
  - "describeReranker (select.ts) resolves provider and model without building an adapter or reading a key, and feeds the config hash"

patterns-established:
  - "Eval cells are fixture-sourced, so calibrated-gate tests run on the eval profile with a thresholds spy"

requirements-completed: [RNK-01, RNK-06, LAT-02, XLG-03]

coverage:
  - id: D1
    description: "Rerank stage: score order with fused-rank ties, counts rerank_input and capped_from, usage, hosted reranker gets the original query and the rerank text"
    requirement: RNK-01
    verification:
      - kind: unit
        ref: "tests/rag/v2/rerank-stage.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fail-safe: timeout, HTTP 503, partial, missing key and budget_exhausted skip the stage and degrade the run with the gate not_applied reranker_unavailable; abort is aborted; none is disabled"
    requirement: RNK-06
    verification:
      - kind: unit
        ref: "tests/rag/v2/rerank-stage.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Voice deadline: timeout min(250, 800 - elapsed - 50), skipped below an 80 ms remainder without a vendor call"
    requirement: LAT-02
    verification:
      - kind: unit
        ref: "tests/rag/v2/rerank-stage.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "local_bm25 receives the document-language query variant per candidate; calibrated cell refuses below_threshold at 0.4 and answers at 0.7"
    requirement: XLG-03
    verification:
      - kind: unit
        ref: "tests/rag/v2/rerank-stage.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "v2-recommended run against the fake edge: rerank ok on all 114 traces, candidates carry rerank_score"
    requirement: RNK-01
    verification:
      - kind: integration
        ref: "npm run test-rag -- --run-config eval/config/runs/v2-recommended.json --no-gate --out eval/out/p4-23-v2-rec"
        status: pass
    human_judgment: false

duration: 40min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 23: Rerank stage Summary

**The v2 rank group now reranks the deduped, capped list through `resolveReranker` with a deadline-capped timeout, keeps the fused order and switches threshold refusal off for the request when the vendor is unavailable, and feeds real rerank scores to the calibrated gate.**

## Accomplishments

- `runRankStages` runs the rerank stage before the refusal stage. It resolves the reranker for the profile and query language (chat, embed and eval use the chat tier, voice the voice tier), builds the text with `rerankText`, sends the original query to hosted rerankers and a per-document query (document-language variant from the query group, else the original) as `queryByDoc` to `local_bm25`, orders by score with ties in fused order, and records `rerank_input`, `capped_from` (from the dedupe counts) and vendor usage as stage counts.
- Failure handling: timeout, HTTP error, partial response (incomplete scores), missing key and `budget_exhausted` record the stage `skipped`, keep the fused order, degrade the run, and give the gate `not_applied reranker_unavailable`, so the similarity floor (D-30) decides. A request abort is recorded `aborted` and propagates as a `StageError` (the pipeline already maps it to an aborted failure). `RAG_RERANKER=none` records the stage `disabled`, not degraded.
- Deadline (F-23): for voice, timeout is `min(stage timeout, 800 - elapsed - 50)`; below an 80 ms remainder the stage is recorded `skipped` / `timeout` / `budget_exhausted` and the vendor is not called. Chat, embed and eval have no deadline, only the stage timeout (600 ms, eval 60000 ms).
- Rerank scores, spans and codepoint prefix lengths pass from `runRankStages` through `runV2Pipeline` into `runContextStages` (the 04-22 hook), and candidates carry `rerank_score`; `kept_by` becomes `rerank`. Eval pre-refusal candidates are in rerank order with scores.
- The placeholder no-op `rerank` stage in `search.ts` is removed; the real stage lives in the rank group. This is also why 04-21 saw `rerank ok` on every trace before this plan.
- `retrieval_config_hash` now uses the provider and model the request resolves to (`describeReranker`), so a `rerank_model` override (and a Voyage per-language model) changes the hash (the 04-21 deferred item). With `RAG_RERANKER=none` the hash input is unchanged.
- Switches off (`RAG_RERANKER=none`, the default): the stage is recorded `disabled`, order and refusal inputs are untouched, so output is unchanged.

## Task Commits

| Task | Commit | Subject |
| ---- | ------ | ------- |
| 1 RED | 74c4a87 | test(04-23): failing tests for the v2 rerank stage, deadline and calibrated routing |
| 1 GREEN | 0eaaf0f | feat(04-23): rerank stage with deadline-capped timeout and fail-safe skip (D-11, F-23) |
| 2 | 2df19e6 | test(04-23): v2-recommended run config validates and selects Cohere against the fake quality model |

The RED commit had all 14 tests failing on assertions (no module-not-found).

## Task 2 progress note (not a gate)

`npm run test-rag -- --run-config eval/config/runs/v2-recommended.json --no-gate --out eval/out/p4-23-v2-rec` against the fake edge (Cohere adapter, `fake-quality-v1`): 114 traces, `stage_status.rerank` is `ok` on all 114 and every trace's first candidate carries `rerank_score`; stage counts show `rerank_input` 71, `capped_from` 71, `usage_search_units` 1. The `jq` check exits 0.

Overall: recall@5 0.013, recall@10 0.013, MRR 0.013 (n=77), correct_refusal 1.000 (n=9), false_refusal 0.987 (n=77). These equal the v2-all-off reference: no threshold cell is calibrated, the gate is `not_applied`, and the legacy 0.65 similarity floor refuses 112 of 114 items because fixture embedder similarities are about 0.3 (research F-9; calibration belongs to 04-30 and 04-39). The numbers say nothing about rerank quality until a calibrated cell or a floor adjustment exists.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Placeholder rerank stage in `search.ts`**
- **Issue:** `runSearchStages` already recorded a no-op `rerank` stage (always `ok`), which would have produced a second `rerank` record and, in `RAG_RERANKER=none`, a record the rank group could not own.
- **Fix:** removed the placeholder; the rank group owns the stage. File was not in `files_modified`.
- **Commit:** 0eaaf0f

**2. [Rule 3 - Blocking] Threading files outside `files_modified`**
- `pipeline.ts` (pass `variants`, `dedupeCounts`, `rerank`, pre-refusal `rerank_score`), `context.ts` (`scoreByChunk` on `ContextRerankInput`, `rerank_score` on candidates), `result.ts` and `select.ts` (`describeReranker` for the config hash). The plan lists only `rank.ts` and the test, but the 04-22 summary requires the pass-through and the 04-21 summary assigns the hash fix here.
- **Commit:** 0eaaf0f

### Choices where the plan was silent

- The final refusal record stays the floor's when the gate is not applied; the gate's own `reranker_unavailable` record is returned as `RankStagesOutput.gate` and asserted in tests. It is not written into the refusal stage detail.
- Eval `overrides.reranker` (not on the wire contract, only the internal `StageOverrides`) cannot switch a config-`none` request to a vendor, because `RAG_RERANKER=none` puts `rerank` in the disabled-stage set and `stageSpec` reads that. The wire contract only carries `rerank_model`, so this is unreachable from the eval route.
- With no candidates the reranker is not called; the stage records `ok` with zero counts.
- Gate candidate language maps only `zh`, `en`, `it`; any other document language is treated as same-language.

## Verification

- `npx vitest run tests/rag/rerank tests/rag/v2`: 13 files, 131 tests pass (15 in `rerank-stage.test.ts`; plan floor was 9).
- `npx vitest run tests/rag/v2`: 8 files, 93 tests pass.
- `node scripts/ci/check-rag-boundary.mjs`: ok, 969 files, no violations.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: exit 0, no errors.
- `node scripts/check-config.mjs`: ok, 122 variables (no new env variable, so nothing to mirror).
- `node --import tsx --test tests/rag-db/eval-v2-overlay.test.mts tests/rag-assemble-differential.test.mts`: 22 pass. `npx vitest run tests/eval-route-v2.test.ts tests/eval-route-profile.test.ts tests/eval-harness.test.ts`: 21 pass.
- `npx vitest run tests/rag`: failures only in `tests/rag/documents-versions.test.ts` (27, the pre-existing `rag_relex_candidates` rpc and pinned-hash failures noted in the 04-21 summary on base) and one timing assertion in `tests/rag/lexical-tokenize.test.ts` (1033 ms vs 1000 ms under load; passes when the load is lower, unrelated to this plan).
- Task 2 harness run and `jq` check: exit 0 (above). The tracked fixtures were not modified (`git status` clean; `eval/out` is ignored).

## Deferred Issues

- Calibrated end-to-end refusal on the fixture needs threshold cells (04-30, 04-39); until then the floor decides and v2 scores near zero on the fixture.
- `retrieval_config_hash` values change for any non-`none` reranker configuration (the model replaces the provider id in the hashed payload). No committed fixture pins such a hash; recorded run manifests from before this plan will not compare equal.
- Per-trace gate reason (`reranker_unavailable`) is only on the stage output, not yet in the eval trace; a trace field would belong to the trace plans.

## Known Stubs

None.

## Threat Flags

None. T-04-45 mitigated: deadline-capped timeout, `budget_exhausted` skip, no retries (the 503 test asserts one fetch call). T-04-46 accepted: chunk text reaches a vendor only when `RAG_RERANKER` is not `none`; logs carry no text and the missing-key warning names the variable only.

## Self-Check

- `tests/rag/v2/rerank-stage.test.ts`, `src/lib/rag/v2/stages/rank.ts` - FOUND
- Commits `74c4a87`, `0eaaf0f`, `2df19e6` - FOUND on `exec/04-23`
- `grep -c budget_exhausted src/lib/rag/v2/stages/rank.ts` = 1 (>= 1)

## Self-Check: PASSED
