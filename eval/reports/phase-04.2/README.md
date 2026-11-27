# Phase 04.2 gates

Verdict: **PASS** over off_identity, diversity, identifier, table, versions, dictionary, stem_it, refusal_mode_cells. Noise band: max(3 x spread, 0.02).

| Gate | Decision | Verdict | Offenders |
| --- | --- | --- | --- |
| off_identity | D-37 | PASS | 0 |
| diversity | D-22 | PASS | 0 |
| identifier | D-32 | PASS | 0 |
| table | ROADMAP-4.2-SC3 | PASS | 0 |
| versions | ROADMAP-4.2-SC5 | PASS | 0 |
| dictionary | D-09 | PASS | 0 |

## off_identity (D-37)

Runs: off-prechunked, off-ingest, v2-default-phase42-off, v2-default.

| Number | Value |
| --- | --- |
| off-ingest.nonzero_cells | 0 |
| off-prechunked.nonzero_cells | 0 |
| v2-default-phase42-off.nonzero_cells | 0 |

## diversity (D-22)

Runs: v2-diversity-collapse, v2-diversity-mmr, v2-default.

| Number | Value |
| --- | --- |
| v2-diversity-collapse.intent_coverage | 1.0000 |
| v2-diversity-collapse.items | 6 |
| v2-diversity-collapse.max_redundancy_over_limit | 0.0000 |
| v2-diversity-mmr.intent_coverage | 1.0000 |
| v2-diversity-mmr.items | 6 |
| v2-diversity-mmr.max_redundancy_over_limit | 0.0000 |

## identifier (D-32)

Runs: v2-identifier-on, v2-default.

| Number | Value |
| --- | --- |
| descriptive.mrr | 0.6110 |
| descriptive.mrr.reference | 0.6110 |
| descriptive.recall_at_10 | 0.7180 |
| descriptive.recall_at_10.reference | 0.7180 |
| descriptive.recall_at_5 | 0.7030 |
| descriptive.recall_at_5.reference | 0.7030 |
| descriptive_items | 159 |
| identifier_precision | 1.0000 |
| identifier_precision_n | 12 |
| items | 12 |
| near_miss_leakage | 0.0000 |
| near_miss_leakage_n | 12 |

## table (ROADMAP-4.2-SC3)

Runs: v2-table-lookup-on, v2-default.

| Number | Value |
| --- | --- |
| items | 3 |
| items_with_leg | 3 |

## versions (ROADMAP-4.2-SC5)

Runs: v2-version-scope-on, v2-default.

| Number | Value |
| --- | --- |
| items | 3 |
| superseded_kept | 3 |

## dictionary (D-09)

Runs: v2-lexical-dict-on, v2-default.

## Decisions

### stem_it (D-10): `keep_off`

| Number | Value |
| --- | --- |
| band | 0.0200 |
| dropped_slices | 0 |
| gain | 0.0000 |
| on | 0.7721 |
| reference | 0.7721 |

- language:it recall_at_10 gain 0.0000 does not exceed the noise band 0.0200

### refusal_mode_cells (D-23, D-24): `keep`

| Number | Value |
| --- | --- |
| bases_skipped_insufficient_data | 1 |
| mode_cells_evaluated | 15 |

- cohere|fake-quality-v1|it|cross|balanced: not calibrated on dev (no_separation)
- cohere|fake-quality-v1|it|cross|flexible: not calibrated on dev (no_separation)
- cohere|fake-quality-v1|it|cross|strict: base cell has no threshold to compare
- cohere|fake-quality-v1|it|same|balanced: holdout check not passed (failed_holdout)
- cohere|fake-quality-v1|it|same|flexible: holdout check not passed (failed_holdout)
- cohere|fake-quality-v1|zh|same|balanced: not calibrated on dev (no_separation)
- cohere|fake-quality-v1|zh|same|flexible: not calibrated on dev (no_separation)
- cohere|fake-quality-v1|zh|same|strict: base cell has no threshold to compare


## Report-only

- ndcg_at_context_k: reported per run, never gated (D-07)
- ttft: reported per run by cache state, never gated (D-26)

## Runs

| Run | Mode | Recall@10 | MRR | Run config hash |
| --- | --- | --- | --- | --- |
| off-prechunked | prechunked | 0.6709 | 0.6399 | `44165cead4b3` |
| off-ingest | ingest | 0.7790 | 0.6924 | `a48430c9ab66` |
| v2-default | prechunked | 0.7211 | 0.6370 | `5db73f8fe8d5` |
| v2-default-phase42-off | prechunked | 0.7211 | 0.6370 | `d3c0e87071dd` |
| v2-diversity-collapse | prechunked | 0.7211 | 0.6370 | `2903b4e3b17f` |
| v2-diversity-mmr | prechunked | 0.7261 | 0.6359 | `9e2ad503708b` |
| v2-identifier-on | prechunked | 0.8015 | 0.7107 | `687faee57136` |
| v2-table-lookup-on | prechunked | 0.7211 | 0.6370 | `c24c3113c85e` |
| v2-version-scope-on | prechunked | 0.7286 | 0.6370 | `c864ed9e5b74` |
| v2-lexical-dict-on | prechunked | 0.7211 | 0.6398 | `e4a92e5ec75c` |
| v2-lexical-stem-it-on | prechunked | 0.7211 | 0.6395 | `045679f1f4d9` |

> Fixture corpus only: every gate, threshold and rule here was committed before any gated run (D-37, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare.

## Phase close (plan 04.2-32, hand-written; the sections above are written by the gate tool)

### ROADMAP 4.2 success criteria

| # | Criterion | Shown by |
| --- | --- | --- |
| 1 | Pool 25 in the sweep grid, cap 25, nDCG@k in the sweep report | plans 04.2-05 and 04.2-12 (`eval/reports/retrieval-sweep-fixture/`); live sweep is 04.2-33 |
| 2 | Dictionary term matches after relex; stemming flips only on an it gain | `dictionary` gate PASS (04.2-19); `stem_it` rule keep_off (`eval/decisions/04.2-lexical.md`) |
| 3 | `versions: all` or a range retrieves both versions; cache bypass | `versions` gate PASS (superseded_kept 3 of 3); plans 04.2-15, 04.2-18, 04.2-21, 04.2-39 |
| 4 | TTFT on the trace for text, embed and voice; the injected delay fails the CI gate | plans 04.2-10 and 04.2-11; the TTFT gate in `tests/rag-e2e` passes (305 of 305); live numbers are 04.2-33 |
| 5 | Table lookup leg within the verified tenant, header kept, no LLM SQL, canary includes the row store | `table` gate PASS; plans 04.2-17, 04.2-24, 04.2-30; `tests/rag-db/v2-two-tenant-matrix.test.mts` |
| 6 | Duplicate clusters per tenant; collapse or mmr keeps intent coverage and limits redundancy | `diversity` gate PASS (intent coverage 1.0, redundancy over the limit 0, no slice drop); plans 04.2-16, 04.2-20, 04.2-22, 04.2-29, plus the 04.2-32 value-token fix |
| 7 | Refusal calibration lists every candidate threshold; per-mode cells; unset targets equal the Phase 4 result | plan 04.2-07; `refusal_mode_cells` rule keep on the refreshed fixture result (it and zh mode cells not calibrated or failed holdout) |
| 8 | Identifier index and filter: only the asked identifier, near misses never in context, suggestions | `identifier` gate PASS (precision 1.0 and leakage 0.0 on 12 of 12; descriptive slice equal to the reference) |

### Report-only numbers (v2-default, prechunked fixture)
- nDCG at context k: overall 0.6506; en 0.5669, it 0.6805, zh 0.7134. Per-category values are in `harness/v2-default/report.json`.
- TTFT and pre-generation (fake edge, so not a latency claim): cache state `bypass` only (the semantic cache is off): n 248, p50 50 ms, p95 71 ms. There are no cache hits on the fixture.
- Stage latencies against `eval/config/latency-budgets.json` are in each run's `report.md`; they are report-only until the live 04.2-33 measurement.

### Full suite (exit codes, 2026-11-27, tree `exec/04.2-32`)

| Command | Exit |
| --- | --- |
| `npx vitest run` (full) | 0 (706 files, 12,927 tests) |
| `node --import tsx --test tests/*.test.mts` | 0 (174) |
| `node --import tsx --test tests/rag-db/*.test.mts` | 0 after two test-fixture fixes. Run in three chunks; the first run failed `diversify-e2e` and `v2-two-tenant-matrix` (dup_cluster path) on fixture copies that differed in a digit token; both were re-run alone and pass (2 of 2, and 290 of 290 with phase33-two-tenant and semantic-cache-canary) |
| `node --import tsx --test tests/rag-e2e/*.test.mts` | 0 (305) |
| `uv run --directory eval pytest -q` | 0 (2,295) |
| `cd rag-sidecar && uv run pytest -q` | 0 (2,675 passed, 12 skipped) |
| `npm test --prefix voice-agent` (with the tsc ratchet) | 0 |
| `node scripts/check-config.mjs`, `node scripts/ci/check-rag-boundary.mjs` (with its node test), config self-tests, gen-zod test | 0 |
| `npm run gen:schemas && git diff --exit-code` | 0 |
| `npx next typegen && npx tsc --noEmit -p tsconfig.json`, `npm run typecheck:new` | 0 |
| workflow check, sibling-types tsc ratchet (voice-agent, baileys-whatsapp) | 0 |
| `node scripts/ci/check-frontend-design-summary.mjs <phase dir>` | 0 after the `## Design skills` section was added to `04.2-32-SUMMARY.md` (it was 2 before) |
| `npm run lint` | 1, pre-existing: 17,650 errors repo-wide (`eslint .` also lints `.claude/` and `.cursor/`). The files changed by this plan have the same error count as on origin/main (0, 0, 0, 1) |
| `npm run test-rag -- --out eval/out/p32-smoke` | 11, pre-existing: the absolute gate fails on false_refusal_rate language:en 0.3143 > 0.25; origin/main gives the same number |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/p32-smoke-ingest` | 0 |
