---
quick_id: 261127-rbm-rebuild-mechanisms-42
slug: rebuild-mechanisms-42
status: complete
date: 2026-11-28
branch: exec/quick-rbm-rebuild-mechanisms
base: origin/exec/quick-42-fixes (c50e5550)
key-files:
  created:
    - tests/rag/ingest/rebuild-lookup-mechanisms.test.ts
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/ingest_settings.py
    - rag-sidecar/schemas/FingerprintImpact.schema.json
    - rag-sidecar/schemas/SettingsClassification.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - config/rag/settings-classification.json
    - scripts/ci/check-settings-classification.mjs
    - src/lib/rag/ingest/fingerprint/impact.ts
    - src/lib/rag/ingest/rebuild/plan.ts
    - src/lib/rag/ingest/rebuild/cli.ts
    - src/app/api/rag/admin/ingest-fingerprint/rebuild/route.ts
    - scripts/config-ui/rag-panels/ingest-impact.js
    - tests/rag/ingest-fingerprint-routes.test.ts
    - tests/rag/rebuild-routes.test.ts
    - rag-sidecar/tests/test_settings_classification.py
    - scripts/tests/check-settings-classification.node-test.mjs
---

# Quick 261127-rbm: dedicated rebuild mechanisms for the Phase 4.2 lookup and cluster switches

Closes the W-5 gap in `261127-q42-SUMMARY.md` (hand-off `04.2-02-settings-classification.md`).

## What changed

`RebuildMechanism` has three new members, one for each existing backfill command:

| Switch | Before | Now | Plan (per tenant of the affected documents) |
| --- | --- | --- | --- |
| `RAG_TABLE_LOOKUP` (both) | `reparse` | `reindex_tables` | `npm run rag:table-rows -- --tenant <key>` |
| `RAG_IDENTIFIER_INDEX` | `reparse` | `reindex_identifiers` | `npm run rag:identifiers -- --tenant <key>` |
| `RAG_DUP_CLUSTERS` | `reparse` | `recluster` | `npm run rag:dup-clusters -- --tenant <key>` |

- Contract: Pydantic `RebuildMechanism` and `REBUILD_MECHANISMS` (the three are also in `AUTOMATIC_REBUILD_MECHANISMS`; only
  `rescan` stays out). `npm run gen:schemas` regenerated the two JSON schemas and the two Zod enums (`FingerprintImpactSchema`,
  `SettingsClassificationSchema`); nothing else in the generated output changed.
- Checker: `MECHANISMS` in `check-settings-classification.mjs`.
- Impact and coverage (`fingerprint/impact.ts`): `REBUILD_MECHANISMS` order is reparse, rechunk, relex, reembed, recaption,
  retranslate, reindex_tables, reindex_identifiers, recluster, rescan. `MECHANISM_COMMANDS` names the three backfills;
  `startOf` gives `cli`.
- Rebuild (`rebuild/plan.ts`, `cli.ts`, admin rebuild route): the three are rebuildable and plan as `kind: command`,
  `activation: none`, like relex. No rebuild run row is written for a command plan, so the 0809 `rag_rebuild_runs.mechanism`
  check needs no migration (no SQL change). `rag:rebuild start --mechanism <...>` usage lists them; the route answers the fixed
  command without tenant keys.
- Config UI ingest-impact panel: labels for the three mechanisms in en, zh and it, and their place in the row order.

## Behaviour changes

- Changing one of the three switches now proposes only its own backfill, never a re-parse. Mixed proposals keep each key's own
  mechanism (e.g. `RAG_SUPPORTED_LANGUAGES` + `RAG_TABLE_LOOKUP` gives `reparse` and `reindex_tables`).
- `GET /api/rag/admin/ingest-fingerprint` lists 10 pending rows instead of 7 (the new three always count 0, because these
  switches are not part of the ingest fingerprint; that was already the case under `reparse`).
- Every other classification entry is unchanged (asserted in the new vitest).

## TDD

RED commit `b0feedb7` failed on assertions only:
- vitest `rebuild-lookup-mechanisms.test.ts`: 5/5 failed (e.g. `expected [ 'reparse' ] to deeply equal [ 'reindex_tables' ]`).
- sidecar pytest: 4 failed (`test_lookup_switches_name_their_own_mechanism[...]`, `test_lookup_mechanisms_are_automatic_rebuilds`).
- checker node test: `the lookup index and duplicate cluster mechanisms are accepted` failed.
- The admin route test for the three mechanisms (in the GREEN commit) fails 3/3 with the route change stashed: tsc found the
  route's own per-mechanism command map, which was missing the new keys.

## Commits

- `b0feedb7` test(quick-rbm): RED tests and PLAN.
- `bd2e7226` feat(quick-rbm): contract, generated schemas, checker, impact, plan, CLI, route, Config UI, classification, test
  expectation updates (7 to 10 coverage rows; command regex allows hyphens).
- SUMMARY commit (this file).

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm run typecheck:new`: no Phase 1 type errors (1 legacy diagnostic ignored, as before).
- `npm run gen:schemas`: diff limited to the two mechanism enums (2 JSON schemas, 2 Zod lines); a second run leaves no new diff.
- `check-settings-classification`, `check-config`, `check-rag-boundary`, `check-language-literals`: exit 0.
- `node --test scripts/tests/check-settings-classification.node-test.mjs`: 8/8.
- sidecar pytest: `tests/test_settings_classification.py tests/test_phase32_ingest_contracts.py` 69 passed; `-k "contract or schema"`
  1499 passed, 1 skipped.
- vitest (every test file importing a changed module plus the new one): `ingest-fingerprint-routes`, `ingest-fingerprint`,
  `ingest/attribute-header`, `ingest/rebuild-lookup-mechanisms`, `rebuild-routes`, `ui/config-ingest-impact-panel`,
  `ui/config-ui-xss-scripts`: 7 files, 205 passed.
- `node --import tsx --test tests/rag-db/rebuild-runs.test.mts tests/rag-e2e/rebuild-hold.test.mts`: 15/15 (the rebuild DB
  harness is multi-tenant only). For single-tenant: `tests/rag-db/phase32-migrations-apply.test.mts` and
  `access-catalog-sentinel.test.mts` (both modes, cover the rebuild functions and grants): 24/24. No SQL changed.
- `node scripts/ci/check-frontend-design-summary.mjs .planning/quick/261127-rbm-rebuild-mechanisms-42`: see below.
- Not run: `test-rag` (no retrieval, ingest or generation path changed).

## Design skills

| Skill | Outcome |
| --- | --- |
| frontend-design | n/a: no new interface; three label strings per locale in an existing table. |
| Impeccable | n/a: copy-only change, layout untouched. |
| web-design-guidelines | pass: changed lines reviewed; labels go through the existing `ragUiLookup` text path, en/zh/it parity kept; none open. |

## Deviations and notes

- Three mechanisms instead of one `relookup`/`recluster` pair: `indexDocumentForLookup` already indexes tables and identifiers
  under separate switches, and each switch has its own backfill command, so one switch maps to one command and nothing more.
- AGENTS.md still lists `rag:rebuild -- start --mechanism <reparse|...|retranslate>` without the three; not edited (docs only on
  explicit request). Suggested follow-up for the coordinator.
- The hand-off `04.2-02-settings-classification.md` is left as written; this SUMMARY resolves its proposal.
- No new env variable, no migration, no operator action.
