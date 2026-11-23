---
phase: 01-evaluation-harness-baseline
plan: 01
subsystem: testing
tags: [pydantic, zod, json-schema, uv, json-schema-to-zod, tsx, fastapi]

requires: []
provides:
  - rag-sidecar uv package (Python 3.12, locked) with the eval-run Pydantic contracts
  - export_schemas CONTRACTS registry writing sorted JSON Schema under rag-sidecar/schemas
  - scripts/gen-zod.mjs generating strict zod/v3 schemas with $ref inlining
  - src/lib/rag-eval/contracts.generated.ts (ConversationTurn, RagRunRequest, RagTrace, RunManifest schemas)
  - npm run gen:schemas
affects: [01-02, 01-04, 01-09, 01-21, eval harness, eval route, sidecar service]

plan_head_before: 23e52cdaccf2434bdecc0eb5e42ede06185cdf04
plan_head_after: 871c34164750be5798b3b6755495ba661cb07f1b

actuals:
  tokens: 9750
  tasks: 2
  commits: 3

tech-stack:
  added: [json-schema-to-zod 2.8.1, tsx 4.23.15, fastapi 0.165.0, uvicorn 0.54.0, httpx 0.28.1, pydantic 2.14.4, pytest 9.2.0]
  patterns:
    - "Pydantic v2 is the single contract source; JSON Schema exported with sorted keys; zod/v3 generated and committed"
    - "Request models exported in validation mode, parsed models in serialization mode"
    - "Atomic writes (temp file + os.replace / fs.renameSync) for generated output"

key-files:
  created:
    - rag-sidecar/pyproject.toml
    - rag-sidecar/uv.lock
    - rag-sidecar/.gitignore
    - rag-sidecar/src/rag_sidecar/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - rag-sidecar/schemas/ConversationTurn.schema.json
    - rag-sidecar/schemas/RagRunRequest.schema.json
    - rag-sidecar/schemas/RagTrace.schema.json
    - rag-sidecar/schemas/RunManifest.schema.json
    - scripts/gen-zod.mjs
    - scripts/tests/gen-zod.node-test.mjs
    - src/lib/rag-eval/contracts.generated.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "Generator failure tests use node:test in scripts/tests/gen-zod.node-test.mjs (file name avoids vitest globs added in 01-09)"
  - "required_precision and search_strategy typed as Literals matching TemporalQueryContext in src/lib/temporal-query-detector.ts"
  - "npm ci run with --ignore-scripts because a transitive onnxruntime-node postinstall downloads a CUDA binary that is unavailable here"

patterns-established:
  - "Contract change flow: edit eval_run.py, register in CONTRACTS, run npm run gen:schemas, commit schemas and generated TS together"
  - "gen-zod fails closed: zero files, duplicate title, cyclic or unresolved $ref all exit 1 and never write --out"

requirements-completed: [EVAL-02]

coverage:
  - id: D1
    description: "npm run gen:schemas turns Pydantic RagRunRequest into JSON Schema and a strict zod/v3 schema that accepts Pydantic output and rejects unknown keys"
    requirement: EVAL-02
    verification:
      - kind: integration
        ref: "npm run gen:schemas piped into tsx safeParse check (Task 1 verify command)"
        status: pass
    human_judgment: false
  - id: D2
    description: "RagTrace and RunManifest contracts generate typed Zod with no untyped schema; regeneration is byte-identical"
    requirement: EVAL-02
    verification:
      - kind: unit
        ref: "scripts/tests/gen-zod.node-test.mjs#committed schemas generate RagTraceSchema and RunManifestSchema without untyped schemas"
        status: pass
      - kind: integration
        ref: "Task 2 verify command (two gen:schemas runs, sha256 equal)"
        status: pass
    human_judgment: false
  - id: D3
    description: "gen-zod exits 1 without writing on empty directory, duplicate title and cyclic $ref"
    requirement: EVAL-02
    verification:
      - kind: unit
        ref: "scripts/tests/gen-zod.node-test.mjs (7 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "rag-sidecar locked dependencies contain no judge or drafting libraries"
    requirement: EVAL-02
    verification:
      - kind: other
        ref: "grep -Ec 'name = \"(deepeval|ragas)\"' rag-sidecar/uv.lock == 0; uv sync --locked exits 0"
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 01: Contract Path Summary

**Pydantic v2 eval-run contracts (request, trace, run manifest) exported to JSON Schema and generated into strict zod/v3 schemas by `npm run gen:schemas`, with a fail-closed, byte-stable generator**

## Performance

- **Duration:** 7 min
- **Started:** 2026-11-23T06:10:00Z
- **Completed:** 2026-11-23T06:17:00Z
- **Tasks:** 2
- **Files modified:** 16 (14 created, 2 modified)

## Accomplishments
- Tracer slice proven end to end: a `RagRunRequest` built and serialized by Pydantic parses with the generated `RagRunRequestSchema` under tsx, and the same value with one unknown key is rejected.
- Widened to `RagTrace` and `RunManifest` (plus 8 supporting models); a Pydantic-built trace and manifest parse with the generated schemas, an unknown key on the trace is rejected, and `tsc --strict` accepts the generated file.
- `gen-zod` hardened: zero files, duplicate model title, cyclic or unresolved `$ref` exit 1 without touching `--out`; `oneOf` with `discriminator` becomes `anyOf` (a Zod 3 union); output written via temp file and `renameSync`.
- Two consecutive `npm run gen:schemas` runs are byte-identical; `uv sync --locked` passes; `rag-sidecar/uv.lock` has no deepeval or ragas.

## Task Commits

1. **Task 1: Tracer, RagRunRequest contract through gen:schemas to zod/v3** - `03ed10f` (feat)
2. **Task 2: Trace and run-manifest contracts, deterministic regeneration, generator failure exits** (TDD)
   - RED - `2b56868` (test)
   - GREEN - `871c341` (feat)
   - REFACTOR - none needed

**Plan metadata:** committed separately (docs: complete plan)

## TDD Evidence (Task 2)

- **RED:** `node --test --test-reporter=tap scripts/tests/gen-zod.node-test.mjs` exited 1 with 6 of 7 tests failing; `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (`target_test_failed`) for the target test "gen-zod exits 1 on an empty schema directory and leaves --out untouched". Semantic assessment: the target ran and failed on the planned assertion (expected exit 1, observed 0, because the Task 1 generator has no zero-file guard); the other failures were assertion failures for the planned behaviors (duplicate title accepted, cyclic ref crashing with RangeError instead of a named cycle, `oneOf` not unioned, `RagTraceSchema` and `RunManifestSchema` not yet exported). No syntax, import or fixture faults.
- **GREEN:** same command, 7 of 7 pass.
- **Gate commits:** `test(01-01)` `2b56868` precedes `feat(01-01)` `871c341`.

## Files Created/Modified
- `rag-sidecar/pyproject.toml`, `rag-sidecar/uv.lock` - uv package, Python pinned to 3.12 via `requires-python`, exact pins for fastapi, uvicorn, httpx, pytest
- `rag-sidecar/src/rag_sidecar/contracts/eval_run.py` - all 13 Pydantic contract models (`extra='forbid'`, `frozen=True`, no recursion)
- `rag-sidecar/src/rag_sidecar/export_schemas.py` - `CONTRACTS` registry, `export_all()`, atomic write, stale file removal, `__file__`-relative paths
- `rag-sidecar/schemas/*.schema.json` - four committed JSON Schemas
- `scripts/gen-zod.mjs` - generator with `--schemas-dir` and `--out`
- `scripts/tests/gen-zod.node-test.mjs` - node:test cases for the generator behaviors
- `src/lib/rag-eval/contracts.generated.ts` - generated zod/v3 schemas and inferred types
- `package.json`, `package-lock.json` - `gen:schemas` script, json-schema-to-zod 2.8.1 and tsx 4.23.15 pinned exactly

## Decisions Made
- Package checks before install: `npm view` confirmed json-schema-to-zod from StefanTerdell/json-schema-to-zod and tsx from privatenumber/tsx, integrity present, no preinstall/install/postinstall scripts (D-24, T-01-SC).
- `TraceQueryContext.required_precision` and `search_strategy` use the exact literal sets from `TemporalQueryContext` so a drifting value is rejected rather than passed through as a free string.
- Added `rag-sidecar/.gitignore` (`.venv/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`) so Python artifacts cannot be staged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `npm ci` failed on a transitive postinstall**
- **Found during:** Task 1 (npm toolchain)
- **Issue:** `onnxruntime-node` postinstall tries to download a CUDA binary (404 here), aborting `npm ci` with zero packages installed.
- **Fix:** Ran `npm ci --ignore-scripts` (the same mode the research spike used) and installed the two new packages with `--ignore-scripts`. No package was substituted; the two plan packages installed at their exact pins.
- **Files modified:** none (environment only)
- **Verification:** `node_modules` populated, tracer and tests run.

**2. [Rule 2 - Missing Critical] Added a test file not listed in the plan's `files_modified`**
- **Found during:** Task 2 (TDD requirement)
- **Issue:** The `tdd="true"` task needs a failing test; the plan lists no test file and the schema-parity test belongs to plan 01-21.
- **Fix:** Added `scripts/tests/gen-zod.node-test.mjs` (node:test, no new dependency). Named so it does not match Vitest globs that 01-09 will introduce.
- **Committed in:** `2b56868`

**3. [Rule 2 - Missing Critical] Added `unresolved $ref` failure and missing-title failure to gen-zod**
- **Found during:** Task 2
- **Issue:** An unresolved `$ref` would otherwise inline `undefined` and produce a permissive schema, the exact T-01-07 risk.
- **Fix:** gen-zod exits 1 on an unresolved `$ref` or a schema without a top-level title.
- **Committed in:** `871c341`

---

**Total deviations:** 3 (1 blocking, 2 missing critical)
**Impact on plan:** All were needed to complete and harden the task; no scope creep.

## Issues Encountered
- Plan size note (11 files) was exceeded slightly by `rag-sidecar/.gitignore` and the test file; both are small and directly support the plan.
- 515 lines were added to `package-lock.json` for tsx and its esbuild optional platform packages; no existing entries were changed.

## Known Stubs
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The eval route (01-04) and harness can import `RagRunRequestSchema`, `RagTraceSchema` and `RunManifestSchema` from `src/lib/rag-eval/contracts.generated.ts`.
- Plan 01-21 adds the CI schema-parity test (`git diff --exit-code` after regeneration); the committed files are already byte-stable.
- Adding a contract: edit `eval_run.py`, register it in `CONTRACTS`, run `npm run gen:schemas`, commit schemas and generated TS together.
- Environment note: use `npm ci --ignore-scripts` in this sandbox; the onnxruntime-node postinstall cannot download its binary here.

## Self-Check: PASSED

Verified files exist and commits are ancestors of HEAD (see below).

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
