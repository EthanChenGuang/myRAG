---
phase: 07-external-backends-release-defaults
plan: 04
subsystem: rag-config
tags: [config, vector-backends, weaviate, qdrant, env]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "RagConfig v2 parsing (04-02); BackendId and RETRIEVAL_BACKEND_IDS in src/lib/rag/backend/types.ts (04-01)"
  - phase: 06
    provides: "last editor of the five config locations (06-40)"
provides:
  - "Ten managed D-24 env names in env.ts, init-env.js, the three config-server.js templates, the Config UI and the env manifest"
  - "RagConfig.backend { default, voice, maxLagSeconds } and RagEnvInput fields RAG_RETRIEVAL_BACKEND, RAG_RETRIEVAL_BACKEND_VOICE, RAG_VECTOR_SYNC_MAX_LAG_SECONDS"
  - "BackendConfig type and DEFAULT_MAX_LAG_SECONDS (300) exported from src/lib/rag/config.ts"
affects: [07-06, 07-07, 07-08, 07-10, 07-11, 07-12, 07-14, 07-15, 07-18, 07-20]

actuals:
  tokens: 60000
  tasks: 2
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Backend selection is a typed config value; secrets (vendor keys, sync secret) stay out of RagConfig and are read through env.ts by client modules"

key-files:
  created: []
  modified:
    - src/lib/env.ts
    - scripts/init-env.js
    - scripts/config-server.js
    - scripts/config-ui/index.html
    - scripts/rag/env-manifest.json
    - scripts/check-config.mjs
    - scripts/check-config.test.mjs
    - eval/config/rag-eval-env.json
    - tests/eval-env-pin.test.ts
    - src/lib/rag/config.ts
    - src/lib/rag/deps.ts
    - tests/rag/config.test.ts

key-decisions:
  - "Unknown backend value uses parseNamedChoice: pgvector fallback, one [RAG Config] warning naming the variable (the backend value is not a secret and is echoed, like other choice switches)"
  - "Lag parsing: only a positive decimal integer is kept; 0, negatives, decimals and non-numbers give 300 with one warning; no upper cap"
  - "The three backend values join the loadRagConfig memo key"
  - "check-config discovery now covers WEAVIATE_* and QDRANT_* names so an unmanifested vendor variable in src/ fails the check"
  - "The Config UI gets a hand-written 'Vector backends' card next to the voice card; plan 07-20 replaces it with the generated section (UI-SPEC 6.2.5)"

requirements-completed: [ADM-01, RET-09]
---

# Phase 7 Plan 04: D-24 env names and RagConfig.backend

The ten D-24 vector-backend variables are configurable in every location with pgvector defaults and empty secrets, and the RAG config parses chat backend, voice backend and the sync lag bound.

## Tasks

| Task | Commits |
|------|---------|
| 1. Ten names in the five locations, manifest and eval pin | `9b5d2e90` test (RED), `f39661a0` feat, `5074dd05` fix (numeric keypad on the lag field) |
| 2. RagConfig.backend parsing | `69338013` test (RED), `db09398c` feat |

## What changed

- `src/lib/env.ts`: the ten names after `VOICE_MAX_ACTIVE_ROOMS` with defaults `pgvector`, `pgvector`, `''`, `'300'` and empty URLs and keys.
- `scripts/init-env.js`: `# VECTOR BACKENDS (Phase 7)` banner, one comment per variable, secrets empty.
- `scripts/config-server.js`: all three templates (save, standard, full); `RAG_VECTOR_SYNC_SECRET` added to the 32-character warning list. The Config UI short-secret list has it too.
- `scripts/config-ui/index.html`: "Vector backends" card with selects (pgvector, weaviate, qdrant) for both backends, password inputs with show/hide buttons for the four keys and the sync secret, URL inputs for the endpoints, numeric input for the lag.
- `scripts/rag/env-manifest.json`: ten `managed` entries with `knownGaps: []` (D-14 metadata comes in 07-18). The manifest is not sorted, so the entries are appended.
- `eval/config/rag-eval-env.json`: regenerated with `eval-env.mts --write`; the diff is exactly `RAG_RETRIEVAL_BACKEND=pgvector`, `RAG_RETRIEVAL_BACKEND_VOICE=pgvector`, `RAG_VECTOR_SYNC_MAX_LAG_SECONDS=300`, `RAG_VECTOR_SYNC_SECRET=""`. No WEAVIATE_/QDRANT_ name is pinned (the pin derives RAG_* only).
- `src/lib/rag/config.ts`: `BackendConfig`, `DEFAULT_MAX_LAG_SECONDS`, `parseBackend`, `parsePositiveInt`; `RagConfig.backend`.
- `src/lib/rag/deps.ts`: `readRagEnvInput` passes the three non-secret names.

## Behaviour

With the defaults nothing outside the config objects changes: no code reads `RagConfig.backend` yet (07-12 adds the factory and its legacy ignore rule). `RAG_PIPELINE=legacy` still parses the backend values.

## Tests that failed before the change

- `scripts/check-config.test.mjs`: 6 new cases failed on assertions (QDRANT/WEAVIATE discovery, manifest entries, removal per location, defaults and empty secrets, masking and warning list, UI selects and password inputs). The fixture case "reports exactly the location that lacks RAG_RETRIEVAL_BACKEND" passes on the old code too; it is a regression case.
- `tests/rag/config.test.ts`: 12 new cases in "retrieval backend (D-11, D-24)" failed (`backend` undefined: one `toEqual` assertion, the others a TypeError reading `.default` of undefined, not module-not-found).
- `tests/eval-env-pin.test.ts`: the new D-24 pin case failed until the pin was regenerated.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors; `npm run typecheck:new`: clean
- `npx vitest run` (full suite, because env.ts and src/lib/rag/config.ts changed): 7577 passed, 4 skipped, 0 failed
- `node --test scripts/check-config.test.mjs`: 52 pass, 0 fail
- `node scripts/check-config.mjs`: ok, 202 variables
- `node scripts/ci/check-rag-boundary.mjs`: ok
- `npx vitest run tests/eval-env-pin.test.ts`: 7 passed
- `npm run test-rag -- --out eval/out/07-04`: gate PASS (7 skipped)
- `npm run test-rag -- --fixture-mode ingest --out eval/out/07-04-ingest`: gate PASS (7 skipped)
- `node scripts/ci/check-frontend-design-summary.mjs .planning/phases/07-external-backends-release-defaults`: PASS
- Not run (not touched): rag-db tests, workflow check, Python suites, gen:schemas.

## Deviations

- `src/lib/rag/deps.ts` is not in the plan's files_modified; without it the new RagEnvInput fields would never be filled from the process env (the key_link "RagEnvInput carries ..." needs it).
- `scripts/check-config.mjs` was extended (WEAVIATE_/QDRANT_ in the discovery pattern), so a vendor variable read in src/ without a manifest entry fails the check.
- Plan said "a select for both backend variables"; done, plus `type="url"` for the endpoint fields and `inputmode="numeric"` for the lag.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | interim card in the existing Config UI idiom (card, form-control, select, password + reveal button); the designed section is 07-20 per 07-UI-SPEC 6.2.5 | n/a |
| Impeccable | no new visual direction; copy kept short and domain neutral | n/a |
| web-design-guidelines | self-review of the new card: labels tied with `for`, `type="button"` and `aria-label` on reveal buttons, `autocomplete="off"` on secrets, `type="url"` and `inputmode="numeric"` on the right fields, `translate="no"` on identifiers | pass (all findings resolved) |

## Operator actions

None. No live API call is needed; vendor keys stay empty until an operator sets them.

## Deferred

- D-14 metadata (group, label, type, options) for the ten entries: plan 07-18.
- Generated Config UI section replacing the hand-written card, and zh/it copy for it: plan 07-20.
- `retrievalConfigHash` including the backend: later backend plans (D-24).

## Self-Check: PASSED
