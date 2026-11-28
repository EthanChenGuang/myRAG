---
phase: 07-external-backends-release-defaults
plan: 46
subsystem: rag-monitor-languages
tags: [lang-10, obs-03, monitor, retrieval-log, language-confidence]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-40 (LanguageQualityCell, LanguageDropAlert), 07-41 (confidence mapping and calibration, per-language judge summary), 07-45 (RAG_LANG_CONFIDENCE)"
  - phase: 05.3 (OBS-03 monitor, executed without a phase directory)
    provides: "daily job runDaily, RULE_KIND_REGISTRY with the reserved language_drop kind, eval/config/monitor-alerts.json and its MonitorAlertsConfig contract, delivery channels"
  - phase: 05.1.1-feedback-loop
    provides: "rag_retrieval_log with the frozen FBK-01 columns (0531, 0532) and the writer src/lib/rag/feedback-loop/retrieval-log.ts; closing plan 05.1.1-22"
  - phase: 05, 05.1, 06
    provides: "closing plans 05-25, 05.1-22, 06-45; VERIFICATION.md status human_needed"
provides:
  - "supabase/migrations/0743_language_quality_cells.sql: rag_language_quality_cells(p_since, p_until, p_tenant_keys, p_min_confidence), service_role only, SECURITY INVOKER, search_path ''"
  - "src/lib/rag/monitor/language-drop.ts: evaluateLanguageDrop, evaluateLanguageJudgeDrop, LANGUAGE_DROP_RULE_ID, languageDropRuleOf, readLanguageQualityCells, toLanguageQualityCells, readLanguageJudgeCells, languageQualityForAdmin, evaluateLanguageDropRule (the job's context entry)"
  - "RULE_KIND_REGISTRY.language_drop (context entry) in src/lib/rag/monitor/rule-registry.ts"
  - "language_drop rule in eval/config/monitor-alerts.json (from default_monitor_alerts, config_hash recomputed)"
  - "GET /api/rag/admin/language-quality"
  - "RAG_LANG_CONFIDENCE=calibrated read by the FBK-01 writer"
affects: [07-47]

actuals:
  tasks: 3
  commits: 8  # placeholder, RED+feat x3, SUMMARY

tech-stack:
  added: []
  patterns:
    - "A Phase 7 rule plugs into the Phase 5.3 job as a context registry entry; the job keeps its evidence, dedup and delivery"

key-files:
  created:
    - supabase/migrations/0743_language_quality_cells.sql
    - src/lib/rag/monitor/language-drop.ts
    - src/app/api/rag/admin/language-quality/route.ts
    - tests/rag-db/language-quality-cells.test.mts
    - tests/rag/monitor/language-drop.test.ts
    - tests/rag/feedback-loop/retrieval-log-confidence.test.ts
    - tests/api/language-quality-route.test.ts
  modified:
    - src/lib/rag/monitor/rule-registry.ts
    - src/lib/rag/index.ts
    - src/lib/rag/feedback-loop/retrieval-log.ts
    - eval/config/monitor-alerts.json
    - rag-sidecar/src/rag_sidecar/contracts/monitor.py
    - tests/fixtures/contracts/samples.json
    - rag-sidecar/tests/test_monitor_contracts.py
    - eval/tests/test_config_files.py
    - tests/rag/monitor-rules.test.ts

key-decisions:
  - "Migration number 0743 as planned (free on every origin branch; placeholder pushed first)."
  - "Dispatch site: src/lib/rag/monitor/rule-registry.ts (RULE_KIND_REGISTRY), the registry runDaily in src/lib/rag/monitor/daily.ts uses after loading eval/config/monitor-alerts.json through alerts-config.ts. The contract's rule-kind list already held language_drop, so no contract kind change."
  - "The rule entry is written by finalize_config(default_monitor_alerts()), so the language_drop rule was added to default_monitor_alerts in rag-sidecar monitor.py (the committed file must equal the default factory, test_phase53_config_files_are_targets_at_their_defaults). Two Phase 5.3 tests that pinned 'no language_drop rule' now pin the rule."
  - "Rule shape (MonitorRule params): metrics [refusal_rate, not_helpful_rate, judge_mean], window_days 1 against the job's 30-day baseline, min_sample 50, baseline_min_sample 200, language_band_<metric> and overall_band_<metric> (refusal 0.05 / 0.02, not-helpful 0.10 / 0.05, judge 0.10 / 0.05). Starting values, report-level until live data ratifies them."
  - "A language drops when its own rate worsens by more than the language band against its own baseline, with the minimum sample in both windows; the average holds when the overall rate (every language, und included) worsens by no more than the overall band. An improving average counts as holding. und is never alerted."
  - "Judge scores are a mean, not an event count, so they do not fit LanguageDropAlert (events/total, metric enum of four count measures). evaluateLanguageDrop returns LanguageDropAlert for the count metrics; evaluateLanguageJudgeDrop returns a typed judge drop from the job's daily cells (rag_monitor_daily judged and judge_score_sums per language). Both become ordinary MonitorAlert candidates of kind language_drop."
  - "One open alert per (tenant, language, metric): dedup key over `language_drop|<metric>`. The job attaches sample trace ids through its evidence path (matchForRule gives {} for language_drop, so samples are rows of that language in the window) and config changes, and delivers through its channels unchanged."
  - "rag_language_quality_cells: low_confidence counts confidence below p_min_confidence (0.75 when null: mapped 0.5 is low, 1 is not); with p_min_confidence set, a row below it or with a null confidence counts under und. Window non-empty and at most 400 days (the job reads 31 days), 22023 otherwise; every given tenant key goes through rag_assert_tenant_key."
  - "Route: checkAdmin + adminDenied (the body of requireAdminOrDeny) because the route needs the admin's user id to resolve administered tenants through rag_admin_tenant_keys; a tenant not administered answers 403. 404 while RAG_MONITOR is off, before the admin check, like the other monitor routes. Judge means come from rag_monitor_daily for the window (the online judge summary of 07-41 is printed, not stored; the daily cells hold the mirrored judge scores per language); null when nothing was judged."
  - "Calibrated confidence: the writer resolves RAG_LANG_CONFIDENCE through loadRagConfig(getRagDeps().ragEnv()).lang.confidence (overridable per call). The default calibration is the committed JSON imported statically (bundled, as alerts-config.ts does with monitor-alerts.json) rather than read from process.cwd(); a caller-supplied file goes through loadLanguageConfidenceCalibration. The trace languages block of 07-41 is unchanged (mapped)."

requirements-completed: [LANG-10]

duration: ~2h
completed: 2026-11-28
---

# Phase 7 Plan 46: Per-language quality, the language drop alert and calibrated confidence

**Refusal rate, votes and judge scores are reported per language. The daily monitor job now alerts when one language drops while the overall average holds. With `RAG_LANG_CONFIDENCE=calibrated`, the retrieval log stores the calibrated query-language confidence; the default `mapped` stores the same values as before.**

## Precondition
- 05, 05.1 and 06 VERIFICATION.md: `status: human_needed`.
- Phase 5.3 has no phase directory. The alternative holds at HEAD: package.json has `rag:monitor`, eval/config/monitor-alerts.json exists and src/lib/env.ts reads `RAG_MONITOR`.
- All 461 transitive depends_on plans have a SUMMARY on this branch (base `d2645421`).

## Task Commits
| Task | Commits |
| --- | --- |
| Migration number | `23285db6` chore: reserve 0743 |
| 1. Cells, rule, admin route (tracer) | `11e0e8dc` test (RED), `7d38564c` feat |
| 2. language_drop in the OBS-03 job | `0aa083d2` test (RED), `16aa7639` feat |
| 3. Calibrated confidence in the FBK-01 log | `1fbc03ab` test (RED), `23c77add` feat |

## Behaviour changes
- With `RAG_MONITOR=true` and the retrieval log on, the daily job also evaluates `language_drop` and can open alerts of kind `language_drop` (ids and counts only), delivered through the existing banner, webhook and Langfuse channels.
- New route `GET /api/rag/admin/language-quality` (404 while `RAG_MONITOR` is off).
- With `RAG_LANG_CONFIDENCE=calibrated`, stored `query_language_confidence` values become the calibrated bin values.
- Defaults: no change. `RAG_MONITOR=false` reads and writes nothing (tests). `RAG_LANG_CONFIDENCE=mapped` stores exactly 1, 0.5 or null as before (test on the 05.1.1-05 cases). No response, prompt or retrieval path changes. Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed chat are untouched; `test-rag` paired differences are zero.

## Tests that failed before the change
- `tests/rag-db/language-quality-cells.test.mts` (RED with a stub rule and a cells function returning no rows): the tracer "one language drops while the average holds", the pooled case, the daily-job case and the counts case failed on assertions, in both modes (9 failed, 6 passed).
- `tests/rag/monitor/language-drop.test.ts`: "is committed ... and registered" and "raises one language_drop alert through a fake channel" failed on assertions (rule absent from the committed config).
- `tests/rag/feedback-loop/retrieval-log-confidence.test.ts`: 3 of 4 failed on assertions (`expected 1 to be 0.9867`, warning not logged); the mapped case passed, as it should.
- Updated: `tests/rag/monitor-rules.test.ts` ("has no language_drop entry" now pins the context entry; the unregistered-kind test uses a registry without it), `rag-sidecar/tests/test_monitor_contracts.py` and `eval/tests/test_config_files.py` (14 rules, language_drop pinned).

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run` (full; src/lib/rag/index.ts and the monitor registry changed): 874 files passed, 3 skipped, 1 failed; 16689 tests passed, 143 skipped, 1 failed. The one failure is `tests/rag/characterize-chat.test.ts` ("builds the same system prompt or refusal for every fixture question and model kind", explicit legacy): the known zh refusal snapshot drift on this line, which also fails on the 07-45 base and is fixed on main. This plan touches neither the chat route nor the refusal texts.
- Targeted vitest: tests/rag/monitor, tests/rag/monitor-rules, monitor-sample, monitor-stats, tests/api/monitor-run-route, tests/api/language-quality-route, tests/rag/feedback-loop (19 files), tests/rag/lang-confidence, tests/rag/trace: all passed
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: exit 0
- rag-db, both modes: `tests/rag-db/language-quality-cells.test.mts` 15 passed; `monitor-daily`, `monitor-clusters`, `tests/rag-e2e/defaults-equal-phase53.test.mts` 39 passed; `definer-search-path-pglite`, `hybrid-grants`, `lexical-stats-grants`, `purge-grants`, `schema-equality`, `search-path-empty`, `search-rpc-grants-pglite` 129 passed
- `uv run --directory eval python -m pytest -q tests/test_config_files.py`: 23 passed; rag-sidecar `pytest -q` on the monitor and contract test files: passed (1490)
- `npm run gen:schemas`: regenerated tests/fixtures/contracts/samples.json once (the new default rule), then no diff
- `npm run test-rag -- --out eval/out/07-46`: gate PASS, `passed == true`, `paired.all_zero == true`. The report-only absolute gate shows `false_refusal_rate language:en 0.3133 vs 0.25`, the known pre-existing item.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/07-46-ingest`: PASS (8 skipped)
- Not run (not touched): workflow check, frontend design summary (no UI), sidecar full suite

## Deviations from Plan
- **Judge scores (Rule 2).** LanguageDropAlert carries event counts, so a judge mean cannot be one. Added `evaluateLanguageJudgeDrop` next to `evaluateLanguageDrop`; both feed the same `language_drop` alerts. Contract unchanged.
- **Phase 5.3 files beyond the dispatch line (Rule 3).** The committed config must equal `default_monitor_alerts()`, so the rule went into rag-sidecar `monitor.py` and samples.json was regenerated. Three Phase 5.3 tests that asserted the rule's absence were updated.
- **Route guard.** `checkAdmin` + `adminDenied` rather than `requireAdminOrDeny`, for the user id (same check, fail closed).
- **Route judge source.** rag_monitor_daily, not the 07-41 stdout summary, which is not stored anywhere the app can read.
- **Files outside files_modified:** rule-registry.ts, index.ts, the route test, the Python contract and its test, samples.json, the eval config test, monitor-rules.test.ts.

## Threat model
- T-07-152: the function returns counts only; LanguageDropAlert and MonitorAlert have no text field; tests assert every string of the alert and the webhook payload is an id or code.
- T-07-153: the route checks admin first and fails closed (401/403/503 tested); tenants come from rag_admin_tenant_keys in SQL, and a tenant not administered answers 403; the function is service_role only (42501 for anon and authenticated, tested both modes), and a tenant list never returns another tenant's rows (tested).
- T-07-154: 90-day cap in the route, 400 days in SQL; reads filter on tenant_key and created_at (the 0532 index).
- T-07-SC: no package installed.

## Pre-existing
- tests/rag/characterize-chat zh refusal snapshot drift is a known issue on this line (07-45's base fails it too) and is fixed on main; not touched here.
- test-rag report-only absolute gate: `false_refusal_rate language:en` above 0.25 (also on main).

## Operator actions
- Apply 0743 after the 05.3 block (any order relative to 0744 of 07-47).
- When live data exists, review the language_drop bands and minimum samples (pull request on eval/config/monitor-alerts.json through default_monitor_alerts).
- Calibrated confidence in production: set `RAG_LANG_CONFIDENCE=calibrated` only after the 07-41 calibration has been re-run on live-representative inputs.

## Deferred
- Metric-specific evidence: matchForRule has no entry for language_drop, so sample trace ids are rows of the language in the window rather than only the refused or not-helpful rows. A `MATCH_BY_RULE` keyed by metric needs a Phase 5.3 correlate change.
- Config UI panel for the language-quality route (no UI in this plan).
- Answer language on production traces while RAG_RETRIEVAL_LOG is off (carried from 07-41).

## Self-Check: PASSED
