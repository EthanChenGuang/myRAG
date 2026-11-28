---
slug: phase42-scanned-slice-regression
status: diagnosed
date: 2026-11-28
branch: exec/debug-42-scanned
base: origin/ci/merge-train-39 (3f4f5e71)
mode: diagnosis only (no product, fixture, golden or gate-spec change)
classification: "trigger = fixture growth (05.2.1-12); underlying cause = (b) two latent retrieval limits, unmasked; plus a (c) proposal for the owner"
related:
  - .planning/quick/261127-q42-phase42-verify-fixes/261127-q42-SUMMARY.md (exec/quick-42-fixes c50e5550, first report)
  - eval/config/phase42-gates.json (D-37 pre-registered, unchanged)
  - eval/reports/phase-04.2/gates.json (committed PASS, 152d29f61)
---

# Phase 4.2 gate FAIL on `category:scanned` (merge-train-39)

## Symptom (reproduced)

`uv run --directory eval python -m rag_eval.phase42_gate --spec eval/config/phase42-gates.json` on `ci/merge-train-39` (3f4f5e71):
FAIL. The `diversity` gate fails on `v2-diversity-mmr` and the `identifier` gate on `v2-identifier-on`. Both offenders are the same:
`category:scanned:recall_at_10` 0.7500 < 0.9800 (`v2-default` 1.0000) and `category:scanned:mrr` 0.7500 < 0.7657 (`v2-default` 0.7857).
`descriptive_items` 159 → 196. The descriptive metrics themselves do not drop (on = reference: R@5 0.7088, R@10 0.7206, MRR 0.6251).
off_identity, table, versions and dictionary pass; stem_it is keep_off and refusal_mode_cells is keep, as committed.

## 1. Which commits

- **The scanned slice is not new.** `{en,it,zh}-scanned-00{1,2}` came in with 01-15 (`fb17b7146`, 2026-11-23). Their documents
  (`scanned-invoice.en.md` and the others) came in with 01-07 (`ed6504c84`). The items were in the gated population when the committed
  4.2 report was made (`152d29f61`). The gated (dev) slice is 4 items: `en-scanned-001/002` and `zh-scanned-001/002`.
  The slice did not show in the 4.2 report because `en-scanned-001` missed in the reference *and* in the switch runs, so there was
  no paired drop (details below). The quick-42-fixes note "the slice came after 4.2" is therefore inaccurate. What came after 4.2 is
  the corpus change that moved the reference.
- **What changed between the passing report and train-39** (golden, corpus, eval/config): only the 05.2.1-12 fixtures.
  - `bb46c5082` adds `calc-rules.{en,it,zh}.md` and `long-reference.{en,it,zh}.md` to `eval/fixtures/corpus/`.
  - `9c476705d`, `f4e9b3791` and `c9f7316fc` add 57 golden items (manifest and split too), merged via `f65f8514a` into ci/merge-train-38.
    By split: `multi_step_calc` 28 dev / 17 test, `context_overflow` 9 dev / 3 test.
  - No existing golden item changed. The golden file minus those two categories is byte-identical to the one at `152d29f61`.
  - The changes under eval/config are new run configs and env pins for other phases; `v2-default.json` and the gate spec are unchanged.
- **Descriptive 159 → 196:** +37 = exactly the 28 + 9 new *dev* items. None of them asks an identifier, so all are descriptive.
  This growth is expected and harmless (on = reference on all three metrics).

## 2. Per-item measurement (04.1-14 method: harness runs joined by item id with the traces)

Three runs of the same gate, scratch only (`/tmp`, not committed):
- **base:** worktree at `152d29f61` (the passing report).
- **train-39:** `3f4f5e71`.
- **train-39 − 05.2.1-12 fixtures:** `3f4f5e71` with the six new corpus files and 57 items removed, and the base manifests restored.

Gated scanned items: `en-scanned-002`, `zh-scanned-001` and `zh-scanned-002` are rank 1 in every run, every config.
The only item that moves is **`en-scanned-001`**: "What is the total due on invoice INV-24-00381?", gold = `scanned-invoice.en.md` §Totals.

| Run (context_k 8) | base | train-39 − new fixtures | train-39 |
| --- | --- | --- | --- |
| v2-default (reference) | miss | miss | **rank 7** |
| v2-diversity-collapse | miss | miss | rank 7 |
| v2-diversity-mmr | rank 8 | rank 8 | **miss** |
| v2-identifier-on | miss | miss | miss |
| reference search legs (dense / lexical), fused candidates | 75 / 31, 87 | 75 / 31, 87 | 75 / 67, 123 |
| gate verdict (diversity, identifier) | PASS | PASS | FAIL |

Slice values follow from this one item (n = 4, one item = 0.25).
- base reference: R@10 0.75. MMR: 1.00 (a gain, not gated). Identifier: 0.75 (equal, no drop).
- train-39 reference: R@10 1.00. MMR and identifier: 0.75 → a drop of 0.25 against a floor of 0.02.

What the traces show:
- **Train-39 code with the base fixtures reproduces base exactly** (same per-item ranks and leg counts, PASS). No retrieval code change
  on the train moves this item. The trigger is the corpus.
- **Why the reference moved.** The new fixtures contain the token `24` 94 times. The query's identifier `INV-24-00381` also yields `24`
  as a lexical token. The reference's lexical leg grows from 31 to 67 hits and the fused pool from 87 to 123 (rerank input capped at 75).
  `RAG_RERANKER=auto` without a Cohere key is `local_bm25`, which computes df and avgdl over the candidate pool
  (`src/lib/rag/rerank/local-bm25.ts` `bm25Scores`). The pool changes, the IDF of `24` falls, and the three `dup-passage-24.*` chunks
  (base ranks 5–7) fall out of the context. The invoice's §Totals and §Payment terms chunks move up to ranks 7 and 8.
- **`v2-identifier-on`: the same miss in every run.** `INV-24-00381` resolves (asked 1, resolved 1, no fallback). D-31 puts
  `c.identifiers_norm && p_ids` on every leg before ranking (`0856_hybrid_search_42.sql`), so search returns only the invoice header
  chunk (dense 1, lexical 1, context 1). The §Totals chunk holds the answer but not the identifier, so it can never be retrieved.
- **`v2-diversity-mmr`: a marginal hit lost.** At base the gold was the last of 8 context slots. On train-39 MMR demotes the third and
  fourth invoice chunks as same-document redundancy, and lower-relevance chunks from other documents (`instrument-catalog.it`,
  `p52-answers.it`, `refund-policy.it`) take the slots.

## 3. Verdict

| Option | Verdict | Why |
| --- | --- | --- |
| (a) item or fixture broken | **no** | The gold quote exists (§Totals, "Tota1 due 1449.36"), and the reference retrieves it on train-39. The 37 new descriptive items are well-formed and on = reference. Nothing to fix in items or fixtures. |
| (b) real retrieval regression | **no regression; two latent limits unmasked** | Train-39 code with the base corpus = base. The switch runs did not get worse (identifier unchanged; MMR lost a rank-8 hit because the pool changed). The reference got better on this item. What the gate now sees is real: (1) under D-31 the identifier filter drops same-document evidence that lacks the identifier; (2) MMR's hit was at the cutoff and depends on the pool. |
| (c) spec should treat the slice differently | **proposal only (owner)** | The spec gates every category slice (`drop_offenders` → `phase_compare.slice_drops`) with floor 0.02 and no minimum n. On a 4-item slice one item flip always fails. |

**Conclusion.** This is not a train-39 retrieval regression. 05.2.1-12's fixtures changed the shared fixture corpus. Through the
pool-relative `local_bm25` reranker that moved one marginal item in the *reference* run. That exposed limit (b1) of the identifier filter
and the pool sensitivity of MMR (b2). The gate verdict is honest for the current corpus. Do not tune it into a PASS.

## 4. Recommended fixes (nothing applied here; D-37 spec, thresholds and metrics untouched)

1. **(b1) Identifier filter scope (main item). Owner: a new Phase 4.2 gap plan, because it amends locked decision D-31.**
   Proposal: when the asked identifiers resolve, the filter should keep the *documents* that carry them, not only the chunks:
   `c.document_id IN (documents with a chunk where identifiers_norm && p_ids)`, still inside the verified tenant. The near-miss guard
   (D-51) stays chunk-level.
   - The predicate must change in `hybrid_search_chunks` (0856) and, with the same body, in `rag_bm25_search_chunks` (0904 parity rule,
     `tests/rag-db/bm25-filter-parity.test.mts`).
   - It needs a 4.2 migration number from 0865 up (check every origin branch first).
   - It needs a failing-first test: an identifier-anchored question whose evidence chunk lacks the identifier.
   - The fixture gate then has to show `en-scanned-001` retrieved under `v2-identifier-on`, with precision 1.0 and leakage 0 unchanged.
2. **(b2) MMR sensitivity. Same 4.2 gap plan, or Phase 7 regression 07-25 if the owner prefers.** Re-run
   `python -m rag_eval.sweep diversity` on the current fixture corpus. Only that tool writes `mmr_lambda`. If the sweep keeps the
   current lambda, record that the hit was marginal at context_k 8.
3. **(c) Proposal for the owner, not applied.** Possible spec changes, each a D-37 decision:
   - (i) A minimum n for the no-slice-drop check of the phase gates, as `regression.py` already has (`min_gate_n`). Slices below it are
     reported, not gated.
   - (ii) Or judge a small slice by paired item flips instead of the mean.
   - (iii) Process: a plan that adds shared fixture documents re-runs `rag_eval.phase42_gate` and the other phase fixture gates in its
     own gates. 05.2.1-12 did not, which is why the shift surfaced later on the train.
   - Without a decision, the spec stays as it is and the gate stays FAIL until (b1) lands.
4. **Report.** The committed `eval/reports/phase-04.2/` (PASS) belongs to the pre-05.2.1-12 corpus. Re-render it with the same spec
   after (b1)/(b2), or after the owner's (c) decision. Do not re-render it now: that would commit a FAIL report with no fix behind it.

## Gates run

- `rag_eval.phase42_gate`, full spec, on train-39 (FAIL, reproduces the symptom).
- `--only diversity --only identifier` at `152d29f61` (PASS) and on train-39 without the 05.2.1-12 fixtures (PASS). Scratch outputs, not committed.
- No item, fixture or code was changed, so the item-change gates (eval pytest `--all-extras`, `test-rag` default and ingest) did not apply and were not run.
- `npm ci --ignore-scripts --onnxruntime-node-install-cuda=skip` and `uv sync --locked --all-extras` in eval/, from the lockfiles.

## Operator / coordinator actions

- Create the 4.2 gap plan for (b1)/(b2). Owner decision on D-31's amendment.
- Owner decision on the (c) proposal.
- Correct the quick-42-fixes coordinator note: the slice is not new; the reference shifted with the 05.2.1-12 corpus.
