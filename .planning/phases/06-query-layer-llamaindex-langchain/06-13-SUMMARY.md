---
phase: 06-query-layer-llamaindex-langchain
plan: 13
subsystem: rag-query
tags: [query-layer, tracer, condense, llamaindex, query-plan, eval-route, date-filter, parity]
requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-03 needsRewrite gate; 06-05/06-11 generated QueryPlan, CondensedQuery, RetrievalFilters.include_undated; 06-07 checkCondensed and renderPrompt; 06-10 RagConfig.queryLayer, D-27 timeouts, RagDeps.queryLlm and the fake query LLM"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "v2 query group, queryVariants seam, translate slot, eval route"
provides:
  - "runQueryLayer / QueryLayerOutcome {plan, variants, dateRange, handledTranslate, shortCircuit} (src/lib/rag/query/run-layer.ts)"
  - "QueryTransformer / getQueryTransformer with the native condense (src/lib/rag/query/transformer.ts)"
  - "llamaindexCondense and the vendored llamaindex.condense v1 prompt (MIT)"
  - "buildQueryPlan / planToVariants (src/lib/rag/query/plan.ts)"
  - "mergeLayerDateRange (src/lib/rag/query/layer-filters.ts)"
  - "RunRetrievalInput.history / classification / timeZone; QueryVariant.kind widened (+ legs, subQuestionIndex); RetrievalResult.queryPlan; StageOverrides.queryLayer"
  - "Eval trace query_plan and query_transforms filled from the plan"
affects: [06-14, 06-15, 06-19, 06-20, 06-23, 06-24, 06-26, 06-27, 06-29, 06-32, 06-37]
actuals:
  tokens: 14400
  tasks: 2
  commits: 6
tech-stack:
  added: []
  patterns:
    - "v2 query stage lazily imports run-layer only when config.queryLayer.enabled; the whole outcome is returned as queryLayer so later plans change run-layer.ts and v2/pipeline.ts only"
    - "Optional result fields (queryPlan) are spread in only when present, so layer-off results stay deep-equal to Phase 4"
key-files:
  created:
    - src/lib/rag/query/run-layer.ts
    - src/lib/rag/query/transformer.ts
    - src/lib/rag/query/llamaindex/condense.ts
    - src/lib/rag/query/prompts/llamaindex.condense.v1.json
    - src/lib/rag/query/plan.ts
    - src/lib/rag/query/layer-filters.ts
    - tests/rag-db/query-layer-tracer.test.mts
    - tests/rag/query/condense.test.ts
    - tests/rag/query/layer-filters.test.ts
    - tests/rag/query/parity-off.test.ts
  modified:
    - src/lib/rag/types.ts
    - src/lib/rag/v2/stages/query.ts
    - src/lib/rag/v2/result.ts
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/query/variants.ts
    - src/lib/rag/query/prompts/render.ts
    - src/lib/rag/backend/types.ts
    - src/app/api/internal/rag/run/route.ts
key-decisions:
  - "The condense prompt is LlamaIndex.TS 0.6.23 defaultCondenseQuestionPrompt verbatim, with its {chatHistory}/{question} variables written as {{history}}/{{question}} for the shared renderer (history rendered as the escaped data block)"
  - "A model answer with unchanged=true is a pass-through; the original query is used"
  - "Post-check reason 'empty' maps to the QueryPlan skip reason 'error' (the contract has no 'empty')"
  - "Eval overrides only narrow: queryLayer.enabled=false switches the layer off for eval, transforms.condense=false disables condense; they cannot switch the layer on while the env has it off (06-19 owns the full overlay)"
  - "getQueryTransformer('langchain') returns the native transformer until 06-37; the plan records the framework that actually ran"
  - "mergeLayerDateRange works on the runtime backend RetrievalFilters (camelCase, dateRange.includeUndated) — the type the backend adapter receives; intersection keeps undated rows only when both sides allow them; disjoint ranges become from > to (matches nothing, includeUndated false); a malformed layer range is ignored"
  - "When handledTranslate is true the Phase 4 translate stage is recorded disabled with detail handled_by_query_layer (what 06-23 expects)"
  - "Query-layer stages are not recorded when the gate does not ask for them (condense absent from stage_status for a standalone question)"
patterns-established:
  - "Tracer tests import the fake query LLM dynamically after prepareInProcessEval (its module imports env, which must see the fixture env)"
requirements-completed: [QRY-01, QRY-05, QRY-06, LAT-03]
coverage:
  - id: D1
    description: "A multi_turn follow-up is gated (R1/R5), condensed by the fake query LLM, and the original and condensed variants are both searched through the real route, stage graph, adapter and SQL; the expected chunk is kept; the trace carries query_plan and query_transforms"
    requirement: QRY-01
    verification:
      - kind: integration
        ref: "tests/rag-db/query-layer-tracer.test.mts (3 pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Condense keeps protected tokens verbatim, discards a rewrite that loses one (protected_token_lost), passes standalone questions through without an LLM call, skips at the 600 ms chat timeout and on LLM errors while retrieving the original"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/rag/query/condense.test.ts (7 pass)"
        status: pass
    human_judgment: false
  - id: D3
    description: "mergeLayerDateRange only narrows; the v2 query stage applies the outcome range, variants and handledTranslate"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "tests/rag/query/layer-filters.test.ts (8 pass)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Layer off (unset, false, true under legacy): run-layer.ts never imported, RetrievalResult identical to Phase 4 (trace id and timings excluded); a fourth case proves the throwing mock is live"
    requirement: QRY-06
    verification:
      - kind: unit
        ref: "tests/rag/query/parity-off.test.ts (4 pass)"
        status: pass
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/06-13 (gate PASS, paired.all_zero true)"
        status: pass
    human_judgment: false
duration: 75min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 13: Query-layer tracer Summary

**The first end-to-end query-layer path: under `RAG_PIPELINE=v2` with `RAG_QUERY_LAYER=true`, an eval request with a conversation runs `query_gate`, then the native LlamaIndex condense through the fake query LLM. The original and the condensed query are then searched in parallel through the Phase 4 variant seam, and the trace carries `query_plan`. With the layer off nothing of this is imported.**

## Commits

| Task | Commit |
|------|--------|
| 1 RED | `ececcfd` test(06-13): add failing query-layer tracer through the eval route |
| 1 GREEN | `0483035` feat(06-13): wire the query-layer tracer: gate, native condense, QueryPlan and trace |
| 2 RED | `58b05f6` test(06-13): add failing date-range merge tests, condense and layer-off parity cases |
| 2 GREEN | `f8a7e07` feat(06-13): narrow the date filter with the query layer's range, never widen it |
| lint | `d22f370` test(06-13): drop unused destructured names in the layer tests |

## Behaviour changes

All of them sit behind `RAG_QUERY_LAYER=true`, which only takes effect under v2. The default is off, and off is identical to Phase 4.

- The v2 query group runs `query_gate`, and `condense` when the gate asks for `condense_history`. It runs after `analyze` and before the Phase 4 `translate` stage, and it lazily imports `run-layer.ts`.
- The condensed variant is searched next to the original. `buildQueryVariants` now accepts any non-original provided kind and keeps its kind. The cap of 3 is unchanged; 06-20 widens it.
- `RetrievalResult.queryPlan` is set only when the layer ran.
- The eval route:
  - passes the request conversation as `history`;
  - calls `classifyQuery` once, only when `env.RAG_QUERY_LAYER === 'true'`;
  - writes `query_plan` and `query_transforms` (the non-original variants) to the trace.
- `RetrievalFilters.dateRange` gains an optional `includeUndated`, which only `mergeLayerDateRange` sets. The pgvector adapter does not pass it on yet; that is 06-24.

## Tests that failed before the fix

- Task 1 RED: two of the three tracer cases failed on assertions (`query_plan` was null). The layer-off case passed, as expected.
- Task 2 RED: 5 of the 7 `mergeLayerDateRange` cases failed on assertions against a pass-through stub. The condense and parity cases already passed after Task 1, because Task 1 implemented that behaviour.

## Gate results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 347 files, 5716 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 172 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1795 pass, 1 fail, 4 skipped. The failure is `profile-rpc-two-tenant` "fills the requested count for a small tenant behind a large one (iterative scan)", which failed only under full-suite load. Rerun alone: 5/5 pass. This plan does not touch that RPC or its SQL. |
| `check-rag-boundary` + node test | ok |
| `node scripts/check-config.mjs` | ok, 183 variables |
| `check-workflows.py` | OK |
| `npm run test-rag -- --out eval/out/06-13` | gate PASS (7 skipped), `paired.all_zero` true |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/06-13-ingest` | gate PASS (7 skipped) |
| Python / `gen:schemas` | not run: no Python and no contract was touched |

## Deviations

1. **Three files outside `files_modified`**, each needed for the tracer:
   - `src/lib/rag/query/variants.ts`: provided variants of any non-original kind are kept with their kind. Before, only `translated` was kept. Existing callers see no change.
   - `src/lib/rag/query/prompts/render.ts`: registers the condense prompt in `PROMPT_REGISTRY`.
   - `src/lib/rag/backend/types.ts`: the optional `dateRange.includeUndated`.
2. **`mergeLayerDateRange` uses the runtime backend `RetrievalFilters`** (camelCase), not the generated snake_case contract type. The v2 stages and the adapter (06-24) use the runtime type.
3. **The trace for this plan carries no explicit eval-option mapping.** `RagRunOptions.query_*` are not yet mapped to `StageOverrides.queryLayer`; 06-29 owns that mapping.
4. **The parity test drops stage timings as well as `traceId`** when it compares results, because timings differ on every run.
5. **D-06 "rerank and refusal on the standalone query" is not done here.** 06-20 and 06-25 own it. Refusal and rerank still use the original query.
6. **Not applicable:**
   - The Phase 4.1.1 `terminologyGlossary` hook: 4.1.1 has not executed, so 4.1.1 implements that branch itself (D-40).
   - Stripping markup from chat history: 06-27 owns `buildHistoryWindow`. Eval history has no markup.

## Notes for later plans

- 06-19 adds the full eval override overlay, the router and the parallel group in `run-layer.ts`.
- 06-19 and 06-32 extend `QueryLayerShortCircuit` (`small_talk`, `cache_hit`).
- 06-26 adds a search delegate as a new optional outcome field. `query.ts` needs no change for it.
- The Phase 4.1.1 terminology slot goes inside `runQueryLayer`, after the parallel group and before `semantic_cache`. Nothing in `query.ts` blocks that.

## Decisions for STATE

- The query layer's first slice is live behind `RAG_QUERY_LAYER` (v2 only). Its outcome contract is `QueryLayerOutcome`.
- Eval query-layer overrides can only narrow what the environment enables.

## Operator actions

None. No live LLM call was made; the fake query LLM serves every test.

## Design skills

Not applicable: no UI was touched.
