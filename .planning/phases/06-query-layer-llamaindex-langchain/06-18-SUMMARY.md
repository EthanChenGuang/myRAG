---
phase: 06-query-layer-llamaindex-langchain
plan: 18
subsystem: ci-boundary
tags: [ci, boundary, langchain, zod, query-llm, cache, security, tdd]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: src/lib/rag/query/llm.ts and the RagDeps queryLlm wiring in deps.ts (06-10)
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: last Phase 4 edit of the boundary script (04-09)
  - phase: 05.1-prompt-injection-defense
    provides: lakera-http rule, last Phase 5.1 edit of the boundary script (05.1-08)
provides:
  - "Rules langchain-import, langchain-adapter-reach, zod-v4 and query-llm-call; cache-rpc extended to rag_cache_* and rag_tenant_language_shares"
  - "Exports LANGCHAIN_DIR, LANGCHAIN_ADAPTER_ALLOWED_IMPORTS, QUERY_LLM_IMPORTERS, QUERY_LLM_AI_CALLS, CACHE_RPC_HOMES, resolveSpec, adapterImportAllowed"
  - "A rule may set enforcedOnAllowlisted(rel) to run on paths in ALLOWLIST; rule.find now receives (text, rel)"
affects: [06-21, 06-22, 06-26, 06-32, 06-35, 06-37]

actuals:
  tokens: 45000
  tasks: 2
  commits: 4
plan_head_before: 582e0b5

tech-stack:
  added: []
  patterns:
    - "Import allow-lists resolve relative and @/ specifiers against the importing file before matching"

key-files:
  created: []
  modified:
    - scripts/ci/check-rag-boundary.mjs
    - scripts/tests/check-rag-boundary.node-test.mjs

requirements-completed: []
requirements-progressed: [QRY-08, QRY-06]
---

# Phase 6 Plan 18: Boundary rules for LangChain, zod 4, the query LLM and tenant-keyed cache RPCs

The boundary check now fences LangChain into `src/lib/rag/query/langchain/` before the packages are installed. The adapter can import only its allow-list. zod 4 cannot enter app code. The query-LLM client and the AI SDK generate/stream calls stay in the query layer. The semantic-cache and language-share RPCs can be called only from their own modules. The real tree passes all rules.

## Commits

| Task | Commits |
|------|---------|
| 1 LangChain and zod rules | 20f019f test(06-18): add failing self-tests for langchain-import, langchain-adapter-reach and zod-v4 boundary rules; 28b356d feat(06-18): add langchain-import, langchain-adapter-reach and zod-v4 boundary rules (D-18, D-19, D-20) |
| 2 Query-LLM and cache RPC rules | 20e7773 test(06-18): add failing self-tests for query-llm-call and the semantic-cache and language-share cache-rpc homes; 65d248a feat(06-18): add query-llm-call rule and extend cache-rpc to the semantic cache and language-share RPCs (D-13) |

## What changed

- **langchain-import**: flags a static, re-export, dynamic `import()` or `require()` of `@langchain/*` (and of the bare `langchain` package) outside `LANGCHAIN_DIR`. It runs in every scan root, including the `tests/` and `eval/harness/` exemptions, through the new `enforcedOnAllowlisted` rule hook. Only `scripts/tests/` (the rule fixtures) stays exempt. Plan 06-35 already keeps tests and eval off `@langchain` through `langchain/fake.ts`.
- **langchain-adapter-reach**: every import in `LANGCHAIN_DIR` must match `LANGCHAIN_ADAPTER_ALLOWED_IMPORTS`. The allowed imports are:
  - `@langchain/*` packages
  - files inside the adapter
  - `src/lib/rag/query/port-types`
  - `src/lib/rag/query/prompts/`
  - `src/lib/rag/query/transformer`, as a type-only import (`import type` or all-`type` inline names)
  - `src/lib/rag-eval/contracts.generated`
  - `rag-sidecar/schemas/*.schema.json`

  Relative and `@/` specifiers are resolved against the importing file. Every other package or module is flagged, including `openai`, Supabase, `@/lib/env`, node built-ins, and the backend, embeddings, rerank, tenant and v2 modules.
- **zod-v4**: flags `zod/v4`, `zod/v4/*`, `zod/mini` and `zod/v4-mini` in any scanned app file. `zod` and `zod/v3` pass.
- **query-llm-call** has two checks:
  - It flags an import that resolves to `src/lib/rag/query/llm` from outside `src/lib/rag/query/` and `src/lib/rag/deps.ts`.
  - Inside `src/lib/rag/query/`, except in `llm.ts`, it flags a value import of `generateText`, `generateObject`, `streamText` or `streamObject` from `ai`. It also flags a namespace import of `ai` and a dynamic `import('ai')`, because the called export cannot be seen. Type-only imports and other `ai` exports such as `Output` pass.
- **cache-rpc** (see the deviation below) is driven by `CACHE_RPC_HOMES`:
  - The Phase 3.1 parse-cache RPCs stay in `src/lib/rag/ingest/parse-cache.ts`. This check covers `src/` only, as before.
  - `rag_cache_*` RPCs belong in `src/lib/rag/cache/`.
  - The exact name `rag_tenant_language_shares` belongs in `src/lib/rag/query/`.

  The last two checks run in every scan root.

## Deviations

- **cache-rpc id reused, not added.** Phase 3.1 already had a rule with the id `cache-rpc` (parse-cache RPCs), and rule ids must be unique (existing self-test). I extended that rule to cover the two new homes instead of renaming it. The id the plan asks for exists, the Phase 3.1 tests are unchanged, and a new test checks that the parse-cache home did not change.
- **Rule hook additions.** `checkBoundary` now passes `rel` to `rule.find(text, rel)`, and a rule can set `enforcedOnAllowlisted(rel)`. This was needed so that `langchain-import` reaches `tests/` and `eval/harness/`, as the plan's truth requires. Existing rules ignore the new argument and the new hook.
- **Stricter than the plan:**
  - langchain-import also flags the bare `langchain` package.
  - zod-v4 also flags `zod/v4/*` subpaths and `zod/v4-mini`.
  - query-llm-call also flags namespace and dynamic imports of `ai` in the query layer.

## Tests that failed before the change

- RED 20f019f: five tests failed on assertions: rule ids and constants missing; langchain-import positives; the adapter directory test (`langchainish` look-alike); adapter-reach forbidden imports; zod-v4.
- RED 20e7773: five tests failed on assertions: rule and constants exported; the query-llm-call importer test; the query-llm-call `ai` test; the cache-rpc semantic-cache test; the cache-rpc language-share test.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 344 files, 5697 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: pass. The first run failed 3 sidecar-launcher tests (`fixture-edge-storage`, `sidecar-tiktoken-cache`) because the rag-sidecar venv had not been synced yet. After `uv sync` they pass.
- `node --import tsx --test tests/rag-db/*.test.mts`: 1783 passed, 4 skipped. The full run had 10 failures in `ingest-identity-async` and `ingest-mode-routing`, because uv could not download sidecar wheels before the rag-sidecar venv was synced. Rerun alone after the sync: 18/18 pass.
- `node scripts/ci/check-rag-boundary.mjs && node --test scripts/tests/check-rag-boundary.node-test.mjs`: ok, 52/52
- `node scripts/check-config.mjs`: ok
- `check-workflows.py`: OK
- No Python, contracts, retrieval, ingest, generation, golden-set or UI changes, so the conditional gates do not apply.

## Decisions for STATE

- The LangChain adapter allow-list is the single exported constant `LANGCHAIN_ADAPTER_ALLOWED_IMPORTS`. The adapter (06-35, 06-37) gets the model id and key passed in. It may not import `@/lib/env`, `openai` or node built-ins. If a later plan needs another import, it must widen the list explicitly, with a self-test.
- The `cache-rpc` rule covers three homes through `CACHE_RPC_HOMES`. Later tenant-keyed RPC families can be added there.

## Operator actions

None.

## Deferred

None.
