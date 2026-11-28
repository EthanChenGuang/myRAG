---
phase: 06-query-layer-llamaindex-langchain
plan: 29
subsystem: rag-eval
tags: [query-layer, eval-route, run-config, fake-llm, d-38, d-39]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-10 createFakeQueryLlm and the transforms.json table; 06-13 StageOverrides.queryLayer, query_plan and the tracer; 06-19 effectiveQueryLayerConfig and the eval-only overlay"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-21 / 04-35 the --run-config overlay allow-list and the last Phase 4 edits of run-eval.mts and run-smoke.mts"
  - phase: 05-verified-citations-groundedness
    provides: "05-22 last Phase 5 edit of the eval route, run-eval.mts and run-smoke.mts"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-19 last Phase 5.1 edit of the eval route and the harness"
provides:
  - "toQueryLayerOverrides(options) in the eval route: query_layer, query_framework, query_transforms, semantic_cache, query_params → StageOverrides.queryLayer"
  - "Trace query_transforms: the searched rewrites plus one entry per considered transform with transform, status and reason"
  - "TraceQueryTransform gains optional transform, status and reason (Pydantic, JSON Schema, Zod)"
  - "Run-config overlay admits the 16 Phase 6 names; enumerated ones are value-checked"
  - "shouldInstallFakeQueryLlm and the fake query LLM install in prepareInProcessEval (InProcessEval.fakeQueryLlm)"
  - "EvalRequestOptions carries the D-38 request fields"
  - "Run configs query-layer-off, query-layer-llamaindex, query-layer-langchain"
affects: [06-34, 06-35, 06-37, 06-41, 06-43, 06-44]

actuals:
  tokens: 13700
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Eval runs that compare two run configs spawn run-smoke.mts per config: the app modules keep the fake edge URL of the first in-process session, so a second session in one process embeds against a closed edge"

key-files:
  created:
    - tests/eval-route-query-layer.test.ts
    - tests/rag-db/eval-query-layer-overlay.test.mts
    - eval/config/runs/query-layer-off.json
    - eval/config/runs/query-layer-llamaindex.json
    - eval/config/runs/query-layer-langchain.json
  modified:
    - src/app/api/internal/rag/run/route.ts
    - src/lib/rag/types.ts
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/schemas/RagTrace.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - rag-sidecar/tests/test_query_contracts.py
    - eval/harness/run-config.mts
    - eval/harness/run-eval.mts
    - eval/harness/run-smoke.mts
    - tests/rag-db/eval-v2-overlay.test.mts
    - tests/rag-db/query-layer-tracer.test.mts

key-decisions:
  - "query_layer keeps the 06-13/06-19 narrowing rule: the override is mapped as given, but enabled=true cannot switch the layer on while the env has it off. Fixture runs turn the layer on through the run-config overlay (RAG_QUERY_LAYER=true), which is the D-38 path"
  - "query_transforms entries: produced variants first (kind = variant kind, as before, now with transform, status 'ok' and the plan reason); then one entry per considered transform without a searched variant (kind 'none', or 'date_range' with 'from..to' for a normalized range), with the stage status and the plan skip reason, else the router reason from the stage detail"
  - "The Phase 4 translate slot records a translate stage on every v2 request; it is listed only when the gate asked for translate (the layer does not handle translate until 06-23)"
  - "A transform with only a plan skip (cap) has no stage record and is listed as status 'skipped'"
  - "query_params null fields and an all-null budget are dropped; an empty query_transforms or query_params object sends no override"
  - "types.ts QueryParamsOverrides now re-exports the partial type from query/query-params.ts (what effectiveQueryParams takes) instead of the generated all-fields-required type"
  - "Run-config Phase 6 names: RAG_QUERY_LAYER, the six transform switches and RAG_SEMANTIC_CACHE_EMBED_STORE must be true|false, RAG_QUERY_FRAMEWORK llamaindex|langchain, RAG_SEMANTIC_CACHE off|pgvector|redisvl; the model id, lists, TTLs and distance are passed through and validated by the app. Legacy RAG_QUERY_ENHANCEMENT and RAG_CACHE_ENABLED stay rejected"
  - "The fake is installed when the effective env after the overlay is v2 with RAG_QUERY_LAYER=true, or when the run's options set query_layer=true; close() restores the previous queryLlm"

patterns-established:
  - "InProcessEval.fakeQueryLlm exposes the installed fake (calls log) to tests"

requirements-completed: [QRY-05, QRY-08, CACHE-01]

coverage:
  - id: D1
    description: "The eval route maps every D-38 override into StageOverrides.queryLayer for the eval profile only; no other API route builds it; absent options send no override"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/eval-route-query-layer.test.ts (10 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The trace lists each considered transform with status and skip reason next to query_plan and validates against RagTraceSchema; query_plan null and query_transforms empty with the layer off"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/eval-route-query-layer.test.ts"
        status: pass
      - kind: integration
        ref: "tests/rag-db/query-layer-tracer.test.mts (3 pass)"
        status: pass
    human_judgment: false
  - id: D3
    description: "--run-config accepts the 16 Phase 6 names, records them in the manifest and the config hash, rejects keys and every other name"
    requirement: CACHE-01
    verification:
      - kind: integration
        ref: "tests/rag-db/eval-query-layer-overlay.test.mts, tests/rag-db/eval-v2-overlay.test.mts, tests/rag-db/eval-sec-overlay.test.mts"
        status: pass
    human_judgment: false
  - id: D4
    description: "In-process runs with the layer on read the fake query LLM; multi_turn items gated for condense carry the scripted standalone; query-layer-off equals v2-all-off per trace and per item"
    requirement: QRY-08
    verification:
      - kind: integration
        ref: "tests/rag-db/eval-query-layer-overlay.test.mts; npm run test-rag -- --run-config eval/config/runs/query-layer-llamaindex.json --no-gate --out eval/out/p6-29-ql"
        status: pass
    human_judgment: false

duration: 120min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 29: Eval overrides and query-layer run configs Summary

**Each eval request can now choose the query layer, the framework, single transforms, the cache backend and the query params, and the trace shows what every transform did. `npm run test-rag --run-config` takes the Phase 6 switches, and every in-process run with the layer on answers query-LLM calls from the deterministic fake.**

## Commits

| Task | Commit |
|------|--------|
| 1 RED | `12a2328` test(06-29): add failing eval-route query-layer override and per-transform trace tests |
| 1 GREEN | `6042007` feat(06-29): map eval query-layer overrides and list each transform's status in the trace |
| 2 RED | `58f3a38` test(06-29): add failing Phase 6 run-config overlay, fake query LLM install and run-config tests |
| 2 GREEN | `c0ad903` feat(06-29): accept Phase 6 switches in run configs, install the fake query LLM and add query-layer run configs |

## Behaviour changes
- Eval route only (`/api/internal/rag/run`): `options.query_layer`, `query_framework`, `query_transforms`, `semantic_cache` and `query_params` now reach the pipeline as `stageOverrides.queryLayer`. The pipeline applies them for the eval profile only (`queryLayerOverrides`). Chat, embed, voice and media never see them.
- Eval trace `query_transforms` entries gain `transform`, `status` and `reason`. A transform that was considered but searched no variant now appears with kind `none`, or kind `date_range` for a normalized range. With the layer off the list stays empty and `query_plan` stays null.
- The run-config overlay accepts the 16 Phase 6 names. The reject message now names the Phase 6 switches.
- In-process eval runs with the layer on install `createFakeQueryLlm` with the committed table. `close()` restores the previous client.
- Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed are untouched. No product route besides the eval route changed.

## RED evidence
- Task 1: 7 of 10 vitest cases failed on assertions (`expected undefined to deeply equal …`, missing entries, no builder found). The tracer's `query_transforms` assertion failed on the missing fields.
- Task 2: 12 cases failed on assertions, or on the `RunConfigError` raised by the old allow-list. `shouldInstallFakeQueryLlm` was stubbed to return false so the module loaded. `eval-v2-overlay` failed on the pinned allow-list and the reject message.

## Deviations
1. **Contract change.** The must-have asks for a status and a skip reason per transform, but `TraceQueryTransform` had only `kind` and `text`. It gains optional `transform`, `status` and `reason` fields, all defaulting to null. Old traces and samples still validate. `npm run gen:schemas` regenerated the JSON Schema, the Zod file and samples.json, and a Pydantic test covers the new fields.
2. **Allow-list file.** The allow-list lives in `eval/harness/run-config.mts` (plan 04-21), not in run-eval.mts, so the names were added there.
3. **`src/lib/rag/types.ts`.** `QueryParamsOverrides` now re-exports the partial type that `effectiveQueryParams` takes. The generated type required every field and did not fit the stripped overrides.
4. **Run comparisons spawn run-smoke.** Two in-process sessions cannot run in one test process: the app modules keep the first fake edge's URL, so the second run fails at embed. The overlay test therefore spawns `run-smoke.mts` once per run config.
5. **Updated existing assertions.** `query-layer-tracer.test.mts` expects the new fields on the condensed entry. `eval-v2-overlay.test.mts` pins the widened allow-list and the new reject message.

## Findings for later plans
- **Italian multi-turn follow-ups are not gated for condense.** With `query-layer-llamaindex`, `it-multi-turn-001` ("Quanto pesa?") hits `R0_TOO_SHORT` and routes to expand. `it-multi-turn-002` (a clitic pronoun) and `it-multi-turn-003` (an ellipsis that opens with "E") trip no rule. So none of the three is condensed, even though transforms.json scripts all three. The en and zh items are condensed as scripted. This is a 06-03 gate lexicon gap, and the multi_turn comparisons in 06-43 and 06-44 will show it. The overlay test asserts on gated items only.
- `query_layer: true` cannot switch the layer on while the env has it off (06-13/06-19 rule). If 06-41 or 06-43 need options-only switching, `effectiveQueryLayerConfig` and `queryLayerActive` are the seam. The route classifies the query only when the env enables the layer.

## Gate results
All gates passed in one full run at `c0ad903`:
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run`: 6,509 passed and 4 skipped.
- `node --import tsx --test tests/*.test.mts`: 172 passed.
- `node --import tsx --test tests/rag-db/*.test.mts`: 1,976 passed.
- Boundary check and its node test: pass.
- `node scripts/check-config.mjs`: pass.
- `check-workflows.py`: pass.
- Sidecar pytest: 1,857 passed and 11 skipped.
- Eval pytest: 1,053 passed.
- `npm run gen:schemas`: no diff.
- `npm run test-rag -- --out eval/out/06-29`: gate PASS, all paired differences zero.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-29-ingest`: gate PASS, all paired differences zero.
- Plan verify: `npm run test-rag -- --run-config eval/config/runs/query-layer-llamaindex.json --no-gate --out eval/out/p6-29-ql` scored 164 items, with no `[Query Layer]` line in the harness log, so no live client was used.

## Operator actions
- None. No live LLM is called. The live LlamaIndex vs LangChain comparison stays with 06-43.

## Deferred
- `query-layer-langchain.json` runs the native transformer until 06-37 wires the LangChain adapter. The plan records the framework that actually ran.
