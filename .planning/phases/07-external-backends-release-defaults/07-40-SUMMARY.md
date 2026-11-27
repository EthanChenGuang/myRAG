---
phase: 07-external-backends-release-defaults
plan: 40
subsystem: rag-eval-contracts
tags: [pydantic, zod, contracts, lang-10, lang-11, sec-11, obs-03]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-05 (RagTrace retrieval_backend, last eval_run.py editor), 07-17 (last registry, samples and generated-file editor)"
  - phase: 05.1.1-feedback-loop
    provides: "LanguageCode pattern (05.1.1-01), closing plan 05.1.1-22"
  - phase: 03.2-language-support-ingestion-hardening
    provides: "closing plan 03.2-68 (registry Language type, deliberately not used here)"
  - phase: 05-verified-citations-groundedness
    provides: "closing plan 05-25; 05-VERIFICATION.md status human_needed"
  - phase: 05.1-prompt-injection-defense
    provides: "closing plan 05.1-22 (D-14 attack-success rule); 05.1-VERIFICATION.md status human_needed"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "closing plan 06-45; 06-VERIFICATION.md status human_needed"
provides:
  - "rag-sidecar/src/rag_sidecar/contracts/language_monitor.py: TraceLanguages, LanguageConfidenceCalibration (CalibrationBin, CalibrationInput, CalibrationLengthBuckets), LanguageQualityCell, LanguageDropAlert, LanguageWindow"
  - "rag-sidecar/src/rag_sidecar/contracts/rollout.py: RolloutRecord, RolloutRef, RolloutPromoteResult, RolloutLanguageComparison, RolloutMeasure"
  - "rag-sidecar/src/rag_sidecar/contracts/red_team.py: RedTeamCorpusItem, RedTeamDocument, RedTeamReport, RedTeamCell, RedTeamSuccess"
  - "RagTrace.languages (optional TraceLanguages, left out of the JSON while None)"
  - "Seven new JSON Schemas and their Zod schemas in src/lib/rag-eval/contracts.generated.ts"
affects: [07-41, 07-42, 07-46, 07-47, 07-49]

actuals:
  tasks: 2
  commits: 4  # RED, GREEN, registration, SUMMARY

tech-stack:
  added: []
  patterns:
    - "A module imported by eval_run.py must not import cache, monitor, feedback_loop or golden (they import eval_run through golden.py); restate the shared patterns and pin them equal to their sources in a test"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/language_monitor.py
    - rag-sidecar/src/rag_sidecar/contracts/rollout.py
    - rag-sidecar/src/rag_sidecar/contracts/red_team.py
    - rag-sidecar/tests/test_revision4_contracts.py
    - rag-sidecar/schemas/LanguageConfidenceCalibration.schema.json
    - rag-sidecar/schemas/LanguageQualityCell.schema.json
    - rag-sidecar/schemas/LanguageDropAlert.schema.json
    - rag-sidecar/schemas/RolloutRecord.schema.json
    - rag-sidecar/schemas/RolloutPromoteResult.schema.json
    - rag-sidecar/schemas/RedTeamCorpusItem.schema.json
    - rag-sidecar/schemas/RedTeamReport.schema.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - rag-sidecar/schemas/RagTrace.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "language_monitor.py restates LANGUAGE_CODE_PATTERN (FBK-01, 05.1.1-01), the canonical TENANT_KEY_PATTERN and the monitor code, sha256, day, timestamp and trace-id patterns instead of importing them: eval_run.py imports TraceLanguages, and cache/monitor/feedback_loop import eval_run through golden.py, so an import would be circular. test_restated_patterns_equal_their_sources pins every copy equal to its source. rollout.py and red_team.py (not imported by eval_run) import LanguageCode from feedback_loop directly"
  - "RagTrace keeps its existing top-level query_language and answer_language fields unchanged; languages is a separate optional block (additive)"
  - "LanguageConfidenceCalibration must hold the full grid of 12 bins (2 confident flags x 3 length buckets x 2 script classes), each once; it records smoothing 'laplace' and length_buckets {short_max_chars < medium_max_chars} so a reader can place a query in a bin. A calibrated bin needs n >= 1 and value = (correct+1)/(n+2) within 1e-4 (allows 4-decimal rounding); an empty bin must be source mapped_fallback with the D-03a mapped value (1.0 confident, 0.5 not)"
  - "LanguageQualityCell: refused + kb_unavailable <= retrievals (one outcome per log row), votes_up + votes_down <= retrievals, low_confidence <= retrievals; tenant_key None means all tenants; window is {since, until} days with since <= until"
  - "LanguageDropAlert.metric is refusal_rate | not_helpful_rate | kb_unavailable_rate | low_confidence_rate (event/total measures); rule_id is a code (07-46 writes language_drop); sample_trace_ids at most 10, unique"
  - "RolloutRecord.candidate_ref / incumbent_ref are a typed RolloutRef naming exactly one of embedding_profile_id, chunking_profile_ids (non-empty, unique) or rebuild_run_id, matching the rollout kind (the 0744 jsonb refs). incumbent_ref may be None only for rebuild_run (the incumbent is the previous published versions). share_percent is an integer 0..100, required for share and forbidden for tenants. Salt pattern ^[A-Za-z0-9_-]{8,128}$. ended_at is set exactly when the state is not active; ended_by needs ended_at. Actor ids are uuids"
  - "RolloutPromoteResult carries rollout_id, ok, refusal (code with up to three colon parts, e.g. rollout_language_drop:<lang>:<metric>, external_not_ready:<backend>) and per language and metric the three measures of 07-49 (candidate_now, candidate_before, incumbent_now, each {value, n}) and the verdict holds | worse | insufficient | unmeasured. refusal is present exactly when ok is false; ok excludes any worse or insufficient comparison; rates must lie in 0..1; a measure with n > 0 needs a value. The 07-49 HTTP rule (409 { code }) is a route rule; this model is the result body / CLI shape"
  - "RedTeamCorpusItem technique id pattern ^[a-z][a-z_]{0,28}$ so the review tag rt_<technique> fits the queue's ^[a-z_]{1,32}$ tag pattern; carrier is one of body_text, hidden_text, link_text, link_target, table_cell, image_caption, conversation_turn (the 07-42 technique families). Added goal (structural description of the planted instruction) and injected_quotes (spans of the attack documents, for the D-14 exposure signal). The canary must appear in an attack document and in neither the question nor a legitimate document; forbidden_claims compile and use no back-reference (same rule as the golden PartialSpec); production needs review_item_id"
  - "RedTeamReport: cells unique per (technique, language) with n >= 1 and successes <= n; each listed success (item id, technique, language, trace id, D-14 signals canary | forbidden_claim | exposed) needs its cell and the cell's successes equal the listed count; review_items_opened <= successes; skipped_reason domain_expert_review_off | review_route_unavailable, and review_off means 0 opened. config_hash is a hex hash (8..64)"
  - "Export modes: LanguageConfidenceCalibration and RedTeamCorpusItem 'validation' (files read back), the other five 'serialization' (tool or route output)"
  - "Plan said 'update the RagTrace sample with a languages block': the base RagTrace sample now carries languages; added variants RolloutPromoteResult:refused and RedTeamReport:review_off"

requirements-completed: []  # contracts only; LANG-10, LANG-11 and SEC-11 complete with 07-41/42/46/47/49

duration: ~40min
completed: 2026-11-27
---

# Phase 7 Plan 40: Revision-4 contracts Summary

**One Pydantic definition, with generated Zod, for the LANG-10 trace languages, confidence calibration, per-language cells and drop alert, the LANG-11 rollout record and promote result, and the SEC-11 red-team corpus item and report.**

## Accomplishments
- Three new contract modules (`language_monitor.py`, `rollout.py`, `red_team.py`); every model forbids unknown fields; language values match the FBK-01 LanguageCode pattern (`und` included), tenant keys the canonical lower-case pattern.
- `RagTrace.languages` added as an optional block; a trace without it validates and serialises as before.
- Seven models registered with neutral synthetic samples (invented nouns, a canary token), regenerated JSON Schemas, samples fixture and Zod; `npm run gen:schemas` leaves no diff.

## Task Commits
1. RED: `d2365056` test(07-40): failing tests (model stubs so the tests fail on validation, not on import)
2. Task 1: `c129fa9f` feat(07-40): the revision-4 models and RagTrace.languages
3. Task 2: `da3a0552` feat(07-40): registration, samples, regenerated schemas and Zod
4. SUMMARY (this commit)

## Behaviour changes
None at runtime. Contracts only; no switch, route, SQL or env variable added. The RagTrace change is additive (an optional key in the schema and Zod).

## Tests that failed before the change
`tests/test_revision4_contracts.py`: 10 acceptance tests failed against the empty stubs at the RED commit (every accepting case, including the RagTrace sample carrying `languages`).

## Gates run
- `uv run --directory rag-sidecar pytest -q` (full sidecar suite, shared contracts modules touched): see Gate results below
- `npm run gen:schemas && git diff --exit-code`: no diff
- `npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts`: 521 passed
- `npx vitest run` on the 151 test files that import `contracts.generated.ts` or the samples fixture: see Gate results below
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: see Gate results below
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: see Gate results below
- Not run (area not touched): rag-db tests, workflow check, eval pytest, test-rag, frontend design summary

## Gate results
- rag-sidecar full pytest: 2808 passed, 12 skipped
- `tests/test_revision4_contracts.py`: 90 passed
- `npm run gen:schemas` then `git diff --exit-code`: clean
- `npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts`: 2 files, 521 tests passed
- `npx vitest run` on the importers of the generated contracts and the samples fixture: 149 files collected (151 listed; the vitest include config collects 149 of them), 3086 passed, 1 skipped, 0 failed
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- check-rag-boundary, check-config, check-language-literals, check-settings-classification: all exit 0

## Deviations from Plan
- **Pattern restatement instead of import (Rule 3, blocking):** importing LanguageCode from feedback_loop (or monitor) into `language_monitor.py` made `eval_run.py` circular. Fix: restate the patterns, pinned equal to their sources by a test. Files: `language_monitor.py`, `test_revision4_contracts.py`. Commit `c129fa9f`.
- **Extra fields beyond the plan's list** (needed by the dependent plans' must-haves): calibration `smoothing`, `length_buckets`, bin `source`; corpus item `goal`, `injected_quotes`; report `finished_at`, success `signals`; promote result `rollout_id`. All are recorded in key-decisions.

## Threat model
- T-07-135: no model except RedTeamCorpusItem has a text field; alerts and cells hold codes, counts and ids; extra fields are forbidden.
- T-07-136: every tenant key matches the canonical pattern; included and excluded must be disjoint; refs must match the rollout kind.

## Operator actions
None.

## Deferred
None. Consumers: 07-41 (TraceLanguages, calibration), 07-42 (red team), 07-46 (cells, alert), 07-47 and 07-49 (rollouts) import these models.

## Self-Check: PASSED
