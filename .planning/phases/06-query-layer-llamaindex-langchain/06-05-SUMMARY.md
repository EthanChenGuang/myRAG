---
phase: 06-query-layer-llamaindex-langchain
plan: 05
subsystem: contracts
tags: [pydantic, zod, json-schema, query-layer, strict-structured-output, codegen]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: rag_sidecar.contracts.query models, RagRunOptions query overrides, RagTrace.query_plan (06-01)
  - phase: 05.1-prompt-injection-defense
    provides: last Phase 5.1 edits of samples.py, export_schemas.py and the generated files (05.1-03, 05.1-24)
provides:
  - JSON Schemas for RewriteGateResult, QueryPlan, CondensedQuery, QueryVariants, HypotheticalDocument, SubQuestions, QueryTranslation, QueryParams
  - Zod schemas in src/lib/rag-eval/contracts.generated.ts (RewriteGateResultSchema, QueryPlanSchema, CondensedQuerySchema, QueryVariantsSchema, HypotheticalDocumentSchema, SubQuestionsSchema, QueryTranslationSchema, QueryParamsSchema)
  - Samples for each, plus variants RagTrace:query_plan and RagRunRequest:query_overrides
affects: [06-09, 06-10, 06-11, 06-13, 06-14, 06-15, 06-19, 06-34, 06-41]

actuals:
  tokens: 30000
  tasks: 2
  commits: 4
plan_head_before: 80e8668

tech-stack:
  added: []
  patterns:
    - "Query models exported in the mode the plan fixed: LLM outputs, QueryParams and RewriteGateResult in validation mode, QueryPlan in serialization mode"
    - "Trace and request query-layer shapes are covered as sample variants, so the existing primary samples stay byte-stable"

key-files:
  created:
    - rag-sidecar/tests/test_query_contract_export.py
    - rag-sidecar/schemas/{RewriteGateResult,QueryPlan,CondensedQuery,QueryVariants,HypotheticalDocument,SubQuestions,QueryTranslation,QueryParams}.schema.json
  modified:
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "The four D-38 eval overrides in the RagRunRequest sample are query_framework, query_layer, query_transforms and semantic_cache. query_params is set as well. cache_seed_answer is left out because refusing it in production belongs to 06-41."
  - "The RagTrace and RagRunRequest query-layer samples are variants, not replacements of the primary samples"

requirements-completed: []
requirements-advanced: [QRY-06, QRY-08, LAT-03]

coverage:
  - id: D1
    description: "Eight query contracts registered in their planned mode, each with a sample that round-trips through Pydantic; LLM-output schemas fully required with additionalProperties false and no $defs"
    requirement: QRY-06
    verification:
      - kind: unit
        ref: "uv run --directory rag-sidecar pytest -q tests/test_query_contract_export.py tests/test_contract_export.py tests/test_contract_models.py"
        status: pass
    human_judgment: false
  - id: D2
    description: "Generated Zod accepts every sample and variant; a second gen:schemas run is byte-identical"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "npm run gen:schemas && git diff --exit-code && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts && node --test scripts/tests/gen-zod.node-test.mjs"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-11-25
---

# Phase 6 Plan 05: Query contract export Summary

**The eight query-side Pydantic contracts now have generated JSON Schemas, Zod schemas and samples. A second `npm run gen:schemas` run leaves every file byte-identical.**

## Commits

| Task | Commit |
|------|--------|
| RED (both tasks) | `54337e7` test(06-05): add failing tests for query contract export and samples |
| 1 Register contracts and samples | `68137ee` feat(06-05): register query-side contracts and their samples for export |
| 2 Generate schemas and Zod | `35c3bb2` feat(06-05): generate JSON Schemas and Zod for query-side contracts |

The RED commit failed on assertions: four tests failed with `AssertionError`, none with an import error.

## Behaviour changes

- Codegen output only. The contract count went from 65 to 73. No runtime path imports the new Zod schemas yet.
- `RagRunRequest.schema.json` and `RagTrace.schema.json` did not change. 06-01 had already regenerated them with the new optional fields.
- `samples.json` gained 8 samples and 2 variants. The primary samples did not change.

## Gate results

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: 0 diagnostics
- `npx vitest run`: 254 files, 4093 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 166 passed
- `node --import tsx --test tests/rag-db/*.test.mts`: 1262 passed, 4 failed, 4 skipped in the full run.
  - The 4 failures were all in `ingest-mode-routing`. The sidecar worker could not download the tiktoken `cl100k_base` encoding: Python `requests` does not trust this container's proxy CA (`SSLCertVerificationError`). This is environmental and unrelated to this plan.
  - Rerun alone with `REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE` set to the proxy CA bundle: 13 passed, 0 failed.
  - The skips are the known ones: three single-tenant skips by design, plus `ingestion-ledger-pg`, which skips as root (pre-existing).
- `check-rag-boundary` and its node test (38 passed): OK
- `check-config`: OK, 125 variables
- `check-workflows`: OK
- rag-sidecar pytest: 1340 passed, 11 skipped
- eval pytest: 702 passed
- `npm run gen:schemas`: no diff
- `test-rag` (both modes): not run. This plan changes no retrieval, ingest or golden-set code; it only adds codegen output and samples.

## Deviations

1. **Added test file:** the plan lists no tests. Following the TDD rule, I added `rag-sidecar/tests/test_query_contract_export.py`. It checks four things: registration mode, strict structured-output shape (A-5), that each sample round-trips and keeps `ERR_TIMEOUT` verbatim, and the two query-layer variants.
2. **RagRunRequest/RagTrace schemas not regenerated here:** the plan lists them as modified, but 06-01 already regenerated them (its deviation 4), so this run produces no diff for them.
3. **No migration:** none needed.

## Decisions for STATE

- The query-side Zod schemas are generated only. Plans 06-09 onward import them from `src/lib/rag-eval/contracts.generated.ts` and never hand-write them.
- The five LLM-output schemas (CondensedQuery, QueryVariants, HypotheticalDocument, SubQuestions, QueryTranslation) are tested to be strict-output compatible: every property is required, `additionalProperties` is false and there are no `$defs`. The LangChain adapter can pass these files to `withStructuredOutput` as-is.

## Operator actions

None.

## Deferred

- Cache, golden and retrieval-field schemas: plan 06-11. Report and latency schemas: plan 06-34.
- Still open from 06-01: whether eval may disable `translate`, which is not in the Pydantic `StageName`.
