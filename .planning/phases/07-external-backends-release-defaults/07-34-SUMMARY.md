---
phase: 07-external-backends-release-defaults
plan: 34
subsystem: rag-retrieval-backend
tags: [canary, cross-tenant, voice, embed, qdrant, weaviate, pgvector, revalidation, release-gate, pglite]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "canary factory, seeding and guard (07-14); resolveRetrievalBackend, RAG_RETRIEVAL_BACKEND_VOICE and readiness (07-12); Qdrant and Weaviate read clients and adapters (07-07, 07-08); createExternalBackend and rag_validate_chunks (07-06)"
  - phase: 02-tenant-scope
    provides: "resolveVoiceScope, mintVoiceToken, resolveEmbedScope (02-10); the voice profile (02-16)"
  - phase: 04-hybrid-retrieval
    provides: "voice under v2 (04-28)"
  - phase: 06-query-layer
    provides: "the voice and embed profiles at Phase 6 close (06-45)"
provides:
  - "tests/rag/canary/entry-points.ts: voiceRequest, embedRequest, chatRequest, mintCanaryVoiceToken, CANARY_VOICE_SECRET, filterIgnoringReader, filterIgnoringQdrant, filterIgnoringWeaviate, filterIgnoringRpc"
  - "tests/rag/canary/voice-scope.test.ts: voice-scope canary on every backend, the RAG_RETRIEVAL_BACKEND_VOICE switch and its fallback"
  - "tests/rag/canary/embed-scope.test.ts: embed-scope canary on every backend"
affects: [07-16, 07-28]

actuals:
  tokens: 11442
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Entry-point drivers: the scope comes only from the production resolver (resolveVoiceScope with a token minted for the tenant, resolveEmbedScope with the configured tenant), then runRetrieval with the profile and the backend switches injected through setRagDepsForTests (ragEnv, rawPipelineEnv, a recording adminClient); the previous dependencies are restored after each request"
    - "Selection is read from the search stage's trace record (backend, fallback_reason, tenant_validation_dropped, leg counts), so the assertions see what production records"
    - "Filter-ignoring negative controls sit below the adapters: a Qdrant read-client proxy strips every tenant_key clause from the batch qdrantScopedBatch built; a Weaviate client proxy answers every tenant handle from a foreign shard; both are installed with setExternalBackendForTests as createQdrantBackend / createWeaviateBackend over the wrapped client, so the fallback wrapper, readiness, re-validation and the security log run as in production. pgvector: an RPC proxy whose hybrid_search_chunks searches the foreign tenant key"

key-files:
  created:
    - tests/rag/canary/entry-points.ts
    - tests/rag/canary/voice-scope.test.ts
    - tests/rag/canary/embed-scope.test.ts
  modified: []

key-decisions:
  - "Retrieval runs through runRetrieval (the plan's wording), not through resolveRetrievalBackend directly as in 07-14; the backend switches reach it through the dependency seam (ragEnv), never through process.env"
  - "Voice results are read from both result.candidates and result.voice.results (what the voice agent receives), each chunk once"
  - "Qdrant's negative control strips the tenant clause, so the raw answer holds every tenant's points in the collection (including other concurrently running canary files on a live service); the expected tenant_validation_dropped is therefore the count of raw ids that are not the requesting tenant's own, and the control asserts that every one of B's (voice) or A's (embed) chunk ids is in it"
  - "Single-tenant voice and embed cases run on the pgvector leg only: s:default is one shared partition on a live store, and tenancy.test.ts already asserts its exact contents there (07-14 decision)"
  - "The readiness cache is reset before the default-routing comparison, so 'no readiness call' and 'chat makes one' are measured, not hidden by a warm cache"

patterns-established:
  - "07-28 builds its voice and embed cache cases on voiceRequest / embedRequest and filterIgnoringReader"

requirements-completed: [RET-08, RET-07, RET-09]

duration: ~60min
completed: 2026-11-27
---

# Phase 7 Plan 34: Voice and embed cross-tenant canary Summary

**The cross-tenant canary now covers the voice and embed entry points on pgvector, Weaviate and Qdrant, including the RAG_RETRIEVAL_BACKEND_VOICE switch and its not-ready fallback, with a filter-ignoring negative control in every case whose foreign ids the Supabase re-check drops. It passed against live Qdrant 1.20.2 and Weaviate 1.40.7.**

## Baseline (count gates at plan start, HEAD 0de2d5d7)

- `grep -c "resolveVoiceScope" tests/rag/canary/entry-points.ts`: error (file absent), exit 2
- `grep -c "RAG_RETRIEVAL_BACKEND_VOICE" tests/rag/canary/voice-scope.test.ts`: error (file absent), exit 2
- `grep -c "resolveEmbedScope\|embedRequest" tests/rag/canary/embed-scope.test.ts`: error (file absent), exit 2
- `npx vitest run tests/rag/canary/{voice,embed}-scope.test.ts -t "negative control"`: error (files absent)

No gate passed before the first edit.

## Task Commits

1. Task 1, RED: `5def7253` test(07-34): add failing voice-scope canary against stub entry-point drivers (6 of 6 pgvector cases fail: five on assertions, one through the test's own scope helper refusing the stub token)
2. Task 1, GREEN: `e48b0826` test(07-34): voice and embed entry-point drivers and filter-ignoring readers
3. Task 2: `8e14f07f` test(07-34): embed-scope canary on every backend with its negative control
4. This SUMMARY

Task 2 has no separate RED commit: its drivers (embedRequest, filterIgnoringReader) landed in Task 1's GREEN commit, so the embed tests passed when written. The guard mutations below show that they fail when the behaviour breaks.

## What the suite covers

Voice (`voice-scope.test.ts`), per backend with `RAG_RETRIEVAL_BACKEND_VOICE` set to it, multi-tenant:
- A, B and O each get their own canary on both legs, served by the backend under test (positive control). A, B, O and M (personal, no data) never get another tenant's marker or chunk id, for the shared sentence, the sentence plus each foreign marker, and each foreign marker alone.
- O's member gets O's canary only (scope `org`, user M, organization O); M's personal voice scope never sees O's marker.
- Refused before retrieval (no result, no RPC call): a tampered signature, B's claims under A's signature, a token minted with another secret (all 401 `bad_signature`), a malformed token (401 `malformed`), and a token for O after M left the organization (403 `not_a_member`). After M rejoins, the same token is served again.
- External backends: with `RAG_RETRIEVAL_BACKEND=<backend>` and the voice switch unset, voice selects pgvector with no `rag_backend_readiness` and no `rag_validate_chunks` call, while chat in the same environment selects the backend and reads readiness.
- External backends: with A's index state `stale`, voice falls back to pgvector with `backend_not_ready` and degraded, still answers A's own canary and no foreign one.
- Negative control (external): the filter-ignoring reader's raw answer holds every one of B's chunk ids; A's voice result holds none of the foreign ids, is served by the backend under test, `tenant_validation_dropped` equals the number of foreign raw ids, and exactly one `[RAG Security]` line is logged, with no UUID, marker, tenant key or sentence.
- pgvector: the filter-ignoring RPC returns B's rows for A's voice scope (resolved through resolveVoiceScope; its canonicalTenantKey is A's); rag_validate_chunks under that scope keeps none of them (requested = dropped), and keeps exactly A's chunks when they are added. With `RAG_RETRIEVAL_BACKEND=qdrant` and the voice switch unset, voice makes no readiness call; chat does and, with nothing synced, falls back degraded.
- Single-tenant (pgvector): a voice token carries `s:default` and is served the single tenant's documents; a personal token in that deployment is refused with 401 `mode_mismatch`.

Embed (`embed-scope.test.ts`), per backend with `RAG_RETRIEVAL_BACKEND` set to it, multi-tenant:
- `RAG_EMBED_TENANT=o:<O>` returns O's canary only (scope `org` with no user) for the sentence and every foreign marker; `u:<B>` returns B's only.
- A raw body naming another workspace (`organizationId` of another organization, `workspaceId` of A, `tenant` of A, `tenant` `s:default`) is refused with 403 `workspace_mismatch` before retrieval; a body naming the configured workspace is served.
- Unset, `s:default` in multi-tenant mode and an unknown organization fail closed (`embed_tenant_unconfigured`, `embed_tenant_invalid`, `embed_tenant_unknown`) with no search.
- External backends: with O's index state stale the embed request falls back to pgvector degraded with `backend_not_ready` and stays isolated.
- Negative control (external): the raw answer holds A's chunk ids for O's embed scope; the result holds none, `tenant_validation_dropped` equals the foreign raw count, one content-free `[RAG Security]` line.
- pgvector: the filter-ignoring RPC returns A's rows for O's embed scope; rag_validate_chunks under that scope drops all of them.
- Single-tenant (pgvector): unset and `s:default` serve `s:default` only; a workspace key is `embed_tenant_invalid`; a body naming a workspace is `workspace_mismatch`.

## Mutation guards (run by hand, then reverted)

- Passing the filter-ignoring fake's rows straight through without rag_validate_chunks (voice pgvector parity case): `-t "negative control"` 1 failed.
- An embedRequest that takes the tenant from the request body: 2 failed (workspace refusal, single-tenant case).
- Skipping re-validation in `createExternalBackend` (every store id kept): the four external negative controls fail (voice and embed, Weaviate and Qdrant). `src/` was restored; `git status src/` is clean.

## Acceptance

- `grep -c "resolveVoiceScope" tests/rag/canary/entry-points.ts`: 3
- `grep -c "RAG_RETRIEVAL_BACKEND_VOICE" tests/rag/canary/voice-scope.test.ts`: 4
- `grep -c "resolveEmbedScope\|embedRequest" tests/rag/canary/embed-scope.test.ts`: 17
- `npx vitest run tests/rag/canary/voice-scope.test.ts -t "negative control"` (pgvector): 1 passed, 0 failed
- `npx vitest run tests/rag/canary/embed-scope.test.ts -t "negative control"` (pgvector): 1 passed, 0 failed
- voice-scope: pgvector alone 6 passed; with `RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant` 18 passed, 0 failed (3 × 6)
- embed-scope: pgvector alone 6 passed; with all three backends 18 passed, 0 failed (3 × 6)

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/rag/canary` (default, pgvector leg): 6 files passed, 1 skipped; 34 passed, 63 skipped
- `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant QDRANT_URL=http://127.0.0.1:6333 WEAVIATE_URL=http://127.0.0.1:8080 npx vitest run tests/rag/canary`: 7 files, 88 passed, 9 skipped, run twice, both green; afterwards both Qdrant collections held 0 points
- `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector npx vitest run tests/rag/canary/guard.test.ts`: exits 1 (the 07-14 guard still fails a job that misses a backend)
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all exit 0
- `npx eslint` on the three new files: 0 errors, 2 warnings (parameter names in function-type signatures, the pattern 07-14 recorded)
- Not run, because this plan changes no production module, SQL, workflow, Python, contract, retrieval, ingest or UI file: the full `npx vitest run`, `tests/rag-db`, `tests/*.test.mts`, check-workflows, pytest, `gen:schemas`, `npm run test-rag`, the frontend design check. No module under `src/` changed, so no other test file imports a changed module.

## Deviations from Plan

- External services without Docker: the container has no Docker daemon. Qdrant 1.20.2 (the musl release binary; the glibc build needs a newer glibc than the container has) and Weaviate 1.40.7 (release binary, with `CLUSTER_ADVERTISE_ADDR`/`CLUSTER_BIND_ADDR=127.0.0.1` because the container has no private IP) were run from their GitHub releases with the docker-compose.backends.yml keys and settings, in the session scratchpad. Same versions as the compose file; nothing was installed into the repository.
- The negative controls wrap the read client and install the adapter with `setExternalBackendForTests` (the factory's existing test seam) rather than wrapping `getQdrantReadClient` in place: the factory caches the built adapter per process, and the seam swaps it for one request without changing production wiring. Re-validation still goes through `getRagDeps().adminClient()`, as in `buildExternal`.
- The plan names `tenant_validation_dropped` "equal to the number of B ids returned"; for Qdrant the stripped filter returns every tenant's points, so the test compares with the number of raw ids that are not A's own (see key decisions). For Weaviate the foreign shard holds exactly B's points, so the two counts coincide.
- Embed gets one more case than the behaviour list (the stale-tenant fallback, mirroring the voice case), which also brings the all-backend count to 3 × the pgvector count.

## Operator actions

- None. The 07-16 backend-canary job runs every file under tests/rag/canary, so the new files are gated there without a workflow change. As 07-14 recorded, keep the canary in its own step, apart from the backend-conformance suites that drop the legacy collection.

## Decisions for STATE

- `voiceRequest(env, tenant, question, config, options?)` and `embedRequest(env, configuredTenant, rawBody, question, config)` return `{ refused, scope, result, selection, ids, contents, rpcCalls }`; `filterIgnoringReader(env, foreignTenant)` returns `{ rawIds(), uninstall() }`. 07-28 builds its voice and embed cache cases on these.
- The voice token secret in the canary is generated per process (`CANARY_VOICE_SECRET`, 64 hex characters); no secret is committed.
