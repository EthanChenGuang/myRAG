---
quick_id: 261128-mkr
branch: exec/quick-5221-mustkeep
base: origin/exec/05.2.1-23 (0869ad9c)
status: complete
follows: 05.2.1-23 (Deferred: must_keep failures of both budget-overflow gates)
owner_decision: "1a, 2026-11-28 07:09Z, owner approved in person: change the golden items, not the packing"
---

# Summary: the context_overflow must_keep sets match the fixture ranking under the 4,096-token window

After 05.2.1-23, both budget-overflow gates failed on `must_keep_rate` only. The owner chose option 1a: change plan 12's golden items and leave the packing code alone, because D-88's behaviour of keeping the top-ranked parents is correct. Nine items changed. Both gates now pass in all three languages. The negative control still fails as designed. No thresholds, gate rules or code changed.

## Commits
| Step | Commit |
|---|---|
| Golden items, `golden_set bump` (fixture 6 → 7, fixture-ingest 8 → 9) | `00a720a2` |
| Pinned tests follow the bump; language-confidence calibration re-run by its tool | `369e728c` |
| Baselines (prechunked, ingest, voice) and characterizations re-recorded | `14700563` |
| Decision record in 05.2.1-CONTEXT.md, this SUMMARY | this commit |

## Why the items failed
- **Legacy (9 items):** with the old questions the best fixture-embedder similarity against the long-reference parents was 0.15 to 0.26. The analyser's tier (0.45) and the 0.28 fallback both returned nothing, so legacy refused these 9 items before any packing. The `-004` items passed because their wording echoes the row text (similarity 0.31 to 0.36).
- **v2:** the must-keep parents of `it-002` (ranks 3 and 4) and `it-003` (rank 2) were ranked below parents that fill the budget.
- **Two-span `-002` items:** two parents of 865 to 1,150 raw tokens each cannot both fit the 1,785-token packing budget once framing is counted (quick 261127-pbr). So `must_keep_rate` 1 was out of reach in any pipeline.

## What changed (choice: the items, not the fake window)
The fake window alone could not fix the legacy refusals, which happen in retrieval before any budget is applied. Editing the items was therefore the smaller change.
- **All nine `-001` to `-003` items** in en, zh and it: the question names the phase's marker, for example "How many rounds does phase 6 of the Varnel sequence, opened by the marker Galmor, hold?". The must-keep parent now ranks first, with similarity 0.32 to 0.43 and a margin of at least 0.078 over rank 2. I checked each wording with a scratch probe that uses the fixture embedder and corpus chunker, and its numbers match the run traces.
- **The three `-002` items** ask two facts about one phase (rounds and slots), where they used to ask about two phases. `gold_evidence` and `must_keep` are that one span, so plan 12's rule `must_keep == gold_evidence` still holds. `expected_answer` follows; the other six expected answers are unchanged.
- The `-004` items, the corpus, the other categories, the split manifest (ids only) and `calc-fake-scripts.json` are untouched.

## Results (fixture)
| Run config | Exit | Gate | Notes |
|---|---|---|---|
| calc-tool-follow | 0 | PASS | paired all_zero |
| calc-block-follow | 0 | PASS | paired all_zero |
| calc-skip-rule-check-off | 10 | FAIL as designed | `negative_control_failed` on numeric_correctness_effective; no `negative_control_passed`; the pr-smoke jq check holds |
| calc-skip-rule-check-on | 0 | PASS | paired all_zero |
| calc-missing-operand | 0 | PASS | paired all_zero |
| budget-overflow-legacy | 0 | **PASS** | overflow_error 0, history_before_documents 1, **must_keep 1**, budget_trace 1 in zh, en, it; paired all_zero |
| budget-overflow-v2 | 0 | **PASS** | same four rates in zh, en, it; paired differs from the legacy baseline by design, as in 05.2.1-20 and 05.2.1-23 |

Before: legacy must_keep was 0.25 in every language; v2 was zh 0.75, en 0.75, it 0.5.

## Baseline differences (only the edited items)
- **Prechunked:** all nine items move from refused (mrr 0, false_refusal 1) to mrr 1 and recall 1.
- **Ingest:** en-002 and en-003 move from refused to 1. it-002 recall goes from 0.5 to 1, and zh-002 recall@5 from 0.5 to 1.
- **Voice:** en-003 mrr goes from 0.25 to 1, it-002 from 0.33 to 1 and it-003 from 0.5 to 1; zh-002 recall goes from 0.5 to 1.
- Every other item is identical in all three baselines. The slices that move are the ones holding these items: `category:context_overflow`, `language:en`, `language:it` and `overall`.
- The tier-1 report-mode absolute check `false_refusal_rate language:en` is pre-existing. It improves from 0.3133 to 0.2771, still above 0.25 and still report-only.
- **Characterizations:** every changed entry in the 7 files is one of the nine edited queries (checked by script).
- **Language-confidence calibration:** re-run by its tool (the base commit passed `--check`). One reworded question moves length bucket, so two bins shift by one query: n 92 → 91, value 0.9894 → 0.9892; and n 223 → 224, value unchanged.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`, `check-zod-isolation`: exit 0
- `golden_set verify`, fixture v7 and fixture-ingest v9: ok. `calibrate-language-confidence.mts --check`: up to date.
- Eval pytest `-q --ignore=tests/test_parse_fixtures.py`: 2,796 passed. Before the test updates there were 5 failures, all fixture pins: test_fixture_calc_overflow ×3 (from the first draft, where the `-002` must_keep was narrower than gold_evidence, a draft I dropped), test_golden_set version pin, and the test_metrics two-span case.
- vitest: 21 files that read the golden set, baselines or calibration, 310 passed. `tests/rag/characterize-*.test.ts`: 28 passed, 7 skipped. `tests/rag/lang-confidence.test.ts` failed before the calibration re-run.
- `node --import tsx --test tests/rag-assemble-differential.test.mts`: 3 passed
- `npm run test-rag -- --out eval/out/quick-5221-mustkeep`: exit 0, gate PASS, `paired.all_zero` true
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-5221-mustkeep-ingest`: exit 0, gate PASS, `paired.all_zero` true, absolute PASS (enforce)
- The seven 05.2.1-23 run configs: see the table above.
- Not run: rag-db SQL suites (no SQL or RPC change; CI shards cover the eval overlays) and UI checks (no UI change).

## Deviations
- **Test updates:** `eval/tests/test_golden_set.py` (version 7 and 9, last changelog entry = these nine) and `eval/tests/test_metrics.py` (the missing-one-of-two-spans case now builds its two-span item itself, because no fixture item has two spans any more, and it also checks that keeping both spans passes). Both follow from the golden change. The metric logic is unchanged.
- **The language-confidence calibration** and the characterization snapshots were regenerated. They pin golden content, so they had to change. Only their tools wrote them.

## Deferred
- `eval/config/fixture-score-calibration.json` records `golden_sha256` 0f20…, which was already stale before this task: it matched neither the old golden nor the new one. Its loader does not check the hash, and only `rag_eval.calibrate refusal` may write the file, so it is left for the next calibration run.

## Operator actions
None. No live call, no migration, no Supabase or Vercel change.
