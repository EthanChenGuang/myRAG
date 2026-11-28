---
phase: 07-external-backends-release-defaults
plan: 02
subsystem: rag-vector-sync
tags: [outbox, change-capture, triggers, supabase, security]

requires:
  - phase: 03-ingestion-pipeline
    provides: "embedding_profiles and chunk_embeddings (0307-0309), version columns and generated tenant_key (0301), quarantine (0316), legacy compat triggers (0305)"
  - phase: 03.1-ingestion-queue
    provides: "rag_soft_delete_document (0357), claim/lease pattern (0352)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "lexical_text (0401), parent_id and chunking_profile_id (0404-0408), chunking activation (0413), PGlite role shim, 0410 upgrade lockdown"
provides:
  - "vector_sync_outbox, rag_vector_sync_targets (both seeded disabled), rag_backend_index_state (0701)"
  - "Ten statement-level enqueue triggers on document_chunks, documents, chunk_embeddings, embedding_profiles and chunking_profiles, no-op with no enabled target (0702)"
  - "rag_vector_sync_enqueue internal helper (dedupe into an untried pending row; optional target filter)"
  - "rag_vector_sync_claim / complete / fail / checkpoint / expand / requeue_dead / set_target (0703)"
affects: [07-06, 07-09, 07-11, 07-13, 07-14, 07-31, 07-33]

actuals:
  tasks: 3
  commits: 8

tech-stack:
  added: []
  patterns:
    - "AFTER ... FOR EACH STATEMENT triggers with transition tables; UPDATE triggers diff the synced columns of OLD and NEW themselves"
    - "Enqueue coalescing: a pending row with attempts 0 and no cursor for the same (target, entity, entity_id, tenant_key, profile_id) absorbs a new change"
    - "Claim serialised by a transaction advisory lock plus FOR UPDATE SKIP LOCKED and a live-lease NOT EXISTS"

key-files:
  created:
    - supabase/migrations/0701_vector_sync_outbox.sql
    - supabase/migrations/0702_vector_sync_triggers.sql
    - supabase/migrations/0703_vector_sync_claim.sql
    - tests/rag-db/vector-sync-schema.test.mts
    - tests/rag-db/vector-sync-triggers.test.mts
    - tests/rag-db/vector-sync-claim.test.mts
  modified:
    - supabase/migrations/0410_security_definer_rpc_grants.sql

key-decisions:
  - "UPDATE triggers have no column list: Postgres refuses transition tables on column-list triggers ('transition tables cannot be specified for triggers with column lists', probed on PGlite). Each UPDATE function compares the synced columns of OLD and NEW (FULL JOIN on the key, row IS DISTINCT FROM), so an UPDATE that sets an unsynced column, or sets a synced column to its current value, enqueues nothing"
  - "Synced chunk columns: document_id, tenant_key, organization_id, is_current, status, embedding, lexical_text, lexical_version, content_hash, doc_type, doc_date, language, source, chunking_profile_id, parent_id (D-02/D-03). Document columns: user_id, organization_id, tenant_key, is_current, status (D-01). chunk_embeddings: tenant_key, embedding, plus key changes"
  - "Vector columns are compared as ::text: with search_path = '' the pgvector = operator (extension schema) is not visible, while casts resolve through pg_cast"
  - "All new functions use SET search_path = '' (the executor brief overrides the plan's pg_catalog, public)"
  - "Enqueue coalescing in the trigger: a cascade fires both the documents and the document_chunks DELETE triggers, and per-row ingest writes fire once per chunk statement; one untried pending row per (target, entity, entity_id, tenant_key, profile_id) absorbs them. A leased, backed-off (attempts > 0) or checkpointed (cursor set) row never absorbs a change"
  - "Embedding profile rows are enqueued on any status change (activation, rollback, backfill start, retire); chunking rows only when a pointer moves to or from active. Profile rows carry tenant_key NULL (a CHECK allows NULL only for entity profile)"
  - "chunk_embeddings rows removed by a chunk cascade cannot name their document (the chunk is gone); the chunk's own DELETE trigger already enqueued that document for every profile (profile_id NULL)"
  - "claim takes pg_advisory_xact_lock so two concurrent claimers cannot both pass the live-lease test for one entity before either commits (SKIP LOCKED alone would let B lease A's sibling row)"
  - "checkpoint gives back the attempt the claim counted (attempts - 1), so a long paged expansion never walks into the dead line; the reclaim counts it again"
  - "fail stores codes only: p_error truncated to 200 and replaced by 'invalid_error_code' unless it matches ^[a-z0-9_.:-]+$; the cap least(2^attempts, 3600) is kept although the dead line (8) makes 2^7 = 128 s the largest backoff reached"
  - "set_target enqueues and marks index state building only on a disabled-to-enabled transition; re-enabling an enabled target is a no-op (disable then enable for a full rebuild). Synced profiles for index state: status active or backfilling"
  - "expand pages current documents by id after the uuid cursor, enqueues for the row's own target only, keeps the row's profile_id, and accepts entity tenant or profile (embedding:<id>, chunking:<doc_type>) on a leased row; anything else is 22023"
  - "0701 is a common file; the outbox and index-state tenant_key CHECK (s:default | [uo]:<lower-case uuid>) makes an upper-case key impossible"

patterns-established:
  - "A catalog test asserts every vector sync trigger function opens with the early exit, is SECURITY DEFINER and has search_path=\"\"; behaviour alone cannot see the early exit because the enqueue helper inserts nothing without an enabled target"

requirements-completed: []
requirements-advanced: [RET-05, RET-09]

coverage:
  - id: D1
    description: "Tables, CHECK enums, PK, indexes, RLS with no policy, anon/authenticated 42501, service_role read/write, idempotent re-apply"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-schema.test.mts"
        status: pass
  - id: D2
    description: "No enabled target: fixture load, writes, cascade, quarantine, release, soft delete, re-embed and profile flips leave the outbox empty"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-triggers.test.mts#no enabled target"
        status: pass
  - id: D3
    description: "One row per document per enabled target; cascade with OLD tenant; tenant move both keys; chunk_embeddings with profile_id; profile and chunking flips; upper-case user id"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-triggers.test.mts"
        status: pass
  - id: D4
    description: "Claim order, lease, live-lease exclusion, expiry, backoff, dead at 8, complete, checkpoint, expand, requeue_dead, set_target and index state, grants"
    requirement: RET-05, RET-09
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-claim.test.mts"
        status: pass
---

# Phase 7 Plan 02: Vector sync outbox, enqueue triggers and claim RPCs Summary

The change-capture half of RET-05: a notification-only outbox, a per-backend switch (both off), the index-state table, ten statement-level enqueue triggers that do nothing until an operator enables a backend, and the claim and lifecycle RPCs the drain worker (07-09) will call.

## Accomplishments
- 0701: `vector_sync_outbox` (with `cursor text`, A-12), `rag_vector_sync_targets` seeded `weaviate`/`qdrant` disabled, `rag_backend_index_state` keyed `(target, profile_id, tenant_key)`. CHECKs on every enum and on tenant key shape; claim index `(status, lease_until, enqueued_at)` and entity index `(target, entity, entity_id)`; RLS on, no policies, client roles revoked (tables and the identity sequence).
- 0702: three triggers each on `document_chunks` and `chunk_embeddings`, UPDATE and DELETE on `documents`, UPDATE on `embedding_profiles` and `chunking_profiles`; all `FOR EACH STATEMENT` with transition tables, SECURITY DEFINER (comment says why), `search_path = ''`, early exit when no target is enabled.
- 0703: `rag_vector_sync_claim`, `_complete`, `_fail`, `_checkpoint`, `_expand`, `_requeue_dead`, `_set_target`; SECURITY INVOKER, `search_path = ''`, service role only, `NOTIFY pgrst`.
- 0410: the ten new definer trigger functions joined the guarded upgrade lockdown (precedent `40d5b7e`).
- 3 new test files, 34 + 31 + 20 test cases across both modes.

## Task Commits
1. Task 1 (0701 tables): RED `13fc86e`, GREEN `f50f0e0`
2. Task 2 (0702 triggers): RED `628d3cf`, GREEN `93a59e9`
3. Task 3 (0703 RPCs): RED `54c5cd8`, GREEN `3db454c` (also adds the optional `p_target` to the 0702 enqueue helper)
4. Gate fix: `82b67c4` (0410 lockdown entries)

## Baseline re-measure (plan start, HEAD b4ec4a8)
Every count gate errored (files absent: grep exit 2) and every name-pattern gate errored (test file absent), so all still discriminated. After: `ENABLE ROW LEVEL SECURITY` 3, `cursor text` 1, `FOR EACH STATEMENT` 11, `REFERENCING OLD TABLE` 8, `SKIP LOCKED` 2, `GRANT EXECUTE ON FUNCTION public.rag_vector_sync_*(` in 0703: 7.

## Mutation guards (run by hand, then reverted)
- 0701 + `GRANT SELECT ... TO authenticated` on `rag_backend_index_state`: `--test-name-pattern=anon` fails 2.
- 0702 early exit removed from one function: `--test-name-pattern="no enabled target"` fails 2 (catalog check).
- 0703 live-lease `NOT EXISTS` removed: `--test-name-pattern="live lease"` fails 2.

## Tests that failed before the fix
- `tests/rag-db/search-rpc-grants-pglite.test.mts` "an upgraded database whose functions all kept their old open grants is locked by 0409 and 0410": failed with the ten `rag_vector_sync_*()` trigger functions executable by PUBLIC, anon and authenticated after 0702 landed; passes after `82b67c4`.
- `tests/rag-db/schema-equality.test.mts` "the dump has teeth" failed transiently between `f50f0e0` and `3db454c` (the last migration, 0701, defined no function); green from 0702 on.

## Deviations from Plan
1. **[Rule 3 - Postgres limit] No `UPDATE OF <cols>`.** Transition tables are refused on column-list triggers, so UPDATE triggers diff the synced columns themselves (key-decisions). Same observable behaviour, plus no enqueue for no-op writes.
2. **[Brief override] `SET search_path = ''`** everywhere instead of the plan's `pg_catalog, public`; vectors compared as text for that reason.
3. **[Rule 2 - correctness] Enqueue coalescing** into an untried pending row, so a cascade (two DELETE triggers) and per-statement ingest writes yield one row per document and target, as the plan's behaviour list requires.
4. **[Rule 2 - correctness] Advisory lock in claim** so concurrent claimers cannot both lease rows of one entity; the real-Postgres concurrent run stays with 07-33 Task 1.
5. **[Rule 2] checkpoint returns the claim's attempt**; documented above; tested as "attempts after checkpoint = attempts before the claim".
6. **[Rule 3] 0410 edited** to lock the new definer trigger functions on upgraded databases (`search-rpc-grants-pglite` gate).
7. Owner-write test uses an authenticated DELETE: multi-tenant `document_chunks` has no UPDATE policy for owners.

## Performance note (T-07-06)
With no target enabled every trigger returns on one indexed lookup of a two-row table, but Postgres still materialises the transition tables of every `document_chunks`/`documents`/`chunk_embeddings` statement. Large bulk updates (relex, re-embed) pay that tuplestore cost on default installs; no outbox rows or extra writes happen.

## Gates
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: 0 diagnostics
- `npx vitest run`: 253 files, 4063 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 166 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 1177 pass, 4 fail (pre-existing, below), 4 skipped. The first full run had 6 failures; the 2 `search-rpc-grants-pglite` ones were fixed by `82b67c4`
- check-rag-boundary and its node test: pass; `node scripts/check-config.mjs`: pass; `check-workflows.py`: OK
- `npm run test-rag -- --out eval/out/07-02`: gate PASS (7 skipped); `--fixture-mode ingest --out eval/out/07-02-ingest`: gate PASS (7 skipped)
- Python and contracts not touched: sidecar/eval pytest and gen:schemas do not apply.

**Pre-existing:** `tests/rag-db/ingest-mode-routing.test.mts` 4 tests (`--routing tiered`, `--force-tier structured|fast|premium`) fail because the Python parse worker downloads `cl100k_base.tiktoken` from openaipublic.blob.core.windows.net and the proxy's certificate is not trusted inside the worker (`CERTIFICATE_VERIFY_FAILED`). Same 4 failures on base `exec/03.1-52` with no 07xx migration (checked in a separate worktree). Environmental.

## Operator actions
None now: both targets ship disabled and nothing is enqueued. Enabling a backend later is `SELECT rag_vector_sync_set_target('<weaviate|qdrant>', true, '<actor>')` once the drain worker (07-09) is deployed.

## Next Phase Readiness
- 07-09 (drain worker): claim → coalesce by (target, entity, entity_id) → for tenant/profile rows call expand and then checkpoint (has_more) or complete; document rows read the current state; fail with a code.
- 07-31 must fold 0701-0703 and the 0410 additions into both setup files.
- 07-33 Task 1: run the concurrent SKIP LOCKED claim against real Postgres.
