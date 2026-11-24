---
phase: 03-unified-ingestion-embedding-profiles
plan: 32
subsystem: ingestion
tags: [ingest, image-upload, captioning, after, tenant-scope, session-auth, quarantine, source_images]
status: complete

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest() stages, writer and runner (03-13, 03-13b), scope resolvers (03-07), object store and resume (03-17), chunker registry (03-19), injection scan and the D-08 filter (03-20), scraper and ai-to-rag write paths as route patterns (03-23, 03-24), parser chain (03-27), version-aware image readers (03-30)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "the upload security fix (session first, session-user storage prefix), requireSessionUser-style 401/503, checkAdmin, resolveTenantScope, the C3 images route fix"
provides:
  - "captionImage / IMAGE_CAPTION_PROMPT / setCaptionerForTests / resetCaptionerForTests / CaptionError in ingest/captioner.ts: the vision call of processImageDocument as one shared module; a test pins the prompt literal and model against document-processor.ts"
  - "image_caption chunker registered in CHUNKERS (returns no text chunk, marked captionOnly) and profileFor(source, docType): image_upload keeps the image_caption chunker whatever type resolved"
  - "whole-image parse (empty Markdown, one picture of the original, parser text, version image) and the captioning images stage: one image chunk, caption stored and recorded for resume, caption scanned with scanText"
  - "POST /api/upload unified branch: scope resolved in the request, ingest({ source: 'image_upload' }) run with after(); legacy branch untouched"
affects: [03-31, 03-37, 03-38, 03-43, 03-47, phase-7-release-defaults]

tech-stack:
  added: []
  patterns:
    - "A source rule lives in the profiles module (profileFor) and is applied wherever a profile is derived (identify, refinement, parse restore, resume), so no stage compares a doc type"
    - "A stage output that is not deterministic (a vision caption) is stored as a fixed-name artifact (caption-<n>.txt) and recorded in the images state slice; rehydrate re-runs the stage and reads it back"
    - "A route that must stay loadable under a narrow @/lib/rag mock reads the pipeline switch and loads the pipeline modules through dynamic import, with the legacy path as the fallback"

key-files:
  created:
    - src/lib/rag/ingest/captioner.ts
    - src/lib/rag/ingest/chunkers/image-caption.ts
    - src/lib/rag/ingest/image-options.ts
    - tests/rag/ingest/captioner.test.ts
    - tests/rag/ingest/write-path-image-upload.test.ts
    - tests/rag/ingest/write-path-image-upload-two-tenant.test.ts
    - tests/fixtures/ingest/caption-recorded.json
  modified:
    - src/app/api/upload/route.ts
    - src/lib/rag/ingest/chunkers/index.ts
    - src/lib/rag/ingest/profiles/load.ts
    - src/lib/rag/ingest/profiles/resolve-doc-type.ts
    - src/lib/rag/ingest/stages/parse.ts
    - src/lib/rag/ingest/stages/images.ts
    - src/lib/rag/ingest/stages/chunk.ts
    - src/lib/rag/ingest/stages/dedup.ts
    - src/lib/rag/ingest/stages/identify.ts
    - src/lib/rag/ingest/stages/scan-injection.ts
    - src/lib/rag/ingest/runner.ts
    - src/lib/rag/ingest/status.ts
    - src/lib/rag/ingest/types.ts
    - tests/rag/ingest/chunk-dispatch.test.ts

key-decisions:
  - "image_upload documents resolve their profile through profileFor(source, docType): the profile of the resolved type with its chunker kind replaced by image_caption. documents.processing_profile_id therefore records the type's profile id (for example general@1) although the chunker is image_caption"
  - "A picture parses to an empty Markdown, so its content hash is the file hash (image:<sha256>); otherwise every image would match every other as a content duplicate. Identical bytes uploaded twice by one tenant now skip as a duplicate under unified (legacy created two documents)"
  - "The caption is stored next to the original as caption-1.txt and the images slice carries nextIndex, captioned, imageUrl, imageContext and mimeType, so a resume needs neither the upload options nor a second vision call; rehydrateFromStore runs the images stage again only for caption-only documents"
  - "Captions are scanned with scanText whenever RAG_INJECTION_SCAN is not off, whatever the resolved profile's scan_injection says: a caption is text a model read out of an untrusted picture. The shared quarantine write moved from scan-injection into an exported quarantineDocument helper"
  - "The vision call yields (processing, resumable) when less than 8 s of the request budget is left or the call outlives the budget minus a 5 s reserve for embed, write and publish; it fails with caption_failed, caption_empty or unsupported_image_type otherwise"
  - "The media type sent to the model is the file's own type (image/jpg mapped to image/jpeg); legacy derived it from the file extension"
  - "The upload route runs all images of a request in one after() callback, four at a time, each bounded by what is left of 55 s since the request started (the route's limit is 60 s)"

patterns-established:
  - "Config-upload rule (same as 03-31): the session check stays first and unchanged; checkAdmin runs once, only under unified with process_rag true and upload_source=config_upload; the admin workspace scope needs ok and the same user id as the session; 401, 403 or another user means the session scope; 503 refuses before storage"

requirements-completed: [DATA-01]
requirements-partial: [DATA-11]

actuals:
  tokens: 43000
  tasks: 3
  commits: 6

plan_head_before: 14f30e5f426a8493e3d0e2f92eb9c2701749e02d
plan_head_after: 328af4cb944c29a3e945eeda56bdd124b0671ec5

coverage:
  - id: D1
    description: "captionImage sends the same model and prompt as processImageDocument, as a data URL with the file's media type, rejects on an aborted signal, and has a recorded-response test setter"
    requirement: DATA-11
    verification:
      - kind: unit
        ref: "tests/rag/ingest/captioner.test.ts#captionImage"
        status: pass
    human_judgment: false
  - id: D2
    description: "image_caption is registered in CHUNKERS (no text chunk, caption-only) and image_upload documents use it whatever type resolved; other sources are unchanged"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/captioner.test.ts#image_caption chunker and #profileFor source rule; tests/rag/ingest/chunk-dispatch.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "An image upload ends ready with one image chunk (caption as content, chunk_kind image, page 1, metadata.image_url, language, content hash, lexical text); two different images are not content duplicates; a failing or too-slow vision call fails or yields as specified"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-image-upload.test.ts#parse stage: a whole image and #an image upload through ingest()"
        status: pass
    human_judgment: false
  - id: D4
    description: "A caption holding an injection phrase quarantines the document under RAG_INJECTION_SCAN=quarantine, also when the profile's own scan flag is off; clean captions and scan off publish as today"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-image-upload.test.ts#an image upload through ingest()"
        status: pass
      - kind: integration
        ref: "tests/rag/ingest/write-path-image-upload-two-tenant.test.ts#an image whose caption holds an injection phrase is quarantined"
        status: pass
    human_judgment: false
  - id: D5
    description: "A resumed image upload does not call the vision model again and writes the same chunk as an uninterrupted run, from the stored caption or, without it, from the stored original"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-image-upload.test.ts#a resumed image upload"
        status: pass
    human_judgment: false
  - id: D6
    description: "In both pipelines and both modes a request with no session answers 401 and a throwing lookup 503 before storage, legacy processing, scope resolution, ingest or after(), with or without an admin cookie; tests/api/upload-route.test.ts passes unchanged"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-image-upload.test.ts#upload route (twelve cases) and tests/api/upload-route.test.ts"
        status: pass
    human_judgment: false
  - id: D7
    description: "Unified scope: u:<session user>, o:<org> after membership, s:default in single-tenant, 403 for a non-member before any storage write, null scope 401; the storage prefix is always the session user; ingest runs in after() with the stored path, the public URL and the bytes and never reads the session again"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-image-upload.test.ts#unified pipeline, scope resolution and #storage and background ingest"
        status: pass
    human_judgment: false
  - id: D8
    description: "Config UI uploads: admin workspace scope only for checkAdmin ok with the session user id; forged or unsigned cookie, non-admin session and identity mismatch give the session scope; a failing admin_users lookup is a 503 before storage; no upload_source never calls checkAdmin; legacy ignores upload_source"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-image-upload.test.ts#unified pipeline, Config UI uploads"
        status: pass
    human_judgment: false
  - id: D9
    description: "Two tenants through the real route, ingest, writer SQL, retrieval, context assembly and the images list: each tenant sees only its own image chunk and image list, the image reaches source_images, a non-member and a missing session write nothing, a quarantined image is neither listed nor retrieved; single-tenant writes under s:default"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag/ingest/write-path-image-upload-two-tenant.test.ts"
        status: pass
    human_judgment: false
  - id: D10
    description: "A real image with the real vision model through an upload on a deployed project: caption quality, the time one upload takes inside the 60 s limit, and the after() callback running to the end on the platform"
    verification: []
    human_judgment: true
    rationale: "No live OpenAI key or Vercel runtime here; the vision call is a recorded fake and after() is a recorder. Plan 03-48's live items must try one upload with RAG_INGEST_PIPELINE=unified"

duration: not measured
completed: 2026-11-24
---

# Phase 3 Plan 32: Image uploads behind ingest() with a shared captioner Summary

**Under RAG_INGEST_PIPELINE=unified an uploaded image becomes one captioned, injection-scanned image chunk through ingest() in a scope resolved from the verified session, written in after() instead of an un-awaited promise; the legacy upload path and the upload security fix's 401/503 checks are untouched**

## Performance

- **Duration:** not measured
- **Started:** 2026-11-24T08:25:15Z
- **Tasks:** 3 (all TDD; six commits)
- **Files:** 7 created, 14 modified, about 1,900 insertions

## Accomplishments

- `captioner.ts`: the vision call of `processImageDocument` (same model, same prompt text, same data-URL message) as one module with an abort-aware signature and a test setter. A test reads `document-processor.ts` and fails if the prompt literal or the model drifts.
- `image_caption` is registered in `CHUNKERS`; `profileFor(source, docType)` gives an `image_upload` document that chunker whatever type resolved, and is applied at identify, refinement, parse restore and resume.
- Parse turns an image under that profile into an empty Markdown with one picture of the original (parser `text`, version `image`) and records the public URL, context and media type in the images state slice. The images stage captions once inside the request budget, stores `caption-1.txt`, scans the caption, and builds the single chunk (`chunk_kind image`, `page_start 1`, `metadata.image_url`).
- `POST /api/upload`: the session lookup stays first and unchanged. Under unified with `process_rag` true the scope is resolved in the request (membership-checked organization, `s:default` in single-tenant, `checkAdmin` for `upload_source=config_upload` with the identity-match rule) before any storage write, and `ingest` runs in one `after()` callback.
- Two-tenant tests run the real route, ingest, writer SQL, retrieval, context assembly and the images list over PGlite in both modes.

## Task Commits

1. **Task 1: shared captioner, image_caption chunker, source rule (TDD)** - RED `56ef0c7`, GREEN `3189c5f`
2. **Task 2: whole-image parse and the images stage (TDD)** - RED `0af7427`, GREEN `fae78b8`
3. **Task 3: upload route switch with after() and scope resolution (TDD)** - RED `903d067`, GREEN `328af4c`

`commits: 6` is measured from the ledger base `14f30e5`.

## Behaviour changes (all under RAG_INGEST_PIPELINE=unified with process_rag true; legacy is untouched)

- An image upload is ingested through `ingest()` in `after()`. The upload response is unchanged.
- Documents carry `source image_upload`, `source_key` = the storage path, `source_file_id` = the storage path, `parser_used text`, `parser_version image`; the chunk carries `image_url`, `image_type`, `image_context`, `document_title` and the usual chunk fields.
- Identical image bytes uploaded again by the same tenant are skipped as a duplicate (legacy created a second document).
- A caption with an injection phrase quarantines the document when `RAG_INJECTION_SCAN=quarantine`.
- A non-member `organization_id` or a failing `admin_users` lookup (config upload) is refused before any storage write; legacy never looked at either.
- The media type sent to the vision model is the file's type instead of one derived from its extension.
- An image file whose source is `image_upload` no longer goes to the Docling sidecar.

## Files Created/Modified

See the frontmatter. New files outside the plan's list: `image-options.ts` (URL and context validation shared by parse and images) and `write-path-image-upload-two-tenant.test.ts`.

## Decisions Made

See `key-decisions`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Every image had the same content hash**
- **Found during:** Task 2 design
- **Issue:** A picture parses to an empty Markdown, and `content_hash_dedup` hashes the parse text, so the second image of a tenant would have been skipped as a duplicate of the first.
- **Fix:** for the image_caption chunker the hash is taken over the file hash. Test: two different images produce different `rag_find_content_duplicate` hashes, the same bytes the same hash.
- **Files modified:** src/lib/rag/ingest/stages/dedup.ts
- **Committed in:** `fae78b8`

**2. [Rule 2 - Missing Critical] A resume after the images stage would have published a document with no chunk**
- **Found during:** Task 2 design
- **Issue:** `rehydrateFromStore` re-runs chunk, enrich and extract only; the caption chunk lives in memory, so a run that stopped between images and embed would have resumed with an empty chunk list and published nothing searchable.
- **Fix:** the caption is stored as `caption-1.txt` and recorded in the images slice; rehydrate runs the images stage again for caption-only documents (it reads the caption back, with no model call). Other documents keep the 03-17 behaviour (and 03-38 can extend it).
- **Files modified:** src/lib/rag/ingest/runner.ts, stages/images.ts
- **Committed in:** `fae78b8`

**3. [Rule 3 - Blocking] Edits outside the plan's file list**
- `types.ts` (ChunkKind image, ChunkResult.captionOnly, IngestWork.captionOnly and pictures, IngestOptions imageUrl and imageContext, the images slice fields), `stages/chunk.ts` (a caption-only document may have no text chunk), `stages/identify.ts`, `profiles/resolve-doc-type.ts`, `status.ts` and `stages/parse.ts` (the source rule wherever a profile is derived), `stages/scan-injection.ts` (the quarantine write became the exported `quarantineDocument`, one behaviour for both scans), `runner.ts`, `stages/dedup.ts`, and `image-options.ts` (new). All additive or one-line.
- **Committed in:** `3189c5f`, `fae78b8`

**4. [Plan interpretation] Pipeline modules load through dynamic import in the route**
- `tests/api/upload-route.test.ts` must pass unchanged and mocks `@/lib/rag` with `isAdminUser` only and `@/lib/logger` without `startup`. A static value import of `@/lib/rag` and `@/lib/admin-route-auth` made it fail (`logger.startup is not a function`). The switch is read with `await import('@/lib/rag')` inside a try (legacy on any failure), and `checkAdmin` and the resolvers are imported only in the unified branch. Legacy behaviour and that test file are unchanged.
- **Committed in:** `328af4c`

**5. [Plan interpretation] Captions are scanned regardless of the profile's own scan flag**
- The plan says captions go through `scanText` under quarantine mode; the scan stage honours `profile.scan_injection`. For captions the flag is ignored, because the text comes from a model reading an untrusted picture. No profile in the data has the flag off today.

**6. [Plan interpretation] One after() callback for all images, four at a time**
- The plan says "after()"; several images in one request cannot run sequentially inside 55 s (each caption takes seconds), so they run in groups of four, each with what is left of the budget. A document that runs out of time stays `processing` and is resumable.

**Total deviations:** 6 (1 bug, 1 missing-critical, 1 blocking, 3 interpretations). **Impact:** all serve the plan's own truths; no scope creep, no new package, migration or environment variable.

## TDD Gate Compliance

Each task has a `test(03-32)` commit followed by a `feat(03-32)` commit. `gsd_run check tdd-red-evidence` was not run: earlier plans found it rejects vitest output and `workflow.tdd_mode` is off. The RED assessment is manual, from the vitest output of each RED commit; every failure was an assertion.

- **Task 1 RED (`56ef0c7`):** 13 of 21 failed on assertions (`expected '' to be 'Describe this image in extreme detail...'`, `expected [ 'markdown_sections', ... ] to include 'image_caption'`, `expected 'legal_clauses' to be 'image_caption'`, the registered list). The stubs (`captioner.ts`, `image-caption.ts`, a pass-through `profileFor`) let the tests load. The chunk-dispatch case for an unknown kind passed as a guard.
- **Task 2 RED (`0af7427`):** 14 of 15 failed on assertions (`expected 'failed' to be 'ready'`, `expected null to deeply equal { nextIndex: 0, ... }`, `expected [] to have a length of 1`); the guard that non-image documents keep the images-stage switch behaviour passed. One GREEN-time failure was a wrong expectation of mine (lexical text is lower-cased) and was fixed in the test.
- **Task 3 RED (`903d067`):** 14 of 47 failed in the route file (`expected 200 to be 403`, `expected [] to have a length of 1` for the missing after() call, no-session cases passed as guards of the existing check) and 8 of 10 in the two-tenant file (`expected [] to have a length of 1`, `expected 200 to be 403`, `the image document of tenant A exists: expected undefined to be truthy`). Two of my first harness versions failed on the harness itself (a logger mock without `startup`; reading `scope` of a missing ingest call) and were fixed before the RED commit.

## Issues Encountered

- The fake edge serves GET and RPC only, so the images list in the two-tenant test runs through `tests/helpers/pglite-admin.ts` over the same database.
- The two-tenant test registers its `@/lib/supabase` wrapper with `vi.doMock` per fixture start: a hoisted `vi.mock` kept the first fixture's edge URL after `vi.resetModules()` and the single-tenant run wrote to a closed server.

## Gate Results (worktree /home/user/wt/03-32, branch exec/03-32)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 150 files, 2142 tests passed (includes `tests/rag/langfuse-pins.test.ts`, no ENOENT) |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 284 tests: 281 passed, 0 failed, 3 skipped (single-tenant variants skipped by design in earlier plans) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 758 files, no violations |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables (no new variable) |
| rag-sidecar pytest, eval pytest | not run: no Python and no sidecar file touched (the orchestrator runs eval pytest) |

Plan verification: `npx vitest run tests/api/admin-auth.test.ts tests/api/config-admin-routes.test.ts tests/api/upload-route.test.ts tests/chat-source-images.test.ts tests/rag/images-route.test.ts` pass (inside the full run). The full vitest and rag-db runs were made on a machine shared with other executors (load average about 25) and passed without a timing flake.

Plan acceptance: `grep -c IMAGE_CAPTION_PROMPT captioner.ts` 2 (EXPECT >=1); `captioner.test.ts` 13 passed (>=4); `grep -c captionImage stages/images.ts` 2 (>=1); `grep -c image_upload route.ts` 1 (>=1); `grep -c "after(" route.ts` 2 (>=1); `grep -c "Authentication required" route.ts` 2 (>=1); `tests/api/upload-route.test.ts` 6 passed, file unchanged (>=4); `grep -c checkAdmin route.ts` 3 (>=1); `grep -c requireRagAdmin route.ts` 0 (==0); `grep -c mintAdminSessionValue write-path-image-upload.test.ts` 3 (>=1); `write-path-image-upload.test.ts` 47 passed (>=18).

## Threat Surface

T-03-92: captions scanned with the SEC-01 matcher, quarantine on a match (unit and two-tenant tests). T-03-93 and T-03-151: the session check is first and unchanged in both pipelines; admin workspace scope only for `checkAdmin` ok with the session user id; forged cookie, non-admin and identity mismatch tests; 503 before storage; the cookie never changes the storage prefix. T-03-141: tests prove no storage write, legacy processing, scope resolution, ingest or after() without a session in both modes and both pipelines. T-03-94: `after()` with a deadline-bounded budget; a document out of time stays processing and resumable. No new endpoint, table or package. One new input: `options.imageUrl` is validated (http or https, no whitespace or control characters, at most 2048 characters) before it reaches chunk metadata, and `imageContext` is capped at 2000 characters and never embedded.

## Known Stubs

None.

## Follow-ups and operator actions

- **Config UI uploader does not send `upload_source=config_upload`.** `scripts/config-ui/index.html` (`uploadKBImage`) posts `files`, `process_rag` and `image_context` to `/api/upload`. Until it adds the field (plan 03-31 or 03-43 owns the Config UI), a Config UI image upload resolves the session scope, which for an admin without an organization is the same personal or `s:default` scope the admin workspace resolver would give.
- No new environment variable, migration or package. The vision call uses the same OpenAI key as legacy.
- To use it: `RAG_INGEST_PIPELINE=unified`; optionally `RAG_INJECTION_SCAN=quarantine`. Off or `legacy` is today's behaviour.
- Plan 03-48 live check: one real image upload on a deployed project (caption quality, time inside 60 s, `after()` completing).
- `documents.processing_profile_id` of an image upload is the resolved type's profile id; an operator filtering by profile should filter by `source = 'image_upload'` instead.

## Next Phase Readiness

- 03-38 can reuse `captionImage`, `captionArtifact` naming (`caption-<n>.txt`), the images slice (`nextIndex`, `captioned`), `quarantineDocument` and `ctx.work.pictures`; the non-caption branch of the images stage is still the 03-13b switch behaviour, and rehydrate runs the images stage again only for caption-only documents.
- 03-37 and 03-43 see image documents as ordinary documents with `status` from the column.

## Self-Check: PASSED

All seven created files exist on disk. Commits `56ef0c7`, `3189c5f`, `0af7427`, `fae78b8`, `903d067` and `328af4c` are ancestors of HEAD; the measured count from the ledger base `14f30e5` is 6.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
