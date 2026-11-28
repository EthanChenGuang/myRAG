---
phase: 06-query-layer-llamaindex-langchain
plan: 38
subsystem: rag-eval
tags: [golden-set, query-layer, fake-llm, baseline, d-39, d-41]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-11 GoldenItem with small_talk; 06-13 parity-off test; 06-23 translate; 06-24 relative dates; 06-25 sub-question coverage; 06-29 run configs and the fake query LLM install"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-38 last Phase 4 golden and baseline changes and the per-item comparison method"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-17 last Phase 5.1 edit of golden.jsonl, the split manifest and both baselines; 05.1-09 corpus"
provides:
  - "38 approved synthetic Phase 6 golden items: per language 2 protected-code, 2 elliptical and 2 relative-time follow-ups, 2 three-part compound questions and 2 small-talk items; 4 en->zh and 4 it->zh questions about the zh-only maintenance contract"
  - "Scripted fake query-LLM entries for every new non-small-talk item (condense, decompose, translate to zh)"
  - "eval/tests/test_golden_phase6.py: per-kind and per-language minimums, dev/test per cell, protected tokens kept, translations share corpus terms"
  - "tests/rag/query/golden-phase6-gate.test.ts: each item fires its gate rule against the real gate and the fake keeps every protected token"
  - "Both fixture baselines re-recorded under RAG_PIPELINE=legacy with every old item identical"
affects: [06-39, 06-40, 06-41, 06-44]

actuals:
  tokens: 60000
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Phase 6 golden items carry one phase6_* tag naming the gate behaviour (small_talk is its own category)"

key-files:
  created:
    - eval/tests/test_golden_phase6.py
    - tests/rag/query/golden-phase6-gate.test.ts
  modified:
    - eval/fixtures/golden.jsonl
    - eval/fixtures/split-manifest.json
    - eval/fixtures/query-llm/transforms.json
    - eval/fixtures/translation-table.json
    - eval/tests/test_fixture_coverage.py
    - eval/tests/test_golden_phase4.py
    - eval/tests/test_gate_population.py
    - eval/baselines/fixture-baseline.json
    - eval/baselines/fixture-ingest-baseline.json
    - tests/rag-db/eval-query-layer-overlay.test.mts
    - tests/rag-db/ingest-mode-routing.test.mts
    - tests/fixtures/characterization/*.json

key-decisions:
  - "Cross-language items use only the zh-only scanned maintenance contract (its stem exists in no other language; the HR handbook is excluded by domain neutrality)"
  - "Compound items carry no exact code: R4 blocks rewrites of a complete question with a code, so a code would stop decompose"
  - "Relative-time follow-ups are exempt from the old no-relative-date rule; their answers do not depend on the date"

requirements-completed: [QRY-01, QRY-04, XLG-01, LAT-03]

coverage:
  - id: D1
    description: "Layer-off parity re-confirmed before any golden change"
    requirement: QRY-01
    verification:
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/p6-38-legacy; --fixture-mode ingest --out eval/out/p6-38-ingest; npx vitest run tests/rag/query/parity-off.test.ts"
        status: pass
  - id: D2
    description: "Phase 6 golden items with scripted fake-LLM entries"
    requirement: QRY-04
    verification:
      - kind: unit
        ref: "eval/tests/test_golden_phase6.py"
        status: pass
      - kind: unit
        ref: "tests/rag/query/golden-phase6-gate.test.ts"
        status: pass
      - kind: integration
        ref: "tests/rag-db/eval-query-layer-overlay.test.mts#query-layer-llamaindex records the overlay and condenses the multi_turn items with the fake"
        status: pass
  - id: D3
    description: "Baselines re-recorded with zero per-item differences on old items"
    requirement: LAT-03
    verification:
      - kind: integration
        ref: "jq per-item comparison against eval/out/p6-38-pre in both modes; npm run test-rag (both tiers) against the new baselines"
        status: pass
---

# Phase 6 Plan 38: Phase 6 golden items and re-recorded baselines

**The golden set now exercises every query-layer behaviour in zh, en and it: protected-code, elliptical and relative-time follow-ups, three-part compound questions, small talk and en/it questions about a zh-only document. Every item has its scripted fake-LLM output, and both baselines were re-recorded with all 164 (prechunked) and 225 (ingest) old items scoring exactly as before.**

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | none | Parity check only; no tracked file changed |
| 2 RED | `9999df6` | test(06-38): add failing Phase 6 golden minimums and transform-entry checks |
| 2 GREEN | `ef817c2` | feat(06-38): add 38 Phase 6 golden items with scripted query-LLM entries |
| 2 pins | `0b962b4` | test(06-38): pins follow the Phase 6 golden items |
| 3 | `b7c1e70` | feat(06-38): re-record both fixture baselines with the Phase 6 items |

## Task 1: layer-off parity (before any change)

- `npm run test-rag -- --out eval/out/p6-38-legacy`: passed, `paired.all_zero == true`.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/p6-38-ingest`: passed, `paired.all_zero == true`.
- `npx vitest run tests/rag/query/parity-off.test.ts`: 4/4 pass.
- Reference copies of both baselines are in `eval/out/p6-38-pre/` (git-ignored).

## New items (38)

| Kind | zh | en | it | Category, tag |
|------|----|----|----|---------------|
| Protected-code follow-up (R1 + R4) | 2 | 2 | 2 | multi_turn, `phase6_protected_followup` |
| Elliptical follow-up (R5) | 2 | 2 | 2 | multi_turn, `phase6_elliptical` |
| Relative-time follow-up (R2, with R1) | 2 | 2 | 2 | multi_turn, `phase6_relative_time` |
| Compound, 3 parts (R6) | 2 | 2 | 2 | compound, `phase6_compound` |
| Small talk (R12) | 2 | 2 | 2 | small_talk |
| Cross-language to zh (R8) | - | 4 | 4 | cross_lingual, `phase6_cross_lingual`, evidence_language zh |

Every (kind, language) cell has one dev and one test item; ids were picked by their hash split only (gaps in the numbering, for example en-multi-turn-004..007, 012, 013). Totals: golden.jsonl 164 -> 202; multi_turn 3 -> 9 and compound 3 -> 5 per language; cross_lingual en->zh and it->zh 4 -> 8 each.

Scripted entries in `transforms.json`: 18 condense (each keeps every code verbatim), 6 decompose (3 parts each), 8 translate to zh (each shares a corpus term with the gold quote and keeps the codes and the 50% literal).

## Task 3: baselines

- Prechunked: `RAG_PIPELINE=legacy npm run eval:baseline` (3 runs). Items 164 -> 202; all 164 old items identical.
- Ingest: `rag_eval.baseline record --runs 3 --fixture-mode ingest` under legacy. Items 225 -> 263; all 225 old items identical. It had to be re-recorded because ingest mode also scores golden.jsonl, so the golden hash changed (same reason as 05.1-17).
- Smoke against the new baselines: `npm run test-rag -- --out eval/out/p6-38` and `--fixture-mode ingest --out eval/out/p6-38-ingest2` both passed with `paired.all_zero == true`.

## Deviations

1. **[Rule 3, blocking] Cross-language items moved to the zh-only contract.** My first draft used product-specs.zh. `test_cross_lingual.py` requires the gold document stem to exist only in the evidence language, and product-specs exists in all three. All 8 items now use `scanned-contract.zh.md`. `test_golden_phase6.py` checks this too.
2. **[Rule 2] Gate test added** (`tests/rag/query/golden-phase6-gate.test.ts`, not in files_modified). Running the gate on the first draft showed that compound items with a code never decompose (R4 blocks a complete question), and that three relative-time follow-ups fired R2 without condense. I rephrased them: compound items have no code and use separate question marks; the relative-time follow-ups gained a pronoun. The test checks that each item fires its rule.
3. **[Rule 3, blocking] Pins outside files_modified updated:**
   - `eval/fixtures/translation-table.json`: 8 zh entries, because the translation-seam test needs one for every approved cross_lingual item.
   - `test_golden_phase4.py`: the byte-identity hash excludes the Phase 6 items. The 126 old rows still hash to the pinned value.
   - `test_gate_population.py`: the legacy aggregate snapshot is computed over the pre-06-38 items. The snapshot was not regenerated.
   - `test_fixture_coverage.py`: the counts changed, and relative-time items are exempt from the no-relative-date rule.
   - `tests/rag-db/eval-query-layer-overlay.test.mts`: multi_turn count 9 -> 27. The it follow-ups now condense, so the test requires all three languages.
   - `tests/rag-db/ingest-mode-routing.test.mts`: the 38 Phase 6 ids are among the ingest baseline additions.
   - The 7 route characterization snapshots were regenerated with `UPDATE_CHARACTERIZATION=1`. 5464 insertions, 0 deletions.
4. Golden lines were appended. Earlier lines were not rewritten, so they are byte-identical.

## Tests that failed before the change

- `test_golden_phase6.py`: 5 of 14 failed on assertions at RED `9999df6` (minimums, small talk, cross minimums, empty phase6 set, cells).
- The gate test is new and was not run against the earlier phrasing as a committed RED. The probe that found the decompose and condense gaps is described in deviation 2.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run`: 419 files, 7020 passed, 4 skipped.
- `node --import tsx --test tests/*.test.mts`: 172/172.
- `node --import tsx --test tests/rag-db/*.test.mts`: 2066 pass, 0 fail.
- `check-rag-boundary` + node test (52/52), `check-config.mjs`, `check-workflows.py`: pass.
- `(cd eval && uv run --all-extras --frozen pytest -q)`: 1091 passed. `eval/fixtures/parse/` was restored afterwards.
- No sidecar Python and no contracts were touched, so the sidecar pytest and `gen:schemas` were not required.
- `npm run test-rag` in both tiers: passed with paired differences all zero. The prechunked run is in `eval/out/p6-38`, the ingest run in `eval/out/p6-38-ingest2`.
- `rag_sidecar.contracts.validate --model GoldenItem`: 202 valid lines.

## Decisions for STATE

- Phase 6 golden items are identified by `phase6_*` tags plus the small_talk category. Later count pins should exclude them the same way.
- Compound items meant to exercise decompose must not contain an R4 code.

## Operator actions

None. No live LLM call; all outputs are scripted.

## Deferred

- The cache_paraphrase and cache_near_miss pairs are plan 06-39.

## Self-Check: PASSED
