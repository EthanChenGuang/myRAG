---
phase: 06-query-layer-llamaindex-langchain
plan: 15
subsystem: rag-query
tags: [query-layer, llamaindex, multi-query, hyde, sub-questions, vendored-prompts]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-05 QueryVariants, HypotheticalDocument and SubQuestions contracts; 06-07 post-checks and the prompt renderer; 06-10 query LLM client, RagDeps.queryLlm and the fake"
provides:
  - "nativeExpand (LlamaIndex QueryFusionRetriever query generation) in src/lib/rag/query/llamaindex/expand.ts"
  - "nativeHyde (LlamaIndex HyDEQueryTransform, zh/en/it templates, dense leg only) in src/lib/rag/query/llamaindex/hyde.ts"
  - "nativeDecompose (LlamaIndex SubQuestionQueryEngine question generator without tools) in src/lib/rag/query/llamaindex/decompose.ts"
  - "callNative / NATIVE_SYSTEM_PROMPT / NativeTransformSkip in src/lib/rag/query/llamaindex/call.ts"
  - "Five vendored prompt files: llamaindex.fusion, llamaindex.hyde.{zh,en,it}, llamaindex.subq (all v1, MIT, attributed)"
affects: [06-19, 06-20, 06-25]

actuals:
  tokens: 60000
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "Native transforms take { query, language, protectedTokens, signal, deps, limits? } with deps = Pick<RagDeps, 'queryLlm'>"
    - "An abort propagates (the stage runner records timeout); unavailable, provider error or schema failure returns a skip { transform, reason: 'error' }"
    - "Each module loads its prompt through loadPrompt(id, { [id]: file }) with a static JSON import; PROMPT_REGISTRY in render.ts is unchanged"

key-files:
  created:
    - src/lib/rag/query/llamaindex/call.ts
    - src/lib/rag/query/llamaindex/expand.ts
    - src/lib/rag/query/llamaindex/hyde.ts
    - src/lib/rag/query/llamaindex/decompose.ts
    - src/lib/rag/query/prompts/llamaindex.fusion.v1.json
    - src/lib/rag/query/prompts/llamaindex.hyde.en.v1.json
    - src/lib/rag/query/prompts/llamaindex.hyde.zh.v1.json
    - src/lib/rag/query/prompts/llamaindex.hyde.it.v1.json
    - src/lib/rag/query/prompts/llamaindex.subq.v1.json
    - tests/rag/query/expand.test.ts
    - tests/rag/query/hyde.test.ts
    - tests/rag/query/decompose.test.ts
  modified: []

key-decisions:
  - "decompose validates with SubQuestionsSchema.extend({ questions: max 16 }): still strict (an answer key fails), but six questions are cut to four by checkSubQuestions instead of failing the whole output (D-15 'cut', plan behaviour). expand and hyde use the contract schemas unchanged."
  - "The sub-question prompt's Uber/Lyft financial example is replaced with a neutral synthetic one (Component A/B length and weight) in the {\"questions\": [...]} shape, per the domain-neutrality owner rule; the instruction sentence is the LlamaIndex text minus ', and a list of tools'."
  - "HyDE passages over variant_max_chars are cut at the last sentence end (. ! ? followed by whitespace or end, or 。！？) within the limit, else hard-cut at the limit; the result reports truncated: true. The cut is not a skip, so it is not in the skipped list."
  - "HyDE protectedOk is computed with keepsProtectedTokens and only reported; the passage is never discarded for a missing token (A-10)."
  - "expand drops model queries equal to the original or to an earlier variant without counting them; after maxItems kept variants the rest are recorded once as { kind: 'expand', reason: 'cap', count }."
  - "Native results carry variants with legs ('both' for expanded and sub_question, 'dense' for hyde) and subQuestionIndex, so 06-19/06-20 can map them onto the widened QueryVariant without another call shape."

requirements-completed: [QRY-02, QRY-03, QRY-04, QRY-06]

coverage:
  - id: D1
    description: "Multi-query expansion: maxItems queries, original never counted, cap, protected-token discard, no call at 0"
    requirement: QRY-02
    verification:
      - kind: unit
        ref: "tests/rag/query/expand.test.ts (7 cases)"
        status: pass
  - id: D2
    description: "HyDE: per-language template, one dense-only variant, protected-token exemption, sentence-end cut, never the standalone query"
    requirement: QRY-03
    verification:
      - kind: unit
        ref: "tests/rag/query/hyde.test.ts (9 cases)"
        status: pass
  - id: D3
    description: "Sub-questions: at most 4, empty means not compound, no answer field, post-checked"
    requirement: QRY-04
    verification:
      - kind: unit
        ref: "tests/rag/query/decompose.test.ts (6 cases)"
        status: pass
  - id: D4
    description: "Every call through deps.queryLlm() with the shared suffix; vendored prompts record source, MIT and attribution"
    requirement: QRY-06
    verification:
      - kind: unit
        ref: "prompt and source assertions in the three test files"
        status: pass
---

# Phase 6 Plan 15: Native expand, HyDE and decompose Summary

**The three remaining LlamaIndex query transforms are native pure functions over the query-LLM seam: multi-query expansion, per-language HyDE (dense leg only) and tool-free sub-question generation. All share the D-15 post-checks and the vendored, attributed prompts.**

## Accomplishments
- `nativeExpand` renders the verbatim `QUERY_GEN_PROMPT` with `num_queries = maxItems` and the shared suffix. It calls the query LLM with `QueryVariantsSchema` and runs `checkVariant` on each query. It keeps at most `maxItems` variants of kind `expanded` and records `cap` for the rest. With `maxItems` 0 it makes no LLM call.
- `nativeHyde` picks the zh, en or it template. The en file is `HYDE_TMPL` verbatim; zh and it are translations of it, recorded as `derived from`. It returns one variant `{ kind: 'hyde', legs: 'dense', protectedOk }`. A passage that drops a protected token is kept, not discarded. Long passages are cut at a sentence end. The result has no standalone field.
- `nativeDecompose` renders `defaultSubQuestionPrompt` without the tools and runs `checkSubQuestions`. It returns up to 4 `sub_question` variants with indexes 0..n-1. An empty list sets `notCompound`. An output with an `answer` key fails the strict schema and is skipped with reason `error`.
- `callNative` maps query-LLM failures. An abort is rethrown, so `runStage` records the timeout. Any other failure becomes `{ transform, reason: 'error' }`, which matches the QueryPlan `skipped` vocabulary.

## Task Commits
1. **Task 1: Native multi-query expansion.** RED `7951b85`, GREEN `c312c47`.
2. **Task 2: Native HyDE.** RED `ef2a79c`, GREEN `de5305d`.
3. **Task 3: Native sub-question generation.** RED `6350927`, GREEN `4a60c96`.

Every RED commit included a stub module and the prompt data, so each test failed on assertions, not on a missing module.

## Deviations
- **Added `src/lib/rag/query/llamaindex/call.ts`** (not in files_modified). It holds the shared call, error mapping and system prompt, so the three modules don't repeat them.
- **Prompts are not added to `PROMPT_REGISTRY`.** Each module passes its own one-entry registry to `loadPrompt`, which keeps `render.ts` untouched. That file is also edited by 06-13 in the same wave, so this avoids a merge conflict. The static JSON imports still keep the files in the bundle.
- **Sub-question example replaced.** The upstream Uber/Lyft revenue/EBITDA example is financial-domain content, which the domain-neutrality rule bans. The new neutral example is recorded in the file's attribution.
- **Sub-question source version.** The source line names `@llamaindex/core@0.6.23`, as 06-RESEARCH verified. The wording was checked against the 0.4.23 copy installed in `node_modules`, and the sentence is identical.
- **Wire schema for decompose.** The schema is widened to at most 16 questions (see key decisions). Without that, the plan's "6 are cut to 4" behaviour is impossible under the contract's `max(4)`.
- **Neutral test strings.** The plan's example query "退款" is replaced with neutral synthetic component queries, per the domain-neutrality rule.

## Gates
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 347 files, 5719 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 172 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 1793 pass, 0 fail, 4 skipped
- `check-rag-boundary` ok plus its self-test (39 pass); `check-config` ok; `check-language-literals` ok; `check-workflows` OK
- `npm run test-rag -- --out eval/out/06-15` and the `--fixture-mode ingest` run: gate PASS. They were run as a precaution; these modules are not wired into retrieval yet.
- No Python, contract, UI or SQL changes, so the sidecar/eval pytest runs, `gen:schemas` and the design check do not apply.

## Notes for later plans
- 06-19: wrap each call in its own `runStage`. An abort propagates, and the other failures come back as `skipped`. Expand's `maxItems` is the D-08 LLM-variant budget left after condense. The phase-level notes say 06-15 takes the glossary from `terminologyGlossary` (04.1.1). That input does not exist on this branch, so it is not wired here. 06-19 or the 4.1.1 executor should add it to the three input types when the terminology stage lands.
- 06-20/06-25: the HyDE variant is `legs: 'dense'`. It must never be the rerank or refusal query (D-06, T-06-30).

## Operator actions
None. No live API call was made; every test runs on the fake query LLM.
