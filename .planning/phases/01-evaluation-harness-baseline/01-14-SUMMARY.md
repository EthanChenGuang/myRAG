---
phase: 01-evaluation-harness-baseline
plan: 14
subsystem: testing
tags: [rag-eval, answer-generation, openrouter, ai-sdk, mock-model, nightly, sentinel]

requires:
  - phase: 01-04
    provides: "POST /api/internal/rag/run, runEval / prepareInProcessEval, RagTrace"
  - phase: 01-09
    provides: "Vitest setup (npm test) and the route-level test conventions"
  - phase: 01-10
    provides: "Pinned eval env, RunManifest, Pydantic validate CLI"
provides:
  - "RagRunRequest.include_answer (default false) and RagRunOptions.generator_model, regenerated JSON Schemas and Zod"
  - "src/lib/rag-eval/answer.ts: EVAL_DEFAULT_SYSTEM_PROMPT, buildEvalSystemPrompt, resolveGeneratorModel, isGPTGeneratorModel, generateEvalAnswer, setEvalLanguageModelFactory"
  - "Eval route generates an answer for non-refused items when include_answer is true and records effective_config.generator_model and stage latency generation"
  - "runEval includeAnswer / generator (stub | live) and eval/harness/run-nightly.mts (exit 4 when the live key is missing)"
  - "tests/eval-answer.test.mts (12 node:test cases) and tests/eval-answer-sentinel.test.ts (6 Vitest cases)"
affects: [01-15, 01-18, 01-20, 01-22, nightly judge tier, faithfulness and answer relevance scoring]

plan_head_before: a8dd091ef96495c843031243b4ccf55fd95cf85b
plan_head_after: 1acbda58236008df802f5e9551fc9183d57060e3

actuals:
  tokens: 9000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Eval answer prompt is a replica of the chat route's env-configured branch, tied to it by a source-reading sentinel instead of a shared import (the chat route is not modified)"
    - "A module-level language-model factory seam (setEvalLanguageModelFactory) lets the harness and tests inject a MockLanguageModelV3; production code never calls it"
    - "Live generation receives the caller's OpenRouter key through a harness-owned factory closure; process.env keeps the fixture placeholder so embeddings and Supabase stay on the 127.0.0.1 fakes"

key-files:
  created:
    - src/lib/rag-eval/answer.ts
    - eval/harness/run-nightly.mts
    - tests/eval-answer.test.mts
    - tests/eval-answer-sentinel.test.ts
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/schemas/RagRunRequest.schema.json
    - rag-sidecar/schemas/RunManifest.schema.json
    - rag-sidecar/schemas/EvalReport.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - src/app/api/internal/rag/run/route.ts
    - eval/harness/run-eval.mts

key-decisions:
  - "Stub runs record generator_model 'stub/extractive-v1' (set as options.generator_model by the harness) so a stub trace and a live trace never share an effective_config_hash or run_config_hash"
  - "buildEvalSystemPrompt and generateEvalAnswer take an optional promptEnv, defaulting to the env.ts snapshot, because env.ts reads process.env once at import and tests need per-case prompt variables"
  - "The chat route's MAX_COMPLETION_TOKENS override is not replicated: env.MAX_COMPLETION_TOKENS is not an envVars key, so it is always undefined in the chat route too; only the per-model limits are copied"
  - "run_config_hash only gains generator_model in request_options when includeAnswer is true, so smoke hashes are unchanged"
  - "A fixture-placeholder OPENROUTER_API_KEY counts as 'not set' for live generation, so a harness-polluted environment cannot send a fake key to OpenRouter"

patterns-established:
  - "run-nightly exit codes: 0 success, 3 harness error, 4 live key missing (notice on stderr, no request, no output directory), otherwise the validator's code"

requirements-completed: [EVAL-06]

coverage:
  - id: D1
    description: "include_answer true returns the generator's text for a non-refused item and null for a refused item; false (default) leaves answer and effective_config.generator_model null with no generation stage"
    requirement: EVAL-06
    verification:
      - kind: integration
        ref: "tests/eval-answer.test.mts 'eval route with include_answer' (5 cases, real route over PGlite and the fake edge)"
        status: pass
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/smoke-check exit 0; every trace answer null and generator_model null"
        status: pass
    human_judgment: false
  - id: D2
    description: "Eval system prompt uses the chat route's default text, RAG_PRE_CONTEXT/RAG_POST_CONTEXT or RAG_SYSTEM_PROMPT with \\n unescaping, ensureContextPlaceholder, then createEnhancedRAGPrompt or injectContext; temperature 0.1; model is options.generator_model or the isDefault list entry"
    requirement: EVAL-06
    verification:
      - kind: unit
        ref: "tests/eval-answer.test.mts buildEvalSystemPrompt, resolveGeneratorModel and generateEvalAnswer cases (mock model sees temperature 0.1, system prompt and the query as the user message)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A sentinel fails when the chat route's default prompt text, pre/post assembly, unescaping, placeholder/enhance/inject order, context branch, temperature literal or isGPTModel expression drift from the eval copy"
    requirement: EVAL-06
    verification:
      - kind: unit
        ref: "tests/eval-answer-sentinel.test.ts (6 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "run-nightly --generator stub writes nightly-tier traces with answers fully offline and byte-stable apart from latency; --generator live without a key exits 4 with the notice and makes no request"
    requirement: EVAL-08
    verification:
      - kind: integration
        ref: "npx tsx eval/harness/run-nightly.mts --generator stub (exit 0, Pydantic validation passes, two runs equal after dropping stage_latency_ms, equal run_config_hash); env -u OPENROUTER_API_KEY ... --generator live exits 4"
        status: pass
    human_judgment: false
  - id: D5
    description: "Live generation against the real OpenRouter model"
    requirement: EVAL-08
    verification: []
    human_judgment: true
    rationale: "No real OPENROUTER_API_KEY in this environment; the live path is exercised only up to the missing-key exit. First live run happens with the nightly judge tier."

duration: 20min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 14: Eval Answer Generation Summary

**The eval endpoint now returns an answer built with the chat route's env-configured prompt assembly (default text, pre/post unescaping, placeholder, enhanced RAG prompt, temperature 0.1) when `include_answer` is true, with a deterministic in-process stub generator for offline nightly traces and a keyed OpenRouter generator for live ones**

## Performance

- **Duration:** about 20 min (start time was not captured at launch; estimate)
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 11 (4 created, 7 modified)

## Accomplishments
- `include_answer` and `options.generator_model` are Pydantic fields; `npm run gen:schemas` is idempotent (two regenerations hash equal) and the Zod file carries both.
- `answer.ts` copies the chat route's env-configured prompt branch and the per-model max output tokens. The route generates only for non-refused items, records the resolved model and a `generation` stage latency, and returns a 500 whose log line carries only the error name and HTTP status (no prompt, context or key).
- `run-nightly.mts --generator stub` produced a valid nightly trace (`tier: nightly` in run.json, answer = first sentence of the retrieved chunk, model `stub/extractive-v1`); two runs matched exactly apart from latency and share one `run_config_hash`.
- The smoke path is untouched: `npm run test-rag` exits 0 with `answer: null` and `generator_model: null`; the chat route, `thinking-rag-enhancer.ts` and `system-prompt-manager.ts` are byte-identical to 325a2c9.

## Task Commits

1. **Task 1: include_answer contract field, answer.ts, route wiring and sentinel** - `29a19ca` (feat)
2. **Task 2: Harness answer mode with a deterministic stub generator and the nightly entry point** - `1acbda5` (feat)

**Plan metadata:** committed separately (docs: complete plan)

## Decisions Made
See `key-decisions` above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Stub runs get their own generator_model id**
- **Found during:** Task 2
- **Issue:** With the default model resolution a stub trace would record `anthropic/claude-sonnet-4.5`, the same value a live run records, making stub and live traces and run hashes indistinguishable and risking a stub run being mistaken for a real baseline.
- **Fix:** The harness sets `options.generator_model = 'stub/extractive-v1'` for the stub generator when the caller gives none.
- **Files modified:** eval/harness/run-eval.mts
- **Commit:** 1acbda5

**2. [Rule 2 - Missing critical functionality] Fixture placeholder key is not a live key**
- **Found during:** Task 2
- **Issue:** In a process where an earlier eval already overwrote `OPENROUTER_API_KEY` with the fixture placeholder (as `fixtureProcessEnv` does), a later live run would see a non-empty key and send a fake key to OpenRouter.
- **Fix:** The captured key equal to the fixture placeholder is treated as absent (exit 4 path).
- **Files modified:** eval/harness/run-eval.mts
- **Commit:** 1acbda5

**3. [Process] TDD order**
- Task 1 is marked `tdd="true"`. The implementation was written before the test files, so there is no separate failing-test commit; the tests and the sentinel were run against the implementation and pass, and the sentinel was written to compare against the chat route text rather than the implementation. Both files landed in one commit with the code.

**Total deviations:** 2 auto-fixed (both Rule 2), 1 process note. **Impact:** no scope change; both fixes protect the baseline from stub or fake-key contamination.

## Issues Encountered
- `env.ts` snapshots `process.env` on first import, so the node:test file prepares the in-process eval first (which sets the fixture env) and passes `promptEnv` explicitly in the prompt unit cases instead of mutating `process.env`.
- `npx tsc --noEmit` shows only the pre-existing TS5097 import-suffix convention for `eval/harness/`; no errors in the new files. ESLint reports only the pre-existing type-position unused-name warnings in `run-eval.mts`.
- `uv` prints the `UV_NATIVE_TLS` deprecation warning on every call; environment noise.

## Known Stubs
None. The `stub/extractive-v1` generator is an intentional offline test double selected only by `--generator stub`.

## Threat Flags
None beyond the plan's register. T-01-21: generation is off unless `include_answer` is set, stub mode makes no network call, and the real key reaches only the generator closure. T-01-23: the generation-failure log was tested to exclude the query text; effective_config still filters key-like names.

## User Setup Required
None. A real `OPENROUTER_API_KEY` in the environment is needed only when the nightly tier is run with `--generator live`.

## Next Phase Readiness
- Plans 01-18 and 01-22 can read `answer` from nightly traces; traces still carry `citations: []`, which this plan did not change.
- EVAL-06 is marked complete: this was the last plan declaring it (the shared-ID gate reported it ready), and `query_transforms` and `citations` are empty only because the current pipeline produces none. EVAL-08 stays Pending: plans 01-18 and 01-22 also declare it and the judge scoring is not part of this plan.
- `tests/fixtures/contracts/samples.json` (plan 01-21) will pick up `include_answer` and `generator_model` from the regenerated schemas.

## Self-Check: PASSED

All created files exist, commits `29a19ca` and `1acbda5` are ancestors of HEAD, `npm test` (17 passed), `node --import tsx --test tests/eval-answer.test.mts` (12 passed), both pytest projects (131 and 53 passed), `npm run test-rag`, the stub nightly run and the keyless exit-4 check pass.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
