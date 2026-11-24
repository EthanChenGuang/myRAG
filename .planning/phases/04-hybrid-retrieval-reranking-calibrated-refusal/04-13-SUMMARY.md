---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 13
subsystem: rag
tags: [refusal, rerank, thresholds, vitest, zod]
requires:
  - phase: 04-01
    provides: RefusalRecord types
  - phase: 04-04
    provides: RefusalThresholdsSchema and refusal-thresholds.json
provides:
  - Pure decideRefusal gate with calibrated-cell-only refuses
  - loadThresholds static JSON loader with warn-once validation
  - similarityFloor from embedding_profiles score_calibration (D-30)
affects:
  - 04-20
  - 04-23
  - 04-44

actuals:
  tokens: 18500
  tasks: 2
  commits: 2
plan_head_before: 7818deeb46e57807398fc77c72e3e106fccd87e8
plan_head_after: 4e4cb4e

tech-stack:
  added: []
  patterns:
    - Pure refusal gate receives cells and versions as inputs (no pipeline imports)
    - Warn-once [RAG Config] validation with empty cell map fallback

key-files:
  created:
    - src/lib/rag/refusal/gate.ts
    - src/lib/rag/refusal/thresholds.ts
    - src/lib/rag/refusal/floor.ts
    - tests/rag/refusal/gate.test.ts
    - tests/rag/refusal/floor.test.ts
  modified: []

key-decisions:
  - "Pairing cross vs same from top candidate language vs query language (A-4)"
  - "Fixture threshold cells apply only on eval profile; chat gets cell_fixture_only"
  - "score_calibration keys context_threshold (text 0.65) and context_image_threshold (image 0.25)"

patterns-established:
  - "cellKey format provider|model|query_language|pairing"
  - "similarityFloor uses strict greater-than floors matching assemble.ts legacy"

requirements-completed: [RNK-05, RNK-06, XLG-03]

coverage:
  - id: gate-branches
    description: Calibrated rerank gate never refuses without a current calibrated cell
    requirement: RNK-05
    verification:
      - kind: unit
        ref: tests/rag/refusal/gate.test.ts
        status: pass
  - id: similarity-floor
    description: D-30 floor from active profile score_calibration when gate not_applied
    requirement: RNK-06
    verification:
      - kind: unit
        ref: tests/rag/refusal/floor.test.ts
        status: pass

status: complete
---

# Phase 4 Plan 13: Refusal gate, thresholds, floor Summary

**One-liner:** Pure `decideRefusal` and `similarityFloor` with Zod-backed threshold loading and Vitest for every failure path.

## Accomplishments

- **`decideRefusal`** — Returns `not_applied` for switch off, disabled reranker, `reranker_unavailable`, relative scores, empty candidates, invalid or missing top score, unknown query language, uncalibrated or stale cells, and fixture-only cells on non-eval profiles. Refuses only when a calibrated, version-matched live (or eval fixture) cell exists and `top.score < threshold`.
- **`loadThresholds` / `loadThresholdsFromData`** — Static import of `eval/config/refusal-thresholds.json`, validated with `RefusalThresholdsSchema`; invalid payload yields empty cells and a single `[RAG Config]` warning.
- **`similarityFloor`** — Maps `context_threshold` and `context_image_threshold` from `embedding_profiles.score_calibration` (legacy row 0.65 / 0.25); refuses when no text similarity exceeds the text floor and no image chunk exceeds the image floor; `no_dense_similarity` when all similarities are null.

## Deviations from Plan

None — plan executed as written.

## Tests

| Command | Result |
|---------|--------|
| `npx vitest run tests/rag/refusal` | 21 passed |
| `node scripts/ci/check-rag-boundary.mjs` | ok |
| `node scripts/check-config.mjs` | ok |
| `python3 scripts/ci/check-workflows.py` | ok |

Pre-existing worktree `tsc` errors in `tests/rag/lexical/chunk-text.test.ts` and `tests/ui/config-rag-panels.test.ts` (unchanged by this plan).

## Self-Check: PASSED

- FOUND: src/lib/rag/refusal/gate.ts
- FOUND: src/lib/rag/refusal/thresholds.ts
- FOUND: src/lib/rag/refusal/floor.ts
- FOUND: tests/rag/refusal/gate.test.ts
- FOUND: tests/rag/refusal/floor.test.ts
- FOUND: d18dfa7
- FOUND: 4e4cb4e