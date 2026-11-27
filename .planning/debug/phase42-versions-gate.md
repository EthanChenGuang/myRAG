---
status: awaiting_human_verify
trigger: "Phase 4.2 versions gate (ROADMAP 4.2 SC5) fails: en-general-007, zh-general-008, it-general-007 keep 0 superseded chunks; trace shows stage_counts.search.superseded 0."
created: 2026-11-27T04:30:00Z
updated: 2026-11-27T05:20:00Z
---

## Current Focus

hypothesis: two defects in series; both fixed
next_action: orchestrator review of PR from fix/phase42-versions-gate

## Symptoms

- expected: under RAG_VERSION_SCOPE=true and `versions: all`, each of the 3 items keeps at least 1 superseded chunk and covers both evidence groups.
- actual: superseded_kept 0; every item misses an evidence group; `stage_counts.search.superseded: 0`.
- timeline: first gated run of the spec (04.2-32).
- repro: `uv run --directory eval python -m rag_eval.phase42_gate --spec eval/config/phase42-gates.json --out eval/reports/phase-04.2`.

## Eliminated

- hypothesis: superseded fixture rows have no lexical text. Eliminated by querying the built prechunked fixture: v1 chunks of all three lineages have lexical_text and lexical_tsv, status ready, is_current false, no vector.
- hypothesis: `retrieval_strategy: superseded_dense_unavailable` means the leg is broken. Eliminated: the search stage emits that code on every non-current scope (D-40 design note), not on failure.

## Evidence

- `rag_version_history_ok` (0856) and the lexical widening of `hybrid_search_chunks` admit a superseded version only when `successor.content_hash IS DISTINCT FROM d.content_hash`.
- The prechunked fixture writer left `documents.content_hash` NULL on all 149 documents. NULL vs NULL is not distinct, so every superseded lineage version read as a re-publish of the same text; `rag_version_history_ok` returned false for all three; setting the hashes made it true.
- Production lineage versions come only from the unified pipeline, whose `content_hash_dedup` stage always writes the hash, so the fixture did not match production. tests/rag-db/version-scope.test.mts seeds hashes itself, which is why the RPC tests passed.
- After fixture fix 1: `search.superseded: 1`, the superseded chunk is kept at rank 2, both evidence groups covered, but superseded_kept still 0.
- The gate reads `trace.kept[].is_current`; the eval route (`src/app/api/internal/rag/run/route.ts`) never wrote `is_current` or `document_version` on kept entries, although the trace contract has declared both since 04.2-15, and `KeptChunk` had no such fields.

## Resolution

root_cause: (1) fixture: prechunked lineage versions had no content_hash, so the D-40 "same text as successor" exclusion dropped every superseded version; (2) product trace: kept chunks under a non-current scope did not carry is_current / document_version, so the gate could not see a kept superseded chunk.
fix: (1) eval/harness/pglite-supabase.mts writes `contentHash(doc.content)` (the pipeline's normaliser) for lineage versions only; (2) v2 context stage sets `isCurrent` / `documentVersion` on kept chunks only under a non-current scope (search row first, else the rag_document_versions lookup); the eval route maps them to `is_current` / `document_version`.
verification: full gate run: versions PASS (items 3, superseded_kept 3), off_identity, diversity, table, dictionary PASS; identifier unchanged (separate hand-off). `--only versions --reuse eval/reports/phase-04.2` PASS.
files_changed: eval/harness/pglite-supabase.mts, src/lib/rag/types.ts, src/lib/rag/v2/stages/context.ts, src/app/api/internal/rag/run/route.ts, tests/rag-db/fixture-lineage-history.test.mts, tests/rag/v2/version-labels.test.ts, eval/reports/phase-04.2/*
