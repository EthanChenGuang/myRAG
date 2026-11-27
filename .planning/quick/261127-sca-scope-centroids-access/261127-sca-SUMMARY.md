---
quick_id: 261127-sca
status: complete
branch: exec/quick-scope-access
base: origin/ci/merge-train-39
---

# Summary: scope centroids honour access groups (0987, Phase 6.2 verification R-4)

Risk: `rag_scope_centroids_rebuild` (0983) averaged every current, ready chunk of the tenant, access labels ignored. With access groups
and `RAG_SCOPE_GATE` both on, a restricted document moved the tenant, doc-type and scope-tag centroids and created its own group keys
(`<doc_type>/<lang>`, `<dimension>:<value>/<lang>`). A member outside the group could read the in/out result as a 1-bit oracle for
whether a restricted document on a topic exists, and the group keys and member counts (`rag_scope_status`, `rag_scope_centroids_list`)
could reveal its doc type and scope tags. Closed.

## Choice: the recommended fix (filter at build time)
While `rag_access_enforced()` is true, the rebuild counts a chunk only when both the chunk's and the document's `access_groups` are
`{all}` (both columns checked, as D-12 does for retrieval). The filter was feasible: the rebuild is one SQL statement over
`document_chunks` joined to `documents`, both carry `access_groups` (0921), and the gate already treats a missing group as unsure. So
centroids, group keys and counts never contain restricted content and the gate keeps working for open content. The fallback (gate off and
`unsure` whenever access is enforced) was not needed; it would have turned the gate off for every access-enabled deployment.

With enforcement off the rebuild is exactly as before, including documents that already carry a group label (access off means every
document is visible to every member).

Negative examples: they are admin-entered texts (`rag_scope_example_add`), not derived from any document, so there is nothing to filter;
they are unchanged.

## What changed
- `supabase/migrations/0987_scope_centroids_access.sql` (common to both modes, idempotent, bodies rebased on 0983, `SET search_path = ''`,
  schema-qualified names, revoked from PUBLIC/anon/authenticated, granted to service_role):
  - `rag_scope_centroids_rebuild`: reads `rag_access_enforced()` after taking the tenant's exclusive advisory lock and adds the `{all}`
    predicate on chunk and document while enforced. Still SECURITY INVOKER; returns counts only.
  - `rag_scope_centroids_on_documents_update` / `_on_chunks_update`: also invalidate on `access_groups` changes (a relabel otherwise
    left a stale centroid that included or omitted the document).
  - New `rag_scope_centroids_on_access_settings_change()` (SECURITY DEFINER trigger, like the 0983 trigger functions) with three statement
    triggers on `rag_access_group_settings` (update with old/new transition tables; insert; delete). It clears the centroids of every tenant
    (keys from `rag_scope_centroids` and `documents`) through `rag_scope_centroids_invalidate` when `enforced` really changes: an update that
    flips it, or an inserted/deleted row with `enforced = true`. Centroids built while access was off therefore never serve once it is on.
    A re-run of 0920's `INSERT ... ON CONFLICT DO NOTHING` (no rows) or a write that leaves `enforced` alone clears nothing.
  - Concurrency: the settings trigger takes each tenant's shared lock and the rebuild takes the exclusive lock before reading the flag, so
    a rebuild that overlaps a flip either sees the new flag or is cleared by it (the 0983 P-27 rule).
- `0410_security_definer_rpc_grants.sql`: one guarded REVOKE/GRANT block **appended** for the new trigger function; nothing else touched.
- `tests/rag-db/access-catalog-sentinel.test.mts`: the EXEMPT reason of `rag_scope_centroids_rebuild` now states what it does: it returns
  group and chunk counts only and, while access is enforced, averages only `{all}` chunks. It stays EXEMPT, not FILTERED: FILTERED means
  a per-caller function with `p_access_keys`/`p_access_all` that raises `access_scope_required` without keys, and the rebuild is a
  tenant-level job with no caller identity; restricted content is excluded for every caller instead.

## Migration number
Fetched every origin branch: 0980-0985 used, 0986 used twice (`0986_review_items_writers_access_sets`, `0986_tenant_doc_types_access`;
the review-writers branch will renumber). Took **0987**, committed and pushed it first (e75accd34) as a reservation. No file on any origin
branch redefines these functions after 0987.

## Apply order
After 0920-0926 and 0983: apply `0987_scope_centroids_access.sql`, then re-run `0410` (idempotent). After re-running 0983, re-run 0987.
Existing centroid rows built before 0987 may include restricted documents: on a database where access is already enforced, run the scope
centroid rebuild once after applying (operator action; with enforcement off nothing is needed, a later flip clears them).

## Tests (TDD)
- `tests/rag-db/q62-scope-centroids-access.test.mts` (PGlite, single- and multi-tenant, 6 tests per mode). RED commit 5bf57ec7f: 8 of 10
  failed on assertions (restricted doc type/tag leaked as group keys, tenant member count 3 instead of 2, rebuild source lacked
  `access_groups`, no invalidation on flip or relabel); the off-state test passed, as intended.
  - enforced: centroids with a restricted document present equal the centroids without it (rows deep-equal), no restricted group key.
  - access off: unchanged; labelled documents still count.
  - flipping `enforced` on clears centroids; an `updated_at`-only write does not.
  - relabelling a document clears the tenant's centroids.
  - re-applying every migration under enforcement keeps the centroids and the exclusion.
- A first GREEN version used a plain `AFTER INSERT OR DELETE` trigger; `q62-scope-gate-schema` "applying every migration a second time"
  caught that the 0920 re-run cleared the centroids. Fixed with transition tables (b8769bb83).

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no errors
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`,
  `node scripts/ci/check-settings-classification.mjs`: pass
- `node --import tsx --test tests/rag-db/access-*.test.mts tests/rag-db/q62-scope-*.test.mts tests/rag-db/*grants*.test.mts
  tests/rag-db/*search-path*.test.mts`: 626/626 pass
- `npx vitest run tests/rag/scope`: 6 files, 110 tests pass
- No TS changed, so no other vitest files import a changed module.

## Commits
- e75accd34 chore: reserve migration 0987
- 5bf57ec7f test: RED restricted documents must not enter scope centroids
- 68573913b fix: build scope centroids from unrestricted documents only while access is enforced (0987, 0410, sentinel)
- b8769bb83 fix: clear centroids only on a real enforcement change; idempotency test
- (this SUMMARY)

## Deviations / deferred
- None from the requested approach. No env switch added (the filter follows `rag_access_enforced()`, no off switch, per AGENTS.md).
- Operator: one centroid rebuild per tenant after applying 0987 where access is already enforced.
