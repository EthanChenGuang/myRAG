---
phase: 01-evaluation-harness-baseline
plan: 02
subsystem: testing
tags: [pglite, pgvector, postgrest, fake-edge, node-test, tsx, fixture-embedder]

requires:
  - phase: 01-01
    provides: tsx toolchain, npm ci --ignore-scripts workflow
provides:
  - PGlite fixture database loaded with the repo's own supabase/*-setup.sql (single and multi tenant) plus the fixture corpus
  - deterministic corpus loader (sorted relpath order, SHA-256 derived UUIDs, corpus hash)
  - deterministic 1536-dim fixture embedder (fixture-ngram v1)
  - 127.0.0.1 fake edge (PostgREST shim plus /v1/embeddings) backed by PGlite, serialized through one promise queue
  - fixtureProcessEnv placeholder overrides so no live key reaches a fake-backed process
  - tracer fixture eval/fixtures/corpus/en/refund-policy.en.md
affects: [01-04, 01-07, eval route, characterization tests, smoke tier]

plan_head_before: 3f5e75f0c4c5498540ec25586d0dc153f9ed1045
plan_head_after: c28e637f4d4e93d158d132b049cbc58f6e6f5aeb

actuals:
  tokens: 10700
  tasks: 2
  commits: 4

tech-stack:
  added: ["@electric-sql/pglite 0.5.17", "@electric-sql/pglite-pgvector 0.0.18"]
  patterns:
    - "Edge fakes as the injection seam: env points NEXT_PUBLIC_SUPABASE_URL and OPENAI_BASE_URL at a local server, then app code is imported dynamically"
    - "Repo SQL read from disk at harness start and executed unmodified inside PGlite behind a Supabase role/auth/storage shim"
    - "Fail loudly: unsupported edge requests are rejected and appended to errors rather than answered"

key-files:
  created:
    - eval/harness/corpus.mts
    - eval/harness/fixture-embedder.mts
    - eval/harness/pglite-supabase.mts
    - eval/harness/fake-edge.mts
    - eval/fixtures/corpus/en/refund-policy.en.md
    - tests/fixture-edge.test.mts
  modified:
    - package.json
    - package-lock.json
    - .gitignore

key-decisions:
  - "Embedder indexes the raw chunk text (what process-document embeds), not the stored 'Document: ... Content:' wrapper"
  - "PGRST116 406 responses are PostgREST-faithful behavior and are not appended to errors; only rejected or failed (PGlite error) requests are"
  - "limit and order are the only extra read parameters considered: limit is supported (the chat route uses it), order is rejected; rows are returned ORDER BY id for determinism"

patterns-established:
  - "Harness entry files are .mts and never statically import @/lib; app code is imported dynamically after fixtureProcessEnv is applied"
  - "Each PGlite database is built per deployment mode because the two SQL files define different match_document_chunks"

requirements-completed: [EVAL-06, EVAL-04]

coverage:
  - id: D1
    description: "createFixtureDatabase builds PGlite with vector and pg_trgm, executes the repo's single-tenant or multi-tenant SQL from disk, and inserts the corpus with fixture embeddings; multi-tenant documents.user_id is FIXTURE_USER_ID"
    requirement: EVAL-06
    verification:
      - kind: unit
        ref: "tests/fixture-edge.test.mts#single-tenant: loads supabase/single-tenant-setup.sql and inserts every corpus chunk"
        status: pass
      - kind: unit
        ref: "tests/fixture-edge.test.mts#multi-tenant: loads multi-tenant-setup.sql and sets documents.user_id to FIXTURE_USER_ID"
        status: pass
    human_judgment: false
  - id: D2
    description: "The unmodified enhancedRetrieveChunks, imported after fixtureProcessEnv, returns a refund-policy.en.md chunk through the fake edge with zero recorded errors"
    requirement: EVAL-06
    verification:
      - kind: integration
        ref: "tests/fixture-edge.test.mts#the unmodified enhancedRetrieveChunks returns a refund-policy.en.md chunk through the edge with zero errors"
        status: pass
    human_judgment: false
  - id: D3
    description: "Corpus ids and candidate order are identical across two builds (EVAL-04 ordering edge)"
    requirement: EVAL-04
    verification:
      - kind: unit
        ref: "tests/fixture-edge.test.mts#document and chunk ids are UUID-shaped and identical across two loads"
        status: pass
      - kind: unit
        ref: "tests/fixture-edge.test.mts#two database builds produce identical chunk ids and candidate order"
        status: pass
    human_judgment: false
  - id: D4
    description: "Fake edge binds 127.0.0.1, answers only the two retrieval RPCs and the documents/document_chunks reads, records unsupported requests in errors, and serializes concurrent RPCs"
    requirement: EVAL-06
    verification:
      - kind: unit
        ref: "tests/fixture-edge.test.mts#unsupported paths, functions, tables, columns and operators are rejected and recorded in errors"
        status: pass
      - kind: unit
        ref: "tests/fixture-edge.test.mts#ten concurrent rpc calls return the same rows as one sequential call"
        status: pass
      - kind: unit
        ref: "tests/fixture-edge.test.mts#listens on 127.0.0.1 only"
        status: pass
    human_judgment: false
  - id: D5
    description: "fixtureProcessEnv overwrites the four vendor/Supabase keys with placeholders and ignores the caller environment"
    requirement: EVAL-06
    verification:
      - kind: unit
        ref: "tests/fixture-edge.test.mts#fixtureProcessEnv overwrites vendor keys with placeholders and ignores the caller environment"
        status: pass
    human_judgment: false
  - id: D6
    description: "Production retrieval code and SQL stay byte-identical to commit 325a2c9"
    requirement: EVAL-06
    verification:
      - kind: other
        ref: "git diff --quiet 325a2c9 -- src/app/api/chat/route.ts src/lib/enhanced-rag-retrieval.ts src/lib/document-processor.ts src/lib/supabase.ts src/lib/thinking-rag-enhancer.ts supabase/ exits 0"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 02: Fixture Database and Fake Edge Summary

**Today's unmodified `enhancedRetrieveChunks` runs offline against the repo's real SQL in PGlite through a loud, serialized 127.0.0.1 PostgREST and OpenAI-embeddings shim, and finds the tracer refund-policy document**

## Performance

- **Duration:** about 15 min (start time was not captured at launch; estimate)
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 9 (6 created, 3 modified)

## Accomplishments
- `createFixtureDatabase` loads `supabase/single-tenant-setup.sql` or `supabase/multi-tenant-setup.sql` read from disk (never copied), including the real `m=64, ef_construction=200` HNSW index, and inserts the corpus with fixture embeddings; each build takes about 1.2 to 1.5 s.
- The real `enhancedRetrieveChunks` with the chat route's flags returns the `refund-policy.en.md` annual-plans chunk first (similarity 0.62 vs 0.48 for the near-duplicate monthly chunk and 0.13 for exceptions); the edge records zero errors and the calls are exactly `POST /v1/embeddings` and `POST /rest/v1/rpc/match_document_chunks`.
- Scratch-verified outside the committed tests: the multi-tenant path through `match_documents_by_workspace` also works end to end, and a different user id gets zero chunks, so tenant filtering is real in the fixture.
- Fake edge rejects and records any unsupported path, function, argument, table, column, operator, method or oversized body; all handling runs through one promise queue; ten concurrent RPCs equal one sequential call.

## Task Commits

1. **Task 1: Corpus loader, fixture embedder and PGlite fixture database** (TDD)
   - RED - `2796b68` (test)
   - GREEN - `1fdaf49` (feat)
2. **Task 2: 127.0.0.1 fake edge and the unmodified enhancedRetrieveChunks** (TDD)
   - RED - `89cf5da` (test)
   - GREEN - `c28e637` (feat)

**Plan metadata:** committed separately (docs: complete plan)

## TDD Evidence

- **Task 1 RED:** `node --import tsx --test --test-reporter=tap tests/fixture-edge.test.mts` exited 1 with 11 of 11 failing; `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (`target_test_failed`) for "reads files in sorted relative-path order, splits on chunk markers and builds stored content". Semantic assessment: the target ran against stub modules with the final exported signatures and failed at the unimplemented call. The first attempt was classified `INVALID_RED` (`invalid_record`: a `before` hook failure cancelled the run); fixed by building the databases lazily inside each test so failures surface as test failures, then re-recorded.
- **Task 1 GREEN:** 11 of 11 pass.
- **Task 2 RED:** same command exited 1 with the 11 Task 1 tests passing and the 10 fake-edge tests failing; `RED_EVIDENCE_OK` for "the unmodified enhancedRetrieveChunks returns a refund-policy.en.md chunk through the edge with zero errors". Semantic assessment: target failed at `startFakeEdge` (stub), no syntax, import or fixture faults.
- **Task 2 GREEN:** 21 of 21 pass.
- **Gate commits:** `test(01-02)` precedes `feat(01-02)` for both tasks. REFACTOR: none needed.

## Decisions Made
- Package checks before install (D-24, T-01-SC): `npm view` confirmed both packages come from electric-sql/pglite, integrity present, no install scripts; installed with exact pins and `--ignore-scripts`.
- Chunk embeddings use the raw chunk text, matching `process-document/route.ts` which embeds `batch[index]` and stores the `Document: ... Content:` wrapper separately.
- HTTP 406 `PGRST116` is PostgREST-faithful behavior for `.single()` and is not counted as an edge error; PGlite query failures and rejected requests are.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `limit` query parameter support to the table reads**
- **Found during:** Task 2
- **Issue:** The plan's read list covers `select` and `eq.` filters, but the chat route's document-reference path calls `.limit(30)` on `document_chunks`; rejecting it would fail the next consumer of the shim.
- **Fix:** `limit` accepts an integer from 1 to 1000; `order` and every other parameter remain rejected and recorded. Rows are returned `ORDER BY id` for determinism.
- **Files modified:** eval/harness/fake-edge.mts
- **Commit:** `c28e637`

**2. [Rule 2 - Missing Critical] Hardening beyond the plan's whitelist**
- **Found during:** Task 2 (threat T-01-03 mitigation)
- **Issue:** Filter values, vector text, `dimensions`, request size and HTTP methods needed validation to keep the "loud rejection" guarantee.
- **Fix:** `eq.` values must be UUIDs, vector text must match a numeric pattern, `dimensions` other than 1536 and any non-`float`/`base64` encoding are rejected, bodies over 5 MB get 413, wrong methods get 405; all recorded in `errors`.
- **Commit:** `c28e637`

**3. [Rule 3 - Blocking] Acceptance grep needed a literal SQL path**
- **Found during:** Task 2 verification
- **Issue:** The templated path `supabase/${deploymentMode}-setup.sql` would not satisfy `grep -c "single-tenant-setup.sql"`.
- **Fix:** Explicit `SQL_FILES` map naming both files; behavior unchanged, all 21 tests re-run green.
- **Commit:** `c28e637`

---

**Total deviations:** 3 (2 missing critical, 1 blocking). **Impact on plan:** none on scope; all additive inside planned files.

## Issues Encountered
- `npm i` ran with `--ignore-scripts` (same transitive onnxruntime-node postinstall constraint as plan 01-01); `package-lock.json` gained 19 lines and no existing entries changed.
- Task 1's tests live in the file the plan lists for both tasks, so the file was committed twice (RED for each task) as one growing test file.

## Known Stubs
None. The RED-phase stub modules were fully replaced in the GREEN commits.

## Threat Flags
None. The only new network surface is the 127.0.0.1 port-0 fake edge already covered by T-01-03; vendor keys are overwritten by `fixtureProcessEnv` (T-01-05).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 01-04 (eval route) can import `createFixtureDatabase`, `startFakeEdge` and `fixtureProcessEnv`, apply the env, then dynamically import `@/lib/enhanced-rag-retrieval`. Set `NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE` to match the database mode; `fixtureProcessEnv` does not set it.
- Plan 01-07 appends chunks after the three tracer chunks in `refund-policy.en.md` and must keep them unchanged; the first near-duplicate pair (annual vs monthly) is in place.
- `loadCorpus` returns `{ documents, corpusSha256 }` with the field names later verify commands read: `relpath, language, filename, imageUrl, createdAt, id, content, chunks[{ index, id, section, text, stored }]`.
- `createFixtureDatabase` returns `{ db, fixtureUserId, corpusSha256, sqlSha256 }` where `sqlSha256` is keyed by the SQL file that was loaded.
- Retrieval with init-env thresholds is bimodal (research Pattern 8): the pinned eval env snapshot arrives in a later plan; the tracer test uses the code's default thresholds.

## Self-Check: PASSED

All 6 created files exist, 4 task commits (`2796b68`, `1fdaf49`, `89cf5da`, `c28e637`) are ancestors of HEAD, `node --import tsx --test tests/fixture-edge.test.mts` reports 21 pass / 0 fail, and the protected-file `git diff --quiet 325a2c9` check exits 0.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
