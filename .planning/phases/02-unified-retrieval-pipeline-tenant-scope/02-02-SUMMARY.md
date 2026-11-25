---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 02
subsystem: infra
tags: [nodejs, engines, vercel, docker, ci, node-test]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "02-01 pr-smoke ts job, check-workflows.py needle list, node:test self-test pattern"
provides:
  - "engines.node ^22.12.0 in the root package.json (pins the Vercel Node major to 22)"
  - ".nvmrc pinning 22"
  - "voice-agent image on node:22-slim with @types/node ^22"
  - "scripts/ci/check-node-runtime.mjs exporting checkNodeRuntime, run in the pr-smoke ts job with a node:test self-test"
  - "AGENTS.md, .claude/CLAUDE.md and README.md state Node.js 22 (^22.12.0)"
affects: [02-22, later phases using Weaviate and Qdrant clients]

actuals:
  tokens: 1736
  tasks: 2
  commits: 3
plan_head_before: 08ee29d3b88ac29459f9cbbb099d2db6d80d9347
plan_head_after: 8aa516151cd2172ae4e25ad8c818d60bfd1d957f

tech-stack:
  added: []
  patterns:
    - "CI helper with exported pure function plus --root/--node-version overrides so the CLI can be self-tested against temp-dir fixtures"

key-files:
  created:
    - scripts/ci/check-node-runtime.mjs
    - scripts/tests/check-node-runtime.node-test.mjs
    - .nvmrc
  modified:
    - package.json
    - package-lock.json
    - voice-agent/Dockerfile
    - voice-agent/package.json
    - voice-agent/package-lock.json
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py
    - AGENTS.md
    - .claude/CLAUDE.md
    - README.md

key-decisions:
  - "engines.node is ^22.12.0, not >=22.12.0, because Vercel maps a >= range to the newest major (26.x)"
  - "The runtime check accepts only ^22.x, ~22.x, 22, 22.x and '>=22.x <23'; any || range, unbounded >=, or * fails"
  - "baileys-whatsapp stays on Node 20 (no file under it changed)"

patterns-established:
  - "Workflow checker asserts every actions/setup-node step in pr-smoke.yml uses node-version '22'"

requirements-completed: [PIPE-10]

coverage:
  - id: D1
    description: "Root package.json declares engines.node ^22.12.0, .nvmrc pins 22, voice-agent builds FROM node:22-slim, baileys-whatsapp untouched"
    requirement: PIPE-10
    verification:
      - kind: other
        ref: "node -e \"if(require('./package.json').engines.node!=='^22.12.0')process.exit(1)\"; grep -c 'FROM node:22-slim' voice-agent/Dockerfile; git diff --name-only 409235f^ 409235f -- baileys-whatsapp/ (empty)"
        status: pass
    human_judgment: true
    rationale: "That Vercel actually builds on Node 22 and that the voice-agent image builds and connects to LiveKit on Node 22 are live checks (see Live verification items)"
  - id: D2
    description: "check-node-runtime rejects a non-22 runtime, a missing engines field and any range admitting another major; accepts ^22.12.0, 22.x, ~22.12.0"
    requirement: PIPE-10
    verification:
      - kind: unit
        ref: "scripts/tests/check-node-runtime.node-test.mjs (11 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "pr-smoke ts job runs the runtime check and its self-test; check-workflows.py asserts both and node-version 22 on every setup-node step"
    requirement: PIPE-10
    verification:
      - kind: other
        ref: "uv run --directory eval python ../scripts/ci/check-workflows.py"
        status: pass
    human_judgment: true
    rationale: "The workflow YAML has not run on a GitHub runner yet; structure and the equivalent local commands were verified"
  - id: D4
    description: "AGENTS.md, .claude/CLAUDE.md and README.md name Node.js 22 (^22.12.0); the WhatsApp service line stays on Node 20"
    requirement: PIPE-10
    verification:
      - kind: other
        ref: "grep -q 22.12 on the three files; grep -q node:22-slim .claude/CLAUDE.md"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-11-23
status: complete
---

# Phase 2 Plan 02: Node.js 22 runtime pin and enforcement Summary

**Node.js 22 is now pinned by `engines.node ^22.12.0`, `.nvmrc`, the voice-agent `node:22-slim` image and a CI check that fails on any other runtime major or any engines range that admits one.**

## Performance

- **Duration:** about 12 min
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 13 (3 created, 10 modified)

## Accomplishments

- `package.json` gains `"engines": { "node": "^22.12.0" }`; the lockfile root records the same field (3 lines).
- `.nvmrc` is the single line `22`.
- `voice-agent/Dockerfile` uses `FROM node:22-slim`; `voice-agent/package.json` moves `@types/node` to `^22`; the refreshed lockfile changes only the `@types/node` entry (20.19.27 to 22.20.5), no runtime package.
- `scripts/ci/check-node-runtime.mjs` exports `checkNodeRuntime({version, engines})` and a CLI (`--root`, `--node-version` for tests) that exits 0 or 1 with a one-line reason.
- `pr-smoke.yml` job `ts`: "Node runtime check" step right after `npm ci`, and the self-test added to the existing self-test line. `check-workflows.py` requires both needles and that every `actions/setup-node` step uses `'22'`.
- AGENTS.md section 3, `.claude/CLAUDE.md` (Runtime and Platform Requirements) and README.md prerequisites state Node.js 22 (`^22.12.0`); README adds the sentence that Vercel picks the major from `engines`.

## Task Commits

1. **Task 1 (TDD): engines, .nvmrc, voice-agent image, CI runtime check**
   - RED: `31780ab` (test)
   - GREEN: `409235f` (feat)
2. **Task 2: Document Node.js 22** - `8aa5161` (docs)

`commits: 3` is the measured `git rev-list --count` over the plan range at SUMMARY time (the final docs commit follows it).

## TDD Gate Compliance

- **RED:** the RED commit imported a module that did not exist yet, so its real run failed with a module-not-found load fault, which the #3770 rules treat as INVALID_RED. I noticed this after GREEN. Reconstruction, not the original run: I ran the RED commit's test file unchanged against a stub `checkNodeRuntime` returning `{ok: true}` (scratch copy under the ignored `.gsd/tdd-evidence/02-02/`), captured TAP (7 of 11 failing, including the target "runtime majors other than 22 fail"), and `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (`target_test_failed`). Semantic assessment: the target ran and failed on its own assertion (`ok` was true, expected false); no import, syntax or fixture fault in the reconstructed run. This is after-the-fact evidence, and the committed RED state itself was a load failure.
- **GREEN:** `node --test scripts/tests/check-node-runtime.node-test.mjs` gives 11 of 11 pass. One test ("the repository itself passes") was red until the `engines` field was added in the same GREEN commit.
- **REFACTOR:** none needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Root package-lock.json records the engines field**
- **Found during:** Task 1
- **Issue:** the plan says to touch the root lockfile only if npm reports it needs the engines field. `npm install --package-lock-only --ignore-scripts` did add `engines` to the lockfile root package entry, so leaving it would have made every later `npm install` produce churn.
- **Fix:** committed the 3-line lockfile change; no dependency version changed.
- **Files modified:** package-lock.json
- **Commit:** 409235f

**2. [Process] RED commit was an import failure**
- Described under TDD Gate Compliance. No code impact.

**Total deviations:** 1 auto-fixed (blocking) plus 1 process note. **Impact:** none on scope.

## Issues Encountered

None. `npm ci --ignore-scripts --prefix voice-agent` followed by the sibling ratchet (`--key voice-agent`) still reports 0 errors with `@types/node` 22.

## Live verification items

These need a person or a live account and are not covered by the automated checks:

1. Set or confirm the Vercel project's Node.js version (Settings, Build and Deployment) so it does not contradict `engines.node` (T-02-04 context; `engines` overrides the project setting per Vercel docs, so confirm a deploy log shows Node 22.x).
2. Build the voice-agent image on Node 22 (`docker build voice-agent`) and confirm a LiveKit connect works with the native `@livekit/rtc-node` binaries (T-02-04, accepted risk; no Docker daemon was available here).
3. Confirm `pr-smoke` passes on a GitHub runner with the new "Node runtime check" step.

## Known Stubs

None.

## Threat Flags

None. T-02-03 is mitigated by the runtime check (open and multi-major ranges fail, self-tested); T-02-SC by the lockfile refresh that changed only `@types/node` (`--package-lock-only --ignore-scripts`).

## Next Phase Readiness

Ready for the next plan in wave 2. Node 22 is the single documented and enforced runtime for the app and the voice agent; Langfuse 6.x (02-22) can rely on it.

## Self-Check: PASSED

- Created files present: scripts/ci/check-node-runtime.mjs, scripts/tests/check-node-runtime.node-test.mjs, .nvmrc
- Commits present on the branch: 31780ab, 409235f, 8aa5161
- Acceptance criteria re-run: engines `^22.12.0` ok; `FROM node:22-slim` count 1; `check-node-runtime` count in pr-smoke.yml 2; baileys-whatsapp diff empty; `22.12` present in AGENTS.md, README.md, .claude/CLAUDE.md; `node:22-slim` in .claude/CLAUDE.md
- Plan verification re-run: self-test 11/11, `node scripts/ci/check-node-runtime.mjs` ok, `check-workflows.py` OK, voice-agent lockfile in sync after commit
