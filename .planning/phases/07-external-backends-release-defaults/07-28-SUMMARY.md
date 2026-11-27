---
phase: 07-external-backends-release-defaults
plan: 28
subsystem: rag-retrieval-backend
tags: [canary, cross-tenant, semantic-cache, embed, voice, qdrant, weaviate, pgvector, pglite]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "canary factory, seeding, drain/reconcile and guard (07-14); voiceRequest / embedRequest drivers (07-34); the backend id and index parameters in the retrieval config hash (07-12)"
  - phase: 06-query-layer
    provides: "rag_semantic_cache SQL (06-12), the semantic_cache stage (06-32), store-after (06-36), the pgvector cache canary (06-42), Phase 6 close (06-45)"
provides:
  - "tests/rag/canary/factory.ts: createCanaryEnv(backend, mode, { cache: 'pgvector' }) and env.ask(scope, question, { profile, backend, voiceBackend, store, semanticCache }) returning CanaryAnswer; CANARY_CACHE_CONTEXT"
  - "tests/rag/canary/semantic-cache.test.ts: cross-tenant, invalidation (delete with cascade, version replace, quarantine and release), backend switch and cache-off cases on every backend"
  - "tests/rag/canary/semantic-cache-entry-points.test.ts: embed-scope cache isolation, the tenant-ignoring cache negative control, voice never touching the cache"
  - "src/lib/rag/cache/sources.ts: resolveHitSources re-checks every document a hit names (citations, sources, source versions) under the request scope"
affects: [07-16, 07-31]

actuals:
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "ask() runs runRetrieval with the request switches injected through setRagDepsForTests (RAG_PIPELINE=v2, RAG_RETRIEVAL_BACKEND, RAG_QUERY_LAYER, RAG_SEMANTIC_CACHE, the fake query LLM with an empty table, a recording admin client), never through process.env; previous dependencies are restored after each request"
    - "Store-after runs through scheduleCacheStore with a schedule override that collects the task, and ask() awaits it before returning, so the next ask sees the stored row"
    - "The stub generator answers with every candidate's content (so a leaked answer carries the owner's marker) and, for chat, one chunk-alias citation per document (so a hit carries chunk ids that rag_validate_chunks can re-check)"

key-files:
  created:
    - tests/rag/canary/semantic-cache.test.ts
    - tests/rag/canary/semantic-cache-entry-points.test.ts
    - tests/rag/cache/hit-sources-recheck.test.ts
  modified:
    - tests/rag/canary/factory.ts
    - src/lib/rag/cache/sources.ts

key-decisions:
  - "Phase 6 gap closed, not only reported (deviation, security rule): the stage's source re-check (resolveHitSources) looked at citations only, so a hit with sources but no citations (every embed answer; chat with RAG_CITATIONS off) reached the entry point unchecked. The Task 3 negative control proved it: a tenant-ignoring cache handed O's embed answer to B and the stage served it. The fix resolves the union of citation, source and source-version document ids under the request's TenantScope; any id that does not resolve makes the hit a miss. Version freshness stays with the backends (rag_cache_sources_current), so the Phase 6 'cited document renamed and re-versioned is served with current names' case is unchanged, and a hit naming no document still makes no call"
  - "ask() without the cache option keeps RAG_SEMANTIC_CACHE=off and RAG_QUERY_LAYER=false, which is the plan 07-14 retrieval; the existing search(), rawStoreSearch() and every other export are unchanged"
  - "The cross-tenant case also checks the cache backend directly (createPgvectorSemanticCache over the service-role client with A's ticket key and vector under B, O and M), because the stage re-check would otherwise mask a backend that ignores the tenant key; that is what makes the 'cache key without the tenant key' mutation fail"
  - "M (personal, no documents) has no index state on an external backend, so its search falls back to pgvector (as in 07-14); the tests expect that selection for M only"
  - "Voice is asserted twice: through voiceRequest with the cache switches on in the request environment (the production voice path, which passes no cache context), and through ask() with profile voice and a cache context (the stage's own profile rule); neither calls rag_cache_check or rag_cache_store"
  - "The backend switch is checked in both directions on external legs (stored under the backend, asked under the other two; stored under pgvector, asked under the backend); on the pgvector leg, asking under qdrant and weaviate is a miss because the configured backend enters the hash even when the request then falls back"

patterns-established:
  - "Cache negative controls pass a test-only SemanticCache through ask({ semanticCache }) (the deps seam the stage already reads); production wiring is unchanged"

requirements-completed: [RET-08, RET-07]

duration: ~2h
completed: 2026-11-27
---

# Phase 7 Plan 28: Semantic-cache cross-tenant canary Summary

**The cross-tenant canary now covers the Phase 6 semantic cache on pgvector, Weaviate and Qdrant through the chat, embed and voice entry points, seeded through ingest, the outbox and the drain. Its tenant-ignoring negative control found that the cache stage did not re-check citation-free hits (every embed answer); that gap is closed in `resolveHitSources`. All cases passed against live Qdrant 1.20.2 and Weaviate 1.40.7.**

## Baseline (count gates at plan start, HEAD ffd59a34)

- `grep -c "cache: 'pgvector'" tests/rag/canary/semantic-cache.test.ts`: error (file absent)
- `grep -c "embedRequest" tests/rag/canary/semantic-cache-entry-points.test.ts`: error (file absent)
- `-t "cross-tenant"`, `-t "backend switch"`, `-t "negative control"`: error (files absent)

Every depends_on plan, transitively (254 plans), has a SUMMARY on this branch.

## Task Commits

1. Task 1: `375ed0f9` test(07-28): cache-aware canary requests and the cross-tenant cache case
2. Task 2: `d76da241` test(07-28): cache invalidation after synced changes and the backend switch (also corrects Task 1's expectation for M on external backends, which falls back to pgvector)
3. Task 3, gap RED: `df45266c` test(07-28): RED - a citation-free cache hit is re-checked under the request scope (3 of 4 fail on assertions on the old code)
4. Task 3, gap GREEN: `265cce97` fix(07-28): re-check every document a cache hit names under the request scope (the RED file's version-mismatch case was replaced by a mixed own/foreign case when the fix dropped the version check; the replaced file still fails 3 of 4 on the old code)
5. Task 3: `e7704531` test(07-28): embed and voice scopes through the cache with a tenant-ignoring control
6. This SUMMARY

Tasks 1 and 2 have no RED commit: they test behaviour that already exists (the Phase 6 cache and the 07-12 hash). The guard mutations below show they fail when that behaviour breaks.

## What the suite covers

`semantic-cache.test.ts`, per backend, multi-tenant, cache on:
- Cross-tenant: A asks the canary sentence (miss, served by the backend under test, stored), asks again (hit, no search, `cache_hit`); the hit's chunk ids are A's and all pass `rag_validate_chunks` under A's key; its sources are A's document. B, O and M ask the identical sentence with the identical vector: each a miss with its own search, no A marker, no A chunk id. The cache backend itself answers A's key under B, O and M with null.
- Each of A, B and O stores the identical sentence; each then hits only its own entry (own marker, own chunk ids, validated under its own key, one row each); M misses.
- A hit for A is never reused for B: B's search records the backend under test with no fallback and returns B's canary.
- Delete with cascade, then settle: A's entry is a miss, no tenant sees the marker, the store holds no point of the document.
- Version replace, then settle: miss; the superseded version's marker and chunks never return; no point of it remains; the new version serves its owner.
- Quarantine of a new version, then settle: miss, the held chunks never appear and are never synced; after release the old entry stays a miss, the superseded clean version never returns, the released version is servable and synced.
- Backend switch: an entry stored under the backend misses under the other two backend ids; on external legs an entry stored under pgvector misses under the backend.
- Cache off (`createCanaryEnv` without the option): every ask has no semantic_cache stage, no ticket, no store and no `rag_cache_*` call; its chunks are a subset of the plan 07-14 `search()` hits; isolation holds.

`semantic-cache-entry-points.test.ts`, per backend:
- Embed `o:<O>` (scope resolved by `embedRequest` from the configured tenant only) misses, is stored (`RAG_SEMANTIC_CACHE_EMBED_STORE` on), hits. Embed `u:<B>` with the identical vector misses with no O marker or chunk id; chat in A misses; chat in O misses too (entry profiles never share an entry).
- Negative control: a fake SemanticCache answers every check from O's entries. Its raw return holds O's answer; the stage calls `rag_cache_resolve_sources` under B's key and B gets a miss, no O marker, no O chunk id, no O document; chat in B the same; O itself still hits (positive control).
- Voice, with `RAG_RETRIEVAL_BACKEND_VOICE` unset and set to the backend, after O (embed) and A (chat) stored the identical sentence: A, B and O through `voiceRequest` with the cache switches on make no `rag_cache_check` or `rag_cache_store` call, carry no ticket or hit and only their own canary; the same through `ask({ profile: 'voice' })` with a cache context.

## Mutation guards (run by hand, then reverted; `git status src/` clean)

- Cache lookup without the tenant key (pgvector backend's check uses the last stored tenant key): `-t "cross-tenant"` 2 failed ("the backend itself answers A's key with a miss", "hits its own entry").
- Retrieval config hash without the backend id and index parameters (`backendId: getRetrievalBackend().id`, no `backendIndex`): `-t "backend switch"` 1 failed ("stored under pgvector, asked under weaviate").
- Stage that skips the source re-check for a citation-free hit (the code before `265cce97`): `-t "negative control"` 1 failed ("B gets a miss: expected 'hit'").

## Acceptance

- `grep -c "cache: 'pgvector'" tests/rag/canary/semantic-cache.test.ts`: 1
- `npx vitest run tests/rag/canary/semantic-cache.test.ts -t "cross-tenant"` (pgvector): 3 passed, 0 failed
- `npx vitest run tests/rag/canary/semantic-cache.test.ts -t "backend switch"` (pgvector): 1 passed, 0 failed
- `grep -c "embedRequest" tests/rag/canary/semantic-cache-entry-points.test.ts`: 2
- `npx vitest run tests/rag/canary/semantic-cache-entry-points.test.ts -t "negative control"` (pgvector): 1 passed, 0 failed
- semantic-cache.test.ts: pgvector alone 8 passed; with `RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant` 24 passed, 0 failed (3 × 8)
- semantic-cache-entry-points.test.ts: pgvector alone 4 passed; with all three backends 12 passed, 0 failed (3 × 4)

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/rag/canary` (default, pgvector leg): 8 files passed, 1 skipped; 46 passed, 87 skipped
- `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant QDRANT_URL=http://127.0.0.1:6333 WEAVIATE_URL=http://127.0.0.1:8080 npx vitest run tests/rag/canary`: 9 files, 124 passed, 9 skipped
- Same environment plus the compose placeholder keys, `npx vitest run tests/rag/backend-conformance`: 4 files, 80 passed. Without `QDRANT_API_KEY` / `WEAVIATE_API_KEY` etc. exported, the Weaviate conformance file fails at startup with 401 (the canary factory fills the placeholders itself, the conformance suite does not); environmental, not caused by this plan
- `npx vitest run tests/rag/cache tests/rag/embed-cache.test.ts tests/rag/chat-cache-hit.test.ts tests/eval-route-cache.test.ts tests/rag/canary/semantic-cache-entry-points.test.ts` (every test importing the cache stage or sources): 19 files, 217 passed, 8 skipped
- Full `npx vitest run` (sources.ts is read by the query layer on every hit): 740 files (737 passed, 3 skipped), 13293 passed, 143 skipped, 0 failed
- `node --import tsx --test tests/rag-db/semantic-cache*.test.mts`: 206 passed, 0 failed
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all exit 0
- `npm run test-rag -- --fixture-mode ingest --out eval/out/07-28-ingest`: gate PASS
- `npm run test-rag -- --out eval/out/07-28`: gate FAIL, `false_refusal_rate language:en: measured 0.3143 vs max 0.2500`. Pre-existing: the base 07-34 (ffd59a34) with `src/lib/rag/cache/sources.ts` restored to its old content gives the identical numbers (356 items, false_refusal 0.246 overall, en 0.3143). Trunk `claude/ecstatic-hamilton-86gtwv` (247-item golden set) passes, so the failure arrived with the merged base (main incl. train 34, 06-45, 07-34), not with this plan; the eval runs with the cache off and never reaches `resolveHitSources`
- `npx eslint` on the changed files: 0 errors; 4 new warnings, all parameter names in function-type signatures (the pattern 07-14 and 07-34 recorded)
- Not run, because this plan does not touch their areas: SQL/migrations (no migration added), workflows, Python, contracts (`gen:schemas`), UI

## Deviations from Plan

- **Gap fix outside the plan's files (security rule).** The plan said to stop and report if the negative control leaked. It leaked: the stage served O's citation-free embed answer to B. Following the brief's first rule (a cross-tenant leak is the worst failure; no insecure path stays), the gap is closed in `src/lib/rag/cache/sources.ts` with a unit test that fails on the old code, instead of leaving a red canary. No sibling plan in this wave touches `src/lib/rag/cache/` (07-37 edits backend and v2 files only). In production both shipped cache backends already re-check source versions under the tenant key in SQL, so the gap needed a backend that ignores the tenant; the fix makes the stage's own re-check independent of whether the answer has citations. Cost: one `rag_cache_resolve_sources` call on hits that name sources but no citations, inside the existing 150 ms stage budget.
- **External services.** The container had no running Docker daemon; `dockerd` was started in the session, and Docker Hub answered 429 for the pinned digests, so the two images were pulled by the same digests from `mirror.gcr.io`, tagged locally, and run with a copy of docker-compose.backends.yml without the digest suffix (same images, same settings and placeholder keys). Nothing in the repository changed for this.
- **ask() options beyond the plan's signature.** `ask(scope, question)` takes optional `{ profile, backend, voiceBackend, store, semanticCache }` so the backend switch, the embed and voice profiles and the negative control use one entry point.

## Operator actions

- None. The 07-16 backend-canary job runs every file under tests/rag/canary, so the two new files are gated there without a workflow change.

## Decisions for STATE

- `resolveHitSources` re-checks every document a cache hit names (citations, sources, source versions) under the request scope; a hit naming no document still makes no call; version freshness stays with the backends.
- `createCanaryEnv(backend, mode, { cache: 'pgvector' })` and `env.ask(scope, question, options)` returning `{ cache: 'hit' | 'miss' | 'bypass' | 'off', answerText, chunkIds, documentIds, texts, backend, storeAttempted, rpcCalls, result, scope }` are the canary's cache entry point (07-31 reaches 07-34 through this plan).

## Deferred

- The default `npm run test-rag` gate failure on `false_refusal_rate language:en` (pre-existing on the base; see Gates run) belongs to whichever merged plan raised the golden set to 356 items.
