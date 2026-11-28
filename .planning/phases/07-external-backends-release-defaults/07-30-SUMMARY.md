---
phase: 07-external-backends-release-defaults
plan: 30
subsystem: ci
status: complete
tags: [release-defaults, d-18, adm-02, pr-smoke]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-17 DefaultsDecision; 07-18 manifest default; 07-20 generated Config UI; 07-21 pr-smoke; 07-25 provisional record; 07-43 cost/latency/per-language contracts (record left unannotated, orchestrator decision b)"
  - phase: 04.1-hybrid-retrieval-and-rerank-on-by-default-proven-by-eval
    provides: "04.1-09 eval/decisions/04.1-retrieval-defaults.json (status not_flipped)"
provides:
  - "scripts/check-release-defaults.mjs: checkReleaseDefaults, readShippedDefaults, parseInitEnv; exit 0 pass, 1 mismatch, 2 malformed record"
  - "pr-smoke ts job: the check in Config drift check, its node tests in the config self-test step"
affects: [07-33]

actuals:
  tokens: 45000
  tasks: 2
  commits: 4

key-files:
  created:
    - scripts/check-release-defaults.mjs
    - scripts/tests/check-release-defaults.node-test.mjs
  modified:
    - .github/workflows/pr-smoke.yml

requirements-completed: []
requirements-partial: [ADM-02]
---

# Phase 7 Plan 30: Shipped defaults follow the decision record (D-18)

`node scripts/check-release-defaults.mjs` now proves that the shipped defaults equal the latest defaults decision. pr-smoke runs it on every pull request.

How it picks the expected value:
- **Provisional record:** the record's `incumbent` map. The five DFLT names (`RAG_PIPELINE`, `RAG_LEXICAL_SEARCH`, `RAG_RERANKER`, `RAG_REFUSAL_THRESHOLD`, `RAG_REFUSAL_FLOOR`) instead take the Phase 4.1 decision's `defaults` map when that decision is `flip`, and their Phase 4 values when it is `not_flipped` (see deviation 2).
- **Non-provisional record:** the record's `defaults` map.

It compares every name in the expected map in each D-18 location:
- the `scripts/init-env.js` template;
- the `src/lib/env.ts` fallback literal;
- each of the three `scripts/config-server.js` templates (`create`, `standard`, `full`), each reported separately;
- the manifest `default`;
- the eval pin `eval/config/rag-eval-env.json`;
- for `RAG_PIPELINE`, also `DEFAULT_PIPELINE` in `src/lib/rag/config.ts`.

Under 04.1 D-25, names in `implicit_in_templates` of a flipped 04.1 decision must be empty in the templates, the manifest and the pin. Only `env.ts` and `DEFAULT_PIPELINE` carry their value.

It exits 2 on a malformed record:
- the record or the 04.1 decision is missing or malformed;
- a map names a secret-typed manifest variable;
- a provisional record without `eval/decisions/defaults-fixtures.md`;
- a non-provisional record without `eval/decisions/defaults-<decided_at date>.md`;
- `incumbent_source` is not the 04.1 decision, or the incumbent differs from it for a DFLT name;
- a missing or partial ADM-02 block (`missing: cost`, `missing: cost.per_1000_documents`, and so on);
- a null cost amount without its reason code, or a `below_baseline: null` language without its reason;
- a non-provisional record that adopts a challenger while an enabled language is below its baseline.

Output is sorted and holds names and default values only.

## First run on the committed record (Task 2)

```
$ node scripts/check-release-defaults.mjs
[check-release-defaults] note: provisional record carries no cost, latency, per_language block; the live decide (plan 07-33) writes them
[check-release-defaults] ok: 19 default(s) match the decision record
```

No default was restored and the record was not edited.

## Commits

| Task | Commit |
| --- | --- |
| 1 RED: 20 node tests against a stub (17 failed on assertions) | b42ee1c0 |
| 1 GREEN: the check | 05bdde4e |
| 2 pr-smoke step and node test entry | c12ac6c3 |
| SUMMARY | this commit |

Mutation guard from the plan: comparing against `record.defaults` even when the record is provisional fails two tests ("a provisional record never moves a default" and "the repository passes on its committed record", because the fixture record adopts `RAG_INJECTION_CHECK=drop`).

## Deviations

1. **A provisional record without the ADM-02 blocks passes with a notice.** The plan says exit 2 "provisional or not". The committed fixture record has no `cost`, `latency` or `per_language` block, because 07-43 is partial. The orchestrator chose (b): the blocks are written only by the live decide of 07-33. The `DefaultsDecision` schema also makes them optional. So, for a provisional record:
   - all three blocks absent prints a notice and passes;
   - only some of them absent still exits 2;
   - malformed blocks still exit 2.

   A non-provisional record needs all three. The core D-18 check does not depend on the blocks, so the plan did not need to stop.
2. **The 04.1 decision is `not_flipped`, but the plan assumed a flip.** 04.1-09 closed without a flip (owner, 2026-11-26), and `RAG_PIPELINE=legacy` with all-off sub-switches is still the shipped default. Taking the 04.1 `defaults` map as expected would have failed on the first run and pushed a flip that the owner declined. So:
   - The 04.1 `defaults` map, and `implicit_in_templates`, apply only when `status` is `flip`. This is the rule `scripts/check-config.mjs` already uses.
   - While the decision is `not_flipped`, the five names expect the Phase 4 values: `legacy`, `false`, `none`, `false`, `similarity` (`PHASE4_RETRIEVAL_DEFAULTS` in the script).
   - Tests cover both statuses.
3. **Parser agreement is tested against the committed eval pin.** The plan asked for a test that both init-env parsers agree on the real file. Plain `node --test` cannot import `eval-env.mts`, so the test compares against the committed eval pin instead. That pin is `derivePinnedEvalEnv`'s output, which CI checks with `eval-env.mts --check`. The test covers every `RAG_` name except the two language overrides.
4. **`DEFAULT_PIPELINE` is always compared for `RAG_PIPELINE`**, not only for implicit names.

## Gates run

- `node --test scripts/tests/check-release-defaults.node-test.mjs`: 20 passed, 0 failed.
- `node scripts/check-release-defaults.mjs`: exit 0 (output above).
- `node --test scripts/check-config.test.mjs`: 91 passed.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`: all exit 0.
- `uv run --all-extras --frozen --directory eval python ../scripts/ci/check-workflows.py`: OK.
- Not run, because no TS module under src, no SQL, contract, Python, retrieval or UI code changed: vitest, rag-db, pytest, `gen:schemas`, `test-rag`.
- Test-split uses: 0. The ledger is unchanged at 26.

## Deferred

- **The 07-25 record's incumbent does not match the shipped defaults for the five DFLT names.** It copies the 04.1 candidate `defaults` map (v2, lexical on, reranker auto, refusal threshold on, floor `legacy_rule`), not the shipped Phase 4 values. Because the 04.1 decision is `not_flipped`, the stage-B `b.incumbent` arm measured the 04.1 candidate, not what ships today.
  - 07-43's rule "the incumbent must be the Phase 4.1 decision" encodes the same assumption.
  - This check accepts it, because it checks provenance against the 04.1 file, but it compares the shipped values with the Phase 4 values.
  - The live decide of 07-33 should decide which incumbent it measures. If it adopts the 04.1 candidate values, that is a flip of the five names, and this check will then require every location to follow.

## Decisions for STATE

- D-18 (07-30): pr-smoke fails any pull request whose shipped defaults differ from the decision record. A provisional record is compared only through its incumbent, with the five DFLT names taken from the 04.1 decision when it is `flip` and from Phase 4 when it is `not_flipped`.
- ADM-02 (07-30): a non-provisional record must carry the cost, latency and per-language blocks. A provisional record without any of them passes with a notice (orchestrator decision b, 07-43).

## Operator actions

None.
