---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 09
subsystem: retrieval
tags: [assembleContext, post-filter, context-assembly, byte-identity, differential-test, query-count, n-plus-one]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: frozen chat assembly oracle and characterization snapshots (02-06); stage runner, StageRecord shape, reason codes and trace ownership (02-08)
provides:
  - assembleContext (pure) with filterCandidates and buildContext halves, byte-identical to the chat route's post-filter and format
  - fetchAssemblyRows, a fixed two-query lookup (documents and document_chunks, both in('id'))
  - post_filter and assemble stages in runRetrieval for profiles chat, embed and eval
  - RetrievalResult now carries context, usedDocuments (full chat shape), sourceImages, links, relevantChunks, kept, queryTerms and refusalCandidate
  - RetrievalOptions now accepts isGPTModel, ragMode, webSearchEnabled and referenced
affects: [02-11, 02-12, 02-13, 02-14, 02-16]

requirements-completed: [PIPE-05]

actuals:
  tokens: 16850
  tasks: 2
  commits: 3
plan_head_before: 7834482d853634736e056896ea48054c0b1875e1
plan_head_after: a8d604752b5c685eb3ac604cf929eebd52bc0bd4

tech-stack:
  added: []
  patterns:
    - "Assembly is split into filterCandidates (Filter 1, referenced state as initial state) and buildContext (grouping, format, Filter 2, source images, refusal); assembleContext composes them, and the pipeline runs one per stage"
    - "Row lookups are Maps keyed by id; iteration follows candidate order, so the order-dependent quirks of the old per-chunk loop survive"
    - "The pure assembly never mutates its inputs; the oracle mutated chunk.metadata and the referenced documents, the new code works on copies"

key-files:
  created:
    - src/lib/rag/context/assemble.ts
    - src/lib/rag/context/fetch-rows.ts
    - tests/rag/assemble.test.ts
    - tests/rag/pipeline-assembly.test.ts
    - tests/rag-assemble-differential.test.mts
    - tests/rag-assemble-query-count.test.mts
  modified:
    - src/lib/rag/types.ts
    - src/lib/rag/pipeline.ts
    - src/lib/rag/index.ts
    - tests/rag/helpers/pipeline-fakes.ts
    - tests/rag/stage-runner.test.ts
    - tests/rag/trace-log.test.ts
    - tests/rag-legacy-differential.test.mts

key-decisions:
  - "ragMode defaults to strict and isGPTModel to false when a caller passes no options, matching the chat route's own default for RAG_BEHAVIOR_MODE"
  - "applyRelevanceFilter is false when post_filter is disabled or skipped: Filter 1 keeps every candidate with a document row and Filter 2 is not applied"
  - "Zero survivors (usedDocuments plus relevantChunks) with candidates present gives status empty and the new reason no_relevant_context; zero candidates keeps no_candidates"
  - "Assembly stages run for chat, embed and eval even with zero candidates, so a referenced-only context and the 'No relevant context found.' text still come from the pipeline; voice and media do not run them"
  - "The query-less general-overview branch of the old loop is not ported: the pipeline always has a query, and plan 02-12 leaves that code in the route until 02-13"

patterns-established:
  - "tests/rag/helpers/pipeline-fakes.ts: fakeAssemblyAdmin() is installed by installDeps() so pipeline fakes need no real admin client"

coverage:
  - id: D1
    description: "assembleContext reproduces the chat post-filter and format: thresholds, Chinese empty-term, name match, grouping, sort, image skip, GPT labels, links, referenced first, Filter 2, source images, refusal candidate"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/rag/assemble.test.ts (30 tests)"
        status: pass
  - id: D2
    description: "For 72 questions x isGPTModel {true,false} x {no reference, one referenced document}, context is byte-identical to the frozen oracle and usedDocuments, sourceImages and the refusal candidate are deep-equal"
    requirement: PIPE-05
    verification:
      - kind: integration
        ref: "node --import tsx --test tests/rag-assemble-differential.test.mts -- 288 compared cases, 0 differences; plus 16 synthetic cases with links and source images, 0 differences"
        status: pass
  - id: D3
    description: "Document and chunk metadata lookups are exactly 2 GETs for 5, 25 and 100 chunks"
    requirement: PIPE-05
    verification:
      - kind: integration
        ref: "tests/rag-assemble-query-count.test.mts (3 tests)"
        status: pass
  - id: D4
    description: "runRetrieval runs post_filter and assemble for chat, embed and eval and returns context, usedDocuments, sourceImages, links and the refusal candidate; failures degrade, never lose candidates"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/rag/pipeline-assembly.test.ts (11 tests)"
        status: pass
---

# Phase 2 Plan 09: Shared Context Assembly Summary

**One pure `assembleContext`, proven byte-identical to the chat route's post-filter loop on 288 fixture cases, now runs inside `runRetrieval` as the post_filter and assemble stages with a constant two-query row lookup.**

## Performance

- **Tasks:** 2 of 2 (Task 1 as RED then GREEN)
- **Files:** 6 created, 7 modified
- **Verification:**
  - `npx vitest run` passes (40 files, 353 tests); `tests/rag` and `tests/legacy-post-filter*.test.ts` included, characterization snapshots untouched
  - `node --import tsx --test tests/rag-assemble-differential.test.mts tests/rag-assemble-query-count.test.mts tests/rag-legacy-differential.test.mts` passes (3, 3 and 5 tests)
  - Differential summary line: `[assemble differential] compared 288 cases, 0 differences (used documents in 156, referenced 144, refusal candidates 68)`, and `synthetic image/url cases: compared 16, 0 differences (with links 16, with source images 16)`
  - Query count: 3 passing cases (5, 25, 100 chunks), GET paths exactly `['/rest/v1/document_chunks', '/rest/v1/documents']`
  - `npm run typecheck:new` reports no Phase 1 errors; `npx next typegen && node scripts/ci/tsc-ratchet.mjs` reports ok (58 errors, 59 files improved)
  - Acceptance greps: `export function assembleContext` in assemble.ts (1), `.in('id'` in fetch-rows.ts (2), `legacyChatAssembly` in the differential test (4)

## Accomplishments

- Task 1 (RED bc8fe4d, GREEN 1d180cc): `assembleContext` started from `legacy-post-filter.ts` and was aligned to the oracle wherever they differed: the group key is `filename || name`, `image_url` is the raw metadata value (not `String()`), `created_at` stays as read, the full `UsedDocument` shape has every key present (including `image_url: undefined`), referenced documents are initial state that survives Filter 2, and `normalizeQueryText` handles content-part arrays. `fetchAssemblyRows` does one documents query (`id, filename, created_at, content, metadata`) and one chunks query (`id, metadata`), de-duplicates ids, passes the abort signal, checks `signal.throwIfAborted()` after each await, and throws on a query error.
- Task 2 (a8d6047): the pipeline runs `post_filter` (row fetch plus Filter 1) and `assemble` (format, Filter 2, source images, refusal candidate) for chat, embed and eval. The status survivor count is `usedDocuments.length + relevantChunks.length`. The differential test runs the oracle and the new code on the same candidates and the same admin client.

## Task Commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 RED | assembleContext and fetchAssemblyRows tests against stub exports | bc8fe4d |
| 1 GREEN | Shared assembleContext and two-query fetchAssemblyRows | 1d180cc |
| 2 | post_filter and assemble stages, differential and query-count tests | a8d6047 |

## Deviations from Plan

**1. [Rule 1 - Contract] `relevantChunks` is not compared with the oracle's return value**
- **Issue:** The oracle wrapper derives its returned `relevantChunks` after the region, from the final (post Filter 2) `usedDocuments` (02-06 key decision). The region's own `relevantChunks`, the one that builds the context, is computed from the pre-Filter-2 documents. `assembleContext` returns the region's definition, which is what the context is built from and what `kept` is derived from. The plan's equality list (context, usedDocuments, sourceImages, refusal candidate) does not include it, and the context equality already proves the region's chunks match. Recorded so plans 02-11 and 02-12 do not expect `relevantChunks` to shrink with Filter 2.

**2. [Rule 3 - Blocking] Existing tests needed an admin client and the new stage names**
- **Issue:** Adding the two stages made the 02-07/02-08 pipeline fakes degrade (no admin client) and changed the stage list in three assertions.
- **Fix:** `installDeps()` now installs `fakeAssemblyAdmin()` by default; `stage-runner.test.ts` and `trace-log.test.ts` list the two new stages.

**3. [Rule 1 - Contract] `tests/rag-legacy-differential.test.mts` status assertion**
- **Issue:** The 02-07 test asserted `status` ok for every question with candidates. With the post-filter, a question whose candidates all fail the relevance filter is `empty` (D-05: zero survivors), reason `no_relevant_context`.
- **Fix:** The assertion now requires `empty/no_candidates` without candidates, `empty/no_relevant_context` with zero survivors, and `ok` otherwise. The candidate and query-context deep-equality checks are unchanged and still pass for all 72 questions.

**4. [Scope] Extra synthetic differential test**
- The fixture corpus has no image chunks or chunk urls, so the 288 fixture cases exercise neither the image nor the links path. A second test inserts synthetic image, url, same-filename and own-image documents into the fixture database and compares the oracle with the new code for 4 queries (English, Chinese, no-match, Italian) x {no reference, reference} x both model kinds (16 cases, 0 differences).

## Intended behaviour changes

- `RetrievalResult` gained required fields (`relevantChunks`, `kept`, `queryTerms`, `refusalCandidate`); `usedDocuments`, `sourceImages` and `links` are now typed. Not reachable from any route yet; entry points still call the old retrieval until plans 02-11, 02-12 and 02-14.
- Status `empty` can now occur with candidates present (reason `no_relevant_context`). A caller that maps `empty` to a refusal must check `refusalCandidate` as well as strict mode (D-06).
- Characterization snapshots are untouched: no route was switched.

## Known Stubs

None. `voice` and `media` profiles intentionally skip the two stages (voice assembly arrives with 02-16).

## Threat Flags

None beyond the plan's register. T-02-19 is mitigated: `fetchAssemblyRows` takes ids only from the candidates the scoped search returned (and the pipeline never passes anything else), and never widens the id set. T-02-20 is accepted as planned: one `in()` of at most 100 chunk ids is about 3.7 KB; the 100-chunk query-count case passed against the fake edge, a live PostgREST length check is still open (assumption A8).

## Notes for later plans

- 02-11 (eval route): map `RetrievalResult.kept`, `queryTerms`, `usedDocuments`, `context` and `refusalCandidate` onto `RagTrace`; call `finishTrace` yourself when you pass `trace`.
- 02-12 (chat route): pass `options: { isGPTModel, ragMode, webSearchEnabled, referenced }`; `referenced.usedDocuments` are copied, never mutated. The strict refusal is `result.refusalCandidate && result.status === 'empty'` (D-06).
- 02-12 sentinel retarget: the pinned regions now live in `assemble.ts` (`filterCandidates` and `buildContext`).
- `legacy-post-filter.ts` still exists and its tests still pass; 02-11 deletes it.

## Self-Check: PASSED

- All 6 files under key-files.created exist.
- Commits bc8fe4d, 1d180cc and a8d6047 are ancestors of HEAD.
