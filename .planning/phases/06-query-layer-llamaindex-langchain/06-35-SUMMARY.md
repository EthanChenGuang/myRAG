---
phase: 06-query-layer-llamaindex-langchain
plan: 35
subsystem: query-layer
tags: [langchain, query-transforms, condense, multi-query, hyde, structured-output, tdd]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "LangChain fallback pins core 1.4.0, classic 1.0.61, openai 1.8.4 and serverExternalPackages (06-22)"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "langchain-import and langchain-adapter-reach boundary rules with the adapter allow-list (06-18)"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "native condense (06-13), expand and HyDE (06-15), shared suffix renderer (06-07), retrieval port types (06-26)"
provides:
  - "src/lib/rag/query/langchain/: createLangChainTransformer (framework langchain) with condense, expand and hyde"
  - "createChatModel (ChatOpenAI on OpenRouter, temperature 0, maxRetries 0, no callbacks) and structured() (JSON Schema plus zod/v3 re-validation)"
  - "CaptureRetriever: records query text, returns no documents"
  - "createFakeLangChainChatModel: deterministic fake keyed on the transforms.json table"
  - "Vendored prompts langchain.contextualize.v1, langchain.multi-query.v1, langchain.hyde.v1"
  - "QUERY_TRANSFORM_FINISHERS in transformer.ts: the native post-check step shared by both frameworks"
affects: [06-37, 06-42, 06-46, 04.1.1-07]

actuals:
  tokens: 13800
  tasks: 3
  commits: 8
plan_head_before: ebf45973

tech-stack:
  added: []
  patterns:
    - "Framework adapters do only the LLM step; post-checks come in through deps (QueryTransformFinishers)"
    - "Classic chains get the model as a lazily built RunnableLambda that binds the request signal and callbacks []"

key-files:
  created:
    - src/lib/rag/query/langchain/index.ts
    - src/lib/rag/query/langchain/chat-model.ts
    - src/lib/rag/query/langchain/capture.ts
    - src/lib/rag/query/langchain/fake.ts
    - src/lib/rag/query/langchain/errors.ts
    - src/lib/rag/query/prompts/langchain.contextualize.v1.json
    - src/lib/rag/query/prompts/langchain.multi-query.v1.json
    - src/lib/rag/query/prompts/langchain.hyde.v1.json
    - tests/rag/query/langchain-adapter.test.ts
  modified:
    - src/lib/rag/query/llamaindex/condense.ts
    - src/lib/rag/query/llamaindex/expand.ts
    - src/lib/rag/query/llamaindex/hyde.ts
    - src/lib/rag/query/transformer.ts

key-decisions:
  - "The native post-processing was extracted into finishCondense, finishExpand and finishHyde. The adapter receives them as deps.finish, so it imports no post-check module and returns exactly the native result objects."
  - "condense and expand are text calls through the LangChain chains. The captured text is validated with CondensedQuery and QueryVariants at the boundary; hyde uses withStructuredOutput(method jsonSchema) with HypotheticalDocument."
  - "decompose and translate come from deps (the native functions) until plan 06-37 adds the LangChain versions."
  - "createChatModel refuses an empty key or model (kind unavailable), so ChatOpenAI never falls back to OPENAI_API_KEY and sends it to OpenRouter."
  - "The OpenRouter provider preferences of the native client (data_collection deny, require_parameters, sort latency) are sent as modelKwargs."

requirements-completed: []
requirements-progressed: [QRY-08]

coverage:
  - id: D1
    description: "No-retry, no-callback, OpenRouter-only chat model with validated structured output"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/query/langchain-adapter.test.ts#chat model"
        status: pass
  - id: D2
    description: "condense via createHistoryAwareRetriever and expand via MultiQueryRetriever over a CaptureRetriever, matching native results on the fixture inputs"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/query/langchain-adapter.test.ts#condense, #expand, #shapes on the fixture inputs"
        status: pass
  - id: D3
    description: "HyDE port of the websearch template, dense-only native shape, no HydeRetriever or VectorStore"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/query/langchain-adapter.test.ts#hyde"
        status: pass
  - id: D4
    description: "No Hub fetch and no scope, tenant key or filter in any LangChain prompt, config or metadata"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/query/langchain-adapter.test.ts#no Hub, no scope"
        status: pass
---

# Phase 6 Plan 35: LangChain adapter part 1 (condense, expand, HyDE)

`src/lib/rag/query/langchain/` now holds a working LangChain implementation of condense, expand and HyDE.
- `createLangChainTransformer` returns a `QueryTransformer` with framework `langchain`.
- On every fixture input in `eval/fixtures/query-llm/transforms.json`, its results deep-equal the native ones.
- Nothing loads the adapter yet. Plan 06-37 adds the `import('./langchain')` switch in transformer.ts, plus decompose, translate and EnsembleRetriever fusion.
- The default path is unchanged: no `@langchain` module is imported outside the adapter. The native refactor moves code without changing behaviour, and the native tests pass.

## Commits

| Task | Commits |
|------|---------|
| 1 Chat model, structured output, fake | 7f2d5039 test (RED), a86f3dfd feat |
| 2 Condense and expand | 64932107 refactor (shared finishers), af6c5502 test (RED), b1041b27 feat |
| 3 HyDE port | 005a3fa3 test (RED), 21e93f19 feat |
| Summary | this commit |

The RED commits failed on assertions, not on missing modules:
- **Task 1:** a chat-model stub with no base URL, no key guard and no validation. 3 assertions failed.
- **Task 2:** a pass-through adapter stub. 10 failed.
- **Task 3:** the throwing hyde stub. 3 failed.

## What it does

- **chat-model.ts**
  - `createChatModel({ model, apiKey, headers? }, transform)` builds `ChatOpenAI` with:
    - `configuration.baseURL` `https://openrouter.ai/api/v1`
    - `temperature: 0`, and `maxRetries: 0` on both the AsyncCaller and the client
    - `callbacks: []`
    - the native OpenRouter provider preferences
  - The caller passes the model id and key in; the adapter reads no env.
  - `structured(model, contract, messages, signal, transform)` calls `withStructuredOutput(<generated JSON Schema>, { method: 'jsonSchema', name })`. It invokes with `{ signal, callbacks: [] }`, races the signal, and re-validates with the generated zod/v3 schema. A failure is `LangChainAdapterError` with kind `invalid_output`, `error` or `aborted`. The message names only the transform and the kind.
- **capture.ts:** `CaptureRetriever extends BaseRetriever`. It records each query and returns `[]`.
- **index.ts**
  - **condense:** `createHistoryAwareRetriever` with a prompt made of two messages:
    - a literal `SystemMessage`: the contextualize text, the rendered `<conversation>` data block and the shared suffix
    - a `{input}` human message
    - Because the rendered text is a literal message, braces in the history are never read as template variables.
    - With empty history the query passes through and the model is never called.
  - **expand:** `MultiQueryRetriever.fromLLM` with the vendored `DEFAULT_QUERY_PROMPT` plus the suffix, prerendered, and `queryCount` set to the allowance. The original query is never among the variants. The shared finisher applies the cap and the post-checks.
  - **hyde:** the websearch template plus the suffix, then `structured(..., 'HypotheticalDocument')`, then the native HyDE finisher. The result is a dense-only `hyde` variant.
  - **Model and signal:** the model is passed as a lazily built `RunnableLambda` that invokes the real model with the request signal. Classic `LLMChain` passes no signal to a real chat model, only `llmKwargs`, so without this an abort would not reach the HTTP call.
  - **Failures:** expand and hyde failures become `{ transform, reason: 'error' }` skips and condense failures throw, matching native. Aborts always propagate.
- **fake.ts:** `FakeLangChainChatModel extends FakeChatModel`. It reads the same table as the native fake.
  - It tells condense from expand by the first line of the vendored prompt. It picks the entry whose query is the last message, else the longest table query that occurs in the prompt.
  - It supports `delay_ms` and `fail: error | invalid`. An invalid condense is an empty rewrite; an invalid expand is five lines, over the QueryVariants bound.
  - It records each call's prompt and config, with the signal as a boolean and callbacks as a handler count.
  - Tests never import `@langchain`; one test checks this.

## Deviations

1. **Files outside the plan's list** (`llamaindex/condense.ts`, `expand.ts`, `hyde.ts` and `transformer.ts`).
   - I extracted the native post-processing into `finishCondense`, `finishExpand` and `finishHyde` and exported them as `QUERY_TRANSFORM_FINISHERS`. The code moved unchanged.
   - Why: the 06-18 allow-list does not let the adapter import post-checks, and copying the logic would drift. This follows D-02: only the LLM step differs between frameworks.
   - Effect: `createLangChainTransformer({ chatModelFactory, deps })` takes `deps = { finish, decompose, translate }`.
2. **Added `src/lib/rag/query/langchain/errors.ts`.** It holds the adapter's own error type, because `llm.ts` (`QueryLlmError`) imports env and is outside the allow-list.
3. **The three prompt files landed in the Task 1 commit,** because fake.ts reads the two text-prompt markers from them.
4. **chat-model.ts imports no zod.** The allow-list rejects even a type-only `zod/v3` import in the adapter, so the contract type is a structural `safeParse` type. Validation still uses the generated zod/v3 schemas from `contracts.generated`.
5. **One `eslint-disable-next-line @typescript-eslint/no-explicit-any` in fake.ts.** The fake's `withStructuredOutput` override must be assignable to every `BaseChatModel` overload; the line carries the reason.
6. **LangChain versions:** I used the installed versions (core 1.4.0, classic 1.0.61, openai 1.8.4). Every API the plan names exists in them: `createHistoryAwareRetriever`, `MultiQueryRetriever.fromLLM` and `withStructuredOutput` method `jsonSchema`.

## Terminology glossary seam (Phase 4.1.1)

`terminologyGlossary` (04.1.1-07) is not on this base: there is no `src/lib/rag/terminology/glossary.ts`, so no glossary is wired.
- **Seam:** every LangChain prompt is rendered through `renderPrompt(prompt, vars, RenderOptions)`, the same call the native condense and HyDE use.
- **When 04.1.1-07 lands:** add the glossary to `RenderOptions` (or a placeholder in the condense and HyDE templates). Feed it from `terminologyGlossary(scope, text, options)` in transformer.ts or run-layer, never inside the adapter, because the adapter must not see a scope (D-18). Both frameworks then get the glossary in the same change.

## Findings for later plans

- **06-37 / P-10, LangSmith tracing:** `callbacks: []` does not stop LangChain's env-driven tracer. `CallbackManager._configureSync` adds a `LangChainTracer` whenever `LANGSMITH_TRACING` or `LANGCHAIN_TRACING_V2` is `true`, whatever handlers are passed. Today the adapter is unreachable, so nothing leaks. I recommend that 06-37 falls back to llamaindex when such a variable is true, not only warns. That would be an owner decision on the D-44 wording.
- **06-37:** pass `chatModelFactory: (t) => createChatModel({ model: RAG_QUERY_LLM_MODEL, apiKey: OPENROUTER_API_KEY, headers }, t)` and `deps: { finish: QUERY_TRANSFORM_FINISHERS, decompose: native, translate: native }` until the LangChain decompose and translate replace the last two.

## Gates run

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run tests/rag/query tests/eval-route-query-layer.test.ts tests/rag/cache/stage.test.ts tests/rag/v2/{refusal-routing,rerank-standalone,translation-seam,variants-fusion}.test.ts tests/next-config-server-externals.test.ts` | 38 files, 482 passed (includes `langchain-adapter.test.ts`, 26 passed) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 1740 files, no violations |
| `node scripts/check-config.mjs` | ok, 213 variables |
| `node scripts/ci/check-language-literals.mjs` | ok |
| `node scripts/ci/check-settings-classification.mjs` | ok, 165 RAG_* variables |
| `node scripts/ci/check-zod-isolation.mjs` (plan verification) | ok |
| `npm run test-rag -- --out eval/out/06-35` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/06-35-ingest` | gate PASS (8 skipped) |
| `npx eslint` on changed files | 0 errors; the only warnings are base `no-unused-vars` hits on interface parameter names, the same pattern as the existing `QueryTransformer` interface |

Not run, because this plan does not touch the area: SQL / rag-db tests, Python pytest, `gen:schemas` and the workflow check. There is no UI.

## Environment notes (pre-existing, not caused by this plan)

- **`uv sync --locked --all-extras` in `eval/` fails:** "The lockfile at `uv.lock` needs to be updated". `npm run test-rag` then re-locks `eval/uv.lock` as a side effect. I restored it with `git checkout -- eval/uv.lock` and did not commit it.
- **Timing flakes:** `tests/rag/query/delays.test.ts` ("condense: a 5000 ms delay …") and `tests/rag/query/voice-budget.test.ts` ("50 runs with condense delays …") failed while the dependency install was running.
  - Under that load they failed on the base without my changes and on trunk `claude/ecstatic-hamilton-86gtwv`.
  - Once the machine was idle, both passed in the targeted run.

## Requirement IDs and STATE

- QRY-08 progressed (adapter part 1). It completes with 06-37.
- Decisions for STATE:
  - The framework adapters share the native finishers through deps.
  - The LangChain chat model refuses an empty key.
  - Tracing env variables should disable the LangChain framework (proposed for 06-37).

## Operator actions

None. Live LangChain or OpenRouter calls are operator checks, recorded for 06-37 and 06-46, and were not run.
