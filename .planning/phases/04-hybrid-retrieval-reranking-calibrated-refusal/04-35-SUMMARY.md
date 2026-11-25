---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 35
subsystem: eval
tags: [chunking-profiles, chunking-sweep, ingest-fixture, gate, decision, chk-05]
requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-04 chunking contracts, 04-21 run configs, 04-25 sweep package and harness_runner, 04-26 slices and bounds, 04-31 dual-write under v2, 04-33 validateChunkingProfile and activation, 04-38 clause items, 04-39 fixture thresholds"
provides:
  - "run-config chunking_profiles: candidate profiles seeded as building in the ingest-mode fixture build, filled by dual-write"
  - "eval-only RetrievalOverrides.chunking_profile_by_doc_type, wired through the eval route and v2 search to p_chunking_override"
  - "python -m rag_eval.sweep chunking and chunking-decide (eval/src/rag_eval/sweep/chunking.py)"
  - "eval/reports/chunking-sweep.{json,md} (fixture) and eval/decisions/chunking/{index,contract_legal}.json"
affects: [04-34, 04-40, 04-43]
actuals:
  tokens: 67000
  tasks: 3
  commits: 8
plan_head_before: a0913ac9f0617627ead8ce6bf4db22876620a43c
plan_head_after: 5330ca963a23c8e8715793b65404848fdbd54e6c
key-files:
  created:
    - eval/src/rag_eval/sweep/chunking.py
    - eval/tests/test_sweep_chunking.py
    - tests/rag-db/eval-chunking-profiles.test.mts
    - eval/reports/chunking-sweep.md
    - eval/decisions/chunking/index.json
    - eval/decisions/chunking/contract_legal.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/retrieval.py
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/schemas/*.schema.json (6 regenerated)
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - src/app/api/internal/rag/run/route.ts
    - src/lib/rag/v2/overrides.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/v2/result.ts
    - eval/harness/run-config.mts
    - eval/harness/ingest-mode.mts
    - eval/harness/pglite-supabase.mts
    - eval/harness/run-eval.mts
    - eval/harness/run-smoke.mts
    - eval/src/rag_eval/harness_runner.py
    - eval/src/rag_eval/sweep/retrieval.py
    - eval/reports/chunking-sweep.json
    - .gitignore
    - tests/eval-route-v2.test.ts
    - tests/rag/v2/search-stages.test.ts
    - tests/rag/v2/params-hash.test.ts
key-decisions:
  - "The eval-only override chunking_profile_by_doc_type did not exist; it is now a RetrievalOverrides field. The eval route maps it, v2 search passes it as p_chunking_override for the eval profile only, and the retrieval config hash records the searched profiles (active pointers with the override on top)."
  - "Run configs may carry chunking_profiles (status building, unique non-legacy ids, RAG_PIPELINE=v2 required). They are seeded only by the ingest-mode builder, after the env overlay and before the first document. Prechunked and --base-url runs refuse them with exit 2."
  - "Sweep gate: the mean paired item difference (candidate minus legacy) on the overall and language:* slices, with band max(k x 0 spread, floor) = 0.02. Fixture runs are deterministic, so spread is 0, as in the retrieval sweep."
  - "Fixture contract_legal decision is legacy. Every candidate fails on correct refusal, and the plan's rule falls back to legacy when no candidate passes."
requirements-completed: [CHK-05, CHK-03, CHK-04]
duration: 75min
completed: 2026-11-25
status: complete
---

# Phase 4 Plan 35: Chunking sweep, gate against legacy and fixture decision Summary

**Candidate chunking profiles can now be seeded into an ingest-mode eval run, filled by ingestion dual-write, and selected per doc type through an eval-only override. `python -m rag_eval.sweep chunking` compares each preset with legacy on every CHK-05 slice and gates it. `chunking-decide` records a choice with its numbers. On the fixture, all three presets fail the gate on correct refusal, so the recorded contract_legal decision is legacy.**

## Fixture sweep results

Setup: v2-recommended plus RAG_PARENT_CHILD=true for every run, ingest fixture mode, dev split only (117 items, 96 answerable, 21 no-answer), fake quality reranker, fixture thresholds from 04-39. Ingest mode keeps the 0.65 floor (04-39). Recall@k uses k=10.

| Profile | Recall@10 | MRR | Correct refusal (upper) | False refusal (upper) | Context tokens (mean) | Gate |
|---|---|---|---|---|---|---|
| legacy | 0.677 | 0.576 | 0.286 (0.487) | 0.208 (0.288) | 695.7 | baseline |
| p128-512 | 0.729 | 0.637 | 0.190 (0.384) | 0.156 (0.230) | 787.0 | failed |
| p256-1024 | 0.729 | 0.627 | 0.190 (0.384) | 0.156 (0.230) | 789.1 | failed |
| p256-2048 | 0.729 | 0.627 | 0.190 (0.384) | 0.156 (0.230) | 809.7 | failed |

All three candidates fail on correct refusal. The deltas against the 0.02 band:
- overall: -0.095
- language:en: -0.125
- language:zh: -0.143

The cause is two more no-answer items that are answered instead of refused. Recall, MRR and false refusal all improve, so a refusal-only gate failure is exactly what the gate exists to stop.

**Clause slice** (clause-tagged items, n=2, all on contract-zh.pdf):

| Profile | Recall@10 | MRR | Context tokens |
|---|---|---|---|
| legacy | 1.000 | 1.000 | 857.5 |
| p128-512 | 1.000 | 1.000 | 812.0 |
| p256-1024 | 1.000 | 1.000 | 857.5 |
| p256-2048 | 1.000 | 1.000 | 857.5 |

The contract_legal doc-type slice is the same (n=2).

**Context cost (research F-11).**
- The validator warns `top_k_parent_over_budget` for 256/1024 (top-k 8 x 1024 = 8192 > 6000) and for 256/2048 (16384). 128/512 (4096) does not warn.
- Measured mean context tokens rise from 696 (legacy) to 787 / 789 / 810. Assembly caps the context at the 6000-token budget, so the actual cost stays well below the top-k x parent figure.

**Decision.** `eval/decisions/chunking/contract_legal.json` records profile `legacy`, decided_by `fixture-demo`, source `fixture`.
- `chosen_on` holds the contract_legal, overall and clause numbers.
- `report_hash` is the sha256 of the committed report.
- Rerunning `chunking-decide` with the same input is byte-identical.
- Trying to decide `p256-1024` exits 2 and names the failed slices.

Fixture numbers prove the mechanism: seeded profiles, dual-write, the override, the gate and the refusal of failed candidates. The live sweep decides real profiles. The retrieval gains come mostly from the lexical fixture embedder.

## Task Commits

| Task | RED | GREEN |
|---|---|---|
| Contracts (deviation) | - | `998f898d` |
| Override plumbing (deviation) | `d339c648` | `8bd51d65` |
| 1. Seeded profiles in ingest-mode runs | `7fa8797b` | `ddf5a6a4` |
| 2. Sweep, gate and decide | `d2c8ac04` | `9ff2dea9` |
| 3. Fixture sweep and decision | - | `5330ca96` |

## TDD
Every RED commit fails on assertions; stub exports are included where an import would otherwise fail.
- Override plumbing RED: 3 failed (route mapping, search override, hash helper).
- Harness RED: 7 of 8 suites failed (the unknown `chunking_profiles` key was rejected, nothing was seeded).
- Sweep RED: 11 failed against a stub module.

## Deviations from Plan

1. **[Rule 3] The override the plan relies on did not exist.** `chunking_profile_by_doc_type` was neither in RetrievalOverrides nor wired anywhere. The SQL `p_chunking_override` and the backend field existed, but v2 search never sent them.
   - What was added: the contract field (optional, so TS run_config and request hashes do not change when it is absent), the route mapping, the search-stage pass-through (eval profile only) and the retrieval config hash merge.
   - Files outside the plan list: contracts, generated schemas, `route.ts`, `overrides.ts`, `search.ts`, `result.ts`.
2. **[Rule 2] Contract additions so the outputs fit their schemas.**
   - `RunConfigRecord.chunking_profiles` records seeded profiles in the manifest.
   - `ChunkingMetricValue.upper_95` carries the refusal bounds the plan asks for.
   - `ChunkingSweepReport.notes` carries the judge skip notice and the validator warnings.
   - All three default to empty or null, and `npm run gen:schemas` leaves no diff.
3. `eval/harness/pglite-supabase.mts` passes `chunkingProfiles` through and exposes `seededChunkingProfiles`. runEval uses that field to refuse a run config whose profiles the reused ingest fixture was not built with.
4. The `chunking` and `chunking-decide` subcommands are registered inside `rag_eval.sweep.retrieval.main`, the parser `__main__` already calls, through a lazy import. `__main__.py` is unchanged.
5. `by_question_kind` carries an extra `clause` key: the clause-tagged subset of context_heavy. This gives the plan's clause slice a home without adding a contract field.
6. The gate uses only the overall and language slices, as the plan states. noise.json also gates `category:cross_lingual` and `pair:*`; those slices are not used here.
7. Report entries are keyed by preset slug (`p256-1024`). The decision maps the slug to the real profile id `<slug>-<doc_type>`. `build_run_id` is null: a fixture profile is filled by dual-write in a throwaway database, so there is no rechunk build run.
8. The legacy run also gets RAG_PARENT_CHILD=true, so all runs share one env ("same base env"). The ingest smoke without chunking_profiles still has all paired differences at zero.
9. `.gitignore` ignores `eval/reports/chunking-cells/`, the per-run scratch output.
10. The resulting decision is legacy, because no candidate passed. This follows the plan's rule.

Migration number: none used.

## Known Stubs
- `default_judge` in `eval/src/rag_eval/sweep/chunking.py` always returns skipped with a notice: no judge key, or the smoke traces carry no generated answers. A judge can be injected (tests use a stub). Wiring the nightly judge into the sweep is deferred to the live sweep.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: eval-override | src/app/api/internal/rag/run/route.ts | The eval route accepts `chunking_profile_by_doc_type`. It sits behind the eval secret and acts on the eval profile only. The SQL rejects unknown profile and doc-type pairs (22023), so tenant filtering is unchanged. |

## Deferred Items
- Three ingest golden items have `split: dev` while the rule split is test: `ingest-contract-exception-zh`, `ingest-clause-scope-en` and `ingest-clause-scope-it`. Dev-only tools drop them, so the clause and contract slices have n=2 instead of 4–5. This is golden data owned by the golden plans, not changed here.
- The live chunking sweep. The CLI is ingest-fixture only. A live sweep needs to select already-built profiles through the override, without seeding, plus nightly judge wiring. Target: 04-43 or later.
- A per-doc-type gate. Candidates set profiles for every doc type at once, so the contract_legal gate also reflects the general-corpus refusal change. A live sweep may want one candidate run per (preset, doc type).
- Pre-existing, not caused by this plan:
  - `eval/tests/test_parse_fixtures.py` regenerates `eval/fixtures/parse/*` and then fails on missing recorded outputs. The files were restored with `git checkout -- eval/fixtures/parse/`.
  - `scanned_image` recall is 0 for every profile, legacy included.
  - `tests/rag/v2/voice-budget.test.ts` failed once under load and passes alone.

## Gates
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run`: 231 files, 3435 passed, 1 skipped.
- `node --import tsx --test tests/*.test.mts`: 166 pass.
- Targeted rag-db: 69 pass across 9 files (`eval-chunking-profiles`, `eval-v2-overlay`, `v2-tracer`, `ingest-eval-retrieval-env`, `in-process-eval-lifecycle`, `chunking-activation`, `hybrid-filters`, `translation-seam-fixture`, `v2-invoice-filters`). The full rag-db suite was not run (machine load; CI is the full gate).
- `check-rag-boundary` and its node test (38), `check-config` (125), `check-workflows`: pass.
- `npm run gen:schemas`: no diff.
- Eval pytest: 594 passed with `test_parse_fixtures.py` deselected (pre-existing, see above). Sidecar contract tests: 180 passed. The full sidecar suite does not collect without pypdfium2 under `--extra chunking`, which is pre-existing.
- `npm run test-rag -- --out eval/out/04-35`: gate PASS, all paired differences zero.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/04-35-ingest`: gate PASS, all paired differences zero.
- Contract validation: chunking-sweep.json is a valid ChunkingSweepReport and contract_legal.json is a valid ChunkingDecision.
- Acceptance greps: all reach EXPECT. `chunking_profiles` in ingest-mode.mts = 2; `def run_chunking_sweep` = 1; `def decide_chunking_profile` = 1; `contract_legal` in index.json = 1; `gate_passed` in the decision = 1; `question_kind` in the report = 4.

## Self-Check: PASSED
All created files exist, and the 8 task commits are ancestors of HEAD.
