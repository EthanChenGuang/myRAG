---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 03
subsystem: infra
tags: [config, env, langfuse, drift-check, eval-pins, node-test]

requires:
  - phase: 01-eval-foundation
    provides: check-config drift check, env manifest, pinned eval env
provides:
  - check-config discovers LANGFUSE_* names in src/ and the four tracked config files
  - 13 new Phase 2 variables mirrored in init-env.js, env.ts, config-server.js (three blocks) and the Config UI
  - RAG_FINAL_RESULT_COUNT read through env.ts (default '25')
  - Manifest entries (managed) for all 13 new names; RAG_FINAL_RESULT_COUNT gap reduced to config-ui
  - Eval env pins re-derived with RAG_PIPELINE=legacy and empty stage lists; voice token and embed tenant excluded
affects: [02-04, 02-05, 02-06, 02-07, 02-08, 02-09, 02-10]

actuals:
  tokens: 7100
  tasks: 2
  commits: 3
plan_head_before: e2cb15bcc01c321ca7736affa6a2aef0c9314b11
plan_head_after: c71e614d97d58a57b317c5c5ea0c777aa19dbc23

tech-stack:
  added: []
  patterns:
    - "New env variables land in all five places in one plan so later plans only read env.X"
    - "Config UI inputs are id-driven: a new input with the variable name as id is loaded and saved with no extra wiring"

key-files:
  created: []
  modified:
    - scripts/check-config.mjs
    - scripts/check-config.test.mjs
    - scripts/init-env.js
    - src/lib/env.ts
    - scripts/config-server.js
    - scripts/config-ui/index.html
    - scripts/rag/env-manifest.json
    - eval/harness/eval-env.mts
    - eval/config/rag-eval-env.json

key-decisions:
  - "NAME_PATTERN gains a LANGFUSE_ alternative, so an unmanaged or missing LANGFUSE_ name fails check-config like RAG_ names do"
  - "RAG_VOICE_TOKEN_ prefix and RAG_EMBED_TENANT are excluded from eval pins: a deployment's secret and tenant identity never enter a parity run"
  - "RAG_PIPELINE, RAG_DISABLED_STAGES and RAG_STAGE_TIMEOUTS are pinned (legacy and empty) so parity runs stay on today's path"
  - "RAG_VOICE_TOKEN_SECRET joins the short-secret warning in config-server and the Config UI; LANGFUSE_SECRET_KEY is a password input with an empty default and is not length-checked"

patterns-established:
  - "Drift-check test cases use syntheticTree with a one-variable manifest to isolate a single discovery rule"

requirements-completed: [PIPE-03, PIPE-04, PIPE-07, PIPE-09, OBS-01, EVAL-15]

coverage:
  - id: D1
    description: "check-config discovers LANGFUSE_* names in src/ and tracked files and holds them to the manifest"
    requirement: PIPE-09
    verification:
      - kind: unit
        ref: "scripts/check-config.test.mjs (15 tests incl. two LANGFUSE cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "13 new variables synchronised in init-env.js, env.ts, config-server.js (all three template blocks) and config-ui, each managed in the manifest, zero check-config violations"
    requirement: PIPE-03
    verification:
      - kind: other
        ref: "node scripts/check-config.mjs -> ok: 78 variable(s) match the manifest"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every new switch defaults to legacy or off; secrets are empty placeholders; RAG_FINAL_RESULT_COUNT read via env.ts"
    requirement: OBS-01
    verification:
      - kind: other
        ref: "grep of defaults in scripts/init-env.js and src/lib/env.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Pinned eval env derivable from init-env.js, excludes voice token variables and the embed tenant, and the smoke tier still passes the gate"
    requirement: EVAL-15
    verification:
      - kind: unit
        ref: "tests/eval-env-pin.test.ts (2 tests); npx tsx eval/harness/eval-env.mts --check"
        status: pass
      - kind: other
        ref: "npm run test-rag -- --out eval/out/env-sync -> gate: PASS"
        status: pass
    human_judgment: false
  - id: D5
    description: "Config UI renders the new Retrieval pipeline and Langfuse tracing cards and saves them through the generic id-driven mechanism"
    requirement: PIPE-09
    verification: []
    human_judgment: true
    rationale: "No browser was run against npm run config; only the HTML structure, the id-driven loader code path and node --check on the server were verified"

duration: 9min
completed: 2026-11-23
status: complete
---

# Phase 2 Plan 03: Environment variables for the unified pipeline and Langfuse Summary

**Thirteen new Phase 2 switches (RAG_PIPELINE, stage disable and timeout lists, embed tenant, voice token secret and TTL, seven LANGFUSE_* names) now exist in all five config places with legacy/off defaults, and check-config enforces LANGFUSE_* names like RAG_* names.**

## Performance

- **Duration:** about 9 min
- **Completed:** 2026-11-23
- **Tasks:** 2 (Task 1 as TDD: test then feat)
- **Files modified:** 9

## Accomplishments

- `scripts/check-config.mjs` NAME_PATTERN includes `LANGFUSE_[A-Z0-9_]+`. Two new node:test cases: an unmanaged LANGFUSE_ name read in `src/` or present in a tracked file fails with "used in src/ or a tracked file but not in the manifest", and a managed LANGFUSE_PUBLIC_KEY missing from config-ui fails with "missing from this location". The first failed before the pattern change (RED) and passes after.
- `scripts/init-env.js` gains a "Retrieval pipeline" block and a "Langfuse tracing" block with one-line format comments. Defaults: RAG_PIPELINE=legacy, RAG_DISABLED_STAGES and RAG_STAGE_TIMEOUTS empty, RAG_EMBED_TENANT empty, RAG_VOICE_TOKEN_SECRET empty, RAG_VOICE_TOKEN_TTL_SECONDS=3600, LANGFUSE_ENABLED=false, LANGFUSE_BASE_URL=https://cloud.langfuse.com, LANGFUSE_SAMPLE_RATE=0.1, LANGFUSE_CAPTURE_CONTENT=false, LANGFUSE_REVIEW_SAMPLE_RATE=0, both Langfuse keys empty.
- `src/lib/env.ts` carries the 13 names plus `RAG_FINAL_RESULT_COUNT` (default '25') next to the RAG_EVAL_* entries.
- `scripts/config-server.js` writes every new name in all three template blocks; RAG_VOICE_TOKEN_SECRET (four occurrences) is added to the short-secret warning.
- `scripts/config-ui/index.html` has a "Retrieval pipeline" card and a "Langfuse tracing" card: toggles for LANGFUSE_ENABLED and LANGFUSE_CAPTURE_CONTENT, password inputs with the reveal button for RAG_VOICE_TOKEN_SECRET and LANGFUSE_SECRET_KEY, text inputs for the rest; RAG_VOICE_TOKEN_SECRET is in the short-secret toast list.
- `scripts/rag/env-manifest.json`: 13 managed entries in sorted order (78 variables total); RAG_FINAL_RESULT_COUNT knownGaps is now `["config-ui"]`.
- `eval/harness/eval-env.mts` excludes the `RAG_VOICE_TOKEN_` prefix and `RAG_EMBED_TENANT`; `eval/config/rag-eval-env.json` regenerated, gaining only RAG_PIPELINE=legacy, RAG_DISABLED_STAGES="" and RAG_STAGE_TIMEOUTS="".

## Task Commits

1. **Task 1: check-config discovers LANGFUSE_* names** - `0715927` (test, RED), `ba9bd63` (feat, GREEN)
2. **Task 2: new variables in all five places, manifest and eval pins** - `c71e614` (feat)

**Plan metadata:** committed with this SUMMARY (docs).

## Files Created/Modified

- `scripts/check-config.mjs` - LANGFUSE_ added to NAME_PATTERN
- `scripts/check-config.test.mjs` - two LANGFUSE cases
- `scripts/init-env.js` - Retrieval pipeline and Langfuse tracing blocks
- `src/lib/env.ts` - typed defaults for the 13 names and RAG_FINAL_RESULT_COUNT
- `scripts/config-server.js` - all three template blocks plus short-secret warning
- `scripts/config-ui/index.html` - two new cards and the short-secret list
- `scripts/rag/env-manifest.json` - 13 managed entries, RAG_FINAL_RESULT_COUNT gap update
- `eval/harness/eval-env.mts`, `eval/config/rag-eval-env.json` - exclusions and re-derived pins

## Decisions Made

- The comment for RAG_EMBED_TENANT in init-env.js states the D-09 semantics: empty means `s:default` in single-tenant and fails closed in multi-tenant. The env default itself stays empty as the plan specifies; resolving the default is the job of the later embed-scope plan.
- LANGFUSE_SECRET_KEY is treated as a secret (password input, empty placeholder, excluded from pins because the pin derivation only takes RAG_ names) but is not added to the 32-character warning, since the plan lists only RAG_VOICE_TOKEN_SECRET there.

## Deviations from Plan

None - plan executed exactly as written. The "managed LANGFUSE_PUBLIC_KEY missing from config-ui" test passes before and after the pattern change because the missing-location check is manifest-driven; it was added to lock that behaviour in, and the first new test supplies the RED.

## Issues Encountered

None.

## Verification

- `node --test scripts/check-config.test.mjs`: 15 pass, 0 fail
- `node scripts/check-config.mjs`: ok, 78 variables match the manifest
- `npx tsx eval/harness/eval-env.mts --check`: pins match init-env.js
- `npx vitest run tests/eval-env-pin.test.ts`: 2 passed
- `npm run test-rag -- --out eval/out/env-sync`: gate PASS (72 items, recall@5 0.574, MRR 0.596)
- `node --check` on config-server.js and init-env.js: ok
- All task acceptance criteria re-run and pass (grep counts, manifest managed check, pin content check)

## Known Stubs

None.

## Threat Flags

None. T-02-05 mitigations applied: empty secret placeholders in every template, password inputs in the Config UI, voice token and embed tenant excluded from eval pins, config-server logs only the secret length. T-02-06: check-config now fails on any unmanaged or missing LANGFUSE_ name.

## Next Phase Readiness

Later Phase 2 plans can read `env.RAG_PIPELINE`, `env.RAG_DISABLED_STAGES`, `env.RAG_STAGE_TIMEOUTS`, `env.RAG_EMBED_TENANT`, `env.RAG_VOICE_TOKEN_SECRET`, `env.RAG_VOICE_TOKEN_TTL_SECONDS`, the `LANGFUSE_*` names and `env.RAG_FINAL_RESULT_COUNT` without touching config files again. `.env.local` is not tracked; running `npm run config` adds the names from init-env.js.

## Self-Check: PASSED

- Modified files exist on disk; commits `0715927`, `ba9bd63`, `c71e614` are ancestors of HEAD.
