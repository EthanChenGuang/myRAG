---
phase: 06-query-layer-llamaindex-langchain
plan: 39
subsystem: rag-eval
tags: [golden-set, semantic-cache, cache-pairs, baseline, d-37, d-41]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-09 GoldenItem pair_of and the cache pair categories; 06-38 last golden and baseline edit before this plan"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-17 last Phase 5.1 edit of golden.jsonl, the split manifest and both baselines; 05.1-09 corpus"
provides:
  - "27 approved synthetic cache pair items: per language 4 cache_paraphrase and 5 cache_near_miss (one each of code, number, language, product, date), each with pair_of naming an existing answerable anchor in the same split"
  - "eval/tests/test_golden_phase6.py: pair minimums, same split, dev and test per (category, language), near-miss kinds, code verbatim, paraphrases free of protected tokens, quotes found in the corpus"
  - "tests/rag/cache/golden-pairs.test.ts: the real cache bypass rules on the pairs (paraphrase anchors storable, candidates checked; code near misses bypass; language/product/date near misses are checked)"
  - "Both fixture baselines re-recorded under RAG_PIPELINE=legacy with every old item identical"
affects: [06-41, 06-44]

actuals:
  tokens: 60000
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Cache pair items are identified by category (cache_paraphrase, cache_near_miss); near-miss kind by one near_miss_<kind> tag"

key-files:
  created:
    - tests/rag/cache/golden-pairs.test.ts
  modified:
    - eval/fixtures/golden.jsonl
    - eval/fixtures/split-manifest.json
    - eval/tests/test_golden_phase6.py
    - eval/tests/test_fixture_coverage.py
    - eval/tests/test_golden_phase4.py
    - eval/tests/test_gate_population.py
    - eval/baselines/fixture-baseline.json
    - eval/baselines/fixture-ingest-baseline.json
    - tests/rag-db/ingest-mode-routing.test.mts
    - tests/fixtures/characterization/*.json

key-decisions:
  - "Anchors are pre-existing items only (no new anchor items); an anchor may serve more than one pair (en-general-003, en-general-004, en-general-005, zh-general-001, zh-compound-001)"
  - "Language near misses ask, in their own language and with own-language evidence, about a topic whose anchor is in another language and which no same-language anchor of the pair set covers"
  - "Number near misses reuse the price-tier table anchors, which carry a model code, so they bypass by protected tokens; no code-free anchor with a number exists in the golden set"
  - "Anchors avoid the zh employee handbook (domain neutrality) and items with filters, conversation, image evidence or first-person wording"

requirements-completed: [CACHE-01]

coverage:
  - id: D1
    description: "Cache pairs per language and split with near-miss kinds"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "eval/tests/test_golden_phase6.py; eval/tests/test_fixture_coverage.py"
        status: pass
      - kind: unit
        ref: "tests/rag/cache/golden-pairs.test.ts"
        status: pass
  - id: D2
    description: "Baselines re-recorded with zero differences on old items"
    requirement: CACHE-01
    verification:
      - kind: integration
        ref: "jq per-item comparison against eval/out/p6-39-pre in both modes; npm run test-rag both tiers"
        status: pass
---

# Phase 6 Plan 39: Cache evaluation pairs and re-recorded baselines

**The golden set now holds 27 cache pairs, 9 per language: 4 paraphrases that should hit and 5 near misses that must miss (a different code, number, language, product or date). Each candidate names its anchor with `pair_of` and sits in the anchor's split, with dev and test pairs in every (category, language) cell. Both baselines were re-recorded; all 202 prechunked and 263 ingest old items score exactly as before.**

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | `88d6e9aa` | test(06-39): add failing cache pair minimums, same-split and near-miss kind checks |
| 1 GREEN | `0d06b542` | feat(06-39): add 27 cache_paraphrase and cache_near_miss golden pairs |
| 1 pins | `3c1d5592` | test(06-39): pins follow the cache pair golden items |
| 2 | `98e6f236` | feat(06-39): re-record both fixture baselines with the cache pairs |
| 2 pin | `088d1930` | test(06-39): ingest baseline additions include the cache pairs |

## Pairs

| Language | Paraphrase (dev/test) | Near miss code | number | language | product | date |
|----------|-----------------------|----------------|--------|----------|---------|------|
| en | 3 / 1 | dev (LV-RC-0050) | dev | dev (anchor it) | test | dev |
| it | 3 / 1 | dev (VV-RC-0060) | dev | dev (anchor en) | test | dev |
| zh | 3 / 1 | test (GT-500) | dev | dev (anchor en) | dev | test |

Ids follow the hash split only, so the numbering has gaps (for example en-cache-paraphrase-004, zh-cache-near-miss-006..014 are unused). Paraphrase items copy their anchor's evidence and answer. Date near misses ask about 2023, which is the year only, so they are not protected and the cache checks them by distance.

Bypass behaviour on the real rules (golden-pairs.test.ts): every paraphrase anchor can be stored and every paraphrase candidate is checked. Code near misses (and the number near misses, which carry a model code) bypass with `protected_tokens`. Language, product and date near misses are checked.

## Baselines

- Pre-change copies: `eval/out/p6-39-pre/` (git-ignored).
- Prechunked: `RAG_PIPELINE=legacy npm run eval:baseline` (3 runs). Items 202 -> 229 (+27); all 202 old items identical.
- Ingest: `rag_eval.baseline record --runs 3 --fixture-mode ingest` under legacy. Items 263 -> 290 (+27); all 263 old items identical.
- Smoke against the new baselines: `eval/out/p6-39`, `eval/out/p6-39-ingest`, `eval/out/06-39`, `eval/out/06-39-ingest` all passed with `paired.all_zero == true`.

## Deviations

1. **[Rule 2] Bypass-rule test added** (`tests/rag/cache/golden-pairs.test.ts`, not in files_modified). It proves the pair run of plan 06-41 can store each paraphrase anchor, and that a code near miss bypasses by protected tokens.
2. **[Rule 3, blocking] Pins outside files_modified:**
   - `test_golden_phase4.py`: the cache categories join `LATER_PHASE_CATEGORIES`. The 126 old rows still hash to the pinned value.
   - `test_gate_population.py`: the legacy aggregate snapshot excludes the cache categories. The snapshot was not regenerated.
   - `tests/rag-db/ingest-mode-routing.test.mts`: the 27 cache pair ids are among the ingest baseline additions. The old version fails on them (`not ok 2 - the items the new baseline adds are exactly the parse fixture items`).
   - Route characterization snapshots regenerated with `UPDATE_CHARACTERIZATION=1`. 4160 insertions, 0 deletions.
3. The ingest `rag_eval.baseline record --out` resolves from the repo root, not the working directory. My first `--out ../eval/...` wrote outside the repository, and I moved the file into `eval/baselines/` before comparing. No tracked file was affected.

## Tests that failed before the change

- `test_golden_phase6.py`: 4 new tests failed on assertions at RED `88d6e9aa`: minimums, anchors, dev/test cells and near-miss kinds. `test_fixture_coverage.py`: 3 count tests failed.
- `ingest-mode-routing.test.mts`: the committed version fails against the new ingest baseline, as shown above.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run`: 452 files, 7505 passed, 4 skipped.
- `node --import tsx --test tests/*.test.mts`: 172/172.
- `node --import tsx --test tests/rag-db/*.test.mts`: 2103 pass, 0 fail.
- `check-rag-boundary` + node test (52/52), `check-config.mjs`, `check-workflows.py`: pass.
- `(cd eval && uv run --all-extras --frozen pytest -q)`: 1110 passed. `eval/fixtures/parse/` was unchanged.
- `rag_sidecar.contracts.validate --model GoldenItem`: 229 valid lines.
- No sidecar Python or contracts were touched, so the sidecar pytest and `gen:schemas` were not required. No UI was touched.

## Decisions for STATE

- Cache pair items are identified by category. Later count pins exclude them by category, the same way the 06-38 items are excluded by `phase6_*` tags and small_talk.
- For plan 06-41: the number near misses bypass by protected tokens, so the threshold calibration gets no distance for that kind. Language, product and date near misses do give one. Anchors are reused across pairs, so a pair run with one shared cache stores some anchors more than once.

## Operator actions

None. No live call; every item is a synthetic fixture.

## Deferred

- The pair run, the threshold calibration and the wrong-hit gate are plan 06-41.

## Self-Check: PASSED
