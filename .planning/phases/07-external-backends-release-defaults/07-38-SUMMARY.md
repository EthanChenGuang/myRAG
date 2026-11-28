---
phase: 07-external-backends-release-defaults
plan: 38
subsystem: rag-sync
tags: [vector-sync, access-groups, qdrant, weaviate, sec-12, ret-06, ret-05, ret-10]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-06 sync reads (0705) and rag_validate_chunks (0704); 07-07/07-08 collection setup; 07-09 servable planner; 07-36 last stores editor; 07-53 BM25 pair on both collections; 07-25 fixture regression"
  - phase: 04.3-document-access-groups
    provides: "seam 2: documents/document_chunks.access_groups text[] NOT NULL DEFAULT '{all}' (0921), relabel propagation and client write guard (0923)"
provides:
  - "supabase/migrations/0742_vector_sync_access_groups.sql: access_groups in rag_vector_sync_document_rows / rag_vector_sync_chunk_row; access_groups in the compared columns of the 0702 documents and chunks UPDATE trigger functions; rag_validate_chunks_for_groups(p_tenant_key, p_ids, p_profile_id, p_access_groups); one-time tenant re-sync"
  - "VectorPointPayload.access_groups (required); toPoint refuses a row without valid keys"
  - "Qdrant keyword payload index access_groups; Weaviate indexFilterable text[] property access_groups (added in place to an existing collection)"
affects: [07-39]

actuals:
  tokens: 90000
  tasks: 3
  commits: 8  # merge, reserve, 2 RED, 2 GREEN, 1 fixture fix, SUMMARY

tech-stack:
  added: []
  patterns:
    - "A migration that sorts before the one adding a column it reads adds the column itself with the identical definition (ADD COLUMN IF NOT EXISTS), so file order does not matter"

key-files:
  created:
    - tests/rag-db/vector-sync-access-groups.test.mts
    - tests/rag/sync/access-groups-payload.test.ts
  modified:
    - supabase/migrations/0742_vector_sync_access_groups.sql
    - src/lib/rag/sync/stores/types.ts
    - src/lib/rag/sync/servable.ts
    - src/lib/rag/sync/stores/fake.ts
    - src/lib/rag/sync/stores/qdrant.ts
    - src/lib/rag/sync/stores/weaviate.ts
    - src/lib/rag/backend/qdrant/collection.ts
    - src/lib/rag/backend/weaviate/collection.ts
    - src/lib/rag/backend/weaviate/types.ts
    - src/lib/rag/v2/overrides.ts  # merge resolution only
    - src/app/api/internal/rag/run/route.ts  # merge resolution only
    - tests/rag-db/eval-v2-overlay.test.mts  # merge resolution only
    - tests/rag-db/vector-sync-tracer.test.mts
    - tests/rag-db/purge-seam.test.mts
    - tests/rag-db/vector-sync-purge-drain.test.mts
    - tests/rag/backend/weaviate-fake.ts
    - tests/rag/backend/lexical-params.test.ts
    - tests/rag/sync/fake-rpc.ts
    - tests/rag/sync/servable.test.ts
    - tests/rag/sync/qdrant-store.test.ts
    - tests/rag/sync/weaviate-store.test.ts
    - "payload fixtures: tests/rag/backend/qdrant-adapter.test.ts, tests/rag/canary/foreign-point.test.ts, tests/rag/sync/{drain,purge,reconcile-purge,store-purge}.test.ts"

requirements: [SEC-12, RET-06, RET-05]
---

# 07-38 SUMMARY: vector sync carries document access groups

Every external point now carries its chunk's Phase 4.3 access keys. A group change reaches the store through the outbox like any other update. Both collections index the field. Supabase can re-validate a hit against the caller's tenant and groups in one call, which plan 07-39 will use. With `RAG_DOC_ACCESS_GROUPS` off the field is written but never queried, so retrieval is unchanged.

## Branch and merge

- `exec/07-38` was created from `origin/exec/07-25` (d9336956). `origin/ci/merge-train-41` (e89fee36) was then merged with `--no-ff`, as the orchestrator authorized (commit 222845ad8).
- Two conflicts; both sides were kept:
  - `src/app/api/internal/rag/run/route.ts` imports: 07-25's `toStageRetrievalOverrides` and train-41's prompt-budget names. For the `toRetrievalOverrides` body, 07-25 had moved it into the shared helper and train-41 had edited it inline. It now calls the shared helper, and `src/lib/rag/v2/overrides.ts` gains train-41's addition, the optional `domain` leg weight, so nothing from either side is lost.
  - `tests/rag-db/eval-v2-overlay.test.mts`: 07-25's title, which includes "the three Phase 7 D-17 names", was kept. The allow-list body auto-merged.

## Commits

| Task | Commit | What |
|------|--------|------|
| setup | 222845ad8 | dependency merge of ci/merge-train-41 |
| setup | 0061b6478 | reserve migration 0742 (pushed at once) |
| 1+3 RED | 57c21f760 | PGlite test: payload, group-change outbox row, re-apply, default install, one-time re-sync, group-aware validation (both modes) |
| 1 GREEN | de7e7cd70 | migration 0742, payload type, planner, fake store, fixture payloads |
| 2 RED | 413854482 | store and collection test |
| 2 GREEN | bc28ea209 | Qdrant index, Weaviate property, both store writes |
| fix | f0eee46e5 | two .mts purge fixtures (not covered by tsc) build points with access_groups |

Task 3's cases (isolation, refusal, roles, parity) are in the Task 1 test file and were RED in 57c21f760 (function missing). They passed on the first 0742 body, so 0742 needed no Task 3 adjustment.

## Behaviour

- **Sync reads (0742):** `rag_vector_sync_document_rows` and `rag_vector_sync_chunk_row` also return `access_groups text[]`. Arguments, SECURITY INVOKER, `search_path ''`, the `rag_assert_tenant_key` guard and the service-role-only grants are unchanged. The redefinition runs inside a DO block that first checks whether the functions already return the column, so a re-run is a no-op.
- **Group changes:** `access_groups` is added to the compared columns of the 0702 functions `rag_vector_sync_documents_update` and `rag_vector_sync_chunks_update`. A relabel (`rag_set_document_access_groups` → `rag_access_groups_propagate`) enqueues exactly one `document` row per enabled target; the pending-row rule absorbs the second statement. Nothing is enqueued with every target disabled, or for updates that change no synced column.
- **`rag_validate_chunks_for_groups`:** this is `rag_validate_chunks` restricted to chunks whose `access_groups` overlap the caller's keys. As defence in depth it also requires the joined document's `access_groups` to overlap (Phase 4.3 D-12). NULL or empty keys raise 22023. More than 500 ids, malformed keys, other-mode keys and unknown profiles raise as `rag_validate_chunks` does. It is SECURITY INVOKER, revoked from PUBLIC, anon and authenticated, and granted to service_role. It was already listed as EXEMPT in `access-catalog-sentinel`.
- **One-time re-sync:** when 0742 replaces the reads, it enqueues one `tenant` row per enabled target and per tenant with index state. A default install (no target) and a re-run enqueue nothing.
- **Payload:** `VectorPointPayload.access_groups: string[]` is required. `toPoint` accepts a PostgREST array or a `{a,b}` literal. It throws on a missing or malformed key rather than guessing `all`: the drain fails that row, so an app newer than its database fails closed. The D-03 field list gains only `access_groups`.
- **Qdrant:** a `keyword` payload index on `access_groups`, created before data on a new collection. On an existing collection the existing missing-index path creates it once, and the per-process cache sends nothing on a second call. The store writes the keys as planned and refuses a point without them.
- **Weaviate:** an `indexFilterable` `text[]` property `access_groups` (field tokenization, not searchable) in the creation body. `ensureCollection` adds it to an existing collection that lacks it with `config.addProperty`, once, and never recreates the collection. `WeaviateCollectionHandle` gains `config.addProperty`, and `collections.export` types `properties`. The store writes the array and refuses a point without it.
- Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed chat are untouched: no query path reads the field yet, and the default backend remains pgvector.

## Deviations

1. **Trigger design:** the plan asked for new statement-level `UPDATE OF access_groups` triggers, and its acceptance grep required `SECURITY DEFINER` to appear 0 times in 0742. Neither could be done as written:
   - Postgres refuses transition tables on a trigger with a column list (0702 says so), so such a trigger cannot tell which rows changed.
   - An extra UPDATE trigger per table breaks the A-7 invariant ("one trigger per event") and the 0702 check that every sync trigger function is SECURITY DEFINER with the early exit. `vector-sync-triggers` failed 4 tests on my first, separate-trigger version.

   Following the plan's own "(one trigger per event, A-7)", I added `access_groups` to the compared columns of the two existing 0702 UPDATE trigger functions. 0742 re-declares those two functions with their unchanged DEFINER rights. So `grep -c "SECURITY DEFINER"` on 0742 is 2, not 0. The criterion's other intent holds: no new privileged function exists, and the new validation function is INVOKER. Operator note: after re-running 0702, re-run 0742.
2. **Column order:** 0742 sorts before Phase 4.3's 0921, so on a fresh install it would read a column that does not exist yet. 0742 therefore adds `access_groups` to both tables with 0921's exact definition (`ADD COLUMN IF NOT EXISTS ... text[] NOT NULL DEFAULT '{all}'`). 0921 then adds its check, GIN index and copy trigger unchanged. Schema equality passes in both modes.
3. **Acceptance grep `rag_validate_chunks_for_groups` ≥ 3:** the count is 5. Met.
4. **Snapshots:** the LEX-05 creation-body snapshots in `tests/rag/backend/lexical-params.test.ts` gained only the new property and index entries, hand-edited for a minimal diff. `qdrant-store` and `weaviate-store` gained `access_groups` in their expected field lists.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- vitest:
  - `tests/rag/sync`, every test file importing a changed module (git grep on the module paths), plus `tests/rag/backend-conformance`, `tests/rag/canary`, `tests/rag/backend` and `tests/rag/admin`: 362 passed / 12 skipped, then 488 passed / 129 skipped (skips are live-vendor suites).
  - Importers of the merge-touched `overrides.ts` and the run route: 19 files, 305 passed.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`, `node scripts/ci/check-migration-numbers.mjs`: all ok.
- rag-db, foreground, both modes:
  - New and plan-named: `vector-sync-access-groups` (24/24), `vector-sync-triggers` and `vector-sync-tracer` (58 with the new file), `validate-chunks`.
  - Grants, search path and schema: `access-catalog-sentinel`, `schema-equality`, `definer-search-path-pglite`, `hybrid-grants`, `lexical-stats-grants`, `purge-grants`, `search-path-empty`, `search-rpc-grants-pglite`.
  - Callers of the sync reads and stores: `access-admin`, `access-resolution`, `vector-sync-purge-drain`, `vector-sync-cli`, `purge-seam`, `source-recheck-external`, `eval-external-backend`, `vector-sync-reconcile`.
  - Merge-touched: `eval-v2-overlay` (37/37).
  - Result: all pass.
- Mutation guard: with `access_groups` removed from the trigger column lists, the "group change" test fails in both modes; the file was restored.
- `npm run test-rag -- --out eval/out/07-38`: gate PASS, `passed == true`, `paired.all_zero == true`.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/07-38-ingest`: gate PASS.
- Test-split budget: no test-split use. `test-rag` does not touch the test split (the ledger is written only by `rag_eval.regression`), so the ledger stays at 26.
- Not run: the full tests/rag-db suite (the merge train runs it), full vitest (no shared core types, env.ts or test setup changed), Python, workflows, gen:schemas (no contract changed), UI checks (no UI).

## Decisions for STATE

- The vector-sync payload always carries `access_groups` once 0742 exists. The query side filters on it only while `RAG_DOC_ACCESS_GROUPS` is on (plan 07-39), so turning the switch on needs no re-sync.
- A group change syncs through the existing 0702 UPDATE trigger functions (A-7 kept). It does not use separate column-list triggers.
- A sync row or point without valid access keys is refused (fail closed), never defaulted to `all`.

## Operator actions

- Apply 0742 after 0705 and the Phase 4.3 block. If targets are enabled, the next drains re-sync every tenant once.
- After re-running 0702, re-run 0742.
- Live Qdrant and Weaviate checks (the index and property on a real collection) belong to the 07-33 live regression and need `QDRANT_URL` / `WEAVIATE_URL`.

## Deferred

- `ACCESS_KEY_RE` now exists in `src/lib/rag/tenant/access-brand.ts` (not exported) and in `src/lib/rag/sync/servable.ts`. A shared export could replace the copy (low).
- Reconcile checksums do not cover `access_groups` (D-05, as the plan decided). A relabel that misses the outbox is caught by 07-39's re-validation, not by reconcile (low, by design).
