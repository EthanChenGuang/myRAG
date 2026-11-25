---
phase: 05-verified-citations-groundedness
plan: 07
subsystem: contracts
tags: [pydantic, zod, contracts, citations, groundedness, review-queue, latency, eval-report]

requires:
  - phase: 05-verified-citations-groundedness
    provides: CitationRecord, AnswerGroundedness, GroundednessScorer (05-01)
  - phase: 03-unified-ingestion-embedding-profiles
    provides: eval_run.py RagTrace and RagRunOptions as of 03-45
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: latency.py, report.py and the last regeneration (04-26)
provides:
  - RagTrace.citations as list[CitationRecord]; TraceCitation is an alias of CitationRecord
  - RagTrace.citation_strategy (null), invalid_citations (0), groundedness (null)
  - RagRunOptions.citations and RagRunOptions.groundedness (both default false)
  - ReviewQueueItem.reasons (sampled, feedback_negative, groundedness_flagged; default [])
  - LatencyBudgets.groundedness (optional; per-scorer p50/p95; report_only Literal[True])
  - SidecarReady.scorers (hhem_2_3_vectara, hhem_2_1_open; default [])
  - EvalReport invalid_citation_rate, citation_coverage, cited_gold_hit, raw_invalid_markers, groundedness_labels, groundedness_latency, by_strategy
affects: [05-12, 05-21, 05-22, 05-24, 05-25]

actuals:
  tokens: 60000
  tasks: 2
  commits: 4
plan_head_before: f979045
plan_head_after: cb420fe

tech-stack:
  added: []
  patterns:
    - "New list fields with closed vocabularies reject repeats in Pydantic and carry uniqueItems for the generated Zod"
    - "Report-only budget sections pin report_only to Literal[True] so a config can never turn them into a gate"

key-files:
  created: []
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/src/rag_sidecar/contracts/review.py
    - rag-sidecar/src/rag_sidecar/contracts/latency.py
    - rag-sidecar/src/rag_sidecar/contracts/sidecar.py
    - rag-sidecar/src/rag_sidecar/contracts/report.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/tests/test_answer_contracts.py
    - rag-sidecar/schemas/{RagTrace,RagRunRequest,ReviewQueueItem,LatencyBudgets,SidecarReady,EvalReport,Baseline,RunManifest}.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "RagTrace.schema_version stays 1: no committed trace, test fixture or baseline holds a non-empty citations list (checked across git ls-files)"
  - "ReviewQueueItem.reasons includes sampled alongside the two D-19 reasons, as the plan's must-have lists"
  - "SidecarReady.scorers excludes none: it lists only scorers that can produce a score"
  - "EvalReport.groundedness_labels is keyed by GroundednessScorer (including none, for not_checked items) then language; counts default to 0 so partial maps validate"
  - "EvalReport.by_strategy is keyed chunk-alias, claude-citations or none; StrategySlice carries items, the three citation metrics, raw_invalid_markers, generation_latency (StageLatency) and faithfulness, so 05-24 needs no further schema change"
  - "EvalReport.raw_invalid_markers and groundedness_latency (keyed by the two scoring scorers) added now for 05-24 (D-23, D-24), so no later plan regenerates schemas"

requirements-completed: [GEN-02, GEN-03, GEN-05, EVAL-16]

coverage:
  - id: D1
    description: "Extended eval, review, latency, sidecar and report contracts with backward-compatible defaults"
    requirement: GEN-02
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_answer_contracts.py (05-07 section)"
        status: pass
  - id: D2
    description: "Regenerated JSON Schemas, Zod and samples in parity"
    requirement: GEN-03
    verification:
      - kind: unit
        ref: "tests/contracts.test.ts, tests/schema-parity.test.ts, rag-sidecar/tests/test_contract_export.py"
        status: pass
  - id: D3
    description: "Committed latency budgets and baselines still load; eval route and gates unchanged"
    requirement: EVAL-16
    verification:
      - kind: integration
        ref: "npm run test-rag (fixture and ingest modes), tests/rag/eval-route-rows.test.ts"
        status: pass
---

# Phase 5 Plan 07: Existing-contract extensions Summary

The eval trace now carries `CitationRecord` (the same shape as the UI and persistence), eval runs can ask for citations and groundedness, review items carry reasons, budgets and `/ready` know about groundedness scorers, and eval reports have slots for the citation metrics and per-strategy slices. Every new field defaults so that existing files and requests stay valid.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | 475b3f5 | test(05-07): add failing tests for Phase 5 extensions of existing contracts |
| 1 GREEN | 78b3175 | feat(05-07): extend eval, review, latency, sidecar and report contracts for Phase 5 |
| 2 | cb420fe | feat(05-07): Phase 5 samples for extended contracts and regenerated schemas |

## Tests

- RED: 12 failed, 85 passed in `tests/test_answer_contracts.py`. Failures were assertion, validation and attribute errors, with no import errors.
- GREEN: `tests/test_answer_contracts.py tests/test_contract_models.py tests/test_latency_contract.py tests/test_review_contract.py`: 198 passed. One failed (`test_review_contract.py::test_committed_schema_matches_the_model`) until Task 2 regenerated the schemas. 05-01 split its commits the same way.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 222 files, 3382 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 163 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 794 pass, 0 fail; `ingestion-ledger-pg.test.mts` hook fails (`pg_ctl: cannot be run as root`), which is pre-existing |
| check-rag-boundary + node test | ok, 1020 files scanned; 38 pass |
| `node scripts/check-config.mjs` | exit 0 |
| check-workflows.py | OK |
| rag-sidecar pytest | 928 passed, 10 skipped |
| eval pytest | 523 passed, 3 failed (pre-existing `test_parse_fixtures.py`); fixtures restored with `git checkout -- eval/fixtures/parse/` |
| `npm run gen:schemas` after commit | no diff |
| `npm run test-rag -- --out eval/out/05-07` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/05-07-ingest` | gate PASS (7 skipped) |

## Deviations

- **Extra regenerated schemas:** `Baseline.schema.json` and `RunManifest.schema.json` also changed. Both embed `RagRunOptions` through `request_options`, so the new options appear there. The plan's files list did not include them.
- **Sample fix moved to Task 1:** the `TraceCitation` sample in `samples.py` became a `CitationRecord` in the Task 1 GREEN commit, because the module would not build samples otherwise. The remaining sample enrichment stayed in Task 2.
- **Extra EvalReport fields added now:** `raw_invalid_markers`, `groundedness_latency` and `StrategySlice.faithfulness` were added beyond the three metrics the plan names. 05-24 needs them (raw markers, report-only groundedness latency, Faithfulness per strategy), and 05-07 is the last plan that regenerates schemas.
- **Uniqueness checks:** `ReviewQueueItem.reasons` and `SidecarReady.scorers` reject repeated values, following the 05-01 pattern for feedback reasons.
- **Committed budgets file unchanged:** this plan did not add a groundedness section to `eval/config/latency-budgets.json`. Plan 05-24 adds it.

## Notes for later plans

- The eval route returns `RagTraceSchema.safeParse(trace).data`. Responses now include `citation_strategy: null`, `invalid_citations: 0` and `groundedness: null` by Zod default, the same way `refusal` and other nullable fields already appear. The fixture gates pass with this. 05-22's "byte-identical without the option" check should compare against this post-default shape.
- The generated Zod cannot express the Pydantic model validators: the p50 ≤ p95 rule on `ScorerBudget`, or the `AnswerGroundedness` status rules inside `RagTrace.groundedness`. The uniqueness rules are carried by `uniqueItems`.

## Self-Check: PASSED
