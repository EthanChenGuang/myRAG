---
quick_id: 261127-dta
branch: exec/quick-doc-types-access
base: origin/ci/merge-train-39
status: complete
---

# Summary: access filter on rag_tenant_doc_types (0981)

`rag_tenant_doc_types(p_tenant_key)` (06.2-11, migration 0981) returned the doc types of every current, ready document of the tenant, so
the sub-question filter vocabulary (the `shared.subq-filters.v1` prompt addendum and `narrowFilters`) named doc types carried only by
documents outside the caller's access groups. Metadata only, but a leak once access groups are on. Fixed.

## Changes
- `supabase/migrations/0986_tenant_doc_types_access.sql` (new). Number checked against every origin branch (0982–0985 and 1010 taken;
  0986 the next free number after 0981), reserved and pushed first (commit 90ab7c4 "claim migration 0986").
  - Drops every overload of `rag_tenant_doc_types` by catalog lookup (the 0981 signature `(text)`), then creates exactly one:
    `(p_tenant_key text, p_access_keys text[] DEFAULT NULL, p_access_all boolean DEFAULT false)`.
  - Guard as 0933/1010, right after `rag_assert_tenant_key`: no keys while `rag_access_enforced()` → `access_scope_required` (42501);
    empty or NULL-holding key array → `access_keys_empty` (22023). With keys and not `p_access_all`, a document counts only when
    `documents.access_groups && p_access_keys`. No keys: the 0981 query and answer.
  - SECURITY INVOKER, STABLE (0981 was VOLATILE), `SET search_path = ''`, REVOKE PUBLIC/anon/authenticated, GRANT service_role.
  - Redefines `rag_access_readiness()` from its 0933 body with `rag_tenant_doc_types` added to the optional functions it checks.
    0986 is now the last definition of both functions.
- `supabase/migrations/0410_security_definer_rpc_grants.sql`: only one guarded (`to_regprocedure`) grant block appended for the new signature.
- `src/lib/rag/query/tenant-vocabulary.ts`: `loadTenantDocTypes` takes `options.access` (default `scopeAccessFilter(scope)`) and sends
  `...accessRpcArgs(access)` (off sends only `p_tenant_key`, so the request body is unchanged with the switch off). Cache key is the tenant
  key plus the access mode and, for keys, sha256 of the sorted key set; `resetTenantVocabularyCacheForTests(tenantKey)` drops every
  access variant of that tenant. An access-resolution error is a load failure: null, not cached, warning with a key hash only (fail closed).
- `src/lib/rag/query/run-layer.ts`: `QueryLayerInput.access` and `subqFilterContextFor({ access })`; the decompose stage passes `ctx.access`.
- `src/lib/rag/v2/stages/query.ts`: passes `ctx.access` to `runQueryLayer`.

## Migration application order and operator rule
After 0981 and the 0920 block (0920–0934): apply 0986, then re-run 0410 (idempotent). Whenever 0981 is re-run, re-run 0986 afterwards
(until then the old signature is a second overload and readiness reports `function_overloaded`, `function_missing_access_parameters`,
`function_missing_guard` for `rag_tenant_doc_types`; tested). Whenever 0933 is re-run, re-run 0986 (0933 restores the readiness body
without this function).

## Tests (RED first in 36f2b9d87; failures were assertions)
- `tests/rag-db/q62-tenant-doc-types.test.mts`: catalog and grant checks on the new signature; new access block per mode (one overload,
  0981 signature gone, STABLE; no keys = 0981; outsider keys hide a doc type only restricted documents carry and leave them out of counts;
  member keys and admin_all see it; 42501 / 22023 guards; tenant check first). The guard case's helper reset the role inside an aborted
  transaction (25P02); fixed in the fix commit.
- `tests/rag-db/access-readiness.test.mts`: `rag_tenant_doc_types` in PENDING-to-check; re-running 0981 without 0986 is reported.
- `tests/rag-db/access-catalog-sentinel.test.mts`: moved from EXEMPT (statistics) to FILTERED.
- `tests/rag-db/access-canary-matrix.test.mts`: new doc-type path per mode — loader with one shared cache (outsider and member-b never get
  the restricted doc type, member-a and admin do), `subqFilterContextFor` → `subqFilterAddendum` and `narrowFilters` for outsider vs member,
  and access switch off equals the 0981 answer. Verified to fail on trunk code ("the cached member-a doc types reached the outsider").
- `tests/rag/query/subq-filters.test.ts`: RPC args per access mode, `options.access` override, access-keyed cache, per-tenant reset.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: ok.
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`: ok.
- vitest: the 24 test files importing `query/tenant-vocabulary`, `query/run-layer` or `v2/stages/query`, plus `tests/rag/access`:
  41 files, 593 passed.
- `node --import tsx --test` on tests/rag-db access-* (except canary), *grants*, *search-path*, q62-*: 614 tests, 609 passed, 5 failed,
  all pre-existing (below). `access-canary-matrix.test.mts`: 144/144.
- Not run: `npm run test-rag` (no retrieval, ingest or golden change beyond the access arguments; the sub-question filter path runs only
  with the query layer on).

## Pre-existing failures (reproduced on origin/ci/merge-train-39 in a clean worktree)
- `access-catalog-sentinel` (2 cases × 2 modes): `rag_scope_centroids_rebuild` (0983, Phase 6.2 scope gate) is unclassified. Not classified
  here on purpose: the centroids are built from chunk embeddings, so whether restricted chunks shape the scope gate needs its own review.
- `q62-scope-separation` "the committed report is the tool output": fails identically on trunk; untouched by this change.

## Deviations
- None from the brief. No new env variables, no new store (no purge hook), no domain strings (enum doc types and synthetic keys only).
  rag-sidecar/eval uv environments not synced (no Python touched).

## Operator actions (evaluation project first; not run here)
1. Apply 0986, then re-run 0410.
2. `SELECT * FROM public.rag_access_readiness();` as service_role: expect ready, no reasons.
3. `SELECT oid::regprocedure FROM pg_proc WHERE proname = 'rag_tenant_doc_types';`: exactly `(text, text[], boolean)`.
4. Deploy the app code with the migration. Production only after the evaluation project passes.
