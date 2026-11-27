# test-rag false refusals on origin/main: root cause and options

Status: **stopped for an owner decision** (H-10, Phase 5.3 plan 05.3-50). No code, threshold, gate or gold label was changed.

## Reproduction

- Tree: `origin/main` at `7651adbc` (merge train 34).
- Command: `npm run test-rag` (= `tsx eval/harness/run-smoke.mts`, fixture mode `prechunked`, single-tenant, `RAG_PIPELINE` unset, so legacy; strict; gates `eval/config/quality-gates.json` in the default `enforce` mode). No `.env.local` and no vendor keys are needed: fixture embedder and fake generator.
- Result: exit 11, `absolute gate: FAIL`, `false_refusal_rate language:en: measured 0.3143 vs max 0.2500`. Overall is 0.2462 (n 199) and passes; it 0.1765, zh 0.2459.
- Every category slice matches `eval/baselines/fixture-baseline.json` exactly (delta +0.0000): the run is the committed baseline.
- CI does not fail. `pr-smoke.yml` runs this tier with `--gates-mode report` (O-1, 05.3-13/15/16), so the ceiling is report-only there. Executors see exit 11 only because the local default is `enforce`.

## Bisect: it never crossed 0.25, it has been above since the start and is falling

The fixture runs are deterministic (spread 0.0 over 3 runs), so each committed baseline records the rate at its commit. False-refusal rate per baseline re-record on main (prechunked, legacy):

| Baseline commit | Overall (n) | en (n) | it | zh |
| --- | --- | --- | --- | --- |
| 2943b976 (train 3) | 0.3953 (86) | 0.4516 (31) | 0.3462 | 0.3793 |
| 3a9d021c (05.1-17) | 0.3542 (96) | 0.4000 (35) | 0.3103 | 0.3438 |
| b7c1e708 (06-38) | 0.3750 (112) | 0.4146 (41) | 0.3429 | 0.3611 |
| 98e6f236 (06-39) | 0.3636 (132) | 0.4167 (48) | 0.3095 | 0.3571 |
| 7e89fbbd (04.2-37) | 0.3161 (155) | 0.3818 (55) | 0.2549 | 0.3061 |
| 3f692371 (train 30) | 0.2952 (166) | 0.3559 (59) | 0.2321 | 0.2941 |
| 5f8c2830 (train 31) | 0.2832 (173) | 0.3607 (61) | 0.2034 | 0.2830 |
| c059129a (train 32) | 0.2832 (173) | 0.3607 (61) | 0.2034 | 0.2830 |
| 9fb4f2b1 (train 33, = main) | 0.2462 (199) | 0.3143 (70) | 0.1765 | 0.2459 |

- The 0.283 the executors quoted is the overall rate at trains 31–32; 0.3143 is en from train 33 on.
- No existing item flipped from answered to refused, with one exception (train 31, below). Every other change comes from new items, and new items lowered the rate.
- Train 31 flips: `en-selective-filter-001`, `en-selective-filter-002` went 0 → 1 and `xl-it-en-04` went 1 → 0. Cause: 05.3-15 made the smoke tier answer-aware (the fake generator's refusal now counts). No retrieval change.
- Phase 5.3 recorded this before the gate shipped: research F-1 (legacy prechunked 0.3953, "a second, separate violation that answer-aware scoring does not fix"), `eval/reports/phase-05.3/absolute-gate-measurement.md` (smoke 0.32, would-be exit 11, mode `report`), 05.3-15 SUMMARY ("making it gating is the owner's decision (H-10) or a retrieval change outside this plan").

## Root cause

22 en answerable items are refused. Two mechanisms:

1. **Legacy keep floor against the fixture embedder (20 of 22).** Legacy `filterCandidates` keeps a chunk only when `similarity > 0.65` (`LEGACY_KEEP_FLOORS.text`, `src/lib/rag/context/relevance.ts`) or when a query word longer than 3 characters appears literally in the file name or chunk text. The fixture embedder (hashed n-grams, Phase 4 F-9) scores the right chunk at 0.15–0.40 for these items; in a v2-all-off run their top similarities are 0.153–0.396. Every item that has no literal word overlap (colloquial, paraphrase, multi-turn, typo, compound, table) loses all candidates, and `refusal_reason` is `no_relevant_context`. The eval-only floor `RAG_EVAL_RETRIEVAL_MIN_SIMILARITY=-1` changes nothing (overall still 0.2462), because it lowers only the RPC threshold, not the 0.65 keep rule. Tiers whose similarities are on another scale do pass:
   - ingest mode (`--fixture-mode ingest`): PASS, overall 0.146, en 0.163
   - `v2-all-off` (no similarity floor): overall 0.020, en 0.029, correct refusal still 1.000
   - `v2-default`, whose similarity floor falls back to the legacy 0.65 without calibration: identical to legacy, en 0.3143
2. **Image-caption evidence never reaches the text context (2 of 22; 4 in v2-all-off).** `en-selective-filter-001..004` have their gold evidence only in the caption chunk of `warehouse-floorplan.png`. Retrieval keeps the chunk (`kept_by: name`), but `buildContext` skips image documents (`if (isImageDoc) continue;`, `src/lib/rag/context/assemble.ts`). The image goes to `source_images` by design ("images displayed above AI text, not cited"), the context block is empty and the generator answers "The provided documents do not contain this information." These items were written as retrieval-filter tests (Phase 4 D-06 lossless selective filtering) before answer-aware scoring existed.

Without mechanism 2, en is still 20/70 = 0.286 > 0.25. Mechanism 1 decides the gate.

## Why this is an owner decision and not a fix

- The 0.65 rule is shipped production behaviour. AGENTS.md requires the explicit-legacy smoke tiers to match the committed baselines exactly, and Phase 4.1 D-16 keeps the legacy baselines. Any change to the legacy keep rule changes production strict-mode refusals and breaks that invariant on purpose.
- Lowering the floor for eval only (a fixture-only keep floor) would make the legacy tier stop measuring the shipped legacy rule. That is the same as loosening the gate. Changing `quality-gates.json` or relabelling the items is also out of scope. The items are answerable: their evidence is in the corpus and v2-all-off answers 18 of the 22.
- Whether real-embedding legacy refuses this much is unknown. The `nightly-live` tier is `not_measured_no_keys`, so no live false-refusal number exists for any configuration.

## Options

A. **Ratify report-only for the prechunked legacy tiers (status quo, H-10 = stay report-only).** Change the local default so `npm run test-rag` uses the same mode the measurement records for the tier, or document `--gates-mode report`. Executors then stop seeing an unowned exit 11. The core promise stays unmeasured in that tier. Cost: small.

B. **Gate the tiers that measure on a meaningful scale (H-10 = ingest tiers gating, prechunked report-only).** The ingest tiers already pass in `enforce` (en 0.163). Make the release decision rest on them plus `nightly-live` once keys exist. Cost: CI wiring only.

C. **Measure legacy on real embeddings first.** Run `nightly-live` (eval project `fsgaeysipkukqoocgzbx`, proxy-injected OpenAI) to see whether the 0.65 keep floor also refuses paraphrased and colloquial questions with `text-embedding-3-small`. If it does, the product promise is broken in production legacy strict mode, and the fix is a product change: flip the default to v2 with a calibrated refusal threshold (`python -m rag_eval.calibrate refusal` on real items, EVAL-14 ship check), never a hand-set floor. Cost: one live run (needs keys and a seeded eval corpus), then a Phase 4.1-style default-flip decision.

D. **Image-caption context (independent of A–C).** Decide whether caption text of an image document should enter the text context (it is retrieved already). If yes, it needs its own switch (off = today, per the "every component has a switch" constraint) and a citation rule for image blocks. If no, the four `selective_filter` items need their evidence in a text document, or a no-answer-aware label, with evidence recorded by the golden-set tooling.

Recommendation: A now, so the local run stops failing on a known, recorded condition, then C. C is the only option that says whether the product promise holds in production. Decide D separately.

## Verification done

- `npm run test-rag` on main: exit 11, en 0.3143, overall 0.2462, all slices equal to the baseline.
- `RAG_EVAL_RETRIEVAL_MIN_SIMILARITY=-1 npm run test-rag -- --no-gate`: unchanged (the RPC floor is not the cause).
- `npm run test-rag -- --fixture-mode ingest`: exit 0, absolute gate PASS, overall 0.146.
- `--run-config eval/config/runs/v2-all-off.json --no-gate`: overall 0.020, en 0.029, correct refusal 1.000.
- `--run-config eval/config/runs/v2-default.json --no-gate`: identical to legacy (en 0.3143).
- No Supabase or Vercel project was touched. Every run is in process (PGlite, fixture embedder, fake generator).
