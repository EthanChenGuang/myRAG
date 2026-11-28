---
phase: 07-external-backends-release-defaults
plan: 47
subsystem: rag-rollouts
tags: [rollouts, embedding-profiles, chunking-profiles, rebuild-runs, tenancy, revision-4]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-45 RAG_ROLLOUTS and RagConfig.rollouts; 07-40 RolloutRecord contract; 07-12 backend factory and readiness; 07-28 and 07-44 canary factory"
  - phase: 03.2-language-support-ingestion-hardening
    provides: "0809 rebuild runs (held versions, saved vectors, eval gate)"
  - phase: 03.1.1-domain-embedding-model-candidates-and-per-doc-type-model-sel
    provides: "per-doc-type binding legs, which an embedding_profile rollout leaves untouched"
provides:
  - "supabase/migrations/0744_rag_rollouts.sql: rag_rollouts, rag_rollout_tenants and the rag_rollout_* functions (start, set_tenant, rollback, finish, active, bucket, in_arm, chunking_map, rebuild publish/restore/sync)"
  - "src/lib/rag/rollout/resolve.ts: resolveRolloutArm, rolloutBucket, inCandidateArm, resolveRolloutQueryProfile, resetRolloutCacheForTests"
  - "src/lib/rag/rollout/cli.ts and npm run rag:rollout (start, list, include, exclude, rollback)"
  - "requestChunkingOverride in src/lib/rag/v2/overrides.ts: the one server-side chunking override (eval first, else the rollout arm)"
affects: [07-49, 07-52]

actuals:
  tokens: 190000
  tasks: 3
  commits: 10

key-files:
  created:
    - supabase/migrations/0744_rag_rollouts.sql
    - src/lib/rag/rollout/resolve.ts
    - src/lib/rag/rollout/cli.ts
    - tests/rag-db/rollouts.test.mts
    - tests/rag/rollout/resolve.test.ts
    - tests/rag/canary/rollout.test.ts
  modified:
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/v2/overrides.ts
    - src/lib/rag/v2/result.ts
    - src/lib/rag/pipeline.ts
    - package.json

key-decisions:
  - "The arm is resolved once per request in runV2Pipeline from the verified scope and rag_rollout_active only (30 s in-process cache); nothing is read while RAG_ROLLOUTS is off, and the eval profile never consults a rollout"
  - "A candidate embedding profile is used only while RAG_EMBEDDING_PROFILES is on and the profile is backfilling or active; otherwise that resolution is recorded as the incumbent arm, so the span never names an arm that did not serve"
  - "A failed rollout read serves the incumbent (one [RAG Rollout] warning per process), never an error"
  - "The candidate embeds through embedQueryForEvalProfile (the eval override's function); the retrieval config hash names it through the embedding profile id it already carries"
  - "Chunking rollout entries are '<doc_type>:<profile_id>' or a bare id (every built doc type); rag_rollout_active returns them as the {doc_type: profile_id} map the p_chunking_override path takes, so external backends answer filter_unsupported and fall back to pgvector without degrading, as for the eval override"
  - "rebuild_run rollouts: start and set_tenant publish or restore per tenant with the per-item bodies of rag_rebuild_activate and rag_rebuild_rollback after the same eval gate (eval_missing, eval_failed); on restore the rebuilt version's vectors are copied into rag_rebuild_saved_vectors before they leave the chunk rows, so no vector is lost"
  - "Span: the search stage detail carries `rollout=<id>:<arm>` for every active query-side rollout; the embed stage detail already names the profile"
  - "Salt: a 32-hex random value per rollout, generated at start; the CLI never prints it"

requirements-completed: [LANG-11]
---

# Phase 7 Plan 47: Per-tenant rollouts of embedding profiles and ingestion configurations

A new embedding profile, a set of chunking profiles or a Phase 3.2 rebuild run can now serve chosen tenants or a stable traffic share first and be taken back per tenant. Membership is deterministic by tenant key (sha256 bucket, identical in TypeScript and SQL), the arm comes only from the server-side scope and the rollout tables, and with `RAG_ROLLOUTS=false` no rollout table is read and the request is unchanged.

## Tasks

| Task | Commits |
| --- | --- |
| Branch setup (merges, migration number reserved) | `f3de441a` merge exec/07-44, `aed4c502` merge ci/merge-train-41, `2f6c8269` 0744 placeholder |
| 1. Tracer: a listed tenant is served by the candidate profile | `84d17a51` test, `f307c6ba` feat |
| 2. Share, ingestion rollouts, per-tenant rollback, CLI | `d0995396` test, `a2168b53` feat |
| 3. Mixed-rollout canary | `627ab6d3` test |

## Branch setup

- `exec/07-47` from `origin/exec/07-45` (`d2645421`), then `git merge --no-ff origin/exec/07-44` (`cbc7317a`, clean) and `git merge --no-ff origin/ci/merge-train-41` (`e89fee36`).
- Conflicts in the train merge, both sides kept:
  - `scripts/init-env.js`: the train still had the pre-07-27 layout block; every variable and value in it is already present in HEAD's `# RAG: <group>` layout (checked name by name and value by value), so HEAD's layout was kept and nothing was dropped.
  - `src/app/api/internal/rag/run/route.ts`: imports unioned (HEAD's `toStageRetrievalOverrides` plus the train's prompt-budget imports); the body keeps HEAD's helper, which now also carries the train's `leg_weights.domain` field (`src/lib/rag/v2/overrides.ts`).
  - `tests/rag-db/eval-v2-overlay.test.mts`: HEAD's test title (it names the D-17 entries the merged list holds).
- Migration number: fetched every origin branch; 0742 was taken on another branch, 0743 belongs to 07-46, 0744 (the plan's number) was free and was pushed as a placeholder first.

## Precondition

- 05, 05.1 and 06 VERIFICATION.md read `status: human_needed`.
- Every plan in depends_on has a SUMMARY on this branch.

## Behaviour changes

- With `RAG_ROLLOUTS=false` (default): none. No `rag_rollout_active` call (asserted on the fake edge), same backend requests, same hash.
- Under `RAG_PIPELINE=legacy` with `RAG_ROLLOUTS=true`: rollouts are ignored with one `[RAG Config]` line.
- With `RAG_ROLLOUTS=true` and v2: a candidate-arm tenant embeds and searches with the candidate profile and/or sends the candidate chunking override; the search span carries `rollout=<id>:<arm>`. An incumbent-arm tenant's backend requests and hash equal the switch-off run; its search detail gains only the `rollout=<id>:incumbent` code.

## Tests that failed before the change

- `tests/rag-db/rollouts.test.mts` (tracer, chunking, rebuild, CLI, grants): written first against the empty 0744 placeholder. The guard mutation "read rag_rollout_active before checking the switch" makes `switch off reads nothing` fail (checked).
- `tests/rag/rollout/resolve.test.ts`: bucket parity over 10,000 keys against the 0744 function text, share 7–13 %, membership order, defensive parsing, switch-off no-read.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors (after the merges and after every task)
- `node --import tsx --test tests/rag-db/rollouts.test.mts` (multi-tenant): 12 passed, 0 failed
- `npx vitest run tests/rag/rollout/resolve.test.ts`: 11 passed
- `RAG_CANARY_BACKENDS=pgvector npx vitest run tests/rag/canary/rollout.test.ts`: 4 passed (chat, embed, voice, rollback); external legs skipped (no Docker daemon, see below)
- `npx vitest run tests/rag/v2` plus every test file importing a changed module (`git grep` on v2/overrides, v2/pipeline, v2/result, v2/stages/search, rag/pipeline, rollout/): 74 files, 1041 passed, 13 skipped
- rag-db, both modes where the file runs both: search-path-empty, definer-search-path-pglite, schema-equality, access-catalog-sentinel, purge-grants, hybrid-grants, search-rpc-grants-pglite, lexical-stats-grants, schema-migrations: 171 tests, 167 passed and 4 failed on the first run; the 4 were access-catalog-sentinel asking to classify the two new rebuild functions that read document_chunks. They are now listed with rag_rebuild_activate/rollback as operator tools (commit with the SUMMARY), and the sentinel passes 14/14
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: ok
- `npm run test-rag -- --out eval/out/07-47`: gate PASS, absolute gate PASS, `passed: true`, `paired.all_zero: true`
- `npm run test-rag -- --fixture-mode ingest --out eval/out/07-47-ingest`: gate PASS, `passed: true`, `paired.all_zero: true`
- Not run: full vitest (no core type, env.ts or test setup change), full rag-db suite (merge train), Python, gen:schemas (no contract change), workflow check, UI design check. No test split used (D-37: ledger untouched).

## Deviations

- TDD order: Task 1's test and implementation were written in the same sitting; the RED commit precedes the GREEN one, and the switch-off guard was checked by mutation rather than by a separately pushed RED run.
- 0744 runs before 0809 in file order, so the rebuild functions use `record` variables instead of `%ROWTYPE` of the 0809 tables (their bodies resolve the tables at call time).
- `tests/rag-db/access-catalog-sentinel.test.mts` classifies `rag_rollout_rebuild_publish_tenant` and `rag_rollout_rebuild_restore_tenant` as operator tools (outside files_modified).
- `src/lib/rag/v2/result.ts` and `src/lib/rag/pipeline.ts` are outside files_modified: the hash must name the rollout chunking override, and the legacy path logs the ignored-rollouts line.
- Per-tenant rebuild restore keeps the rebuilt version's vectors in `rag_rebuild_saved_vectors` (the run-wide `rag_rebuild_rollback` deletes them); a restored item is not republished by a later include (item state `restored`).
- The canary's foreign-point case leaves the planted point in place for the last case, whose point counts are taken after it.

## Docker / external legs

No Docker daemon in this container (`/var/run/docker.sock` missing), so the Weaviate and Qdrant legs of `tests/rag/canary/rollout.test.ts` were not run here. Operator / merge-train action: `docker compose -f docker-compose.backends.yml up -d`, then `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant npx vitest run tests/rag/canary/rollout.test.ts` (expects 0 failed and at least 4 external cases passed per backend: chat, embed, voice, foreign point, rollback).

## Purge hooks

None added: rollouts hold tenant keys and membership only, no document or chunk data. The rebuild per-tenant functions write only to the 0809 stores, which `rag_purge_hook_rebuild` already covers.

## Operator actions

- Apply `supabase/migrations/0744_rag_rollouts.sql` after the 07xx block (not folded; idempotent).
- Run the external canary legs above with the compose backends.

## Deferred

- Admin route / Config UI for rollouts (07-49 owns the promotion and the cohort comparison).
- `rag_rollout_active` returns the salt to the server role; if a later admin route lists rollouts it must drop the salt as the CLI does.
