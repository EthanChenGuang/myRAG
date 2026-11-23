---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 36
subsystem: ci
tags: [typescript, nextjs-16, tsc, ci, build-gate]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: zero tsc errors across the app (plans 02-19, 02-20, 02-28 to 02-35)
provides:
  - CI ts job runs plain `npx tsc --noEmit -p tsconfig.json` after `npx next typegen`
  - Root ratchet baseline removed; sibling-package ratchet kept
  - next.config.js `typescript.ignoreBuildErrors: false` (own commit)
  - AGENTS.md quality checklist requires the zero-error type-check
affects: [ci, vercel-build]

requirements-completed: [PIPE-01, PIPE-08]

actuals:
  tokens: 4000
  tasks: 2
  commits: 2
plan_head_before: 53a88e54c72ce57f9aeef1828b7913d339e94dac
plan_head_after: 3ca2aed4bf6206e1a938374133c812cdb79c5e45

key-files:
  created: []
  modified:
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py
    - scripts/ci/tsc-ratchet.mjs
    - AGENTS.md
    - next.config.js
    - tests/rag-legacy-differential.test.mts
  deleted:
    - scripts/ci/tsc-baseline.json

key-decisions:
  - "tsc-ratchet.mjs and its self-test stay because the sibling-types and voice-agent jobs still use them; only its default baseline path moved to sibling-tsc-baseline.json so nothing references the deleted file"
  - "check-workflows.py now asserts the ts job runs plain tsc and rejects any root ratchet or tsc-baseline.json reference"

patterns-established:
  - "Root app: type errors fail CI (plain tsc) and the Next.js build (ignoreBuildErrors false)"

duration: 20min
completed: 2026-11-23
---

# Phase 2 Plan 36: Zero type errors, plain tsc in CI, build fails on type errors Summary

CI now runs `npx next typegen` then `npx tsc --noEmit -p tsconfig.json` instead of the per-file ratchet, the root baseline is deleted, and `next build` fails on type errors via `ignoreBuildErrors: false` in its own revertible commit.

## Tasks

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Zero errors, plain tsc in CI, ratchet baseline removed | d1dae27 |
| 2 | Type errors fail the build (own commit) | 3ca2aed |

## Results

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors (already zero on entry; no source fixes needed).
- Local `next build` (Turbopack, placeholder env from tests/setup-env.ts): exit 0, log shows `Running TypeScript ... Finished TypeScript`, no "Type error" or "Failed to type check".
- `npx vitest run`: 79 files, 900 tests passed. `node --import tsx --test tests/*.test.mts`: 86 passed. `scripts/check-config.test.mjs`, `typecheck-new.test.mjs`, `tsc-ratchet.node-test.mjs`: 34 passed.
- `check-rag-boundary`, `check-node-runtime`, `check-config`, `check-workflows.py` (prints OK): pass. `npm run typecheck:new`: exit 0.

## Replacement for the removed gate

`node scripts/ci/tsc-ratchet.mjs` (root) is gone: its baseline `scripts/ci/tsc-baseline.json` was deleted. Replacement command: `npx next typegen && npx tsc --noEmit -p tsconfig.json` (exits 0). The sibling ratchets (`tsc-ratchet.mjs --cwd voice-agent|baileys-whatsapp --baseline scripts/ci/sibling-tsc-baseline.json --key ...`) are unchanged.

## Deviations from Plan

**1. [Rule 1 - Bug] typecheck:new failed on one .mts test file**
- **Found during:** Task 1 (the plan's verify command includes `npm run typecheck:new`)
- **Issue:** `tests/rag-legacy-differential.test.mts:30` used `<T>(value: T)`, which TS7060 rejects in `.mts` files; tsconfig does not include `.mts`, so plain tsc never saw it.
- **Fix:** `<T,>(value: T)`, behaviour-preserving one-character fix. Owned by plans 02-19/02-26 but trivial.
- **Files modified:** tests/rag-legacy-differential.test.mts
- **Commit:** d1dae27

**2. [Rule 3 - Blocking] Local build verification environment**
- Turbopack cannot resolve `next` through the shared `node_modules` symlink in the worktree ("Could not find the Next.js package"). I temporarily replaced the symlink with a hardlink copy for the build, then restored the symlink. Nothing from this is committed. A first attempt without the placeholder env stopped after the type-check phase at "Collecting page data" with `supabaseUrl is required` (missing env, not a type error); with placeholders the build exits 0. Vercel build remains a VERIFICATION live item (T-02-88).

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Commits d1dae27 and 3ca2aed exist on exec/02-36; scripts/ci/tsc-baseline.json shows status D in d1dae27; `grep -c "npx tsc --noEmit -p tsconfig.json" .github/workflows/pr-smoke.yml` is 1; `ignoreBuildErrors: false` present and no uncommented `true`.
