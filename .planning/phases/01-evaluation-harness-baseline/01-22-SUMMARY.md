---
phase: 01-evaluation-harness-baseline
plan: 22
subsystem: infra
tags: [github-actions, ci, typecheck, schema-parity, eval-gate, nightly, docker]
status: complete

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-11 check-config and its self-test; 01-12 sidecar Dockerfile and probes; 01-17 chat route characterization tests; 01-18 judge CLI; 01-19 eval draft extras; 01-20 gate, baseline and npm run test-rag; 01-21 schema parity and gen:schemas"
provides:
  - "scripts/typecheck-new.mjs and npm run typecheck:new: tsc over Phase 1 paths only, fails on diagnostics there or on a tsc crash, counts and ignores legacy diagnostics"
  - ".github/workflows/pr-smoke.yml: ts, schema-parity, python, eval-smoke, gate-negative-control, docker-build jobs; pull_request and push to main, read-only, no secrets"
  - ".github/workflows/nightly.yml: schedule and workflow_dispatch judge job with key-presence skip and telemetry opt-out"
  - "scripts/ci/check-workflows.py: structural check of both workflows (triggers, permissions, pins, required commands)"
affects: [phase-2-and-later gating, ci]

plan_head_before: ebdffed8a702e9e3dd3b7d04735283e7da326ad4
plan_head_after: f9dcb8a08fcb9a34e9cbd1d529d442f3cab3d093

actuals:
  tokens: 6000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Type-check of new code: tsc with a dedicated tsconfig, output filtered by path; a non-zero exit with no parseable diagnostic is a failure"
    - "Workflow structure is asserted by a standard-library-plus-PyYAML script, mutation-tested against each rule"
    - "Negative control: the degraded run must exit exactly 1, so a crash (exit 3) or a missing gate fails the job"

key-files:
  created:
    - tsconfig.typecheck-new.json
    - scripts/typecheck-new.mjs
    - scripts/typecheck-new.test.mjs
    - .github/workflows/pr-smoke.yml
    - .github/workflows/nightly.yml
    - scripts/ci/check-workflows.py
  modified:
    - package.json

key-decisions:
  - "gh could not reach GitHub from this environment (HTTP 403 on every release lookup), so the plan's fallback pins were used: actions/checkout@v4, actions/setup-node@v4, astral-sh/setup-uv@v5, actions/upload-artifact@v4. The first CI run on GitHub confirms them"
  - "Telemetry opt-out variables are set workflow-wide in pr-smoke.yml as well as nightly.yml, so no job that imports a judge library can phone home"
  - "Every job that runs eval pytest or the harness syncs eval with uv sync --locked --all-extras (orchestrator revision: tests import httpx and anthropic from the draft extra); check-workflows.py enforces it"
  - "Nightly: only the skip-notice step runs without HAS_JUDGE_KEYS == 'true'; the check script enforces that, so a later edit cannot leak a keyless failure or an ungated secret use"
  - "EVAL-02 and EVAL-13 marked complete (their CI clauses are delivered and their commands verified locally); EVAL-01, EVAL-08 and EVAL-10 stay Pending for the live checks below"

patterns-established:
  - "Local CI rehearsal: run each job's commands in order locally, plus mutation checks on the workflow checker"

requirements-completed: [EVAL-02, EVAL-13]

coverage:
  - id: D1
    description: "typecheck:new fails on a TypeScript error in any Phase 1 path (injected error in tests/ exits 1), ignores 103 legacy diagnostics, and treats a tsc crash as a failure"
    requirement: EVAL-10
    verification:
      - kind: unit
        ref: "node --test scripts/typecheck-new.test.mjs (8 passed)"
        status: pass
      - kind: integration
        ref: "npm run typecheck:new exits 0 on the tree; with tests/zz-inject.test.ts containing a type error it exits 1"
        status: pass
    human_judgment: false
  - id: D2
    description: "pr-smoke.yml runs every Phase 1 check with the pull_request trigger, read-only permissions, no secrets, pinned actions, a negative control requiring exit 1, and a sidecar image build with probe and auth checks"
    requirement: EVAL-10
    verification:
      - kind: other
        ref: "python3 -I scripts/ci/check-workflows.py (OK; mutations of pin, exit-code assertion, pull_request_target, missing --all-extras and write permission each exit 1)"
        status: pass
      - kind: integration
        ref: "each job's commands run locally: npm test 117 passed, tsx tests 37 passed, check-config ok, self-tests 21 passed, gen:schemas then git diff clean, pytest 137 and 185 passed, npm run test-rag gate PASS, degraded run exit 1"
        status: pass
    human_judgment: false
  - id: D3
    description: "nightly.yml runs on schedule and manual dispatch with telemetry off, generates live answered traces and runs the judge, and skips with a notice when keys are absent"
    requirement: EVAL-08
    verification:
      - kind: other
        ref: "python3 -I scripts/ci/check-workflows.py (nightly assertions; mutations of trigger, telemetry value, pin, gating and extras each exit 1)"
        status: pass
      - kind: integration
        ref: "run-nightly --generator stub then rag_eval.judge.run without a key: traces and manifest validate, judge reports 'judge key not configured'"
        status: pass
    human_judgment: false
  - id: D4
    description: "First real GitHub run: all pr-smoke jobs green including docker-build and gate-negative-control; nightly succeeds with the skip notice, then covers zh, en and it with real keys"
    verification: []
    human_judgment: true
    rationale: "GitHub Actions, a Docker daemon and real judge keys are not reachable from this environment"

duration: 12min
completed: 2026-11-23
---

# Phase 1 Plan 22: CI Workflows Summary

**PR smoke and nightly GitHub Actions workflows now run every Phase 1 gate (Vitest, tsx tests, config drift, new-code type-check, schema parity, both pytest projects, the baseline gate with a negative control, the sidecar image) and the judge tier, with fork-safe permissions and a structure checker.**

## Performance

- **Duration:** about 12 minutes
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- `npm run typecheck:new` type-checks only Phase 1 paths; the tree passes in about 5 s with 103 legacy diagnostics counted and ignored (more than the 12 RESEARCH measured, because the config also pulls in test helpers that import legacy routes).
- `pr-smoke.yml` has the six required jobs; the negative control runs `npm run test-rag -- --max-results 1` and passes only on exit code exactly 1.
- `nightly.yml` has the single `judge` job; keys are step env only, `CONFIDENT_API_KEY` is never set.
- `scripts/ci/check-workflows.py` asserts the structure and was mutation-tested for each rule.

## Task Commits

1. **Task 1: New-code type-check and the PR smoke workflow** - `226e701` (ci)
2. **Task 2: Nightly judge workflow with key-presence skip** - `f9dcb8a` (ci)

## Files Created/Modified

- `tsconfig.typecheck-new.json`, `scripts/typecheck-new.mjs`, `scripts/typecheck-new.test.mjs`, `package.json` (`typecheck:new`)
- `.github/workflows/pr-smoke.yml`, `.github/workflows/nightly.yml`
- `scripts/ci/check-workflows.py`

## Decisions Made

See frontmatter key-decisions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Telemetry opt-out also set in pr-smoke.yml**
- **Found during:** Task 1
- **Issue:** The plan set the variables only on the python job, but the eval-smoke and ts jobs also import eval code.
- **Fix:** Set DEEPEVAL_TELEMETRY_OPT_OUT, DEEPEVAL_UPDATE_WARNING_OPT_IN and RAGAS_DO_NOT_TRACK at workflow level.
- **Files modified:** .github/workflows/pr-smoke.yml
- **Commit:** 226e701

Orchestrator revision applied: every job running eval pytest or the harness syncs eval with `--locked --all-extras` (the `python` job included), enforced by the checker.

## Issues Encountered

- `gh release view` returned HTTP 403 for all four actions, so the fallback pins were used (see decisions).

## Known Stubs

None.

## Threat Flags

None. T-01-34 to T-01-36 and T-01-SC are mitigated and asserted by `scripts/ci/check-workflows.py` (pull_request only, no secrets in pr-smoke, read-only contents, tag or sha pins, `npm ci` and `uv sync --locked`, nightly on schedule and manual dispatch only).

## Pending live verification

- Push the branch, open a PR and confirm every pr-smoke job is green, in particular docker-build (no Docker daemon here, validated statically only) and gate-negative-control.
- Confirm the action pins resolve (A1) and bump if a newer major is wanted.
- Add OPENROUTER_API_KEY and OPENAI_API_KEY as repository secrets and trigger nightly with workflow_dispatch; before that, confirm the run succeeds with the skip notice. Hand-check judge.json covers zh, en and it (EVAL-08).
- EVAL-01 (image builds) and EVAL-10 (first real CI run) therefore stay Pending.

## Verification

- `node --test scripts/typecheck-new.test.mjs scripts/check-config.test.mjs`: 21 passed
- `npm run typecheck:new`: exit 0; `python3 -I scripts/ci/check-workflows.py`: OK
- `npm test`: 117 passed; tsx tests: 37 passed; `node scripts/check-config.mjs`: ok
- `npm run gen:schemas` then `git diff --exit-code`: clean
- pytest: rag-sidecar 137 passed, eval 185 passed
- `npm run test-rag`: gate PASS; `npm run test-rag -- --max-results 1`: exit 1

## Self-Check: PASSED

- FOUND: tsconfig.typecheck-new.json, scripts/typecheck-new.mjs, scripts/typecheck-new.test.mjs, .github/workflows/pr-smoke.yml, .github/workflows/nightly.yml, scripts/ci/check-workflows.py
- FOUND commits: 226e701, f9dcb8a
