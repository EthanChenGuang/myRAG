---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 28
subsystem: rag-v2-voice
tags: [voice, latency, v2, characterization]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: v2 pipeline, fast rerank tier, voice profile budgets (04-22, 04-23, 04-44)
provides:
  - Voice entry point on RAG_PIPELINE=v2 with hybrid fuse/dedupe/rerank/refusal/assemble (no keyword fallback)
  - RetrievalResult.voice wire contract via assembleVoiceResults
  - voice-v2 characterization snapshot; legacy voice.json unchanged
  - Injected-delay voice budget proof (p95 < 800 ms)
affects: [04-40, 06-28]

actuals:
  tokens: 12000
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Voice v2 skips runContextStages; assembles voice payload after rank stages"

key-files:
  created:
    - tests/rag/v2/voice-budget.test.ts
    - tests/fixtures/characterization/voice-v2.json
  modified:
    - src/lib/rag/pipeline.ts
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/v2/result.ts
    - tests/rag/characterize-voice.test.ts

key-decisions:
  - "RAG_PIPELINE=legacy keeps runVoicePipeline unchanged; v2 uses the same stage graph as chat minus compression and keyword fallback"

requirements-completed: [LAT-02, LAT-01]

coverage:
  - id: D1
    description: "Voice v2 wire contract and characterization"
    requirement: LAT-01
    verification:
      - kind: unit
        ref: "tests/rag/characterize-voice.test.ts"
        status: pass
      - kind: unit
        ref: "tests/rag/voice-rag-route.test.ts"
        status: pass
  - id: D2
    description: "Voice budget under 800 ms with injected delays"
    requirement: LAT-02
    verification:
      - kind: unit
        ref: "tests/rag/v2/voice-budget.test.ts"
        status: pass

---

## HANDOFF

**Branch:** `exec/04-28` → `claude/ecstatic-hamilton-86gtwv`

**Commits:** `ef0c40fb` (voice v2 + characterization), `6287a970` (voice-budget tests), `SUMMARY` (this commit)

**Gates**
| Command | Result |
|---------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` (plan verification) | 20/20 pass (4 files) |
| `node --import tsx --test tests/*.test.mts` | 159 pass / 4 fail (pre-existing fixture DB + RLS) |
| `node scripts/ci/check-rag-boundary.mjs` | pass |
| `python3 scripts/ci/check-workflows.py` | pass |
| `node scripts/check-config.mjs` | pass |

**Deviations**
- `src/lib/rag/pipeline.ts` updated for v2 voice routing (required by task behavior; omitted from plan `files_modified`).
- Refusal after skipped rerank may report `above_similarity_floor` rather than `reranker_unavailable`; voice still returns results under 800 ms.

**Open questions:** none