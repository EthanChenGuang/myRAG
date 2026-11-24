---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 26
subsystem: eval
tags: [rag, eval, report, pydantic, zod, latency, clopper-pearson]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: golden tags and Category (04-04), trace stage_status, legs and stage_counts (04-21)
provides:
  - rag_eval.bounds.upper_bound and binom_cdf (exact one-sided Clopper-Pearson, stdlib)
  - EvalReport by_doc_type and by_question_kind slices, false_refusal_upper_95 on every SliceMetrics
  - rerank_skipped_rate and lexical_leg_hit_rate_at_10 report metrics
  - report-only v2 stage p95 budgets (rerank 600 chat and embed, 250 voice) in eval/config/latency-budgets.json
affects: [04-25, 04-30, 04-35, 04-39, 04-40]

actuals:
  tokens: 11000
  tasks: 3
  commits: 7
plan_head_before: 96ec63378737fb89a435888b7ab2c257a6ae57ae
plan_head_after: 88ff735124deaa639099ea9753eee88c941be41a

tech-stack:
  added: []
  patterns:
    - "Report additions are optional fields with defaults, so reports written before this plan still validate"
    - "Question kind is one pure function (metrics.question_kind) that the chunking sweep and the final comparison can import"

key-files:
  created:
    - eval/src/rag_eval/bounds.py
    - eval/tests/test_bounds.py
    - eval/tests/test_report_v2.py
  modified:
    - eval/src/rag_eval/metrics.py
    - eval/src/rag_eval/report.py
    - eval/src/rag_eval/runner.py
    - eval/src/rag_eval/corpus.py
    - eval/config/latency-budgets.json
    - eval/tests/test_latency_report.py
    - rag-sidecar/src/rag_sidecar/contracts/report.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/tests/test_latency_contract.py
    - rag-sidecar/schemas/EvalReport.schema.json
    - rag-sidecar/schemas/EmbeddingProfileComparison.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "rerank_skipped_rate and lexical_leg_hit_rate_at_10 are MetricValue objects (value, n); value is null when nothing was attempted, so the denominator is always visible"
  - "Rerank attempted means a trace whose stage_status.rerank is present and not disabled; skipped means skipped or timeout (error, degraded and aborted count as attempted, not skipped)"
  - "The lexical leg counts as having run for the whole run when any trace shows lexical in stage_counts.search or in a candidate's legs; answerable items then count as a hit or a miss, otherwise the metric is null (no legacy run is scored 0)"
  - "Lexical hit uses the candidate list (where legs live), a candidate whose legs.lexical rank is 10 or better and whose text matches any gold span"
  - "by_doc_type takes the type of the first gold-evidence document (general for no-answer items, unknown documents or no map); the slices use the gate population, like by_category"
  - "Doc types come from the fixture-meta doc_type key through score_items(doc_types=) and runner --corpus; without the flag the runner reads the fixture corpus only when the manifest records a corpus hash"
  - "The latency contract already accepts any stage name, so latency.py and LatencyBudgets.schema.json did not change"

patterns-established:
  - "Slice-level honesty: every SliceMetrics carries the 95% upper bound next to the false-refusal point estimate; n=0 answerable gives 1.0"

requirements-completed: [CHK-05, RET-10, RNK-06, LAT-02, RNK-05]

coverage:
  - id: D1
    description: "Exact Clopper-Pearson upper bound: (0,13)=0.206, (0,18)=0.153, (0,20)=0.139, closed form at k=0, (0,0)=1.0"
    requirement: CHK-05
    verification:
      - kind: unit
        ref: "eval/tests/test_bounds.py"
        status: pass
    human_judgment: false
  - id: D2
    description: "by_doc_type, by_question_kind, false_refusal_upper_95, rerank_skipped_rate, lexical_leg_hit_rate_at_10 in the report contract, writer and Markdown; legacy reports still validate"
    requirement: RET-10
    verification:
      - kind: unit
        ref: "eval/tests/test_report_v2.py"
        status: pass
      - kind: unit
        ref: "tests/contracts.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "v2 stage p95 budgets for chat, embed and voice, report-only, rerank 600 and 250"
    requirement: LAT-02
    verification:
      - kind: unit
        ref: "eval/tests/test_latency_report.py"
        status: pass
      - kind: unit
        ref: "rag-sidecar/tests/test_latency_contract.py"
        status: pass
    human_judgment: false

duration: 40min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 26: Report slices, bounds and latency budgets Summary

**Eval reports now slice by document type and question kind, print an exact 95% upper bound next to every false-refusal rate, report rerank skip rate and lexical-leg hit rate, and show v2 stage latency against report-only budgets (rerank 600 ms chat, 250 ms voice).**

## Accomplishments

- `bounds.py`: `binom_cdf` and `upper_bound` with `math.comb` and 60 bisection steps. `upper_bound(0, n)` equals `1 - 0.05 ** (1 / n)` within 1e-9, `(0, 0)` and `(n, n)` give 1.0, invalid counts raise.
- Contract (additive, all optional): `SliceMetrics.false_refusal_upper_95`; `ItemResult.doc_type`, `question_kind`, `rerank_status`, `lexical_hit_at_10`; `EvalReport.by_doc_type`, `by_question_kind`, `rerank_skipped_rate`, `lexical_leg_hit_rate_at_10`. Pre-existing fields, the gate and `by_language_pair` are untouched; a report without the new keys validates.
- `metrics.question_kind(category, tags)`: `clause` tag or compound or multi_turn gives `context_heavy`; exact_term, general, table give `fact_lookup`; everything else `other`.
- Markdown: a bound column on every table, "By document type" and "By question kind" tables (omitted when empty), and a "Retrieval stage metrics" block with the two new rates plus a note on how to read the bound.
- Runner: `score --corpus <dir>` feeds fixture-meta `doc_type` (new `CorpusDocument.doc_type`) into `score_items(doc_types=)`.
- Budgets: chat and embed translate 5, embed 200, search 400, fuse 5, dedupe 5, rerank 600, refusal 1, expand_parents 100, assemble 100, compress 50; voice translate 5, embed 200, search 300, fuse 5, dedupe 5, rerank 250, refusal 1, assemble 50. Totals stay 1000/2000 and 400/800. The report's existing latency table already prints p50 and p95 for any stage name and compares against the chat profile, so rerank shows against 600.

## Task Commits

| Task | Commit | Subject |
| ---- | ------ | ------- |
| 1 RED | c746d11 | test(04-26): RED for the exact binomial upper bound |
| 1 GREEN | 1a49e3f | feat(04-26): exact binomial upper bound for false-refusal rates |
| 2 RED | bd248de | test(04-26): RED for report slices, refusal bounds, rerank and lexical-leg metrics |
| 2 GREEN | 9700f9b | feat(04-26): report slices by document type and question kind, refusal bounds, rerank and lexical-leg metrics |
| 3 RED | 5cbd449 | test(04-26): RED for v2 stage latency budgets |
| 3 GREEN | 08bf058 | feat(04-26): v2 stage latency budgets, report-only |
| 3 follow-up | 88ff735 | test(04-26): sidecar budget test accepts the v2 stage targets |

## Deviations from Plan

**1. [Rule 1 - Bug] Sidecar budget test asserted the Phase 2 stage table exactly**
- **Found during:** Task 3
- **Issue:** `rag-sidecar/tests/test_latency_contract.py::test_committed_config_matches_the_decided_budgets` compared chat and embed stages to `{embed, search, assemble}` only and would fail on the new stages. It was not in the plan's file list.
- **Fix:** it still asserts the three Phase 2 budgets and now also asserts rerank 600 (chat, embed) and 250 (voice). Found after the Task 3 GREEN commit (a chained command did not stop on the failure), fixed in 88ff735.
- **Commit:** 88ff735

**2. [Rule 3 - Scope] Contract and RED stubs**
- The RED commits for Tasks 1 and 2 carry a stub (`bounds.py` returning 0.0, `question_kind` returning "other") so the tests fail on assertions and not on a missing import. The GREEN commits replace both.

**3. [Rule 3 - Scope] `latency.py` and `LatencyBudgets.schema.json` unchanged**
- Listed in the plan, but `ProfileBudget.stages` is a free `dict[str, float]`, so the new stage names already validate. No schema drift to commit for Task 3 beyond the Task 2 regeneration.

**4. Commit-protocol note**
- The per-agent branch allow-list in the executor commit protocol expects `agent-*`; this plan was assigned `exec/04-26` by the orchestrator, so only the protected-branch and worktree-toplevel checks were applied.

## Known Stubs

None.

## Deferred Issues

- Pre-existing, environment only: `eval/tests/test_judge_offline.py` and `eval/tests/test_online_judge.py` fail to collect (no `deepeval`), `test_draft_cli.py::test_pinned_synthesizer_forces_style_and_length` (no `ragas`) and `test_judge_config.py::test_importing_deepeval_after_the_opt_out_does_not_load_dotenv_files` fail; `tests/ingest-queue-contracts.test.ts` "BackfillManifestEntry rejects a known invalid case" fails. `rag-sidecar` tests that import `docling_core` fail to collect. None touch this plan.
- `eval/harness/run-smoke.mts` and `run-profile-compare.mts` call `rag_eval.runner score` without `--corpus`; they get doc types through the fixture-corpus default (manifest has a corpus hash). Plan 04-37 adds `doc_type` to the fixture docs; until then every item is `general`.
- `lexical_hit_at_10` reads the post-dedupe candidate list, so a lexical hit cut by the rerank input cap counts as a miss (conservative for the P-7 trigger).

## Threat Flags

None. T-04-49 is mitigated: every slice carries `false_refusal_upper_95`, and the Markdown note says a point estimate at or below target is not evidence until the bound is.

## Self-Check: PASSED

- Files: bounds.py, test_bounds.py, test_report_v2.py, SUMMARY present; commits c746d11, 1a49e3f, bd248de, 9700f9b, 5cbd449, 08bf058, 88ff735 are ancestors of HEAD.
- `npm run gen:schemas` leaves a clean tree.
