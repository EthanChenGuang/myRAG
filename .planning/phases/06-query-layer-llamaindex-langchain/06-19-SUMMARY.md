---
phase: 06-query-layer-llamaindex-langchain
plan: 19
subsystem: rag-query
tags: [query-layer, router, parallel-group, deadline, soft-status, small-talk]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-06 normalizeRelativeDates; 06-07 groupDeadlineMs / transformSignal; 06-13 tracer run-layer; 06-14 routeTransforms / effectiveQueryParams; 06-15 native expand, hyde, decompose"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-14 last edit of v2/pipeline.ts and v2/result.ts"
provides:
  - "runQueryLayer: gate → router → condense → parallel group (normalize_dates, expand, hyde, decompose) under one deadline anchored at the gate start"
  - "QueryTransformer gains expand, hyde, decompose (native implementations wired)"
  - "effectiveQueryLayerConfig(base, overrides): the eval-only overlay of enabled, framework and per-transform switches (D-38)"
  - "expandAllowance(budget, condensed, hyde): the D-08 LLM-variant budget left for expand"
  - "buildQueryPlan accepts expanded, hyde and subQuestions; variants deduplicated by text, capped at 8"
  - "statusRecords(records, survivors) in v2/result.ts: the A-2 soft-stage filter applied before deriveStatus"
  - "buildSmallTalkResult and the v2 small_talk short-circuit (D-10)"
affects: [06-20, 06-23, 06-24, 06-27, 06-32, 06-37]

actuals:
  tokens: 90000
  tasks: 3
  commits: 7
plan_head_before: 18beab3

tech-stack:
  added: []
  patterns:
    - "Query-layer transforms run through a local runner with the Phase 2 record semantics, but with deadline.ts signals (setTimeout-based), so fake timers drive them and a group deadline is recorded as timeout"
    - "A failed model call that native code returned as a skip is rethrown inside the stage, so the stage is recorded skipped/failed rather than ok"

key-files:
  created:
    - tests/rag/query/run-layer.test.ts
    - tests/rag/query/delays.test.ts
    - tests/rag/query/status.test.ts
  modified:
    - src/lib/rag/query/run-layer.ts
    - src/lib/rag/query/transformer.ts
    - src/lib/rag/query/plan.ts
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/v2/result.ts

key-decisions:
  - "Group deadline = min(groupDeadlineMs(profile, elapsed since the gate start, semantic_cache timeout when that stage is enabled else 0), params.group_deadline_ms); only chat and embed have one. Voice and eval run each transform under its own timeout only"
  - "Per-transform timeouts come from stageSpec (D-27 defaults, RAG_STAGE_TIMEOUTS, eval overrides); the effective cut is the earlier of the stage timeout and the group deadline"
  - "LLM-variant budget (max_llm_variants=2): condensed counts first, HyDE reserves one if any is left, expand gets the rest. A transform with no budget is not called and is listed in plan.skipped with reason cap (no stage record, so it never degrades)"
  - "Router skips (switch off, voice_blocked, classifier_tool, voice allow-list) are recorded as stage status disabled with the router reason in detail; only disabled_for_profile could reach plan.skipped, and translate is left entirely to the Phase 4 slot until 06-23"
  - "Eval overrides overlay in both directions: transforms.{x}: true enables a transform even when its env switch is off (unless the eval request lists it in disabledStages); false disables it. Chat, embed and voice ignore them"
  - "normalize_dates runs on the standalone query and falls back to the original when the rewrite dropped the expression; outcome.dateRange feeds the existing mergeLayerDateRange, plan.date_range carries the contract shape"
  - "Post-check discards (protected_token_lost, length, cap, empty→error) go to plan.skipped but keep the stage ok, matching 06-13's condense behaviour"
  - "A-2: semantic_cache records are always ignored by the status; the other query-layer stage records are ignored only when zero results survive and every core stage (embed, search, fuse) is ok. Refusal precedence and deriveStatus's signature are unchanged"
  - "Small talk returns before the binding plan, embed, search, rank and context: status ok, reason small_talk, context '', refusalCandidate false, refusal null, queryPlan attached, voice gets an empty wire payload. No retrievalConfigHash (the eval route already treats it as null). The Phase 4 translate slot still runs before the short-circuit"

requirements-completed: []
requirements-advanced: [QRY-02, QRY-03, QRY-04, QRY-05, LAT-03]

coverage:
  - id: D1
    description: "Routing (decompose only, expand only, condense then normalize_dates), the shared LLM-variant budget, classifier tool/multi_step, voice allow-list with native framework, plan schema and skips, eval overrides, small-talk outcome"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/rag/query/run-layer.test.ts (10 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Per transform: 5 s delay → skipped timeout at its D-27 timeout, error and invalid output → skipped (plan reason error), request completes degraded with the original chunks; three slow transforms cut at the 650 ms group deadline, layer span < 1,250 ms; request abort → aborted"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "tests/rag/query/delays.test.ts (14 cases, fake timers, through runRetrieval)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A-2 soft status (degraded with results, empty with zero results and core ok, cache never counts, disabled is ok, core error wins) and the D-10 small-talk short-circuit with the layer on and off"
    requirement: QRY-02
    verification:
      - kind: unit
        ref: "tests/rag/query/status.test.ts (7 cases)"
        status: pass
    human_judgment: false
---

# Phase 6 Plan 19: Query-layer orchestration Summary

**The query layer now runs exactly the transforms each query needs: it routes after the gate, runs condense, then runs the parallel group under one deadline anchored at the gate start. Every transform fails soft. The status treats query-layer stages as optional, and small talk skips retrieval. All of this happens only with `RAG_QUERY_LAYER=true` under `RAG_PIPELINE=v2`.**

## Tasks and commits

| Task | Commits |
|------|---------|
| 1 Router, parallel group, native transformer | `08204f6` test (RED), `fdc77ac` feat, `6c7ba04` fix (type annotation found by tsc) |
| 2 Injected delay and failure per transform | `b39e8f2` test |
| 3 Soft status and small-talk short-circuit | `c572fdf` test (RED), `d7248ec` feat |

## Behaviour changes (only with the layer on)
- Expand, HyDE, decompose and normalize_dates now run in requests when the router selects them. Before this plan only condense ran.
- A skipped query-layer transform with zero surviving results now gives `empty` instead of `degraded`, so strict mode answers "information not available". A skipped `semantic_cache` record never changes the status.
- R12 small talk returns `ok` / `small_talk` without retrieval.
- With the layer off nothing changes. The parity-off, characterize, chat-strict, refusal-routing and Phase 4 status suites pass unchanged.

## RED evidence
- run-layer.test.ts: 10 of 10 failed on assertions against the tracer.
- status.test.ts: 3 of 7 failed on assertions (empty-with-skip, cache-skip, small talk). The other 4 lock in current behaviour.
- delays.test.ts: no RED commit was possible. The cases were written after Task 1 and passed on its implementation, so Task 2 needed no fix in run-layer.ts.

## Deviations
1. **Local transform runner.** Transforms do not go through `runStage`. `runStage` uses `AbortSignal.timeout`, which fake timers do not control, and it would record a group-deadline abort as `failed`. `runTransform` in run-layer.ts keeps the same record shapes (`ok`/`disabled`/`skipped`+`timeout|failed`/`aborted`+throw) and uses deadline.ts signals instead. `query_gate` still uses `runStage`.
2. **plan.ts edited** (owned by 06-20 as well). `buildQueryPlan` gained `expanded`, `hyde` and `subQuestions` inputs. `planToVariants` is unchanged: `legs` and `denseText` are left to 06-20 and 06-24.
3. **Test fixtures shortened.** Two run-layer fixtures were longer than the 4× length ratio of the post-checks, so they were shortened in the feat commit.
4. **Delay tests pre-import `run-layer` and `v2/pipeline`.** The dynamic `import()` in `v2/stages/query.ts` never settles under vitest fake timers.
5. The neutral query "日志" replaces the plan's "退款" example (domain-neutrality rule).

## Interim gaps for later plans
- Until 06-24 the pgvector adapter ignores `includeUndated`. With the layer on, a relative-date query therefore drops undated chunks.
- `buildQueryVariants` still caps at 3 variants. 06-20 widens it and routes HyDE to the dense leg only.
- Translate is not run by the layer. `handledTranslate` stays false until 06-23.
- No semantic cache stage runs yet (06-32), so the deadline subtracts 0 ms for the cache by default.
- `terminologyGlossary` (04.1.1) is not on this branch. The terminology slot stays between the parallel group and `semantic_cache`, which this plan does not touch.

## Gates
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 375 files, 6274 passed, 4 skipped, 0 failed
- `node --import tsx --test tests/*.test.mts`: 172 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 1863 pass, 0 fail, 0 cancelled
- `check-rag-boundary.mjs` and its self-tests: pass (52/52)
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: OK
- `npm run test-rag -- --out eval/out/06-19`: gate PASS (7 skipped)
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-19-ingest`: gate PASS (7 skipped)
- Not run (not touched): Python suites, `gen:schemas` (no contract change), the frontend design check (no UI)

## Operator actions
None. No new env vars, packages, SQL or migrations.

## Self-Check: PASSED
