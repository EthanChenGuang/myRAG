---
phase: 01-evaluation-harness-baseline
plan: 11
subsystem: infra
tags: [config-drift, env-manifest, check-config, config-ui, node-test]

requires:
  - phase: 01-04
    provides: "RAG_EVAL_ENDPOINT_ENABLED, RAG_EVAL_SECRET, RAG_SIDECAR_URL, RAG_SIDECAR_SECRET entries in src/lib/env.ts"
  - phase: 01-10
    provides: "eval-env.mts derive filter that already excludes RAG_EVAL_* and RAG_SIDECAR_*"
provides:
  - "The four Phase 1 variables in scripts/init-env.js, all three template blocks of scripts/config-server.js, and a Config UI card (RAG modes tab) with masked secrets"
  - "scripts/rag/env-manifest.json: 64 variables once each, 4 managed, 60 legacy of which 44 carry measured knownGaps (82 gap entries)"
  - "node scripts/check-config.mjs [--root <dir>]: five-location drift check with knownGaps ratchet, exit 0/1"
  - "scripts/check-config.test.mjs: 13 node:test cases proving the check fails on injected drift"
affects: [01-22, ci, config-sync]

plan_head_before: 3ec91f76a97003203cbed0da690ca7642384c189
plan_head_after: e12b7aee2866e20592ff1d9bddb298ccc41fc89b

actuals:
  tokens: 8200
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Config drift gate: manifest of every RAG env var with status managed|legacy and a knownGaps list that can only shrink (stale gap fails)"
    - "check-config exports its functions and runs main only when invoked directly, so scratch tooling can reuse discovery"
    - "Self-test builds a temp root (copy of tracked files or a synthetic tree) and runs the script with --root"

key-files:
  created:
    - scripts/check-config.mjs
    - scripts/check-config.test.mjs
    - scripts/rag/env-manifest.json
  modified:
    - scripts/init-env.js
    - scripts/config-server.js
    - scripts/config-ui/index.html

key-decisions:
  - "Manifest was seeded by measuring the tree with the script's own discovery (src process.env/env reads plus every matching name in the four tracked files): 64 names, not the 51 in RESEARCH, because discovery also covers NEXT_PUBLIC_RAG_* and LLAMACLOUD_* names and the four new variables"
  - "knownGaps may only name the four tracked locations; env-local is checked only for managed variables and only when .env.local exists"
  - "The Config UI card sits in the RAG modes tab; no new JavaScript was needed because populateFields and the delegated change handler key on element id and the reveal button handler keys on data-for"
  - "EVAL-13 left Pending in REQUIREMENTS.md: its text says the script runs in CI, and the workflow that calls it is plan 01-22"

patterns-established:
  - "Adding a RAG env var now requires the manifest entry and all four tracked locations, or node scripts/check-config.mjs exits 1"

requirements-completed: []

coverage:
  - id: D1
    description: "The four variables appear in init-env, env.ts, all three config-server blocks and the Config UI with false/empty defaults; the secret template line carries no value"
    requirement: EVAL-13
    verification:
      - kind: integration
        ref: "four-by-four grep loop passes; node --check on config-server.js and init-env.js; grep -c RAG_SIDECAR_SECRET config-server.js == 3; grep -Ec '^RAG_EVAL_SECRET=.+' init-env.js == 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "Config UI exposes the eval switch as an unchecked toggle and both secrets as password inputs with reveal buttons"
    requirement: EVAL-13
    verification:
      - kind: integration
        ref: "grep type=\"password\" id=\"RAG_EVAL_SECRET\" == 1; id=\"RAG_SIDECAR_URL\" present; markup reviewed against the EXA_API_KEY input; not exercised in a browser"
        status: pass
    human_judgment: true
  - id: D3
    description: "check-config exits 0 on today's tree and exits 1 on each drift rule (deleted variable, stale gap, undiscovered src variable, managed with gaps, adjacency names, missing file, zero vars, duplicate name, .env.local present without a managed var), printing violations sorted by name then location"
    requirement: EVAL-13
    verification:
      - kind: unit
        ref: "node scripts/check-config.mjs exit 0; node --test scripts/check-config.test.mjs -> 13 pass, 0 fail"
        status: pass
    human_judgment: false
  - id: D4
    description: "Existing suites stay green and the pinned eval env still matches init-env.js"
    requirement: EVAL-13
    verification:
      - kind: integration
        ref: "npm test (10 passed); npm run test-rag (trace and run.json validate); eval-env.mts --check matches"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 11: Config Mirror and check-config Drift Gate Summary

**The four eval/sidecar variables are mirrored into init-env, config-server and the Config UI with off/empty defaults, and `check-config` plus a 64-variable manifest turns the five-location rule into a check that fails on drift while grandfathering today's 44 legacy gaps**

## Performance

- **Duration:** about 15 min (start time was not captured at launch; estimate)
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments
- `RAG_EVAL_ENDPOINT_ENABLED=false`, `RAG_EVAL_SECRET=`, `RAG_SIDECAR_URL=`, `RAG_SIDECAR_SECRET=` are in `scripts/init-env.js` under a "RAG EVALUATION & SIDECAR" section and in all three `config-server.js` template blocks, each in that block's own idiom. The "Evaluation & Sidecar" card in the RAG modes tab has an unchecked toggle with a production warning, two password inputs with the existing reveal button, and a URL input.
- `check-config.mjs` implements the five fail rules from RESEARCH Pattern 7 plus unknown-gap-location and bad-status checks. Presence uses `(?<![A-Z0-9_])NAME(?![A-Z0-9_])`, so `RAG_RERANKING` vs `RAG_RERANKING_STRATEGY` and `NEXT_PUBLIC_RAG_CACHE_ENABLED` vs `RAG_CACHE_ENABLED` stay distinct (both covered by tests).
- The manifest was measured, not copied: 64 names, 20 present everywhere (the 4 new ones plus 16 legacy), 44 legacy with gaps, 82 gap entries in total. Legacy gaps were not fixed.

## Task Commits

1. **Task 1: Mirror the four variables into init-env, config-server and the Config UI** - `1231edd` (feat)
2. **Task 2: Env manifest, check-config and the drift self-test** - `e12b7ae` (feat)

**Plan metadata:** committed separately (docs: complete plan)

## Decisions Made
See `key-decisions` above.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- The plan's file list names `src/lib/env.ts` as a tracked location but it was already updated by plan 01-04, so it needed no edit here.
- `scripts/check-config.test.mjs` is a `node:test` file; Vitest's include is `tests/**/*.test.ts`, so `npm test` does not pick it up and it must be run with `node --test` (plan 01-22 does this in CI).
- No `.env.local` exists in this checkout, so the env-local location was exercised only through the test that creates one in a temp root.
- Config UI changes were checked by grep and markup comparison, not in a browser.

## Known Stubs
None.

## Threat Flags
None. T-01-08 is mitigated (`^RAG_EVAL_SECRET=.+` count is 0 in init-env.js; both secrets are `type="password"` inputs) and T-01-09 is mitigated (switch defaults to false in init-env, the three config-server blocks and env.ts; the UI toggle is unchecked by default with a warning).

## User Setup Required
None. Developers with an existing `.env.local` will see `check-config` report the four managed variables as missing until they run `npm run config` or add them.

## Next Phase Readiness
- Plan 01-22 can call `node scripts/check-config.mjs` and `node --test scripts/check-config.test.mjs` from the workflow.
- EVAL-13 stays Pending in REQUIREMENTS.md until that workflow runs the check in CI.

## Self-Check: PASSED

Created files `scripts/check-config.mjs`, `scripts/check-config.test.mjs` and `scripts/rag/env-manifest.json` exist; commits `1231edd` and `e12b7ae` are ancestors of HEAD; `node scripts/check-config.mjs` exits 0, `node --test scripts/check-config.test.mjs` reports 13 pass and 0 fail, `npm test` and `npm run test-rag` pass.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
