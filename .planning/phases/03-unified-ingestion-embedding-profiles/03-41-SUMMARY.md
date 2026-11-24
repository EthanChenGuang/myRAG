---
phase: 03-unified-ingestion-embedding-profiles
plan: 41
subsystem: eval-harness
tags: [eval, ingest, fixture-mode, pglite, baseline, fake-sidecar, ci]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest() and the stage runner (03-13, 03-13b), object store (03-17), chunkers (03-19), injection scan (03-20), doc-type resolution (03-22), parser chain and sidecar client (03-27), dual-write embed stage (03-28), recorded fixtures and manifest (03-25), cross_lingual golden items and baseline (03-11)"
provides:
  - "createFixtureDatabase fixtureMode prechunked (default, unchanged) | ingest, and createEmptyFixtureDatabase (schema, migrations, fixture user)"
  - "buildIngestFixtureDatabase: the 13 corpus documents go through the real ingest() on PGlite behind the fake edge"
  - "installIngestFakes: fake sidecar over HTTP serving the recorded fixtures, always-unavailable LlamaParse stub, in-memory object store, fixture embedder; removed again by uninstall()"
  - "npm run test-rag -- --fixture-mode prechunked|ingest, ingestModeGoldenPaths() and mergeGoldenFiles()"
  - "eval/baselines/fixture-ingest-baseline.json (3 runs, spread 0) and baseline.py record --fixture-mode"
  - "CI: ingest-mode smoke gate on every pull request, enforced by check-workflows.py"
affects: [03-44, 03-45, 03-46, 03-48]

actuals:
  tokens: 25000
  tasks: 3
  commits: 5
plan_head_before: 14f30e5f426a8493e3d0e2f92eb9c2701749e02d
plan_head_after: 4ad9ba9ffa526bb8bc086e71b09d9ac8758ae271
commits: 5

tech-stack:
  added: []
  patterns:
    - "The ingest mode builds its database through its own fake edge and hands the running edge to the eval run (FixtureDatabase.edge), so the app modules, which read @/lib/env once at first import, only ever see one edge URL"
    - "Process variables the run needs are applied before the first app import (createFixtureDatabase processEnv), not after the database exists"
    - "Ingest-mode corpus_sha256 is sha256('fixture-mode:ingest' + corpus hash), so the existing gate refuses to compare an ingest run with the prechunked baseline and the reverse"
    - "Harness modules that import app code are loaded with import() after the environment is set"

key-files:
  created:
    - eval/harness/ingest-mode.mts
    - eval/harness/ingest-fakes.mts
    - eval/harness/process-env.mts
    - eval/baselines/fixture-ingest-baseline.json
    - tests/rag-db/ingest-mode.test.mts
    - tests/rag-db/ingest-mode-multi-tenant.test.mts
    - .planning/phases/03-unified-ingestion-embedding-profiles/deferred-items.md
  modified:
    - eval/harness/pglite-supabase.mts
    - eval/harness/run-eval.mts
    - eval/harness/run-smoke.mts
    - eval/src/rag_eval/baseline.py
    - eval/tests/test_baseline.py
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py
    - scripts/tests/test_check_workflows.py

key-decisions:
  - "Corpus documents enter ingest() as text with docType 'general' picked and source config_upload, not as files: the image document is named warehouse-floorplan.png, which no text parser takes, and text never reaches a parser, so the corpus run does not depend on the parser chain. The fakes are installed for the typed fixtures of plan 03-44 and proven here with a recorded PDF"
  - "The ingest baseline records what the unified pipeline produces today, including the documents.content gap (see Issues). It is not adjusted to look like the prechunked numbers; 03-44 re-records it"
  - "A single golden file is used as it is; several are concatenated into <out>/golden.merged.jsonl, so plan 03-44 adds its file to ingestModeGoldenPaths() without touching run-smoke.mts"
  - "The harness builds its own supabase client for ingest (fixtureAdminClient) instead of the app singleton, so a second build in one process (tests) talks to its own edge"

requirements-completed: [DATA-01, DATA-02]

coverage:
  - id: D1
    description: "Every corpus document is ingested through the real ingest() as a ready, current config_upload document of the fixture tenant (single-tenant s:default, multi-tenant u:<fixture user>); chunks are written by the unified writer with plain content, hashes, parser and a vector"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-mode.test.mts (every corpus document is a ready...; the chunks are written by the unified writer...)"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-mode-multi-tenant.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "No chunk marker and no fixture-meta line reaches a chunk, a lexical text, a document row or a hash; the stored content hash equals the hash of the stripped text"
    requirement: DATA-02
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-mode.test.mts#no chunk marker and no fixture-meta line reaches a chunk..."
        status: pass
    human_judgment: false
  - id: D3
    description: "Every approved gold quote of the fixture golden set (111 spans) lies inside a single ingest-mode chunk of its document, using the matcher's normalisation; the test lists any that do not"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-mode.test.mts#every gold quote of the fixture golden set lies inside a single chunk of its document"
        status: pass
    human_judgment: false
  - id: D4
    description: "The prechunked mode is unchanged: createFixtureDatabase without a mode inserts the same pre-cut rows, the Phase 2 two-tenant and differential tests pass, and the prechunked smoke gate passes with paired.all_zero true"
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-mode.test.mts#createFixtureDatabase without a fixture mode...; node --import tsx --test tests/two-tenant-fixture.test.mts tests/rag-legacy-differential.test.mts; npm run test-rag -- --out eval/out/final-prechunked"
        status: pass
    human_judgment: false
  - id: D5
    description: "The ingest mode has its own deterministic baseline (3 runs) and its smoke gate passes against it; gating one mode against the other's baseline fails on corpus_sha256"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "npm run test-rag -- --fixture-mode ingest --out eval/out/final-ingest; jq .passed == true; --baseline eval/baselines/fixture-baseline.json gives passed false with a corpus_sha256 mismatch"
        status: pass
    human_judgment: false
  - id: D6
    description: "installIngestFakes serves a recorded PDF through the real sidecar client (parser_used docling, original in the fake store) and uninstalls cleanly; LlamaParse is unavailable while installed"
    requirement: DATA-02
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-mode.test.mts#installIngestFakes serves a recorded PDF through the real sidecar client..."
        status: pass
    human_judgment: false
  - id: D7
    description: "CI runs the ingest-mode smoke gate after the prechunked one and uploads its output; check-workflows.py requires the step, its order, no --no-gate or foreign --baseline, and the upload"
    verification:
      - kind: unit
        ref: "scripts/tests/test_check_workflows.py#EvalSmokeJobTest (7 tests); python3 scripts/ci/check-workflows.py"
        status: pass
    human_judgment: true
    rationale: "The workflow has not run on a GitHub runner"
  - id: D8
    description: "The ingest-mode numbers say something true about unified ingestion: recall@5 0.273 against 0.519 prechunked is caused by documents.content being empty under unified ingestion (deferred-items.md), not by the chunks"
    verification: []
    human_judgment: true
    rationale: "The cause was shown by an uncommitted experiment (filling documents.content gave exactly the prechunked metrics); whether to fix the writer, and how, is a design decision for the orchestrator"

duration: about 60 min (start time was not captured)
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 41: Ingest fixture mode for the eval harness Summary

**The fixture corpus now goes through the real ingest() on PGlite with a fake sidecar, a stubbed LlamaParse, an in-memory object store and the fixture embedder (`--fixture-mode ingest`), with its own 3-run baseline and a CI gate, while the prechunked mode stays byte for byte what it was; the first honest numbers (recall@5 0.273 against 0.519) expose that unified ingestion leaves documents.content empty**

## Performance

- **Duration:** about 60 min (start time was not captured)
- **Completed:** 2026-11-24T09:15:00Z
- **Tasks:** 3 (Task 1 TDD)
- **Files:** 7 created, 8 modified (14 changed files in the five task commits)

## Accomplishments

- `createFixtureDatabase` takes `fixtureMode` (`prechunked` default, `ingest`) and an optional `processEnv`; the schema, migrations and fixture user moved into `createEmptyFixtureDatabase`, which both modes use. The prechunked insert code is the same statements in the same order; `ingest-mode.mts` is loaded with `import()` only for the ingest mode, so prechunked runs never import the ingest code.
- `buildIngestFixtureDatabase` starts a fake edge on the empty database, applies the fixture process environment (`process-env.mts`, extracted from `prepareInProcessEval`), installs the fakes, mints the fixture tenant's scope (`single`, or `personal` for the fixture user in multi-tenant) and ingests each corpus document (`doc.content`, which the corpus loader has already stripped of `<!-- chunk -->` markers and the fixture-meta line) as a picked-`general` `config_upload`. A document that does not end `ready`, or any request the edge refused, fails the build with the document and reason. The edge stays up and is handed to `prepareInProcessEval` through `FixtureDatabase.edge`.
- `installIngestFakes({ db })` replaces everything `ingest()` calls outside the database: the real `createSidecarParser` pointed at `tests/helpers/fake-sidecar.ts` (recorded ParseResults by file hash), an always-unavailable LlamaParse stub, the fake object store and `embedText` from the fixture embedder. `uninstall()` resets every setter and closes the sidecar. Test setters only; production modules keep their defaults (T-03-118).
- `run-smoke.mts`: `--fixture-mode prechunked|ingest`. In ingest mode the golden files come from `ingestModeGoldenPaths()` (one file today; several are merged into `<out>/golden.merged.jsonl`) and the default baseline is `eval/baselines/fixture-ingest-baseline.json`. `--fixture-mode ingest` with `--base-url` is refused. `baseline.py record --fixture-mode` forwards the flag.
- Ingest-mode `corpus_sha256` is `sha256('fixture-mode:ingest' 0x00 corpus hash)`. The gate already compares it, so an ingest run against `fixture-baseline.json` fails with `corpus_sha256 differs` and the reverse exits 2 (T-03-117, shown by hand).
- The ingest baseline holds 3 deterministic runs (spread 0): overall recall@5 0.273, recall@10 0.273, MRR 0.279, correct refusal 0.667, false refusal 0.701. All 111 gold quotes of the 114 approved items lie inside one chunk.
- `pr-smoke.yml` runs `npm run test-rag -- --fixture-mode ingest --out eval/out/smoke-ingest` after the prechunked smoke step and uploads both outputs in the existing artifact step.

## Task Commits

1. **Task 1: Ingest-mode database builder and harness fakes (TDD)**
   - RED `932f4c1` (test): 7 of 10 tests failed on assertions against inert stubs (no documents, no chunks, equal corpus hash, no parser installed, merge returning the first path)
   - GREEN `1461df4` (feat)
   - Fix `5d59306` (fix): the eval route variables must be in the environment before the ingest mode imports the app (see deviation 2)
2. **Task 2: --fixture-mode flag and the ingest-mode baseline** - `13ace72` (feat)
3. **Task 3: CI runs the ingest-mode smoke gate** - `4ad9ba9` (ci)

`commits: 5` is measured from the ledger base `14f30e5`.

## Files Created/Modified

See `key-files`. `eval/baselines/fixture-baseline.json` and every file under `eval/fixtures/` are unchanged.

## Decisions Made

See `key-decisions`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Files outside the plan's list**
- **Found during:** Task 1
- **Issue:** The ingest build has to import app code that reads `@/lib/env` once, so the environment setup and the database creation had to be reorganised, which touches `run-eval.mts` (not in the plan's file list) and needs a shared env function.
- **Fix:** New `eval/harness/process-env.mts` (`applyFixtureProcessEnv`, the block that was inline in `prepareInProcessEval`), `run-eval.mts` threads `fixtureMode` and reuses a handed-over edge, and `tests/rag-db/ingest-mode-multi-tenant.test.mts` covers the multi-tenant build (one build per process is the safe unit, so it is a separate file). `eval/tests/test_baseline.py` and `scripts/tests/test_check_workflows.py` gained tests for the new flag and checker.
- **Files modified:** eval/harness/run-eval.mts, eval/harness/process-env.mts, tests/rag-db/ingest-mode-multi-tenant.test.mts, eval/tests/test_baseline.py, scripts/tests/test_check_workflows.py
- **Committed in:** 932f4c1, 5d59306, 13ace72, 4ad9ba9

**2. [Rule 1 - Bug] Eval route answered 503 in ingest mode**
- **Found during:** Task 2 (first ingest smoke run: `route returned 503 (Eval endpoint is not configured)`)
- **Issue:** `RAG_EVAL_SECRET` and `RAG_EVAL_ALLOWED_SCOPES` were set after the database was built, but the ingest build had already imported `@/lib/env`, which keeps the values of that moment.
- **Fix:** `createFixtureDatabase({ processEnv })` carries them into the ingest build, which applies them with the rest of the fixture environment before its first app import; `prepareInProcessEval` generates the secret first.
- **Verification:** ingest smoke run and both gates pass; prechunked results are identical.
- **Committed in:** 5d59306

**3. [Plan interpretation] No recorded captioner**
- The plan lists a recorded captioner among the fakes. The `images` stage is still the placeholder that reports `image_chunks_unavailable` (plans 03-32 and 03-38 add captioning), so there is no seam to fake. `installIngestFakes` is the place to add it; 03-44 wires the PDF image fixture.

**4. [Plan interpretation] Corpus documents enter as text, not files**
- See `key-decisions`. The marker and fixture-meta stripping is the corpus loader's (P-19 was already satisfied there); the test proves no marker or meta text reaches a chunk, a lexical text, a document row or the hash.

**5. [Plan interpretation] corpus hash differs between modes**
- The plan says nothing about how the gate tells the modes apart; the baseline would have been accepted for either mode otherwise (the gate compares golden and corpus hashes, not chunks). Using the ingest-mode corpus digest keeps `FixtureDatabase`, the manifest contract and the prechunked hash unchanged.

---

**Total deviations:** 5 (1 Rule 3, 1 Rule 1, 3 interpretations). **Impact:** no scope creep; the harness behaves as specified.

## TDD Gate Compliance

- **RED (`932f4c1`):** 7 of 10 tests failed on assertions: `expected at least one chunk per document, got 0`, `there are chunks to inspect`, the corpus hashes equal, `ingest said failed` for the PDF (no parser installed), the merge returned the first path. The stubs build the empty database and edge (real infrastructure) but ingest nothing. Three tests pass at RED by design (prechunked default, unknown mode, golden path list). I added guards after the first RED run because the marker test passed vacuously on an empty database.
- **GREEN (`1461df4`):** 10 of 10 pass.
- `gsd_run check tdd-red-evidence` was not run: `workflow.tdd_mode` is off and earlier plans found it rejects node/vitest TAP output. Semantic assessment is manual.

## Issues Encountered

- **Unified ingestion leaves `documents.content` empty, and legacy retrieval reads it.** First ingest run: recall@5 0.273, false refusal 0.701, against 0.519 and 0.377 for the same corpus as pre-cut rows. A scratch experiment that set `documents.content` to the parsed text after ingestion (reverted, not committed) reproduced the prechunked metrics exactly (0.519, MRR 0.526, false refusal 0.377), so the chunks are not the cause. `rag_begin_document_version` inserts `content = ''`, `rag_set_document_fields` (0310) does not allow `content`, and `assemble.ts` keeps a chunk below the similarity threshold when a query term appears anywhere in its document's `content` (`isRelevantByName`); `content_preview` in sources reads it too. In production that means documents ingested under `RAG_INGEST_PIPELINE=unified` are filtered harder and show no preview. Logged in `deferred-items.md` with the fix location. The committed ingest baseline records the current behaviour; re-record it after the fix.
- Gold quotes: none straddles a chunk boundary in ingest mode (the test lists any that do).
- `npx vitest run` failed once with two tests and once with one (`tests/rag/injection-scan.test.ts` 1 MB timing bound, which passes alone, 45 of 45, and is the flake 03-28 recorded); the first run's second failure did not reproduce. `node --import tsx --test tests/rag-db/*.test.mts` failed one test once under load (`match_chunks_by_profile on the two-tenant fixture`); it passes alone and in the rerun (292 passed, 3 skipped).
- `tests/rag/langfuse-pins.test.ts` did not fail here.

## User Setup Required

None - no external service configuration, environment variable, migration or package change.

## Known Stubs

None. The captioner is not stubbed; it does not exist yet (deviation 3).

## Threat Flags

None. T-03-117: separate baseline, distinct corpus hash, cross-mode gating refused, prechunked parity re-checked in this plan (`paired.all_zero` true). T-03-118: the setters are called only from `ingest-fakes.mts` and tests, and `uninstall()` resets all of them; no production module imports the harness. T-03-SC: no package, lockfile or dependency change.

## Next Phase Readiness

- 03-44 adds its golden file to `ingestModeGoldenPaths()`, ingests the manifest fixtures inside `buildIngestFixtureDatabase` (the fakes are installed there; the sidecar fake records each upload's `request` for the parser-option assertions), extends `ingestCorpusSha256` with the typed-fixture manifest hash, and re-records the baseline. It should decide about `documents.content` first, because the new baseline depends on it.
- 03-45/03-46 can compare profiles in ingest mode through the same builder; `FixtureDatabase.edge` must be closed by whoever builds directly (as the tests do).
- Operator: the new CI step has not run on a runner.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 147 files; 2071 of 2072 passed on the last full run, the one failure is the injection-scan timing test (passes alone) |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 295 tests: 292 passed, 0 failed, 3 skipped (a one-off failure under load passed on rerun) |
| `tests/rag-db/ingest-mode.test.mts` + `ingest-mode-multi-tenant.test.mts` | 10 + 1 passed (criterion: at least 4) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 757 files |
| `python3 scripts/ci/check-workflows.py` and `uv run --directory eval python ../scripts/ci/check-workflows.py` | OK |
| `python3 -m unittest discover -s scripts/tests -p test_check_workflows.py` | 20 passed |
| `node scripts/check-config.mjs` | ok, 93 variables |
| `npm run test-rag -- --out eval/out/final-prechunked` | passed true, paired.all_zero true (recall@5 0.519, MRR 0.526) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/final-ingest` | passed true (7 skipped), paired.all_zero true (recall@5 0.273, MRR 0.279) |
| `(cd eval && uv run --all-extras --frozen pytest -q)` | 367 passed |
| rag-sidecar pytest | not run, sidecar untouched; `uv.lock` and `package*.json` unchanged |

Acceptance: `grep -c fixtureMode eval/harness/pglite-supabase.mts` = 5 (EXPECT >= 1); ingest-mode tests 10 passed 0 failed (EXPECT >= 4); `jq -e '.runs | length >= 3' eval/baselines/fixture-ingest-baseline.json` exit 0; `grep -c "fixture-mode ingest" .github/workflows/pr-smoke.yml` = 1 (EXPECT >= 1).

## Self-Check: PASSED

Created files exist (`eval/harness/ingest-mode.mts`, `ingest-fakes.mts`, `process-env.mts`, `eval/baselines/fixture-ingest-baseline.json`, both test files, `deferred-items.md`); commits `932f4c1`, `1461df4`, `5d59306`, `13ace72`, `4ad9ba9` are ancestors of HEAD; the ledger count is 5; the acceptance commands above were re-run.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
