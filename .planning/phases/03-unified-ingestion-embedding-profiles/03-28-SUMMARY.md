---
phase: 03-unified-ingestion-embedding-profiles
plan: 28
subsystem: ingestion
tags: [embeddings, dual-write, chunk-embeddings, backfill-gaps, tenant-isolation, pglite]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "0308 chunk_embeddings and backfill tables (03-07), registry providers (03-08), 0310 writer RPCs (03-03), ingest tracer and stages (03-13, 03-13b), active profile pointer and getBackfillingProfiles (03-21)"
provides:
  - "resolveEmbeddingTargets: active, every backfilling and the previous active profile, each with the open backfill run; the legacy profile alone with no read while RAG_EMBEDDING_PROFILES is off"
  - "Multi-target embed stage: one embedding text per chunk, each target through its provider with canonical model and dims asserted, all vectors written in one call"
  - "Migration 0313: rag_write_chunks for any registry profile, rag_publish_document_version deleting superseded chunk_embeddings, rag_record_backfill_gap, rag_latest_backfill_runs"
  - "Writer methods findBackfillRuns, recordBackfillGap and chunkIdFor; getPreviousActiveProfile"
affects: [03-36, 03-37, 03-43, 04-31]

actuals:
  tokens: 20500
  tasks: 2
  commits: 4
plan_head_before: 65c5b7fec2be3a12c7e444f38c1bc4f50f947053
plan_head_after: 661d6c14ab8021d7585fbbfb6240a2e4b7abe107

tech-stack:
  added: []
  patterns:
    - "p_embeddings values are a vector list (legacy) or {vectors, host} (other profiles); the SQL reads the registry row for model and dims"
    - "A non-active target that fails is skipped for the rest of the run and recorded as gaps; gap rows are cleared by a later write of the vector and by publish of a newer version"

key-files:
  created:
    - supabase/migrations/0313_write_chunks_profiles.sql
    - src/lib/rag/ingest/embedding-targets.ts
    - tests/rag/ingest/embedding-targets.test.ts
    - tests/rag-db/ingest-dual-write.test.mts
  modified:
    - src/lib/rag/ingest/stages/embed-write.ts
    - src/lib/rag/ingest/writer.ts
    - src/lib/rag/embeddings/active-profile.ts
    - tests/rag-db/ingest-writer.test.mts

key-decisions:
  - "rag_record_backfill_gap takes a fifth argument p_tenant_key; every chunk must belong to it and a run limited to another tenant is refused. rag_latest_backfill_runs(p_tenant_key) returns only runs that apply to the tenant, so a tenant never records a gap against another tenant's run"
  - "A backfilling target uses a run only while one is running; the previous active target uses its newest run that was not rolled back; with no usable run the gap is kept in processing_state.embeddingGaps and as the warning embedding_gap:<profile> (the re-embed sweep finds every current chunk lacking a vector, and the activation gate refuses an incomplete profile)"
  - "A failed non-active target is not tried again for the remaining batches of the run, so a vendor outage costs one timeout, not one per batch"
  - "A retired previous profile is not a target"
  - "The legacy target embeds through deps.embedDocuments as before (the test seam) and, when the pipeline is unified or profiles are on, first compares the configured OpenAI model with the legacy profile model (P-10)"
  - "A rewrite that changes a chunk's text deletes that chunk's old vectors of profiles not sent again, so no vector outlives its text"

patterns-established:
  - "chunkIdFor in writer.ts mirrors the SQL chunk id formula; the DB test pins both to the same value"

requirements-completed: [EMB-02, EMB-05]

coverage:
  - id: D1
    description: "rag_write_chunks stores the legacy column and one chunk_embeddings row per chunk for any registry profile with model, dims, tenant key from the document and host from the payload; wrong-length vectors and unknown profiles are refused; rewrites upsert"
    requirement: EMB-02
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-dual-write.test.mts#ingest writer: embeddings for every profile, gaps and the version swap"
        status: pass
    human_judgment: false
  - id: D2
    description: "Publishing a new version deletes the superseded version's chunk_embeddings rows and keeps its chunk rows"
    requirement: EMB-05
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-dual-write.test.mts#publishing version 2 deletes version 1 chunk_embeddings rows and keeps its chunk rows"
        status: pass
    human_judgment: false
  - id: D3
    description: "Gaps are recorded per chunk against the open run with a tenant check; another tenant's chunk, a run of another profile and an unknown run are refused"
    requirement: EMB-05
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-dual-write.test.mts#rag_record_backfill_gap and tenant tests"
        status: pass
    human_judgment: false
  - id: D4
    description: "Target resolution: off gives legacy with no read; on gives active, backfilling and previous active with their runs"
    requirement: EMB-02
    verification:
      - kind: unit
        ref: "tests/rag/ingest/embedding-targets.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "A document ingested mid-migration has vectors in both profiles; a failing backfilling provider still publishes and records gaps; a failing active provider fails the run; wrong model or dims fail the active target and gap the others; the legacy target refuses a model swap; two tenants stay separate"
    requirement: EMB-05
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-dual-write.test.mts#ingest() writes every profile that must stay complete"
        status: pass
    human_judgment: false
  - id: D6
    description: "Behaviour against a real Supabase project with live Voyage and Qwen providers"
    verification: []
    human_judgment: true
    rationale: "Tests run on PGlite with fake providers; no live project or vendor key was available"

duration: not measured
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 28: Dual-write to every profile that must stay complete Summary

**Ingestion now embeds each chunk for the active, every backfilling and the previous active profile from one embedding text, writes them through migration 0313 into the legacy column and chunk_embeddings, and records each vector it could not write as a gap of the open backfill run; with RAG_EMBEDDING_PROFILES off it still writes the legacy column alone**

## Performance

- **Duration:** not measured (the work spanned a restart)
- **Completed:** 2026-11-24
- **Tasks:** 2 (both TDD, four commits)
- **Files:** 4 created, 4 modified, 1495 insertions, 22 deletions

## Accomplishments
- `rag_write_chunks` (same signature) accepts any registry profile. The legacy profile fills `document_chunks.embedding`; other profiles upsert `chunk_embeddings` with the profile's model and dims, the document's tenant key and the payload's host. A vector of the wrong length raises `embedding_profile_mismatch`, an id outside the registry `embedding_profile_unsupported`. A changed chunk loses vectors that were made from its old text, and a written vector clears its recorded gap.
- `rag_publish_document_version` deletes the superseded version's `chunk_embeddings` rows and gaps; chunk rows stay for citations (F-9).
- `rag_record_backfill_gap` and `rag_latest_backfill_runs`: tenant-checked, service role only (no anon or authenticated execute).
- `resolveEmbeddingTargets` and the new `embed` stage: a failing backfilling or previous provider leaves the document publishing on the active profile with gaps recorded; a failing active provider fails the run (`embed_failed`, or `embedding_profile_mismatch` for a wrong model or dims); the legacy target refuses a configured model that differs from the legacy profile's.

## Task Commits

1. **Task 1: Writer functions with profile targets and gap recording**
   - RED `a410011` (test): 13 tests, 12 failed on assertions, 1 passed (unknown profile already refused)
   - GREEN `cf87204` (feat)
2. **Task 2: Target resolution and the multi-target embed stage**
   - RED `a85d1f3` (test): 8 unit tests all failed on assertions against an inert stub; 8 of 9 new DB tests failed on assertions, the switch-off test passed as a regression guard
   - GREEN `661d6c1` (feat)

**Plan metadata:** the SUMMARY commit follows this file (docs).

## Files Created/Modified
- `supabase/migrations/0313_write_chunks_profiles.sql` - the four functions
- `src/lib/rag/ingest/embedding-targets.ts` - `resolveEmbeddingTargets`
- `src/lib/rag/ingest/stages/embed-write.ts` - multi-target embed
- `src/lib/rag/ingest/writer.ts` - `findBackfillRuns`, `recordBackfillGap`, `chunkIdFor`, `ProfileVectors`, new reason words
- `src/lib/rag/embeddings/active-profile.ts` - `getPreviousActiveProfile`
- `tests/rag-db/ingest-dual-write.test.mts` - 13 SQL-level and 9 ingest-level tests
- `tests/rag/ingest/embedding-targets.test.ts` - 8 unit tests
- `tests/rag-db/ingest-writer.test.mts` - the old "another profile is unsupported" case now covers an unknown id and a wrong-length vector

## Decisions Made
See `key-decisions`.

## Deviations from Plan

**1. [Rule 2 - Missing Critical] rag_record_backfill_gap has a fifth argument, p_tenant_key**
- **Issue:** the plan lists four arguments but requires that a gap for another tenant's chunk is refused (T-03-82); with four arguments the function cannot know the caller's tenant.
- **Fix:** added `p_tenant_key` as the last argument, plus `rag_latest_backfill_runs(p_tenant_key)` so the TypeScript side only sees runs that apply to its tenant.

**2. [Rule 3 - Blocking] Files outside the plan's list**
- `writer.ts` (the only file naming the writer RPCs, so the two new RPC wrappers belong there), `active-profile.ts` (additive `getPreviousActiveProfile`, so the previous profile comes from the same 30 s snapshot), `tests/rag-db/ingest-writer.test.mts` (one case asserted the old limitation that non-legacy profiles are unsupported; the migration test file was not touched).

**3. [Interpretation] Legacy model guard scope**
- The plan says "under unified". `ingest()` has no pipeline switch of its own, so the guard runs when `RAG_INGEST_PIPELINE=unified` or `RAG_EMBEDDING_PROFILES=on`. With both at their defaults nothing changes. A deployment with the unified pipeline, profiles off and a non-default OpenAI model now fails with `embedding_profile_mismatch` instead of writing under another model.

**4. [Interpretation] Failure reason for wrong legacy dims**
- A wrong-length vector from the legacy embedder now fails with `embedding_profile_mismatch` (was `embedding_dimension_mismatch`, which nothing consumed). Writes with the switch off are otherwise identical: same embedder call, same `{ 'openai-3-small-1536': vectors }` payload, same batching.

**5. [Interpretation] Gaps with no usable run**
- `embedding_backfill_gaps.run_id` is required. With no running run for a backfilling profile (or no run for the previous profile) the gap is kept in `processing_state.embeddingGaps` and as the warning `embedding_gap:<profile>`; the re-embed sweep and the activation completeness check still cover the chunk.

**Total deviations:** 5 (1 Rule 2, 1 Rule 3, 3 interpretation notes).

## TDD Gate Compliance
Both tasks have a `test(03-28)` commit followed by a `feat(03-28)` commit. The RED commits fail on assertions (DB errors are turned into assertion failures by the test helper; the Task 2 stub only lets the unit test load). `gsd_run check tdd-red-evidence` was not run: it returned INVALID_RED for vitest and node TAP output in earlier plans and `workflow.tdd_mode` is off. Semantic assessment: every failing test exercised the planned behaviour and none failed on an import, syntax or fixture fault. Task 1's "unknown profile is rejected" and Task 2's "switch off writes the legacy vector only" passed at RED by design, as regression guards.

## Issues Encountered
- `tests/rag/injection-scan.test.ts` (1 MB timing bound) failed once in the full vitest run under load and passed alone (45 of 45); unrelated to this plan.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 134 files; 1830 passed, 1 timing test failed under load and passed on rerun alone |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 251 tests: 248 passed, 0 failed, 3 skipped (single-tenant variants, by design) |
| `tests/rag-db/ingest-dual-write.test.mts` | 22 passed (criterion: at least 9) |
| `tests/rag/ingest/embedding-targets.test.ts` | 8 passed |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 719 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run, sidecar untouched |

Acceptance greps: `chunk_embeddings` in 0313 = 6 (EXPECT >=3); `rag_record_backfill_gap` in 0313 = 4 (EXPECT >=1); `resolveEmbeddingTargets` in embed-write.ts = 2 (EXPECT >=1).

## Threat Surface
T-03-80: gaps recorded per chunk against the open run; the activation gate still counts missing vectors. T-03-81: canonical model and dims asserted per target (before the call for the configured provider, after it for the answer); the legacy target compares the configured model. T-03-82: `tenant_key` is taken from the document inside SQL, the gap function checks every chunk and the run against the caller's tenant, and a two-tenant test shows no crossed rows. No new endpoint, no package, no environment variable.

## Known Stubs
None.

## User Setup Required
Apply migration 0313 (`scripts/setup-database.sh`) before turning `RAG_EMBEDDING_PROFILES` on or running a backfill; it replaces `rag_write_chunks` and `rag_publish_document_version` and adds two functions. No environment variable.

## Next Phase Readiness
- 03-36 can mark gaps through `rag_record_backfill_gap` or rely on its sweep; gap rows are cleared when the vector is written or the version is superseded.
- 04-31 can call `resolveEmbeddingTargets(writer)` for variant chunks and pass `{ vectors, host }` for non-legacy profiles.

## Self-Check: PASSED
Created files exist on disk; commits `a410011`, `cf87204`, `a85d1f3`, `661d6c1` are ancestors of HEAD; the ledger count is 4.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
