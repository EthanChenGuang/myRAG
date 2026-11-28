---
quick_id: 261128-dar-docs-agents-rebuild
slug: docs-agents-rebuild
---
# Quick 261128-dar: AGENTS.md rebuild mechanisms and auto reranker profiles

1. `rag:rebuild` mechanism list in AGENTS.md §6: add `reindex_tables`, `reindex_identifiers`, `recluster` (per 261127-rbm SUMMARY).
2. AGENTS.md §6 `RAG_RERANKER=auto`: only chat, embed, eval use the hosted reranker; voice uses `local_bm25` (quick-41, `AUTO_HOSTED_PROFILES`).
3. Gates: `tests/rag/agents-guide.test.ts`, `node scripts/check-config.mjs`. Docs only.
