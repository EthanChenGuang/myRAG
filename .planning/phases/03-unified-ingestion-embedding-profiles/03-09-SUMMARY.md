---
phase: 03-unified-ingestion-embedding-profiles
plan: 09
subsystem: database
tags: [postgres, pgvector, halfvec, hnsw, supabase, pglite, embeddings, tenant-isolation]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: 03-01 migrations directory and loader, promoted chunk columns (tenant_key, is_current, status), the D-08 filter, tests/rag-db suite
  - phase: 03-unified-ingestion-embedding-profiles
    provides: 03-08 provider registry (provider ids openai, voyage, qwen3; canonical model ids; QWEN_QUERY_TASK)
provides:
  - supabase/migrations/0307_embedding_profiles.sql (embedding_profiles registry, single active pointer, five seeded profiles, score_calibration, list and status functions)
  - supabase/migrations/0308_chunk_embeddings.sql (chunk_embeddings, four per-profile HNSW indexes, guard trigger, embedding_backfill_runs and _gaps, match_chunks_by_profile)
  - supabase/migrations/0309_profile_activation.sql (rag_activate_embedding_profile, rag_rollback_embedding_profile)
  - tests/rag-db/embedding-profiles.test.mts, profile-rpc-two-tenant.test.mts, activation-gate.test.mts
affects: [03-28, 03-36, 03-40, 03-46, 03-47]

actuals:
  tokens: 17000
  tasks: 3
  commits: 6
plan_head_before: c50bdea1d821c9c536eebe2faa66ea26cf512c83
plan_head_after: b2e027acaf72411fa761c1782a830fa2d0405112

tech-stack:
  added: []
  patterns:
    - "Profile search builds its statement with format() from one registry integer and one %L literal; every caller value is bound with USING"
    - "A BEFORE trigger is the authority for chunk_embeddings.tenant_key and dims, so the writer cannot place a vector in another tenant"
    - "Activation and rollback are single SQL functions under LOCK TABLE ... SHARE ROW EXCLUSIVE; each refusal has its own message prefix"
    - "Server-only SQL objects: REVOKE ALL FROM PUBLIC, anon, authenticated plus GRANT to service_role, proven by a privilege test run with Supabase default grants on"

key-files:
  created:
    - supabase/migrations/0307_embedding_profiles.sql
    - supabase/migrations/0308_chunk_embeddings.sql
    - supabase/migrations/0309_profile_activation.sql
    - tests/rag-db/embedding-profiles.test.mts
    - tests/rag-db/profile-rpc-two-tenant.test.mts
    - tests/rag-db/activation-gate.test.mts
  modified:
    - tests/rag-db/schema-migrations.test.mts

key-decisions:
  - "Seed ids and shapes: openai-3-small-1536 (legacy_column, active, calibration retrieval 0.7, context 0.65, fallback 0.28, context image 0.25), voyage-4-large-2048/1024 and qwen3-8b-2048/1024 (halfvec, available); provider ids and the Qwen model id follow the 03-08 registry"
  - "A guard trigger on chunk_embeddings copies tenant_key from the chunk and sets dims from the vector, and enforces the registry length for every profile, with or without an index"
  - "Evidence must also name the target profile and a completed backfill run of the target (halfvec targets), in addition to the plan's conditions: two extra refusals, eval_target_mismatch and eval_run_mismatch"
  - "Rollback clears previous_active_id on the restored profile, so a second rollback is refused instead of toggling back to the profile that was just rolled away from"
  - "For the legacy target the run-id check is skipped and staleness is measured against the newest current ready chunk's created_at"

patterns-established:
  - "Test-data rule for HNSW under-fill tests: vectors must be spread (random in several dimensions), identical or one-dimensional clusters leave unreachable graph islands and make iterative scans return 0"
  - "Gate tests run each case inside BEGIN/ROLLBACK with SAVEPOINT around expected refusals"

requirements-completed: [EMB-02, EMB-05]

coverage:
  - id: D1
    description: "embedding_profiles seeds, exactly one active row, registry CHECKs (dims <= 4000, legacy_column <= 2000), legacy row carries today's thresholds"
    requirement: "EMB-02"
    verification:
      - kind: integration
        ref: "tests/rag-db/embedding-profiles.test.mts#the registry holds the legacy profile active with today thresholds and five more profiles available"
        status: pass
      - kind: integration
        ref: "tests/rag-db/embedding-profiles.test.mts#exactly one profile can be active and the registry rules hold in the table"
        status: pass
    human_judgment: false
  - id: D2
    description: "chunk_embeddings stores side-by-side halfvec vectors per (chunk, profile) with a partial expression HNSW index per profile (m 64, ef_construction 200); a wrong-length vector is rejected; tenant_key follows the chunk"
    requirement: "EMB-02"
    verification:
      - kind: integration
        ref: "tests/rag-db/embedding-profiles.test.mts#every halfvec profile has its own partial expression HNSW index with m 64 and ef_construction 200"
        status: pass
      - kind: integration
        ref: "tests/rag-db/embedding-profiles.test.mts#a vector of the wrong length for a profile is rejected, the right length is stored"
        status: pass
      - kind: integration
        ref: "tests/rag-db/embedding-profiles.test.mts#a stored row always carries its chunk tenant_key and its true vector length"
        status: pass
    human_judgment: false
  - id: D3
    description: "match_chunks_by_profile returns the same visible documents per tenant as match_documents_by_workspace, hides quarantined and non-current chunks, raises embedding_profile_mismatch, fills the requested count for a small tenant, and is service_role only"
    requirement: "EMB-02"
    verification:
      - kind: integration
        ref: "tests/rag-db/profile-rpc-two-tenant.test.mts"
        status: pass
    human_judgment: false
  - id: D4
    description: "rag_activate_embedding_profile refuses on incompleteness, model or dims mismatch and bad evidence (each with its own prefix); a passing activation flips the pointer and records previous_active_id; rag_rollback_embedding_profile restores it"
    requirement: "EMB-05"
    verification:
      - kind: integration
        ref: "tests/rag-db/activation-gate.test.mts"
        status: pass
    human_judgment: false
  - id: D5
    description: "No rag_ function, match_chunks_by_profile or new table is usable by anon or authenticated"
    requirement: "EMB-05"
    verification:
      - kind: integration
        ref: "tests/rag-db/embedding-profiles.test.mts#no rag_ function and no match_chunks_by_profile is executable by anon or authenticated"
        status: pass
      - kind: integration
        ref: "tests/rag-db/embedding-profiles.test.mts#the new tables are closed to anon and authenticated, open to service_role, with RLS on"
        status: pass
    human_judgment: false
  - id: D6
    description: "HNSW index builds, relaxed iterative scans and the 2048-dim profile indexes on the real Supabase project (maintenance_work_mem, pooler connections, real pgvector version)"
    verification: []
    human_judgment: true
    rationale: "No live Supabase project is reachable; PGlite proves the SQL semantics on pgvector 0.8.7 only"

duration: 22min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 09: Embedding profile registry, halfvec storage, profile search and activation gate Summary

**Side-by-side embedding storage in SQL: an `embedding_profiles` registry with one active pointer, `chunk_embeddings` halfvec rows with a partial HNSW index per profile and a tenant/length guard trigger, a tenant-scoped `match_chunks_by_profile` RPC with iterative scans, and gated `rag_activate_embedding_profile` / `rag_rollback_embedding_profile`, proven in PGlite with pgvector 0.8.7.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-11-24T01:00:55Z
- **Completed:** 2026-11-24T01:23:00Z
- **Tasks:** 3 (each a RED, GREEN pair)
- **Files modified:** 7 (6 created, 1 modified)

## Accomplishments

- `embedding_profiles` (0307): id, provider, model, dims, storage, status, query_instruction, score_calibration, activation fields, eval_evidence; a partial unique index allows one `active` row; five seeds (the legacy profile active with the thresholds 0.7, 0.65, 0.28, 0.25; Voyage and Qwen3 at 2048 and 1024 dims as `available`). `rag_list_embedding_profiles()` returns `has_evidence` instead of evidence bodies; `rag_set_embedding_profile_status(p_profile_id, p_status, p_actor)` moves a profile between available, backfilling and retired and refuses `active` and any change to the active row.
- `chunk_embeddings` (0308): `(chunk_id, profile_id)` key with cascade, tenant_key, halfvec embedding, model, dims, host; four partial expression HNSW indexes (m 64, ef_construction 200); `rag_chunk_embeddings_guard` copies tenant_key from the chunk, sets dims from the vector and rejects a length that differs from the registry (`expected 2048 dimensions, not 1024`). `embedding_backfill_runs` and `embedding_backfill_gaps` hold the re-embed job's progress and per-run gaps.
- `match_chunks_by_profile` (0308): dims and status from the registry, dynamic SQL from a registry integer and a `%L` literal, `e.tenant_key = $2`, `c.is_current AND c.status = 'ready'`, `hnsw.iterative_scan = relaxed_order` on pgvector 0.8.0 and later, `embedding_profile_mismatch` on an unknown profile, a dims mismatch (also against the query vector length) or an inactive profile when `p_require_active` is true. On the two-tenant fixture it returns the same documents as `match_documents_by_workspace` for each of four tenant scopes.
- `rag_activate_embedding_profile` / `rag_rollback_embedding_profile` (0309): one function each, under `LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE`, `statement_timeout` 120 s, comment-free bodies. Refusals: `incomplete`, `model_mismatch`, `eval_missing`, `eval_target_mismatch`, `eval_baseline_mismatch`, `eval_failed`, `pre_migration_missing`, `eval_run_mismatch`, `eval_stale`, plus `already_active`, `unknown_profile`, `actor_required`; rollback refuses `no_active`, `no_previous`, `incomplete`.
- All new tables have RLS on without policies and nothing granted to anon or authenticated; every new function is revoked from PUBLIC, anon and authenticated and granted to service_role. The privilege tests run with Supabase's default grants switched on, so they prove the REVOKEs do the work.

## Task Commits

1. **Task 1: registry, chunk_embeddings, run tables, indexes, grants** - RED `d273f1f` (test), GREEN `d413f16` (feat)
2. **Task 2: match_chunks_by_profile and the two-tenant equality test** - RED `9c9ec8c` (test), GREEN `c91f346` (feat)
3. **Task 3: gated activation and rollback** - RED `e1bc5fe` (test), GREEN `b2e027a` (feat)

**Plan metadata:** the docs commit that adds this file.

## TDD Evidence

The plan is `type: execute` (tasks carry `tdd="true"`), so the plan-level gate sequence does not apply; each RED was classified with `gsd_run check tdd-red-evidence` (records under the git-ignored `.gsd/tdd-evidence/03-09/`), target test named with its suite prefix because test names repeat across the two deployment modes.

- **RED 1** (`d273f1f`): 20 tests (10 per mode), 0 pass, 20 fail with ERR_ASSERTION ("embedding_profiles table is missing"; the file needs no new module, so the failure is never module-not-found). Verdict `RED_EVIDENCE_OK`. Semantic assessment: every test starts with a schema-existence assertion, so each failure is the planned missing-object assertion, not a SQL or fixture error.
- **RED 2** (`9c9ec8c`): 5 tests, 0 pass, 5 fail with ERR_ASSERTION ("match_chunks_by_profile is missing"); the suite `before` hook (fixture, legacy-profile demotion, test profile and vector copy) ran. Verdict `RED_EVIDENCE_OK`.
- **RED 3** (`e1bc5fe`): 22 tests (11 per mode), 0 pass, 22 fail with ERR_ASSERTION ("rag_activate_embedding_profile is missing"). Verdict `RED_EVIDENCE_OK`.
- GREEN 1 passed 20/20 first run; GREEN 2 needed test-data work (see Issues Encountered); GREEN 3 needed a PL/pgSQL fix (Issues Encountered). Final counts: 20, 5 and 22 passed.

## Files Created/Modified

- `supabase/migrations/0307_embedding_profiles.sql` - registry table, single-active index, seeds, RLS and grants, list and status functions
- `supabase/migrations/0308_chunk_embeddings.sql` - chunk_embeddings, per-profile HNSW indexes, guard trigger, run and gap tables, grants, match_chunks_by_profile
- `supabase/migrations/0309_profile_activation.sql` - activation and rollback functions and grants
- `tests/rag-db/embedding-profiles.test.mts` - registry, storage, grants, list and status (20 tests over both modes)
- `tests/rag-db/profile-rpc-two-tenant.test.mts` - RPC equality, filters, mismatch errors, iterative scan fill, grants (5 tests)
- `tests/rag-db/activation-gate.test.mts` - every refusal, success, rollback, legacy checks, grants (22 tests over both modes)
- `tests/rag-db/schema-migrations.test.mts` - the `rag_` function list assertion now requires the two trigger functions instead of equalling exactly them (exposure check unchanged)

## Decisions Made

- **Guard trigger on chunk_embeddings.** The plan's `tenant_key` predicate is only as good as the writer. Copying it from the chunk in a trigger (same reasoning as 03-01 deviation 3) removes the possibility that the re-embed job, `--derive-from` or a bug files a vector under another tenant. The same trigger makes the registry length binding for profiles without an index (test and future profiles), and keeps the `dims` column truthful so gate check (d) is meaningful.
- **Evidence binds target and run.** T-03-27 asks that evidence match the baseline and the run id; the evidence must also name the target (otherwise evidence for profile X recorded on row Y could pass) and a `completed` backfill run of the target. Both have their own refusal prefix.
- **Rollback is one step.** The restored profile gets `previous_active_id = NULL`, so a second rollback is refused. Re-activating the rolled-away profile goes through the full gate again.
- **Legacy target.** The column holds the vectors, so completeness reads `embedding IS NULL`, the run-id check is skipped (a legacy profile is never backfilled) and staleness uses the newest current ready chunk's `created_at`. The legacy model recorded in chunk metadata is not part of the gate (the plan's check (d) concerns `chunk_embeddings` rows).
- **Seeds are idempotent data.** `ON CONFLICT (id) DO NOTHING`, so re-applying migrations never resets an activation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Guard trigger for tenant_key and vector length**
- **Found during:** Task 1 (threat T-03-24)
- **Issue:** `chunk_embeddings.tenant_key` is writer-supplied and the profile RPC trusts it; a wrong value (or a vector whose length differs from the registry for a profile without an index) would be silently accepted.
- **Fix:** `rag_chunk_embeddings_guard` (SECURITY DEFINER, pinned search_path, revoked from PUBLIC, anon and authenticated) always copies tenant_key from the chunk, sets `dims` from the vector, and raises `expected N dimensions, not M` against the registry; tests cover a forged tenant_key and a wrong-length vector.
- **Files modified:** supabase/migrations/0308_chunk_embeddings.sql, tests/rag-db/embedding-profiles.test.mts
- **Committed in:** `d413f16`

**2. [Rule 3 - Blocking] 03-01's test pinned the exact list of rag_ functions**
- **Found during:** Task 1 (running the rag-db suite)
- **Issue:** `tests/rag-db/schema-migrations.test.mts` asserted the defined `rag_%` functions equal exactly the two legacy-trigger functions, which any later Phase 3 function breaks.
- **Fix:** it now asserts both trigger functions exist; the check that no `rag_` function is executable by anon or authenticated is unchanged. Plan 03-10 adds `rag_*` functions too and will touch the same assertion, so a merge conflict on that line is possible; either resolution is fine as long as the exposure check stays.
- **Files modified:** tests/rag-db/schema-migrations.test.mts
- **Committed in:** `d413f16`

**3. [Rule 2 - Missing critical] Extra refusals for forged evidence**
- **Found during:** Task 3 (threat T-03-27)
- **Issue:** the plan's list of refusals does not stop evidence written for another target, or evidence that cites no real run.
- **Fix:** `activation_refused: eval_target_mismatch` and `eval_run_mismatch` (halfvec targets; the run must exist, belong to the target and be `completed`), plus `already_active`, `unknown_profile`, `actor_required`.
- **Files modified:** supabase/migrations/0309_profile_activation.sql, tests/rag-db/activation-gate.test.mts
- **Committed in:** `e1bc5fe` (tests), `b2e027a`

**4. [Rule 1 - Bug in own code] IF ... CASE ... THEN in PL/pgSQL**
- **Found during:** Task 3 (GREEN)
- **Issue:** a `CASE WHEN ... THEN` inside an `IF` condition ends the IF expression at the CASE's THEN ("syntax error at end of input"); the migration failed to apply and the suite hung in its `before` hook.
- **Fix:** the slice check is computed into a boolean variable first.
- **Files modified:** supabase/migrations/0309_profile_activation.sql
- **Committed in:** `b2e027a`

---

**Total deviations:** 4 (2 missing-critical security hardenings, 1 own-code bug, 1 blocking test adjustment)
**Impact on plan:** No scope creep; items 1 and 3 strengthen T-03-24 and T-03-27, item 2 is a one-line test relaxation.

## Issues Encountered

- **Iterative-scan test data.** The first small-tenant fixture used identical or one-dimensional vectors; pgvector's HNSW graph then had unreachable islands and returned 0 rows even with `relaxed_order` and `ef_search = 400`. Spread random vectors fix it (off: 0 rows, relaxed: 15, stable over 8 runs). A planner caveat for the test: with the `(profile_id, tenant_key)` btree index present the planner may choose an exact btree plan for a small tenant, so the test drops that index inside a transaction (rolled back) to force the HNSW plan and asserts the control under-fills before asserting the RPC fills.
- **Syntax error hangs the suite.** A migration that fails to apply makes the `before` hook reject and node:test reports every test as `cancelledByParent` with no message; running `createFixtureDatabase` in a scratch script shows the SQL error.
- `tests/rag/langfuse-pins.test.ts` read its files without an ENOENT in this worktree (vitest 119 files, 1534 tests pass).
- The sidecar was not touched, so its pytest was not run.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: security-definer-function | supabase/migrations/0308_chunk_embeddings.sql | `match_chunks_by_profile` and `rag_chunk_embeddings_guard` are SECURITY DEFINER (they read chunks and the registry regardless of RLS); search_path is pinned, EXECUTE is revoked from PUBLIC, anon and authenticated, and the RPC interpolates only a registry integer and a quoted literal |
| threat_flag: security-definer-function | supabase/migrations/0307_embedding_profiles.sql, 0309_profile_activation.sql | list, status, activation and rollback functions are SECURITY DEFINER and service_role only; they change which embedding model every tenant is searched with |

## User Setup Required

None - no external service configuration required. Applying 0307-0309 to the real Supabase project is a live verification item (below).

## Operator actions (live, not done here)

1. Before migrating: confirm `SELECT extversion FROM pg_extension WHERE extname = 'vector'` is 0.7.0 or later (halfvec) and ideally 0.8.0 or later (iterative scans); below 0.8.0 the RPC skips the setting and relies on superseded vectors being dropped.
2. The four HNSW indexes are created on an empty table, so they build instantly; later bulk loads should raise `maintenance_work_mem` only if indexes are ever rebuilt, and avoid pooler connections for any rebuild.
3. After migrating: `SELECT * FROM rag_list_embedding_profiles()` (service role) should show the legacy profile `active` and four `available` profiles; `RAG_EMBEDDING_PROFILES` stays `off`, so nothing changes until a profile is activated.

## Next Phase Readiness

- 03-28 (dual-write) can insert into `chunk_embeddings` without sending a correct tenant_key (the guard fixes it) and relies on `rag_set_embedding_profile_status` for `backfilling`.
- 03-36 can create `embedding_backfill_runs` rows with `derived_from`; 03-40 and 03-46 own the CLI, admin routes and the evidence writer that must produce `{target_profile, baseline_profile, gate_passed, pre_migration: {passed, n >= 1}, backfill_run_id (a completed run of the target), recorded_at}`.
- The re-embed job's `rag_reembed_*` functions (research Pattern 8) are not part of this plan.

## Self-Check: PASSED

All 6 created files exist; the 6 task commits are ancestors of HEAD (`d273f1f`, `d413f16`, `9c9ec8c`, `c91f346`, `e1bc5fe`, `b2e027a`); acceptance criteria re-run: `USING hnsw` 4 (>= 4), `score_calibration` 5 (>= 1), `format(` 1 (>= 1), `iterative_scan` 1 (>= 1), `activation_refused` 12 (>= 7); test counts 20, 5, 22 passed and 0 failed; `tests/rag-db/*.test.mts` 86 of 86; `tsc`, vitest (1534), `tests/*.test.mts` (136), boundary, workflows and config gates pass.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
