---
phase: 03-unified-ingestion-embedding-profiles
plan: 11
subsystem: eval-golden-set
tags: [golden-set, cross-lingual, pydantic, zod, noise-gate, baseline, xlg-02]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: Pydantic to JSON Schema to Zod pipeline, paired-difference report, noise-band gate, baseline recorder
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: colloquial, ambiguous and typo categories, provenance slices, pinned legacy eval env, 90-item fixture golden set
provides:
  - cross_lingual golden Category and optional evidence_language on GoldenItem and DraftedItemProposal, with the cross-field validator
  - EvalReport.by_language_pair (default empty) and ItemResult.evidence_language
  - pair:<question>-><evidence> and category:cross_lingual slices in the report, baseline recorder, gate and paired report, gated like language slices
  - 24 approved synthetic cross_lingual fixture items (4 per pair, six pairs) quoted only from single-language documents
  - legacy baseline re-recorded with the cross_lingual slice and its pairs; 90 pre-existing items unchanged
affects: [03-45, 03-46, phase-04, phase-06]

actuals:
  tokens: 171000
  tasks: 3
  commits: 7
plan_head_before: 9729bd96d42cad0daf78844e65a888b0cd0fcec4
plan_head_after: 85082baa7dfa172a5df729c9c15cbbd8f1e7c34d
commits: 7

tech-stack:
  added: []
  patterns:
    - "Gated slices are data: noise.json (and the NoiseConfig default) list exact names and prefixes, so category:cross_lingual and pair: gate while other categories stay report-only"
    - "Pair slices are keyed question->evidence and built only from items that are cross_lingual with an evidence_language"
    - "Fixture items for one pair are numbered so the gated dev split holds both an identifier-bearing and a purely semantic question"

key-files:
  created:
    - eval/tests/test_cross_lingual.py
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/golden.py
    - rag-sidecar/src/rag_sidecar/contracts/report.py
    - rag-sidecar/src/rag_sidecar/contracts/baseline.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/schemas/GoldenItem.schema.json
    - rag-sidecar/schemas/DraftedItemBatch.schema.json
    - rag-sidecar/schemas/EvalReport.schema.json
    - rag-sidecar/schemas/JudgeReport.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - eval/src/rag_eval/metrics.py
    - eval/src/rag_eval/report.py
    - eval/src/rag_eval/gate.py
    - eval/src/rag_eval/paired.py
    - eval/src/rag_eval/baseline.py
    - eval/src/rag_eval/draft/writer.py
    - eval/config/noise.json
    - eval/fixtures/golden.jsonl
    - eval/fixtures/split-manifest.json
    - eval/baselines/fixture-baseline.json
    - tests/fixtures/characterization/chat.json
    - tests/fixtures/characterization/embed.json
    - tests/fixtures/characterization/voice.json

key-decisions:
  - "Gating is configured, not hard-coded: noise.json and the NoiseConfig default gain category:cross_lingual and pair:, so the contract default and the file stay identical"
  - "ItemResult carries evidence_language so the paired report can slice pairs; metrics.language_pair_key is the one place the key format lives"
  - "write_golden is unchanged: every golden line now carries evidence_language null (canonical output), accepted as a one-time 90-line diff because golden_sha256 changes anyway"
  - "Identifier-bearing questions are code-mixed (invoice or contract number plus the proper nouns in their original script) so the non-multilingual fixture embedder can score them; purely semantic questions stay uniformly zero under it"

patterns-established:
  - "Count-pinned tests are split by what they count (single-language 90, cross_lingual 24) rather than loosened"
  - "Characterization snapshots over every golden question are regenerated with UPDATE_CHARACTERIZATION=1 and the diff is checked to be additions only"

requirements-completed: [XLG-02]

coverage:
  - id: D1
    description: "The golden contract expresses a cross-lingual question: cross_lingual needs an evidence_language that differs from the question language; other categories allow null or the question language only"
    requirement: XLG-02
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_golden_contract.py#test_cross_lingual_item_without_evidence_language_fails"
        status: pass
      - kind: unit
        ref: "npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Reports carry by_language_pair keyed question->evidence, and the gate, baseline recorder and paired report treat the cross_lingual category and each pair like a language slice"
    requirement: XLG-02
    verification:
      - kind: unit
        ref: "eval/tests/test_cross_lingual.py (11 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "24 approved synthetic cross_lingual items, 4 per pair, quoted from documents that exist in one language only, with coverage checks"
    requirement: XLG-02
    verification:
      - kind: unit
        ref: "eval/tests/test_fixture_coverage.py, test_fixture_quotes.py, test_fixture_pii.py, test_cross_lingual.py#test_no_cross_lingual_gold_document_has_a_translated_twin_in_another_language_folder"
        status: pass
    human_judgment: false
  - id: D4
    description: "Legacy baseline re-recorded with the cross_lingual slice and pairs; corpus unchanged; every pre-existing item has paired difference zero"
    requirement: XLG-02
    verification:
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/xlg; jq -e '.passed == true' and '.paired.all_zero' on gate.json"
        status: pass
    human_judgment: false

duration: 14min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 11: cross_lingual golden category, pair slices and legacy baseline Summary

**cross_lingual golden category with evidence_language validation, by_language_pair reporting and gating for the six question->evidence pairs, 24 single-language-document fixture items, and a re-recorded legacy baseline whose 90 earlier items are unchanged**

## Performance

- **Duration:** 14 min
- **Started:** 2026-11-24T00:47:00Z
- **Completed:** 2026-11-24T01:01:30Z
- **Tasks:** 3
- **Files modified:** 24 (one created)

## Accomplishments

- Contract: `cross_lingual` joins Category after `typo`; `GoldenItem` and `DraftedItemProposal` gain `evidence_language`; the validator rejects a cross_lingual item with no evidence language or the question language, and an evidence language on any other category unless it equals the question language. Schemas, samples and Zod were regenerated with `npm run gen:schemas`; the CI drift diff is clean.
- Reporting and gating: `build_report` fills `by_language_pair` (dev split, like the other slices); `gate`, the baseline recorder and the paired report expose `pair:<q>-><e>` and `category:cross_lingual`; the noise config gates both, other categories stay report-only. The markdown report prints a "By language pair" table only when the mapping is non-empty.
- Fixture: 24 approved `synthetic_fixture` items, ids `xl-<question>-<evidence>-NN`. Evidence comes only from single-language documents (zh: scanned-contract, employee-handbook; en: scanned-invoice, shipping-handbook; it: scanned-receipt, warranty-terms). No corpus document was added, so the corpus hash is unchanged.
- Baseline: recorded three times under the pinned legacy eval env, deterministic (spread 0). The gate passes (7 skipped: `correct_refusal_rate` has no value on answerable-only slices) and the paired report is all zero.

## Task Commits

1. **Task 1: contract** - `2760b5e` (test, RED), `4f390e9` (feat)
2. **Task 2: report and gate pair slices** - `e3dffeb` (test, RED), `1c8f81f` (feat)
3. **Task 3: fixture items, coverage and baseline** - `b91eb1b` (test, RED), `216a612` (feat)
4. **Snapshot extension (deviation)** - `85082ba` (test)

**Plan metadata:** committed after this file (docs: complete plan)

## Evidence for the baseline (T-03-32)

- Corpus sha256 equal to the previous baseline's.
- All 90 pre-existing items compared against the previous baseline's per-item rows before the file was replaced: 324 metric cells, 0 differences.
- Slices of the old categories are unchanged. `overall` and `language:*` moved only because 24 new dev items joined their population (overall recall@5 0.508 -> 0.519).
- The old baseline stored `request_options` without `disabled_stages` and `stage_timeouts_ms` (model fields added in Phase 2, all null); the values are equivalent and the new file is serialised by the current model.

Per-pair recall under the fixture embedder (not multilingual, so only the identifier-bearing questions can hit):

| Pair (question->evidence) | All 4 items: recall@5 | MRR | Gated dev items: n | Dev recall@5 |
|---|---|---|---|---|
| en->zh | 0.500 | 0.375 | 2 | 0.500 |
| it->zh | 0.500 | 0.375 | 4 | 0.500 |
| zh->en | 0.500 | 0.500 | 3 | 0.667 |
| it->en | 0.500 | 0.500 | 3 | 0.667 |
| zh->it | 0.250 | 0.250 | 2 | 0.500 |
| en->it | 0.500 | 0.500 | 2 | 0.500 |

cross_lingual slice (dev, n=16): recall@5 0.562, MRR 0.531, false refusal 0.375.

## Files Created/Modified

See `key-files`. The three schema files plus `JudgeReport.schema.json`, `contracts.generated.ts`, `samples.json` and the baseline were produced by `npm run gen:schemas` and `npm run eval:baseline`, not edited by hand.

## Decisions Made

See `key-decisions`. In short: gating lives in the noise config (file and contract default), `evidence_language` is carried on `ItemResult`, and identifier-bearing questions are code-mixed so the fixture embedder can score them.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pair slices needed code outside the listed files**
- **Found during:** Task 2
- **Issue:** The plan lists only `report.py` and `gate.py`, but `by_language_pair` needs `metrics.score_items` and `aggregate`, the baseline recorder must record `pair:` slices (the baseline artifact must contain them), the paired report needs the slice members, and `ItemResult` needs `evidence_language`.
- **Fix:** Added `evidence_language` to `ItemResult`, the pair key and members to `metrics.py`, `pair:` loops to `gate._report_slices` and `baseline._slices`, and pair members to `paired._slice_members`.
- **Files modified:** eval/src/rag_eval/metrics.py, paired.py, baseline.py, rag-sidecar/src/rag_sidecar/contracts/report.py
- **Verification:** eval/tests/test_cross_lingual.py (11 tests)
- **Committed in:** 4f390e9, 1c8f81f

**2. [Rule 2 - Missing critical] Gating configured in noise.json and the NoiseConfig default**
- **Found during:** Task 2
- **Issue:** `is_gated_slice` reads `gated_slice_prefixes`, so pair and cross_lingual slices were not gated; the plan files did not list the config.
- **Fix:** Added `category:cross_lingual` and `pair:` to `eval/config/noise.json` and the `NoiseConfig` default; updated the two assertions that pinned the old list and the gating-note assertion in `test_report_runner.py` deliberately.
- **Files modified:** eval/config/noise.json, rag-sidecar/src/rag_sidecar/contracts/baseline.py, eval/tests/test_gate.py, rag-sidecar/tests/test_contract_models.py, eval/tests/test_report_runner.py, eval/src/rag_eval/report.py (GATING_NOTE)
- **Committed in:** 1c8f81f

**3. [Rule 1 - Bug] Draft writer dropped evidence_language**
- **Found during:** Task 1
- **Issue:** `write_drafted_items` built `GoldenItem` without `evidence_language`, so every cross_lingual draft would be rejected as invalid.
- **Fix:** Pass `proposal.evidence_language` through; test added in `eval/tests/test_draft_writer.py` (failed first on the missing field).
- **Committed in:** 4f390e9

**4. [Rule 3 - Blocking] Count-pinned tests and snapshots**
- **Found during:** Task 3 and the full vitest run
- **Issue:** `test_fixture_coverage.py` pinned 90 items, 30 per language and an id pattern; the chat, embed and voice characterization snapshots run every golden question.
- **Fix:** Split the pinned counts into single-language (90) and cross_lingual (24) tests, allowed the `xl-` id pattern, added cross_lingual: 8 per language to the cell table. Regenerated the three snapshots with `UPDATE_CHARACTERIZATION=1`; the diff is 743 insertions and 0 deletions, so every earlier entry is unchanged.
- **Files modified:** eval/tests/test_fixture_coverage.py, tests/fixtures/characterization/{chat,embed,voice}.json
- **Committed in:** b91eb1b, 216a612, 85082ba

**5. [Rule 2 - Missing critical] Dev-split mix per pair**
- **Found during:** Task 3
- **Issue:** Splits come from the id hash, so with the default numbering `en->zh` had only semantic items in the gated dev split and `zh->it` only identifier-bearing ones, making those slices uninformative.
- **Fix:** Numbered the facts of those two pairs differently and added a coverage test that each pair's dev split holds both kinds. This is a deliberate fixture design choice, not a tuned result.
- **Committed in:** 216a612

---

**Total deviations:** 5 auto-fixed (2 blocking, 2 missing critical, 1 bug)
**Impact on plan:** None changes the plan's outcome; all are needed for the contract, gate and baseline to work end to end.

## TDD Gate Compliance

RED/GREEN pairs exist for all three tasks (2760b5e->4f390e9, e3dffeb->1c8f81f, b91eb1b->216a612).

- **RED task 1:** 11 tests failed on `ValidationError` (unknown category / unknown field `evidence_language`) or `AttributeError` for the missing field, i.e. the planned behaviour was absent; messages are matched on distinctive phrases so an extra-field error cannot satisfy them. `gsd_run check tdd-red-evidence` does not support the pytest report format, so the semantic assessment is recorded here instead.
- **RED task 2:** 8 of 9 tests failed (missing `by_language_pair` content, no `pair:` slices, `KeyError` in the test's own baseline builder because the slice did not exist, no markdown table). One test (the negative control) passes by design.
- **RED task 3:** 7 tests failed because the golden set had no cross_lingual items. After the first refinement of the sharing check (compare the question with the evidence chunk, not just the quote) the tests were edited in the GREEN commit; they still fail on an empty golden set.

## Issues Encountered

- `tests/test_judge_offline.py` and `tests/test_online_judge.py` cannot be collected in this worktree (they import `deepeval`, an optional extra that is not installed), and two further eval tests fail for the same reason (`test_draft_cli.py::test_pinned_synthesizer_forces_style_and_length`, `test_judge_config.py::test_importing_deepeval_after_the_opt_out_does_not_load_dotenv_files`). They fail identically before this plan's changes. The orchestrator should run the full eval pytest with `--all-extras`.
- A first design of the identifier-bearing items (shared digits only) produced a uniformly zero cross_lingual slice because same-language distractors outrank the evidence. They were rewritten to quote invoice, contract and receipt identifiers plus proper nouns in the evidence language.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None.

## Threat Flags

None. The items are synthetic (example.net addresses, invented company names); `test_fixture_pii.py` passes. T-03-32 is mitigated by the zero-difference check recorded above; T-03-33 by the PII scan.

## Next Phase Readiness

- Plan 03-45/03-46 can compare embedding profiles per pair against this legacy baseline (`pair:*` and `category:cross_lingual` are gated).
- The identifier-bearing items are the only ones the fixture embedder can hit; the real multilingual ranking decision stays the live verification run.

## Self-Check: PASSED

- Created and modified files exist (`eval/tests/test_cross_lingual.py`, `eval/fixtures/golden.jsonl`, `eval/baselines/fixture-baseline.json`).
- Commits `2760b5e`, `4f390e9`, `e3dffeb`, `1c8f81f`, `b91eb1b`, `216a612`, `85082ba` are ancestors of HEAD.
- Acceptance: `grep -c "cross_lingual" golden.py` = 5; `grep -c "evidence_language" contracts.generated.ts` = 3; `grep -c "by_language_pair" report.py` = 2; `eval/tests/test_cross_lingual.py` 11 passed; `grep -c '"category": "cross_lingual"' golden.jsonl` = 24; baseline `.slices | has("category:cross_lingual")` true.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
