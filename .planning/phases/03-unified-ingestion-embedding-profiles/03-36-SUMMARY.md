---
phase: 03-unified-ingestion-embedding-profiles
plan: 36
subsystem: embeddings
tags: [re-embed, backfill, resumable, halfvec, matryoshka, rollback, dry-run, tenant-isolation, pglite]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "0308 chunk_embeddings, embedding_backfill_runs and gaps, guard trigger (03-09); registry, price table and providers (03-08); active pointer, getBackfillingProfiles and refreshAfterOperation (03-21); dual-write and rag_record_backfill_gap (03-28); embedding text builder and template header (03-10, 03-29); writer.ts and the operator-job rule (03-16)"
provides:
  - "Migration 0315: thirteen service-role rag_reembed_* functions bound to a run row (start, get, resume, next/missing batch, transactional write, derive, count, preview, remaining, finish, rollback, legacy guard) and one internal selection"
  - "src/lib/rag/ingest/reembed/: runReembed, dryRunReembed, rollbackReembedRun, cost estimate and the CLI behind npm run rag:reembed"
  - "createReembedWriter in writer.ts: the only door to the rag_reembed_* functions"
  - "scripts/rag/reprocess-documents.js --reembed delegation and safety refusals for its destructive legacy mode"
affects: [03-40, 03-43, 03-46, 03-47, 03-48]

actuals:
  tokens: 38817
  tasks: 3
  commits: 7
plan_head_before: 14f30e5f426a8493e3d0e2f92eb9c2701749e02d
plan_head_after: e73dcb9fca9ea92e24922f343563c1e6cbd913e2

tech-stack:
  added: []
  patterns:
    - "Every re-embed function takes a run id and reads the profile and tenant scope from the run row, never from the caller, so a run limited to one tenant cannot read, derive or write another tenant"
    - "One write call = upsert vectors + resolve gaps + move cursor and counts in one transaction; chunks that already hold a vector of the profile are not picked again, so a kill never causes a duplicate or a second embedding"
    - "Operator CLI modules load dotenv before any module that reads @/lib/env; cli.ts imports run.ts and deps.ts dynamically inside main()"

key-files:
  created:
    - supabase/migrations/0315_reembed_functions.sql
    - src/lib/rag/ingest/reembed/run.ts
    - src/lib/rag/ingest/reembed/cost.ts
    - src/lib/rag/ingest/reembed/cli.ts
    - tests/rag-db/reembed.test.mts
  modified:
    - src/lib/rag/ingest/writer.ts
    - scripts/rag/reprocess-documents.js
    - package.json

key-decisions:
  - "The functions are run-bound: rag_reembed_next_batch, missing_batch, write_batch, derive_batch, remaining, finish_run and rollback_run take p_run_id, and the profile and tenant come from the run row. The plan's Pattern 8 signatures carried p_profile_id and p_tenant_key; the run-bound form is stronger (T-03-101 and the two-tenant rule) and the TypeScript side has nothing to forge. Only the dry run (count, preview_batch) takes a profile and tenant, because no run exists"
  - "A chunk that already has a vector of the profile with the profile's model and dims is skipped by both the keyset pass and the sweep. A resumed run, dual-written chunks and a second run therefore never pay for the same chunk twice; the cursor is an efficiency hint and correctness rests on the upsert plus this filter. Consequence: the job fills what is missing, it does not refresh existing vectors (an EMBEDDING_TEXT_VERSION bump needs a rollback and a new run)"
  - "Starting a run flips the profile to backfilling inside rag_reembed_start_run, in the same transaction that creates the run row and under the same table lock the activation gate uses, instead of calling setEmbeddingProfileStatus first. After the start the job refreshes the pointer cache and confirms through getBackfillingProfiles() that ingestion will dual-write the profile (warning dual_write_not_active otherwise)"
  - "A run completes only when the database counts zero current ready chunks still lacking a vector in its scope (rag_reembed_finish_run refuses with reembed_refused: incomplete); the TypeScript side retries the sweep up to four rounds for chunks that arrive late. The profile stays backfilling after completion; only the 03-09 gate moves it on"
  - "Rollback deletes the profile's rows in the run's scope stamped between the run's start and its last update, the run's gaps, marks the run rolled_back and returns a backfilling profile to available. Refused for the active profile, for a running run updated in the last 10 minutes, and for any profile that has ever been active when a pointer flip happened in the last 10 minutes (the database keeps no deactivation time, so the latest activated_at stands in for it; this is conservative)"
  - "--derive-from is accepted only for a profile of the same provider and model with fewer dimensions than a halfvec source (derive_model_mismatch, derive_dims_not_smaller); chunks with no source vector stay missing and the run fails with derive_source_incomplete instead of calling a provider"
  - "Write calls are split by payload size (about 1 MB of vectors, as ingest's chunk writes) and every slice carries its own last chunk id as cursor, so a kill between slices still resumes at a committed prefix"
  - "The embedding text is rebuilt from stored columns only: section_path, the header rendered from the document's stored invoice columns through the doc type's processing profile (an unknown type renders no header, warning unknown_doc_type), and content. Image chunks use their stored caption like any other chunk"
  - "The legacy reprocess guard treats a non-legacy profile that holds chunk_embeddings rows as in use, in addition to the backfilling and active statuses the plan names, because the delete cascades to those rows"

patterns-established:
  - "Test seams for a kill: ReembedHooks.beforeWrite and afterWrite throw a Killed error that the job never catches, so the run is left running exactly as after a SIGKILL"
  - "A counting trigger on chunk_embeddings (test only) proves 'embedded exactly once' by upsert count per chunk, not only by row count"

requirements-completed: [EMB-04, EMB-05]

coverage:
  - id: D1
    description: "The 0315 functions: run start (profile to backfilling, refusals for active, legacy storage, retired, unknown, bad tenant key, overlapping run), keyset and sweep reads, transactional write with cursor and counts, gap resolution, per-tenant counts, derive, finish, rollback and legacy guard, all service role only"
    requirement: "EMB-04"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#re-embed SQL functions (migration 0315)"
        status: pass
    human_judgment: false
  - id: D2
    description: "runReembed fills every current ready chunk once from stored text with the text ingest embeds, in batches, with model and dims asserted and the share of rows per serving host reported"
    requirement: "EMB-04"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#a run over the corpus fills every current ready chunk once, with the text ingest embeds for the same chunk"
        status: pass
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#the report gives the share of rows per serving host, the fallback share for Qwen3"
        status: pass
    human_judgment: false
  - id: D3
    description: "Zero parser, sidecar, object-store and OpenAI calls: throwing fakes, call counts on the fake sidecar and LlamaParse, the fake edge seeing only re-embed and registry calls, and a structural check of the module imports"
    requirement: "EMB-04"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#the job makes no parser, sidecar, object-store or OpenAI call"
        status: pass
      - kind: unit
        ref: "tests/rag-db/reembed.test.mts#the job modules import no parser, sidecar, object-store or OpenAI client"
        status: pass
    human_judgment: false
  - id: D4
    description: "A process killed between batches, and one killed after a batch was embedded and before it was written, resume to one complete set with every chunk upserted exactly once; a resume must name the profile and tenant of the run; a vendor outage fails the run as provider_failed and resumes"
    requirement: "EMB-04"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#a process killed between batches resumes from its cursor and ends with every chunk embedded exactly once"
        status: pass
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#a process killed after a batch was embedded and before it was written loses only that batch"
        status: pass
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#a vendor outage fails the run as provider_failed and a resume finishes it"
        status: pass
    human_judgment: false
  - id: D5
    description: "Dry run prints per tenant chunks, cl100k tokens and estimated cost (non-OpenAI labelled estimates), reads only, writes no run, no vector and no status change; the CLI output has counts and costs and no stored text or key"
    requirement: "EMB-04"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#a dry run reports chunks, tokens and cost per tenant, labels the token counts as estimates and writes nothing"
        status: pass
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#the CLI dry run prints counts and costs only, never a word of stored text, and exits 0"
        status: pass
    human_judgment: false
  - id: D6
    description: "--derive-from fills a 1024-dimension profile from stored 2048-dimension vectors as unit vectors with zero provider calls, and fails visibly when the source is incomplete"
    requirement: "EMB-04"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#--derive-from fills a 1024-dimension profile from stored 2048-dimension vectors with no provider call"
        status: pass
    human_judgment: false
  - id: D7
    description: "A wrong-dimension or wrong-model answer stops the run with embedding_profile_mismatch, leaves the cursor at the last good batch and stores nothing of the bad batch"
    requirement: "EMB-05"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#an answer with the wrong dimensions stops the run with embedding_profile_mismatch and leaves the cursor at the last good batch"
        status: pass
    human_judgment: false
  - id: D8
    description: "Two-tenant isolation: a re-embed limited to tenant A reads, sends and writes only tenant A, and the run cannot be used to write a vector for tenant B"
    requirement: "EMB-04"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#two tenants: a re-embed limited to tenant A never reads, sends or writes tenant B"
        status: pass
    human_judgment: false
  - id: D9
    description: "Rollback deletes the run's rows, keeps earlier rows, and is refused for the active profile, a live run and within 10 minutes of a pointer flip"
    requirement: "EMB-05"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#rollback is refused for the active profile, for a run still in progress and within 10 minutes of a pointer flip, and allowed after"
        status: pass
    human_judgment: false
  - id: D10
    description: "With RAG_EMBEDDING_PROFILES off ingestion still writes the legacy vector alone, the active pointer is the legacy profile and the operator is warned that dual-write is inactive"
    requirement: "EMB-05"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#with RAG_EMBEDDING_PROFILES off ingestion, the active pointer and dual-write targets do not change while a run exists"
        status: pass
    human_judgment: false
  - id: D11
    description: "reprocess-documents.js --reembed delegates to the TypeScript job and forwards its exit code; the legacy mode refuses (exit 3) on versioned documents, a backfilling, active or vector-holding profile, or a database it cannot ask; its default model is text-embedding-3-small"
    requirement: "EMB-04"
    verification:
      - kind: integration
        ref: "tests/rag-db/reembed.test.mts#scripts/rag/reprocess-documents.js"
        status: pass
    human_judgment: false
  - id: D12
    description: "The job against a real Supabase project and real Voyage, DeepInfra and OpenRouter keys: PostgREST accepting the ~1 MB write payloads, statement time of rag_reembed_count and rag_reembed_remaining on the real chunk count, the Voyage Matryoshka assumption behind the derived profile, and the real fallback share"
    verification: []
    human_judgment: true
    rationale: "No live project or vendor key is reachable here; PGlite and fake providers prove the SQL semantics and the job logic only"

duration: 41min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 36: Re-embed job Summary

**A resumable, tenant-bound re-embed job: `npm run rag:reembed` fills a new embedding profile from stored chunk text through run-bound SQL functions (keyset pass, sweep, transactional cursor), with a dry-run cost report, a Matryoshka `--derive-from` mode, a guarded rollback, and a legacy `reprocess-documents.js` that now delegates with `--reembed` and refuses to delete cited chunks**

## Performance

- **Duration:** 41 min
- **Started:** 2026-11-24T08:26:33Z
- **Completed:** 2026-11-24T09:07:18Z
- **Tasks:** 3 (each a RED and GREEN pair, plus one follow-up commit in Task 2)
- **Files modified:** 8 (5 created, 3 modified), 3152 insertions, 2 deletions

## Accomplishments

- **SQL (0315).** `rag_reembed_start_run` refuses the active, legacy-storage, retired and unknown profile, a bad tenant key and an overlapping running run, flips the profile to `backfilling` and records `derived_from`. `rag_reembed_next_batch` and `rag_reembed_missing_batch` return current ready chunks (with the columns the embedding template needs: section path, kind, doc type and the document's invoice columns) in id order, skipping chunks that already hold a vector of the profile. `rag_reembed_write_batch` upserts with `ON CONFLICT (chunk_id, profile_id) DO UPDATE`, resolves gaps and moves the cursor, counts and tokens in one transaction, and rolls the whole batch back on a wrong-length vector, a chunk of another tenant, a non-current chunk or a duplicate. `rag_reembed_derive_batch` writes `l2_normalize(subvector(source, 1, dims))`. `rag_reembed_finish_run` completes only at zero missing. `rag_reembed_rollback_run` and `rag_reembed_legacy_guard` as described under Decisions. All functions are SECURITY DEFINER with a pinned search_path and granted to `service_role` only; the shared selection `rag_reembed_pick` is not granted at all.
- **Job.** `runReembed` embeds stored text in batches, asserts the provider's canonical model and every vector length (a mismatch stops the run as `embedding_profile_mismatch` with the cursor at the last good batch), writes in size-bounded slices, sweeps until the database confirms completeness, and reports chunks, tokens, per-tenant estimates, batches, the share of rows per serving host (and the OpenRouter fallback share for Qwen3), and warnings. A failed run is resumable with `--resume <runId>`; a killed process leaves its run `running` and resumes the same way.
- **Dry run and cost.** `dryRunReembed` counts chunks per tenant, tokenises the rebuilt embedding text with cl100k_base in-process, and prices it from the registry table; Voyage and Qwen3 are labelled estimates. It starts no run, writes nothing, calls no provider.
- **CLI.** `npm run rag:reembed -- --profile <id> [--dry-run] [--batch-size 128] [--tenant <key>] [--resume <runId>] [--rollback <runId>] [--derive-from <profileId>]`. Output is counts, dollars, run ids and reason words; exit 0 done, 1 failed or refused, 2 bad arguments.
- **Script.** `node scripts/rag/reprocess-documents.js --reembed ...` spawns the TypeScript CLI through tsx and forwards its exit code. Its destructive legacy mode now asks the database first and exits 3 without touching anything when any document has version above 1, a non-legacy profile is backfilling, active or holds vectors, or the question cannot be answered; its default model is `text-embedding-3-small`. `reprocess-docs` in package.json now points at the script that exists.

## Task Commits

1. **Task 1: Re-embed SQL functions** - RED `3ec0168` (test), GREEN `3b6e7ee` (feat)
2. **Task 2: The TypeScript job, cost estimate and CLI** - RED `840b0fb` (test, with inert stubs), GREEN `ca85c58` (feat), follow-up `e73dcb9` (feat: confirm dual-write through `getBackfillingProfiles()`)
3. **Task 3: reprocess-documents.js `--reembed` and refusals** - RED `4d2636b` (test), GREEN `a274330` (feat)

**Plan metadata:** the docs commit that adds this file.

## TDD Evidence

The plan is `type: execute` with task-level `tdd="true"` and `workflow.tdd_mode` is off, so `gsd_run check tdd-red-evidence` was not run (earlier plans recorded INVALID_RED for node:test TAP output). Each RED was classified by hand: every failing test failed with `ERR_ASSERTION`, none on a module-not-found, syntax or fixture fault.

- **RED 1** (`3ec0168`): 15 tests, 0 pass, 15 fail. The SQL helpers turn a missing function into an assertion failure ("function rag_reembed_start_run ... does not exist" inside `assert.fail`); two tests failed on `assert.ok(names.includes(...))` ("rag_reembed_start_run is missing").
- **RED 2** (`840b0fb`): 22 tests in the job suite, 21 fail on assertions against inert stubs (empty reports, `ok: false` parser), 1 passes (the structural import check; with the writer's `createReembedWriter` not yet committed it would also fail, but the working tree already held it). The three kill tests fail with "Missing expected rejection (Killed)".
- **RED 3** (`4d2636b`): 7 tests, 0 pass, 7 fail: the script ran its legacy mode (no refusal, no delegation, the `ada-002` banner).
- GREEN counts: 15, 22 and 7 passed; the whole file reports 44 passed, 0 failed.

## Files Created/Modified

- `supabase/migrations/0315_reembed_functions.sql` - the functions described above
- `src/lib/rag/ingest/reembed/run.ts` - `runReembed`, `dryRunReembed`, `rollbackReembedRun`, `ReembedInputError`, hook seams for the kill tests
- `src/lib/rag/ingest/reembed/cost.ts` - `estimateReembedCost`, `formatUsd`, the estimate note
- `src/lib/rag/ingest/reembed/cli.ts` - `parseReembedArgs`, `main`, the guarded entry point (dotenv loaded first, SIGINT aborts the run, which stays resumable)
- `src/lib/rag/ingest/writer.ts` - appended `ReembedWriterError`, the re-embed row types and `createReembedWriter` (no existing line changed)
- `scripts/rag/reprocess-documents.js` - delegation, `assertLegacyModeIsSafe`, schema-tolerant fallback guard, default model
- `package.json` - `rag:reembed` script, `reprocess-docs` path corrected
- `tests/rag-db/reembed.test.mts` - 44 tests over three PGlite fixtures (SQL, job and CLI, script)

## Decisions Made

See `key-decisions`. The two that later plans rely on most: every re-embed function is run-bound (a new function that touches chunks for an operator job should follow the same rule), and the job fills only what is missing, so completeness is always measured by the database, not by the cursor.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Run-bound function signatures instead of profile and tenant arguments**
- **Found during:** Task 1 (threat T-03-101 and the two-tenant rule in the brief)
- **Issue:** Pattern 8 passes `p_profile_id` and `p_tenant_key` to the read and write functions, so a TypeScript bug or a copied call could read or write another tenant's chunks.
- **Fix:** all read, write, derive, finish and rollback functions take `p_run_id`; the run row carries the profile and the tenant scope. `write_batch` refuses any chunk outside the scope (`tenant_mismatch`) and rolls the whole call back. Only `rag_reembed_count` and `rag_reembed_preview_batch` (the dry run) take a profile and tenant.
- **Files modified:** supabase/migrations/0315_reembed_functions.sql
- **Committed in:** `3b6e7ee`

**2. [Rule 3 - Blocking] writer.ts edited although it is not in the plan's file list**
- **Found during:** Task 2 (brief: operator jobs write through writer.ts; boundary rule that RPC names live in one place)
- **Fix:** an appended block `createReembedWriter` with typed methods, an error class that carries the function name, code and the refusal words only (never a database message), and no change to any existing export.
- **Files modified:** src/lib/rag/ingest/writer.ts
- **Committed in:** `ca85c58`

**3. [Rule 1 - Bug] rag_reembed_remaining returned a bare bigint**
- **Found during:** Task 2 (typing the writer)
- **Issue:** PostgREST answers a scalar function with a bare number, not an array of rows, while the fake edge answers rows; the writer expects rows.
- **Fix:** it now returns a one-row table `(chunks_missing bigint)`. The Task 1 migration was edited in the Task 2 commit (nothing had been released).
- **Files modified:** supabase/migrations/0315_reembed_functions.sql
- **Committed in:** `ca85c58`

**4. [Rule 2 - Missing critical] Legacy guard also covers profiles that hold vectors**
- **Found during:** Task 3
- **Issue:** the plan names backfilling and active profiles; the legacy mode's chunk delete also cascades to the `chunk_embeddings` rows of an `available` profile (a prepared or rollback-target profile), destroying a finished backfill silently.
- **Fix:** `rag_reembed_legacy_guard` counts a non-legacy profile with any `chunk_embeddings` row as in use. A refusal is exit code 3, and an unanswerable question also refuses.
- **Files modified:** supabase/migrations/0315_reembed_functions.sql, scripts/rag/reprocess-documents.js
- **Committed in:** `3b6e7ee`, `a274330`

**5. [Interpretation] Pass A skips chunks that already hold a vector**
- Pattern 8's keyset pass re-reads every current chunk. The job instead picks only chunks lacking a vector of the profile (same model and dims) in both the pass and the sweep. This is what makes "every chunk embedded exactly once" hold for dual-written chunks and resumed runs. See the refresh limit under Decisions.

**6. [Interpretation] Rollback window rule**
- "Refused for one active within the last 10 minutes" needs a deactivation time that the registry does not store. The rule used: refused when the profile has ever been active and any pointer flip happened in the last 10 minutes. Conservative; a profile that was never active is never blocked by it.

**7. [Interpretation] `getBackfillingProfiles()` and profile-ops**
- The profile flip to `backfilling` happens inside `rag_reembed_start_run` (same transaction as the run row) rather than through `setEmbeddingProfileStatus`; the job then refreshes the pointer and uses `getBackfillingProfiles()` to confirm that ingestion dual-writes the profile. The status-setting function is unchanged and still the way to move a profile to `retired`.

---

**Total deviations:** 7 (2 Rule 2, 1 Rule 3, 1 Rule 1, 3 interpretation notes)
**Impact on plan:** every must_haves truth holds. Items 1 and 4 strengthen the tenant and citation guarantees; no scope was added beyond the three tasks.

## Issues Encountered

- **doc-type-branching boundary rule.** `chunk.docType !== null` in run.ts tripped `check-rag-boundary.mjs` (document types are data, D-13); the check is now `if (chunk.docType)` and the type is only passed to `getProcessingProfile`.
- **Unknown doc type value.** The fixture's `documents_doc_type_check` allows `invoice_receipt`, not `invoice`; the template-header test uses the real type name.
- **Test infrastructure.** `spawnSync` would block the fake edge that lives in the test process, so the script tests use an async `spawn`. The upload-based tests install the fake object store in `beforeEach` (ingest stores the original).
- `tests/rag/langfuse-pins.test.ts` ran and passed inside vitest in this worktree (no ENOENT).

## Known Stubs

None. The RED-commit stubs of run.ts, cost.ts and cli.ts were replaced by the real implementations in `ca85c58`.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: security-definer-function | supabase/migrations/0315_reembed_functions.sql | Thirteen new SECURITY DEFINER functions, service role only, pinned search_path. `rag_reembed_preview_batch` and `rag_reembed_next_batch` return stored chunk text (the first without a run, for the dry run) and `rag_reembed_rollback_run` deletes vectors; all are revoked from PUBLIC, anon and authenticated and tested with `has_function_privilege`. Run-bound functions cannot leave the run's tenant scope |
| threat_flag: operator-cli-reads-all-tenants | src/lib/rag/ingest/reembed/cli.ts | The CLI holds the service key and, without `--tenant`, reads and sends the stored text of every tenant to the embedding vendor; the dry run counts it locally and prints counts only |

Threat register: T-03-101 (partial or duplicated vectors): cursor and rows commit together, upsert on `(chunk_id, profile_id)`, two kill-and-resume tests with a per-chunk upsert counter. T-03-102 (rollback of a live profile): refused for the active profile, a live run and within 10 minutes of a flip. T-03-103 (destructive legacy reprocess): refusal on versions, non-legacy profiles in use or holding vectors, or an unanswerable check. T-03-104 (keys in output): the CLI prints presence-free counts, costs, ids and reason words; a test asserts no stored text and no key material in the output. T-03-SC: no package added or changed.

## User Setup Required

None - no external service configuration required and no new environment variable (nothing to mirror in the config sync). Operator actions are below.

## Operator Actions

1. **Apply migration 0315** (`scripts/setup-database.sh`, after 0307-0314) before the first run; it adds functions only and re-applies safely. It also adds `rag_reembed_legacy_guard`, which the legacy mode of `reprocess-documents.js` calls (without it the script falls back to table reads and still refuses on any doubt).
2. **Run order for a new profile:** set `RAG_EMBEDDING_PROFILES=on` (so ingestion dual-writes while the run is going; with it off the CLI warns and a later document needs another run), then `npm run rag:reembed -- --profile <id> --dry-run` for counts and cost, then `npm run rag:reembed -- --profile <id> [--tenant <key>]`. Note the run id it prints.
3. **After a kill or a failure:** `npm run rag:reembed -- --resume <runId>` (the profile and tenant are taken from the run; passing `--profile` or `--tenant` that differ is refused). A run for a profile that is already running for an overlapping tenant is refused with `run_in_progress`: resume it instead.
4. **Lower-dimension profiles:** `npm run rag:reembed -- --profile qwen3-8b-1024 --derive-from qwen3-8b-2048` makes no provider call; the Voyage 1024 profile relies on Matryoshka truncation (assumption A4) and must be judged by the eval before activation.
5. **Rollback:** `npm run rag:reembed -- --rollback <runId>`; refused for the active profile, a run updated in the last 10 minutes, and within 10 minutes of a pointer flip.
6. **Legacy mode:** `node scripts/rag/reprocess-documents.js` (no `--reembed`) exits 3 with an explanation when it would destroy cited chunks. `--reembed` accepts exactly the `rag:reembed` options.
7. **Live checks (not done here):** one real dry run against the project (count and preview statement time on the real chunk count), one small tenant-limited run against the real providers to confirm ~1 MB write payloads through PostgREST and the host share, and the first derived 1024 profile compared by the eval.

## Next Phase Readiness

- 03-40 and 03-46 can build the activation CLI and evidence writer on a profile that a completed run has filled; the run id to cite as `backfill_run_id` is the one the CLI prints, and `embedding_backfill_runs.status = 'completed'` now means the database counted zero missing chunks in the run's scope. A run limited to one tenant completes for that tenant only; the 03-09 gate still checks the whole deployment.
- 03-43 (admin panel) can show runs and call the same `createReembedWriter` methods.
- No blockers. No package was installed or locked.

## Gate Results (worktree /home/user/wt/03-36, branch exec/03-36)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 147 files, 2072 tests passed, 0 failed |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 328 tests: 325 passed, 0 failed, 3 skipped (single-tenant variants, by design in earlier plans) |
| `node --import tsx --test tests/rag-db/reembed.test.mts` | 44 passed, 0 failed (criterion: at least 14) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 756 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| `node --check scripts/rag/reprocess-documents.js` | ok |
| rag-sidecar pytest | not run, sidecar untouched |
| `tests/rag/langfuse-pins.test.ts` | passed here, no ENOENT |

Acceptance greps: `ON CONFLICT (chunk_id, profile_id)` in 0315 = 2 (EXPECT >=1); `l2_normalize` in 0315 = 2 (EXPECT >=1); `"rag:reembed"` in package.json = 1 (EXPECT ==1); `scripts/rag/reprocess-documents.js` in package.json = 1 (EXPECT ==1); `--reembed` in the script = 4 (EXPECT >=1); `text-embedding-ada-002` in the script = 0 (EXPECT ==0). No model identifiers beyond the registry's own ids, no keys and no real identifiers were added.

## Self-Check: PASSED

Created files exist on disk (0315 migration, run.ts, cost.ts, cli.ts, reembed.test.mts, this file); the seven task commits (`3ec0168`, `3b6e7ee`, `840b0fb`, `ca85c58`, `4d2636b`, `a274330`, `e73dcb9`) are ancestors of HEAD; the ledger count measured by `git rev-list --count 14f30e5..HEAD` is 7. All acceptance criteria and gates above were re-run after the last code commit, except the full `tests/rag-db` suite: it ran on the tree before the last follow-up commit (`e73dcb9`, which touches only run.ts, cli.ts and this plan's own test file), and `tests/rag-db/reembed.test.mts` was re-run in full after it (44 passed).

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
