---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 01
subsystem: infra
tags: [typescript, tsc, ci, ratchet, github-actions, node-test]

requires:
  - phase: 01-eval-foundation
    provides: typecheck:new gate, pr-smoke workflow, check-workflows.py
provides:
  - Root tsconfig that type-checks only the Next.js app (voice-agent and baileys-whatsapp excluded, .mts imports allowed)
  - scripts/ci/tsc-ratchet.mjs per-file type-error ratchet (exports countDiagnostics, compareToBaseline; exit 0/1/70)
  - Committed baselines: 231 errors in 65 files for the app, 0 for each sibling package
  - pr-smoke ts job runs next typegen then the ratchet; new sibling-types job ratchets voice-agent and baileys-whatsapp
  - src/lib/rag/ held to zero errors by npm run typecheck:new
affects: [02-07, 02-29, 02-30, 02-31, 02-32, 02-33, 02-34, 02-35, 02-36]

actuals:
  tokens: 5038
  tasks: 3
  commits: 5
plan_head_before: af38c528e48268781ecf4474701d8fcd516681c4
plan_head_after: 5776570bcca631c02c22b4bf4b237d78de5e0248

tech-stack:
  added: []
  patterns:
    - "Per-file tsc ratchet: committed baseline, fewer errors always pass, --write is manual only and forbidden in CI by the workflow checker"
    - "One baseline file holds several projects through --key (packages map)"

key-files:
  created:
    - scripts/ci/tsc-ratchet.mjs
    - scripts/ci/tsc-baseline.json
    - scripts/ci/sibling-tsc-baseline.json
    - scripts/tests/tsc-ratchet.node-test.mjs
  modified:
    - tsconfig.json
    - tsconfig.typecheck-new.json
    - scripts/typecheck-new.mjs
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py

key-decisions:
  - "Root tsconfig excludes voice-agent and baileys-whatsapp (own dependencies and tsconfig) and sets allowImportingTsExtensions; eval/ and tests/ stay in the root check"
  - "The ratchet baseline is recorded with route types generated (next typegen), so it includes 7 errors in .next/types/validator.ts; CI generates the same types before the ratchet"
  - "Sibling packages both install cleanly and have 0 errors, so both are tracked in CI with a zero baseline"
  - "baileys-whatsapp is installed with Corepack Yarn 4 (yarn install --immutable --mode=skip-build), the Yarn 4 equivalent of --frozen-lockfile --ignore-scripts"

patterns-established:
  - "Self-test via node:test with --input fixtures and temp-dir baselines for CI helper scripts"

requirements-completed: []  # PIPE-01 is shared with later Phase 2 plans; it is not complete after this plan

coverage:
  - id: D1
    description: "Root tsconfig covers only the app: 312 errors before, 224 after (231 with route types), no voice-agent/baileys-whatsapp diagnostics, no TS5097"
    requirement: PIPE-01
    verification:
      - kind: other
        ref: "npx tsc --noEmit -p tsconfig.json --pretty false | grep -c 'error TS' -> 224"
        status: pass
    human_judgment: false
  - id: D2
    description: "Per-file tsc ratchet fails on any file gaining errors, new erroring files and file-less diagnostics, passes when counts fall, exits 70 on a tool crash"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "scripts/tests/tsc-ratchet.node-test.mjs (11 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "CI wiring: ts job runs next typegen and the ratchet, sibling-types job ratchets both sibling packages, workflow checker asserts the steps"
    requirement: PIPE-01
    verification:
      - kind: other
        ref: "uv run --directory eval python ../scripts/ci/check-workflows.py"
        status: pass
    human_judgment: true
    rationale: "The workflow YAML has not run on a GitHub runner yet; only its structure and the equivalent local commands were verified"
  - id: D4
    description: "src/lib/rag/ is type-checked by npm run typecheck:new"
    requirement: PIPE-01
    verification:
      - kind: other
        ref: "npm run typecheck:new"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-23
status: complete
---

# Phase 2 Plan 01: Type-check configuration and per-file ratchet Summary

**Root `tsc` now covers only the Next.js app (312 to 224 errors) and a per-file ratchet against a committed baseline of 231 errors stops regressions in CI, with voice-agent and baileys-whatsapp tracked separately at 0 errors each.**

## Performance

- **Duration:** about 25 min
- **Completed:** 2026-11-23
- **Tasks:** 3
- **Files modified:** 9 (4 created, 5 modified)

## Accomplishments

- tsconfig.json excludes `voice-agent` and `baileys-whatsapp` and sets `allowImportingTsExtensions` (valid with `noEmit`), removing the 88 configuration errors (67 sibling-package errors plus 21 TS5097).
- `src/lib/rag/` is now in `tsconfig.typecheck-new.json` and `PHASE1_PATHS`, so pipeline code is held at zero errors from its first file.
- `scripts/ci/tsc-ratchet.mjs` with flags `--project`, `--baseline`, `--cwd`, `--input`, `--key`, `--write`; exit 0 pass, 1 regression, 70 tool crash. It never edits a baseline without `--write`.
- Baseline `scripts/ci/tsc-baseline.json` (schemaVersion 1, total 231, 65 files) and `scripts/ci/sibling-tsc-baseline.json` (a `packages` map; both entries `total: 0`).
- `pr-smoke.yml`: `ts` job gains "Generate route types" and "Type-error ratchet" steps and the new self-test; new `sibling-types` job installs both packages from their lockfiles and ratchets each.
- `check-workflows.py` asserts the new needles, the `sibling-types` job, and that no job runs the ratchet with `--write` (T-02-01 mitigation).

## Type-check coverage

Root `tsc --noEmit -p tsconfig.json` (measured at base commit af38c52, then after the change):

| State | Without `next typegen` | With `next typegen` |
|-------|-----------------------|---------------------|
| Before (HEAD af38c52) | 312 | not measured |
| After | 224 | 231 |

The 7-error difference is `.next/types/validator.ts`, generated by `next typegen`; those errors come from route handlers and are in the baseline under `.next/types/validator.ts`. After the change no diagnostic names `voice-agent/`, `baileys-whatsapp/` or TS5097.

Sibling packages (D-15: record what was checked):

| Package | Install command | Install result | tsc under own tsconfig | CI tracked |
|---------|-----------------|----------------|------------------------|------------|
| voice-agent | `npm ci --ignore-scripts` | exit 0 | 0 errors (6 files, TypeScript 5.9.3) | yes, `sibling-types` job |
| baileys-whatsapp | `corepack yarn install --immutable --mode=skip-build` | exit 0 (1110 packages) | 0 errors (90 files, TypeScript 5.8.3) | yes, `sibling-types` job |

The first baileys attempt, `yarn install --frozen-lockfile --ignore-scripts` with the global Yarn 1.22.22, failed because `package.json` pins `packageManager: yarn@4.9.2` and the lockfile is Yarn Berry format (metadata version 8). The root `tsc` gate never includes these packages. Neither `node_modules` is tracked (`git status --porcelain` on both is empty).

## Task Commits

1. **Task 1: Root tsconfig covers only the app; typecheck:new covers src/lib/rag/** - `6f7a956` (chore)
2. **Task 2 (TDD): Per-file tsc ratchet**
   - RED: `617a6cf` (test) - 11 tests, all failing on assertions against stub exports
   - GREEN: `b1f6a47` (feat) - implementation, baseline, CI wiring, workflow checker
3. **Task 3: Sibling type-check tracking** - `5776570` (chore)

`commits: 5` in the frontmatter is the measured `git rev-list --count` over the plan range. It includes `f8f3e4f` (a roadmap docs commit made by the orchestrator while this plan ran); the plan itself made 4 commits plus the final docs commit.

## TDD Gate Compliance

- **RED:** `node --test --test-reporter=tap scripts/tests/tsc-ratchet.node-test.mjs` exited 1 with 11 of 11 tests failing. The classifier (`gsd_run check tdd-red-evidence`) returned `RED_EVIDENCE_OK` (`target_test_failed`) for the target "compareToBaseline passes when counts drop and lists the improved files". Semantic assessment: the target test executed and failed on its own assertion (`improved` was `[]`, expected `['src/a.ts','src/b.ts']`); the module loaded because the RED commit carries a stub `scripts/ci/tsc-ratchet.mjs` exporting the two functions, so no failure was an import or syntax fault. The evidence record is under the ignored `.gsd/tdd-evidence/02-01/`.
- **GREEN:** same command, 11 of 11 pass.
- **REFACTOR:** none needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Yarn 4 install command for baileys-whatsapp**
- **Found during:** Task 3
- **Issue:** the planned `yarn install --frozen-lockfile --ignore-scripts` is Yarn 1 syntax; the package pins Yarn 4.9.2 and the global Yarn 1 refuses to run.
- **Fix:** used `corepack yarn install --immutable --mode=skip-build` (lockfile-only, no build scripts), the plan's permitted `corepack yarn` route. The CI job runs `corepack enable` then the same command. No package was added or substituted.
- **Files modified:** `.github/workflows/pr-smoke.yml`
- **Commit:** 5776570

**2. [Rule 2 - Missing critical] Workflow checker forbids `--write` in CI**
- **Found during:** Task 2
- **Issue:** threat T-02-01 says check-workflows must assert that CI never passes `--write`; the plan's needle list did not include it.
- **Fix:** added a per-job assertion in `check_pr`; verified it fails when `--write` is injected into the ratchet step.
- **Files modified:** `scripts/ci/check-workflows.py`
- **Commit:** b1f6a47

**3. [Plan detail] `--input-status` flag added to the ratchet**
- The crash behavior (exit 70 when tsc fails without a parseable diagnostic) cannot be fed through `--input` without an exit status, so the ratchet accepts `--input-status <n>`; it is only used by the self-test.

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing critical) plus 1 minor addition. **Impact:** none on scope; all acceptance criteria hold.

## Issues Encountered

None blocking. The baseline includes 7 errors in the generated `.next/types/validator.ts`; they fall away when the route-handler type errors are fixed by plans 02-29..02-35, and a decrease always passes. Pre-existing errors in the app (224 without route types) are untouched by design.

## Known Stubs

None. (The stub exports in the RED commit were replaced in the GREEN commit.)

## Threat Flags

None. The sibling `npm ci` / `yarn install` run only from committed lockfiles with scripts disabled (T-02-SC); the ratchet never rewrites a baseline without `--write` and CI never passes it (T-02-01).

## Next Phase Readiness

Ready for 02-02. The ratchet baseline is the interim gate for the type-fix plans; those plans do not edit the baseline. Not yet verified: the `pr-smoke.yml` changes on a real GitHub runner (structure checked locally, and the same commands pass locally).

## Self-Check: PASSED

- Created files present: scripts/ci/tsc-ratchet.mjs, scripts/ci/tsc-baseline.json, scripts/ci/sibling-tsc-baseline.json, scripts/tests/tsc-ratchet.node-test.mjs
- Commits present on the branch: 6f7a956, 617a6cf, b1f6a47, 5776570
- Acceptance criteria re-run: root count 224 / 231 with typegen, ratchet ok at 231, 11 self-tests pass, workflow check OK, typecheck:new OK, config check OK
