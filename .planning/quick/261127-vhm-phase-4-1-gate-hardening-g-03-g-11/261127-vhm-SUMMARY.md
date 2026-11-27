---
quick_id: 261127-vhm
slug: phase-4-1-gate-hardening-g-03-g-11
status: complete
completed: 2026-11-27
branch: exec/quick-41-gate-hardening
base: origin/ci/merge-train-39 @ c6f1b3f7
source: origin/verify/04.1 @ 94e4284d, 04.1-VERIFICATION.md
gaps_closed: [G-03, G-04, G-05, G-06, G-07, G-09, G-11]
---

# Quick 261127-vhm: Phase 4.1 gate hardening — Summary

Seven code gaps from the Phase 4.1 verification are closed. Each fix started with a test that failed on the old code. With every switch off, behaviour is unchanged: both legacy smoke tiers still give `paired.all_zero = true`.

## Commits

| Gap | RED | Fix |
| --- | --- | --- |
| G-03 | 597e6eee | 4a8eb350 |
| G-04, G-05, G-07 (tools) | a6136cc5 | ec8dc31d |
| G-04 (committed records) | — | d1e10540 |
| G-04, G-09 (CI) | — | 086ef04c |
| G-06 | af95f7d8, 166d9c52 | 4b7ec4f1 |
| G-11 | b4507684 | 4d5e0eb4 |

## What changed

- **G-03:** `rag_eval.regression.load_incumbent` now takes the five DFLT values from the decision only when `status == "flip"`, the same rule `scripts/check-config.mjs` uses. A `not_flipped` record now gives today's shipped values (`legacy`, `false`, `none`, `false`, `similarity`). A missing or unknown status is malformed input (exit 2).
  - **What this means for Phase 7:** the committed 04.1 decision is `not_flipped`, so the regression incumbent is now the legacy configuration, not v2/auto.
  - The tests that need a flipped incumbent use the new fixture `eval/tests/fixtures/regression/incumbent-flip.json`.
  - Failed before the fix: `test_a_not_flipped_decision_is_not_the_incumbent`, `test_the_committed_decision_follows_its_status`, `test_a_decision_without_a_status_stops_before_any_plan`.
- **G-04, gate and decision JSON:**
  - `defaults_gate evaluate` now writes `git_sha` (HEAD) and `evaluated_at`.
  - `defaults_decision build` copies `git_sha` and records `run_date`.
  - `DecisionRecord` has an optional `historical` field (`as_of_git_sha`, `reason`, `original_gate_sha256`). `check-current` names a historical record in its output, but still exits 1 on drift.
  - **Committed records:**
    - The gate result gained only `git_sha = 12598da41b7a6eaaead8fcf93309240e65fedf2e` (the run sha from the 04.1-17 SUMMARY). `evaluated_at` stays unrecorded, because it is not known.
    - The decision gained `git_sha`, `run_date 2026-11-26` and `historical` @12598da4. Its `gate.sha256` now points at the updated gate file; the original `e171ff69…` is kept in `historical.original_gate_sha256`.
    - Both Markdown twins were re-rendered from the JSON. They now show the sha line and `n/a` in place of the empty `n` cells.
    - Nothing else was rebuilt. `check-current` is still stale by design: the criteria and both baselines have moved on.
- **G-04 and G-09, CI** (`.github/workflows/pr-smoke.yml`, eval-smoke job): three new report-only steps. Each one captures the exit code, writes a `::notice` or `::warning`, and exits 0.
  - `defaults_decision check-current` on the 04.1 record.
  - A v2-default smoke tier on `eval/config/runs/v2-default.json`.
  - A v2 negative control: the same config with `--degrade drop_top_candidate`.
  - Both new output directories are uploaded.
  - **Deviation from "report-mode":** these steps do not pass `--gates-mode report`. `scripts/ci/check-workflows.py` allows that flag only on tiers that `eval/reports/phase-05.3/absolute-gate-measurement.json` marks as report. Changing that record is a 05.3 measurement action, so the steps are report-only at the CI-step level instead.
  - Local run: v2-default exit 10 (the gate fails, as in the verification); negative control exit 10 (rejected as designed).
- **G-05:** `defaults_gate derive` now refuses (exit 2, `criteria_after_gate_result`) when a gate result taken on the same criteria file has runs newer than the criteria it read. The default gate result is `eval/reports/phase-04.1/fixture/defaults-gate.json`, and it can be changed with `--gate-result`. `--before-run` overrides the refusal and says so on stderr; it is for an explicit new pre-registration that fresh runs must follow.
  - The committed gate result blocks a re-derive of the committed criteria (tested).
  - Whether to record 72adfe8a as D-29 or to revert it is left to the other planned task, as instructed.
- **G-06 — moved, not just documented:** `voice` is out of `AUTO_HOSTED_PROFILES` (`src/lib/rag/rerank/select.ts`), now `chat, embed, eval`.
  - **Why moving is safe:** the list is read only under `RAG_RERANKER=auto` with a Cohere key, and both are opt-in. The defaults (`RAG_RERANKER=none`, `RAG_PIPELINE=legacy`) never read it, so the switch-off behaviour is identical. The legacy tiers confirm this with `all_zero = true`.
  - **Opt-in behaviour change:** with `auto` and a key set, voice now uses the no-key fallback (`local_bm25`) until G7 measures its hosted p95. `RAG_RERANKER=cohere` still reranks voice with the fast tier.
  - **Decision builder:** for a `pending_live` result it now records the code default `chat, embed, eval`, with voice listed as dropped and marked "not measured". The historical committed record keeps its stored list.
  - Two existing assertions that encoded the old voice-hosted behaviour were updated.
- **G-07:** G1 `noise_gate` checks now carry `n` (from the report slice) and `band` (`max(k*spread, floor)`), with band 0 for absolute-zero offenders. The Markdown prints `n/a` instead of an empty cell. The committed gate result could not be regenerated with real `n` values, because the per-run reports are not in the repo (G-08). Its Markdown only shows `n/a`.
- **G-11:** added one hint under the `RAG_RERANKER` select in `scripts/config-ui/index.html` (with `aria-describedby`), and one comment line in the `scripts/init-env.js` template. Both say that `auto` with `COHERE_API_KEY` sends query and candidate text to Cohere. Tested in `tests/ui/config-reranker-cohere-hint.test.ts`, which failed on the old files.

## Design skills

- web-design-guidelines (`.claude/skills/web-design-guidelines/references/command.md`, run locally with no fetch) on the touched lines of `scripts/config-ui/index.html`:
  - The select keeps its `<label for>`, and the help text is linked with `aria-describedby`.
  - Code tokens are marked `translate="no"`.
  - One finding: the brand name "Cohere" was not `translate="no"`. Fixed.
  - No other findings.
- frontend-design, Impeccable and gsd-ui-review were not run: this is one copy line in an existing form field, not new UI.
- zh/it: this field had no i18n entry before, so English static markup is kept, matching its neighbours.

## Gates run

| Gate | Result |
| --- | --- |
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | exit 0 |
| `node scripts/check-config.mjs` | ok, 274 variables |
| `check-rag-boundary`, `check-language-literals`, `check-settings-classification` | exit 0 |
| `check-workflows.py` + `scripts/tests/test_check_workflows.py` | OK, 198 passed |
| eval pytest, full (`uv run --frozen --all-extras --directory eval pytest -q`) | 2798 passed |
| vitest: `tests/rag/rerank/`, `tests/rag/v2/`, `tests/rag/refusal/`, characterize-defaults/voice | 59 files, 862 passed, 5 skipped |
| vitest: `tests/ui/` (includes the new hint test) | 100 files, 2086 passed |
| `node --test scripts/tests/init-env-languages.node-test.mjs` | 22 passed |
| `npm run test-rag` default, prechunked / ingest | exit 0 / exit 0 |
| legacy tier, prechunked / ingest (`runs/legacy.json`) | exit 0, `paired.all_zero = true` / exit 0, `paired.all_zero = true` |
| v2-default and v2 negative control (new CI steps, run locally) | exit 10 / exit 10 (report-only) |

Environment: `npm ci --ignore-scripts --onnxruntime-node-install-cuda=skip`, `uv sync --locked --all-extras` in eval, then `fill-tiktoken-cache.py`.

## Deviations

- **Workflow:** run inline as a single executor; no planner or executor subagents were spawned. Per the orchestrator brief, STATE.md was not touched (its Quick Tasks row is left to the orchestrator).
- **G-09:** report-only at the CI-step level, not through `--gates-mode report` (reason above).
- **G-04:** the committed gate file changed by one field, so the decision's gate hash was updated; the original hash is kept in `historical`.
- **G-07:** the committed G1 rows still have no `n`, because the reports are missing (G-08).

## Deferred, not in scope

- **AGENTS.md §6 (Phase 4):** still says `auto` uses Cohere when the key is set, for every profile. After G-06, voice under `auto` stays local. A docs touch needs an explicit request.
- **Plan 07-30:** its text (line 46: "04.1-09 flips") still needs the amendment the verification asks for. It is a planning document outside this task.
- **G-05 deviation record:** D-29, or a revert of 72adfe8a, is owned by the other planned task.
