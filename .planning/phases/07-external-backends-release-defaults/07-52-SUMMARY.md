---
phase: 07-external-backends-release-defaults
plan: 52
subsystem: language-change-rules
tags: [lang-11, languages, fingerprint, rebuild, config-ui]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-47 (last package.json editor; rebuild_run rollouts), 07-48 (last config-server.js editor), 07-45 (config)"
  - phase: 03.2-language-support-ingestion-hardening
    provides: "03.2-68 (validator, settings.ts, fingerprint impact, rebuild plan and run, /api/config/languages, languages.js, ingest-impact.js)"
  - phase: 03.2.1-bge-m3-open-source-fallback-embedding
    provides: "03.2.1-05 (per-model language declarations behind embedding_profile_unsupported)"
  - phase: 05-verified-citations-groundedness
    provides: "05-25"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-22"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-45"
provides:
  - "config/rag/language-change-plan.cjs (+ .d.cts): planLanguageChange, the one planner for the CLI and the config server"
  - "src/lib/rag/lang/change-plan.ts: planLanguageChange, LanguageChangePlan, baselineChecker, appLanguageChangeContext"
  - "src/lib/rag/lang/cli.ts: npm run rag:languages (baseline, plan, add, remove, rebuild, selection)"
  - "supabase/migrations/0745_language_add_candidates.sql: rag_language_add_candidates (service_role, 0808 tenant rule)"
  - "selectLanguageAdd and LANGUAGE_ADD_GROUPS (rebuild/plan.ts); startRebuild({ selection: 'language_add' }) and loadLanguageAddCandidates (rebuild/run.ts)"
  - "POST /api/config/languages: planner on every save, preview: true, added/removed/notes/rebuild/selection on a change to a saved set; GET marks baselineMissing"
affects: [07-31, 07-32, 07-33, 07-50, 07-51]

actuals:
  tasks: 3
  commits: 8  # migration reservation, Task 2 RED + GREEN, Task 1, Task 3 RED + GREEN, SUMMARY (plus the authorized dependency merge)

tech-stack:
  added: []
  patterns:
    - "A dependency-free CommonJS rule module under config/rag/ shared by a TypeScript CLI and the config server (same pattern as validate-language-settings.cjs)"
    - "Config server reaches app logic that needs TypeScript and the database through the CLI (execFile, fixed argument array, codes only after the planner accepted them)"

key-files:
  created:
    - config/rag/language-change-plan.cjs
    - config/rag/language-change-plan.d.cts
    - src/lib/rag/lang/change-plan.ts
    - src/lib/rag/lang/cli.ts
    - supabase/migrations/0745_language_add_candidates.sql
    - tests/rag/lang/change-plan.test.ts
    - tests/rag-db/language-add-selection.test.mts
    - scripts/tests/config-server-languages-change.node-test.mjs
    - tests/ui/config-languages-baseline.test.ts
  modified:
    - src/lib/rag/ingest/fingerprint/impact.ts
    - src/lib/rag/ingest/rebuild/plan.ts
    - src/lib/rag/ingest/rebuild/run.ts
    - package.json
    - scripts/config-server.js
    - scripts/config-ui/rag-panels/languages.js
    - scripts/config-ui/rag-panels/quarantine.js
    - tests/rag-db/fingerprint-impact.test.mts
    - scripts/tests/config-server-languages.node-test.mjs
    - scripts/tests/config-server-rag-gate-save.node-test.mjs
    - tests/ui/config-languages-panel.test.ts

requirements-completed: [LANG-11]
---

# Phase 7 Plan 52: Language addition and removal rules (LANG-11) Summary

**Adding a language now needs its complete pack and golden slice, an embedding profile that declares it, and a baseline recorded first. It then reprocesses only the documents stored as `und`, scanned documents, and documents whose fingerprint is out of date. Removing a language changes only the query side and deletes nothing. The `rag:languages` CLI and the Config UI use the same planner.**

## Branch setup

- `exec/07-52` was created from `origin/exec/07-47` at `f30cafe0`, then `origin/exec/07-48` (`0f0450b1`) was merged with `--no-ff`. The orchestrator authorized this dependency merge. It had **no conflicts**.
- Preconditions checked before any edit: the SUMMARY of every one of the 470 transitive dependencies exists on the branch. 05, 05.1 and 06 VERIFICATION are all `status: human_needed`.

## Commits per task

| Task | Commits |
| --- | --- |
| Migration number | `e0884ac50` reserves 0745 (pushed at once) |
| Task 2 (removal query-side, language_add selection) | `fb7f2dce8` RED, `bc4c3550e` GREEN |
| Task 1 (tracer: planner + CLI) | `edcf62795` |
| Task 3 (Config UI) | `ea773231f` RED, `8669ae940` GREEN (includes the quarantine guard fix) |

Task 2 was done before Task 1 because the CLI's rebuild step calls the selection that Task 2 builds.

## Behaviour changes

- **Planner** (`config/rag/language-change-plan.cjs`): runs the validator unchanged, then adds `language_baseline_missing` (with the `npm run rag:languages -- baseline <code>` command) for each added registry code that has no baseline. On any refusal there are no steps and nothing is normalized. An accepted addition gives the steps `baseline`, `save`, `rebuild(language_add)`. A removal gives `save` only, plus the note `removed_documents_stay_searchable`. A change that both adds and removes applies the addition rules to the added codes and the note to the removed ones.
- **First choice (decision, recommended option):** when no set is saved yet, `current` is empty. The planner treats this as the Phase 3.2 setup: no baseline is needed, nothing is rebuilt, and the config server's answer is byte-identical to Phase 3.2. Otherwise first-run setup would be blocked.
- **Baseline record:** `rag:languages baseline <code>` runs `rag_eval.baseline record --runs 3` and stores the `language:<code>` slice with `run_config_hash`, `golden_sha256`, the manifest hash and set version in `eval/baselines/languages/<code>.json`. A live run (`--base-url`) writes to `eval/golden/private/baselines/languages/` instead, because rag_eval keeps live baselines untracked. The check reads both locations and requires `language` to match. A run with no golden slice for the language is refused (`golden_slice_missing`, exit 2) and writes nothing.
- **Removal is query-side** (`computeFingerprintImpact` / `countImpact` in `impact.ts`): a proposed language set is compared with the document's own stored languages added back in (the keys of `language_pack_versions`). A removed language therefore never makes a stored document look out of date, for LlamaParse documents too. An added language still does. The same rule applies to the coverage view, so nothing shows as pending after a removal is saved.
- **language_add selection:** 0745 `rag_language_add_candidates(p_tenant_key, p_after, p_limit)` lists current, ready documents with `has_und` (`'und' = ANY(languages)`) and `scanned` (doc type `scanned_image`, or a stored processing profile `scanned_image@*`) computed in SQL. NULL lists every tenant, and any other key goes through `rag_assert_tenant_key`, which is the 0808 rule. `selectLanguageAdd` adds the `stale` group with the coverage comparison over every mechanism. Each document counts once, under the first of und, scanned, stale. Documents in no group are never selected. `startRebuild({ mechanism: 'reparse', selection: 'language_add' })` runs it as an ordinary held reparse run. The settings hash includes the selection, and the run plan records the groups, so the run can be rolled out per tenant with a 07-47 `rebuild_run` rollout. Any other mechanism with a selection is refused with `invalid_selection`.
- **Config server:** POST `/api/config/languages` plans every save. A refusal answers 400 with the refusals, the validator codes first and `language_baseline_missing` last, and writes nothing. `preview: true` plans and counts without writing. On a change to a saved set the answer adds `added`, `removed`, `notes` and `rebuild`, and an addition also adds `selection: { groups, total }`. The counts come from `npm run rag:languages -- selection` (a dry run, through execFile with a fixed argument list; null when the database is not configured). GET marks `baselineMissing: true` on a language that is not enabled and has no baseline, only when a set is saved.
- **Languages panel:** a `baselineMissing` row gets a disabled checkbox and the `blocked.baseline` line, with the command on its own line in font-mono. An addition first sends a preview POST. If it is refused, one sentence per code shows in the error alert and the status region repeats the first one. If it is accepted, the impact guard gets `{ title: add.title, groups, rowLabels, columns, totalLabel: add.total, total, note: add.note }`. With a total of 0 no dialog opens. A removal only opens no dialog and no rebuild offer. After the save, the status region and an `alert-info` show `save.added` / `save.addedNone` per added language and `save.removed` per removed language. All new copy is in en, zh and it (07-UI-SPEC 12.5).

## Tests that failed before the fix

- `tests/rag-db/language-add-selection.test.mts` "removal deletes nothing": on the old code a removal counted LlamaParse documents as affected. This is the plan's guard mutation.
- The same file's addition, tenant and dry-run tests failed on assertions against the RED stubs.
- `tests/ui/config-languages-baseline.test.ts` "forwards the dialog options to the inner impact guard": `quarantineCreateGuard` in `quarantine.js` dropped the third argument, so no caller's dialog labels ever reached `ingest-impact.js`. This is a pre-existing bug from Phase 3.2, found by rendering the panel. Fixed in one line.
- `scripts/tests/config-server-languages-change.node-test.mjs`: on the old code an addition without a baseline saved with 200.

## Existing tests changed (they encoded the old behaviour)

- `tests/rag-db/fingerprint-impact.test.mts`: "a language-set change counts LlamaParse documents" and "exactly one affected document answers 1" both used a removal (zh,en,it to zh,en). They now assert that a removal counts 0, at deployment and tenant scope.
- `scripts/tests/config-server-languages.node-test.mjs` (concurrent saves): whichever save lands second now adds languages to a saved set, so the test records baselines for all three languages.
- `scripts/tests/config-server-rag-gate-save.node-test.mjs`: the enforce-mode 409 test uses a removal, because an addition without a baseline is now refused with 400 before the gate.
- `tests/ui/config-languages-panel.test.ts`: two guard tests ignore the new preview POST, which writes nothing.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- vitest on the changed and importing test files (28 files: change-plan, config-languages-baseline, config-languages-panel, config-ingest-impact-panel, quarantine panels, lang-validate-entrypoints, ingest-fingerprint(-routes), rebuild-routes, rebuild-lookup-mechanisms, attribute-header, config-gate writers and the other config-server importers): 787 passed
- `node --test scripts/tests/config-server-*.node-test.mjs scripts/tests/init-env-languages.node-test.mjs`: 110 passed
- `node --import tsx --test` tests/rag-db/language-add-selection (both modes), fingerprint-impact, fingerprint-backfill, attribute-header-sites, tests/rag-e2e/rebuild-hold: 53 passed
- tests/rag-db grants, search-path and schema-equality files (definer-search-path-pglite, hybrid-grants, lexical-stats-grants, purge-grants, schema-equality, search-path-empty, search-rpc-grants-pglite): 129 passed
- `node scripts/ci/check-rag-boundary.mjs`, `check-config.mjs`, `check-language-literals.mjs`, `check-settings-classification.mjs`, `check-zod-isolation.mjs`: ok
- `node scripts/ci/check-frontend-design-summary.mjs .planning/phases/07-external-backends-release-defaults`: PASS
- Not run: `npm run test-rag` (both modes). Retrieval, ingest, generation and golden sets are untouched: the change is in the admin impact count, the rebuild selection and the settings save. No workflow, Python or contract change, so check-workflows, pytest and gen:schemas do not apply.

## Design skills

| Skill | Outcome |
| --- | --- |
| frontend-design | n/a: no new interface. The states and copy follow 07-UI-SPEC 6.5, 7.5 and 12.5 inside the 03.2 Languages panel and impact dialog |
| Impeccable | pass: critique on the rendered panel (real config server, Chromium, 1280px and 390px, no horizontal page scroll). Finding fixed: at 390px the baseline command in the blocked row broke mid-token; it now sits on its own line and breaks between words only. A second finding came from rendering the dialog: the title and note were missing because the quarantine wrapper dropped the options. Fixed |
| web-design-guidelines | pass: all findings resolved. The blocked reason is linked to the disabled checkbox through aria-describedby; decorative icons are aria-hidden; the refusal alert has role alert and takes focus, and the polite status region repeats its first sentence; info alerts have no role; the count is formatted with Intl; there is one sentence per language and no plural forms; code is rendered with translate="no" |

/gsd-ui-review was not run separately; the phase-level UI audit (07-31 or later) covers it.

## Deviations

1. **The planner core lives in CommonJS** (`config/rag/language-change-plan.cjs`), and `src/lib/rag/lang/change-plan.ts` wraps it. The config server cannot load TypeScript, and the plan allows "the CommonJS build used for the validator". One planner, two entry points.
2. **The removal rule is per document**, not "old set vs new set". The plan resolution says to compare the old and new sets. Comparing each document against its own stored languages also keeps the coverage view (after the save) from offering a rebuild, and it handles add-and-remove in one rule.
3. **Migration 0745** was not in the plan's file list. The `und` group needs `documents.languages`, which no existing listing returns. The number was taken after fetching every origin branch (0744 was the last one used) and was pushed at once.
4. **rebuild/run.ts and quarantine.js** were edited outside the plan's file list. run.ts hosts the language_add start; quarantine.js got the one-line forwarding fix with its test.
5. **Groups are counted once per document** (first of und, scanned, stale), so the dialog rows add up to the total.
6. **CLI extras:** `rebuild` (continue the language_add reprocessing for the saved set, for example after setting the service-role key) and `selection` (JSON counts, used by the config server).
7. **The first choice is exempt** from the baseline rule (see Behaviour changes).

## Follow-ups and deferred

- **ingest-impact.js (Phase 3.2 follow-up, per the plan):** the dialog already renders the caller's `title`, `totalLabel` and `note`, and the `rowLabels` keyed by mechanism. It does not render a `groups` list of `{ group, label, count }`, and it shows the impact count from the app route (the reparse mechanism rows) instead of the three groups. `add.note` is added after `impact.warning` instead of replacing it. languages.js already passes everything in the documented options, so the follow-up is limited to ingest-impact.js. This plan does not edit that file.
- No fixture baselines are committed for zh, en and it. Recording them is an operator or eval action (`npm run rag:languages -- baseline <code>`). Until then, adding any of them to a saved set is refused with the exact command.
- The CLI's `add` for a language-aware deployment (`RAG_LANGUAGE_AWARE_INGEST=on`) selects every document as stale, because detection reads all the configured languages. This is correct under the fingerprint rule, and the counts are shown before anything starts.
- Medium: when the preview's count fails (no database), the dialog opens with the guard's own count, or its "could not be counted" state, instead of the three groups.

## Decisions for STATE

- LANG-11: language removal is query-side by comparing each document with its own stored languages; the first choice of languages is exempt from the baseline rule; language_add counts each document once (und, then scanned, then stale).
- Migration 0745 (`rag_language_add_candidates`) is taken by Phase 7.

## Operator actions

- Apply migration 0745 after 0744 (it is not folded into the setup files and is idempotent).
- Record a baseline before adding a language: `npm run rag:languages -- baseline <code>` (fixture), or with `--base-url` for the private slice.
- Live check (not run here): `npm run rag:languages -- add <code>` against a staging project, then confirm the per-group counts and the held reparse run.
