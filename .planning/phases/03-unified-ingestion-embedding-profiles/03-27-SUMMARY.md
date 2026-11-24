---
phase: 03-unified-ingestion-embedding-profiles
plan: 27
subsystem: ingestion
tags: [parser-chain, llamaparse-v2, docling, sidecar-client, polling, resume, fallback]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "sidecar parse job API (03-12), Docling adapter and ParseResult contract (03-15, 03-02), object store and artifacts (03-17), Docling chunk slot on IngestWork (03-19), refineDocTypeAfterParse (03-22), recorded fixtures and manifest (03-25), ingest switches (03-03)"
provides:
  - "parsers/chain.ts: buildParserChain and parseWithFallback (configured parser, the other parser, plain text for txt, md, csv; no_parser_available otherwise)"
  - "parsers/llamaparse-v2.ts: LlamaParse API v2 adapter (per-page Markdown, heading levels and tables from items, pictures with page, partial pages, image host allow-list)"
  - "parsers/sidecar-docling.ts: sidecar client (multipart submit, schema-validated responses, budgeted polling, resume, one resubmit, artifact download)"
  - "parsers/plain-text.ts and parsers/shared.ts (parser interface, ParserError reason codes, backoff, fetch helpers)"
  - "parse stage on top of the chain with ParseResult.chunks into ctx.work.parseChunks, saved job id, refinement and at most one re-parse"
  - "tests/helpers/fake-llamaparse.ts and fake-sidecar.ts (http servers; the sidecar one serves recorded results from the fixture manifest by file_sha256)"
affects: [03-29, 03-31, 03-32, 03-38, 03-39, 03-41, 03-48]

actuals:
  tokens: 31600
  tasks: 3
  commits: 6
plan_head_before: 65c5b7fec2be3a12c7e444f38c1bc4f50f947053
plan_head_after: af1ccb38a4ffa7072ae4e9fce4c5dff8f2676451

tech-stack:
  added: []
  patterns:
    - "Parsers are objects behind per-module getters with set/reset test seams, like deps.ts; the chain calls the getters"
    - "A parser failure is a ParserError carrying a short reason code; no URL, key, secret, header, response body or document text enters an error or a log line"
    - "fetch with redirect manual and a combined abort/timeout signal, so a header carrying a secret cannot follow a redirect"

key-files:
  created:
    - src/lib/rag/ingest/parsers/shared.ts
    - src/lib/rag/ingest/parsers/plain-text.ts
    - src/lib/rag/ingest/parsers/chain.ts
    - src/lib/rag/ingest/parsers/llamaparse-v2.ts
    - src/lib/rag/ingest/parsers/sidecar-docling.ts
    - tests/helpers/fake-llamaparse.ts
    - tests/helpers/fake-sidecar.ts
    - tests/rag/ingest/parser-chain.test.ts
    - tests/rag/ingest/llamaparse-v2.test.ts
    - tests/rag/ingest/sidecar-client.test.ts
  modified:
    - src/lib/rag/ingest/stages/parse.ts
    - src/lib/rag/ingest/artifacts.ts
    - src/lib/rag/ingest/runner.ts
    - tests/rag/ingest/runner.test.ts
    - tests/rag-db/ingest-tracer.test.mts

key-decisions:
  - "LlamaParse refuses to run without a minted TenantScope (reason scope_unverified) and the chain skips it, so there is no anonymous path to its spend; no route or export that reaches it was added"
  - "Pending versus timeout: a job still running when the poll budget ends is pending (the stage yields processing and a resume polls it); timeout is a single request over its limit or a job older than 15 minutes"
  - "A resume starts the chain at the parser that owns the saved job, so a parser that already failed is not paid for again"
  - "A type refined after parse is written to the document row at once (doc_type, origin, profile), so a resume between parse and enrich rebuilds the refined profile; a re-parse is skipped when plain text parsed the file"
  - "Docling chunks are stored as chunks.json next to parse.md and rehydrateFromStore restores them, so a resumed Docling run chunks like an uninterrupted one (03-19 follow-up)"
  - "Artifact names may contain hyphens (picture-1.png), so the stored name equals the ParseResult image_ref"
  - "Presigned LlamaCloud image URLs: https, no port, no credentials, host llamaindex.ai or a subdomain or an S3 bucket host, no redirects, and the API key is never sent to them"

patterns-established:
  - "Poll deadline = min(start + RAG_PARSE_POLL_BUDGET_MS, request deadline - 3 s); under 2 s left the stage yields before starting a parser"

requirements-completed: [DATA-05]

coverage:
  - id: D1
    description: "The parse stage tries the configured parser, then the other, then plain text for txt, md and csv; anything else ends failed with no_parser_available; parser_used and parser_version record what ran and each fallback logs [Ingest] with its reason"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/parser-chain.test.ts#parseWithFallback and #the parse stage"
        status: pass
    human_judgment: false
  - id: D2
    description: "LlamaParse is skipped without a key and falls back on an HTTP error, a FAILED job or a timeout; Docling is skipped on 503 docling_unavailable, 429 and 401 and falls back the same way"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/parser-chain.test.ts#parseWithFallback; tests/rag/ingest/llamaparse-v2.test.ts; tests/rag/ingest/sidecar-client.test.ts#401, 503 and 429"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both parsers return a validated ParseResult; the sidecar's docling.json and picture artifacts are copied into the version's storage; a result failing ParseResultSchema is rejected"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/sidecar-client.test.ts#a result that fails ParseResultSchema is rejected; tests/rag/ingest/parser-chain.test.ts#a PDF falls back from an unconfigured LlamaParse to Docling"
        status: pass
    human_judgment: false
  - id: D4
    description: "The job id is saved before polling; polling backs off inside the budget and the request deadline; time running out yields processing and a resume polls the same job, a 404 or expired job being resubmitted once"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/sidecar-client.test.ts#polling follows the 500 ms doubling schedule and #a resume with a saved job id; tests/rag/ingest/parser-chain.test.ts#a job that is still running yields processing"
        status: pass
    human_judgment: false
  - id: D5
    description: "refineDocTypeAfterParse may change an auto type once; a changed parser profile re-parses once, never more; a picked type is never refined"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/parser-chain.test.ts#a refinement that switches general to scanned_image, #does not change parser options, #a picked type"
        status: pass
    human_judgment: false
  - id: D6
    description: "Fixture PDFs (table and scan) are parsed by the sidecar job with LlamaParse unconfigured and parser_used records docling (success criterion 4)"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/sidecar-client.test.ts#fixture PDFs through ingest() with the sidecar and no LlamaParse key"
        status: pass
    human_judgment: false
  - id: D7
    description: "LlamaParse v2 request and response shapes against the live service (upload response field, status location, items and bbox shapes, presigned image hosts)"
    requirement: DATA-05
    verification: []
    human_judgment: true
    rationale: "Built from the research notes and a local fake; no live key was available. Plan 03-48 live item 1 must confirm the shapes and the image host list before RAG_PARSER=llamaparse is relied on under the unified pipeline"

duration: not measured
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 27: Switchable parser, fallback chain and sidecar Docling client Summary

**The parse stage now runs a configured-then-other-then-plain-text parser chain over a LlamaParse v2 adapter and a schema-validated sidecar Docling client with budgeted polling, a saved job id, resume and one resubmit; Docling chunks reach the chunk stage and parser_used records what ran**

## Accomplishments
- `buildParserChain` resolves the profile preference (`configured` from RAG_PARSER), appends the other parser, then plain text for txt, md and csv; an invoice profile tries Docling first. `parseWithFallback` skips unavailable parsers and falls back on a `ParserError` with a logged reason (`missing_key`, `http_500`, `job_failed`, `timeout`, `docling_unavailable`, `http_429`, `scope_unverified`, ...). An abort is not a fallback. A PDF with no parser ends `failed` with `no_parser_available`.
- LlamaParse v2: multipart `file` and `configuration {tier, version: latest}` with the bearer key (fast, balanced to cost_effective, premium to agentic), polling with `expand=markdown,items,images_content_metadata`, page-ordered Markdown, heading levels and HTML tables rewritten from items, failed pages give `partial` plus a warning, image items become pictures with page and area share. Images are fetched only over https from LlamaCloud or S3 hosts, never through a redirect and never with the key.
- Sidecar client: builds the `ParseJobRequest` from the profile, sends `input_format` pdf, docx, html or image (png, jpeg, tiff), the file as `input.bin` and the `x-sidecar-secret` header, validates every response with the generated Zod schemas, downloads the listed artifacts and deletes the job afterwards.
- Polling: 500 ms doubling to 5 s inside `min(start + RAG_PARSE_POLL_BUDGET_MS, deadline - 3 s)`; the job id is saved with `saveState` before the first poll; a job still running yields `processing` (reason `parse_pending`); a resume polls the same job; a 404 or `expired` job is resubmitted once, then `job_lost`.
- The stage sets `ctx.work.parseChunks` from `ParseResult.chunks`, stores `parse.md`, `docling.json` (via `DOCLING_ARTIFACT`), picture artifacts and `chunks.json`, calls `refineDocTypeAfterParse` and re-parses at most once.

## Task Commits
1. **Task 1: plain-text parser, the chain and the parse stage** - RED `9ffb8c0`, GREEN `b3ba106`
2. **Task 2: LlamaParse v2 adapter with its fake** - RED `0280070`, GREEN `a2ac95d`
3. **Task 3: sidecar Docling client** - RED `f893924`, GREEN `af1ccb3`

`commits: 6` is measured from the ledger base `65c5b7f`.

## Behaviour changes (all under RAG_INGEST_PIPELINE=unified; legacy is untouched)
- A PDF no parser can read now fails as `no_parser_available` (was `parser_unavailable`); `tests/rag-db/ingest-tracer.test.mts` was updated to the new reason.
- `.csv` files are rendered as a Markdown table (header, separator, rows) instead of raw text. `.md` and `.txt` give the same text as before (BOM stripped), parser `text`, version `native`.
- With a LlamaParse key set, a `.md`, `.txt` or `.csv` upload goes to LlamaParse first (D-19 order) and uses plain text only as the last resort. With no key and no sidecar URL (the defaults) text-like files behave as before. Text passed directly to `ingest()` (scrapers, ai-to-rag, tests) never reaches a parser.
- Documents with `docType: 'auto'` may change type after parse (03-22 design), and a changed type is written to the row at once.
- A resumed run restores Docling chunks from `chunks.json` (one extra object-store `get` on resume).

## Deviations from Plan

**1. [Rule 2 - Missing Critical] Resume must reproduce Docling chunking** (Task 1) - `runner.ts` and `artifacts.ts` are outside the file list. `PARSE_CHUNKS_ARTIFACT` (`chunks.json`) is saved by the parse stage and `rehydrateFromStore` loads it into `ctx.work.parseChunks` (validated with the generated schema). Updated the 03-17 runner test that pinned the exact `get` calls on resume.

**2. [Rule 3 - Blocking] Artifact names with a hyphen** (Task 1) - `isArtifactName` rejected the sidecar's `picture-1.png`; the pattern now allows `[a-z0-9-]` in the stem so stored name equals `image_ref`.

**3. [Rule 2 - Missing Critical] Refined type persisted before resume can need it** (Task 1) - `persistRefinedType` writes doc_type, origin and profile after a refinement; without it a resume between parse and enrich rebuilt the old profile and chunked differently. A first draft compared doc types in the stage and failed the D-13 boundary check; the resume restore is now unconditional for auto-origin documents with a refined type.

**4. [Plan interpretation] `parsers/shared.ts` added** - holds the parser interface, `ParserError`, backoff, bounded body readers and the redirect-free fetch used by both adapters.

**5. [Plan interpretation] pending versus timeout** - "exceeding its time falls back with reason timeout" and "when time runs out the run yields processing" are both kept: a single request over its limit, or a job older than 15 minutes, is `timeout`; a job still running when the poll budget ends is pending.

**6. [Plan interpretation] Docling artifact failures are warnings** - a missing artifact gives the warning `artifact_unavailable`; a storage failure while saving artifacts fails the run as `store_parse_output_failed` like parse.md.

**7. [Existing test updated]** `tests/rag-db/ingest-tracer.test.mts` (reason string) and `tests/rag/ingest/runner.test.ts` (extra `chunks.json` get on resume).

**Total deviations:** 7 (2 Rule 2, 1 Rule 3 plus one boundary self-fix, 3 interpretations, 1 test update). No scope creep.

## TDD Gate Compliance
Each task has a `test(03-27)` commit followed by a `feat(03-27)` commit. `gsd_run check tdd-red-evidence` was not run: `workflow.tdd_mode` is off and earlier plans found it rejects vitest TAP output. RED was assessed by hand; every failure was an assertion against an inert stub (chain/plain-text stubs returning empty results; stub adapters returning `pending`), none a module-not-found.
- Task 1 RED: 22 of 23 failed (the 23rd, text passed to ingest, is a regression guard).
- Task 2 RED: 14 of 14 failed. Task 3 RED: 15 of 15 failed.
- One test of mine was wrong at GREEN (resume spec statuses) and was fixed in the test, not the code.

## Gate Results
| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 136 files, 1875 tests passed |
| `node --import tsx --test tests/*.test.mts` | 145 passed (one earlier run had 1 failure under machine load, passed on rerun; same flake 03-22 recorded) |
| `node --import tsx --test tests/rag-db/*.test.mts` | 229 tests: 226 passed, 0 failed, 3 skipped (single-tenant variants) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 726 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables (no new variable) |
| rag-sidecar pytest | not run, sidecar untouched; `uv.lock` and `package*.json` unchanged |

Acceptance: `LLAMA_CLOUD_API_KEY` in chain.ts plus llamaparse-v2.ts = 2 (EXPECT >= 1; it is 0 until Task 2); `/api/v2/parse` in llamaparse-v2.ts = 2 (>= 2); `ParseResultSchema` in sidecar-docling.ts = 2 (>= 1); parser-chain 23 passed (>= 9), llamaparse-v2 14 (>= 5), sidecar-client 15 (>= 7).

## Threat Surface
T-03-76: errors carry reason codes only; tests assert neither the LlamaParse key nor the sidecar secret appears in any error or console call. T-03-77: image URL allow-list, https only, no redirects, no key to image hosts (tested, including a redirecting image). T-03-78: every sidecar response goes through the generated schemas; LlamaParse is mapped field by field and the result re-validated with `ParseResultSchema`. T-03-79: request timeouts, 15 minute job age, poll budget, deadline reserve, processing status and resume. The sidecar secret is only sent, never compared, so no constant-time comparison is needed in this plan. T-03-SC: fetch only, no package change.

## Known Stubs
None.

## Known Limitations
- On the LlamaParse path chunk `page_start/page_end` stay null: the Markdown chunker has no page information and the ParseResult has no page-range field. Page numbers on that path need a later change (a page map in the contract or page markers).
- The list of pictures is not persisted. Picture bytes are stored as `picture-N.<ext>` equal to `image_ref` (listed in `processing_state.artifacts`); 03-38 has to rebuild the list from there and `docling.json`.
- `page_area_share` for a LlamaParse image without page size or 0..1 coordinates is 1 (never dropped on a guess).
- LlamaParse response shapes (D7) and the S3/llamaindex.ai image host list are unverified against the live service.

## Hand-offs
- 03-29: the extract stage can read `ctx.work.parseText` and `ctx.parserUsed`; Docling `docling.json` is saved with `saveArtifact(ctx, DOCLING_ARTIFACT, ...)`.
- 03-31 and later callers: `RAG_PARSER`, `RAG_PARSE_POLL_BUDGET_MS`, `LLAMA_CLOUD_API_KEY`, `LLAMACLOUD_PARSING_MODE`, `RAG_SIDECAR_URL`, `RAG_SIDECAR_SECRET` are read; none is new.
- 03-38: `MAX_IMAGES` (30) and `isAllowedImageUrl` are exported from `parsers/llamaparse-v2.ts`; LlamaParse pictures are already fetched and stored by the parse stage.
- 03-48: live item 1 also confirms the LlamaParse v2 shapes.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | retrospective / plan predates gate | n/a |
| Impeccable | retrospective | n/a |
| web-design-guidelines | retrospective (no re-audit this pass) | pass (all findings resolved) |

## Self-Check: PASSED
All ten created files exist, commits `9ffb8c0`, `b3ba106`, `0280070`, `a2ac95d`, `f893924` and `af1ccb3` are ancestors of HEAD, and the measured count from the ledger is 6.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
