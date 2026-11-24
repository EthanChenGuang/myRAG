---
phase: 03-unified-ingestion-embedding-profiles
plan: 26
subsystem: retrieval
tags: [embeddings, active-profile, match_chunks_by_profile, calibration, mismatch, vitest, pglite]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: plan 03-21 getActiveProfile, refreshActiveProfile, ProfileUnavailableError, getStartupVerdict; plan 03-08 provider registry; plan 03-09 match_chunks_by_profile and score_calibration seeds
provides:
  - embedQuery: legacy embedder while RAG_EMBEDDING_PROFILES is off, active profile's provider.embedQuery at the profile dims while on
  - per-request vector length and canonical response model assertions; startup verdict mismatch honoured
  - profileVectorSearch and searchByEmbedding in the backend adapter (match_chunks_by_profile on the admin client, tenant key from scopeKey(scope))
  - withStaleProfileRetry: one refresh and one retry on "profile not active"
  - searchThresholdsFor / scaleThreshold: search thresholds from score_calibration
affects: [03-28, 03-43, 03-45, 04-13, 04-20]

actuals:
  tokens: 40000
  tasks: 2
  commits: 4
plan_head_before: 65c5b7fec2be3a12c7e444f38c1bc4f50f947053
plan_head_after: 4ffa56dfad5b4037f0a7e055e9abd8eafe8ae275

tech-stack:
  added: []
  patterns:
    - "Embed stage returns { vector, profile }; the search stage dispatches on profile.storage (halfvec to match_chunks_by_profile, otherwise the unchanged legacy RPCs)"
    - "Profile failures are classified in one place (classifyProfileFailure) and mapped to retrieval reasons in pipeline.ts; the operator line is written once per distinct cause"

key-files:
  created:
    - src/lib/rag/embeddings/query-embedding.ts
    - tests/rag/embeddings/mismatch.test.ts
    - tests/rag/embeddings/profile-search.test.ts
    - tests/rag-db/profile-search.test.mts
  modified:
    - src/lib/rag/backend/supabase-rpc.ts
    - src/lib/rag/deps.ts
    - src/lib/rag/pipeline.ts
    - src/lib/rag/legacy/enhanced-retrieval.ts

key-decisions:
  - "ProfileUnavailableError maps to status error, reason embedding_profile_unavailable; a mismatch (dims, same-dims model swap, provider, startup verdict, RPC refusal) maps to status error, reason embedding_profile_mismatch. Neither is ever empty, so chat strict mode with web search off streams the localized knowledge-base-unavailable message (AGENTS.md section 14, existing chat-status tests)"
  - "A startup verdict of mismatch fails every request until the process restarts; the causes are env or deployment settings that need a restart anyway"
  - "With the switch on and the legacy profile active the legacy embedder and the two legacy RPCs are used; the length is asserted against the profile dims and the configured provider model against the profile model"
  - "Thresholds: retrieval_threshold anchors the analyzer tiers (tier x retrieval_threshold / 0.7) and is the exact-match floor; fallback_threshold replaces 0.28. The legacy profile gives scale 1, so values are bit-identical to today. A non-legacy profile with a missing or invalid key keeps the legacy constant for it and warns once (CALIBRATION MISSING)"
  - "Media 0.3, overview and voice 0.15 floors are scaled the same way"

requirements-completed: [EMB-02, EMB-03]

duration: about 50 min (including a restart)
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 26: Query embedding from the active profile Summary

**Queries are embedded with the active profile's provider at the profile's dims and searched in that profile's vectors through match_chunks_by_profile, with per-request dims and model assertions, calibrated thresholds, a one-shot stale-pointer retry, and an unchanged path while RAG_EMBEDDING_PROFILES is off.**

## Accomplishments

- `embedQuery` (new `embeddings/query-embedding.ts`): off returns the legacy embedder result; on resolves the active profile, calls the provider's `embedQuery` with `{ dims }` through the new optional `RagDeps.profileEmbedder`, asserts vector length and canonical model, and fails closed on a startup verdict of mismatch or an unreadable registry (no legacy fallback).
- `profileVectorSearch` / `searchByEmbedding` in `backend/supabase-rpc.ts`: tenant key only from `scopeKey(scope)`; errors containing `embedding_profile_mismatch` become `EmbeddingProfileMismatchError`; `vectorSearch` is untouched.
- `pipeline.ts`: chat, embed, eval, voice, media and overview pipelines use the profile-aware embed and search; the four catch blocks map profile failures to status error.
- `legacy/enhanced-retrieval.ts`: every search goes through the dispatcher; thresholds come from `searchThresholdsFor(profile)`.
- `[Embedding Profile] MISMATCH {profile, model, dims, reason, actual}` once per distinct cause, no key; the startup check's own line is not repeated per request.

## Task Commits

1. Task 1: RED `1c9a6e4` (9 of 11 failed on assertions, 2 baseline guards passed), GREEN `a1a6fac` (11 passed)
2. Task 2: RED `d8c5c3f` (10 of 12 unit and 3 of 6 DB tests failed on assertions, the rest are baseline guards), GREEN `4ffa56d` (12 unit, 6 DB passed)

## RED evidence

`type: execute` with task-level `tdd="true"`, so the `tdd-red-evidence` classifier was not run. RED was confirmed by hand: stubs and unchanged production code made every failing test fail on an `AssertionError` for the planned behaviour (for example `expected 'ok' to be 'error'`, `the profile RPC must be used`), never on a missing module.

## Deviations from Plan

**1. [Interpretation] Calibration key names and semantics.** The plan example `{ initial, fallback }` is illustrative; the registry seed (0307) uses `retrieval_threshold`, `context_threshold`, `fallback_threshold`, `context_image_threshold` (legacy 0.7, 0.65, 0.28, 0.25). Search uses `retrieval_threshold` and `fallback_threshold`. Because the exact-match floor 0.7 is below the default exact tier 0.75, replacing the floor alone would have changed nothing, so `retrieval_threshold` also rescales the four analyzer tiers. Plan 04-13 should read `context_threshold` (text floor 0.65) and `context_image_threshold` (image floor 0.25).

**2. [Scope, not done] Post-filter thresholds in `context/assemble.ts`** (0.65 chunk, 0.6 document, 0.25 image) are still legacy constants; the file is outside this plan's list and covered by the Phase 2 oracle tests. With a non-legacy profile whose scores run lower, the post filter can still drop chunks. Recommend the owner of 04-20 (or a follow-up before the switch is turned on) pass `context_threshold` and `context_image_threshold` into `AssembleInput`.

**3. [Interpretation] "Switch off issues no admin-client call".** Phase 2 retrieval already searches on the admin client; off issues the same two legacy RPCs as before and no registry read or profile search (asserted on the fake edge).

**4. [Ordering] `EmbeddingProfileMismatchError` and `ProfileQueryEmbedding` landed in Task 1** (needed by the embed stage) although the plan lists `supabase-rpc.ts` under Task 2. Tests were also added in a new `tests/rag/embeddings/profile-search.test.ts` for the unit-level retry, calibration and argument checks; `tests/rag-db/profile-search.test.mts` holds the PGlite tests.

**5. [Note] Between the Task 1 and Task 2 commits** a halfvec profile would have been embedded correctly but searched with the legacy RPC; the switch defaults off and Task 2 closes it.

## Known Stubs

None.

## Gate results (worktree /home/user/wt/03-26, branch exec/03-26)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 1845 passed, 1 failed: `tests/rag/injection-scan.test.ts` 1 MB timing assertion (1355 ms vs 1000 ms) under full-suite load; passes alone (45 of 45); unrelated |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed (includes legacy differential, two-tenant) |
| `node --import tsx --test tests/rag-db/profile-search.test.mts` | 6 passed |
| `npx vitest run tests/rag/embeddings/mismatch.test.ts` | 11 passed |
| `npm run test-rag -- --out eval/out/p3-profile-off` | gate PASS, `.passed == true and .paired.all_zero == true` |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 720 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run (untouched) |

Acceptance greps: `embedding_profile_mismatch` in pipeline.ts = 1 (>=1); `match_chunks_by_profile` in supabase-rpc.ts = 2 (>=1).

## Threat Flags

None. T-03-73 (tenant key only from scopeKey, RPC predicate, two-tenant equality test), T-03-74 (dims and model asserted per request, startup verdict honoured), T-03-75 (exactly one refresh-and-retry, no retry when the pointer is unchanged) are mitigated as planned.

## User Setup Required

None; no new environment variable.

## Next Phase Readiness

- Operators: after fixing a startup MISMATCH (key, model, dims) restart the instance; the stored verdict fails retrieval until then.
- Before switching a non-legacy profile on, fill its `score_calibration` (at least `retrieval_threshold` and `fallback_threshold`) and retune `RAG_*_THRESHOLD` if wanted; see deviation 2 for the assemble post filter.

## Self-Check: PASSED

- Files exist: query-embedding.ts and the three test files; commits 1c9a6e4, a1a6fac, d8c5c3f, 4ffa56d are ancestors of HEAD.
