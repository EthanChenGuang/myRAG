---
quick_id: 261127-rih
slug: review-items-hardening
branch: exec/quick-review-items-hardening
base: origin/exec/quick-review-writers-access (c55b69071)
status: complete
migration: 0990
requirements: [SEC-13, FBK-05]
decisions: [D-25, A-06]
source: 05.1.1-VERIFICATION.md and 05.1.1-SECURITY.md on origin/verify/05.1.1 (ea26afd72), gaps G3, G5, G6, G8, G9
---

# Quick 261127-rih: review items hardening after the Phase 5.1.1 verification (0990)

## Migration number
- **0990** (`supabase/migrations/0990_review_items_hardening.sql`). All origin branches were fetched first. 0986 is used twice
  (this base's `0986_review_items_writers_access_sets`, and `0986_tenant_doc_types_access`), 0987 and 0989 are taken, 0988 is
  reserved for train-40's rename of `0986_review_items_writers_access_sets`. 0990 was reserved with a placeholder and pushed
  first (04e4d7f36). `0986_review_items_writers_access_sets.sql` was not edited or renamed.
- One common file, both modes. Idempotent, `SET search_path = ''`, service_role only, not folded into the setup files. 0410 got
  one guarded grant block (append only).

## Changes per gap
- **G5 (privacy, W2).** `rag_review_items_fill_owner()` is a BEFORE INSERT trigger on `rag_review_items`. When the writer left
  `user_id` / `chat_id` NULL, it copies them from the item's `rag_retrieval_log` row of the same tenant. A one-off UPDATE backfills
  existing items. So the user cascade (0534 FK) and `rag_feedback_loop_on_chat_delete` (0534) now remove sampled items. The log
  retention purge still keeps the item, because the snapshot is meant to outlive the log row. The trigger is SECURITY INVOKER and
  service_role only.
  - Deviation from the two suggested fixes: the brief suggested rebuilding the writer body or adding a BEFORE DELETE trigger. I used
    a BEFORE INSERT trigger instead, for two reasons:
    - A BEFORE DELETE trigger on the log would also fire on the retention purge and delete items whose snapshot must survive it.
    - A rebuilt body would come undone whenever 0967 or 0986 is re-run. The trigger covers every writer and survives those re-runs.
- **G6 (W1).** 0944 and 0950 now end with a guarded block: when the five-argument `rag_enqueue_review_item` (0984) exists, the
  four-argument one is dropped again. A re-run therefore leaves a single function, and a four-argument call no longer fails with
  42725. Both files stay idempotent.
  - Re-run order notes were added to the headers of 0944, 0950, 0967 and 0974: re-running them still restores older bodies, so
    re-run 0984 / 0986 / 0990 / 0410 after them. Under G8, the NULL rows those older bodies write fail closed while access is
    enforced.
- **G8 (T-0511-90).**
  - `rag_review_access_sets` is rebuilt from its 0984 body with one change: while `rag_access_enforced()`, a write with no given
    sets and no source documents returns `'[]'` instead of NULL. Every writer that goes through it (mining, enqueue, 0986's
    sampled and re-review writers) inherits this.
  - The restrictive policy `rag_review_items_access_sets` now reads `(access_sets IS NULL AND NOT rag_access_enforced()) OR
    rag_caller_reads_access_sets(tenant_key, coalesce(access_sets, '["g:00000000-…"]'))`. While access is enforced, a NULL row is
    visible only to those who administer the tenant. With access off, nothing changes.
- **G9.**
  - Label oracle (T-0511-91): `checkEvidence` in `src/lib/rag/feedback-loop/labels.ts` now answers `chunk_not_servable` for every
    chunk the caller cannot see (another tenant, unknown, non-UUID, not servable). Such a chunk is never compared with the quote.
    `chunk_not_in_tenant` and its extra tenant-existence query are gone, and the Config UI mapping was updated.
  - CI catalog guard (T-0511-92): `tests/rag-db/review-items-hardening.test.mts` scans `pg_proc` after all migrations, in both
    modes. Every INSERT INTO `rag_review_items` must list `access_sets`. `rag_red_team_open_cases` (0741) is allow-listed, with
    this reason: its synthetic red-team cases have no document or log source, and under 0990 their NULL rows fail closed while
    access is enforced.
- **G3.** `tests/rag/feedback-loop/routes-log-two-tenant.test.ts`: the beforeAll hook timeout is now `180_000`. I found no such
  edit to this file on trains 38, 39 or 40, so I used train-38's `}, 180_000);` pattern from `tests/rag/access/access-service.test.ts`.
- Not done here: G7 (live access check in `fetchServableChunks` / `checkEvidence`), which belongs to `exec/quick-access-derived-stores`.
  Once G7 makes `fetchServableChunks` access-aware, access-restricted chunks also get the single `chunk_not_servable` reason.

## Behaviour changes
- Sampled review items now carry `user_id` / `chat_id`. Deleting that user or chat deletes them.
- While access groups are enforced:
  - Sourceless new items store `'[]'`, and every expert of the tenant sees them.
  - Items with NULL `access_sets` (written while access was off, or by an older body after an out-of-order re-run) are hidden from
    experts who do not administer the tenant.
- With access off, nothing changes.
- A label citing an invisible chunk answers `invalid_evidence` / `chunk_not_servable` (previously `chunk_not_in_tenant` for other
  tenants and unknown ids).

## TDD (tests that failed before the fix)
- RED f2f6dcadd, `review-items-hardening.test.mts`: 20 of 24 failed on assertions in both modes. The failures were G5 (no owner
  copy, items survive chat and user delete, no backfill), G6 (2 overloads after re-run), G8 (NULL visible, no `'[]'`), G9 catalog
  (`rag_mine_failed_queries` / `rag_enqueue_review_item` after re-run, and the 0741 writer), and grants (function missing).
  GREEN 4ac6db0d3: 24/24.
- RED c42d26de9, `labels.test.ts` and `review-label-search.test.ts`: 2 failed on assertions (`chunk_not_in_tenant` was answered).
  GREEN 2b809baed.
- Expectation updates in e4c1915ad:
  - `review-writers-access-sets` "row without any source" now expects `'[]'` while enforced.
  - `review-items-rls` "0534 idempotent" no longer counts the 0990 trigger.

## Commits
04e4d7f36 reserve 0990 · f2f6dcadd RED SQL · 4ac6db0d3 GREEN 0990 + 0944/0950/0967/0974 headers + 0410 · c42d26de9 RED label
oracle · 2b809baed GREEN labels.ts + Config UI mapping · e283b3502 G3 timeout · e4c1915ad test expectation updates · SUMMARY (this commit)

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm run typecheck:new`: no errors.
- `node scripts/ci/check-rag-boundary.mjs`, `scripts/check-config.mjs`, `scripts/ci/check-language-literals.mjs`,
  `scripts/ci/check-settings-classification.mjs`: all exit 0.
- tests/rag-db, both modes (each file runs single- and multi-tenant): review-enqueue, review-item-strata, review-items-access-sets,
  review-items-hardening, review-items-mining, review-items-rls, review-writers-access-sets, retrieval-log-purge,
  retrieval-log-schema, retrieval-log-source-opened, mining-end-to-end, calc-review-reasons, hybrid-grants, lexical-stats-grants,
  search-rpc-grants-pglite, definer-search-path-pglite, search-path-empty, schema-equality, access-catalog-sentinel.
  - All pass after the expectation updates, except `access-catalog-sentinel`.
  - `access-catalog-sentinel` is **pre-existing**: it fails identically on the base c55b69071, because `rag_scope_centroids_rebuild`
    is unclassified (Phase 6.2, unrelated).
  - `mining-end-to-end` failed once in the concurrent run (`invalid_mining_config`, load). Alone it passes 3/3; it also passes on base.
- vitest: labels, review-label-search, label-category-rules, review-labelling-panel, review-labelling-phase53, review-admin-panel,
  routes-log-two-tenant, review-items-two-tenant: 8 files, 132/132 pass.

## Operator actions
- Apply 0990, then 0410, after 0984 and 0986 (whatever number train-40 gives 0986, which becomes 0988).
- Re-run 0990 and 0410 after any later re-run of 0934, 0984 or 0986.
- After turning access enforcement on, items with NULL `access_sets` stay admin-only until they are recomputed. To recompute them,
  re-run 0984 → 0986 → 0990 → 0410 while access is enforced.
