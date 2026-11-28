---
phase: 06-query-layer-llamaindex-langchain
plan: 14
subsystem: rag-query
tags: [router, query-params, classifier, voice, translate, eval-overrides]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-03 needsRewrite / GateResult; 06-05 QueryParamsSchema and RagRunOptions.query_params; 06-10 QueryLayerConfig"
provides:
  - "routeTransforms({ gate, classification?, config, profile, embeddingProfileId }) → RoutedTransforms { transforms, skipped, skipRetrieval, framework }"
  - "RoutedTransform (stage names), RouteSkip { transform, reason, status: 'disabled' }, RouteSkipReason = disabled | disabled_for_profile | classifier_tool | voice_blocked"
  - "effectiveQueryParams(profile, overrides?) — committed eval/config/query-params.json plus eval-only overrides"
  - "parseCommittedQueryParams, QueryParamsOverrides, resetQueryParamsWarningsForTests"
affects: [06-19, 06-13, 06-20, 06-23, 06-31]

actuals:
  tokens: 45000
  tasks: 2
  commits: 5
plan_head_before: 582e0b5

tech-stack:
  added: []
  patterns:
    - "Pure router: no I/O, no classifier call; the entry point passes its single classifyQuery result in"
    - "Query params loader copies the effectiveRetrievalParams pattern: static JSON import, schema validation at module load, eval-only overrides, warn once"

key-files:
  created:
    - src/lib/rag/query/router.ts
    - src/lib/rag/query/query-params.ts
    - tests/rag/query/router.test.ts
    - tests/rag/query/query-params.test.ts
  modified:
    - src/lib/rag/config.ts
    - tests/rag/config.test.ts

key-decisions:
  - "Routed transforms use the D-05 stage names and order: condense, normalize_dates, translate, expand, hyde, decompose"
  - "hyde is added whenever the gate's expand fires (independent of RAG_QUERY_EXPAND) and then runs only if RAG_QUERY_HYDE is on; otherwise it is recorded disabled"
  - "Every router skip carries status 'disabled' (D-28); reasons: disabled (switch or voice allow-list), disabled_for_profile (D-24), classifier_tool (A-1), voice_blocked (hard-coded D-30)"
  - "Check order per transform: classifier_tool, voice_blocked, voice allow-list, switch, translate profile opt-out"
  - "With RAG_QUERY_LAYER off the router returns no transforms and skipRetrieval false, even for R12 small talk (D-10)"
  - "Voice framework is 'llamaindex' (the native ports; no LangChain import), whatever RAG_QUERY_FRAMEWORK says"
  - "RAG_QUERY_TRANSLATE_DISABLED_PROFILES now holds embedding-profile ids, as D-24, the env manifest and the Config UI help text already say"

requirements-completed: []
requirements-advanced: [QRY-05, QRY-03, QRY-07, LAT-03]

coverage:
  - id: D1
    description: "routeTransforms: gate mapping, hyde, disabled records, classifier A-1 mapping, voice allow-list and hard block, translate profile opt-out, R12 skipRetrieval, layer off"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/rag/query/router.test.ts (15 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Voice runs only condense/normalize_dates/translate from the allow-list, never hyde/expand/decompose, always the native framework"
    requirement: QRY-07
    verification:
      - kind: unit
        ref: "tests/rag/query/router.test.ts#voice"
        status: pass
    human_judgment: false
  - id: D3
    description: "effectiveQueryParams: committed file equals defaults, eval-only overrides, invalid override keeps previous value with one warning, invalid committed file falls back to defaults"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "tests/rag/query/query-params.test.ts (7 cases)"
        status: pass
    human_judgment: false

duration: ~40min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 14: Router and committed query params Summary

**A pure router that turns the gate result, the classifier result, the switches and the profile into the transforms to run, plus the loader for the committed variant limits with eval-only overrides. Neither is wired into a request path yet (06-19 does that), so runtime behaviour is unchanged.**

## Commits

| Task | Commits |
|------|---------|
| 1 routeTransforms | `95a344f` test (RED), `0a5c528` feat |
| 2 effectiveQueryParams | `fb4a5a7` test (RED), `769eba8` feat |
| SUMMARY | this commit |

Both RED commits failed on assertions against stubs (router: 14 of 15 failed; config: 1 failed; query params: 7 of 7 failed), never on module-not-found.

## Behaviour

- `routeTransforms`
  - Gate `condense_history` → `condense`; `normalize_dates`, `decompose`, `expand`, `translate` keep their names. `hyde` joins `expand` only when `RAG_QUERY_HYDE` is on.
  - Classifier (A-1): `tool_required` with `needsMcp` → no transforms, each candidate recorded `classifier_tool`; `multi_step` → adds `decompose`. `conversational`, `complex`, `document_search` and an absent classification change nothing.
  - Voice: only the `RAG_QUERY_VOICE_TRANSFORMS` allow-list intersected with condense, normalize_dates and translate. `expand`, `hyde` and `decompose` are blocked by a constant, even when a config lists them.
  - `translate` is `disabled_for_profile` when the active embedding-profile id is listed in `RAG_QUERY_TRANSLATE_DISABLED_PROFILES`.
  - R12 small talk → `skipRetrieval: true`, no transforms, only while the layer is on.
- `effectiveQueryParams`
  - Reads `eval/config/query-params.json` once at module load and validates it with `QueryParamsSchema`. If the file is invalid, it falls back to the schema defaults and logs one `[Query Layer]` warning.
  - Overrides apply only for profile `eval`, one field at a time. An invalid value (for example `max_searches: 9`) keeps the previous value and logs one warning per field and value. Nested `query_budget_ms` entries are merged per entry profile.
  - Returns a fresh copy, so callers cannot mutate the committed limits.

## Deviations

1. **Bug fix in `src/lib/rag/config.ts` (not in files_modified).** 06-10 parsed `RAG_QUERY_TRANSLATE_DISABLED_PROFILES` as pipeline profiles (`chat`, `voice`, …) and dropped everything else, so an embedding-profile id such as `openai-3-small-1536` could never be listed. D-24, the env manifest and the Config UI help text all define it as embedding-profile ids. It now keeps ids that match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, de-duplicates them, and drops malformed entries with one `[Query Layer]` warning. `QueryLayerConfig.translateDisabledProfiles` is now `string[]`. The old test in `tests/rag/config.test.ts` asserted the wrong semantics and was replaced; the new one fails on the old code. Nothing else read the field.
2. **Extra exports:** `parseCommittedQueryParams` (to test the invalid-file fallback without a second JSON file), `resetQueryParamsWarningsForTests`, `QueryParamsOverrides`, `RouteInput`, `RouteSkip`, `RouteSkipReason`.
3. **Skip reasons are router-internal.** `QueryPlan.skipped.reason` has no `disabled`, `classifier_tool` or `voice_blocked`. 06-19 maps router skips to trace fields; only `disabled_for_profile` exists in the contract.

## Gate results

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 346 files, 5719 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 172 passed, 0 failed
- `node --import tsx --test tests/rag-db/*.test.mts`: 1793 passed, 0 failed, 4 skipped (the known skips)
- `check-rag-boundary` ok (1329 files); its node test 39 passed
- `check-config`: ok, 183 variables; `check-language-literals`: ok
- `check-workflows.py`: OK
- `npm run test-rag -- --out eval/out/06-14`: gate PASS, all paired differences zero
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-14-ingest`: gate PASS
- Python suites, `gen:schemas` and the UI gate: not run (no Python, contract or UI files touched)

## Decisions for STATE

- The router's transform names are the D-05 stage names, in D-05 order.
- Router skips are always `disabled`, never `degraded` (D-28).
- `RAG_QUERY_TRANSLATE_DISABLED_PROFILES` holds embedding-profile ids.

## Operator actions

None.

## Deferred

- Wiring `routeTransforms` and `effectiveQueryParams` into the query stages and the trace: 06-19.
- Phase 4.1.1 terminology stage: the router only selects transforms and does not order stages in `src/lib/rag/v2/stages/query.ts`, so the slot after the parallel group and before `semantic_cache` stays open.
