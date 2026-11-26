---
phase: 06-query-layer-llamaindex-langchain
plan: 34
subsystem: rag-eval
tags: [query-layer, semantic-cache, eval-report, latency-budgets, d-29, d-38, d-42]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-11 last generation pass; 06-29 traces carry query_plan and per-transform query_transforms (transform, status, reason)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-26 latency.py, report.py contract and report slices"
  - phase: 05-verified-citations-groundedness
    provides: "05-07 last edit of latency.py and report.py; 05-24 last edit of latency-budgets.json and eval report.py"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-03 report contract, samples and generated files; 05.1-10 eval report.py; 05.1-19 latency-budgets.json"
provides:
  - "GroupBudget and ProfileBudget.groups ({p50_ms?, p95_ms}) in the LatencyBudgets contract"
  - "eval/config/latency-budgets.json: report-only query group (chat/embed p50 600 / p95 1200 ms, voice p95 300 ms) and per-transform p95 equal to the D-27 timeouts"
  - "EvalReport.query_layer (QueryLayerReport) and EvalReport.semantic_cache (SemanticCacheReport), optional, default None"
  - "build_query_layer_report, build_semantic_cache_report, query_stage_latency and cache_outcome in eval/src/rag_eval/report.py, plus Markdown sections"
affects: [06-32, 06-36, 06-41, 06-43, 06-44, 06-46]

actuals:
  tokens: 60000
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "The semantic_cache stage reports its outcome through stage_counts: hit (1 or 0), distance, or bypass_<reason> = 1; a failed check is a fail-open miss"

key-files:
  created:
    - eval/tests/test_report_query.py
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/latency.py
    - rag-sidecar/src/rag_sidecar/contracts/report.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/tests/test_latency_contract.py
    - rag-sidecar/schemas/EvalReport.schema.json
    - rag-sidecar/schemas/LatencyBudgets.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - eval/config/latency-budgets.json
    - eval/src/rag_eval/report.py
    - eval/tests/test_latency_report.py
    - eval/tests/test_report_citations.py

key-decisions:
  - "GroupBudget.p50_ms is optional because D-29 gives voice a p95 only; p95_ms is required and both are > 0 with p50 <= p95"
  - "Chat and embed translate budget moves from 5 ms to 600 ms (D-27 timeout, per D-29): with the layer on, the translate stage record is the query-layer translate transform. Voice translate stays 5 ms (no voice D-27 timeout). Report-only either way"
  - "Query-stage latency per trace = query_gate + condense + semantic_cache + the slowest of normalize_dates, expand, hyde, decompose, translate (the D-05 order; the trace has no stage start times, so the parallel group is its slowest member)"
  - "Budget status uses the chat profile's query group (the same profile as the existing latency section): over when p95 > budget p95 or, when the budget has a p50, p50 > budget p50"
  - "A transform ran when its status is ok or degraded; skipped, timeout, error and aborted count as skipped with the trace reason (falling back to the status); disabled counts as disabled. One status per transform and trace (several variants of one transform count once)"
  - "LLM transforms: condense, expand, hyde, decompose, translate; the share's denominator is the traces with a query plan"
  - "Protected-token losses count QueryPlan.skipped entries with reason protected_token_lost"
  - "Cache outcome convention for 06-32 and 06-41: stage_status.semantic_cache plus stage_counts.semantic_cache {hit: 1|0, distance} or {bypass_<reason>: 1}; status disabled or no stage means not checked; skipped, timeout, error or aborted is a miss counted under failures (D-36). Hit and miss latency is the retrieval total (all stages except generation)"
  - "Near-miss wrong-hit rate: denominator is cache_near_miss items whose check ran (hit or miss), numerator those that hit; None when no near-miss item was checked"
  - "With traces, layer-off reports carry both sections empty (zero counts, empty maps, None latencies); without traces both are None. Markdown sections render only with data, so layer-off report.md is byte-identical"

patterns-established:
  - "New EvalReport sections: build from traces in build_report, render only when non-empty, keep the layer-off Markdown byte-identical and prove the remaining JSON bytes unchanged by stripping the new keys"

requirements-completed: [QRY-05, QRY-07, LAT-03, CACHE-01]

coverage:
  - id: D1
    description: "LatencyBudgets profiles accept an optional groups map; the committed budgets file has the D-29 query groups and D-27 per-transform p95 entries"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_latency_contract.py::TestQueryGroupBudgets (9 cases); eval/tests/test_latency_report.py"
        status: pass
    human_judgment: false
  - id: D2
    description: "EvalReport gains QueryLayerReport and SemanticCacheReport; old reports validate with both None; samples, JSON Schema and Zod regenerate with no diff"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_latency_contract.py::TestEvalReportQuerySections; tests/contracts.test.ts; tests/schema-parity.test.ts; rag-sidecar/tests/test_contract_export.py"
        status: pass
    human_judgment: false
  - id: D3
    description: "Report computes gate rule counts, transform statuses with skip reasons, LLM share, protected-token losses and query-stage latency against the budget overall, per language and per category"
    requirement: QRY-07
    verification:
      - kind: unit
        ref: "eval/tests/test_report_query.py (3 query-layer cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Report computes cache checks, bypasses by reason, hits, misses, failures, hit-vs-miss p50/p95 and the near-miss wrong-hit rate"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "eval/tests/test_report_query.py (3 cache cases)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Layer-off traces give empty sections; every existing number, the Markdown and the other JSON bytes are unchanged; reports hold no query text"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "eval/tests/test_report_query.py (5 cases); eval/tests/test_report_citations.py byte pin; eval/tests/test_report_v2.py"
        status: pass
    human_judgment: false

duration: 90min
completed: 2026-11-26
status: complete
---

# Phase 6 Plan 34: Query-layer and semantic-cache report sections Summary

**Every eval report now says what the query layer and the semantic cache did: which gate rules fired, which transforms ran, were off or were skipped and why, how often an LLM transform ran, protected-token losses, query-stage latency against new report-only budgets, and cache hits, misses, bypasses, hit-vs-miss latency and near-miss wrong hits.**

## Commits

| Task | Commit |
|------|--------|
| 1 RED | `b6837f0` test(06-34): add failing tests for query-group latency budgets |
| 1 GREEN | `6b41e1f` feat(06-34): add query-group and per-transform latency budgets (D-29) |
| 2 RED | `b3f023d` test(06-34): add failing tests for query-layer and semantic-cache report sections |
| 2 GREEN | `ce759fe` feat(06-34): add query-layer and semantic-cache sections to the EvalReport contract |
| 3 RED | `f80c4bd` test(06-34): add failing tests for query-layer and cache report sections |
| 3 GREEN | `0a6a1fb` feat(06-34): compute query-layer and semantic-cache report sections from traces |

## Behaviour changes
- Eval only. `report.json` gains `query_layer` and `semantic_cache` whenever traces are scored; for runs without query plans or cache checks they are empty (zero counts, empty maps). `report.md` gains "Query layer (report-only)" and "Semantic cache (report-only)" sections only when they hold data.
- `eval/config/latency-budgets.json`: `groups.query` for chat and embed (p50 600, p95 1,200 ms) and voice (p95 300 ms); stage p95 entries condense 600, translate 600, expand 700, decompose 800, hyde 900, semantic_cache 150 for chat and embed, and condense 300 for voice. All report-only; 06-46 replaces them with measured numbers.
- No product route, env switch or retrieval path changed. Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed are untouched.

## RED evidence
- Task 1: 3 cases failed on `ValidationError` (`groups` was an unknown field) and on the missing committed query budgets.
- Task 2: 4 cases failed on `AttributeError` for `query_layer` / `semantic_cache` and on `ValidationError` for the new payloads.
- Task 3: 8 of 11 cases failed (`build_report` had no `budgets` argument and no sections were computed).

## Deviations
1. **Translate budget.** D-29 sets per-transform p95 equal to the D-27 timeouts, so chat and embed `translate` moves from Phase 4's 5 ms (table translator) to 600 ms. `eval/tests/test_latency_report.py` (named in the plan's verify list) now pins the Phase 4 entries plus the D-27 entries.
2. **Re-pinned report bytes.** `eval/tests/test_report_citations.py::test_report_without_citation_data_is_byte_identical_to_before` pins report hashes. The Markdown hashes are unchanged. The JSON hashes are re-pinned because layer-off reports now carry the empty sections, and the test now also asserts that removing the two new keys gives the earlier hash (`7437bc8e…`), so every other byte is proven unchanged. The same re-pin pattern was used in merge-train-14.
3. **Cache trace convention defined here.** 06-32 and 06-41 have not run, so no trace carries a cache outcome yet. The report reads `stage_status.semantic_cache` and `stage_counts.semantic_cache` (`hit`, `distance`, `bypass_<reason>`), which fit the existing `StageEntry.counts` and `sanitizeStageCounts` key rule. 06-32 and 06-41 must emit that shape (see Findings).
4. **No `__init__.py` export.** The new models (`GroupBudget`, `QueryLayerReport`, `SemanticCacheReport`, `TransformOutcomeCounts`, `BudgetedLatency`) are imported from their modules; `contracts/__init__.py` was not in the plan's file list.

## Findings for later plans
- **06-32 / 06-41 (cache stage and eval cache traces):** record the `semantic_cache` stage with `counts: { hit: 1, distance }` on a hit, `{ hit: 0 }` on a miss, and `{ bypass_<reason>: 1 }` (reason from `CheckBypassReason`) on a bypass. A failed or timed-out check needs no counts; its status alone makes it a miss under failures. Without this, the report shows the cache as unchecked.
- The query-stage latency adds the cache check sequentially after the parallel group, as D-05 orders it.

## Gate results
All gates passed at `0a6a1fb`:
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run`: 418 files, 7,014 passed and 4 skipped.
- `node --import tsx --test tests/*.test.mts`: 172 passed.
- `node --import tsx --test tests/rag-db/*.test.mts`: 2,066 passed.
- Boundary check (1,523 files) and its node test (52): pass.
- `node scripts/check-config.mjs`: 191 variables match the manifest.
- `check-workflows.py`: OK.
- Sidecar pytest: 1,879 passed and 11 skipped. Eval pytest: 1,088 passed.
- `npm run gen:schemas` run twice: no diff.
- `npm run test-rag -- --out eval/out/06-34`: gate PASS. Its report has an empty `query_layer` (0 of 164 planned) and `semantic_cache` (0 checks), and no new Markdown section.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-34-ingest`: gate PASS.
- Extra check: `npm run test-rag -- --run-config eval/config/runs/query-layer-llamaindex.json --no-gate --out eval/out/06-34-ql` gave 164 of 164 planned items, a gate rule table, an LLM-transform share of 0.104, condense 4, decompose 9, expand 4 and hyde disabled 4. The query stage was within budget (fixture p95 2 ms).

## Requirement IDs
QRY-05, QRY-07, LAT-03, CACHE-01 (report and budget parts).

## Decisions for STATE
- Query-stage latency = gate + condense + cache + the slowest parallel transform; budget status uses the chat query group.
- Cache outcome convention in `stage_counts.semantic_cache` (above) is the contract between the pipeline (06-32, 06-41) and the report.
- Chat and embed `translate` budget is 600 ms (report-only).

## Operator actions
- None. No live call is made; 06-46 replaces the starting budgets with live measurements.

## Deferred
- Live latency numbers (06-46). The cache section fills once 06-32 and 06-41 emit the stage counts.
