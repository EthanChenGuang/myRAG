---
quick_id: 261127-ads
slug: access-derived-stores
type: quick
created: 2026-11-27
source: origin/verify/04.3 (04.3-VERIFICATION.md G5, G6; 04.3-SECURITY.md NF-2, NF-3)
threats: [T-04.3-143, T-04.3-131]
---

# Quick 261127-ads: close G5 (NF-2) and G6 (NF-3)

Scope: only G5 and G6 of the Phase 4.3 verification. Branch `exec/quick-access-derived-stores` from `origin/ci/merge-train-39`.

## Task 1: G5 / NF-2, Langfuse review export (TDD)
- RED: `tests/rag/access/review-export-access.test.ts` covers groundedness_flagged, claim_unsupported, feedback_negative and the
  semantic-cache hit, each with access on (restricted stripped, unknown stripped, open kept) and access off (unchanged).
- GREEN: `exportReviewCandidate` takes `accessSets`; with RAG_DOC_ACCESS_GROUPS on it keeps query, answer and quotes only when every
  cited document's set is exactly `['all']` (unknown = restricted) and otherwise exports ids and counts only. The three callers pass
  the cited sets (answer-finish and claims from `input.accessSets`, feedback reads the row's `access_sets` with the admin client).
  Cache hits: the cached `sources` / `source_versions` documents are read for labels and count as kept for `stripRestrictedContent`;
  the hit's answer record stores their sets.

## Task 2: G6 / NF-3, review chunk route live check (TDD)
- RED: tests for a relabelled document (stale access set) and a NULL-set item written before enforcement.
- GREEN: `fetchServableChunks` runs a live `rag_chunks_visible` check with the expert's resolved access scope while access is on;
  any failure returns no text (fail closed). No SQL change unless the live check needs one.

## Gates
tsc, typecheck:new, check-rag-boundary, tests/rag/access, tests/rag-db access-* and review-items-access-sets (both modes), trace and
review vitest files.
