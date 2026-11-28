---
phase: 07-external-backends-release-defaults
plan: 39
subsystem: rag-backend
tags: [access-groups, qdrant, weaviate, sec-12, ret-06, ret-07, ret-08, canary]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-38 access_groups payload, store indexes and rag_validate_chunks_for_groups (0742); 07-03 scoped-request; 07-07/07-08 adapters; 07-37 external.ts; 07-14/07-28/07-34/07-44 canary factory, seed, drivers"
  - phase: 04.3-document-access-groups
    provides: "scopeAccessFilter (A-14 seam 1), BackendSearchRequest.access, BackendCapabilities.accessFilter, runAccessConformance (04.3-16), resolveAccessScope"
provides:
  - "qdrantScopedRequest / qdrantScopedBatch / assertScoped take `{ accessGroups }`: access_groups match-any in the top filter and every prefetch, asserted; absent = byte-identical request"
  - "Weaviate legs (nearVector and bm25) add access_groups containsAny inside the tenant handle in mode keys (withAccessGroups)"
  - "revalidateChunks: rag_validate_chunks_for_groups(keys) in mode keys; plain rag_validate_chunks in modes off and admin_all"
  - "assertExternalAccess in external.ts: req.access must equal scopeAccessFilter(req.scope), else access_filter_mismatch before any store call"
  - "Qdrant and Weaviate backends declare capabilities.accessFilter: true"
  - "tests/rag/canary/access-groups.test.ts: three-backend access canary with the missing-field negative control"
affects: [07-16 backend-canary job picks up the new canary file]

actuals:
  tokens: 85000
  tasks: 3
  commits: 5  # merge, RED, GREEN (tasks 1+2), canary, SUMMARY

key-files:
  created:
    - tests/rag/backend/access-group-filter.test.ts
    - tests/rag/canary/access-groups.test.ts
  modified:
    - src/lib/rag/backend/qdrant/scoped-request.ts
    - src/lib/rag/backend/qdrant/adapter.ts
    - src/lib/rag/backend/weaviate/adapter.ts
    - src/lib/rag/backend/revalidate.ts
    - src/lib/rag/backend/external.ts
    - src/lib/rag/sync/stores/types.ts
    - tests/rag/backend/qdrant-fake-client.ts
    - tests/rag/backend/weaviate-fake.ts
    - tests/rag/canary/entry-points.ts

requirements: [SEC-12, RET-06, RET-07, RET-08]
---

# 07-39 SUMMARY: Qdrant and Weaviate filter by the caller's access groups

With `RAG_DOC_ACCESS_GROUPS` on, both external backends now filter by the caller's access keys inside the store. Supabase then re-checks every hit against the same keys. A canary proves this on pgvector, Weaviate and Qdrant across chat, voice and embed. With the switch off, every store request and re-validation call is the same as before.

## Branch and merge

- `exec/07-39` was created from `origin/exec/07-38` (95bd2d67).
- `origin/exec/07-44` (cbc7317a) was merged with `--no-ff`, as the orchestrator authorized. There were no conflicts.
- Preconditions held:
  - Every SUMMARY in depends_on exists on the branch.
  - The 05, 05.1 and 06 verifications are `human_needed`.
  - Phase 4.3 has no VERIFICATION file. The alternative condition holds: `RAG_DOC_ACCESS_GROUPS` is in `src/lib/env.ts`, and `TenantScope.access` is read through `scopeAccessFilter`.

## Commits

| Task | Commit | What |
|------|--------|------|
| setup | merge of exec/07-44 | dependency merge |
| 1+2 RED | 036bc6c8 | access-group-filter test. Both fakes match array payloads per element, as the servers do |
| 1+2 GREEN | 4af7babd | scoped-request option, both adapters, group-aware re-validation, access assertion, capabilities |
| 3 | 49c20edc | three-backend access canary, plus a `resolvedRequest` driver export in entry-points.ts |

Tasks 1 and 2 share one test file. They were written RED together: 22 assertion failures, none of them module-not-found. They went GREEN in one commit.

## Behaviour

- **Qdrant (D-08 extended):** `qdrantScopedRequest`, `qdrantScopedBatch` and `assertScoped` take an optional `{ accessGroups }`.
  - When given, `{ key: 'access_groups', match: { any: keys } }` goes next to the tenant clause in the top filter and in every prefetch at every depth. The IDF corpus stays tenant-wide.
  - The assertion throws if any of those filters lacks the exact clause with the same key set.
  - An empty or malformed key list throws (fail closed).
  - A caller-built `access_groups` condition is rejected, as caller-built `tenant_key` conditions already were.
  - Without the option, the serialized request is byte-identical.
  - The adapter passes the keys only in mode keys.
- **Weaviate:** in mode keys, `withAccessGroups` ANDs `access_groups containsAny(keys)` into the native filters of both legs, on the tenant handle. Modes off and admin_all leave the filter unchanged.
- **Re-validation:** in mode keys, `revalidateChunks` calls `rag_validate_chunks_for_groups` with exactly the scope's keys. Modes off and admin_all (and no filter) call plain `rag_validate_chunks` with today's three arguments. A keys filter without keys throws before any call.
- **Where access comes from:** each adapter's `search` calls `assertExternalAccess`. It requires `req.access` to equal `scopeAccessFilter(req.scope)` (mode and set hash), so a group claimed anywhere other than the server-resolved scope is refused with `access_filter_mismatch` before any store call. `createExternalBackend` forwards `access` to the store only in mode keys, so `StoreSearchRequest.access` is optional and absent otherwise.
- **Capabilities:** both backends declare `capabilities: { accessFilter: true }`. The 04.3-07 startup check therefore no longer marks retrieval not ready when one of them is the configured backend.
- Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed chat are unchanged with the switch off. `test-rag` paired differences are all zero in both fixture modes.

## Tests that failed before the fix

- `tests/rag/backend/access-group-filter.test.ts`: 22 cases failed at 036bc6c8. They cover the clause in every prefetch, the assertion, the batch builder, key validation, the group-aware re-validation call, `accessFilter`, both adapters end to end, the request-access mismatch, the Weaviate legs, and the outsider cases of `runAccessConformance` for qdrant and weaviate.
- Guard mutations:
  - Injecting the clause into the top level only: the "every prefetch" cases fail (2).
  - The Weaviate bm25 leg without the access filter: "weaviate both legs" fails.
  - Plain `rag_validate_chunks` with the switch on: the canary negative control fails on both external backends (2).
  - All three mutations were reverted.

## Deviations

1. **`accessFilter` location:** the plan says "declare `accessFilter: true` on the RetrievalBackend". The Phase 4.3 contract puts that flag on `RetrievalBackend.capabilities` (`BackendCapabilities.accessFilter`, read by `access-startup.ts`), so both adapters set `capabilities: { accessFilter: true }`. The acceptance grep `accessFilter: true` still matches in both adapter files.
2. **Assertion helper:** both adapters call one shared `assertExternalAccess` in external.ts, which lazy-imports `scopeAccessFilter` as pgvector does. They do not each repeat it. The qdrant adapter names `scopeAccessFilter` at the call site.
3. **Files outside `files_modified`:**
   - `src/lib/rag/sync/stores/types.ts`: optional `access` on `StoreSearchRequest`.
   - The two test fakes: array semantics for `match.any`, `match.value` and `ContainsAny`, which the real servers already have.
   - `tests/rag/canary/entry-points.ts`: a `resolvedRequest` export, so the canary can attach access the way the routes do and then run through the existing seam.
4. **Bm25 mutation and conformance:** the plan names "ignoring req.access in the Weaviate bm25 leg" as the guard for `-t "access conformance"`. Under that mutation the conformance cases still pass, because layer 2 drops the leaked row. The mutation is caught by `-t "weaviate both legs"` instead, which inspects both legs' filters.
5. **Canary scope:** the canary runs in multi-tenant mode. Group-restricted documents live in tenant O, and tenant B is the cross-tenant caller. The negative control relabels the restricted document (`g:<GA>` plus G's own key, still restricted) and drains it through a write client that drops `access_groups`. That plants a point under the restricted chunk's id with the write key.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- vitest:
  - `tests/rag/backend`, `tests/rag/backend-conformance`, `tests/rag/sync`, `tests/rag/canary` and `tests/rag/admin/index-compat.test.ts` (every importer of a changed module, found with git grep): 547 passed / 139 skipped.
  - After Task 3: `tests/rag/canary` and `tests/rag/backend` gave 368 passed / 150 skipped.
- Live backends: Docker was available, and the compose services `docker-compose.backends.yml` (Qdrant 1.20.2, Weaviate 1.40.7) were started locally.
  - `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant npx vitest run tests/rag/canary/access-groups.test.ts`: 14 passed, 0 failed. That is 10 external cases (5 Weaviate, 5 Qdrant), plus 4 on pgvector. The one skip is the external-only negative control on pgvector.
  - `tests/rag/backend-conformance` live: 104/104 passed once the compose placeholder Weaviate keys were exported. Without them the Weaviate factory gets a 401: an environment-only issue, since CI sets the keys.
  - `tests/rag/canary/foreign-point.test.ts` live: 8/8.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`, `node scripts/ci/check-migration-numbers.mjs`: all ok.
- rag-db (code calling `rag_validate_chunks_for_groups`), foreground, both modes inside each file: `vector-sync-access-groups`, `validate-chunks`, `eval-external-backend`, `source-recheck-external`, `hybrid-grants`, `search-path-empty`, `definer-search-path-pglite`, `search-rpc-grants-pglite`, `schema-equality`. Result: 162 tests, 159 pass, 0 fail, 3 skipped.
- `npm run test-rag -- --out eval/out/07-39`: PASS, `passed == true`, `paired.all_zero == true`.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/07-39-ingest`: PASS, `passed == true`, `paired.all_zero == true`.
- No migration, no new env variable, no package change. The test-split ledger is untouched.

## Decisions for STATE

- External backends follow Phase 4.3's `RAG_DOC_ACCESS_GROUPS`; there is no Phase 7 switch.
- Defence in depth mirrors the tenant layers: a store filter (layer 1), then `rag_validate_chunks_for_groups` (layer 2). admin_all never calls the group-aware function.
- The Qdrant IDF corpus stays tenant-wide under an access filter, matching pgvector's per-tenant BM25 statistics.

## Operator actions

None. The backend-canary CI job (07-16) picks up `tests/rag/canary/access-groups.test.ts` through its `tests/rag/canary` path.

## Deferred

- Under an access filter, a Qdrant point that lacks `access_groups` (an app newer than its data) is invisible even to members until it is re-synced. This fails closed, and 07-38's one-time tenant re-sync covers it. A reconcile drift check for points missing the field could make it visible sooner (low).
- `backendForRequest` does not route on `accessFilter`, because every backend now declares it. If a future backend omits it, the 04.3-07 startup check is the only guard (low).
