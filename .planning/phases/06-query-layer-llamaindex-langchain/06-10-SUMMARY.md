---
phase: 06-query-layer-llamaindex-langchain
plan: 10
subsystem: rag-query
tags: [config, query-layer, semantic-cache, query-llm, fake-llm, stage-names, timeouts]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-02 env names in the five locations; 06-05 generated StageName and transform output schemas"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-02 v2 config, profile-prefixed RAG_STAGE_TIMEOUTS, pinned stage-array test"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-06 / 05.1-21 last edits of config.ts, config.test.ts and deps.ts"
provides:
  - "OPTIONAL_STAGES and QUERY_LAYER_STAGES with query_gate, condense, normalize_dates, expand, hyde, decompose, semantic_cache"
  - "RagConfig.queryLayer and RagConfig.semanticCache; layer and cache inert under legacy with one [Query Layer] / [Semantic Cache] warning"
  - "D-27 per-profile timeouts for the query-layer stages"
  - "createQueryLlm / QueryLlm / QueryLlmError in src/lib/rag/query/llm.ts"
  - "RagDeps.queryLlm (lazy default, replaceable in tests)"
  - "createFakeQueryLlm in eval/harness/fake-query-llm.mts and the scripted table eval/fixtures/query-llm/transforms.json"
affects: [06-13, 06-15, 06-20, 06-21, 06-22, 06-27, 06-31, 06-35]

actuals:
  tokens: 70000
  tasks: 3
  commits: 8

tech-stack:
  added: []
  patterns:
    - "Query-LLM calls go through getRagDeps().queryLlm(); tests inject createFakeQueryLlm"
    - "QueryLlmError carries only transform and kind (unavailable | aborted | invalid_output | error)"

key-files:
  created:
    - src/lib/rag/query/llm.ts
    - eval/harness/fake-query-llm.mts
    - eval/fixtures/query-llm/transforms.json
    - tests/rag/query/llm.test.ts
    - tests/rag/query/fake-query-llm.test.ts
    - tests/rag/query/stage-names.test.ts
  modified:
    - src/lib/rag/config.ts
    - src/lib/rag/deps.ts
    - tests/rag/config.test.ts

key-decisions:
  - "Output.object takes the generated zod/v3 schema directly (AI SDK 6.0.3 FlexibleSchema accepts z3); the jsonSchema() fallback was not needed. Output is safeParsed again."
  - "Translate timeout: chat/embed/media 600 ms and eval 60000 ms apply only while the query layer is on; with the layer off the Phase 4 translate budget (1000 ms; voice 300 ms) is unchanged."
  - "semantic_cache is disabled iff the cache backend is off; it does not depend on RAG_QUERY_LAYER. The other six query-layer stages are disabled when the layer is off, or individually when their sub-switch is off. query_gate is never disabled while the layer is on."
  - "translate keeps its Phase 4 disabled rule (RAG_LEXICAL_TRANSLATION); the plan that wires the real translator (06-21/06-13) owns re-enabling it under RAG_QUERY_TRANSLATE."

requirements-completed: [QRY-05, QRY-06, QRY-07]

coverage:
  - id: D1
    description: "Stage names, switches, D-27 timeouts, legacy inertness"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/rag/config.test.ts (describe 'query layer', 12 cases) and tests/rag/query/stage-names.test.ts"
        status: pass
  - id: D2
    description: "Structured, no-retry, abortable query LLM client behind RagDeps"
    requirement: QRY-06
    verification:
      - kind: unit
        ref: "tests/rag/query/llm.test.ts"
        status: pass
  - id: D3
    description: "Deterministic fake with delay and failure injection; voice allow-list rejects expand/hyde/decompose"
    requirement: QRY-07
    verification:
      - kind: unit
        ref: "tests/rag/query/fake-query-llm.test.ts"
        status: pass
---

# Phase 6 Plan 10: Query-layer config, query LLM client and fake Summary

**The pipeline config now knows every Phase 6 stage and switch with the layer inert by default; one structured, no-retry, abortable query-LLM client sits behind `RagDeps.queryLlm`, and a deterministic fake serves CI and eval from a scripted table.**

## Accomplishments
- `src/lib/rag/config.ts`
  - Seven stage names added to `OPTIONAL_STAGES`; new export `QUERY_LAYER_STAGES`.
  - `PROFILE_STAGE_DEFAULTS` gains the D-27 budgets: chat, embed and media get `query_gate` 50, `condense` 600, `normalize_dates` 50, `expand` 700, `hyde` 900, `decompose` 800 and `semantic_cache` 150. Voice gets `query_gate` 50, `condense` 300 and `normalize_dates` 50. Eval gets 60000 for every query-layer stage.
  - While the layer is on, `translate` becomes 600 for chat, embed and media and 60000 for eval. `RAG_STAGE_TIMEOUTS` still wins, globally or per profile.
  - `RagEnvInput` has the 16 new names. `RagConfig.queryLayer` is `{enabled, framework, model, transforms, translateDisabledProfiles, voiceTransforms}`. `RagConfig.semanticCache` is `{backend, ttl, refusalTtl, maxDistance, embedStore}`. All of them are in the memo key.
  - `problem()` takes a log prefix. New warnings use `[Query Layer]` or `[Semantic Cache]` and are logged once per process.
  - Validation:
    - The layer or a non-off cache under legacy stays off.
    - An unknown framework falls back to llamaindex.
    - A malformed model id falls back to the default. The warning logs the id's length, never the value.
    - Expand, hyde and decompose are dropped from `RAG_QUERY_VOICE_TRANSFORMS` with one warning that names them.
    - Unknown translate-disabled profiles are dropped.
    - The cache distance must be above 0 and at most 0.2, otherwise 0.05 is used. TTLs must be 1 to 604800 seconds.
- `src/lib/rag/deps.ts`
  - `readRagEnvInput` reads the 16 names.
  - `RagDeps.queryLlm: () => QueryLlm`. The default is created on first use for the configured `RAG_QUERY_LLM_MODEL`, and `resetRagDepsForTests` clears it.
- `src/lib/rag/query/llm.ts`
  - `createQueryLlm({ model, apiKey?, languageModel? })` returns `generate({ transform, schema, system, prompt, input, targetLanguage?, signal })`.
  - It calls `generateText` with `Output.object({ schema })`, `temperature: 0`, `maxRetries: 0` and `abortSignal`.
  - The provider is `@openrouter/ai-sdk-provider`, imported on the first call, with `require_parameters: true`, `data_collection: 'deny'` and `sort: 'latency'`.
  - The output is validated again with `schema.safeParse`.
  - Errors map to `QueryLlmError` kinds. A missing key logs one `[Query Layer]` line that contains no key material.
- `eval/harness/fake-query-llm.mts`
  - `createFakeQueryLlm({ table })` keys entries by `${transform}|${NFC, trimmed, whitespace-collapsed query}`. Translate entries also key on the target language.
  - It supports `delay_ms`, which is abortable and works with fake timers, and `fail: 'invalid' | 'error'`. The invalid output fails the schema and surfaces as `invalid_output`, as with the real client.
  - Defaults when no entry matches: condense passes the input through, expand and decompose return empty lists, hyde returns the input as the passage, and translate returns empty text (no variant).
  - It also has `rawOutput()` and a `calls` log for tests. Duplicate keys are rejected.
- `eval/fixtures/query-llm/transforms.json`: 41 entries.
  - Condense for all 9 golden `multi_turn` items and decompose for all 9 `compound` items, with protected codes kept verbatim.
  - Expand, hyde and translate samples.
  - For each transform, one delay entry, one invalid entry and one error entry under synthetic queries.

## Task Commits
1. **Task 1: Stage names, switches and timeouts.** RED `1ba8a75`, GREEN `997a774`.
2. **Task 2: Query LLM client and the RagDeps seam.** RED `6eb1a71` (tests plus an API stub, so the tests fail on assertions), GREEN `87fe2cb`.
3. **Task 3: Fake query LLM and fixture table.** RED `d54b918` (tests, table and stub; adds `targetLanguage` to the request type), GREEN `8948a9d`.
4. **Fix:** `f960639` types `targetLanguage` from the generated `QueryTranslation` contract, so check-language-literals passes.

## Behaviour changes
- None at runtime with the defaults. The query-layer stages are registered but disabled, and no pipeline code runs them or calls the query LLM yet; 06-13 is the first caller.
- `/api/internal/rag/run` now forwards the query-layer names in `disabled_stages`, because they are registered stages now.
- Eval fixture runs: gate PASS with `paired.all_zero == true`.

## Tests that failed before the fix
- `tests/rag/config.test.ts`: the module failed to load, because `QUERY_LAYER_STAGES` was undefined. The 12 'query layer' cases, the updated pinned stage array and `CHAT_DEFAULTS` cover the change.
- `tests/rag/query/stage-names.test.ts`: all 3 cases failed on assertions.
- `tests/rag/query/llm.test.ts`: 8 of 10 failed against the stub.
- `tests/rag/query/fake-query-llm.test.ts`: 10 of 11 failed against the stub.

## Gate results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm run typecheck:new`: 1 diagnostic, pre-existing and in a file this plan does not touch: `tests/rag-db/eval-sec-overlay.test.mts(171,16)` TS18048. The same diagnostic appears on `ci/merge-train-15` without this plan's changes.
- `npx vitest run`: 337 files, 5475 passed, 1 skipped.
- `node --import tsx --test tests/*.test.mts`: 172 passed, 0 failed.
- `node --import tsx --test tests/rag-db/*.test.mts`: 1670 passed, 0 failed, 4 skipped.
- `node scripts/ci/check-rag-boundary.mjs`: ok, 1304 files. `node --test scripts/tests/check-rag-boundary.node-test.mjs`: 39 passed.
- `node scripts/ci/check-language-literals.mjs`: ok. The first version of llm.ts had a hard-coded `'zh' | 'en' | 'it'` union, which this check failed on; the Task 4 fix commit below types it from the generated contract instead.
- `node scripts/check-config.mjs`: ok, 182 variables.
- `check-workflows.py`: OK.
- `npm run test-rag -- --out eval/out/06-10`: gate PASS, `passed == true`, `paired.all_zero == true`.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-10-ingest`: gate PASS.
- `npx next build` with the CI placeholder env: passes.
- Python suites and `gen:schemas`: not run, because no Python files or contracts were touched. UI gate: not applicable, because no UI was touched.

## Deviations from Plan
1. **The stage-set parity test is a superset check, not equality.** The generated Pydantic `StageName` (06-05) lists the Phase 2 stages and the seven Phase 6 stages. It does not list the eight v2-internal stages (`fuse`, `exact_id_lookup`, `translate`, `dedupe`, `rerank`, `refusal`, `expand_parents`, `compress`), which the eval contract never exposed in Phase 4 either. The test asserts three things:
   - every generated name is registered;
   - the registered set equals the generated names plus that pinned v2-internal list;
   - every query-layer stage is in both sets.
   Adding the v2 stages to the Pydantic contract is a contract change outside this plan's files.
2. **The existing exact `disabledStages` assertions now go through `phase4Disabled()`,** which filters out the query-layer stages. The new 'query layer' cases assert the query-layer stages separately, including a Phase 4 field snapshot for legacy and v2.
3. **The fake validates its own output with the request schema,** so `fail: invalid` surfaces as `QueryLlmError('invalid_output')`, as with the real client. The raw invalid object is exposed through `rawOutput()`, and the test asserts that it fails the schema.
4. **`QueryLlmRequest` gains an optional `targetLanguage`** (translate only). `QueryTranslation` is a single `{target_language, text}`, so the fake needs the target to key translate entries and to build the "no variant" default (empty text).
5. **Logged-once across two calls:** the test changes one unrelated env field between the two calls to get past the memo, so that the once-per-process log rule is what is actually exercised.

## Seams left for later plans
- The query LLM boundary rule (D-13: query-LLM calls only under `src/lib/rag/query/`) is not added here. `scripts/ci/check-rag-boundary.mjs` is not in this plan's files, and the current check passes.
- Re-enabling the `translate` stage under `RAG_QUERY_TRANSLATE`, and applying `translateDisabledProfiles` and `voiceTransforms` at run time, belong to the pipeline plans (06-13 / 06-21 / 06-31).
- 4.1.1 terminology slot: this plan only registers the stage names. `terminologyGlossary` and the terminology stage do not exist in this branch, and nothing here orders stages, so the D-05 order (terminology after the parallel group, before `semantic_cache`) is left to the query stage plan.
- Group deadline (D-27, 900 ms after condense): not a config field yet. `src/lib/rag/query/deadline.ts` already exists for the plan that wires it.

## Decisions for STATE
- Default query model `openai/gpt-4.1-nano` (A-8), read from `RAG_QUERY_LLM_MODEL`. A malformed id falls back to the default with a warning.
- `semantic_cache` is gated by `RAG_SEMANTIC_CACHE` only, not by `RAG_QUERY_LAYER`. Both need `RAG_PIPELINE=v2`.
- While the layer is on, the D-27 translate budget replaces the Phase 4 translate budget for chat, embed, media and eval. Voice keeps 300 ms.

## Operator actions
- None for this plan. Live latency and quality checks of `RAG_QUERY_LLM_MODEL` stay a phase-level live verification item; the request leaves the deployment for OpenRouter with `data_collection: deny` and should be listed in the Phase 7 vendor inventory.

## Deferred
- None.
