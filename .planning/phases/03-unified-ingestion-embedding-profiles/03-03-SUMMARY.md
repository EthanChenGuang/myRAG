---
phase: 03-unified-ingestion-embedding-profiles
plan: 03
subsystem: infra
tags: [config, env, drift-check, eval-pins, vitest, node-test, voyage, deepinfra]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: check-config drift check with LANGFUSE_ pattern, env manifest, pinned eval env, loadRagConfig pattern
provides:
  - check-config discovers VOYAGE_* and DEEPINFRA_* names in src/ and the four tracked config files
  - 14 D-44 variables mirrored in env.ts, init-env.js, the three config-server templates and the Config UI, all managed in env-manifest.json
  - eval env pin regenerated with the nine new RAG_ switches at their legacy/off defaults
  - loadIngestConfig, a pure memoised parser of the ingest switches that falls back to legacy/off on any bad value
affects: [03-04, 03-08, 03-09, 03-13, 03-21, 03-26, 03-31, 03-43]

actuals:
  tokens: 10950
  tasks: 3
  commits: 5
plan_head_before: ccfcd7e0e02d332cc60a779fc7a84197888bf557
plan_head_after: 26ea25f435ff086b88318832579f6db30880a1ac

tech-stack:
  added: []
  patterns:
    - "Ingest switches are read through loadIngestConfig(env snapshot), never process.env directly"
    - "Invalid switch value resolves to today's behaviour and logs one [Ingest Config] warning per distinct value"
    - "Config UI inputs stay id-driven: a select, number or password input with the variable name as id is loaded and saved with no extra wiring"

key-files:
  created:
    - src/lib/rag/ingest/config.ts
    - tests/rag/ingest/config.test.ts
  modified:
    - scripts/check-config.mjs
    - scripts/check-config.test.mjs
    - src/lib/env.ts
    - scripts/init-env.js
    - scripts/config-server.js
    - scripts/config-ui/index.html
    - scripts/rag/env-manifest.json
    - eval/config/rag-eval-env.json

key-decisions:
  - "Booleans and enumerated switches are trimmed and lower-cased before matching, so ' Unified ' and 'TRUE' are accepted; anything else resolves to the off state with a warning"
  - "VOYAGE_API_KEY and DEEPINFRA_API_KEY join the 32-character short-secret warning in config-server and the Config UI, as the plan lists; the message wording is shared with the other secrets"
  - "Boolean switches are true/false selects in the Config UI (not checkboxes) so the stored value is always the literal the parser accepts"
  - "VOYAGE_* and DEEPINFRA_* are not RAG_ names, so the eval env pin does not carry them; only the nine RAG_ switches were added to the pin"

patterns-established:
  - "Drift-check test cases use syntheticTree with a one-variable manifest to isolate a single discovery rule"
  - "Config parser warnings are keyed by name:value so a repeated bad value never re-logs across different snapshots"

requirements-completed: [DATA-01, DATA-05, EMB-01, EMB-02, SEC-01]

coverage:
  - id: D1
    description: "check-config discovers VOYAGE_* and DEEPINFRA_* names, so drift in those variables fails CI"
    requirement: EMB-01
    verification:
      - kind: unit
        ref: "scripts/check-config.test.mjs (19 tests incl. four VOYAGE/DEEPINFRA cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fourteen D-44 variables in env.ts, init-env.js, three config-server templates and the Config UI with D-44 defaults, managed in the manifest"
    requirement: DATA-01
    verification:
      - kind: other
        ref: "node scripts/check-config.mjs -> ok: 93 variable(s) match the manifest"
        status: pass
    human_judgment: false
  - id: D3
    description: "Secrets have empty defaults, password inputs and short-secret entries; no key value is written anywhere"
    requirement: SEC-01
    verification:
      - kind: other
        ref: "grep of VOYAGE_API_KEY and DEEPINFRA_API_KEY defaults in init-env.js, env.ts, config-server.js; security.isSecretConfigEntry returns true for both"
        status: pass
    human_judgment: false
  - id: D4
    description: "Pinned eval env matches init-env.js after the new RAG_ switches"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/eval-env-pin.test.ts (2 tests); npx tsx eval/harness/eval-env.mts --check"
        status: pass
    human_judgment: false
  - id: D5
    description: "loadIngestConfig is a pure function of an env snapshot and falls back to legacy, llamaparse, off, off on invalid values with one warning per distinct value"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/config.test.ts (27 tests)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Config UI renders the Ingestion and embedding profiles card and saves it through the id-driven mechanism"
    requirement: EMB-02
    verification: []
    human_judgment: true
    rationale: "No browser was run against npm run config; only the HTML structure, the id-driven loader code path and node --check on the server were verified"

duration: 11min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 03: Ingestion and embedding profile switches Summary

**Fourteen Phase 3 variables now exist in all five config places with legacy/off defaults, check-config enforces VOYAGE_* and DEEPINFRA_* names, and loadIngestConfig parses every ingest switch as a pure, memoised function that falls back to today's behaviour.**

## Performance

- **Duration:** about 11 min
- **Started:** 2026-11-24T00:24Z (approximate; start time was not recorded at launch)
- **Completed:** 2026-11-24T00:35Z
- **Tasks:** 3 (Tasks 1 and 3 as TDD: test then feat)
- **Files modified:** 10

## Accomplishments

- `scripts/check-config.mjs` NAME_PATTERN includes `VOYAGE_[A-Z0-9_]+` and `DEEPINFRA_[A-Z0-9_]+`. Four new node:test cases: an unmanaged VOYAGE_API_KEY in a tracked file and an unmanaged DEEPINFRA_BASE_URL read in `src/` both fail with "used in src/ or a tracked file but not in the manifest"; a managed VOYAGE_API_KEY missing from init-env fails per location; `VOYAGER_X`, `VOYAGEX`, `XVOYAGE_KEY` and `DEEPINFRAX` are not matched.
- The 14 D-44 variables are in `src/lib/env.ts` (`process.env.X || 'default'`), `scripts/init-env.js` (new commented `INGESTION AND EMBEDDING PROFILES` section), all three `scripts/config-server.js` templates, and a new Config UI card. Defaults: RAG_INGEST_PIPELINE=legacy, RAG_PARSER=llamaparse, RAG_PARSE_POLL_BUDGET_MS=45000, the four feature flags false, RAG_INJECTION_SCAN=off, RAG_EMBEDDING_PROFILES=off, RAG_QWEN_EMBED_FALLBACK=openrouter, VOYAGE_BASE_URL=https://api.voyageai.com/v1, DEEPINFRA_BASE_URL=https://api.deepinfra.com/v1/openai, both API keys empty.
- Config UI card holds selects for the enumerated switches and the four booleans, a number input (1000 to 55000) for the poll budget, text inputs for the two base URLs, and password inputs with the reveal button for the two keys. Both keys are in the short-secret warning list in `config-server.js` and `index.html`.
- `scripts/rag/env-manifest.json` has 14 new managed entries in sorted order (93 variables). `eval/config/rag-eval-env.json` regenerated; it gained exactly the nine new RAG_ switches at their defaults.
- `src/lib/rag/ingest/config.ts` exports `loadIngestConfig`, `resetIngestConfigForTests`, `IngestEnvInput`, `IngestConfig` (plus the value-union types and `DEFAULT_PARSE_POLL_BUDGET_MS`). Memoised by the JSON of the ten inputs, warnings deduplicated per `name:value`, never reads `process.env`.

## Task Commits

1. **Task 1: check-config discovers VOYAGE_* and DEEPINFRA_* names** - `8db994f` (test, RED), `671c1c6` (feat, GREEN)
2. **Task 2: D-44 variables in the five locations, manifest and eval pin** - `f0f6b66` (feat)
3. **Task 3: loadIngestConfig** - `293f1ed` (test, RED), `26ea25f` (feat, GREEN)

**Plan metadata:** committed with this SUMMARY (docs). `commits: 5` is measured from the plan ledger before the SUMMARY commit.

## TDD Evidence

- **Task 1 RED (`8db994f`):** `node --test scripts/check-config.test.mjs` gave 17 pass, 2 fail. The two failing tests (VOYAGE_API_KEY in env.ts, DEEPINFRA_BASE_URL in src/) failed on `0 !== 1` for the exit code, which is the planned behaviour (check-config must exit 1 on an unmanaged name). The other two new tests pass before and after by design: one is manifest-driven and one is a negative guard. GREEN: 19 pass, 0 fail.
- **Task 3 RED (`293f1ed`):** the commit carries a stub `config.ts` that returns the default config without parsing, so the target file loads and every parsing case fails on its assertion (for example `expected 'legacy' to be 'unified'`). 23 failed, 4 passed (the three default-snapshot tests and the no-process.env test, which a defaults-only stub satisfies). GREEN: 27 passed.
- **Classifier note:** `gsd_run check tdd-red-evidence` returned `INVALID_RED (invalid_record)` for the vitest `tap` and `tap-flat` reports ("Non-TAP data in report", "Malformed TAP"), so the machine verdict was not obtained. `workflow.tdd_mode` is not enabled in this project, and the semantic assessment was done by hand: the target tests ran, failed on the planned assertions, and there were no import, syntax or fixture errors. Evidence files stayed in the ignored `.gsd/tdd-evidence/` directory.

## Files Created/Modified

- `scripts/check-config.mjs` - VOYAGE_ and DEEPINFRA_ added to NAME_PATTERN
- `scripts/check-config.test.mjs` - four discovery cases
- `src/lib/env.ts` - typed defaults for the 14 names
- `scripts/init-env.js` - Ingestion and embedding profiles section with one-line format comments
- `scripts/config-server.js` - all three template blocks plus short-secret warning
- `scripts/config-ui/index.html` - new card and short-secret list
- `scripts/rag/env-manifest.json` - 14 managed entries
- `eval/config/rag-eval-env.json` - nine new pinned switches
- `src/lib/rag/ingest/config.ts` - pure ingest switch parser (new)
- `tests/rag/ingest/config.test.ts` - 27 tests (new)

## Decisions Made

- Matching is case-insensitive after trim for enums and booleans. The plan's behaviour line requires `Unified ` to be accepted; booleans follow the same rule for consistency, and any other value resolves to the off state.
- Qwen model ids stay out of the five-location chat model lists, per the plan's D-44 adjustment and F-6; no `LLAMACLOUD_API_KEY` was added (the existing `LLAMA_CLOUD_API_KEY` is reused).
- The short-secret message reads "must be at least 32 characters; the endpoint answers 503 until it is" and now also applies to the two embedding keys. That wording fits the endpoint secrets better than provider keys; the plan asked for list membership and nothing else, so the wording was left alone.

## Deviations from Plan

None - plan executed exactly as written.

The task read_first list said to re-read Phase 2 plan outputs at HEAD; `NAME_PATTERN`, the `LANGFUSE_` tests, the three config-server templates and the Config UI anchors matched the 03-PATTERNS description, with line numbers moved by Phase 2 as expected.

## Issues Encountered

- The worktree branch is `exec/03-03`, not in the `agent-*` namespace that the executor's per-agent branch allow-list expects. The orchestrator named this branch in the brief, so commits were made on it; HEAD was never on a protected branch.
- The commit trailer follows the executor's own session attribution (Sonnet 5.5) rather than the model name in the common brief, per the plan's commit rule ("never copy them from a plan").

## User Setup Required

None - no external service configuration required. `.env.local` is not tracked; running `npm run config` adds the new names from `init-env.js`. No key values were written anywhere.

## Next Phase Readiness

- Later plans can read `env.RAG_INGEST_PIPELINE`, `env.RAG_PARSER`, `env.RAG_PARSE_POLL_BUDGET_MS`, the four flag names, `env.RAG_INJECTION_SCAN`, `env.RAG_EMBEDDING_PROFILES`, `env.RAG_QWEN_EMBED_FALLBACK` and the Voyage and DeepInfra names from `@/lib/env`, and pass a snapshot to `loadIngestConfig` (for example through an `IngestDeps.ingestEnv()` thunk in 03-13) without touching config files again.
- `config-server.js` is edited again in 03-31 and 03-43 (sequential waves).

## Verification

- `node --test scripts/check-config.test.mjs`: 19 pass, 0 fail
- `node scripts/check-config.mjs`: ok, 93 variables match the manifest
- `npx tsx eval/harness/eval-env.mts --check`: pins match init-env.js
- `npx vitest run tests/rag/ingest/config.test.ts tests/eval-env-pin.test.ts`: 27 + 2 passed
- `npm run typecheck:new`: no Phase 1 type errors
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 109 files, 1360 tests passed (tests/rag/langfuse-pins.test.ts passed in this worktree)
- `node --import tsx --test tests/*.test.mts`: 136 pass, 0 fail
- `node scripts/ci/check-rag-boundary.mjs`: ok, 622 files, no violations
- `python3 scripts/ci/check-workflows.py`: OK
- `node --check` on `scripts/config-server.js` and `scripts/init-env.js`: ok
- Task acceptance greps: `RAG_INGEST_PIPELINE` in config-server.js = 3 (>= 3); `RAG_EMBEDDING_PROFILES|RAG_INJECTION_SCAN|RAG_PARSER` in env.ts = 3 (>= 3); manifest key names = 2 (>= 2); `id="VOYAGE_API_KEY"` in index.html = 1 (>= 1); `VOYAGE_[A-Z0-9_]` in check-config.mjs = 1 (>= 1); `[Ingest Config]` in config.ts = 1 (>= 1)
- rag-sidecar was not touched, so its pytest was not run.

## Known Stubs

None.

## Threat Flags

None. T-03-08: both keys have empty defaults in every template, password inputs with reveal, short-secret entries, and `security.isSecretConfigEntry` classifies both as secrets; the new module logs only the offending switch value, never a key. T-03-09: `loadIngestConfig` falls back to legacy/off on anything unknown. T-03-SC: no package changes.

## Self-Check: PASSED

- `src/lib/rag/ingest/config.ts` and `tests/rag/ingest/config.test.ts` exist on disk.
- Commits `8db994f`, `671c1c6`, `f0f6b66`, `293f1ed`, `26ea25f` are ancestors of HEAD.
