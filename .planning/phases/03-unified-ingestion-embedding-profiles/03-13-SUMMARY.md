---
phase: 03-unified-ingestion-embedding-profiles
plan: 13
subsystem: ingestion
tags: [ingest, stage-runner, rag-writer-rpc, markdown-chunker, tenant-scope, pgvector]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "0310 writer RPCs (03-03), profile lookup and hashing (03-02, 03-06), embedding text and token helpers (03-06, 03-10)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "TenantScope minting, scopeKey, assertTenantScope, runRetrieval, RpcClient"
provides:
  - "ingest() in src/lib/rag/ingest/index.ts: Markdown upload to a ready version-1 document retrievable only by its tenant"
  - "INGEST_STAGES (all thirteen D-02 names) and runIngestStages with the eight tracer stages registered, one module each"
  - "writer.ts as the only caller of the rag_* writer RPCs, with IngestWriterError(rpc, code)"
  - "Markdown section chunker (heading stack to section_path, token budget on the embedding text)"
  - "IngestState declared with every slice later stages fill"
affects: [03-13b, 03-14, 03-15, 03-16, 03-28]

tech-stack:
  added: []
  patterns:
    - "One module per D-02 stage, registered in runner.ts; stages read the processing profile, never a doc type (D-13)"
    - "All writer RPCs go through writer.ts; tenant key and ids derive only from the minted scope (no user id for s:default)"
    - "Writer errors carry RPC name and code only; one [Ingest] log line per failure with no row content"

key-files:
  created:
    - src/lib/rag/ingest/types.ts
    - src/lib/rag/ingest/deps.ts
    - src/lib/rag/ingest/runner.ts
    - src/lib/rag/ingest/writer.ts
    - src/lib/rag/ingest/identity.ts
    - src/lib/rag/ingest/index.ts
    - src/lib/rag/ingest/stages/identify.ts
    - src/lib/rag/ingest/stages/dedup.ts
    - src/lib/rag/ingest/stages/parse.ts
    - src/lib/rag/ingest/stages/chunk.ts
    - src/lib/rag/ingest/stages/embed-write.ts
    - src/lib/rag/ingest/stages/publish.ts
    - src/lib/rag/ingest/chunkers/markdown-sections.ts
    - tests/rag-db/ingest-tracer.test.mts
    - tests/rag/ingest/markdown-sections.test.ts
  modified: []

key-decisions:
  - "embed and write run as one batched loop in stages/embed-write.ts (research Pattern 1) so vectors never live outside the database"
  - "IngestDeps holds only db (admin RpcClient), embedDocuments, now, randomId and ingestEnv; later plans add services in their own modules"
  - "Single-tenant writes send no user id (Open Question 6 resolved)"

patterns-established:
  - "Stage module per D-02 name registered in REGISTERED_STAGES; a type-level check fails the build if INGEST_STAGES misses a StageName"
  - "Recording fake RpcClient injected through ingest/deps.ts test setters to pin writer behaviour"

requirements-completed: [DATA-01, DATA-04, CHK-01]

actuals:
  tokens: 18000
  tasks: 2
  commits: 3

plan_head_before: 1bb17723d342d0193e1279efa9dda871088dbcd4
plan_head_after: 7a4e1eee3f74412e52d6a5e2b78121c75ebb3fd8

coverage:
  - id: D1
    description: "ingest() turns a Markdown upload into a ready version-1 document whose chunks runRetrieval returns for tenant A and never for tenant B"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-tracer.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Chunks carry section_path, plain content, buildEmbeddingText embeddings at version 1 and the legacy metadata keys"
    requirement: CHK-01
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-tracer.test.mts"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/markdown-sections.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Duplicate bytes, CRLF content duplicates, unreadable PDFs, writer RPC failures and unminted scopes end in the specified result without leaking content or writing chunks"
    requirement: DATA-04
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-tracer.test.mts"
        status: pass
    human_judgment: false
  - id: D4
    description: "writer.ts is the only caller of the rag_* writer RPCs and INGEST_STAGES lists the thirteen D-02 names in order"
    requirement: DATA-01
    verification:
      - kind: other
        ref: "grep gates in 03-13-PLAN.md acceptance criteria; node scripts/ci/check-rag-boundary.mjs"
        status: pass
    human_judgment: false

duration: resumed-session
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 13: Ingest Tracer Summary

**ingest() runs a Markdown upload through the eight tracer D-02 stages (identify, file_hash_dedup, parse, content_hash_dedup, chunk, embed, write, publish) via the 0310 writer RPCs to a version-1 document that runRetrieval returns for its own tenant only**

## Performance

- **Duration:** not measured. This plan ran across two sessions and the first was interrupted, so a wall-clock figure would be wrong.
- **Completed:** 2026-11-24
- **Tasks:** 2 (tracer task plus one TDD task, three commits)
- **Files modified:** 15 created, 0 edited (1806 insertions)

## Accomplishments
- One Markdown upload goes from `ingest()` to a ready, current, tenant-scoped chunk set, retrieved through the Phase 2 `runRetrieval` for tenant A and absent for tenant B of the two-tenant fixture.
- `INGEST_STAGES` lists all thirteen D-02 names; `REGISTERED_STAGES` runs the eight tracer stages in order, each in its own module. A compile-time check fails if a `StageName` is missing from the list. Plan 03-13b registers the other five.
- `writer.ts` wraps every 0310 function and is the only file under `src` naming the writer RPCs. Tenant key comes from `scopeKey(scope)`, user and org ids from the scope only, with no user id for an `s:default` scope. Failures surface as `IngestWriterError(rpc, code)`.
- Markdown section chunker: heading stack to `section_path`, sections packed to the profile `max_tokens` measured on `buildEmbeddingText`, no splitting of table rows or list items, plain chunk content with no path or `Document: X. Chunk n of m` prefix, and the legacy metadata keys (`document_title`, `chunk_index`, `chunk_position`, `total_chunks`).
- Duplicate, unreadable-file and writer-error branches are pinned: same bytes twice returns `skipped_duplicate` with `duplicateOf`; CRLF re-save is caught by `content_hash_dedup`; a PDF ends `failed` with `parser_unavailable` and its version is marked failed; an unminted scope is refused before any RPC; a 57014 failure on `rag_write_chunks` leaks no document text into the error or the single `[Ingest]` log line.

## Task Commits

1. **Task 1: End-to-end Markdown ingest to retrieval (tracer)** - `dcf1406` (feat)
2. **Task 2: duplicate, unreadable-file and writer-error branches (TDD)**
   - RED: `f6e85d7` (test)
   - GREEN: `7a4e1ee` (feat)

**Plan metadata:** committed after this file (docs: complete plan)

The tracer gate ran in interactive `end-of-phase` mode with an automated-only `<verify>`: the verify command was re-run end to end and passed before expansion to Task 2.

## Files Created/Modified
- `src/lib/rag/ingest/types.ts` - IngestSource, IngestInput (with request deadline), IngestResult, IngestState with all later slices, StageName, StageContext
- `src/lib/rag/ingest/deps.ts` - IngestDeps getter and test setters
- `src/lib/rag/ingest/runner.ts` - INGEST_STAGES, REGISTERED_STAGES, runIngestStages, failure marking and logging
- `src/lib/rag/ingest/writer.ts` - the only caller of the rag_* writer RPCs; IngestWriterError
- `src/lib/rag/ingest/identity.ts` - buildSourceKey, normalizeFilename
- `src/lib/rag/ingest/index.ts` - ingest() and public types
- `src/lib/rag/ingest/stages/*.ts` - identify, dedup (file and content hash), parse, chunk, embed-write, publish
- `src/lib/rag/ingest/chunkers/markdown-sections.ts` - Markdown section chunker
- `tests/rag-db/ingest-tracer.test.mts` - ten DB-backed tests
- `tests/rag/ingest/markdown-sections.test.ts` - chunker unit tests

## Decisions Made
- embed and write share one module and loop (research Pattern 1); they still report separate stage outcomes, spans arrive with 03-13b.
- Legacy profile only embeds through the existing path; dims asserted 1536. Multi-profile targets stay with 03-28.
- F-12: the request deadline is declared on IngestInput; enforcement in every stage is 03-13b's.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Chunker unit tests added outside the plan's file list**
- **Found during:** Task 1
- **Issue:** The chunker packs by token budget and never splits table rows or list items; the DB test alone does not pin those edge rules.
- **Fix:** Added `tests/rag/ingest/markdown-sections.test.ts` (vitest, no DB).
- **Files modified:** tests/rag/ingest/markdown-sections.test.ts
- **Verification:** `npx vitest run` passes (120 files, 1541 tests).
- **Committed in:** dcf1406

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Test-only addition, no scope creep.

## TDD Gate Compliance

Task 2 has a `test(03-13)` commit (`f6e85d7`) followed by a `feat(03-13)` commit (`7a4e1ee`); no refactor commit. I did not witness the RED run myself: the commits were restored from a patch after an interrupted session, and no RED evidence record exists in this worktree, so `check tdd-red-evidence` was not re-run. The RED commit message names the five new cases (it does not record the failure output). I re-verified GREEN: all ten tracer tests pass at HEAD.

## Issues Encountered
- The restored history carries a different `Claude-Session` link than the one supplied for this run, because the first session produced those commits. Left as is, since rewriting history is out of bounds.
- The plan commit ledger did not exist after the restore. I created it with base `1bb1772` (the last commit before this plan's work) so the measured commit count is 3.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 120 files, 1541 tests passed |
| `node --import tsx --test tests/*.test.mts` | 143 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 158 tests: 155 passed, 0 failed, 3 skipped (single-tenant variants that need a second tenant or a content_type/slug column, skipped by design in earlier plans) |
| `node --import tsx --test tests/rag-db/ingest-tracer.test.mts` | 10 passed, 0 failed (criteria: at least 3 and at least 8) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 670 files, no violations |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run, sidecar untouched |
| tests/rag/langfuse-pins.test.ts | passed here, no ENOENT |

Acceptance greps: writer RPC names 10 (EXPECT >=3), stage names in runner 5 (EXPECT >=4), `export async function ingest` 1 (EXPECT >=1), `IngestWriterError` in writer 8 (EXPECT >=2). Checked by grep: no doc-type comparisons in stages or chunker, no chunk prefix, no model identifiers, and the only log lines are the four fixed `[Ingest]` lines that carry stage, reason, RPC and code only.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. The five unregistered D-02 stages are a planned hand-off to 03-13b, not stubs.

## Next Phase Readiness
- 03-13b can register store_original, scan_injection, enrich, extract and images, add the deadline, state persistence, resume and spans, and export from `@/lib/rag`.
- No blockers. No new packages were installed or locked.

## Self-Check: PASSED

All fifteen created files exist on disk. Commits `dcf1406`, `f6e85d7` and `7a4e1ee` are ancestors of HEAD, and the measured count from the ledger is 3.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
