---
phase: 07-external-backends-release-defaults
plan: 10
subsystem: rag-embeddings
tags: [activation-gate, embedding-profiles, external-backends, qdrant, weaviate, security]
requires:
  - phase: 07-external-backends-release-defaults
    provides: "rag_vector_sync_targets and rag_backend_index_state (07-02, 0701); 07-07 and 07-08 PGlite seeding finished before 0706 exists"
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "rag_activate_embedding_profile gate (03-09, 03-21, 03-40); profile-ops refusal mapping (03-21)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "the 0425 body of rag_activate_embedding_profile (04-33, last editor)"
provides:
  - "supabase/migrations/0706_activation_gate_external.sql: rag_activate_embedding_profile with the external index-ready condition"
  - "src/lib/rag/embeddings/profile-ops.ts: external_not_ready:<backend> -> { reason, code: 'external_not_ready', backend, detail }; ExternalBackend type"
affects: [07-11, 07-12, 07-16]
actuals:
  tokens: 45000
  tasks: 2 of 2
  commits: 5
tech-stack:
  added: []
  patterns:
    - "Gate extension by CREATE OR REPLACE of the latest body copied verbatim, new condition appended after every older refusal"
key-files:
  created:
    - supabase/migrations/0706_activation_gate_external.sql
    - tests/rag-db/activation-gate-external.test.mts
    - tests/rag/embeddings/profile-ops-external.test.ts
  modified:
    - src/lib/rag/embeddings/profile-ops.ts
key-decisions:
  - "0706 copies the 0425 body verbatim (signature, SECURITY DEFINER, search_path '', statement_timeout 120s) and adds the check after every Phase 3 refusal, just before the pointer flip; REVOKE/GRANT re-stated (service_role only), NOTIFY pgrst"
  - "Tenants that must be ready = DISTINCT tenant_key of current ready document_chunks (the same set the incomplete check counts); NULL tenant keys are excluded because no tenant-scoped retrieval can return them"
  - "Only state 'ready' for the exact (target, profile, tenant) counts; building, stale, failed, or ready for another profile/target do not"
  - "Enabled targets checked in fixed order qdrant, weaviate; the first not-ready one is named. Message: external_not_ready:<target> (<n> tenants ... profile <id>), ERRCODE 55000; it carries a tenant count, never tenant keys"
  - "Rollback is not gated (rag_rollback_embedding_profile untouched)"
  - "profile-ops: reason carries the backend (external_not_ready:<backend>), so the admin route (409 with reason) and the CLI (refused(result)) show the backend with no new code path; code and backend are optional fields present only on this refusal; an unknown backend name is not a named refusal and throws ProfileUnavailableError (fail closed)"
requirements-completed: [RET-05, RET-09]
---

# Phase 7 Plan 10: Activation gate for external backends Summary

An embedding profile can no longer become active while an enabled external backend (Qdrant or Weaviate) lacks a ready index for it on any tenant with current documents. The refusal names the backend.

## Baseline (count gates measured at plan start, HEAD 16f7af04)

| Gate | Before edit | After |
|------|-------------|-------|
| `grep -c external_not_ready supabase/migrations/0706_activation_gate_external.sql` | error (no file) | 2 |
| `--test-name-pattern="not ready"` on the new test | error (no file) | 11 passed, 0 failed |
| `grep -c external_not_ready src/lib/rag/embeddings/profile-ops.ts` | 0 | 3 |

No gate passed before the edits.

## Tasks and commits

- Task 1 (0706, D-06)
  - `c2696dd7` test (RED): 10 of 22 failed on assertions (activation accepted where it must refuse)
  - `9ba91f2d` feat: migration 0706
- Task 2 (profile-ops, D-06)
  - `d047080b` test (RED): 2 of 4 failed on assertions (refusal not mapped)
  - `3e8e11ac` feat: mapping

## Behaviour changes

- With any target enabled in `rag_vector_sync_targets`, activation needs a `ready` row in `rag_backend_index_state` for every (enabled target, target profile, tenant with current ready chunks); otherwise it raises `external_not_ready:<target>` and changes nothing.
- With both targets disabled (the seeded default) activation is exactly the 0425 gate. Every Phase 3 refusal still wins when it applies (incomplete, model_mismatch, eval_*, unknown_profile, already_active).
- Rollback is never blocked by external readiness.
- No env variable, switch or Config UI change.

## Tests that failed before the fix

- `tests/rag-db/activation-gate-external.test.mts`: not-ready with no state; building/stale/failed/other-profile states; one of two tenants ready (both orders; this catches the "checking only the first tenant" mutation); weaviate named once qdrant is ready; qdrant named first.
- `tests/rag/embeddings/profile-ops-external.test.ts`: external_not_ready:weaviate and :qdrant mapped to the named refusal.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/rag/embedding-profile-routes.test.ts tests/rag/embeddings tests/ui/config-rag-panel-binding.test.ts tests/ui/config-rag-panels.test.ts`: 15 files, 315 tests passed
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all ok
- `node --import tsx --test tests/rag-db/activation-gate-external.test.mts`: 22 passed (both modes)
- `node --import tsx --test tests/rag-db/activation-gate.test.mts tests/rag-db/activation-evidence.test.mts tests/rag-db/embedding-cli.test.mts tests/rag-db/definer-search-path-pglite.test.mts tests/rag-db/search-path-empty.test.mts tests/rag-db/search-rpc-grants-pglite.test.mts tests/rag-db/schema-migrations.test.mts`: 105 passed
- Not run (my change doesn't touch these areas): the test-rag runs, gen:schemas, Python, workflows, the UI design check. I also didn't run the CLI test files under tests/rag-db that only drive finetune, bindings or chunking.

## Deviations

- The plan describes the refusal as `{ code: 'external_not_ready', backend }`. The existing `ProfileRefusal` shape is `{ ok, reason, detail }`, so the refusal keeps that shape: `reason` is `external_not_ready:<backend>` and the new optional fields `code` and `backend` are added. Because the reason carries the backend name, the admin route and CLI show it without a new code path.
- The two-tenant cases run only in multi-tenant mode: single-tenant has the single key `s:default`. The second tenant is made by moving one document's chunks; `documents.tenant_key` is a generated column and can't be updated directly.
- Migration number 0706 was free on every origin branch, so I took it as planned.

## Operator pending

- None. Live backends are not involved; readiness rows come from the 07-11 reconcile.

## Deferred

- None.
