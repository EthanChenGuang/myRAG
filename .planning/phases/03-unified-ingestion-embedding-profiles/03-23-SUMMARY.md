---
phase: 03-unified-ingestion-embedding-profiles
plan: 23
subsystem: ingestion
tags: [ingest, scraper, firecrawl, tenant-scope, session-auth, markdown]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest() and its stages (03-13, 03-13b), buildSourceKey (03-13), scope resolvers (03-07), store_original and parse output (03-17), doc-type resolution (03-22)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "resolveTenantScope, repairOwnerMembership, requireSessionUser, checkSingleTenantKbWrite"
provides:
  - "scrapeAndProcess and crawlAndProcess with a unified branch: Firecrawl Markdown (or an inline PDF) through ingest(), identity = canonical URL"
  - "scrape and crawl routes that look the session up once with requireSessionUser and resolve the scope on the server under unified"
  - "ingest options.origin: source_provider, source_file_id, source_connection_id and string metadata written to the document row right after the version begins"
  - "currentIngestConfig and buildSourceKey exported from @/lib/rag for callers outside the pipeline"
affects: [03-24, 03-30, 03-31, 03-33, phase-7-release-defaults]

actuals:
  tokens: 14000
  tasks: 2
  commits: 6

tech-stack:
  added: []
  patterns:
    - "A write-path switch outside src/lib/rag reads RAG_INGEST_PIPELINE through scraperPipeline() (currentIngestConfig, falls back to legacy when the read fails)"
    - "A source names its row fields through IngestOptions.origin; ingest keeps only plain strings"

key-files:
  created:
    - src/lib/scrapers/ingest-switch.ts
    - src/lib/rag/ingest/current-config.ts
    - src/lib/rag/ingest/origin.ts
    - tests/rag/ingest/write-path-scraper.test.ts
    - tests/rag/ingest/origin-fields.test.ts
  modified:
    - src/lib/scrapers/scraper-adapter.ts
    - src/lib/scrapers/firecrawl-client.ts
    - src/app/api/scrapers/scrape/route.ts
    - src/app/api/scrapers/crawl/route.ts
    - src/lib/rag/index.ts
    - src/lib/rag/ingest/index.ts
    - src/lib/rag/ingest/types.ts
    - src/lib/rag/ingest/stages/dedup.ts

key-decisions:
  - "Both routes use requireSessionUser; its 401 is re-mapped to the route's existing 'Authentication required' body so the client-visible text and the plan's acceptance grep stay as at HEAD, while a retryable auth-service error is now a 503 instead of a 401"
  - "The fake user id 'single-tenant-user' is gone from both routes (the session user id is always present after the check); single-tenant unified scraping uses s:default"
  - "Unified scrape writes provider fields through a new ingest options.origin instead of the adapter writing documents itself, so the boundary rules hold and 03-33 can reuse it"
  - "The pdf output format accepts only inline PDF bytes from Firecrawl's pdf action; a link or non-PDF content is refused and the app never fetches a third-party URL (T-03-67)"
  - "scraperPipeline() falls back to legacy when the config read throws, which is also what keeps tests/rag/single-tenant-writes.test.ts passing unchanged under its narrow @/lib/rag mock"

patterns-established:
  - "Route order: requireSessionUser, single-tenant owner-or-admin check, Firecrawl-enabled check, body validation, then the pipeline switch and scope resolution"

requirements-completed: [DATA-01, DATA-02]

coverage:
  - id: D1
    description: "Under legacy, scrapeAndProcess and crawlAndProcess call Firecrawl and processDocument exactly as before (source scrape) and never call ingest"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-scraper.test.ts#scraper adapter, legacy pipeline"
        status: pass
    human_judgment: false
  - id: D2
    description: "Under unified, scrape and crawl send Firecrawl Markdown to ingest() with source scraper, the canonical URL as source key, text/markdown, the title as filename and provider metadata; unchanged pages are skipped and changed pages become new versions through ingest identity"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-scraper.test.ts#scraper adapter, unified pipeline"
        status: pass
    human_judgment: false
  - id: D3
    description: "ingest writes source_provider, source_file_id and URL metadata named in options.origin onto the document row"
    requirement: DATA-02
    verification:
      - kind: unit
        ref: "tests/rag/ingest/origin-fields.test.ts#ingest origin fields"
        status: pass
    human_judgment: false
  - id: D4
    description: "Both routes refuse a request without a session (401) or with an unavailable session service (503) in both modes and both pipelines before anything is fetched or written; single-tenant writes are owner-or-admin and honour read_only_doc_dashboard"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-scraper.test.ts#scrape route / crawl route"
        status: pass
      - kind: unit
        ref: "tests/rag/single-tenant-writes.test.ts (unchanged)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Under unified, the routes resolve s:default, o:<org> and u:<user> scopes on the server, refuse a non-member with 403 before any scrape and return status and version"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-scraper.test.ts#unified pipeline"
        status: pass
    human_judgment: false
  - id: D6
    description: "The pdf output format returns the page as a PDF through Firecrawl's pdf action; the response shape of that action is not confirmed against the live API"
    requirement: DATA-01
    verification: []
    human_judgment: true
    rationale: "The installed Firecrawl SDK does not document the pdf action's output and no live key is available; a real scrape with outputFormat pdf under unified must be tried once"

duration: 55min active
completed: 2026-11-24
status: complete
plan_head_before: 65c5b7fec2be3a12c7e444f38c1bc4f50f947053
plan_head_after: b73af1d
commits: 6
---

# Phase 3 Plan 23: Scraper write path behind ingest() Summary

**Scrape and crawl now go through ingest() under RAG_INGEST_PIPELINE=unified (Firecrawl Markdown, canonical-URL identity, server-resolved scope) and through the unchanged legacy code otherwise, behind a single requireSessionUser check that leaves no anonymous path in either pipeline or mode.**

## Performance

- **Duration:** about 55 min of active work (the wall clock also spans a usage-limit pause)
- **Started:** 2026-11-24T03:24:52Z
- **Completed:** 2026-11-24T07:58Z
- **Tasks:** 2 (plus one follow-up RED/GREEN pair for the request budgets)
- **Files modified:** 13

## Accomplishments

- Unified branch in `scrapeAndProcess` and `crawlAndProcess`: Markdown request to Firecrawl, `ingest({ scope, source: 'scraper', sourceKey: canonical URL, text, filename '<title>.md', mimeType 'text/markdown' })` per page, results mapped to `{ documentId, url, title, status, version }` (a skipped duplicate reports the existing document id). The legacy bodies are untouched: `source: 'scrape',` still appears twice and the legacy calls are pinned by tests.
- Routes: `requireSessionUser` first (401 body kept as `Authentication required`, 503 when the lookup throws or the auth service is temporarily unreachable), then the single-tenant owner-or-admin / `read_only_doc_dashboard` check, then under unified `repairOwnerMembership` and `resolveTenantScope` with the already verified session user (one lookup), 403 for a non-member, null scope is 401.
- DATA-02: ingest gained `options.origin`, so scraped documents carry `source_provider firecrawl`, `source_file_id`, `external_url`, `scraped_url` and `title` like the legacy rows (the scraper status route reads them).
- Per-request ingest deadlines inside the 60 s scrape and 300 s crawl budgets.

## Task Commits

1. **Task 1: unified branch in the scraper adapter** - `96e8e43` (test, RED), `3988bab` (feat, GREEN)
2. **Task 2: scope resolution in the scrape and crawl routes** - `e41f528` (test, RED), `b73af1d` (feat, GREEN)
3. **Follow-up: ingest deadline budgets** - `f1e4b1a` (test, RED), `66a3836` (feat, GREEN)

**Plan metadata:** the docs commit that adds this file.

## RED evidence

- `96e8e43`: 11 tests failed on assertions (origin fields not written, `scraperPipeline` stub returning legacy, adapter throwing `No HTML content returned from Firecrawl` instead of calling ingest); the legacy guards and the legacy-default switch tests passed, as intended. `src/lib/scrapers/ingest-switch.ts` existed as a stub so nothing failed on a missing module.
- `e41f528`: 16 failed: 8 for the retryable auth error answering 401 instead of 503 (every route x mode x pipeline) and 8 for the missing unified scope, status and version. The other route tests were guards for the HEAD security fix and passed.
- `f1e4b1a`: 2 failed (no `deadlineMs`, no crawl budget).

## Files Created/Modified

- `src/lib/scrapers/scraper-adapter.ts` - unified branch, identity union, inline-PDF handling, budgets
- `src/lib/scrapers/firecrawl-client.ts` - `output` option ('html' default, 'markdown', 'pdf' via the pdf action)
- `src/lib/scrapers/ingest-switch.ts` - `scraperPipeline()`
- `src/app/api/scrapers/scrape/route.ts`, `src/app/api/scrapers/crawl/route.ts` - shared session check, scope resolution
- `src/lib/rag/ingest/origin.ts`, `types.ts`, `stages/dedup.ts` - `options.origin`
- `src/lib/rag/ingest/current-config.ts`, `src/lib/rag/ingest/index.ts`, `src/lib/rag/index.ts` - `currentIngestConfig`, `buildSourceKey` public exports
- `tests/rag/ingest/write-path-scraper.test.ts` (73 tests), `tests/rag/ingest/origin-fields.test.ts` (4 tests)

## Decisions Made

See `key-decisions`. In short: requireSessionUser with the old 401 text; no fake single-tenant user id; provider fields through `options.origin`; inline-only PDFs; the switch read falls back to legacy.

## Deviations from Plan

**1. [Rule 3 - Blocking] Public exports for the pipeline switch and the source key**
- **Found during:** Task 1
- **Issue:** The boundary check forbids deep imports below `@/lib/rag` outside it, and `loadIngestConfig` and `buildSourceKey` were not exported from the index, so the adapter could use neither.
- **Fix:** added `currentIngestConfig` (`loadIngestConfig(getIngestDeps().ingestEnv())`) and `buildSourceKey` to the public index (`src/lib/rag/index.ts`, `src/lib/rag/ingest/index.ts`, new `current-config.ts`).
- **Files modified:** src/lib/rag/index.ts, src/lib/rag/ingest/index.ts, src/lib/rag/ingest/current-config.ts
- **Committed in:** 3988bab
- **Note:** `src/lib/rag/index.ts` is also in 03-29's file list and 03-24/03-31/03-33 need the same switch; expect a trivial textual merge conflict there. Keep both sides, and reuse `currentIngestConfig` instead of adding a second accessor.

**2. [Rule 2 - Missing critical] ingest did not persist source_provider, source_file_id or URL metadata**
- **Found during:** Task 1
- **Issue:** The plan requires these fields on scraped documents, and the scraper status route (03-30 keeps its query) finds documents by `source_provider = 'firecrawl'` and `source_file_id`. Nothing in ingest wrote them, so unified-scraped pages would never be found.
- **Fix:** `IngestOptions.origin` (typed, plain strings only, length-capped) applied through `writer.setFields` right after `rag_begin_document_version` in the file_hash_dedup stage; a run without `origin` writes nothing new.
- **Files modified:** src/lib/rag/ingest/types.ts, origin.ts, stages/dedup.ts
- **Verification:** tests/rag/ingest/origin-fields.test.ts; all 306 tests under tests/rag/ingest pass
- **Committed in:** 96e8e43 (tests), 3988bab
- **Note:** 03-33 (Nango) names `source_provider` and `source_connection_id` too and can pass them through `options.origin`.

**3. [Rule 1/2 - Security] Session check moved to requireSessionUser**
- **Found during:** Task 2
- **Issue:** The inline lookup at HEAD treated an `AuthRetryableFetchError` with no user as 401 instead of 503, and used a catch-all around the whole block. The brief requires `requireSessionUser` for audit H8.
- **Fix:** both routes call `requireSessionUser`; its 401 is mapped to the existing `Authentication required` body. Tests failed first (8 cases).
- **Committed in:** e41f528 (tests), b73af1d

**4. [Rule 2 - Missing critical] Request-budget deadlines for ingest**
- **Found during:** Task 2
- **Issue:** ingest's default 50 s deadline after a slow Firecrawl call, or 50 pages in sequence, could outlast the routes' 60 s and 300 s limits and lose the result.
- **Fix:** per-page `deadlineMs` inside the remaining budget; crawl pages left after the budget list as failed.
- **Committed in:** f1e4b1a (tests), 66a3836

**5. [Interpretation] Plan says the routes read the switch through loadIngestConfig**
- The route reads it through `scraperPipeline()`, a thin wrapper over `currentIngestConfig()` that returns legacy if the read throws. This is what lets `tests/rag/single-tenant-writes.test.ts` pass without edits, since its `@/lib/rag` mock exposes only `isAdminUser`.

**Total deviations:** 5 (2 Rule 2, 1 Rule 3, 1 Rule 1/2 security, 1 interpretation). **Impact:** all necessary for the plan's own truths or for correctness; no scope creep beyond the files listed, and every new switch has an off state equal to today's behaviour.

## Issues Encountered

- `tests/rag-langfuse-export.test.mts` timed out once in the full `node --test tests/*.test.mts` run (waitFor under load) and passed 8/8 when run alone; unrelated to this plan.
- No live Firecrawl key: the `pdf` action output (`actions.pdfs`) is read per the SDK types and the API as understood, not confirmed live (see D6).

## Known Stubs

None.

## Threat Flags

None new. T-03-65 and T-03-140 are covered by tests (403 before any scrape; no request without a session reaches Firecrawl, the adapter or ingest in either mode or pipeline). T-03-67: the app never fetches a URL Firecrawl returns.

## User Setup Required

None - no new environment variable (the config sync rule has nothing to mirror).

## Next Phase Readiness

- 03-24, 03-31 and 03-33 can use `currentIngestConfig` and `buildSourceKey` from `@/lib/rag`; 03-33 can use `options.origin`.
- Observed for later plans, outside this plan's files: `GET /api/scrapers/status` still answers without a session in single-tenant mode (03-30 owns that file).
- 03-27's parser chain parses the PDF bytes the pdf output format sends; this plan only sends them.

## Self-Check: PASSED

Created files exist on disk; commits `96e8e43`, `3988bab`, `e41f528`, `f1e4b1a`, `66a3836` and `b73af1d` are ancestors of HEAD; the measured count from the ledger is 6. Gates: tsc 0 errors, `typecheck:new` clean, vitest 1900/1900, node --test 144/145 (one load-dependent timeout, passes alone), boundary ok, check-workflows ok, check-config ok.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
