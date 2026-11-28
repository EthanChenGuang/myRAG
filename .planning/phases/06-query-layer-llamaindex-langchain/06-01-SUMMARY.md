---
phase: 06-query-layer-llamaindex-langchain
plan: 01
subsystem: contracts
tags: [pydantic, contracts, query-layer, strict-structured-output, eval-config]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: retrieval.py (RetrievalParams, RetrievalFilters, ConfigProvenance), config_files init (04-04)
  - phase: 05-citations-groundedness
    provides: last edits of contracts/__init__.py (05-01) and eval_run.py (05-07)
  - phase: 05.1-prompt-injection-defense
    provides: last Phase 5.1 edits of eval_run.py and contracts/__init__.py (05.1-03, 05.1-24)
provides:
  - rag_sidecar.contracts.query (RewriteGateResult, DateRange, QueryVariantOut, SkippedTransform, QueryPlan, CondensedQuery, QueryVariants, HypotheticalDocument, SubQuestions, QueryTranslation, QueryParams, QueryParamsOverride, QueryBudgetMs, QueryBudgetMsOverride, QueryTransformToggles)
  - StageName / StageTimeoutsMs gain query_gate, condense, normalize_dates, expand, hyde, decompose, semantic_cache
  - RagRunOptions gains query_framework, query_layer, query_transforms, semantic_cache, query_params, cache_seed_answer (all default None)
  - RagTrace.query_plan
  - RetrievalParams.sub_question_coverage (default true); DateRangeFilter.include_undated (default false)
  - eval/config/query-params.json written by `python -m rag_eval.config_files init`
affects: [06-05, 06-09, 06-10, 06-11, 06-13, 06-14, 06-15, 06-19, 06-29, 06-41]

actuals:
  tokens: 60000
  tasks: 2
  commits: 5
plan_head_before: 463894d

tech-stack:
  added: []
  patterns:
    - "LLM-output models: every field required, no defaults, extra forbid, list caps of 4 (strict structured output, A-5/P-4)"
    - "D-08 caps enforced twice: Field(le=...) so the JSON Schema and generated Zod carry them, plus a model_validator shared by QueryParams and QueryParamsOverride"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/query.py
    - rag-sidecar/tests/test_query_contracts.py
    - eval/config/query-params.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/src/rag_sidecar/contracts/retrieval.py
    - eval/src/rag_eval/config_files.py
    - eval/tests/test_config_files.py
    - eval/config/retrieval-params.json
    - rag-sidecar/schemas/{Baseline,EvalReport,GoldenItem,RagRunRequest,RagTrace,RetrievalFilters,RetrievalParams,RunManifest}.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "query.py takes _Contract from contracts/retrieval.py, not golden.py: golden imports eval_run, which now imports query (circular import)"
  - "QueryParams carries schema_version, provenance and config_hash like the other committed eval config files, so finalize_config and the init overwrite guard apply"
  - "query-params.json sits second in CONFIG_TARGETS (after retrieval-params) because init stops at the calibrated refusal-thresholds.json; later it would never be written in this repo"
  - "QueryPlan.variants max 8 (the hard search cap); a sub_question variant needs sub_question_index, other kinds must not carry one, and the index must point into sub_questions"
  - "SkippedTransform.transform is the five gate transforms plus hyde"
  - "disabled_stages max_length follows len(StageName) (17) instead of a literal"
  - "Existing schemas, Zod and samples regenerated so `npm run gen:schemas` leaves no diff; new query models are not added to the export list (plan 06-05)"

requirements-completed: []
requirements-advanced: [QRY-01, QRY-02, QRY-03, QRY-04, QRY-05, QRY-06, LAT-03, XLG-01]

coverage:
  - id: D1
    description: "RewriteGateResult, QueryPlan, five strict-output LLM models, QueryParams D-08 caps"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "uv run --directory rag-sidecar pytest -q tests/test_query_contracts.py"
        status: pass
    human_judgment: false
  - id: D2
    description: "Stage names, RagRunOptions overrides, RagTrace.query_plan, retrieval fields, committed samples still validate"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "uv run --directory rag-sidecar pytest -q tests/test_query_contracts.py tests/test_contract_models.py"
        status: pass
    human_judgment: false
  - id: D3
    description: "config_files init writes query-params.json with sorted keys, schema_version 1, idempotent; committed file equals defaults"
    requirement: QRY-06
    verification:
      - kind: unit
        ref: "uv run --directory eval pytest -q tests/test_config_files.py"
        status: pass
    human_judgment: false

duration: ~70min
completed: 2026-11-25
---

# Phase 6 Plan 01: Query-layer contracts Summary

**Every Phase 6 query-layer shape now lives in Pydantic: gate result, query plan, strict-output LLM models, D-08 params, eval overrides and the trace field. `eval/config/query-params.json` is committed.**

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1 Query contracts | `40f2413` test(06-01): add failing tests for query-layer contracts | `a8c6a07` feat(06-01): add query-layer Pydantic contracts |
| 2 Stages, overrides, retrieval fields, query-params.json | `c058435` test(06-01): add failing tests for query stages, run options and query-params.json | `b986afc` feat(06-01): add query stages, eval overrides, retrieval fields and query-params.json |

The RED commits fail on assertions. Task 1's RED commit ships an empty `query.py`, and the tests look models up with `getattr`, so nothing fails on an import error.

## Behaviour changes

- Contracts only. No runtime path reads the new fields yet. Every new `RagRunOptions` field defaults to `None`. `include_undated` defaults to `false`. `sub_question_coverage` defaults to `true` and is not read anywhere yet.
- `eval/config/retrieval-params.json` gained `"sub_question_coverage": true` and a new `config_hash`. `init` rewrites a defaults-provenance file, and `test_module_entrypoint_refuses_the_committed_calibrated_files` requires the committed bytes to match what `init` writes. The TS `retrievalConfigHash` input therefore changes. Both `test-rag` gates still pass.
- The generated JSON Schemas, `contracts.generated.ts` and `samples.json` now include the new optional fields (as `null` in samples).

## Gate results

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: 0 diagnostics
- `npx vitest run`: 254 files, 4077 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 166 passed
- `node --import tsx --test tests/rag-db/*.test.mts`: 1266 passed, 4 skipped. Three are single-tenant skips by design. The fourth is `ingestion-ledger-pg`, which skips as root (known, pre-existing).
- `check-rag-boundary` and its node test (38 passed), `check-config` (125 variables), `check-workflows`: OK
- rag-sidecar pytest: 1336 passed, 11 skipped; eval pytest: 702 passed
- `npm run gen:schemas`: no diff
- `npm run test-rag -- --out eval/out/06-01`: gate PASS (7 skipped)
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-01-ingest`: gate PASS (7 skipped)

## Deviations

1. **Circular import (Rule 3):** `golden.py` imports `eval_run.py`, so `query.py` takes `_Contract` from `retrieval.py` (same config: extra forbid, frozen).
2. **retrieval-params.json rewritten:** the plan expected it "unchanged". It still validates without edits, but the init idempotence test forces the committed bytes to match `init`. The file now has the new default field and a new hash.
3. **`translate` not in the Pydantic StageName:** the plan says it was added in Phase 4. It is in the TS `StageName` (`src/lib/rag/config.ts`) but not in the Pydantic eval `StageName`. Only the seven planned names were added. Plans 06-05 and 06-10 should decide whether eval may disable `translate`.
4. **Generated files regenerated here**, not in 06-05: the executor gate requires `gen:schemas` to leave no diff. The new query models are still not exported (06-05 adds them and their samples).
5. **`python -m rag_eval.config_files init` exits 1 in this repo:** it refuses the calibrated `refusal-thresholds.json` (pre-existing behaviour, covered by an existing test). It writes retrieval-params and query-params before it stops.

## Decisions for STATE

- The Pydantic gate model is `RewriteGateResult` (P-2). The TS alias `GateResult` is allowed only inside `src/lib/rag/query/`.
- `QueryParams` is a provenance-stamped committed config, like `retrieval-params.json`. Eval-only overrides go through `RagRunOptions.query_params` (`QueryParamsOverride`, same caps).
- `cache_seed_answer` is at most 4,000 characters in the contract. Refusing it in production is the eval route's job (06-41).

## Operator actions

None.

## Deferred

- Exporting the query models to JSON Schema and Zod, with samples: plan 06-05.
- Cache contracts: plan 06-09.
