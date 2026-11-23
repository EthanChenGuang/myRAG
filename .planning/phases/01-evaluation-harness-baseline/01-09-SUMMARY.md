---
phase: 01-evaluation-harness-baseline
plan: 09
subsystem: testing
tags: [vitest, vite, rag-eval, next-route, auth, concurrency, http-transport]

requires:
  - phase: 01-04
    provides: "POST /api/internal/rag/run, checkEvalAccess, runEval and prepareInProcessEval"
  - phase: 01-02
    provides: "PGlite fixture database and the serialized 127.0.0.1 fake edge"
provides:
  - "npm test (vitest run) with the @ alias and a placeholder-only env setup file"
  - "Route-level auth matrix test for the eval endpoint (401/503/404/400, auth before parsing)"
  - "Harness tests: tracer retrieval through runEval, five-way concurrency equality, HTTP transport equality"
affects: [01-10, 01-14, 01-15, 01-17, 01-21, characterization tests, corpus tests, contract tests]

plan_head_before: 7d3ecf24566db4b618412bc663686d9725895c1f
plan_head_after: 657f25079360402488a5da5249094a5d96828482

actuals:
  tokens: 4200
  tasks: 2
  commits: 2

tech-stack:
  added: [vitest@5.1.1, vite@7.3.8]
  patterns:
    - "Route tests set process.env, call vi.resetModules(), then dynamically import the route so env.ts snapshots the per-case environment"
    - "Each harness test group resets the module registry before preparing its own edge, because the route module and Supabase singleton capture the edge URL at import"
    - "HTTP transport is tested with a node:http forwarder that rebuilds a NextRequest and returns the route's Response"

key-files:
  created:
    - vitest.config.ts
    - tests/setup-env.ts
    - tests/eval-route-auth.test.ts
    - tests/eval-harness.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "vitest.config.ts includes only tests/**/*.test.ts, so the existing node:test file tests/fixture-edge.test.mts is not collected by npm test and keeps running under node:test"
  - "The HTTP-transport test compares kept chunk ids across two separately built fixture databases; ids are deterministic, so the comparison is meaningful"

patterns-established:
  - "Placeholder env lives in tests/setup-env.ts and is overwritten by fixtureProcessEnv inside prepareInProcessEval"

requirements-completed: []

coverage:
  - id: D1
    description: "npm test runs Vitest with the @ alias and a setup file that sets only fake placeholder env"
    requirement: EVAL-06
    verification:
      - kind: integration
        ref: "npm test: 2 files, 10 tests passed"
        status: pass
    human_judgment: false
  - id: D2
    description: "Route-level auth matrix: missing/wrong secret 401, unset or 31-char secret 503 with matching header, production without enable flag 404, enabled + correct secret + invalid body 400 with success false and details, unauthenticated invalid body 401"
    requirement: EVAL-06
    verification:
      - kind: unit
        ref: "tests/eval-route-auth.test.ts (7 tests, real route handler)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Five concurrent in-process calls return the same candidates, kept, used_documents, context and refused as one sequential call, with zero edge errors"
    requirement: EVAL-06
    verification:
      - kind: integration
        ref: "tests/eval-harness.test.ts concurrency case (Promise.all of five POSTs)"
        status: pass
    human_judgment: false
  - id: D4
    description: "runEval with baseUrl pointed at a local node http forwarder yields the same kept chunk ids as the in-process run; the in-process tracer run keeps refund-policy.en.md with zero edge errors"
    requirement: EVAL-06
    verification:
      - kind: integration
        ref: "tests/eval-harness.test.ts tracer and HTTP transport cases"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 09: Vitest Infrastructure and Eval Endpoint Tests Summary

**Vitest 5.1.1 (vite 7.3.8) is wired up with `npm test`, and 10 tests lock the eval endpoint's auth matrix, five-way concurrency equality and the HTTP transport the live tier uses**

## Performance

- **Duration:** about 8 min (start time was not captured at launch; estimate)
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 6 (4 created, 2 modified)

## Accomplishments
- `npm test` exits 0 with 2 test files and 10 tests, in about 5 seconds.
- Auth matrix runs against the real route handler: a changed status code in `checkEvalAccess` or a reordering that parses the body before auth now fails CI.
- Concurrency equality holds because the fake edge serializes PGlite access; the five-way run and the sequential run match on candidates, kept, used_documents, context and refused.
- HTTP transport: `runEval({ baseUrl })` through a local `node:http` forwarder produces the same kept chunk ids as the in-process run, with the live-tier secret header path exercised.

## Task Commits

1. **Task 1: Vitest infrastructure and route-level auth matrix** - `b867918` (feat)
2. **Task 2: Tracer, concurrency and HTTP transport tests** - `657f250` (test)

**Plan metadata:** committed separately (docs: complete plan)

## Decisions Made
See `key-decisions` above.

## Deviations from Plan

None - plan executed exactly as written. `run-eval.mts` was not modified; `prepareInProcessEval` and `runEval` already exported everything needed. The install used `--ignore-scripts` per the environment note; `npm view` showed no install scripts for either package, so nothing was skipped.

Supply-chain check (T-01-SC): `npm view` confirmed repositories vitest-dev/vitest and vitejs/vite, integrity hashes present, and no install-time scripts for vitest@5.1.1 and vite@7.3.8. `npm ls vite` shows vite@7.3.8 at depth 0.

## Issues Encountered
- Installing vite 7.3.8 as a direct dependency re-resolved part of the lockfile (about 1900 lines added, 1100 removed), mostly dedupe of transitive vite 5 packages. Reviewed as lockfile churn only; no runtime dependency version in `package.json` changed.
- `eslint` prints the existing `.eslintignore` deprecation warning; the new files lint clean.

## Known Stubs
None.

## Threat Flags
None. Test env values are placeholders (the `sk-or-` value is the same fake string `fixtureProcessEnv` uses), and every retrieval test runs behind the 127.0.0.1 fake edge, so no vendor is reachable with a real key (T-01-41).

## User Setup Required
None.

## Next Phase Readiness
- Plans 01-15, 01-17, 01-14 and 01-21 can add `tests/*.test.ts` files and run them with `npm test`; they get the `@` alias and placeholder env automatically.
- Any test that imports the route more than once with different env or edges must call `vi.resetModules()` first, because `env.ts` and the Supabase client are read at import.
- EVAL-06 stays Pending in REQUIREMENTS.md: plans 01-10 and 01-14 also deliver parts of it.

## Self-Check: PASSED

All 4 created files exist, commits `b867918` and `657f250` are ancestors of HEAD, and `npm test` exits 0 with 10 passed tests.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
