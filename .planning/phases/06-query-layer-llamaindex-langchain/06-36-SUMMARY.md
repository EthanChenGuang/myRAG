---
phase: 06-query-layer-llamaindex-langchain
plan: 36
subsystem: rag-cache
tags: [semantic-cache, cache-01, d-32, d-33, d-36, a-3, chat, embed, groundedness, answer-record]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-32 semantic_cache stage, CacheTicket, cacheHit short-circuit and rag_cache_resolve_sources re-resolution; 06-17 storeBypassReason and key hash; 06-21 backends, fail-open wrapper and RagDeps.semanticCache; 06-33 last chat/embed route edits; 06-27 index.ts"
  - phase: 05-verified-citations-groundedness
    provides: "05-13 answerId and scheduleAnswerFinish; 05-18 post-stream groundedness step"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-15 last Phase 5.1 edit of the chat route"
provides:
  - "src/lib/rag/cache/store-after.ts: scheduleCacheStore, cacheSourcesFromResult, CACHE_STORE_GROUNDEDNESS_WAIT_MS (25 s)"
  - "src/lib/rag/cache/hit-stream.ts: streamCachedAnswer, cacheHitMetadata"
  - "isSemanticCacheActive() in src/lib/rag/v2/switch.ts"
  - "hashedTenantKey exported from src/lib/rag/cache/index.ts"
  - "scheduleAnswerFinish now returns Promise<AnswerGroundedness | null> (never rejects); AnswerFinishInput.groundedness for hits (inserted unchanged, no scoring); createGroundednessStep returns its label"
  - "@/lib/rag exports: scheduleCacheStore, cacheSourcesFromResult, streamCachedAnswer, cacheHitMetadata, hashSystemPromptTemplate, isCacheHitResult, isSemanticCacheActive"
affects: [06-41, 06-42, 06-44, 05.2]

actuals:
  tasks: 3
  commits: 9

key-files:
  created:
    - src/lib/rag/cache/store-after.ts
    - src/lib/rag/cache/hit-stream.ts
    - tests/rag/cache/store-after.test.ts
    - tests/rag/chat-cache-hit.test.ts
    - tests/rag/__snapshots__/chat-cache-hit.test.ts.snap
    - tests/rag/generation/answer-finish-cache.test.ts
    - tests/rag/embed-cache.test.ts
  modified:
    - src/lib/rag/index.ts
    - src/lib/rag/cache/index.ts
    - src/lib/rag/v2/switch.ts
    - src/lib/rag/generation/answer-finish.ts
    - src/app/api/chat/route.ts
    - src/app/api/embed/chat/route.ts

requirements-completed: [CACHE-01]
---

# 06-36 SUMMARY: cache hits and stores in chat and embed

## Accomplishments

- **Store scheduler** (`scheduleCacheStore`): one after-response task per eligible turn. It waits for the Phase 5 groundedness label (25 s at most), applies `storeBypassReason` on the ticket's check-time facts plus the store-only facts, re-resolves the source documents' current versions under the request scope (`rag_cache_resolve_sources`; an unresolved or changed source means no store), builds and validates a `CachedAnswer` and calls the backend `store`. A failure is logged once as `[Semantic Cache] store failed, dropped` with a hashed tenant key and dropped.
- **Hit stream** (`streamCachedAnswer`): start metadata `{ragTraceId: <original trace>, cache: 'hit', …}`, the legacy `metadata` sources part (re-resolved document names), the cached text, and finish metadata with the capped citations. No retrieval beyond the one `runRetrieval` call and no generation call.
- **Chat route**: `cacheContext` (generator model, hash of the system-prompt template before `{{context}}` plus the citation strategy, webSearch, MCP/multi-step/tool continuation, chat id) is passed only while `isSemanticCacheActive()`. A hit short-circuits before the failure/refusal checks. A cached refusal streams the stored localized refusal with `refusal: true`. An answer hit applies the Phase 5 record rule: the request's `answerId` goes in the start and finish metadata, and after the stream `scheduleAnswerFinish` runs once with the cached text, the re-resolved citations and the cached groundedness (no scoring). On a miss with a ticket, the store is scheduled in `onFinish` after the answer record, chained to that record's groundedness promise. The strict refusal path stores refusals (refusal TTL comes from the backend).
- **Embed route**: same hit stream (with the feedback token when the embed rating applies, and the normal CORS and rate-limit headers). Stores are scheduled from `streamText.onFinish`; the store rule `embed_check_only` keeps embed check-only unless `RAG_SEMANTIC_CACHE_EMBED_STORE=true`.

## Task Commits

1. **Task 1: store scheduler**: `1cda5b46` (test, RED), `ecb66fce` (feat)
2. **Task 2: chat hits and stores**: `38ffb388` (test, RED answer finish), `cf3fb88b` (feat answer finish), `7bacc194` (test, RED route + cache-off snapshot recorded on today's route), `4e2bd561` (feat)
3. **Task 3: embed**: `ad438723` (test, RED), `091cb2d7` (feat)

## Tests that failed before the change

- `tests/rag/cache/store-after.test.ts`: 8 of 13 failed (stub scheduler stored nothing).
- `tests/rag/generation/answer-finish-cache.test.ts`: 5 of 5 failed (no groundedness handle; a hit was scored like a fresh answer).
- `tests/rag/chat-cache-hit.test.ts`: 10 of 12 failed, including the same-tenant colleague attachment test, the two-tenant attachment test and the non-default-options test. Their positive controls fail without the wiring. The cache-off snapshot test passes on the old route on purpose: it was recorded there.
- `tests/rag/embed-cache.test.ts`: 5 of 6 failed.

## Behaviour changes

- Every switch off (`RAG_SEMANTIC_CACHE=off`, the query layer off, legacy pipeline): nothing changes. `runRetrieval` gets no `cacheContext`. The chat stream matches the snapshot recorded on the pre-change route byte for byte, and the system-prompt template is still built after retrieval (the hoisted builder is memoized and only called early when the cache is active). Strict "information not available", webSearch, `source_images`, `{{context}}` and voice are untouched. Every characterization suite passes.
- Cache on: hits as described above. A hit's `ragTraceId` is the trace that produced the answer; the request still writes its own retrieval trace and log row.
- `scheduleAnswerFinish` returns a promise instead of `void`. Existing callers ignore it.

## Deviations from Plan

- **[Rule 2 - missing seam] Phase 5 exposed no groundedness promise.** `scheduleAnswerFinish` now settles with the record's final groundedness (scored or the inserted not_checked), or null when no record was written. `AnswerFinishInput.groundedness` lets a hit insert the cached object without scoring. File not in the plan's list: `src/lib/rag/generation/answer-finish.ts`, with a new test file.
- **[Rule 2 - security] Groundedness on, but no label for the turn** (no answer record: anonymous caller, no citations capability, embed): the answer is **not stored**, because it was never scored. With groundedness off it is stored as `not_checked/disabled`. Refusals are always storable as `not_checked/refusal`, since they are fixed system text. Consequence: with `RAG_GROUNDEDNESS=true`, embed never stores even when `RAG_SEMANTIC_CACHE_EMBED_STORE=true`.
- **[Rule 2 - security] Attached images:** a chat turn with an attached image gets no `cacheContext`, so it neither reads nor writes the cache. The image is not part of the key or the bypass facts.
- **[Rule 2 - correctness] The citation strategy is hashed with the template** (`template \0 citations:<strategy|none>`). Without it, answers with and without alias markers would share a key.
- **[Rule 3 - blocking] The chat system-prompt template was built after retrieval.** It moved into a memoized closure. Byte-identical template literal; the workspace-prompt lookup runs early only when the cache is active.
- **[Rule 3] Source versions:** context blocks often carry no version, so the store re-resolves current versions with `rag_cache_resolve_sources` after the response. A block version that disagrees with the current one aborts the store (the SQL store check rejects stale versions as well).
- Non-default `maxResults` cannot come from the chat request body (the route always passes the configured count). That case is tested through `runRetrieval` with the route's own input in the same test, and `generalOverview` is tested at route level (empty message).
- Tool use observed after retrieval (webSearch results or MCP tool output in the answer) is passed as `toolsUsed` and blocks the store.

## Gate results

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 455 files, 7538 passed, 4 skipped, 0 failed
- `node --import tsx --test tests/*.test.mts`: 172 passed, 0 failed
- `node --import tsx --test tests/rag-db/*.test.mts`: 2103 passed, 4 skipped, 0 failed
- `check-rag-boundary.mjs` ok; its node test 52 passed
- `node scripts/check-config.mjs`: ok (192 variables; no new variable)
- `check-workflows.py`: OK
- `npm run test-rag -- --out eval/out/06-36`: gate PASS (7 skipped)
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-36-ingest`: gate PASS (7 skipped)
- No Python, contract or UI file touched: sidecar/eval pytest, `gen:schemas` and the frontend-design gate do not apply.
- ESLint on new files: warnings only (unused parameter names in type signatures), 0 errors.

## Decisions for STATE

- CACHE-01 entry-point side done: chat and embed serve hits and store after the response behind groundedness.
- A hit writes its own Phase 5 answer record with the cached groundedness (W6); refusal hits write none, as fresh refusals do.
- With `RAG_GROUNDEDNESS=true`, only turns that Phase 5 actually labelled are stored (unscored turns are not).
- The cache key's system-prompt hash covers the citation strategy.

## Operator actions

- Live checks against a real Supabase `rag_semantic_cache` and a RedisVL sidecar (hit latency, real groundedness labels): record them in 06-42 / 06-46. None were run here.

## Deferred

- The eval route's cache context and seeding: 06-41.
- Phase 5.2 RNK-08 prompt budget: untouched. Prompt assembly order is unchanged and the user question stays last.
- Phase 4.1.1 `terminologyHashBlock`: not in the tree yet. Nothing in this plan blocks it.

## Self-Check: PASSED
