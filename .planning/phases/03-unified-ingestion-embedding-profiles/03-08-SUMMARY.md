---
phase: 03-unified-ingestion-embedding-profiles
plan: 08
subsystem: embeddings
tags: [embeddings, voyage, qwen3, deepinfra, openrouter, mrl, registry, vitest, fake-endpoints]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: plan 03-03 config switches (RAG_QWEN_EMBED_FALLBACK, VOYAGE_* and DEEPINFRA_* in env.ts) and loadIngestConfig; plan 03-06 countTokens (cl100k_base)
provides:
  - EmbeddingProvider interface and EmbedOutput { vectors, model, host, usage }
  - OpenAI, Voyage voyage-4-large and Qwen3-Embedding-8B providers behind that interface
  - truncateAndNormalize (MRL) and EmbeddingProfileMismatch
  - registry with validateProfileShape, canonicalModelId and RagDeps-style test setters
  - price table in USD per million tokens with estimate labels
  - local fake Voyage, DeepInfra and OpenRouter embedding endpoints for tests
affects: [03-09, 03-21, 03-26, 03-28, 03-36]

actuals:
  tokens: 13075
  tasks: 3
  commits: 6
plan_head_before: c10c869434aa2da06aa15fe5f1424ec67b02fbe4
plan_head_after: e885f640ef53cca613811c973606c56f0a479f53

tech-stack:
  added: []
  patterns:
    - "Providers are factories (createOpenAiProvider, createVoyageProvider, createQwenProvider) taking an injectable config or client thunk; production defaults read env lazily, tests point them at the fake endpoints"
    - "Vendor failures surface as EmbeddingProviderError carrying host and HTTP status only; the vendor response text and the key never reach a message"
    - "A caller abort is rethrown as the signal's own AbortError, never wrapped or retried"

key-files:
  created:
    - src/lib/rag/embeddings/types.ts
    - src/lib/rag/embeddings/mrl.ts
    - src/lib/rag/embeddings/registry.ts
    - src/lib/rag/embeddings/openai-provider.ts
    - src/lib/rag/embeddings/voyage.ts
    - src/lib/rag/embeddings/qwen.ts
    - src/lib/rag/embeddings/prices.ts
    - tests/helpers/fake-embedding-endpoints.ts
    - tests/rag/embeddings/registry.test.ts
    - tests/rag/embeddings/providers.test.ts
  modified: []

key-decisions:
  - "canonicalModelId and the provider error helpers live in types.ts and registry.ts re-exports canonicalModelId, because qwen.ts and voyage.ts need the function and registry.ts imports both (an import cycle otherwise)"
  - "validateProfileShape returns { ok, reason, detail } instead of throwing, with reasons provider_unknown, storage_unknown, dims_invalid, dims_above_limit, legacy_column_dims, dims_unsupported; checked in that order, so qwen3 4096 halfvec reports dims_above_limit and any legacy_column above 2000 reports legacy_column_dims"
  - "Supported dims: openai [1536], voyage [256, 512, 1024, 2048], qwen3 [256, 512, 1024, 1536, 2048, 4096]; validateProfileShape reads them from constants so it works for voyage and qwen3 whether or not a provider instance is registered"
  - "Qwen3 canonical model id is Qwen/Qwen3-Embedding-8B (DeepInfra spelling); the OpenRouter spelling maps to it, and the returned model is canonicalModelId(response.model), so a wrong model from either host stays detectable"
  - "Qwen3 fallback is one OpenRouter attempt after DeepInfra's three attempts (two retries); it needs OPENROUTER_API_KEY and RAG_QWEN_EMBED_FALLBACK=openrouter, otherwise the DeepInfra error propagates"
  - "Within one embed call, once DeepInfra is down the remaining batches go straight to OpenRouter, and the output host is openrouter if any batch used it, so a mixed call is flagged as fallback-sourced"
  - "A missing DEEPINFRA_API_KEY or VOYAGE_API_KEY throws before any request and never triggers the fallback; only 5xx, 429 and timeouts or dropped connections do"

patterns-established:
  - "Fake vendor endpoints: one local http server with per-host path prefixes, a call recorder, failNext(host, ...statuses), setDelay and failure bodies that echo the Authorization header, so the redaction tests are meaningful"

requirements-completed: [EMB-01, EMB-03]

coverage:
  - id: D1
    description: "Three providers expose embedDocuments and embedQuery returning { vectors, model, host, usage }; embedText and embedBatch are untouched"
    requirement: EMB-01
    verification:
      - kind: unit
        ref: "tests/rag/embeddings/registry.test.ts (OpenAI provider, registry) and tests/rag/embeddings/providers.test.ts (Voyage, Qwen3)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Voyage sends input_type document or query, output_dimension = dims, truncation false, batches of at most 128 texts and an estimated 100K tokens"
    requirement: EMB-01
    verification:
      - kind: unit
        ref: "tests/rag/embeddings/providers.test.ts#Voyage provider (8 tests, local fake endpoint)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Qwen3 uses the exact Instruct/Query: prefix on queries only, never sends dimensions, input_type or custom_instruction, checks 4096 raw components, truncates and normalises, falls back to OpenRouter on 5xx, 429 or timeout"
    requirement: EMB-01
    verification:
      - kind: unit
        ref: "tests/rag/embeddings/providers.test.ts#Qwen3 provider (14 tests, local fake endpoints)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Registry rejects unsupported dims, dims above 4000 and legacy_column above 2000, and canonicalises host-specific model ids"
    requirement: EMB-03
    verification:
      - kind: unit
        ref: "tests/rag/embeddings/registry.test.ts#validateProfileShape and #canonicalModelId"
        status: pass
    human_judgment: false
  - id: D5
    description: "Keys are read from env only and never appear in thrown messages or logs"
    requirement: EMB-01
    verification:
      - kind: unit
        ref: "providers.test.ts: Voyage 400 and Qwen3 'keeps both keys out of the errors thrown when the hosts fail' (fake failure bodies echo the bearer token)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The providers work against the live Voyage, DeepInfra and OpenRouter APIs"
    requirement: EMB-01
    verification: []
    human_judgment: true
    rationale: "No live call was made and no real key exists here; request shapes follow the research notes and are asserted only against local fakes (ROADMAP live verification item)"

duration: 10min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 08: Embedding providers and registry Summary

**OpenAI, Voyage voyage-4-large and Qwen3-Embedding-8B (DeepInfra primary, OpenRouter fallback) sit behind one EmbeddingProvider interface, with MRL truncation, registry dims and storage rules, canonical model ids, a price table and fake vendor endpoints.**

## Performance

- **Duration:** about 10 min
- **Started:** 2026-11-24T00:44:22Z
- **Completed:** 2026-11-24T00:54:07Z
- **Tasks:** 3 (all TDD: test then feat)
- **Files modified:** 10 (all new)

## Accomplishments

- `EmbeddingProvider` and `EmbedOutput` (`types.ts`) as in research Pattern 5. `embedDocuments(texts, { dims, signal })` and `embedQuery(text, { dims, signal })` return `{ vectors, model, host, usage: { tokens } }`. `openai.ts` (`embedText`, `embedBatch`) is not changed.
- `mrl.ts`: `truncateAndNormalize` keeps the head, rescales to unit length, throws `EmbeddingProfileMismatch('dims')` for a short vector and `('zero_norm')` for an all-zero head. The class also has a `'model'` kind for plans 03-21 and 03-26.
- `registry.ts`: `getEmbeddingProvider`, `validateProfileShape`, `canonicalModelId`, `setEmbeddingProvidersForTests`, `resetEmbeddingProvidersForTests`. Defaults hold the three providers.
- OpenAI provider (`openai-provider.ts`): batches of 100, signal on every request, returns the response model and summed `total_tokens`, asserts `dims === 1536` before any request and that every returned vector has 1536 components.
- Voyage (`voyage.ts`): `fetch` to `VOYAGE_BASE_URL/embeddings` with `model voyage-4-large`, `input_type`, `output_dimension`, `truncation: false`, bearer key. Batches of at most 128 texts and an estimated 100K tokens (cl100k_base count x 1.3). Missing key throws `[Embedding Profile] VOYAGE_API_KEY not configured` before a request. Returned vector sizes are checked against `dims`.
- Qwen3 (`qwen.ts`): `openai` SDK against `DEEPINFRA_BASE_URL` (model `Qwen/Qwen3-Embedding-8B`) with `encoding_format: 'float'` only, query text `Instruct: <task>\nQuery:<q>`, raw 4096 check, truncate and L2-normalise. DeepInfra gets two retries, then OpenRouter (`qwen/qwen3-embedding-8b`) on 5xx, 429 or timeout when `RAG_QWEN_EMBED_FALLBACK=openrouter`; the output host says which.
- `prices.ts`: 0.02 (OpenAI), 0.12 (Voyage), 0.01 (Qwen3) USD per million tokens; Voyage and Qwen3 counts are labelled estimates. `estimateCostUsd` returns `{ usd, estimated }`.
- `tests/helpers/fake-embedding-endpoints.ts`: one local http server for all three vendors with call recording, queued failures, per-host delay, adjustable Qwen raw size and Voyage return size. Deterministic vectors come from `eval/harness/fixture-embedder.mts`.

## Task Commits

1. **Task 1: provider interface, MRL helper, registry rules, OpenAI provider** - `9eb1e34` (test, RED), `9dc40c1` (feat, GREEN)
2. **Task 2: Voyage provider against a fake endpoint** - `fd547a1` (test, RED), `b8a0132` (feat, GREEN)
3. **Task 3: Qwen3 provider with DeepInfra primary and OpenRouter fallback** - `150c1a1` (test, RED), `e885f64` (feat, GREEN)

**Plan metadata:** committed with this SUMMARY (docs). `commits: 6` is measured from the plan ledger before the SUMMARY commit.

## TDD Evidence

Each RED commit carries compiling stub modules, so the target tests load and fail on their assertions rather than on a missing module.

- **Task 1 RED (`9eb1e34`):** `npx vitest run tests/rag/embeddings/registry.test.ts` gave 20 failed, 6 passed. Failures are assertion errors such as `expected 3 to be close to 0.6`, `expected true to be false`, `promise resolved ... instead of rejecting`. GREEN: 26 passed.
- **Task 2 RED (`fd547a1`):** 8 failed, 0 passed (`expected [] to have a length of 1 but got +0`, `promise resolved ... instead of rejecting`). One test first indexed an empty call list (TypeError); a length assertion was added ahead of the index and the run repeated before committing. GREEN: 8 passed.
- **Task 3 RED (`150c1a1`):** 15 failed, 34 passed across the two files. The registry test fails with `unknown embedding provider "voyage"`, which is the missing registry default. GREEN: 49 passed across the two files (27 registry, 22 providers).
- **Classifier note:** `gsd_run check tdd-red-evidence` was not run. `workflow.tdd_mode` is not enabled here, and plan 03-03 recorded that the classifier rejected vitest `tap` reports. The semantic assessment was done by hand from the run output: the target tests executed, failed on the planned assertions, and no import, syntax or fixture errors occurred.

## Files Created/Modified

- `src/lib/rag/embeddings/types.ts` - interface, output type, shared constants, `canonicalModelId`, `EmbeddingProviderError` and abort helpers
- `src/lib/rag/embeddings/mrl.ts` - `truncateAndNormalize`, `EmbeddingProfileMismatch`
- `src/lib/rag/embeddings/registry.ts` - provider lookup, profile shape rules, test setters
- `src/lib/rag/embeddings/openai-provider.ts` - OpenAI provider (injectable client)
- `src/lib/rag/embeddings/voyage.ts` - Voyage provider and `splitIntoBatches`
- `src/lib/rag/embeddings/qwen.ts` - Qwen3 provider, `QWEN_QUERY_TASK` (the instruction text plan 03-09 records on the profile row)
- `src/lib/rag/embeddings/prices.ts` - price table and cost estimate
- `tests/helpers/fake-embedding-endpoints.ts` - fake Voyage, DeepInfra and OpenRouter endpoints
- `tests/rag/embeddings/registry.test.ts` - 27 tests
- `tests/rag/embeddings/providers.test.ts` - 22 tests

## Decisions Made

See `key-decisions` above. The two that later plans must know: `validateProfileShape` returns a result object instead of throwing (03-21 maps `reason` to its startup verdict), and `getEmbeddingProvider` throws for an unknown id rather than returning undefined.

## Deviations from Plan

None - plan executed exactly as written. Details the plan left open and how they were filled:

- Providers are factories with an injectable config, because `env` in `src/lib/env.ts` is a snapshot object and cannot be changed per test. Production defaults read `env.VOYAGE_BASE_URL`, `env.DEEPINFRA_BASE_URL` and the keys, as the plan says.
- A later edit to the tests during Task 3 GREEN (a `clearFailures()` helper and a restructured key-redaction test) fixed a queue-leak bug in my own RED test, not a behaviour change; the corrected test still failed on its assertion before the implementation.

## Issues Encountered

- The worktree branch is `exec/03-08`, outside the `agent-*` namespace that the executor's allow-list expects. The orchestrator named this branch, so commits were made on it; HEAD was never on a protected branch.
- The commit trailer uses this session's own attribution (Sonnet 5.5) rather than the model name in the common brief, per the plan's commit rule.

## User Setup Required

None - no external service configuration required. `VOYAGE_API_KEY` and `DEEPINFRA_API_KEY` were added by plan 03-03 with empty defaults; no key values were written anywhere and no live call was made.

## Next Phase Readiness

- 03-09 can seed profiles with `validateProfileShape` and record `QWEN_QUERY_TASK` on the qwen3 rows. 03-21, 03-26 and 03-28 get `getEmbeddingProvider(id)`, `provider.model`, `canonicalModelId`, `EmbeddingProfileMismatch` and the `host` to store as `embedding_host`. 03-36 gets `estimateCostUsd`.
- `embedQuery` for Qwen3 sends the prefixed query as a one-element `input` array.
- Residual risk carried from research: OpenRouter may route to a host with other quantisation (P-15). The host is recorded; the live cosine comparison between hosts is still a live verification item.

## Verification

- `npx vitest run tests/rag/embeddings`: 49 passed (registry 27, providers 22)
- `npm run typecheck:new`: no Phase 1 type errors
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 117 files, 1479 tests passed (tests/rag/langfuse-pins.test.ts passed in this worktree)
- `node --import tsx --test tests/*.test.mts`: 136 pass, 0 fail
- `node scripts/ci/check-rag-boundary.mjs`: ok, 645 files, no violations
- `python3 scripts/ci/check-workflows.py`: OK
- `node scripts/check-config.mjs`: ok, 93 variables match the manifest
- Acceptance greps: `export function truncateAndNormalize` in mrl.ts = 1 (== 1); `truncation: false` in voyage.ts = 1 (>= 1); `Query:${` in qwen.ts = 1 (>= 1); registry test 27 passed (>= 9); providers test 22 passed (>= 5 and >= 10)
- rag-sidecar was not touched, so its pytest was not run.

## Known Stubs

None.

## Threat Flags

None. T-03-21: errors carry host and status only and tests assert neither key appears in any thrown error (the fake vendors echo the bearer token in their failure bodies); the only log line, `[Embedding Profile] primary host failed, falling back`, carries host names and a status. T-03-22: raw 4096 check for Qwen3, dims assertion on every returned vector for all three providers, zero-norm rejection. T-03-23: host recorded per call, fallback only on 5xx, 429 or timeout, off with `RAG_QWEN_EMBED_FALLBACK=none`. T-03-SC: `fetch` and the existing `openai` SDK only, no package changes.

## Self-Check: PASSED

- All 10 created files exist on disk (`types.ts`, `mrl.ts`, `registry.ts`, `openai-provider.ts`, `voyage.ts`, `qwen.ts`, `prices.ts`, `fake-embedding-endpoints.ts`, `registry.test.ts`, `providers.test.ts`).
- Commits `9eb1e34`, `9dc40c1`, `fd547a1`, `b8a0132`, `150c1a1`, `e885f64` are ancestors of HEAD.
