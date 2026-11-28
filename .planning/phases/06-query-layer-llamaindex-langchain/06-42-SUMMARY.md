---
phase: 06-query-layer-llamaindex-langchain
plan: 42
subsystem: testing
tags: [two-tenant, canary, semantic-cache, query-layer, langchain, pglite, vitest]

requires:
  - phase: 06-04
    provides: rag_tenant_language_shares (0601)
  - phase: 06-36
    provides: chat and embed routes with the semantic cache
  - phase: 06-37
    provides: LangChain end to end (EnsembleRetriever delegate through the scope-bound port)
  - phase: 04-41
    provides: two-tenant v2 harness and matrix
provides:
  - cache cases of the RET-08 two-tenant canary suite on PGlite (real adapter and SQL)
  - query-layer rows (both frameworks) in the v2 two-tenant matrix
  - route-level two-tenant cases for chat, embed and voice-rag with the query layer on
affects: [06-43, 06-44, 06-45, 06-46]

actuals:
  tokens: 10300
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Canary suites over existing behaviour are checked by a mutation run (tenant key forged in the RPC client), not by a RED commit"

key-files:
  created:
    - tests/rag-db/semantic-cache-canary.test.mts
  modified:
    - eval/harness/two-tenant-v2.mts
    - tests/rag-db/v2-two-tenant-matrix.test.mts
    - tests/rag/v2/routes-two-tenant-v2.test.ts

key-decisions:
  - "No product code changed: every case passed on first run, so the canaries were validated by mutants instead of RED commits"

requirements-completed: [CACHE-01, QRY-08, XLG-01]

duration: ~1.5h
completed: 2026-11-26
---

# Phase 6 Plan 42: Two-tenant canary for the cache and the query layer — Summary

**The cross-tenant canary suite now covers the semantic cache and every query-layer path under both frameworks. No case found a leak, and no product code changed.**

## Accomplishments

- **Harness** (`eval/harness/two-tenant-v2.mts`) adds a two-tenant cache fixture:
  - `V2_CACHE_QUESTION`: the one question both tenants ask.
  - `insertV2CacheSource`: a fresh current, ready lineage per call.
  - `insertV2CacheSourceVersion`: a processing next version.
  - `v2CacheServiceRoleRpc`: PostgREST-shaped service_role RPC access over PGlite.
- **Cache canary** (`tests/rag-db/semantic-cache-canary.test.mts`, 12 cases). Everything goes through `createPgvectorSemanticCache` and the 0603 SQL, on the two-tenant v2 database:
  - Same text, vector and key parts: a store in A misses in B and in org O, and A still hits. Each tenant gets back only its own answer. The key hash carries no tenant.
  - B cannot store an answer that cites one of A's documents (`cache_sources_not_current`).
  - `rag_soft_delete_document` and `rag_publish_document_version` on A's source make A miss, and B still hits.
  - A version bump with the `documents` triggers disabled is still a miss, because the hit re-validates `source_versions`.
  - After an active embedding-profile change (openai-3-small-1536 → voyage-4-large-1024), A misses with the new profile and its 1024-dimension vector. A new-dimension vector against the old profile id also misses. There is no dimension error.
  - An entry stored with entry profile chat misses through embed and eval.
  - An entry stored under one system-prompt template hash misses under another.
  - A cached refusal in A is invalidated by the authenticated owner's legacy upload in A. B's cached refusal stays.
  - `invalidateTenant(A)` deletes only A's rows.
- **Matrix rows** (`tests/rag-db/v2-two-tenant-matrix.test.mts`, 92 new cases, 146 in the file). The rows run with `RAG_QUERY_LAYER=true` on top of every Phase 4 switch, over 2 frameworks × 3 profiles (chat, embed, eval) × 3 tenants (a, b, o) × 5 variant kinds (condensed, expanded, hyde, sub_question, translated). Each row asserts that:
  - the plan holds that variant and names that framework;
  - the framework's own fake wrote the variants and the other fake was never called;
  - in LangChain rows, `framework_import` is ok and `fuse.delegated = 1` (the EnsembleRetriever went through the port);
  - the variant's own leg (`:<index>`) found candidates;
  - every chunk, document, parent and image belongs to the caller;
  - no foreign marker appears in the result, stages, plan or rerank input.

  Two more cases:
  - **LangChain twin:** A and B hold an identical-text chunk. A LangChain request in A returns A's chunk id and never B's.
  - **Language shares:** A's documents are set to zh and B's to en. On both frameworks, an English question translates into zh in A (R8, a translated variant with language zh) and not in B (no R8, no translate call). Each `rag_tenant_language_shares` call carries exactly `{ p_tenant_key: <caller> }`.
- **Route level** (`tests/rag/v2/routes-two-tenant-v2.test.ts`, 15 new cases, 48 in the file). Each case runs in all three tenants, and only the caller's text reaches the model prompt, the response body and the logs:
  - chat with history (condense) under llamaindex and langchain;
  - embed (expand, hyde) under llamaindex and langchain;
  - voice-rag with session-bound history. It condenses on the native model even with `RAG_QUERY_FRAMEWORK=langchain`, and LangChain is never called.

## Task Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | 6666ce6 | test(06-42): two-tenant semantic cache canary cases on PGlite |
| 2 | f25374e | test(06-42): query-layer rows in the v2 two-tenant matrix |
| 2 | 3eadba3 | test(06-42): route-level two-tenant cases with the query layer on |
| — | this commit | docs(06-42): summary |

## Tests that failed before the change / TDD note

None. The plan adds canary tests over behaviour that plans 06-12, 06-21, 06-26, 06-36 and 06-37 already built, and every case passed on its first run. A RED commit would have had to be artificial, so each suite was checked with an uncommitted mutant instead:

| Mutant | Result |
|--------|--------|
| Cache: the RPC client rewrites every `p_tenant_key` to tenant A's | 7 of 12 cache cases fail: every cross-tenant case. The 5 that pass check single-tenant key parts and need no tenant to fail. |
| Matrix: `hybrid_search_chunks` gets tenant B's key | Every A and O row fails (llamaindex embed and langchain chat sampled, 20 of 30). The B rows pass, as they should. |
| Routes: the same forged key in the route's deps | 10 of 15 fail (all A and O). The 5 B cases pass. |

## Behaviour changes

None. Only tests and the eval harness changed.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/rag/v2/routes-two-tenant-v2.test.ts tests/rag/voice-rag-route.test.ts tests/rag/voice-rag-two-tenant.test.ts` (the changed file plus every importer of the changed harness): 3 files, 80 passed
- `node --import tsx --test tests/rag-db/semantic-cache-canary.test.mts tests/rag-db/v2-two-tenant-matrix.test.mts tests/rag-db/language-shares.test.mts tests/rag-db/semantic-cache-invalidation.test.mts tests/rag-db/semantic-cache-adapter.test.mts tests/rag-db/query-layer-langchain.test.mts`: 217 passed, 0 failed
- Plan verify: `semantic-cache-canary` + `semantic-cache-invalidation`: 32 passed
- `node scripts/ci/check-rag-boundary.mjs`: ok (1745 files). `node scripts/check-config.mjs`: ok (213 variables). `check-language-literals`: ok. `check-settings-classification`: ok (165 variables).
- Acceptance greps: `RAG_QUERY_LAYER` in the matrix = 2 (≥ 1); `langchain` in the matrix = 20 (≥ 1); the canary reports 12 passed (≥ 7).
- ESLint on the changed files: 0 errors. 8 warnings, all parameter names inside function type signatures, the same pattern as the file's existing ones.
- Not run, because their areas were not touched: SQL/migrations, `tests/*.test.mts`, workflows, Python, contracts, `test-rag` (no retrieval, ingest, generation or golden-set change), the UI design gate.

## Deviations

- **No RED commits** (see the TDD note above). The canaries were validated by mutation instead.
- **Profile change scope:** embedding profiles are deployment-wide, so "A's active embedding profile" is tested as a deployment-wide activation flip. The tenant-A entry must miss under the new profile, and B is checked too.
- **Voice in the matrix:** voice is left out of the query-layer matrix rows. Voice blocks expand, hyde and decompose and always runs native, so those rows would not exercise the variants. Voice with history is covered at route level instead, which also closes plan-check B4's gap for "every query-layer path".
- **Environment:** `uv sync --locked --all-extras` in `eval/` refuses because `eval/uv.lock` needs updating. This is pre-existing on the base and was not re-locked (brief rule). No Python gate applies to this plan. `npm ci` and the sidecar sync succeeded.

## Decisions for STATE

- RET-08 canary: the semantic cache and every query-layer path (both frameworks, every variant kind, language shares, LangChain chunk-id documents) are in the two-tenant suite. No cross-tenant path was found.
- Pattern: a canary over existing behaviour is validated with a tenant-key mutant and the result is recorded in the SUMMARY.

## Operator actions

None.

## Deferred

None.

## Self-Check: PASSED
