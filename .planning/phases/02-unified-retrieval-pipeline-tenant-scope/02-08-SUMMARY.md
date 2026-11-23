---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 08
subsystem: retrieval
tags: [stage-runner, abort-signal, timeouts, status-semantics, trace-collector, rag-trace]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: RAG_PIPELINE / RAG_DISABLED_STAGES / RAG_STAGE_TIMEOUTS env entries (02-03); tracer pipeline, injected deps, scope brand (02-07)
provides:
  - runStage with per-stage timeout, request-signal composition and trace recording
  - deriveStatus implementing D-05 with the adjustment that config-disabled stages are `disabled`, not `degraded`
  - loadRagConfig (pipeline, disabled stages, per-profile timeouts) with one-time `[RAG Config]` warnings
  - in-request trace collector and one content-free `[RAG Trace]` line via finishTrace
affects: [02-09, 02-10, 02-16, 02-19, 02-20, 02-22]

requirements-completed: [PIPE-06, PIPE-07, OBS-01]

actuals:
  tokens: 14300
  tasks: 3
  commits: 6
plan_head_before: 55c07ff3ea5e2152479b4b5b606318a13c83a95f
plan_head_after: f7aadc86c7a3b74f94c0310c0ab8c508ff63b5dd

tech-stack:
  added: []
  patterns:
    - "Stage signal = AbortSignal.any([request signal, AbortSignal.timeout(ms)]); the stage promise is raced against that signal so a stage that ignores it still times out, and signal.throwIfAborted() runs after every await because postgrest resolves on abort"
    - "Config is a pure function of an env snapshot (loadRagConfig(env)), memoised per snapshot, warnings deduplicated per distinct problem in a module Set"
    - "Trace log line is built from a fixed field whitelist, so query and chunk text cannot reach the sink"

key-files:
  created:
    - src/lib/rag/config.ts
    - src/lib/rag/trace/collector.ts
    - src/lib/rag/trace/log.ts
    - src/lib/rag/trace/finish.ts
    - tests/rag/config.test.ts
    - tests/rag/stage-runner.test.ts
    - tests/rag/status.test.ts
    - tests/rag/trace-log.test.ts
    - tests/rag/helpers/pipeline-fakes.ts
  modified:
    - src/lib/rag/pipeline.ts
    - src/lib/rag/types.ts
    - src/lib/rag/deps.ts
    - src/lib/rag/index.ts
    - src/lib/rag/query/temporal-query-detector.ts

key-decisions:
  - "Stage statuses are ok | skipped | disabled | error | timeout | aborted. An optional stage that fails or times out is `skipped` with a reason; a core stage is error/timeout/aborted. deriveStatus: any error/timeout/aborted record gives error, else any skipped record gives degraded, else zero survivors gives empty, else ok. `disabled` records never count"
  - "Result reasons: embed_failed, embed_timeout, search_timeout, search_failed, aborted, backend_error, no_tenant, no_candidates, and `<stage>_<reason>` of the first skipped stage for degraded (for example legacy_rank_timeout)"
  - "A RetrievalBackendError in the search stage keeps the 02-07 reason backend_error (pinned by the differential test) rather than the plan's search_failed; any other search failure is search_failed"
  - "runRetrieval finishes the trace only when it created the collector. A caller that passes `trace` (the eval route, later assembly stages) finishes it itself after its own stages"
  - "RagDeps gained ragEnv() so the pipeline reads config through an injectable env snapshot (default from the typed env module); tests inject RAG_* values without touching process.env"
  - "When analyze is skipped, search runs with defaultQueryContext(), a new helper next to the copied detector that returns the values analyzeQuery returns for a plain semantic query"
  - "Per-request stageOverrides (disabled stages, timeouts 1..60000) are honoured only for profile eval; core stages in an override list are ignored"

patterns-established:
  - "Pipeline tests inject fakes through setRagDepsForTests (embedder, anon RPC client, ragEnv); tests/rag/helpers/pipeline-fakes.ts holds the abort-aware fake RPC and embedder"

coverage:
  - id: D1
    description: "Stage switches and timeouts are parsed safely and core stages cannot be switched off; unknown RAG_PIPELINE runs legacy and logs once"
    requirement: PIPE-06
    verification:
      - kind: unit
        ref: "tests/rag/config.test.ts (12 tests)"
        status: pass
  - id: D2
    description: "Core stage failure, timeout and abort give error with a reason; optional stage failure or timeout gives degraded; config-disabled stage stays empty/ok"
    requirement: PIPE-07
    verification:
      - kind: unit
        ref: "tests/rag/status.test.ts (10 tests); tests/rag/stage-runner.test.ts (runStage and failure semantics)"
        status: pass
  - id: D3
    description: "Aborting the request signal aborts the embedder and RPC signals, runs no later stage, and returns error/aborted"
    requirement: PIPE-07
    verification:
      - kind: integration
        ref: "tests/rag/stage-runner.test.ts#runRetrieval abort propagation (3 tests)"
        status: pass
  - id: D4
    description: "One trace collector per request; finishTrace writes exactly one `[RAG Trace]` line without query or chunk text"
    requirement: OBS-01
    verification:
      - kind: unit
        ref: "tests/rag/trace-log.test.ts (11 tests, distinctive query and chunk strings asserted absent)"
        status: pass
  - id: D5
    description: "OK-path output unchanged: all 72 fixture questions still deep-equal enhancedRetrieveChunks"
    requirement: PIPE-06
    verification:
      - kind: integration
        ref: "node --import tsx --test tests/rag-legacy-differential.test.mts (5 tests)"
        status: pass
---

# Phase 2 Plan 08: Stage Runner, Switches, Status and Trace Collector Summary

**`runRetrieval` now runs analyze, embed, search and legacy_rank through a stage runner with per-stage timeouts, request-signal abort, D-05 status derivation and one content-free `[RAG Trace]` line per request, with unchanged candidates on the ok path.**

## Performance

- **Tasks:** 3 of 3, each as a RED commit (failing on assertions against a stub) followed by a GREEN commit
- **Files:** 9 created, 5 modified
- **Verification:**
  - `npx vitest run` passes (38 files, 312 tests; `tests/rag` 10 files, 89 tests)
  - `node --import tsx --test tests/rag-legacy-differential.test.mts` passes (5 tests)
  - `npm run typecheck:new` reports no Phase 1 errors
  - `npx next typegen && node scripts/ci/tsc-ratchet.mjs` reports ok (58 errors, 59 files improved)
  - Acceptance greps: `[RAG Config]` in config.ts (1), `AbortSignal.any` in pipeline.ts (1), `[RAG Trace]` in log.ts (1)

## Accomplishments

- Task 1 (RED e1b74e6, GREEN 6a7956e): `loadRagConfig(env)` returns pipeline `legacy`, the disabled-stage set, per-profile timeouts (code defaults from the plan, overridden by `RAG_STAGE_TIMEOUTS`) and the warnings. Core stages named in `RAG_DISABLED_STAGES`, unknown names, invalid timeout entries and unknown `RAG_PIPELINE` values are dropped and logged once per distinct problem under `[RAG Config]` (names only).
- Task 2 (RED cb539e2, GREEN ae349df): `runStage`, `StageError`, `deriveStatus`, spec building per profile, eval-only per-request overrides, default query context when analyze is skipped, and a skipped `legacy_rank` keeping search order. The stage promise is raced against the composed signal, so a stage that ignores its signal still times out.
- Task 3 (RED 43c1a17, GREEN f7aadc8): `finishTrace` / `logRagTrace` emit `[RAG Trace] {json}` with traceId, tenantKey, profile, status, reason and per-stage name, status, reason, latency, candidate counts and rules. It never throws, even with a failing sink or a missing collector.

## Task Commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 RED | Config parsing tests against a stub loader | e1b74e6 |
| 1 GREEN | Parse RAG_PIPELINE, RAG_DISABLED_STAGES and RAG_STAGE_TIMEOUTS | 6a7956e |
| 2 RED | Stage runner and status tests against stub exports | cb539e2 |
| 2 GREEN | Stage runner, status derivation, abort propagation | ae349df |
| 3 RED | Trace collector and `[RAG Trace]` tests against a no-op finishTrace | 43c1a17 |
| 3 GREEN | `[RAG Trace]` log line and finishTrace | f7aadc8 |

## Intended behaviour changes

- Slow stages are now bounded: a hung embedder or RPC becomes error (`embed_timeout`, `search_timeout`) after 15 s (5 s for voice) instead of waiting for the platform limit. Not yet reachable from any route; entry points still call the old retrieval until the plans after 02-19.
- An embedder failure reason is now `embed_failed` for every error type (02-07 logged the error name but used the same reason string).
- `runRetrieval` writes one `[RAG Trace]` console line per call when it owns the collector.

## Deviations from Plan

**1. [Rule 1 - Contract] RPC error keeps reason `backend_error`**
- **Issue:** The plan's behaviour says an RPC error gives reason `search_failed`. The 02-07 contract and `tests/rag-legacy-differential.test.mts` (which this plan must keep passing) pin `backend_error`.
- **Fix:** A `RetrievalBackendError` raised in search keeps `backend_error`; the search stage record still shows `error`. Any other search failure is `search_failed`. Both cases are tested. 02-09 and later plans that branch on reasons should treat `backend_error` as a specific kind of search failure.

**2. [Ordering] Trace collector landed with Task 2**
- `runStage` records into the collector, so `trace/collector.ts` and the extended `StageRecord` shape were committed with the Task 2 RED commit. Task 3's collector tests therefore passed at its RED commit; its log and wiring tests failed on assertions against the no-op `finishTrace`.

**3. [Rule 2 - Config sync] No new env variables**
- The three RAG_* variables already exist in `.env.local` defaults, `scripts/init-env.js`, `src/lib/env.ts` and `scripts/config-server.js` from plan 02-03, so no four-place sync was needed. `RagDeps.ragEnv()` reads them from the existing typed env snapshot.

## Known Stubs

None. `context`, `usedDocuments`, `sourceImages` and `links` on `RetrievalResult` stay empty until plan 02-09 (assembly); `post_filter`, `assemble`, `voice_keyword_fallback` and `local_rerank` are configurable stage names with defaults but no runner wiring yet (their plans add the stages).

## Threat Flags

None beyond the plan's register. T-02-16 (core stages cannot be disabled; per-request overrides eval-only), T-02-17 (fixed field list, distinctive query and chunk strings asserted absent from the log line) and T-02-18 (per-stage timeouts, abort stops all in-flight work) are mitigated and tested. The log line includes `tenantKey` (`s:default`, `u:<id>` or `o:<id>`), as D-19 requires for trace tagging.

## Notes for later plans

- Plan 02-22 adds the sampled Langfuse export inside `finishTrace` and keeps `logRagTrace` as the fallback.
- Plans that add stages (02-09 assemble, post_filter, voice stages) should wrap them in `runStage` with `stageSpec`-style specs and pass the same collector (`trace`) so `deriveStatus` sees every record; the caller that passes `trace` must call `finishTrace` itself.
- `routes that map reasons to user-facing text` (strict refusal) must treat `degraded` with zero candidates as not empty, per D-05.

## Self-Check: PASSED

- All 9 files under key-files.created exist.
- Commits e1b74e6, 6a7956e, cb539e2, ae349df, 43c1a17 and f7aadc8 are ancestors of HEAD.
