---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 02
subsystem: rag
tags: [env-sync, v2-config, rerank, cohere, timeouts]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: VOYAGE_* sync, RAG_EXACT_ID_LOOKUP, check-config patterns
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: loadRagConfig baseline and stage tables

provides:
  - Sixteen Phase 4 env switches in seven sync sites plus eval pin
  - loadRagConfig pipeline legacy|v2 with V2Config and disabled stage mapping
  - Profile-prefixed RAG_STAGE_TIMEOUTS and extended PROFILE_STAGE_DEFAULTS

affects:
  - 04-03 through 04-45 (read config.v2 only; no further env plumbing)

actuals:
  tokens: 95000
  tasks: 3
  commits: 3
  plan_head_before: faa521267114a0b8b518198833f58caf223797ab
  plan_head_after: 54948910f36a2f79fa08a34a3f847c93fa125833

tech-stack:
  added: []
  patterns:
    - "V2 switch-off positions folded into disabledStages (rerank, compress, expand_parents, translate)"
    - "Secrets in memo key as presence booleans only"

key-files:
  created: []
  modified:
    - src/lib/rag/config.ts
    - src/lib/rag/deps.ts
    - scripts/check-config.mjs
    - scripts/check-config.test.mjs
    - scripts/rag/env-manifest.json
    - scripts/init-env.js
    - src/lib/env.ts
    - scripts/config-server.js
    - scripts/config-ui/index.html
    - eval/config/rag-eval-env.json
    - tests/rag/config.test.ts

key-decisions:
  - "RAG_PIPELINE=v2 accepted; unknown values still run legacy with warn-once"
  - "eval profile rerank default 60000 ms for D-10 none semantics"

requirements-completed: [LAT-02, RNK-06, RET-10, DATA-08]

duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 04 Plan 02: Phase 4 Env Switches and v2 Config Summary

**Sixteen D-23 retrieval switches sync across all operator surfaces; `loadRagConfig` exposes `config.v2`, v2 stage names, and profile-prefixed timeouts while legacy behaviour stays the default.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 3
- **Tests:** `scripts/check-config.test.mjs` 23/23; `tests/rag/config.test.ts` 30 passed (was 12 @525dae5, +18); legacy differential 5/5

## Accomplishments

1. **check-config and manifest** — `COHERE_*` in NAME_PATTERN; managed manifest rows for all Phase 4 names; `COHERE_API_KEY` short-secret warning alongside Voyage/DeepInfra.
2. **Five-location env sync** — Defaults in `env.ts`, `init-env.js`, `config-server.js` (three templates), Config UI (selects/checkboxes/password), and eval pin regeneration.
3. **`loadRagConfig` v2** — `fuse` core stage; six v2 optional stages; `V2Config`; switch-off → `disabledStages`; `voice.rerank=200` style timeouts; `RAG_RETRIEVAL_PARAMS_OVERRIDE` parsing; memo on full `RagEnvInput` with secret booleans; `deps.fetch` seam.

## Design skills

Recorded retroactively by plan 04-47 (verification gap 1). The UI change of this plan is commit 3236cc7e in `scripts/config-ui/index.html`: the RAG_PIPELINE select, the Phase 4 retrieval switch group inside the existing Retrieval pipeline card, and the legacy notes on four older toggles.

| Skill | Outcome | What it found and changed |
|-------|---------|---------------------------|
| frontend-design | n/a: controls inside existing panels, no new interface | The controls sit in the existing Retrieval pipeline card and reuse its DaisyUI form-control, select, input and checkbox patterns. No page, layout or visual direction was added. |
| Impeccable | n/a: controls inside existing panels, no new interface | Same scope: standard form controls in an existing card, no new interface to critique or polish. |
| web-design-guidelines (pinned `references/command.md`, the 3236cc7e hunks as they stand at 04-47) | all findings resolved | Found and fixed in 04-47 commit 1c5832b6, covered by `tests/ui/config-phase4-switches.test.ts`: labels of 11 selects and inputs not tied to their control (`for` added); no `name` on any of the 17 controls (added); text, secret, URL and number fields without `autocomplete="off"` (added) and code-like fields without `spellcheck="false"` (added); Cohere base URL as `type="text"` (now `url`); number fields without `inputmode="numeric"` (added); example placeholders without an ellipsis (`zh=rerank-2.5…`, `pool=50,cap=60,topk=10…`, and the Cohere key placeholder is now "Paste your Cohere API key…"); the Cohere key reveal button had no accessible name and no `type` (now `type="button"` with `aria-label` "Show or hide the Cohere API key"; the shared handler swaps only the emoji); help text not tied to its control (`aria-describedby` on RAG_PIPELINE and the Voyage model field); env names and option values without `translate="no"` (added on the five selects, RAG_LEXICAL_SEARCH and the four `RAG_PIPELINE=v2` notes); group heading without balanced wrapping (`text-balance`); key input in a flex row without `min-w-0` (added). Kept by decision, not defects: sentence-case labels (04-UI-SPEC copy contract, section 12); placeholders that show the value used when the field is empty (`6000`, `0`, `https://api.cohere.com`) keep no ellipsis; native selects take background and text colour from the DaisyUI theme. |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] config-server template corruption**
- **Found during:** Task 2 sync script
- **Issue:** Erroneous `split().join()` callback text landed in getEnvValue templates
- **Fix:** Restored from git and applied StrReplace patches for the two template blocks
- **Files modified:** `scripts/config-server.js`
- **Commit:** 3236cc7 (included in task 2 commit)

None otherwise — plan executed as written.

## Self-Check

- [ ] SUMMARY head_after placeholder — updated below after final commit

## Verification

- `node scripts/check-config.mjs` — ok 122 variables
- `node --test scripts/check-config.test.mjs` — pass 23
- `npx vitest run tests/rag/config.test.ts tests/eval-env-pin.test.ts` — pass
- `npx vitest run tests/rag/stage-runner.test.ts tests/rag/status.test.ts` — pass
- `npm run typecheck:new` — exit 0 (41 pre-existing phase-1 lines)
- `node --import tsx --test tests/rag-legacy-differential.test.mts` — pass 5