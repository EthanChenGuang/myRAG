---
status: diagnosed
trigger: "Plan 04-40 (Phase 4 comparison) fails rule (b): correct refusal v2-recommended 0.333 vs legacy 0.667 (v2-all-off 0.333); MRR drops vs v2-all-off on category:typo (1.0->0.833) and category:scanned (0.8333->0.8125, threshold 0.8133). Investigate only, no fix."
created: 2026-11-25
updated: 2026-11-25
mode: find_root_cause_only
note: "Session file kept in scratchpad because the worktree /home/user/wt/04-40 is read-only for this task."
---

## Current Focus
hypothesis: rule (b) fails because of how it is measured on the fixture, not because production refusal or ranking logic regressed
bug_class: Bohrbug (deterministic fixture runs; replay reproduces every decision)
reasoning_checkpoint:
  hypothesis: "Refusal: legacy's 0.667 is the operating point of LEGACY_FALLBACK_THRESHOLD 0.28 on the fixture-embedder scale (FRR 0.395); v2 sits at the fixture-fitted floor 0.1159 (FRR 0.047) on the same dense score, and the fake reranker adds no separating signal, so no calibration that follows the protocol beats 7/21 at FRR <= 0.05. MRR: one item per tiny slice moves one rank (zh-typo-001 via the lexical leg in RRF, en-scanned-001 via the fake reranker), and a 0.02 band with zero spread is finer than one item's step on n=3/n=4 slices."
  confirming_evidence:
    - "Replaying the floor and gate+floor from trace candidates reproduces all 146 refusal decisions of v2-all-off and v2-recommended (0 mismatches)"
    - "v2-all-off replayed with floor 0.28 refuses exactly legacy's 14 dev no-answer items (FR 33/86 vs legacy 34/86)"
    - "Dev oracle at FRR <= 0.05: best CR 7/21 for a single threshold on dense (AUC 0.627) or top rerank score (AUC 0.645)"
    - "Joint per-cell oracle reaches 9/21 only by allowing 1 FR in it|same (thr 0.1603); that cell then fails holdout (test FR 2/10 > 0.15)"
    - "zh-typo-001: fused rank 2 already (RRF 0.03252 vs 0.03227), rerank keeps 2; en-scanned-001: fused rank 3, rerank 0.1145 < 0.1185 moves to 4"
    - "Paired bootstrap CI includes 0 for both slices (typo [-0.5,0], scanned [-0.0625,0])"
  falsification_test: "A v2 floor or cell set at legacy's false-refusal rate that refuses fewer no-answer items than legacy; or a protocol-respecting calibration that lifts dev CR above 0.333 at FRR <= 0.05"
  fix_rationale: "Compare correct refusal at matched false refusal (ROC), and treat single-item category-slice moves by paired significance or minimum n; production code is behaving per D-30"
  blind_spots: "Real Cohere/Voyage scores (04-43) may separate near-miss no-answer items; test split shows zh|same 0.0446 letting zh-no-answer-003 through (gate supersedes floor per D-30)"
  candidate_causes:
    - "data/eval criterion: raw CRR compared at unmatched FRR (phase_compare._refusal)"
    - "environment/fixture: fake reranker = 0.6 fixture cosine + 0.4 IDF coverage, no extra signal on near-miss items"
    - "config: fitted floor 0.1159 vs legacy constant 0.28"
    - "code: gate/floor composition (eliminated by replay)"
  and_gate: "yes: CRR shortfall needs both the unmatched-FRR comparison AND a fixture with no separating signal; MRR fail needs both a single-item move AND a band finer than the slice's step"
next_action: hand back diagnosis

## Symptoms
expected: v2-recommended correct refusal > committed baseline (legacy 0.667) and > v2-all-off; no slice MRR drop beyond noise band
actual: correct refusal 0.333 (n=21) vs legacy 0.667 / v2-all-off 0.333; MRR drop category:typo 1.0->0.833, category:scanned 0.8333->0.8125 (thr 0.8133)
errors: comparison.json passed=false, rule (b) FAIL
reproduction: python -m rag_eval.phase_compare --spec eval/config/phase4-comparison.json (04-40 worktree)
started: 04-40 first run (2026-11-25)

## Eliminated
- hypothesis: v2 gate/floor composition refuses fewer no-answer items than intended (production logic bug)
  evidence: exact replay (0/146 mismatches); v2-all-off and v2-recommended refuse the identical 7 dev no-answer items; v2 floor at 0.28 refuses legacy's identical 14
- hypothesis: compression or translation causes the typo/scanned MRR drop
  evidence: both disabled in v2-recommended (stage_status translate/compress disabled); compression-on ranks identical to v2-recommended
- hypothesis: edge order reorders kept and so changes MRR
  evidence: kept rank == candidate rank for both moved items
- hypothesis: same-split calibration causes the refusal shortfall
  evidence: same-split fitting can only flatter dev; oracle ceiling 0.333 at FRR <= 0.05; joint per-cell 0.429 fails holdout

## Evidence
- legacy refusal = 0 RPC rows above LEGACY_FALLBACK_THRESHOLD 0.28 (src/lib/rag/legacy/enhanced-retrieval.ts:8) -> no_relevant_context
- 7 items legacy refuses / v2-rec answers: en-005 (gate en 0.411>=0.150), en-009 (cross->floor 0.165>0.116), it-007 (cross->floor 0.279>0.116), it-008 (gate it 0.158>=0.079), it-009 (gate it 0.152>=0.079), zh-009 (cross->floor 0.182>0.116), zh-010 (gate zh 0.470>=0.045); legacy best dense 0.165-0.279 all < 0.28
- fake reranker eval/harness/fake-reranker.mts: clamp(0.6*fixture cosine + 0.4*idf coverage)
- rule (b) refusal check phase_compare._refusal: improved = correct > reference_correct (no FRR matching); research D-28 row reads criterion 4 "at the target false-refusal point estimate"
- 4 dev items rank down (6 up): zh-typo-001 1->2, en-scanned-001 3->4, it-ambiguous-002 3->4 (n=6, -0.0139), en-multi-turn-003 3->5 (n=7, -0.019)
- baseline_from_report triplicates one run -> spread 0 -> band = floor 0.02

## Resolution
root_cause: "Rule (b) compares correct refusal at unmatched false-refusal operating points (legacy RPC fallback 0.28 = FRR 0.395 vs v2 fitted floor 0.1159 = FRR 0.047 on the same dense score) on a fixture whose fake reranker adds no separating signal; MRR 'drops' are single-item one-rank moves (lexical leg on typo tokens; fake reranker on OCR tokens) on n=3/n=4 category slices where the 0.02 zero-spread band is finer than one item's step"
fix: (not applied; diagnose-only)
verification: replay scripts in scratchpad/rule-b/
files_changed: []
