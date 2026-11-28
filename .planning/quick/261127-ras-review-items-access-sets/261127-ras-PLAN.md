---
quick_id: 261127-ras
status: planned
---

# Plan: review-queue writers carry access_sets

Gap found by 04.3-14: `rag_mine_failed_queries` (0535/0537, last body 0950) and `rag_enqueue_review_item` (0944, last body 0950) write
`rag_review_items.access_sets` as NULL, so 0934's restrictive policy never hides a new item and an expert outside a document's access
group can read its evidence through the review chunks route.

1. Claim the next free 09xx migration number that sorts after 0950 (both functions are redefined there): 0984.
2. RED: `tests/rag-db/review-items-access-sets.test.mts`, PGlite, both modes (sets written, 0934 hides from an outside expert, off unchanged).
3. 0984: helper `rag_review_access_sets`, mining rebuilt from 0950 (copy the log row's sets), enqueue rebuilt from 0950 with
   `p_access_sets jsonb DEFAULT NULL` (old signature dropped), backfill while enforced, guarded grants appended to 0410.
4. TS: `enqueueReviewItem` sends `p_access_sets` when given; callers pass an optional `accessSets` through.
5. Update the tests that pin the old signature; run the gates.
