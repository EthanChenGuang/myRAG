---
quick_id: 261127-acc
branch: exec/quick-attribute-access
base: origin/exec/04.3-51 (92aee9bb5)
status: complete
---

# Summary: access filter on the 1008 attribute resolver

`rag_attribute_filter_values` and `rag_attribute_documents` (1008) had no access parameters, so `rag_access_readiness()` was not ready
and `RAG_DOC_ACCESS_GROUPS=on` could not pass startup; an outsider could also read the attribute values and document ids of restricted
documents. Fixed; readiness is now `ready` on the migrated catalog in both modes and the canary matrix no longer filters any object.

## Changes
- `supabase/migrations/1010_attribute_resolver_access.sql` (new; number checked against every origin branch, highest used was 1009, reserved and pushed first in a183f843f). Both functions are the 1008 bodies plus `p_access_keys text[] DEFAULT NULL, p_access_all boolean DEFAULT false`, with the 0930/0933 guard right after `rag_assert_tenant_key` (`access_scope_required` 42501 when no keys while `rag_access_enforced()`; `access_keys_empty` 22023 for an empty or NULL-holding array) and the predicate `d.access_groups && p_access_keys` unless `p_access_all`. Without keys: the 1008 answer. SECURITY INVOKER, STABLE, `SET search_path TO ''`, REVOKE from PUBLIC/anon/authenticated, GRANT service_role. One file for both modes (tenant mode via `rag_assert_tenant_key`); idempotent.
- `supabase/migrations/0410_security_definer_rpc_grants.sql`: appended only two guarded (`to_regprocedure`) grant blocks for the new signatures.
- `src/lib/rag/retrieval/attributes.ts`: new `AttributeOptions.access` (default `scopeAccessFilter(scope)`); both RPCs get `...accessRpcArgs(access)` (off sends nothing, so request bodies are unchanged with the switch off). The lexicon cache key is now tenant key + access mode + sha256 of the sorted key set, so one caller's lexicon never serves another key set; `invalidateAttributeLexicon(tenantKey)` drops every access variant of that tenant.
- `src/lib/rag/v2/stages/query.ts`: `runAttributeResolveStage` takes `access` and the pipeline passes `ctx.access ?? scopeAccessFilter(scope)`.

## Migration application order
After the 0920 block (0920–0934) and 1001–1009: apply `1010_attribute_resolver_access.sql`, then re-run `0410_security_definer_rpc_grants.sql` (idempotent). Rule: whenever 1008 is re-run, re-run 1010 afterwards; until then the old signatures come back as second overloads and `rag_access_readiness()` reports `function_overloaded` / `function_missing_access_parameters` / `function_missing_guard` (tested).

## DROP section
1010 drops every overload of `rag_attribute_filter_values` and `rag_attribute_documents` by catalog lookup (`pg_proc` in `public`), which removes the 1008 signatures `(text, integer)` and `(text, jsonb, integer)`, then creates exactly one of each. PostgREST callers that pass only the old named arguments keep working through the defaults.

## Operator actions (evaluation project fsgaeysipkukqoocgzbx only first; not run here)
1. On the evaluation project: apply 1010, then re-run 0410.
2. `SELECT * FROM public.rag_access_readiness();` as service_role: expect `ready = true`, empty `reasons`/`objects`.
3. Check one overload each: `SELECT oid::regprocedure FROM pg_proc WHERE proname IN ('rag_attribute_filter_values','rag_attribute_documents');`
4. Deploy app code from this branch together with the migration (the app sends `p_access_*` only while access groups are on). Production (ppvywaxrycaxrtrrditl) only after the evaluation project passes; not touched in this task.

## Tests (RED first, 8b332c211; failures were assertions: missing function signature, readiness `not_ready`, access startup `not_ready`, missing RPC args)
- `tests/rag-db/attribute-filter.test.mts`: new access-filter block per mode (one overload, old signatures gone; no keys = 1008; outsider sees no restricted value/id; member and admin_all see them; unknown_attribute unchanged; guard and empty-keys errors); catalog test uses the new signatures and checks that re-applying 1010, and 1008 then 1010, leaves the schema unchanged.
- `tests/rag-db/access-readiness.test.mts`: migrated catalog is `{ready:true, reasons:[], objects:[]}`; re-running 1008 without 1010 is reported.
- `tests/rag-db/access-catalog-sentinel.test.mts`: both functions moved to FILTERED; PENDING empty.
- `tests/rag-db/access-canary-matrix.test.mts`: the readiness filter (`withoutPendingReadiness`, `PENDING_1008`) removed, the seed asserts readiness is ready; new attribute path cases (value lexicon per identity with a shared cache, explicit filter per language through `resolveAttributeFilter` and strict v2 retrieval, automatic match per language with stage counts).
- `tests/rag/retrieval/attributes.test.ts`: RPC args per access mode, `options.access` override, access-keyed cache and invalidation.
- `tests/rag/v2/attribute-resolve-stage.test.ts`: the stage passes the request access filter.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: ok.
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`: ok.
- vitest: the 12 files importing the changed modules + `tests/rag/access`: 27 files, 412 passed; `tests/rag/v2`, `search-rpc-grants`, `instrumentation`: 47 files, 713 passed.
- `node --import tsx --test` on tests/rag-db access-* (except canary), *grants*, *search-path*, attribute*, document-attributes, phase33-*, fixture-phase33-features: 670/670 passed; `access-canary-matrix.test.mts`: 138/138 passed.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-attribute-access-ingest`: exit 0, gate PASS, absolute gate PASS.
- `npm run test-rag -- --out eval/out/quick-attribute-access`: exit 0, gate PASS; absolute gate reports `false_refusal_rate language:en 0.3143 > 0.25` in report-only mode. Not caused by this change: that run has `RAG_ATTRIBUTE_FILTER` off and access groups off, so no attribute RPC runs and every other RPC body is unchanged.

## Deviations
- None from the brief. The dependency installs for `rag-sidecar`/`eval` uv environments were not re-run (already present; the eval gate ran through uv).
- No new env variables, no new store (no purge hook needed), no domain strings (synthetic `quorvel*` markers and neutral keys only).
