---
phase: 06-query-layer-llamaindex-langchain
plan: 11
subsystem: contracts
tags: [pydantic, zod, contracts, semantic-cache, codegen]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: RetrievalParams.sub_question_coverage and RetrievalFilters include_undated, already generated (06-05)
  - phase: 06-query-layer-llamaindex-langchain
    provides: rag_sidecar.contracts.cache and GoldenItem pair_of / cache categories (06-09)
provides:
  - JSON Schemas and zod/v3 schemas for CachedAnswer, CacheCheckRequest, CacheCheckResponse, CacheStoreRequest, CacheInvalidateRequest, CacheInvalidateResponse, SemanticCacheCalibration
  - Samples for each, plus variants GoldenItem:cache_near_miss, RetrievalParams:sub_question_coverage_off, CacheCheckResponse:miss, CacheInvalidateRequest:whole_tenant
affects: [06-17, 06-21, 06-30, 06-36]

actuals:
  tokens: 35000
  tasks: 2
  commits: 4
plan_head_before: bda21e3

tech-stack:
  added: []
  patterns:
    - "Requests in validation mode, responses, CachedAnswer and the calibration file in serialization mode"

key-files:
  created:
    - rag-sidecar/tests/test_cache_contract_export.py
    - rag-sidecar/schemas/CachedAnswer.schema.json
    - rag-sidecar/schemas/CacheCheckRequest.schema.json
    - rag-sidecar/schemas/CacheCheckResponse.schema.json
    - rag-sidecar/schemas/CacheStoreRequest.schema.json
    - rag-sidecar/schemas/CacheInvalidateRequest.schema.json
    - rag-sidecar/schemas/CacheInvalidateResponse.schema.json
    - rag-sidecar/schemas/SemanticCacheCalibration.schema.json
  modified:
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

requirements-completed: []
requirements-progressed: [CACHE-01, QRY-04, LAT-03]
---

# Phase 6 Plan 11: Cache contracts to Zod

The seven semantic-cache contracts are now exported. Each has a JSON Schema, a generated zod/v3 schema in `contracts.generated.ts`, and a sample that parses in both Pydantic and Zod. A second `npm run gen:schemas` run changes nothing.

## Commits

| Task | Commits |
|------|---------|
| 1 Register cache contracts and samples | dc90e58 test(06-11): add failing tests for cache contract export and samples; a41ed80 feat(06-11): register semantic-cache contracts with the schema exporter |
| 2 Generate and prove no drift | c4a60ca feat(06-11): generate JSON and Zod schemas for semantic-cache contracts |

## What changed

- `CONTRACTS` lists the cache contracts in these modes:
  - validation: `CacheCheckRequest`, `CacheStoreRequest`, `CacheInvalidateRequest`
  - serialization: `CachedAnswer`, `CacheCheckResponse`, `CacheInvalidateResponse`, `SemanticCacheCalibration`
- The samples use placeholder data only:
  - tenant key `s:default`
  - a 64-character hex key hash (sha256 of a placeholder string)
  - masked query text `How many leave days does [EMAIL] get?`
  - one Phase 5 citation whose quote is `placeholder quote`, with its hash
  - a scored and verified groundedness
  - a calibrated profile whose near-miss wrong-hit rate is 0
- New variants:
  - a `cache_near_miss` golden item with `pair_of`
  - `RetrievalParams` with `sub_question_coverage: false`
  - a cache miss
  - a whole-tenant invalidate (`document_ids: null`)

## Behaviour changes

None at runtime. The changes are generated contract artifacts only. `GoldenItem`, `RetrievalParams` and `RetrievalFilters` already carried the Phase 6 fields from 06-05 and 06-09, so regenerating them produced no change.

## Tests that failed before the fix

- At RED (dc90e58), `tests/test_cache_contract_export.py::test_cache_contracts_are_exported_in_their_modes` failed on an assertion: the models were not in `CONTRACTS`. Two existing tests also failed on assertions at RED, because the samples had no matching contracts: `test_every_model_has_one_schema_one_sample_and_no_self_ref` and `test_null_variants_round_trip_through_pydantic`.
- `test_committed_samples_match_a_fresh_build` failed until Task 2 regenerated `samples.json`.

## Gate results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | 0 diagnostics |
| `npx vitest run` | 4152 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1446 pass, 4 fail, 4 skipped. All 4 failures are in `ingest-mode-routing.test.mts`. Rerun alone, that file passes 13/13. This is the known load flake: this plan touches no TS runtime or SQL |
| `check-rag-boundary` + node test | ok (1159 files), 38 pass |
| `node scripts/check-config.mjs` | ok, 135 variables |
| `check-workflows.py` | OK |
| rag-sidecar pytest | 1387 passed, 11 skipped |
| eval pytest | 726 passed |
| `npm run gen:schemas` | no diff |
| `npm run test-rag -- --out eval/out/06-11` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/06-11-ingest` | gate PASS (7 skipped) |

## Deviations

1. **No GoldenItem, RetrievalParams or RetrievalFilters schema diff.** The plan lists these files as modified, but 06-05 and 06-09 had already regenerated them. The acceptance greps for `sub_question_coverage` and `include_undated` pass on the existing files.
2. **Extra regression test file.** I added `rag-sidecar/tests/test_cache_contract_export.py` so that the export modes and placeholder samples are pinned.

## Note for 06-21 (T-06-20)

JSON Schema cannot express the cross-field validators in `cache.py`, so the generated Zod schemas do not enforce them:
- a hit carries every field, and a miss carries none
- groundedness is scored and verified, or not_checked
- every cited or shown document has a `source_versions` entry
- a refusal has no citations
- calibrated profiles meet their extra requirements

For example, Zod accepts a cached answer with `possibly_unreliable` groundedness. When 06-21 parses sidecar cache responses, it should add these checks as a Zod `superRefine`, or treat any response that breaks them as a miss.

## Decisions for STATE

- D-06-11-a: cache requests are exported in validation mode; responses, `CachedAnswer` and `SemanticCacheCalibration` in serialization mode.
- Requirements progressed: CACHE-01, QRY-04, LAT-03 (contracts only).

## Operator actions

None.

## Deferred

- Runtime parsing of cache responses with the cross-field checks above: plan 06-21.
