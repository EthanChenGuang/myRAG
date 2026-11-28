---
quick_id: 261128-dar-docs-agents-rebuild
slug: docs-agents-rebuild
status: complete
date: 2026-11-28
branch: exec/docs-agents-rebuild
base: origin/exec/quick-rbm-rebuild-mechanisms (a5b0a3a6)
key-files:
  modified:
    - AGENTS.md
---

# Quick 261128-dar: AGENTS.md update

Docs only; no product code, no env variable, no migration.

## What changed (AGENTS.md §6)

- Ingestion fingerprint bullet: `rag:rebuild -- start --mechanism` lists `reindex_tables` (`RAG_TABLE_LOOKUP`, runs `rag:table-rows`),
  `reindex_identifiers` (`RAG_IDENTIFIER_INDEX`, runs `rag:identifiers`) and `recluster` (`RAG_DUP_CLUSTERS`, runs `rag:dup-clusters`),
  as in `261127-rbm-SUMMARY.md`; each plans only its own backfill, never a re-parse.
- Hybrid retrieval bullet: `RAG_RERANKER=auto` uses Cohere (with a key) for chat, embed and eval only; voice uses `local_bm25`.

## Verification of the reranker claim

- `git show origin/exec/quick-41-gate-hardening:src/lib/rag/rerank/select.ts` (8f7b2b9f): `AUTO_HOSTED_PROFILES = ['chat', 'embed', 'eval']`.
- This branch's base (a5b0a3a6) still has `['chat', 'embed', 'eval', 'voice']`, so quick-41 is not merged here; the text says
  "effective once quick-41 is merged". Once quick-41 is in the trunk this qualifier can be dropped.
- The original sentence did not literally say "all profiles"; it said `auto` uses Cohere when the key is set, which was wrong for voice after quick-41.

## Gates run

- `npx vitest run tests/rag/agents-guide.test.ts`: 144 passed.
- `node scripts/check-config.mjs`: ok, 274 variables match the manifest.
- `npm ci --ignore-scripts --onnxruntime-node-install-cuda=skip` was used for install. Nothing else run (docs only).
