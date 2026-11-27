---
phase: 07-external-backends-release-defaults
plan: 20
subsystem: config-ui
tags: [config-ui, env-manifest, secrets, test-connection, index-compat, vector-sync, generated-settings]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "manifest metadata and the check-config generated-section rule (07-18), POST /api/rag/admin/providers/test and PROVIDER_IDS (07-19), GET /api/rag/admin/index-compat and GET/PUT /api/rag/admin/vector-sync/targets (07-15)"
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "rag-fetch.js and the /api/rag proxy (03-43)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "panel pattern (04-36)"
provides:
  - "scripts/config-server-security.js: maskConfig returns secretHints { state, last4? } (last4 only for values of 20+ characters); mergeSecretUpdate and SECRET_MASK_PLACEHOLDER"
  - "GET /api/rag-pipeline/manifest (config server): managed entries' metadata, saved non-secret values, secret hints, envModifiedAt"
  - "scripts/config-ui/rag-panels/rag-pipeline.js: the generated RAG pipeline settings section (rows, hosted rows, provider blocks with Test connection, index-compat warnings, sync switches and state, loaded-configuration note)"
  - "index.html: #rag-pipeline-settings skeleton in RAG Modes, saveConfig dispatches rag-config-saved, populateFields skips the section"
affects: [07-45, 07-48, 07-49, 07-52]

actuals:
  tasks: 4
  commits: 7

tech-stack:
  added: []
  patterns:
    - "A managed variable whose control already exists elsewhere on the page gets a hosted row (saved value, Show setting) instead of a second control"
    - "Secrets cross the config-server boundary only as { state, last4? }; an empty or masked field never replaces a stored value"

key-files:
  created:
    - scripts/config-ui/rag-panels/rag-pipeline.js
    - tests/ui/config-rag-pipeline-panel.test.ts
    - tests/ui/helpers/rag-pipeline-harness.ts
  modified:
    - scripts/config-server-security.js
    - scripts/config-server.js
    - scripts/config-ui/index.html
    - scripts/check-config.test.mjs
    - tests/scripts/config-server-security.test.ts
    - tests/ui/config-phase4-switches.test.ts
    - tests/ui/config-query-layer-card.test.ts
    - tests/ui/config-injection-panel.test.ts
    - tests/ui/config-chunking-panel.test.ts
    - tests/ui/config-feedback-loop-switches.test.ts
    - tests/ui/config-phase42-switches.test.ts
    - tests/ui/config-phase33-switches.test.ts
    - tests/ui/config-query-layer-panel.test.ts

key-decisions:
  - "Precondition: 05-, 05.1- and 06-VERIFICATION.md all read status: human_needed; every plan in the transitive depends_on has a SUMMARY on this branch."
  - "Removal scope at HEAD (not the 7 cards / 88 inputs the plan counted at 9da3865c): the RAG Modes tab had ten cards and 149 managed inputs, and several cards now host hand-built widgets. Removed whole: Evaluation & Sidecar, Langfuse tracing, Citations and groundedness, Vector backends (07-04, plain settings; its fields now sit with the generated warnings and sync block). Kept with only their hand-built blocks: Retrieval pipeline (Phase 4 box with localized labels and the lexical-scoring dependency note, and #rag-tuning-switches), Query layer (framework warning block and cache tools block that query-layer.js binds at DOMContentLoaded), Ingestion and embedding profiles (#rag-finetune-slots). Prompt-injection defense keeps only #injection-defense-summary and the events pointer, retitled Prompt-injection detectors and moved directly after #rag-pipeline-settings. Not touched: Retrieval log and feedback, Answer rules and output safety (hand-built panels of later phases), the two inputs beside the mode selector, and every RAG administration block. Static managed controls: 196 before, 120 after; the 76 removed are generated; the 120 kept show as hosted rows."
  - "Hosted rows: every managed variable has exactly one row; a variable with a hand-written control anywhere on the page gets a read-only hosted row, so no id ever occurs twice (verified over the real page: 196 rows, 0 duplicate ids in Chromium). The related-panel button (RAG_REFUSAL_THRESHOLD, RAG_EMBEDDING_PROFILES, RAG_ROLLOUTS) also renders on hosted rows, which replaces the static refusal pointer."
  - "Script order: rag-pipeline.js loads once, directly after rag-ui.js (whose builders it uses) and after rag-fetch.js. 'Directly after rag-fetch.js' would break two pinned adjacencies of earlier plans (rag-fetch.js -> gates-ui.js -> judge-calibration.js)."
  - "Masked save: SECRET_MASK_PLACEHOLDER is '********'. The POST /api/config handler now runs mergeSecretUpdate against the saved .env.local; empty, null and placeholder secret fields keep the stored value, a typed value replaces it."
  - "Provider ids without a brand name (app, webhook, ft_endpoint) render their id in font-mono with no probe, as 6.2.4 specifies for unknown ids."

requirements-completed: [ADM-01]

coverage:
  - id: D1
    description: "Secrets leave the config server only as set/unset and, for 20+ characters, the last four; an untouched or masked secret field never overwrites the stored value"
    requirement: ADM-01
    verification:
      - kind: unit
        ref: "tests/scripts/config-server-security.test.ts (secret hints and the masked-save rule; GET /api/rag-pipeline/manifest)"
        status: pass
  - id: D2
    description: "Every managed variable has one row in the generated section with a type-specific control or a hosted row; requirements disable bool/enum/number/string only; Test connection, index-compat warnings, sync switches and the restart note"
    requirement: ADM-01
    verification:
      - kind: unit
        ref: "tests/ui/config-rag-pipeline-panel.test.ts (31 cases, including 'every managed', 'requires', 'probe map', 'exactly once')"
        status: pass
---

# Phase 7 Plan 20: Generated RAG pipeline settings in the Config UI

**Every managed switch and provider now appears in one generated "RAG pipeline settings" section of the RAG Modes tab, rendered from the env manifest, with masked secrets (stored state and last four characters only), one Test connection button per provider, the index-compatibility warnings, the Weaviate and Qdrant sync switches with their index state, and a note when .env.local changed after the app started.**

## Task commits

| Task | RED | GREEN |
| --- | --- | --- |
| 1 Last-4 masking and masked save | dbcf403a | b50bf903 |
| 2 Manifest endpoint and generated section | 304ca0f7 (with Task 3; stub script renders nothing: 22 of 24 failed on assertions or null controls; the manifest endpoint test failed with the route absent) | b72a7067 |
| 3 Test connection, warnings, sync, mount | 304ca0f7 | b72a7067 |
| 4 Remove the hand-written inputs, move their tests | Task 4 tests run against the pre-removal index.html: 3 of 7 failed ("cards lost their inputs", "security help lines", "null-safety"); the other four are guards that also hold with hosted rows | 564acc9e, 16f16080 |

## Behaviour changes

- `GET /api/config` and the new `GET /api/rag-pipeline/manifest` send no secret value: a secret is `{ state: 'set' | 'unset', last4? }`. `POST /api/config` keeps a stored secret when the field is empty, null or the masked placeholder.
- RAG Modes: the generated section replaces 76 hand-written managed inputs (see key-decisions for which cards went and which hand-built blocks stay). Values still save through the page's change listener, because each generated control's id and name are the env name. A typed secret is emptied and dropped from `configManager.config` after the save.
- No runtime app code, no switch default, no env variable, no migration. Chat, embed, voice, strict refusal, webSearch with Exa, `source_images` and `{{context}}` are untouched.

## Tests that failed before the change

- Task 1: 5 of the 6 new masking tests on the stub (the substring-leak guard passes on a stub that returns no hints).
- Tasks 2-3: 22 of 24 section tests on the stub script; the manifest endpoint test without the route.
- Task 4: 3 tests on the old index.html (listed above).

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run tests/ui tests/scripts`: 82 files, 1669 passed. Plus the files that import config-server or the UI: `tests/api/config-reload-auth.test.ts tests/lib/rag-settings-hash.test.ts tests/rag/lang-validate-entrypoints.test.ts`: 130 passed.
- `node --test scripts/check-config.test.mjs scripts/tests/check-frontend-design-summary.node-test.mjs scripts/tests/config-server-*.node-test.mjs scripts/tests/rag-settings-hash.node-test.mjs`: all pass (the rag-gate e2e needed `uv sync` in eval first; it failed with `error_reason crashed` before the sync and passes after).
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: ok.
- `node scripts/ci/check-frontend-design-summary.mjs .planning/phases/07-external-backends-release-defaults`: pass.
- Browser check (Chromium, config server on a temp root, main app not running): 196 rows, no duplicate env-name ids, no page errors at 1280px and 390px; the admin-backed parts show the unavailable sentence and the rows stay usable. The 27px horizontal overflow at 390px on the RAG Modes tab comes from a pre-existing label outside the section.
- Not run (area untouched): rag-db (no SQL), test-rag fixture runs (no retrieval, ingest or generation change), gen:schemas, workflow check, Python suites.

## Deviations

1. **Removal scope** (key-decisions 2): the plan's "seven cards, 88 inputs" was written at 9da3865c; at HEAD the cards hold hand-built widgets that D-14 keeps, so those blocks stay and their inputs are hosted rows. Vector backends (a plain settings card of this phase) was removed as well.
2. **Files outside files_modified:** five more test files pinned removed inputs or used removed elements as position anchors and were updated (`config-feedback-loop-switches`, `config-phase42-switches`, `config-phase33-switches`, `config-query-layer-panel`, and `scripts/check-config.test.mjs`, whose "removed from the config UI" cases now also drop the generated-section loader, since 07-18's rule counts the generated section as present). `tests/ui/helpers/rag-pipeline-harness.ts` is new.
3. **Script position** (key-decisions 4).
4. **ingestion.js and refusal-calibration.js were not edited**: the null-safety test passes at HEAD.

## Design skills

| Skill | Outcome |
| --- | --- |
| frontend-design | pass: follows the approved 07-UI-SPEC direction (setting row with default line and Changed badge as the signature element, DaisyUI tokens only, no brand colour) |
| Impeccable | pass: critique pass on the rendered page (Chromium screenshots at 1280px and 390px); hosted rows read "Current value: not set" consistently, no layout jump, rows stack below 768px |
| web-design-guidelines | pass: all findings resolved (visible label per control, aria-describedby on help, hint and meta lines, type="button" on every button, reveal button with aria-pressed and a named label, decorative icons aria-hidden, autocomplete and spellcheck off on text, URL and secret fields, ellipsis characters in placeholders, polite status region, no outline removal). Sentence case is intentional per the UI-SPEC |

## Purge hooks (Phase 6.3 note)

None needed: no new store.

## Requirement IDs and decisions for STATE

- ADM-01 (Config UI half; 07-15, 07-18 and 07-19 delivered the server halves).
- Decision: a managed variable with a hand-written control anywhere on the page is shown as a hosted row; later plans should add manifest metadata and no input (07-UI-SPEC 15 item 12).
- Decision: the generated section loads after rag-ui.js; the rag-fetch.js -> gates-ui.js -> judge-calibration.js adjacency stays.

## Operator actions

- Open the Config UI with the main app running and signed in as admin: press Test connection for each configured provider, check the index-compat warnings and the sync switches against a real Weaviate or Qdrant. Only fakes were used here.

## Deferred

- Migrating the remaining hand-built settings blocks (Phase 4 box, tuning switches, query-layer cache block, fine-tune slots, Retrieval log and feedback, Answer rules) into the generated section needs their localized help in the manifest and edits to the tests of Phases 4, 4.2, 4.4, 5.1.1, 5.3 and 6.1; they show as hosted rows meanwhile.
- The known test-rag failure (`false_refusal_rate` en 0.3143 > 0.25) also fails on main; not run here because this plan changes no retrieval path.
