---
phase: 06-query-layer-llamaindex-langchain
plan: 32
subsystem: rag-retrieval
tags: [semantic-cache, query-layer, config-hash, cache-01, d-05, d-32, d-33, d-36, tenant-scope]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-17 bypass rules, cache key hash and entry profiles; 06-21 pgvector/RedisVL backends with the fail-open wrapper and RagDeps.semanticCache; 06-12 rag_cache_resolve_sources; 06-19 small-talk short-circuit and soft query stages; 06-20 variant types; 06-23 last run-layer.ts edit; 06-26 last search.ts edit"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-44 retrieval-config hash (computeRetrievalConfigHash)"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-06 / 05.1-14 last edits of types.ts, config-hash.ts, pipeline.ts and result.ts (security hash part)"
provides:
  - "computeRetrievalConfigHash optional queryLayer part (framework, query model, query-params hash, prompt file versions, transform switches); absent while the layer is off"
  - "queryLayerHashComponent / queryPromptVersions in src/lib/rag/query/hash-part.ts"
  - "RunRetrievalInput.cacheContext {generatorModel, systemPromptHash, webSearch, mcpTools, chatId}; RetrievalResult.cacheHit and cacheTicket"
  - "CacheTicket (scope-free key parts, embedding profile id, standalone, vector, check-time TurnFacts) in src/lib/rag/cache/types.ts"
  - "semantic_cache stage in runQueryLayer after the parallel group (bypass first, one standalone embed, 150 ms check + source re-resolution, fail-open)"
  - "resolveCachedSources / withCurrentSources / resolveHitSources over rag_cache_resolve_sources (src/lib/rag/cache/sources.ts)"
  - "SemanticCacheSeam lent by the v2 pipeline: embed with the request's embedding profile and requestRetrievalConfigHash (shared by the result and the cache key)"
  - "embedForRetrieval / embedVariantTexts in v2/stages/search.ts: the embed batch skips precomputed texts"
  - "buildCacheHitResult / isCacheHitResult and the cache_hit short-circuit in runV2Pipeline"
  - "query/layer-config.ts: effectiveQueryLayerConfig and queryLayerOverrides (re-exported by run-layer)"
affects: [06-36, 06-41, 06-42, 06-44, 04.1.1]

actuals:
  tokens: 20500
  tasks: 3
  commits: 8

tech-stack:
  added: []
  patterns:
    - "The pipeline lends the query layer a seam (embed + config hash) so a stage inside the layer computes exactly what the retrieval stages will use, without importing the v2 graph"
    - "Precomputed-vectors map: a stage that embeds a variant early hands the vector to the embed batch, which leaves that text out"

key-files:
  created:
    - src/lib/rag/cache/sources.ts
    - src/lib/rag/query/hash-part.ts
    - src/lib/rag/query/layer-config.ts
    - tests/rag/cache/stage.test.ts
    - tests/rag/cache/stage-hit.test.ts
    - tests/rag/v2/config-hash-query.test.ts
  modified:
    - src/lib/rag/types.ts
    - src/lib/rag/cache/types.ts
    - src/lib/rag/v2/config-hash.ts
    - src/lib/rag/query/run-layer.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/v2/stages/query.ts
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/v2/result.ts

key-decisions:
  - "The retrieval-config hash used in the cache key is computed by one function (requestRetrievalConfigHash) that buildV2Result also uses, so the key's hash always equals result.retrievalConfigHash (test asserts it). It includes the planned binding legs: the pipeline plans them once, early, from the request's doc-type filter (the only filter planBindingLegs reads) and reuses that plan after the query stages."
  - "While the query layer runs, result.retrievalConfigHash includes the query-layer part (research A-7); with the layer off it is the Phase 4 value (pinned constant test)."
  - "The query-layer hash part also carries the transform switches, beyond the plan's list, because they change the searched variants."
  - "The standalone is embedded before the 150 ms stage budget starts (under the embed stage's timeout): check plus source re-resolution share the 150 ms. An embed or hash failure records semantic_cache skipped (key_unavailable) and the embed stage embeds as usual."
  - "Every bypass and stand-down is recorded as status disabled with detail bypass=<reason>, off, no_backend or no_cache_context; a lookup records ok with detail miss, miss citations_unresolved or hit distance=<d>; a failure or timeout records skipped. semantic_cache never affects status (A-2, existing statusRecords filter)."
  - "A missing ragMode counts as bypass (rag_mode); the chat and embed routes always pass it. Without input.cacheContext (generator model and prompt hash unknown) the stage stands down, so nothing reads the cache until 06-36 passes it."
  - "The ticket is handed out whenever check-time bypass is null and the standalone was embedded, including on a check timeout or citations_unresolved miss; a hit result carries no ticket. Voice never reaches the stage (profile bypass), and buildV2Result never puts a ticket on a voice result."
  - "On a hit, citations and sources get the current document name and version; any cited document that no longer resolves turns the hit into a miss that continues to retrieval."
  - "effectiveQueryLayerConfig and queryLayerOverrides moved to query/layer-config.ts (run-layer re-exports them) so the hash path does not depend on run-layer, which several tests mock with runQueryLayer only."

patterns-established:
  - "Cache stage tests drive runQueryLayer with a hand-built SemanticCacheSeam and an in-memory backend keyed by scope key, key hash and embedding profile; pipeline tests use runRetrieval with RagDeps.semanticCache"

requirements-completed: [CACHE-01]

coverage:
  - id: D1
    description: "Query-layer part of the retrieval-config hash; Phase 4 hash unchanged with the layer off"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "tests/rag/v2/config-hash-query.test.ts"
        status: pass
      - kind: unit
        ref: "tests/rag/v2/params-hash.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "semantic_cache stage: bypass rules (protected tokens, document refs, retrieval options, rag mode, profile), key with entry profile from input.profile, TenantScope lookup, two-tenant and eval-versus-chat isolation, fail-open on error and 400 ms delay, store ticket"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "tests/rag/cache/stage.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Standalone embedded once; embed batch skips it; check key hash equals the result hash"
    requirement: CACHE-01
    verification:
      - kind: integration
        ref: "tests/rag/cache/stage.test.ts#semantic_cache stage in the v2 pipeline"
        status: pass
    human_judgment: false
  - id: D4
    description: "Hit citations re-resolved through rag_cache_resolve_sources; unresolved means miss"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "tests/rag/cache/stage.test.ts#a hit re-resolves cited documents"
        status: pass
    human_judgment: false
  - id: D5
    description: "Hit short-circuit: ok / cache_hit / cacheHit, no search, rank or context; refusal hit keeps is_refusal; no hit with the layer off"
    requirement: CACHE-01
    verification:
      - kind: integration
        ref: "tests/rag/cache/stage-hit.test.ts"
        status: pass
    human_judgment: false

duration: 75min
completed: 2026-11-26
status: complete
---

# Phase 6 Plan 32: Semantic-cache stage in the query layer Summary

**Chat and embed requests under v2 with the query layer and a cache backend now check the semantic cache once, after the parallel transforms, with the full key and bypass rules; a hit returns the cached answer without search, rank or context, a miss hands the entry point a store ticket, and the standalone vector is reused by the embed step.**

## Performance

- **Duration:** about 75 min
- **Tasks:** 3 (each RED then GREEN)
- **Files modified:** 14 (6 created)

## Accomplishments

- `computeRetrievalConfigHash` takes an optional `queryLayer` part and adds it to the canonical JSON only when present; the Phase 4 pinned hash is unchanged with the layer off.
- `runQueryLayer` runs the `semantic_cache` stage at the D-05 position: profile, mode and check-time bypass rules first (never embedding or checking a bypassed turn), then one standalone embed, the key over plan language, RAG mode, generator model, retrieval-config hash, framework, entry profile (from `input.profile`) and system-prompt hash, and a `check` scoped by the request's `TenantScope` and the embedding profile id.
- Hits with citations are re-resolved under the request scope through `rag_cache_resolve_sources`; unresolved cited documents turn the hit into a miss (`citations_unresolved`).
- The v2 pipeline lends the stage an embed function and the shared config-hash function; the embed batch skips the precomputed standalone (one embed call less), and a hit short-circuits to `status ok`, `reason cache_hit` with `cacheHit {entryId, distance, answer}`.

## Task Commits

1. **Task 1: query-layer hash part and cache inputs**: `894ef72` (test, RED), `a77ea59` (feat)
2. **Task 2: semantic_cache stage and vector reuse**: `626b73b` (test, RED), `416bae8` (feat), `a29d6fd` (fix: config helpers moved to layer-config.ts)
3. **Task 3: hit short-circuit**: `084b397` (test, RED), `307bc0b` (feat)

## Tests that failed before the change

- `tests/rag/v2/config-hash-query.test.ts`: 2 of 4 failed (the hash ignored a query-layer part).
- `tests/rag/cache/stage.test.ts`: 17 of 18 failed (no stage records, no checks, no ticket).
- `tests/rag/cache/stage-hit.test.ts`: 2 of 3 failed (a hit still searched).
- `tests/rag/v2/rerank-standalone.test.ts` failed after `416bae8` (mocked run-layer lacked the config helpers); fixed by `a29d6fd`.

## Behaviour changes

- Switches off (`RAG_QUERY_LAYER=false` or `RAG_PIPELINE=legacy`): none. run-layer is not imported, the hash is the Phase 4 value, no stage record is added.
- Layer on, `RAG_SEMANTIC_CACHE=off`: one extra trace record (`semantic_cache` disabled, detail `off`) and `result.retrievalConfigHash` now includes the query-layer part (A-7). No cache call, no extra embed.
- Layer on, cache on: as described above; nothing reaches the cache until an entry point passes `cacheContext` (06-36).

## Deviations from Plan

- **[Rule 3 - blocking] The embed step lives in `v2/pipeline.ts`, not `search.ts`.** `embedForRetrieval` moved to `search.ts` with the new `embedVariantTexts` (precomputed map); the pipeline's embed stage calls it.
- **[Rule 3 - blocking] The retrieval-config hash needs the binding legs, the embedding profile and the query language, which only the pipeline knows.** Solved with a `SemanticCacheSeam` passed through `runQueryStages` into `runQueryLayer`, and one shared `requestRetrievalConfigHash` in `result.ts`.
- **[Rule 1 - bug] `rerank-standalone.test.ts` mock** (see above); new module `src/lib/rag/query/layer-config.ts`.
- Added `transforms` to the query-layer hash part (not in the plan's list) because the transform switches change what is searched.
- Phase 4.1.1 has not landed (no terminology stage or `terminologyHashBlock` in the tree), so the key has no terminology part yet; the stage sits after the parallel group and before the embed stage, leaving the 4.1.1 slot (after the parallel group, before semantic_cache) open.

## Gate results

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 421 files, 7042 passed, 4 skipped, 0 failed
- `node --import tsx --test tests/*.test.mts`: 172 passed, 0 failed
- `node --import tsx --test tests/rag-db/*.test.mts`: 2066 passed, 4 skipped, 0 failed
- `check-rag-boundary.mjs` and its node test: pass (52)
- `node scripts/check-config.mjs`: ok (191 variables; no new env variable)
- `check-workflows.py`: OK
- `npm run test-rag -- --out eval/out/06-32`: gate PASS (7 skipped)
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-32-ingest`: gate PASS (7 skipped)
- No Python, contract or UI file touched, so the sidecar/eval pytest, `gen:schemas` and frontend-design gates do not apply.
- ESLint on the touched files: 5 errors and 20 warnings, all on lines this plan did not change (pre-existing: `_hash`/`_prov` in config-hash.ts, `assertTenantScope` and an unused `index` in pipeline.ts, `params` in buildV2Result, which the base commit already reports).

## Decisions for STATE

- CACHE-01 pipeline side done: stage, key, bypasses, source re-resolution, ticket and short-circuit.
- `result.retrievalConfigHash` includes the query-layer part while the layer runs.
- The cache stays inert until 06-36 passes `cacheContext` from chat and embed (and 06-41 from the eval route).

## Operator actions

- None. Live checks against a real Supabase or RedisVL backend stay with 06-36 / 06-42.

## Deferred

- Streaming hits, `store` in `after()` with the ticket, the answer record for hits: 06-36.
- `terminologyHashBlock` in the key: when Phase 4.1.1 lands.
- Calibrated distance from `eval/config/semantic-cache.json` (D-37): the stage passes no `maxDistance`, so the backend default (`RAG_SEMANTIC_CACHE_MAX_DISTANCE`) applies.
- A cache hit does not skip the query layer's own parallel transforms (they run before the cache by D-05).

## Self-Check: PASSED
