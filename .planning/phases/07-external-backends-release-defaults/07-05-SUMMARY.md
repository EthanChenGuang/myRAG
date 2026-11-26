---
phase: 07-external-backends-release-defaults
plan: 05
subsystem: contracts
tags: [pydantic, zod, vector-sync, weaviate, qdrant, eval-trace]

requires:
  - phase: 03-ingestion
    provides: "RagRunOptions.embedding_profile (03-45)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "RetrievalOverrides and RagTrace additions (04-04), report fields (04-26)"
  - phase: 05-verified-citations-groundedness
    provides: "last edits to eval_run.py and the generated files (05-07)"
  - phase: 06
    provides: "last Phase 6 registry edits (06-34)"
  - phase: 05.1-prompt-injection-defense
    provides: "phase close ordering (05.1-22)"
provides:
  - "VectorSyncSliceReport and ReconcileReport (contracts/vector_sync.py): numbers, codes and ids only"
  - "RetrievalOverrides.backend: pgvector | weaviate | qdrant, optional (eval-only override, read by 07-12)"
  - "TraceRetrievalBackend and RagTrace.retrieval_backend with fallback_reason backend_not_ready | backend_error | backend_slow | filter_unsupported | null"
  - "Literals VectorBackend, ExternalVectorBackend (retrieval.py), BackendFallbackReason (eval_run.py)"
  - "Regenerated schema JSON, Zod (VectorSyncSliceReportSchema, ReconcileReportSchema) and samples"
affects: [07-06, 07-07, 07-08, 07-09, 07-10, 07-12, 07-13, 07-14]

actuals:
  tokens: 41000
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "New optional fields on existing contracts use exclude_if=None plus omit_none_schema, so old dumps, config hashes and TS types are unchanged"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/vector_sync.py
    - rag-sidecar/tests/test_vector_sync_contracts.py
    - rag-sidecar/schemas/VectorSyncSliceReport.schema.json
    - rag-sidecar/schemas/ReconcileReport.schema.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/retrieval.py
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - rag-sidecar/schemas/RetrievalOverrides.schema.json
    - rag-sidecar/schemas/RagRunRequest.schema.json
    - rag-sidecar/schemas/RagTrace.schema.json
    - rag-sidecar/schemas/RunManifest.schema.json
    - rag-sidecar/schemas/Baseline.schema.json
    - rag-sidecar/schemas/EvalReport.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "RetrievalOverrides.backend and RagTrace.retrieval_backend are omitted from dumps when unset and have no JSON Schema default, so Zod makes them .optional() rather than .default(null). With .default(null) tsc failed in src/lib/rag/v2/overrides.ts and two tests, and parsed overrides and traces would have gained a null key that changes run-config and trace hashes."
  - "ReconcileReport.tenant_key reuses cache.TENANT_KEY_PATTERN (full lower-case UUID form). It is stricter than the plan's ^(s:default|[uo]:[0-9a-f-]{36})$."
  - "ReconcileReport.target is weaviate | qdrant only, because reconcile compares Supabase with an external backend. profile_id uses BindingProfileId."
  - "TraceRetrievalBackend.tenant_validation_dropped defaults to 0, ge=0."
  - "Samples: VectorSyncSliceReport, ReconcileReport, plus variants RagTrace:retrieval_backend and RetrievalOverrides:backend. All neutral, no domain strings."

patterns-established:
  - "Vector sync and reconcile reports carry no free text; extra keys are forbidden"

requirements-completed: [RET-05, RET-09]

coverage:
  - id: D1
    description: "VectorSyncSliceReport and ReconcileReport reject negative counts, unknown modes, states and targets, bad tenant keys and extra keys"
    requirement: RET-05
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_vector_sync_contracts.py"
        status: pass
    human_judgment: false
  - id: D2
    description: "RetrievalOverrides.backend accepts pgvector, weaviate and qdrant and rejects others; unset it is omitted"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_vector_sync_contracts.py#test_retrieval_overrides_backend"
        status: pass
    human_judgment: false
  - id: D3
    description: "RagTrace.retrieval_backend is optional; fallback reasons are validated; a negative dropped count fails"
    requirement: RET-09
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_vector_sync_contracts.py#test_rag_trace_retrieval_backend_optional_and_validated"
        status: pass
    human_judgment: false
  - id: D4
    description: "Generated Zod and samples are in sync with Pydantic, with no drift"
    verification:
      - kind: unit
        ref: "npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts"
        status: pass
      - kind: other
        ref: "npm run gen:schemas && git diff --exit-code"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-26
status: complete
---

# Phase 7 Plan 05: Vector sync contracts Summary

**This plan adds the Pydantic contracts for the vector sync reports, the eval-only backend override and the trace's backend fallback block, with Zod schemas and samples generated from them. Every addition is optional: existing samples, dumps, hashes and TypeScript callers do not change.**

## Accomplishments
- `contracts/vector_sync.py`:
  - `VectorSyncSliceReport`: mode drain or reconcile, eight non-negative counters and `more_pending`.
  - `ReconcileReport`: counts, a lower-case tenant key pattern, and state building, ready, stale or failed.
- `RetrievalOverrides.backend` and `RagTrace.retrieval_backend` (`TraceRetrievalBackend`) are registered in `__init__` and `export_schemas.py`. Both have samples, and the generated outputs are regenerated.

## Task Commits
1. RED, Task 1 tests: `a1a1d341` test(07-05). 18 tests failed: the module was missing (caught by an assert on `find_spec`), and the new fields were rejected as extra keys.
2. Task 1 GREEN: `2bc64b1c` feat(07-05). Adds the models and fields.
3. Task 2: `085c7510` feat(07-05). Registers the models, adds samples, regenerates the outputs and makes the new fields omit-when-unset.

## Deviations from Plan
- **[Rule 1, bug found during Task 2]** With a plain `= None`, gen-zod emitted `.default(null)` for `backend`. That made the field required in the inferred TS type, and `tsc` failed with 4 errors in `src/lib/rag/v2/overrides.ts`, `tests/rag/v2/exact-id-rrf.test.ts` and `tests/rag/v2/params-hash.test.ts`. It would also have added `backend: null` to parsed overrides. Fix: switch both new fields to the existing omit-none pattern (`exclude_if` plus `omit_none_schema`) and add `test_unset_backend_fields_are_left_out_of_dumps`. The fields stay additive as the plan required.
- Tenant key pattern: stricter than the plan text (see key decisions).
- Besides the four schema files the plan lists, `RunManifest`, `Baseline` and `EvalReport` were regenerated too, because they embed `RagRunOptions` → `RetrievalOverrides`. No hand edits.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run` (full suite, because the shared generated contracts changed): 451 files, 7506 passed, 4 skipped
- `npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts`: 313 passed
- `uv run pytest -q` in rag-sidecar (full suite): 1983 passed, 11 skipped
- eval pytest on the 45 test files that reference contracts, RagTrace or RetrievalOverrides: 938 passed
- `npm run gen:schemas` after the last commit: no diff
- `node scripts/ci/check-rag-boundary.mjs`: ok. `node scripts/check-config.mjs`: ok (192 variables)
- Not run, because their areas were not touched: SQL/rag-db tests, workflows check, `test-rag` (no retrieval, ingest or generation code changed), UI gate.

## Threat mitigations
- T-07-14: the reports hold numbers, codes and ids only, with `extra="forbid"`. Tests reject `last_error` and `note` keys.
- T-07-15: `fallback_reason` is now recorded in RagTrace, so the regression can reject runs that fell back.

## Operator actions / deferred
- None. No env variables, migrations or packages were added. The route and worker that emit these reports, and the use of `backend` by the eval harness, come in later plans (07-06..07-14, 07-12).
