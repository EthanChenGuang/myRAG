---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 44
subsystem: rag-v2-config
tags: [retrieval-params, config-hash, chunking-profiles, vitest]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: retrieval-params.json, V2Config switches, rag_list_chunking_profiles, refusal thresholds hash
provides:
  - effectiveRetrievalParams with eval-only override gate
  - v2ProfileSettings per entry point
  - computeRetrievalConfigHash canonical sha256
  - getActiveChunkingProfiles cached reader with refresh
affects: [04-19, 04-22, 04-28, 04-31, 04-33, 04-34]

actuals:
  tokens: 16000
  tasks: 2
  commits: 2
plan_head_before: 80751211f56864a1284cf2f1fd0e3c5ba7971380
plan_head_after: c92f72e
commits: 2

tech-stack:
  added: []
  patterns:
    - "Static eval JSON import validated at module load"
    - "Warn-once invalid rerank_input_cap guard (50..100)"
    - "Null chunking map hashes as chunking:unavailable"

key-files:
  created:
    - src/lib/rag/v2/retrieval-params.ts
    - src/lib/rag/v2/profiles.ts
    - src/lib/rag/v2/config-hash.ts
    - src/lib/rag/chunking/active.ts
    - tests/rag/v2/params-hash.test.ts
  modified: []

key-decisions:
  - "Voice token budget 2000 ms stays a code default (A-9), not a new env var"
  - "Chunking RPC errors log code-only [RAG Chunking] lines"

patterns-established:
  - "30s TTL cache pattern mirrored from embedding active profile reader"

requirements-completed: [RNK-02, LAT-01, LAT-02]

coverage:
  - id: D1
    description: Retrieval params loader honors file, emergency override, and eval-only request overrides
    requirement: RNK-02
    verification:
      - kind: unit
        ref: "tests/rag/v2/params-hash.test.ts#effectiveRetrievalParams"
        status: pass
    human_judgment: false
  - id: D2
    description: Per-profile v2 settings encode voice deadline and rerank budget fields
    requirement: LAT-02
    verification:
      - kind: unit
        ref: "tests/rag/v2/params-hash.test.ts#v2ProfileSettings"
        status: pass
    human_judgment: false
  - id: D3
    description: retrievalConfigHash changes when any listed configuration part changes
    requirement: RNK-02
    verification:
      - kind: unit
        ref: "tests/rag/v2/params-hash.test.ts#computeRetrievalConfigHash"
        status: pass
    human_judgment: false
  - id: D4
    description: Active chunking pointers cached, refreshable, and unavailable when RPC fails
    requirement: LAT-01
    verification:
      - kind: unit
        ref: "tests/rag/v2/params-hash.test.ts#getActiveChunkingProfiles"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 44: v2 config modules for params, profiles, hash and chunking cache

**Pure v2 modules load committed retrieval params, expose per-profile budgets and deadlines, sha256-label retrieval configuration, and cache active chunking pointers for the tracer (plan 04-19).**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2/2
- **Commits:** 2

## Accomplishments

1. `effectiveRetrievalParams` merges `eval/config/retrieval-params.json`, `RAG_RETRIEVAL_PARAMS_OVERRIDE`, and eval-only `retrieval_overrides`; invalid `rerank_input_cap` values outside 50..100 are rejected with a single `[RAG Config]` warning.
2. `v2ProfileSettings` gives voice fast tier, 2000-token budget, 800 ms deadline, 50 ms rerank reserve and 80 ms floor; chat/embed/eval follow chat tier and `RAG_CONTEXT_TOKEN_BUDGET`.
3. `computeRetrievalConfigHash` hashes canonical sorted-key JSON over backend, embedding profile, versions, params, reranker, thresholds hash, chunking map (or `chunking:unavailable`), and D-23 switches.
4. `getActiveChunkingProfiles` reads `rag_list_chunking_profiles` at most once per 30 s; `refreshActiveChunkingProfiles` invalidates the cache after pointer flips.

## Task Commits

1. **Task 1: Retrieval params loader and per-profile v2 settings** - `394ffc9` (feat)
2. **Task 2: Retrieval-config hash and the active chunking-profile cache** - `c92f72e` (feat)

## Deviations from Plan

None — plan executed as written.

## Tests

- `npx vitest run tests/rag/v2/params-hash.test.ts` — 15 passed
- `npx tsc --noEmit -p tsconfig.json` — 0 errors on changed files (full repo gate has pre-existing failures in unrelated suites)
- `node scripts/ci/check-rag-boundary.mjs` — ok
- `python3 scripts/ci/check-workflows.py` — ok
- `node scripts/check-config.mjs` — ok

## Self-Check: PASSED

- FOUND: src/lib/rag/v2/retrieval-params.ts
- FOUND: src/lib/rag/v2/profiles.ts
- FOUND: src/lib/rag/v2/config-hash.ts
- FOUND: src/lib/rag/chunking/active.ts
- FOUND: tests/rag/v2/params-hash.test.ts
- FOUND: 394ffc9
- FOUND: c92f72e