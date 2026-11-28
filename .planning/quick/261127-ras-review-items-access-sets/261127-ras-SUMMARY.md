---
quick_id: 261127-ras
status: complete
branch: exec/quick-review-access-sets
base: origin/ci/merge-train-37
---

# Summary: review-queue writers carry access_sets (0984)

Security gap from 04.3-14: `rag_mine_failed_queries` and `rag_enqueue_review_item` wrote `rag_review_items.access_sets` as NULL, so the
restrictive policy `rag_review_items_access_sets` (0934) hid no new item. An expert outside a document's access group could open the
item's evidence through the review chunks route. Closed.

## Migration number
0935 was the next free number in the 093x block, and I claimed it first (479a3d4e). Both functions are redefined again by **0950**
(Phase 5.2.1), though, which comes later in file order, so a 093x body would be overwritten on every database built in order. I moved
the claim to **0984**, the next free number after every used 09xx on all origin branches (364a45e7). No 10xx file redefines either function.

## What changed
- `supabase/migrations/0984_review_items_access_sets.sql`, one common file (nothing differs by mode; `tenant_key` exists in both; `rag_assert_tenant_key` checks the mode):
  - New `rag_review_access_sets(p_tenant_key text, p_given jsonb, p_document_ids uuid[], p_strict boolean DEFAULT true) RETURNS jsonb`: SECURITY INVOKER, `SET search_path = ''`, revoked from PUBLIC/anon/authenticated, granted to service_role. It returns `p_given` normalised (keys sorted and deduplicated within each set, sets deduplicated and sorted) and merged with one `access_groups` set per document of the tenant. The documents' labels are added **only while `rag_access_enforced()`**. With access off and `p_given` NULL it returns NULL. When strict, a malformed `p_given` raises `invalid_access_sets` (22023); when lenient (mining), a malformed set becomes the key nobody holds, `g:00000000-0000-0000-0000-000000000000` (the 04.3-14 `UNKNOWN_ACCESS_SET`), which fails closed.
  - `rag_mine_failed_queries`, rebuilt from its 0950 body: the inserted item gets `rag_review_access_sets(l.tenant_key, l.access_sets, <candidate document ids>, false)`, which copies the log row's sets (written by 04.3-14's retrieval-log writer) and also covers log rows without sets. SECURITY DEFINER, empty search_path, service_role only; otherwise unchanged.
  - `rag_enqueue_review_item`: **DROP** of `(text, text, jsonb, jsonb)`, then CREATE of `(text, text, jsonb, jsonb, p_access_sets jsonb DEFAULT NULL)` from its 0950 body. It stores the given sets merged with those of the source chunks' and documents' documents. SECURITY INVOKER, empty search_path, service_role only. Positional 4-argument calls still resolve.
  - Backfill: while access is enforced at apply time, rows with `access_sets IS NULL` get sets from their candidates and snapshot ids. With access off it does nothing.
- `0410`: guarded REVOKE/GRANT lines **appended only**, for the new enqueue signature and the helper. The old 4-argument entry stays; it is guarded and becomes a no-op.
- TS: `enqueueReviewItem` takes an optional `accessSets` and sends `p_access_sets` only when given (sets validated and normalised; a malformed set becomes the unknown set). When not given, the RPC arguments are exactly as today. `scheduleCalcReviewEnqueue`, `writeAnswerConflict`/`recordAnswerConflict` and `recordOutputGuardEvents` pass an optional `accessSets` through. This branch has no `accessSetsFor` (04.3-14 is not merged into train-37), so the call sites send nothing yet. The SQL reads the labels itself, so the gap is closed without them. After 04.3-14 lands, the route can pass `accessSetsFor(...)` into these fields.

## Apply order
1. After 0934 and **after 0950** (and everything before 0984 in file order): apply `0984_review_items_access_sets.sql`.
2. Re-run `0410_security_definer_rpc_grants.sql` (idempotent; locks the new signatures).
3. Re-running 0944 or 0950 later re-creates the 4-argument enqueue (an ambiguous overload) and the old mining body. Re-run 0984 after them.

Not folded into the setup files.

## Operator actions (evaluation project fsgaeysipkukqoocgzbx only; production untouched)
- Apply 0984, then 0410, on the eval project. Check: `SELECT to_regprocedure('public.rag_enqueue_review_item(text,text,jsonb,jsonb)')` is NULL, and the 5-argument signature and `rag_review_access_sets(text,jsonb,uuid[],boolean)` are service_role only.
- If access groups are already enforced there, the backfill labels existing NULL items. Otherwise, re-run 0984 after turning `RAG_DOC_ACCESS_GROUPS` on to label items written during the gap.
- Deploy the app after the migration. The TS sends `p_access_sets` only when sets are given, so the app stays compatible with a database that does not have 0984 yet.

## Tests
- RED (f25ab847): `tests/rag-db/review-items-access-sets.test.mts`, both modes. 20 failed on assertions (sets NULL, outsider sees the item) or on the missing 5-argument signature; the 4 access-off cases passed.
- GREEN: same file 24/24. Covered: restricted item carries `[["g:<group>"]]`; hidden from the outside expert, visible to the member and the admin; chunks route `not_found` for the outsider and evidence for the member; given sets merged; malformed sets refused with 22023; access off gives NULL and stays visible as today; mining copies log sets and derives from candidates; catalog and grants; 0410 relock; re-run 0984, then 0950, then 0984 leaves one signature.
- Existing tests updated for the new signature and the re-run rule: `tests/rag-db/review-enqueue.test.mts`, `tests/rag-db/calc-review-reasons.test.mts` (they re-run 0944/0950 and now re-run 0984 after them). The test file got two fixes after the RED commit: the regprocedure text format, and the multi-tenant owner added as an expert, since operator admins are not implicit experts.
- Vitest: new cases in `tests/rag/feedback-loop/enqueue-item.test.ts` and `tests/rag/calc/check-record.test.ts`.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: ok
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: ok
- `node --import tsx --test`: every tests/rag-db file matching grant|search-path|access|review|mining|calc-review|security-definer|catalog|inventory|feedback, plus every .mts that names `rag_enqueue_review_item`, `rag_mine_failed_queries`, `rag_review_items`, 0410 or 0950 (37 files): 692 passed, 0 failed
- `npx vitest run` on the 25 test files importing the changed modules: 312 passed

## Deferred / not done
- Other `rag_review_items` writers, `rag_review_items_enqueue` (0967) and `rag_review_items_enqueue_re_review` (0974), still write `access_sets` NULL. They store no candidates or snapshot ids, so the chunks route serves no evidence for them, but their masked query stays visible to every expert of the tenant. A follow-up could copy the sets of the referenced log row (0967 has `retrieval_log_id`).
- Passing `accessSetsFor(...)` from the chat route waits for 04.3-14 to merge.
- No new env variable, no UI change.
