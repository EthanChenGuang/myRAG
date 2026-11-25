---
phase: 06-query-layer-llamaindex-langchain
plan: 26
subsystem: rag-query-layer
tags: [retrieval-port, langchain-adapter-seam, search-delegate, rrf, tenant-scope, d-18, a-4]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: 06-20 query-layer variants (legs, denseText, variantDenseTexts) and the single-fusion search stage
provides:
  - RetrievalPort, RetrievalPortVariant, RetrievalPortLists, RetrievalPortHit, SearchDelegate (src/lib/rag/query/port-types.ts, plain types, no TenantScope)
  - createRetrievalPort, RetrievalPortHandle, variantSearchRequest, listsFromLegs (src/lib/rag/v2/port.ts)
  - SearchStagesInput.searchDelegate; SEARCH_DELEGATE_ERROR, SearchDelegateError, delegatedFusion (src/lib/rag/v2/stages/search.ts)
  - StageRunOptions.failureDetail (src/lib/rag/pipeline.ts)
affects: [06-35, 06-37, 06-18, 06-42]

actuals:
  tokens: 14000
  tasks: 2
  commits: 5
plan_head_before: aae1f56

tech-stack:
  added: []
  patterns:
    - "Scope-bound port: tenant scope, filters, signal, embedder and backend live only in the factory closure; the frozen port object exposes variants, searchVariant and finishRetrieval"
    - "One backend request builder (variantSearchRequest) shared by the native search and the port, so both send identical requests"

key-files:
  created:
    - src/lib/rag/query/port-types.ts
    - src/lib/rag/v2/port.ts
    - tests/rag/v2/retrieval-port.test.ts
  modified:
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/pipeline.ts

key-decisions:
  - "createRetrievalPort returns a handle { port, collectedLegs, fusedHits }; only handle.port is given to the delegate, the search stage keeps the server-side view"
  - "finishRetrieval/fusedHits score the delegate's order with native RRF over the collected lists (params rrf_k and leg weights), so a delegate that reproduces the native order yields byte-identical FusedHits, scores and ranks included"
  - "Unknown and repeated ids in a delegate order are dropped; a non-array or non-string result is a delegate error"
  - "The trace's stage reason enum (failed|timeout|aborted) is unchanged: a delegate failure records status error, reason failed, detail search_delegate_error. runStage gained an optional failureDetail for this; an abort or timeout during the delegate keeps its own reason and no delegate detail"
  - "Exact-id and binding (domain) legs are not visible to the delegate; when present they are fused natively with the delegate order as one ranked list (id 'delegate', weight 1) and the collected leg ranks are kept. With neither present, the delegate order is used unchanged"
  - "In the search stage the port's embedder returns the vectors the embed stage already computed in one batch (06-20 keeps embedding in the embed stage), so delegate mode adds no embed call"

requirements-completed: [QRY-08]

coverage:
  - id: D1
    description: "Scope-bound retrieval port with a per-variant memo, one embed batch, abort and a two-tenant split"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/v2/retrieval-port.test.ts#createRetrievalPort (D-18, A-4)"
        status: pass
  - id: D2
    description: "Search delegate hook: native-equivalent order on a tie-free fixture, delegate errors fail the core search stage"
    requirement: QRY-08
    verification:
      - kind: unit
        ref: "tests/rag/v2/retrieval-port.test.ts#runSearchStages with a search delegate (D-02, D-18, A-4)"
        status: pass

duration: ~1.5h
completed: 2026-11-25
---

# Phase 6 Plan 26: Scope-bound retrieval port and search delegate hook

**A framework can now search and fuse the query variants only through a frozen port that already holds the tenant scope. The search stage accepts an optional delegate that fuses the port's lists; with a pure TypeScript RRF delegate the result equals the native fusion exactly. Without a delegate nothing changes.**

## Accomplishments

- `src/lib/rag/query/port-types.ts`: plain types only (`RetrievalPort`, `SearchDelegate = (port) => Promise<string[]>`). It declares no `TenantScope` and imports nothing, so the 06-35/06-37 adapter can import it without reaching scope, backend or embedding modules.
- `createRetrievalPort(ctx)` binds scope, backend, filters, params, signal, embedder and the lexical switch in its closure. `port.searchVariant(i)` returns the variant's dense and lexical ranked chunk-id lists. A `Map` memo makes the dense and lexical leg retrievers share one backend call per variant. The first search triggers one `embed` call with `variantDenseTexts(variants)`. Once the signal is aborted, it rejects with the abort reason and makes no call. A bad index is rejected with `RangeError`. The port, its variants and the returned lists are frozen. `Object.keys(port)` is `['finishRetrieval', 'searchVariant', 'variants']` and `JSON.stringify(port)` holds only variant texts, kinds and legs.
- `runSearchStages({ ..., searchDelegate })` builds the port under the search stage signal and awaits the delegate's order. It maps that order through the handle and then runs the existing dedupe and cap. The search stage counts come from the collected legs. Standalone similarity, exact-id and binding legs keep working.
- The native search now builds its backend request through `variantSearchRequest`, the same helper the port uses. The request fields are identical to before, and every existing v2 suite passes unchanged.

## Task Commits

1. Task 1 RED: `757f969` test(06-26): add failing tests for the scope-bound retrieval port (10/10 failed on assertions)
2. Task 1 GREEN: `b710b79` feat(06-26): scope-bound retrieval port with a per-variant search memo
3. Task 2 RED: `bbc11ce` test(06-26): add failing tests for the search delegate hook (5/15 failed on assertions; the tie-free precondition held)
4. Task 2 GREEN: `89616f9` feat(06-26): search delegate hook fuses variants through the retrieval port (adds tests for the extras merge and abort during a delegate; 18 tests total)
5. SUMMARY (this commit)

## Deviations

- **Files outside `files_modified`:** `src/lib/rag/pipeline.ts` gains the optional `StageRunOptions.failureDetail`, which is additive. Without it a stage records exactly what it did before.
- **Delegate failure reason:** the plan says "reason search_delegate_error". The trace's `reason` field is a closed enum (`failed | timeout | aborted`) that traces and eval reports share. To avoid widening that contract, the value is recorded as `detail: 'search_delegate_error'` with `status: 'error'` and `reason: 'failed'`. The retrieval status derives to `error`, never `empty`.
- **Exact-id and binding legs under a delegate:** the plan does not cover these. The delegate sees only the variant legs. When extra lists exist they are fused natively with the delegate order (see key decisions). Native equivalence is proved without extras, as the plan asks. The ordering with extras is a framework-path difference for 06-37/06-40 to report.
- **Embedding:** in the search stage the port's embedder returns the vectors computed in the embed stage, following the 06-20 deviation. The port's own one-batch embed behaviour is proved in isolation with a fake embedder.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 389 files, 6517 passed, 4 skipped
- `node --import tsx --test tests/*.test.mts`: 172 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 1964 pass, 0 fail, 4 skipped
- `check-rag-boundary`: ok (1445 files); its node test: 52 pass. `check-config`: ok (190 variables). `check-workflows`: OK
- `npm run test-rag -- --out eval/out/06-26`: gate PASS (7 skipped). `--fixture-mode ingest --out eval/out/06-26-ingest`: gate PASS (7 skipped)
- No Python, contract, env or UI changes, so the pytest, `gen:schemas` and frontend-design gates do not apply.
- Acceptance greps: `TenantScope` in port-types.ts = 0; `export function createRetrievalPort` = 1; `searchDelegate` in search.ts = 3; retrieval-port tests = 18 passed.

## Threats

- T-06-56: the scope is bound in the closure on the server. The port exposes no scope-bearing field. A two-tenant test with interleaved calls shows each port reaches the backend only with its own minted scope, and port-types.ts contains no `TenantScope`.
- T-06-57: the per-variant memo is tested. Six interleaved asks over three variants make three calls, all under the request signal.

## Operator actions / deferred

None. The pipeline does not set `searchDelegate` yet. 06-35/06-37 wire the LangChain adapter to it when `RAG_QUERY_FRAMEWORK=langchain`.
