---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 16
subsystem: voice-retrieval
tags: [voice, pipeline, tenant-scope, keyword-fallback, local-rerank, structured-503]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: runRetrieval, runStage, StageRecord and trace ownership (02-08); assemble stages (02-09); resolveVoiceScope and VOICE_SCOPE_HEADER (02-10); signed voice token in LiveKit metadata (02-15)
provides:
  - "runRetrieval({ profile: 'voice' }) with stages embed, search, voice_keyword_fallback, local_rerank, assemble and a RetrievalResult.voice payload"
  - "voiceKeywordFallback with a tenant predicate (in-scope document ids first) and deriveVoiceKeywords"
  - "hybridRerank re-homed to src/lib/rag/rerank/local-hybrid.ts"
  - "assembleVoiceResults / enrichVoiceCandidates (voice wire formatting)"
  - "voice-rag and voice-chat routes that require the signed scope token"
affects: [02-17, 02-19, 02-20]

requirements-completed: [PIPE-01, PIPE-04, PIPE-05, PIPE-06, PIPE-07]

actuals:
  tokens: 19400
  tasks: 3
  commits: 5
plan_head_before: cf070c32d6f244335579d0a83178b005751fe38c
plan_head_after: 023db2d1dd23886eb5358b8a6244360833ff20dc

tech-stack:
  added: []
  patterns:
    - "Voice profile has its own pipeline function (runVoicePipeline) dispatched from runRetrieval; the chat/embed/eval path is untouched"
    - "A recording Supabase stand-in (tests/rag/helpers/recording-admin.ts) asserts exact query shapes; the two-tenant PGlite fixture proves isolation end to end"

key-files:
  created:
    - src/lib/rag/rerank/local-hybrid.ts
    - src/lib/rag/voice/keyword-fallback.ts
    - src/lib/rag/context/voice.ts
    - tests/rag/local-hybrid.test.ts
    - tests/rag/voice-rag-route.test.ts
    - tests/rag/voice-chat-route.test.ts
    - tests/rag/entrypoints-call-pipeline.test.ts
    - tests/rag/helpers/recording-admin.ts
  modified:
    - src/lib/rag/pipeline.ts
    - src/lib/rag/types.ts
    - src/lib/rag/index.ts
    - src/app/api/internal/voice-rag/route.ts
    - src/app/api/internal/voice-chat/route.ts
    - tests/rag/characterize-voice.test.ts
    - tests/rag/pipeline-assembly.test.ts
    - tests/rag/stage-runner.test.ts

key-decisions:
  - "runRetrieval owns the trace for voice (the route passes no collector), so the route does not call finishTrace itself; the [RAG Trace] line carries profile voice and the five stage names"
  - "The voice payload travels in a new optional RetrievalResult.voice field ({ results, source_images }); candidates stays empty for voice because its rows are not the chat Candidate shape"
  - "Status mapping: error, or degraded without results, returns 503 { error: 'knowledge_base_unavailable', reason }; degraded with results is served; empty returns { results: [] }"
  - "A skipped local_rerank keeps vector order (enriched candidates); a skipped or disabled assemble still produces the wire payload through the same pure function"
  - "Scope document lookup is capped at 500 documents and chunk queries run in batches of 100 ids, so a large workspace cannot overflow the request URL; hitting the cap logs a [Document Search] warning"

patterns-established:
  - "Tenant predicate for table reads without a tenant column: read in-scope document ids with tenantPredicate, then restrict chunk queries with in('document_id', ids); zero ids means no chunk query"

coverage:
  - id: D1
    description: "voice-rag: key check then signed token; missing/forged/expired 401, revoked membership 403, unset secret 503; no global fallback; personal and org tokens return only their own chunks; structured 503 on embed failure; empty returns { results: [] }"
    requirement: PIPE-04
    verification:
      - kind: unit
        ref: "tests/rag/voice-rag-route.test.ts (12 tests, two-tenant PGlite fixture)"
        status: pass
  - id: D2
    description: "Keyword and image fallback is tenant-scoped, sanitiser byte-identical, injection query cannot add a filter"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/rag/local-hybrid.test.ts (25 tests); mutation check: disabling the predicate fails 'the keyword and image fallback cannot reach another tenant chunk'"
        status: pass
  - id: D3
    description: "Single-tenant wire contract unchanged: 78 committed voice snapshots reproduced exactly with an s:default token"
    requirement: PIPE-06
    verification:
      - kind: characterization
        ref: "tests/rag/characterize-voice.test.ts (snapshot file untouched)"
        status: pass
  - id: D4
    description: "voice-chat saves under the token's user and organization; body ids ignored"
    requirement: PIPE-07
    verification:
      - kind: unit
        ref: "tests/rag/voice-chat-route.test.ts (9 tests)"
        status: pass
  - id: D5
    description: "Voice entry calls runRetrieval with profile voice and the five stages"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/rag/entrypoints-call-pipeline.test.ts (asserts the [RAG Trace] profile and stage list)"
        status: pass
---

# Phase 2 Plan 16: Voice Retrieval on the Pipeline Summary

**Voice retrieval now runs through `runRetrieval({ profile: 'voice' })` under a signed scope token with no global fallback, the keyword and image heuristics moved into a voice-only stage that is restricted to the caller's documents, and voice-chat saves only under the tenant the app signed.**

## Performance

- **Tasks:** 3 of 3 (Task 1 and Task 3 as RED then GREEN, Task 2 single commit)
- **Verification:**
  - `npx vitest run tests/rag/local-hybrid.test.ts` 25 passed (plan required at least 5)
  - `npx vitest run tests/rag/voice-rag-route.test.ts` 12 passed (plan required at least 7)
  - `npx vitest run tests/rag/voice-chat-route.test.ts` 9 passed (plan required at least 5)
  - `npx vitest run tests/rag/characterize-voice.test.ts` 2 passed; `tests/fixtures/characterization/voice.json` unchanged
  - `npx vitest run` 48 files, 528 tests passed
  - `node --import tsx --test tests/rag-legacy-differential.test.mts tests/rag-two-tenant.test.mts tests/rag-assemble-differential.test.mts` 14 passed
  - `npm run test-rag` gate PASS
  - `npx next typegen && node scripts/ci/tsc-ratchet.mjs` ok (58 errors, no new file); `npm run typecheck:new` clean
  - Acceptance greps: `resolveVoiceScope` in voice-rag 2, `.rpc(` outside comments 0, `knowledge_base_unavailable` 1, `tenantPredicate` in keyword-fallback 2, `resolveVoiceScope` in voice-chat 2, `export function hybridRerank` 1

## Task Commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 RED | Stub modules and failing stage tests | 3744672 |
| 1 GREEN | Keyword fallback, local hybrid rerank, voice result assembly | 25210c5 |
| 2 | voice-rag on the voice profile with token scope and 503 mapping | 7f82b50 |
| 3 RED | voice-chat tests failing against the body-trusting route | 85dc37f |
| 3 GREEN | voice-chat saves under the token tenant | 023db2d |

## Intended behaviour changes

- A valid `x-rag-scope-token` is required on voice-rag and voice-chat; agents that still send only `userId` get 401 (the agent side is plan 02-17; deploy the agent first).
- In multi-tenant mode the keyword and image fallback is narrowed to the caller's own documents (personal: own documents with no organization; org: the organization's documents). Before, it read every tenant's chunks.
- Org tokens now search the organization; personal tokens search the personal workspace; the single-tenant RPC is never called in multi-tenant mode.
- Retrieval failures return 503 `{ error: 'knowledge_base_unavailable', reason }` instead of 500; an optional-stage failure (keyword fallback, rerank) degrades instead of failing the request.
- The body is validated: `query` 1..4000 characters, `matchCount` integer 1..20 (default 5); invalid JSON is a 400.
- The `delete` sites in the re-homed reranker no longer raise TS2790 (the optional `rerankScore` and `scoreBreakdown` typing is explicit). The re-homed copy contains only the functions `hybridRerank` needs, so four of the six original `delete` lines remain; the other two sit in `semanticRerank`, which stays in the old module until 02-19.

## Deviations from Plan

**1. [Rule 1 - Bug] Two earlier tests encoded the legacy voice behaviour**
- **Found during:** Task 2 (full `tests/rag` run)
- **Issue:** `tests/rag/pipeline-assembly.test.ts` asserted the voice profile runs analyze/embed/search/legacy_rank, and `tests/rag/stage-runner.test.ts` looped `voice` through the legacy-rank override check. Both are replaced by the new voice stage list, which this plan defines.
- **Fix:** pipeline-assembly now asserts the five voice stages, the `voice` payload and that request overrides are ignored; stage-runner drops `voice` from the loop.
- **Files modified:** tests/rag/pipeline-assembly.test.ts, tests/rag/stage-runner.test.ts
- **Commit:** 7f82b50

**2. [Rule 3 - Blocking] entrypoints-call-pipeline.test.ts did not exist in this base**
- Plan 02-11 creates it in parallel. I created the file with a single self-contained describe block (`voice entry points call the pipeline`). Expect an add/add conflict on merge: keep both describe blocks. The check is done by reading the `[RAG Trace]` line (profile, tenantKey, stage names) rather than a function spy, so it needs no module mocking and cannot clash with 02-11's approach.

**3. [Rule 2 - Hardening] pipeline wiring and types**
- `RetrievalResult` gained an optional `voice` field (`src/lib/rag/types.ts`) and `index.ts` gained two appended exports (`VoiceResult*` types and `deriveVoiceKeywords`). `pipeline.ts` changes are one dispatch line in `runRetrieval`, the imports, and a self-contained `runVoicePipeline` appended at the end of the file.

## Known issue handled: keyword step 2 and the fake edge

The original keyword step 2 selects `id, document_id, content, metadata, embedding`. The fake edge rejects the `embedding` column (400), so in fixtures this step has always logged a warning and added nothing, and the 78 committed voice snapshots encode that. I kept the select byte-identical so the snapshots reproduce, and covered step 2 through the recording admin (shape, limit 50, scoping) instead. In production step 2 works. The `embedding` column is never read afterwards (enrichment copies only named fields), so dropping it is output-neutral in production but would change fixture snapshots (step 2 would start contributing); recommend doing that together with a snapshot regeneration in a later plan (02-19 when the old module is removed) rather than here.

## Notes for the orchestrator and later plans

- **Single-tenant voice-chat:** the single-tenant token carries no user (`resolveVoiceScope` returns a `s:default` scope with `userId` null), so voice-chat returns 400 `Missing userId` for every single-tenant session, which is what the plan specifies ("as today for anonymous"). If single-tenant deployments save voice chats for a logged-in user today, those saves stop. Decide whether the LiveKit token route should put the session user's id in `uid` for `s:default` tokens (the resolver currently ignores it for single-tenant).
- **Dedupe quirk kept:** the old code deduped keyword rows on `c.id`, but single-tenant vector rows carry `chunk_id` only, so an image chunk found by both vector and keyword search is added twice (similarity 3.0 or 2.0 copy). Workspace rows had `id`, so multi-tenant deduped correctly; `toVoiceChunk` sets `id` for non-single scopes to keep that. Fixing the single-tenant quirk changes snapshots; left for a later plan.
- **Trace:** `runRetrieval` owns the collector and writes the `[RAG Trace]` line; the route does not pass `trace`.
- **Merge hotspots with 02-18:** `src/lib/rag/pipeline.ts` (my dispatch line in `runRetrieval` and the appended `runVoicePipeline`; the media profile will touch the same function), `src/lib/rag/index.ts` (appends only) and `tests/rag/entrypoints-call-pipeline.test.ts`.
- Trailers: commits end with the Opus 5.5 co-author line specified by the plan and dispatch file.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-02-43 (global fallback removed; test asserts no single-tenant RPC in multi-tenant), T-02-44 (in-scope document ids, mutation-checked), T-02-45 (body userId ignored, token required), T-02-46 (sanitiser unchanged, injection test) and T-02-47 (voice-chat identity from the token only) are mitigated and covered by tests.

## Self-Check: PASSED

- All files listed under key-files exist in the worktree.
- Commits 3744672, 25210c5, 7f82b50, 85dc37f and 023db2d are ancestors of HEAD.
