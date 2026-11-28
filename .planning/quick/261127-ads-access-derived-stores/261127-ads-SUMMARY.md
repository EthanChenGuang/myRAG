---
quick_id: 261127-ads
status: complete
branch: exec/quick-access-derived-stores
base: origin/ci/merge-train-39 (c6f1b3f7)
closes: [G5 / NF-2 / T-04.3-143, G6 / NF-3 / T-04.3-131 (chunk text)]
migration: none
---

# Summary: access checks for the Langfuse review export and the review chunk route (G5, G6)

Only G5 and G6 of `04.3-VERIFICATION.md` / `04.3-SECURITY.md` (origin/verify/04.3). Both switch-off paths are unchanged and tested.

## Commits
| Task | Commit | What |
|---|---|---|
| G5 RED | 77e8430b | `tests/rag/access/review-export-access.test.ts`: 17 tests, 9 failed on assertions on the old code (restricted text in the export) |
| G5 GREEN | b320ec08 | review export access rule, three callers, cache-hit sources |
| G6 RED | b254c8db | `tests/rag-db/review-chunks-live-access.test.mts` (both modes) and `tests/rag/feedback-loop/review-chunks-fail-closed.test.ts`; on the old code the outsider received the restricted text (4 DB tests and 2 unit tests failed) |
| G6 GREEN | c0749443 | live `rag_chunks_visible` check in `fetchServableChunks` |

## G5 (NF-2): Langfuse review exports
- `exportReviewCandidate` (`src/lib/rag/trace/review-export.ts`) takes `accessSets` (the cited documents' key arrays). While `RAG_DOC_ACCESS_GROUPS` is on, query, answer and cited quotes are kept only when **every** set is exactly `['all']`. Unknown sets (absent, null, empty) count as restricted. Otherwise the review observation carries the trace id, tenant key, reason, model and `cited_count` only. If the switch cannot be read, it counts as on. Off: the export is byte-for-byte as before (tests).
- Callers: `answer-finish.ts` (groundedness_flagged) and `claims.ts` (claim_unsupported) pass `input.accessSets` (the same sets the answer record stores). `feedback.ts` (feedback_negative) reads the record's `access_sets` with the admin client while access is on (new dep `accessOn`). A failed read or a timeout gives unknown, so the text is stripped. The key is omitted when there are no sets, so the off-state inputs are unchanged.
- Cache hits: new `cachedSourceDocumentIds(hit)` (`src/lib/rag/cache/sources.ts`, exported from `@/lib/rag`) lists the cached `sources` / `source_versions` documents. They are now among the documents whose labels `attachAccessLabels` reads (`resultDocumentIds`), and `finishTrace → stripRestrictedContent` counts them as kept (new optional `sourceDocumentIds` argument). This covers chat (`route.ts` cache hit) and embed (`embed/chat/route.ts`, through the same `finishTrace`). On a chat hit, the answer record also stores the cached sources' sets, so a later negative vote on that answer is stripped too.
- Decision: an answer with no cited documents counts as unknown while access is on, so its review copy is stripped (the answer may still come from uncited restricted context). This is stricter than "any cited document not `all`", as the security-first rule requires.

## G6 (NF-3): review chunk text
- `fetchServableChunks(admin, tenantKey, ids, options)` takes a `viewer`. While access is on:
  - `expert`: `resolveAccessScope` (user identity, membership read fresh), then `visibleChunkIds` → `rag_chunks_visible` (labels, tenant, current, ready), live. Only those ids are read.
  - `tenant_admin`: no extra filter. Used by the golden and calibration exports, which sit behind the tenant-admin guard; an admin reads every group of the tenant.
  - Missing viewer, refused scope, failed lookup or malformed tenant key: no text (fail closed, `[Review] chunk text refused` with a reason only).
- Expert callers pass the expert: the chunks route (`getReviewItemChunks`), review search (`searchForReviewItem`) and label evidence (`validateAndSaveLabel → checkEvidence`, which now gets `expertId`).
- The item's stored `access_sets` no longer decides chunk text, so a stale set after a relabel and a NULL set written before enforcement both stop serving restricted text. The tests cover both cases, in both modes, plus the member still being served and the off path being unchanged.
- 5.1.1 G7 / T-0511-89 (orchestrator follow-up): `checkEvidence` (label save) already reads through `fetchServableChunks` with the expert as viewer (c0749443), so the same live, fail-closed check applies; a span on a chunk the expert may no longer read is refused as `chunk_not_servable` and nothing is written. Test added in `tests/rag-db/review-chunks-live-access.test.mts` (fails on the pre-fix code, passes in both modes; the group member can still cite it).
- **No migration.** The live check makes recomputing `access_sets` unnecessary for chunk text, so no SQL changed and no migration number was claimed.

## Gates run
All pass:
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm run typecheck:new`: no Phase 1 type errors, 0 legacy diagnostics ignored.
- `node scripts/ci/check-rag-boundary.mjs`, `scripts/check-config.mjs`, `scripts/ci/check-language-literals.mjs`, `scripts/ci/check-settings-classification.mjs`: exit 0.
- `npx vitest run tests/rag/access tests/rag/generation tests/rag/trace tests/rag/cache`: 65 files, 941 tests.
- Every vitest file importing a changed module (G5): 99 files, 1337 passed, 3 skipped (pre-existing skips).
- Review and feedback-loop vitest (G6: `tests/rag/feedback-loop`, `tests/rag/judge`, `tests/rag/access`, `tests/api/feedback-loop-export-*`, `tests/api/review-label-search`, `tests/api/golden-evidence-routes`, `tests/ui/review-labelling-panel`): 42 files, 590 tests.
- `node --import tsx --test tests/rag-db/access-*.test.mts tests/rag-db/review-items-access-sets.test.mts tests/rag-db/review-chunks-live-access.test.mts` (each file runs single- and multi-tenant): 529/529 (70 suites), up from 523 on the train with the 6 new tests; after the G7 follow-up the live-access file has 8/8.

## Deviations
- `tests/rag-db/review-chunks-live-access.test.mts` wraps the PGlite REST client: `rpc(...).abortSignal()`, and a correct `SETOF uuid` read for `rag_chunks_visible` (the shared helper returns only the first row of a set-returning function). The shared helper is unchanged.
- `ReviewCandidateInput` / `CollectedTrace.review` gained `accessSets` / `citedCount`; Langfuse metadata gained `cited_count` (stripped exports only).

## Residual / deferred (not in scope)
- Item-level text (`query_masked`, golden question text) of NULL-set or stale-set items is still governed by the stored `access_sets` (0934 policy, NULL = readable). This is the review-writers gap (merge `exec/quick-review-writers-access` as 0987) plus a recompute on flip or relabel. Not part of G6, which covers chunk text.
- G4 (NF-1, shared chats over PostgREST) and the 0986 collision are untouched.

## Operator actions
None (no SQL). Deploy as part of the next train.

## Requirement / threat ids
SEC-13; T-04.3-143 (closed for review exports and cache hits); T-04.3-131 (chunk text closed; item text residual above).
