---
quick_id: 261127-rwa
slug: review-writers-access
branch: exec/quick-review-writers-access
base: origin/ci/merge-train-39
status: complete
migration: 0986
requirements: [SEC-13]
decisions: [D-25, A-06]
---

# Quick 261127-rwa: the Phase 5.3 review writers carry access_sets (0986)

## Problem
0984 fixed `rag_mine_failed_queries` and `rag_enqueue_review_item`, but `rag_review_items_enqueue` (0967) and
`rag_review_items_enqueue_re_review` (0974) still wrote `rag_review_items.access_sets` as NULL. 0934's restrictive policy
`rag_review_items_access_sets` treats NULL as readable, so every expert of the tenant could read the masked query of a
representative, pilot, drift-fill, historical or re-review item, even one that came from a document outside their access groups.

## Change
- Migration number: 0986 (next free after 0984; 0982–0985 and 1010 were taken on origin). It was reserved and pushed first (4aa52236b).
- `supabase/migrations/0986_review_items_writers_access_sets.sql` (one common file for both modes, idempotent, not folded):
  - `rag_review_items_enqueue(text, text, jsonb)`: for each row, the access sets are the caller's `access_sets` merged with
    the row's sources, through `rag_review_access_sets()` (0984). The sources are the row's `document_ids` and, for its
    `retrieval_log_id`, the log row's `access_sets` (only while `rag_access_enforced()`) plus the documents among the log's
    candidates. The rebuild runs only when 0967's tables exist.
  - `rag_review_items_enqueue_re_review(text, jsonb)`: rows may carry `access_sets`, `document_ids` and golden `item_ids`. The
    documents of the `item_ids` are read from the tenant's `rag_golden_evidence_index` (only if that table exists). The rebuild runs
    only when 0974 already created the function.
  - Validation: the caller's sets are checked strictly (22023 `invalid_access_sets`). Malformed `document_ids` or `item_ids` raise
    22023 `invalid_row`. A document outside `p_tenant_key` raises 22023 `document_not_in_tenant`. Each call is one statement, so a
    refusal writes nothing.
  - Backfill: while access is enforced at apply time, items with `access_sets` NULL that have a log row of the same tenant get sets
    from that log row.
  - Both functions keep SECURITY INVOKER, `SET search_path = ''`, schema-qualified names and service_role only. Signatures are
    unchanged.
- `supabase/migrations/0410_security_definer_rpc_grants.sql`: I appended two guarded (`to_regprocedure`) REVOKE/GRANT entries at
  the end of the service_role block. No other existing migration was edited.
- TS: `enqueueReReview` (`src/lib/rag/monitor/golden-evidence.ts`) now accepts `{ question, itemId }`. It sends `item_ids` and
  merges the ids of duplicate questions, at most 50 per row. The route `src/app/api/rag/admin/golden/re-review/route.ts` passes each
  `item_id`.
  - `sample.ts` sends `retrieval_log_id`, and the SQL derives the sets from that log row. I did not also send the log row's sets from
    TS, because with access off they would make the stored value non-NULL.
  - `questions-import.ts` has no source document to send.

## Behaviour with access off
Unchanged. `rag_review_access_sets` adds document labels only while access is enforced, and log row sets are read only while it is
enforced. Today's callers send no `access_sets` key, so the stored value stays NULL. The tests check this for both writers in both
modes, including the strata row.

## Residual
A row with no source (CSV historical import, a re-review question without golden evidence) still has NULL sets and stays visible to
every expert of the tenant. That is the same as 0984's rule for sourceless items. Making these fail closed would hide all imported
items from non-admin experts.

## Apply order
After 0967, 0974 and 0984 (and 0950 / 0944, which 0984 already follows), apply 0986, then re-run 0410.
Re-running 0967 or 0974 later restores their old bodies: re-run 0986 after them.

## DROP section
None. No signature changed, so nothing is dropped (CREATE OR REPLACE on the same argument lists).

## Operator actions (eval project first, never production first)
1. On the **eval** Supabase project: apply `0986_review_items_writers_access_sets.sql`, then re-run `0410_security_definer_rpc_grants.sql`.
2. Verify:
   - `SELECT has_function_privilege('authenticated', 'public.rag_review_items_enqueue(text,text,jsonb)'::regprocedure, 'EXECUTE')`
     returns false; do the same check for `rag_review_items_enqueue_re_review(text,jsonb)`.
   - With access enforced, enqueue a representative row whose log row retrieved a restricted document. The item's `access_sets`
     is non-NULL, and an expert outside the group cannot select it.
3. Only after that passes, apply to production in the same order.

## Commits
- 4aa52236b chore: reserve 0986
- 8f224eb1a test RED: `tests/rag-db/review-writers-access-sets.test.mts`. Failed on assertions: sets NULL, outside expert could see the item, 0410 did not lock the functions.
- 568b8d60c fix: 0986 + 0410 entries
- 5cf368190 test RED: the re-review route test in `tests/api/golden-evidence-routes.test.ts`. It failed because the item's `access_sets` was NULL.
- 21bbb6597 fix: the route sends golden item ids
- eac83eef5 chore: pause note (removed in the SUMMARY commit)
- 4th fix commit: 0986 rebuilds the re-review writer only where 0974 created it (phase53 ownership test)

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: ok
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`,
  `node scripts/ci/check-settings-classification.mjs`: all ok
- tests/rag-db subset (every file matching grant, search-path, access, review, definer, monitor-evidence, phase53, questions-import):
  813 tests, 807 pass, 4 fail. All 4 failures are in `access-catalog-sentinel.test.mts` (both modes) and are **pre-existing**: they
  fail the same way on origin/ci/merge-train-39, because 0983's `rag_scope_centroids_rebuild` is not classified. They are not caused
  by this task.
- New test `tests/rag-db/review-writers-access-sets.test.mts`: 26/26 (both modes)
- vitest: `tests/api/golden-evidence-routes.test.ts`, `tests/rag/questions-import.test.ts`, `tests/rag/feedback-loop/labels.test.ts`:
  46/46
