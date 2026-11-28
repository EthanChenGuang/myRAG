---
quick_id: 261128-rdm
slug: readme-refresh
status: complete
---
# Quick 261128-rdm: README refresh

Commit: 15a850a2 (README.md only). Base cbc51d53.

## Changed sections
- Header nav, Support list, footer: the 3 Discord links removed; nav separators kept tidy (footer now links Read Docs and Quick Start).
- Brand names: grep for ChatRAG / chatrag / Chat RAG found none; nothing to rename.
- Badge: Next.js 16 (was 16.0.10).
- What's New: new "Optional RAG pipeline" entry.
- RAG System: "Pure Semantic" row replaced with the real default; new table "Optional RAG pipeline (opt-in switches, all off by default)" with switch names and defaults taken from AGENTS.md §6 and src/lib/env.ts.
- RAG Pipeline card: semantic matching wording.
- Quick Start prerequisites: optional extras and handoff checks.
- Tech stack: versions from package.json and package-lock.json (Next 16.4.6 resolved, range ^16.1.6; React 19.2.1; AI SDK 6.0.3; Tailwind 3.4; Zustand 5; Node ^22.12.0); Qdrant/Weaviate and Python services listed; project structure adds rag-sidecar, eval, config/rag, supabase/migrations.
- Documentation index: RAG Pipeline subsection linking AGENTS.md §6, docs/finetune-retention.md, docs/vendor-data-flow.md.

## Gates run
- Relative links and images in README.md: all targets exist.
- Tests referencing README.md: none reference the root README (search-rpc-grants reads supabase/README.md; link-allowlist only uses the string); nothing to run.
- node scripts/check-config.mjs: ok, 283 variables match.

## Deviations / for the orchestrator
- README_RAG_PIPELINE.md does not exist in the repo, so it is not linked. No README mentions it.
- "Source deletion sync", "rollouts" and "red-team" are listed only as far as code shows (RAG_SOURCE_RECHECK, rag:source-reconcile, rag_rollouts admin, npm run rag:red-team); the red-team row appears under Evaluation & gates.
- Existing performance claims (15-28x, <50ms benchmarks table) were left untouched; I did not verify them against code. Deferred.
