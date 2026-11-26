---
phase: 06-query-layer-llamaindex-langchain
plan: 37
subsystem: query-layer
tags: [langchain, ensemble-retriever, framework-switch, query-transforms, langsmith, tdd]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "LangChain adapter part 1: condense, expand, HyDE, chat model, fake, shared finishers (06-35)"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "retrieval port, SearchDelegate and the search-stage delegate path (06-26); run-layer and v2/pipeline edits (06-32); transformer.ts (06-19); query-layer config (06-10)"
  - phase: 05.1-prompt-injection-defense
    provides: "last Phase 5.1 edits of v2/pipeline.ts, config.ts and config.test.ts (05.1-14, 05.1-06)"
provides:
  - "LangChain decompose (vendored decomposition prompt, withStructuredOutput SubQuestions) and translate (shared prompt): all five QueryTransformer methods"
  - "createLangChainSearchDelegate: EnsembleRetriever over one LegRetriever per (variant, leg) port list, chunk id as pageContent, leg weights and c = rrf_k"
  - "loadQueryFramework / prewarmQueryFramework / setLangChainChatModelFactoryForTests in transformer.ts: the only import('./langchain')"
  - "run-layer framework_import stage (counts.import_ms) and QueryLayerOutcome.searchDelegate, forwarded by v2/pipeline.ts"
  - "SearchDelegateContext { signal, rrfK, legWeights } passed by the search stage; fuse stage counts delegated: 1 on the delegated path"
  - "loadRagConfig langchain check: falls back to llamaindex with one [Query Layer] warning when a tracing variable is true or the @langchain packages do not resolve"
affects: [06-42, 06-46, 04.1.1-07]

actuals:
  tokens: 90000
  tasks: 3
  commits: 9
plan_head_before: 4f5875b4

key-files:
  created:
    - src/lib/rag/query/langchain/ensemble.ts
    - src/lib/rag/query/prompts/langchain.decompose.v1.json
    - tests/rag/query/framework-parity.test.ts
    - tests/rag/query/langchain-ensemble.test.ts
    - tests/rag-db/query-layer-langchain.test.mts
  modified:
    - src/lib/rag/query/langchain/index.ts
    - src/lib/rag/query/langchain/chat-model.ts
    - src/lib/rag/query/langchain/fake.ts
    - src/lib/rag/query/transformer.ts
    - src/lib/rag/query/llamaindex/decompose.ts
    - src/lib/rag/query/llamaindex/translate.ts
    - src/lib/rag/query/llm.ts
    - src/lib/rag/query/run-layer.ts
    - src/lib/rag/query/port-types.ts
    - src/lib/rag/query/hash-part.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/config.ts
    - src/lib/rag/deps.ts
    - tests/rag/config.test.ts
    - tests/rag/query/langchain-adapter.test.ts

key-decisions:
  - "A true LANGSMITH_* / LANGCHAIN_TRACING* variable turns the langchain framework back to llamaindex (not only a warning), per the 06-35 finding and the orchestrator note: callbacks: [] does not stop LangChain's env-driven tracer."
  - "decompose and translate reuse the native post-steps through QUERY_TRANSFORM_FINISHERS (finishDecompose, translateRequests, finishTranslate, defaultLimits), like 06-35 did for the other three."
  - "The delegate gets rrf_k and leg_weights from the search stage (SearchDelegateContext), so run-layer needs no retrieval params; a weight-0 leg gets no retriever, as native RRF skips it."
  - "import_ms is traced as a framework_import stage (latency = the request's wait, counts.import_ms = the cold import) only in langchain mode."
requirements-completed: [QRY-08]

coverage:
  - id: D1
    description: "LangChain decompose and translate; five transforms schema-identical on the fixture inputs, differing fields reported"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/query/framework-parity.test.ts"
        status: pass
  - id: D2
    description: "EnsembleRetriever fusion over the scope-bound port equals native RRF on a tie-free fixture; chunk-id keys; one port search per variant; hyde dense-only; signal honoured"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/query/langchain-ensemble.test.ts#createLangChainSearchDelegate, #the delegate inside the search stage"
        status: pass
  - id: D3
    description: "Dynamic import only for langchain and non-voice; default framework and voice never load ./langchain (module-load spy)"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/query/langchain-ensemble.test.ts#framework selection and the dynamic import"
        status: pass
  - id: D4
    description: "End to end: eval route with options.query_framework langchain, LangChain fake, real port and SQL, expected chunk kept, fuse delegated"
    requirement: QRY-08
    verification:
      - kind: integration
        ref: "tests/rag-db/query-layer-langchain.test.mts"
        status: pass
  - id: D5
    description: "Config: tracing variable or unresolvable packages -> llamaindex with one warning naming the variable, never a value"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/config.test.ts#query layer"
        status: pass
---

# Phase 6 Plan 37: LangChain adapter part 2 and the framework switch

`RAG_QUERY_FRAMEWORK=langchain` now works end to end for chat, embed and eval. Voice stays native.
- All five transforms run through LangChain and return the native shapes.
- Variant fusion runs through `EnsembleRetriever` over the scope-bound retrieval port.
- `./langchain` is loaded only by a dynamic import in `transformer.ts`. The default framework and voice never load it.
- With every switch at its default nothing changes. The only exception is the semantic-cache config hash when the query layer is on (see the fix below).

## Commits

| Task | Commits |
|------|---------|
| 1 Decompose and translate | 49c67885 refactor (shared finishers), beb45211 test (RED), ff1f9bcb feat |
| 2 Ensemble fusion and the switch | bc721eb1 test (RED), 792ad619 feat |
| 3 End to end and config warnings | c4ee199a test (RED), a83389a2 feat |
| Bug fix (gate) | a765974f fix: LangChain prompts in the config hash |
| Summary | this commit |

The RED commits failed on assertions, not on missing modules:
- **Task 1:** the adapter's stub decompose and translate returned empty results. 7 assertions failed.
- **Task 2:** the stub delegate returned `[]` and the stub `loadQueryFramework` returned native. 9 failed.
- **Task 3:** the config resolver stub caused 5 config tests to fail. The end-to-end `fuse.delegated` assertion also failed without the search.ts change.

## What it does

- **decompose:** LangChain's decomposition prompt is a literal system message, the query is the human message, and the call uses `withStructuredOutput` with `SubQuestions` (`method: jsonSchema`).
  - The JSON Schema drops `maxItems`. The shared `finishDecompose` validates the wire bound of 16 and cuts the list to `max_sub_questions` (4), so a longer list is cut, not discarded.
  - A failure is a `{ transform: 'decompose', reason: 'error' }` skip and an abort propagates, both as on the native path.
- **translate:** `translateRequests` renders the shared prompt per target, with at most two targets. One structured `QueryTranslation` call runs per target, in parallel. `finishTranslate` applies the D-15 checks.
  - Failures, aborts included, are per-target skips of the same kinds as native.
  - The comparison report labels translate "plumbing only" (A-6).
- **ensemble.ts:**
  - One `LegRetriever` (a `BaseRetriever`) is built per (variant, leg). A hyde variant gets only a dense one, and a leg with weight 0 gets none.
  - Each retriever closes over a memoised `port.searchVariant(i)` and the stage signal. It returns `Document({ pageContent: chunkId, metadata: {} })`.
  - `EnsembleRetriever` is built with `weights` from `leg_weights`, `c = rrf_k` and `callbacks: []`. It is invoked once and raced against the signal.
  - Its order goes through `port.finishRetrieval`.
- **transformer.ts:**
  - `loadQueryFramework(framework, { model })` returns `{ transformer, searchDelegate, importMs }`.
  - In langchain mode it shares one `import('./langchain')` and measures `import_ms`. A failed load can be retried.
  - The chat model is `createChatModel` with the native OpenRouter key and attribution headers. llm.ts now exports `openRouterApiKey` and `openRouterHeaders`.
  - At module load, the import is prewarmed when the configured layer is on and the framework is langchain (P-7).
- **run-layer:** when the router picks langchain (never for voice), the layer awaits the framework and records `framework_import`: ok with `counts.import_ms`, or skipped/failed and the request runs native. It sets `QueryLayerOutcome.searchDelegate`, and v2/pipeline.ts forwards it to `runSearchStages`.
- **search.ts:** passes `{ signal: stageSignal, rrfK, legWeights }` to the delegate. The fuse stage counts `delegated: 1` on the delegated path only.
- **config.ts:**
  - For `RAG_QUERY_FRAMEWORK=langchain`:
    - any `LANGSMITH_*` or `LANGCHAIN_TRACING*` variable equal to `true` gives llamaindex and one `[Query Layer]` warning naming the variable (never a value).
    - so does a failed resolve of `@langchain/core/retrievers`, `@langchain/classic/retrievers/ensemble` or `@langchain/openai`. The packages are resolved from the app root through `process.getBuiltinModule('node:module')`, once per process.
  - The tracing variable names are part of the memo key.
  - `readRagEnvInput` passes those variables through from `process.env` (`langchainTracingEnv`).

## Parity report (fixture inputs, both fakes)

`condense: none; expand: none; hyde: .variant.text, .truncated; decompose: none; translate: none`. The hyde difference comes from the fakes, not the frameworks:
- The two frameworks use different HyDE templates (LlamaIndex vs LangChain websearch).
- With no table entry, each fake answers with its documented default (the input text), and that input differs.

Tie order in fusion differs from native by design (F-2): first-seen order versus chunk id ascending. Only the tie-free fixture asserts equality.

## Deviations

1. **The fix to the config hash, outside the plan's file list.** `tests/rag/v2/config-hash-query.test.ts` already failed on the base `exec/06-35`: the three langchain.* prompts from 06-35 were missing from `PROMPT_FILES`. I confirmed this in a worktree of the base.
   - Now that LangChain is reachable, a change to its prompts must change the retrieval-config hash and the cache key. I added all four LangChain prompts.
   - Effect: with `RAG_QUERY_LAYER` on, the query-layer hash component changes once, so existing semantic-cache entries miss once. With the layer off nothing changes.
2. **The tracing variables fall back to llamaindex, not only a warning.** The plan said warn; the orchestrator note and the 06-35 finding said fall back. Security comes first.
3. **Neutral test sentences.** The plan's example query "What is the hotel reimbursement limit?" breaks the domain-neutrality rule. The translate test uses "What is the rated range of sensor QX-210?" instead. The decompose test uses the plan's "A 和 B 有什么区别？".
4. **The vendored decomposition prompt leaves out the docs' two opening lines** (the example "tutorial videos" database), for domain neutrality. The instructions are verbatim; the source URL, the retrieval date and the omission are recorded in the file.
5. **Files outside the plan's list:**
   - `llamaindex/decompose.ts`, `llamaindex/translate.ts`: the extracted finishers. Behaviour is unchanged and the native tests pass.
   - `langchain/chat-model.ts`: `structuredRaw` and `RAW_STRUCTURED_SCHEMAS`.
   - `langchain/fake.ts`: translate lookup keyed on the target, mirroring the native fake.
   - `llm.ts`: the key and header exports.
   - `port-types.ts`: `SearchDelegateContext`, an optional second argument, so existing delegates are unaffected.
   - `search.ts`, `deps.ts`, `hash-part.ts`.
6. **`LangChainTransformerDeps` lost `decompose` and `translate`.** They were placeholders until this plan. `langchain-adapter.test.ts` was updated to match.
7. **The prewarm runs when `transformer.ts` loads**, which is the first query-layer request (run-layer is itself dynamically imported), not when the route module loads. Getting earlier would mean touching route modules. This is left for 06-46 if the live cold-start check shows it matters.

## Terminology glossary seam (Phase 4.1.1)

`terminologyGlossary` is not on this base. Decompose and translate render through the same `renderPrompt` / shared `translateRequests` seam as the native path, so 04.1.1-07 adds the glossary in one place for both frameworks. The note from 06-35 still applies.

## Gates run

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` (full suite: config.ts is shared) | 496 files, 8452 passed, 1 failed: `config-hash-query` (pre-existing on base, fixed in a765974f, then 7/7 passed) |
| `npx vitest run tests/rag/query/framework-parity.test.ts tests/rag/query/langchain-adapter.test.ts tests/rag/query/langchain-ensemble.test.ts tests/rag/v2/retrieval-port.test.ts tests/rag/query/run-layer.test.ts tests/rag/config.test.ts` | all passed (parity 11, ensemble 12, config 129) |
| `node --import tsx --test tests/rag-db/query-layer-langchain.test.mts tests/rag-db/query-layer-tracer.test.mts` | 5 passed, 0 failed |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 1744 files |
| `node scripts/check-config.mjs` | ok, 213 variables |
| `node scripts/ci/check-language-literals.mjs` | ok |
| `node scripts/ci/check-settings-classification.mjs` | ok, 165 RAG_* variables |
| `node scripts/ci/check-zod-isolation.mjs` | ok |
| `npm run test-rag -- --out eval/out/06-37` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/06-37-ingest` | gate PASS (8 skipped) |
| `npx eslint` on changed files | 2 errors, both on lines this plan did not touch (`v2/pipeline.ts:13` unused `assertTenantScope`; `config.ts:745` `MODEL_ID_PATTERN` escape) |

Not run, because this plan does not touch the area: SQL migrations and the grants/search-path rag-db tests (no SQL or RPC change), Python pytest, `gen:schemas` (no contract change), the workflow check. There is no UI.

## Environment notes (pre-existing)

- `uv sync --locked --all-extras` in `eval/` fails because the lockfile needs updating, as 06-35 reported. `npm run test-rag` re-locks `eval/uv.lock` as a side effect; I restored it with `git checkout -- eval/uv.lock`.

## Requirement IDs and decisions for STATE

- QRY-08 complete.
- Decisions:
  - LangSmith/LangChain tracing variables disable the langchain framework (llamaindex fallback plus one warning).
  - Unresolvable @langchain packages fall back to llamaindex.
  - LangChain prompts are part of the query-layer config hash.
  - Search delegates receive `SearchDelegateContext`.

## Operator actions (recorded, not run)

- A live check of LangChain against OpenRouter with a real key: one chat request with `RAG_QUERY_FRAMEWORK=langchain`, checking `framework_import` `import_ms` on a cold instance.
- `next build` with `serverExternalPackages` and a smoke test of a route in langchain mode (06-46).
- The Config UI help text for D-22 (voice always native) and the tracing fallback belong to the D-44 panel plan.
