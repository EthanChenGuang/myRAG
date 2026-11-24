---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 21
subsystem: api
tags: [rag, eval, harness, zod, pydantic, filters, routes]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: contracts (04-04), fake rerank endpoints (04-10), parseRetrievalFilters (04-14), v2 pipeline (04-19)
provides:
  - eval route maps options.retrieval_overrides and options.retrieval_filters and writes the v2 trace fields
  - harness --run-config with an env allow-list, eval overrides and golden-item filters
  - eval/config/runs/v2-all-off.json and v2-recommended.json
  - optional retrievalFilters on the chat and embed bodies under RAG_PIPELINE=v2 (legacy never reads it)
affects: [04-23, 04-25, 04-30, 04-35, 04-39, 04-40]

actuals:
  tokens: 16300
  tasks: 3
  commits: 9
plan_head_before: 7a9b96f230c61545dbd2f6469ec5992b1ea4cbd5
plan_head_after: c262b267d2e1ae3ae53c219b4812408c577f7a16

tech-stack:
  added: []
  patterns:
    - "Snake_case eval filters are converted once to the camelCase body shape and validated by parseRetrievalFilters, so the eval route, chat and embed share one validator"
    - "Run configs are named {name, env, overrides} files; env is allow-listed, overrides go through the generated RetrievalOverridesSchema"

key-files:
  created:
    - eval/harness/run-config.mts
    - eval/config/runs/v2-all-off.json
    - eval/config/runs/v2-recommended.json
    - src/lib/rag/v2/switch.ts
    - tests/eval-route-v2.test.ts
    - tests/rag-db/eval-v2-overlay.test.mts
    - tests/rag/v2/route-filters.test.ts
  modified:
    - src/app/api/internal/rag/run/route.ts
    - src/app/api/chat/route.ts
    - src/app/api/embed/chat/route.ts
    - src/lib/rag/index.ts
    - src/lib/rag/v2/overrides.ts
    - eval/harness/run-eval.mts
    - eval/harness/run-smoke.mts
    - rag-sidecar/src/rag_sidecar/contracts/retrieval.py
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - src/lib/rag-eval/contracts.generated.ts

key-decisions:
  - "The wire contract gained two optional fields (RetrievalOverrides.rerank_model, RunManifest.run_config) because the plan's v2-recommended run and manifest record could not be expressed with the strict 04-04 schemas"
  - "In the trace, v2-only fields (refusal, retrieval_config_hash, context_tokens, query_language, retrieval_versions) are written only when the result carries retrievalConfigHash, so a legacy trace is unchanged"
  - "refused is true when assembly flagged it or the gate decided refuse; refusal_reason follows the record (below_threshold, below_similarity_floor) and falls back to no_relevant_context"
  - "Run-config env allow-list is RAG_PIPELINE plus the 12 D-23 RAG_* switches; keys, base URLs, RAG_EXACT_ID_LOOKUP, RAG_RETRIEVAL_PARAMS_OVERRIDE, RAG_DISABLED_STAGES and everything else exit 2"

patterns-established:
  - "Route and trace code reaches LEXICAL_VERSION, RERANK_TEXT_VERSION, countTokens, parseRetrievalFilters and isV2Pipeline through the @/lib/rag index (the boundary check rejects deep imports)"

requirements-completed: [DATA-08, RNK-02, RNK-05]

coverage:
  - id: D1
    description: "Eval route carries retrieval_overrides and retrieval_filters and writes refusal, refusal_reason, retrieval_config_hash, context_tokens, stage_counts and per-candidate rerank_score, fused_score, legs, language"
    requirement: RNK-05
    verification:
      - kind: unit
        ref: "tests/eval-route-v2.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Harness --run-config: env allow-list, overrides, manifest and config-hash record, golden filters; v2-all-off and v2-recommended run configs"
    requirement: RNK-02
    verification:
      - kind: unit
        ref: "tests/rag-db/eval-v2-overlay.test.mts"
        status: pass
      - kind: integration
        ref: "npm run test-rag -- --run-config eval/config/runs/v2-all-off.json --no-gate --out eval/out/p4-21-v2-all-off"
        status: pass
    human_judgment: false
  - id: D3
    description: "retrievalFilters on the chat and embed bodies under v2 (400 on invalid), ignored under legacy"
    requirement: DATA-08
    verification:
      - kind: unit
        ref: "tests/rag/v2/route-filters.test.ts"
        status: pass
    human_judgment: false

duration: 47min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 21: Connect v2 to its callers Summary

**v2 is reachable from the eval endpoint with overrides, filters and refusal-aware traces, comparison runs are named harness configs, and chat and embed accept validated retrievalFilters only under RAG_PIPELINE=v2.**

## Accomplishments

- Eval route: `options.retrieval_overrides` becomes `stageOverrides.retrievalOverrides`, `options.retrieval_filters` goes through `parseRetrievalFilters` (400 `{success:false, error, details}` before retrieval), and the trace carries `refusal`, `refusal_reason` (`below_threshold`, `below_similarity_floor`, `no_relevant_context`), `retrieval_config_hash`, `context_tokens` (cl100k_base), `stage_counts`, `query_language`, `retrieval_versions` and per-candidate `rerank_score`, `fused_score`, `legs`, `language`. A legacy result produces the same trace as before.
- Harness: `--run-config <file>` with `{name, env, overrides}`. Env is applied after the pinned env and before the route import; overrides are validated with `RetrievalOverridesSchema` and sent as `options.retrieval_overrides` on every request; a golden item's `retrieval_filters` is sent as `options.retrieval_filters`. The overlay and overrides are recorded in the manifest (`run_config`, `request_options.retrieval_overrides`) and change the run config hash and the effective config hash. A name outside the allow-list exits 2 with `[Eval Harness] run-config may only set RAG_PIPELINE and Phase 4 RAG_* switches`.
- `eval/config/runs/v2-all-off.json` (RAG_PIPELINE=v2 only) and `v2-recommended.json` (lexical, Cohere against `fake-quality-v1`, refusal, edge order).
- Chat and embed: `isV2Pipeline()` (new, exported from `@/lib/rag`); under v2 `body.retrievalFilters` is parsed before scope resolution, an invalid value returns 400 JSON with CORS headers on embed, a valid one is passed to `runRetrieval`. Under legacy the field is not read and `runRetrieval` receives no `retrievalFilters` key.

## Task Commits

| Task | Commit | Subject |
| ---- | ------ | ------- |
| contract RED | 7cb7679 | test(04-21): RED for rerank_model override and run_config manifest field |
| contract GREEN | 69ec2b5 | feat(04-21): rerank_model override and run_config manifest record in the eval contracts |
| 1 RED | e597211 | test(04-21): RED for eval route overrides, filters and v2 trace fields |
| 1 GREEN | c727bff | feat(04-21): eval route carries retrieval overrides, filters and v2 trace fields |
| 2 RED | 7cd6dad | test(04-21): RED for harness run configs, overlay allow-list and golden filters |
| 2 GREEN | b0c087f | feat(04-21): harness --run-config with env allow-list, eval overrides and golden filters |
| 3 RED | eca68cc | test(04-21): RED for retrievalFilters on the chat and embed bodies |
| 3 GREEN | 8dd945d | feat(04-21): validated retrievalFilters on the chat and embed bodies under v2 |
| 2 follow-up | c262b26 | fix(04-21): refuse a run-config env overlay on a retained in-process session |

Each RED commit failed on assertions (stubs were added where a module did not exist yet).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The 04-04 wire contract could not carry what the plan needs**
- **Found during:** Task 2 design
- **Issue:** `RetrievalOverrides` is strict and has no model field, so `v2-recommended.json` could not override `rerank_model` to `fake-quality-v1` (the fake edge serves only `fake-` models; calibration cells in 04-30 are keyed on that id). `RunManifest` is strict and had no place for the env overlay, which the plan says must be recorded in the manifest.
- **Fix:** Added optional `RetrievalOverrides.rerank_model` and `RunManifest.run_config` (`RunConfigRecord {name, env, overrides}`) to the Pydantic models and regenerated the schemas, `samples.json` and `contracts.generated.ts` with `uv run --frozen` and `scripts/gen-zod.mjs` (no package installed). Additive and optional; older manifests and requests still validate. The eval route maps `rerank_model` to `rerankModel`, which `select.ts` already honours for the eval profile only.
- **Files modified:** rag-sidecar/src/rag_sidecar/contracts/{retrieval,eval_run}.py, rag-sidecar/schemas/*, tests/fixtures/contracts/samples.json, src/lib/rag-eval/contracts.generated.ts, rag-sidecar/tests/test_retrieval_contracts.py
- **Commits:** 7cb7679, 69ec2b5

**2. [Rule 3 - Blocking] Regenerated types broke two existing literals**
- **Issue:** `ApiRetrievalOverrides` now requires `rerank_model`, so `evalRetrievalOverrides` (v2/overrides.ts) and two literals in tests/rag/v2/params-hash.test.ts no longer type-checked.
- **Fix:** `rerank_model: overrides.rerankModel ?? null` in the mapper; `rerank_model: null` in the two test literals. Params and hashes are unchanged (effectiveRetrievalParams ignores the field).
- **Commit:** c727bff

**3. [Rule 3 - Blocking] Boundary check rejects deep imports**
- **Fix:** `@/lib/rag` now also exports `LEXICAL_VERSION`, `RERANK_TEXT_VERSION`, `countTokens`, `RetrievalFilterInput` and `isV2Pipeline`.
- **Commits:** c727bff, 8dd945d

**4. [Rule 2 - Missing critical] Overlay silently ignored on a retained session**
- **Fix:** `runEval` throws a `RunConfigError` when a run-config env overlay is combined with `retainInProcess` or `--base-url`, since the overlay can only be applied when the in-process session is prepared.
- **Commit:** c262b26

### Choices where the plan was silent

- Run-config `env` allow-list excludes `RAG_EXACT_ID_LOOKUP`, `RAG_RETRIEVAL_PARAMS_OVERRIDE`, `RAG_DISABLED_STAGES` and `RAG_STAGE_TIMEOUTS` (not D-23 names); `RAG_PIPELINE` must be `legacy` or `v2`. Unknown top-level keys in a run config are rejected.
- The harness does not call `verifyV2Startup()`: against the fake edge its extension probe would record an unsupported request and fail the run on `edge_errors`; the default verdict is `ok`.
- The CLI wiring tests in `tests/rag-db/eval-v2-overlay.test.mts` (`run-smoke` exit 2 cases) were added after the wiring rather than before it.

## Verification

- `npx vitest run tests/eval-route-v2.test.ts tests/eval-route-auth.test.ts tests/eval-route-profile.test.ts tests/eval-harness.test.ts tests/rag/v2`: pass.
- `node --import tsx --test tests/rag-db/eval-v2-overlay.test.mts`: 19 pass.
- chat and embed characterization (`tests/rag/characterize-*.test.ts`), `tests/rag/embed-route.test.ts`, `tests/rag/v2/route-filters.test.ts`: 9 files, 67 tests pass (base run of the characterization set: all pass too, so no new failures).
- `npm run test-rag` (legacy smoke): gate PASS, `paired.all_zero == true`.
- `npm run test-rag -- --run-config eval/config/runs/v2-all-off.json --no-gate --out eval/out/p4-21-v2-all-off`: 114 traces, manifest `run_config` {name v2-all-off, env RAG_PIPELINE=v2}.
- `node scripts/ci/check-rag-boundary.mjs`: ok, no violations. `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `node scripts/check-config.mjs`: ok. `python3 scripts/ci/check-workflows.py`: OK.
- Full `npx vitest run`: 31 failures in 5 files, none new: tests/ingest-queue-contracts.test.ts (BackfillManifestEntry), tests/legacy-post-filter-sentinel.test.ts and tests/rag/documents-versions.test.ts (same 28 failures on base 7a9b96f, `rag_relex_candidates` rpc and a pinned assemble hash) and tests/rag/injection-scan.test.ts (1 MB timing budget, passes when run alone).
- rag-sidecar pytest: 618 pass; failures only from the missing `docling_core` and the uv warning text in test_boot. eval pytest: 348 pass; failures only from missing `deepeval` and `ragas`.

## Known Stubs

None.

## Deferred Issues / Observations

- **v2-all-off scores near zero on the fixture** (recall@5 0.013, false_refusal 0.987): 112 of 114 items are refused with `below_similarity_floor` because the fallback floor is the legacy 0.65 (D-30) while fixture embedder similarities are about 0.3. The wiring is correct; this is a calibration matter for 04-30 and 04-39 and should be kept in mind when reading the v2-all-off reference run (research F-9).
- `v2-recommended.json` already runs end to end on the fixture (rerank `ok` on all 114 traces) because the rerank stage is present on this base; the plan's per-trace assertion belongs to 04-23.
- `retrieval_config_hash` still builds `reranker.model` from the provider id rather than the resolved model, so a `rerank_model` override does not change the hash; that belongs to the rerank-stage plan (04-23).

## Threat Flags

None. `retrieval_overrides` exist only on the authenticated eval route (T-04-41); the chat and embed bodies accept filters only (narrow-only, validated, T-04-43); the run-config overlay is allow-listed and recorded (T-04-42).

## Self-Check: PASSED

Created files and all nine commits were checked present on `exec/04-21`.
