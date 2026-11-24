---
phase: "06"
slug: "query-layer-llamaindex-langchain"
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-11-24"
---

# Phase 06 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Every executable task in 06-01 to 06-45 has an `<automated>` command. The non-automated items are the package-approval checkpoint in 06-22 (blocking-human, never auto-approvable), the four live-service checkpoints in 06-46, and one Config UI walk-through in 06-40 (a `<human-check>` under end-of-phase mode).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.1.1 (`tests/**/*.test.ts`); `node --import tsx --test` for `.test.mts` (PGlite DB tests in `tests/rag-db/`); `node --test` for `scripts/**/*.node-test.mjs`; pytest 9.2.0 for `eval/` and `rag-sidecar/`; `node --import tsx --test test/*.test.ts` in `voice-agent/` |
| **Config file** | `vitest.config.ts`; `eval/pyproject.toml`; `rag-sidecar/pyproject.toml`; `voice-agent/package.json` |
| **Quick run command** | `npx vitest run tests/rag/query tests/rag/cache` (plus `node --import tsx --test tests/rag-db/<file>.test.mts` for SQL work) |
| **Full suite command** | `npx vitest run && node --import tsx --test tests/*.test.mts tests/rag-db/*.test.mts && uv run --directory eval pytest -q && uv run --directory rag-sidecar pytest -q && node --test scripts/tests/check-rag-boundary.node-test.mjs scripts/tests/check-zod-isolation.node-test.mjs scripts/check-config.test.mjs && node scripts/check-config.mjs && node scripts/ci/check-rag-boundary.mjs && node scripts/ci/check-zod-isolation.mjs && npm run typecheck:new && (cd voice-agent && npm test)` |
| **Estimated runtime** | quick: under 30 s per area; full: about 8 to 12 minutes (PGlite suites dominate); smoke tier about 2 minutes per mode |

No test calls a live service. Query-LLM calls use the deterministic fake (`eval/harness/fake-query-llm.mts`, and `src/lib/rag/query/langchain/fake.ts` for LangChain) reading `eval/fixtures/query-llm/transforms.json`; SQL runs on PGlite with pgvector 0.8.7; RedisVL runs against a fake cache (the import-path case needs the `cache` extra); the sidecar uses TestClient.

---

## Sampling Rate

- **After every task commit:** the task's `<automated>` command, plus `npm run typecheck:new` for TypeScript changes.
- **After every plan wave:** the full suite command, plus the legacy smoke tiers: `npm run test-rag -- --out eval/out/p6-wave && jq -e '.passed == true and .paired.all_zero == true' eval/out/p6-wave/gate.json` and the same with `--fixture-mode ingest`. From wave 4 on, also `npx vitest run tests/rag/query/parity-off.test.ts` (layer off byte-identical under v2).
- **Before `/gsd-verify-work`:** plan 06-45 Task 2 command chain green, `eval/reports/phase-06/comparison.json` passed (plan 06-44), `eval/reports/frameworks-fixture/report.json` written (plan 06-43), and `npm run gen:schemas` with a clean diff.
- **Max feedback latency:** 60 seconds for per-task commands (smoke tiers, comparisons and builds are per-wave or per-plan gates).

---

## Requirement → Test Map (Nyquist map)

| Req | Behaviour that must be observable | Plans | Automated command |
|-----|-----------------------------------|-------|-------------------|
| QRY-01 | Follow-ups become standalone queries in the user's language with protected tokens verbatim; standalone questions pass through; history window 6 turns of 1,000 characters, markup stripped; a token-losing rewrite is discarded | 06-01, 06-07, 06-13, 06-27, 06-38 | `npx vitest run tests/rag/query/condense.test.ts tests/rag/query/post-checks.test.ts tests/rag/query/history.test.ts && node --import tsx --test tests/rag-db/query-layer-tracer.test.mts` |
| QRY-02 | Multi-query expansion (LlamaIndex QueryFusionRetriever prompt), at most 2 LLM variants shared with condensed and HyDE, original always searched, one RRF over all lists | 06-15, 06-19, 06-20 | `npx vitest run tests/rag/query/expand.test.ts tests/rag/query/run-layer.test.ts tests/rag/v2/variants-fusion.test.ts` |
| QRY-03 | HyDE off by default, per-language template, dense leg only, never the rerank or refusal query, never in voice | 06-14, 06-15, 06-19, 06-20, 06-25, 06-28 | `npx vitest run tests/rag/query/hyde.test.ts tests/rag/query/router.test.ts tests/rag/v2/rerank-standalone.test.ts tests/rag/query/voice-budget.test.ts` |
| QRY-04 | At most 4 sub-questions, empty means not compound, no answer field; sub-question coverage reservation (at most 4) after one rerank, switchable | 06-15, 06-19, 06-25, 06-38 | `npx vitest run tests/rag/query/decompose.test.ts tests/rag/v2/subq-coverage.test.ts` |
| QRY-05 | Router uses the gate plus the classifier only for tool_required with needsMcp and multi_step (A-1); per-transform switch, timeout and budget; injected delay or failure per transform completes the request with the original retained; soft status (A-2) | 06-10, 06-13, 06-14, 06-19, 06-27, 06-29 | `npx vitest run tests/rag/query/router.test.ts tests/rag/query/delays.test.ts tests/rag/query/status.test.ts tests/rag/query/parity-off.test.ts tests/rag/config.test.ts` |
| QRY-06 | Native ports with vendored LlamaIndex prompts and no framework call at query time; structured outputs validated by the generated Zod schemas; query-LLM calls only in `src/lib/rag/query/llm.ts` | 06-01, 06-05, 06-10, 06-13, 06-15, 06-18 | `npx vitest run tests/rag/query/llm.test.ts tests/contracts.test.ts tests/schema-parity.test.ts && node --test scripts/tests/check-rag-boundary.node-test.mjs` |
| QRY-07 | Voice profile runs only gate, condense and date normalization (plus translate if listed), stays under 800 ms p95 with fakes, keeps the voice wire contract; the voice-agent switch defaults to today's agent-side rewrite | 06-14, 06-28, 06-31 | `npx vitest run tests/rag/voice-rag-route.test.ts tests/rag/query/voice-budget.test.ts tests/rag/v2/voice-budget.test.ts && (cd voice-agent && npm test)` |
| QRY-08 | LangChain adapter in one module (dynamic import), same output shapes, EnsembleRetriever over the scope-bound port with chunk-id documents; boundary rules; zod 4 isolated; Config UI switch; paired framework comparison | 06-18, 06-22, 06-26, 06-35, 06-37, 06-40, 06-42, 06-43 | `npx vitest run tests/rag/query/langchain-adapter.test.ts tests/rag/query/langchain-ensemble.test.ts tests/rag/query/framework-parity.test.ts tests/rag/v2/retrieval-port.test.ts && node --import tsx --test tests/rag-db/query-layer-langchain.test.mts && node scripts/ci/check-zod-isolation.mjs && node scripts/ci/check-rag-boundary.mjs && uv run --directory eval pytest -q tests/test_compare_frameworks.py` |
| LAT-03 | Locked gate spec: fixture table zh/en/it, all fired rules returned, protected tokens, p99 under 1 ms; R2 relative dates normalized deterministically with undated documents kept; at most two variants by default | 06-03, 06-06, 06-07, 06-08, 06-13, 06-24 | `npx vitest run tests/rag/query/rewrite-gate.test.ts tests/rag/query/rewrite-gate.bench.test.ts tests/rag/query/protected.test.ts tests/rag/query/dates.test.ts tests/rag/query/layer-filters.test.ts && node --import tsx --test tests/rag-db/hybrid-include-undated.test.mts tests/rag-db/query-dates-undated.test.mts` |
| XLG-01 | Query language detection; tenant KB shares via a service-role SQL function with tenant-key checks; translation only below a 20% share into at most two KB languages, verbatim tokens, through the Phase 4 slot; en and it questions retrieve zh evidence; answers requested in the asker's language with prompts unchanged when languages match | 06-03, 06-04, 06-16, 06-23, 06-33, 06-38 | `npx vitest run tests/rag/query/kb-languages.test.ts tests/rag/query/translate.test.ts tests/rag/query/translate-slot.test.ts tests/rag/prompt-answer-language.test.ts && node --import tsx --test tests/rag-db/language-shares.test.mts tests/rag-db/cross-language-query.test.mts` |
| CACHE-01 | pgvector table and server-role functions, profile-filtered exact distance, source re-validation, same-transaction triggers; RedisVL sidecar backend; full key incl. entry profile and prompt hash; deterministic bypass; fail-open 150 ms; hits stream with cache: hit; store after groundedness; calibrated threshold; near-miss wrong-hit 0; cache canary cases | 06-09, 06-11, 06-12, 06-17, 06-21, 06-30, 06-32, 06-36, 06-39, 06-40, 06-41, 06-42 | `npx vitest run tests/rag/cache tests/rag/chat-cache-hit.test.ts tests/rag/embed-cache.test.ts && node --import tsx --test tests/rag-db/semantic-cache.test.mts tests/rag-db/semantic-cache-invalidation.test.mts tests/rag-db/semantic-cache-canary.test.mts tests/rag-db/cache-pairs.test.mts && uv run --directory rag-sidecar pytest -q tests/test_cache_endpoints.py tests/test_cache_service.py && uv run --directory eval pytest -q tests/test_calibrate_cache.py` |

### Cross-cutting checks

| Check | Source | Plans | Automated command |
|-------|--------|-------|-------------------|
| All switches off (RAG_QUERY_LAYER unset or false, RAG_SEMANTIC_CACHE=off, or RAG_PIPELINE=legacy) gives Phase 4 behaviour byte for byte: run-layer never imported, hash unchanged, route inputs unchanged, characterization suites unchanged; either voice switch off alone keeps today's follow-up condensing (VOICE_SERVER_QUERY_REWRITE=true with the layer off falls back to the agent rewrite because voice-rag sends no x-rag-server-query-rewrite header, plans 06-28 and 06-31) | D-04, ROADMAP "behind a switch", plan-check W2 | 06-10, 06-13, 06-27, 06-28, 06-31, 06-32, 06-33, 06-36, 06-38, 06-44 | `(cd voice-agent && npm test) && npx vitest run tests/rag/voice-rag-route.test.ts tests/rag/query/parity-off.test.ts tests/rag/v2/config-hash-query.test.ts tests/rag/characterize-chat.test.ts tests/rag/characterize-embed.test.ts tests/rag/characterize-voice.test.ts && npm run test-rag -- --out eval/out/p6-check && jq -e '.passed == true and .paired.all_zero == true' eval/out/p6-check/gate.json` and the same with `--fixture-mode ingest` |
| Strict "information not available" preserved; a skipped transform never turns an empty result into an outage message (A-2); small talk under the layer is answered without refusal (D-10) | AGENTS.md §14, A-2, D-10 | 06-19, 06-25, 06-27 | `npx vitest run tests/rag/query/status.test.ts tests/chat-strict.test.ts tests/rag/v2/refusal-routing.test.ts tests/rag/chat-query-layer.test.ts` |
| Tenant scope stays server-bound through every new surface, each tested with two tenants: voice-rag history bound to its session token (a tenant-B token with tenant-A history sees only B, plan 06-28), language shares and their in-process cache, cache SQL, the pgvector and RedisVL adapters, the sidecar cache service, the pipeline cache stage, chat and embed cache routes, the admin clear route, variants, the LangChain port and EnsembleRetriever | Project constraint (multi-tenant), D-18, D-23, D-34, D-35, plan-check B4 | 06-04, 06-12, 06-16, 06-21, 06-26, 06-28, 06-30, 06-32, 06-36, 06-37, 06-40, 06-42 | `node --import tsx --test tests/rag-db/language-shares.test.mts tests/rag-db/semantic-cache.test.mts tests/rag-db/semantic-cache-canary.test.mts tests/rag-db/v2-two-tenant-matrix.test.mts tests/rag-db/semantic-cache-adapter.test.mts && npx vitest run tests/rag/query/kb-languages.test.ts tests/rag/v2/retrieval-port.test.ts tests/rag/cache/redisvl-http.test.ts tests/rag/cache/stage.test.ts tests/rag/chat-cache-hit.test.ts tests/rag/embed-cache.test.ts tests/rag/semantic-cache-admin-route.test.ts tests/rag/v2/routes-two-tenant-v2.test.ts tests/rag/voice-rag-two-tenant.test.ts && uv run --directory rag-sidecar --frozen --no-sync pytest -q tests/test_cache_service.py` |
| The cache never crosses tenants, entry profiles (chat, embed, eval), system-prompt templates or document versions; never reads or writes turns with document references or non-default retrieval options; never stores history-dependent, ghost, personal, tool or unreliable turns; eval seed answers are refused in production; RedisVL never caches refusals; a hit writes its Phase 5 answer record with re-resolved citations | A-3, D-33, spec rules 1, 4, 6, 7, plan-check B1, B2, W1, W6 | 06-12, 06-17, 06-21, 06-30, 06-32, 06-36, 06-41, 06-42 | `npx vitest run tests/rag/cache/keys.test.ts tests/rag/cache/bypass.test.ts tests/rag/cache/stage.test.ts tests/rag/cache/store-after.test.ts tests/rag/cache/redisvl-http.test.ts tests/rag/chat-cache-hit.test.ts tests/eval-route-cache.test.ts && node --import tsx --test tests/rag-db/semantic-cache.test.mts tests/rag-db/semantic-cache-canary.test.mts` |
| Boundary rules: @langchain only in the adapter; adapter reach limited; no zod v4 in app code; query-LLM calls in one module; cache and language-share RPCs in their modules | D-13, D-19 | 06-18 | `node --test scripts/tests/check-rag-boundary.node-test.mjs && node scripts/ci/check-rag-boundary.mjs` |
| zod isolation: root zod 3.25.x, zod 4 nested under each @langchain package, root openai 4.x; type-check and build pass | D-20 | 06-22 | `node --test scripts/tests/check-zod-isolation.node-test.mjs && node scripts/ci/check-zod-isolation.mjs && npx next typegen && npx tsc --noEmit -p tsconfig.json && npm run build` |
| Package legitimacy: no LangChain or RedisVL install before the blocking human checkpoint; installs, locks and syncs are orchestrator-only (06-22 Task 2) and executors only verify the committed lock (npm ls, uv lock --check, uv run --frozen --no-sync); the LangChain trio never installed before 2026-12-04; exact pins (--save-exact); --before cutoff of install date minus 7 days; RedisVL extra optional, and declining it needs a D-35 and CACHE-01 decision change; per-package exclude-newer; hashed locks | A-9, planner package gate | 06-22 | checkpoint (blocking-human) plus `uv run --directory rag-sidecar pytest -q tests/test_dependency_boundary.py` |
| Env names in the five config places and the manifest; eval pin includes them and NEXT_PUBLIC_MCP_SYSTEM_ENABLED | AGENTS.md rule 5, D-26, A-1 | 06-02 | `node --test scripts/check-config.test.mjs && node scripts/check-config.mjs && npx vitest run tests/eval-env-pin.test.ts` |
| Pydantic source with generated Zod, no drift | Project constraint (Pydantic v2) | 06-05, 06-11, 06-34 | `npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts` |
| Latency: gate p99 under 1 ms; per-transform timeouts; group deadline anchored at the gate; voice under 800 ms p95 with fakes; budgets reported | D-27, D-29, A-7 | 06-03, 06-07, 06-19, 06-28, 06-34 | `npx vitest run tests/rag/query/rewrite-gate.bench.test.ts tests/rag/query/deadline.test.ts tests/rag/query/delays.test.ts tests/rag/query/voice-budget.test.ts && uv run --directory eval pytest -q tests/test_report_query.py` |
| No query text, history, rewrites, keys or tenant keys in logs; `[Query Layer]` and `[Semantic Cache]` prefixes | Conventions, F-22 | 06-10, 06-16, 06-21, 06-36 | `npx vitest run tests/rag/query/llm.test.ts tests/rag/query/kb-languages.test.ts tests/rag/cache/redisvl-http.test.ts tests/rag/cache/store-after.test.ts tests/rag/hot-path-logs.test.ts` |
| Admin clear-cache route behind the S7 guard, fail closed | D-44, Phase 3 D-45 | 06-40 | `npx vitest run tests/rag/semantic-cache-admin-route.test.ts tests/api/admin-auth.test.ts` |
| Folded setup files apply cleanly on PGlite and equal the migrations, each mode on its own | D-23, D-34, Phase 3 D-05 | 06-45 | `node --import tsx --test --test-reporter=tap --test-name-pattern="single-tenant setup" tests/rag-db/schema-equality.test.mts` and the same with `"multi-tenant setup"`, each with `# fail 0` |
| Phase completion against Phase 4 (D-42 a to e) | ROADMAP "proven against the baseline", D-42 | 06-44 | `uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase6-comparison.json --out eval/reports/phase-06 && jq -e '.passed == true' eval/reports/phase-06/comparison.json` |

---

## Per-Task Verification Map

Requirements and threat references per plan are in each plan and in `06-PLAN-INDEX.md`. Kind: tracer, tdd (test first), auto, checkpoint. Commands longer than one line are shortened here; the plan holds the full command.

| Task ID | Wave | Kind | Automated Command | Status |
|---------|------|------|-------------------|--------|
| 06-01-01 | 1 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_query_contracts.py` | ⬜ pending |
| 06-01-02 | 1 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_query_contracts.py tests/test_contract_models.py && uv run --directory eval pytest -q tests/test_config_files.py && uv run --directory eval python -m rag_eval.config_files init` | ⬜ pending |
| 06-02-01 | 1 | tdd | `node --test scripts/check-config.test.mjs` | ⬜ pending |
| 06-02-02 | 1 | auto | `node scripts/check-config.mjs && npx vitest run tests/eval-env-pin.test.ts` | ⬜ pending |
| 06-02-03 | 1 | tdd | `node --test scripts/tests/config-server-security.node-test.mjs && node scripts/check-config.mjs` | ⬜ pending |
| 06-03-01 | 1 | tdd | `npx vitest run tests/rag/query/protected.test.ts` | ⬜ pending |
| 06-03-02 | 1 | tdd | `npx vitest run tests/rag/query/rewrite-gate.test.ts tests/rag/query/protected.test.ts` | ⬜ pending |
| 06-03-03 | 1 | tdd | `npx vitest run tests/rag/query/rewrite-gate.bench.test.ts` | ⬜ pending |
| 06-04-01 | 1 | tdd | `node --import tsx --test tests/rag-db/language-shares.test.mts` | ⬜ pending |
| 06-04-02 | 1 | tdd | `node --import tsx --test tests/rag-db/language-shares.test.mts tests/rag-db/schema-migrations.test.mts` | ⬜ pending |
| 06-05-01 | 2 | auto | `uv run --directory rag-sidecar pytest -q tests/test_contract_export.py tests/test_contract_models.py` | ⬜ pending |
| 06-05-02 | 2 | auto | `npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts && node --test … (full command in the plan)` | ⬜ pending |
| 06-06-01 | 2 | tdd | `npx vitest run tests/rag/query/dates.test.ts` | ⬜ pending |
| 06-06-02 | 2 | tdd | `npx vitest run tests/rag/query/dates.test.ts tests/rag/query/rewrite-gate.test.ts` | ⬜ pending |
| 06-07-01 | 2 | tdd | `npx vitest run tests/rag/query/post-checks.test.ts` | ⬜ pending |
| 06-07-02 | 2 | tdd | `npx vitest run tests/rag/query/deadline.test.ts` | ⬜ pending |
| 06-07-03 | 2 | tdd | `npx vitest run tests/rag/query/prompt-render.test.ts` | ⬜ pending |
| 06-08-01 | 2 | tdd | `node --import tsx --test tests/rag-db/hybrid-include-undated.test.mts tests/rag-db/hybrid-filters.test.mts tests/rag-db/hybrid-search.test.mts` | ⬜ pending |
| 06-08-02 | 2 | tdd | `node --import tsx --test tests/rag-db/hybrid-grants.test.mts tests/rag-db/hybrid-tenant.test.mts tests/rag-db/hybrid-include-undated.test.mts` | ⬜ pending |
| 06-09-01 | 2 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_cache_contracts.py` | ⬜ pending |
| 06-09-02 | 2 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_golden_contract.py && uv run --directory eval pytest -q tests/test_golden_io.py` | ⬜ pending |
| 06-10-01 | 3 | tdd | `npx vitest run tests/rag/config.test.ts tests/rag/query/stage-names.test.ts tests/rag/stage-runner.test.ts && npm run typecheck:new` | ⬜ pending |
| 06-10-02 | 3 | tdd | `npx vitest run tests/rag/query/llm.test.ts && npm run typecheck:new` | ⬜ pending |
| 06-10-03 | 3 | tdd | `npx vitest run tests/rag/query/fake-query-llm.test.ts` | ⬜ pending |
| 06-11-01 | 3 | auto | `uv run --directory rag-sidecar pytest -q tests/test_contract_export.py tests/test_contract_models.py tests/test_cache_contracts.py` | ⬜ pending |
| 06-11-02 | 3 | auto | `npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts tests/rag/v2/params-hash.test.ts` | ⬜ pending |
| 06-12-01 | 3 | tdd | `node --import tsx --test tests/rag-db/semantic-cache.test.mts` | ⬜ pending |
| 06-12-02 | 3 | tdd | `node --import tsx --test tests/rag-db/semantic-cache.test.mts` | ⬜ pending |
| 06-12-03 | 3 | tdd | `node --import tsx --test tests/rag-db/semantic-cache-invalidation.test.mts tests/rag-db/semantic-cache.test.mts tests/rag-db/ingest-writer.test.mts tests/rag-db/soft-delete.test.mts` | ⬜ pending |
| 06-13-01 | 4 | tracer | `node --import tsx --test tests/rag-db/query-layer-tracer.test.mts tests/rag-db/v2-tracer.test.mts` | ⬜ pending |
| 06-13-02 | 4 | tdd | `npx vitest run tests/rag/query/condense.test.ts tests/rag/query/layer-filters.test.ts tests/rag/query/parity-off.test.ts && npm run test-rag -- --out eval/out/p6-13 && jq -e '.passed == true and .paired.all_zero == true' eval/out/p6-13/gate.json` | ⬜ pending |
| 06-14-01 | 4 | tdd | `npx vitest run tests/rag/query/router.test.ts` | ⬜ pending |
| 06-14-02 | 4 | tdd | `npx vitest run tests/rag/query/query-params.test.ts` | ⬜ pending |
| 06-15-01 | 4 | tdd | `npx vitest run tests/rag/query/expand.test.ts` | ⬜ pending |
| 06-15-02 | 4 | tdd | `npx vitest run tests/rag/query/hyde.test.ts` | ⬜ pending |
| 06-15-03 | 4 | tdd | `npx vitest run tests/rag/query/decompose.test.ts tests/rag/query/expand.test.ts tests/rag/query/hyde.test.ts` | ⬜ pending |
| 06-16-01 | 4 | tdd | `npx vitest run tests/rag/query/kb-languages.test.ts` | ⬜ pending |
| 06-16-02 | 4 | tdd | `npx vitest run tests/rag/query/translate.test.ts` | ⬜ pending |
| 06-17-01 | 4 | tdd | `npx vitest run tests/rag/cache/keys.test.ts` | ⬜ pending |
| 06-17-02 | 4 | tdd | `npx vitest run tests/rag/cache/bypass.test.ts` | ⬜ pending |
| 06-18-01 | 4 | tdd | `node --test scripts/tests/check-rag-boundary.node-test.mjs && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 06-18-02 | 4 | tdd | `node --test scripts/tests/check-rag-boundary.node-test.mjs && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 06-19-01 | 5 | tdd | `npx vitest run tests/rag/query/run-layer.test.ts tests/rag/query/condense.test.ts` | ⬜ pending |
| 06-19-02 | 5 | tdd | `npx vitest run tests/rag/query/delays.test.ts` | ⬜ pending |
| 06-19-03 | 5 | tdd | `npx vitest run tests/rag/query/status.test.ts tests/rag/status.test.ts tests/rag/v2/refusal-routing.test.ts tests/chat-strict.test.ts` | ⬜ pending |
| 06-20-01 | 5 | tdd | `npx vitest run tests/rag/v2/variants-fusion.test.ts tests/rag/v2/translation-seam.test.ts` | ⬜ pending |
| 06-20-02 | 5 | tdd | `npx vitest run tests/rag/v2/variants-fusion.test.ts tests/rag/v2/search-stages.test.ts tests/rag/v2/exact-id-rrf.test.ts` | ⬜ pending |
| 06-21-01 | 5 | tdd | `npx vitest run tests/rag/cache/pgvector.test.ts && node --import tsx --test tests/rag-db/semantic-cache-adapter.test.mts` | ⬜ pending |
| 06-21-02 | 5 | tdd | `npx vitest run tests/rag/cache/redisvl-http.test.ts tests/rag/cache/pgvector.test.ts && npm run typecheck:new` | ⬜ pending |
| 06-21-03 | 5 | tdd | `npx vitest run tests/rag/cache/invalidation-emit.test.ts tests/rag/ingest` | ⬜ pending |
| 06-22-01 | 5 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 06-22-02 | 5 | checkpoint | `orchestrator-only install, lock and sync after approval, not before 2026-12-04 (see plan); executor then checks npm ls zod openai --all, uv lock --check` | ⬜ pending |
| 06-22-03 | 5 | tdd | `node --test scripts/tests/check-zod-isolation.node-test.mjs && node scripts/ci/check-zod-isolation.mjs && npm ls zod --all && npx next typegen && npx tsc --noEmit -p tsconfig.json && npm run build && uv run --frozen --directory eval python ../scripts/ci/check-workflows.py` | ⬜ pending |
| 06-22-04 | 5 | tdd | `uv lock --directory rag-sidecar --check && uv run --directory rag-sidecar --frozen --no-sync pytest -q tests/test_dependency_boundary.py` | ⬜ pending |
| 06-23-01 | 6 | tdd | `npx vitest run tests/rag/query/translate-slot.test.ts tests/rag/v2/translation-seam.test.ts tests/rag/query/run-layer.test.ts` | ⬜ pending |
| 06-23-02 | 6 | tdd | `node --import tsx --test tests/rag-db/cross-language-query.test.mts` | ⬜ pending |
| 06-24-01 | 6 | tdd | `npx vitest run tests/rag/backend/pgvector-adapter.test.ts tests/rag/v2/variants-fusion.test.ts tests/rag/backend-conformance` | ⬜ pending |
| 06-24-02 | 6 | tdd | `node --import tsx --test tests/rag-db/query-dates-undated.test.mts` | ⬜ pending |
| 06-25-01 | 6 | tdd | `npx vitest run tests/rag/v2/subq-coverage.test.ts` | ⬜ pending |
| 06-25-02 | 6 | tdd | `npx vitest run tests/rag/v2/rerank-standalone.test.ts tests/rag/v2/rerank-stage.test.ts tests/rag/v2/refusal-routing.test.ts tests/chat-strict.test.ts` | ⬜ pending |
| 06-26-01 | 6 | tdd | `npx vitest run tests/rag/v2/retrieval-port.test.ts` | ⬜ pending |
| 06-26-02 | 6 | tdd | `npx vitest run tests/rag/v2/retrieval-port.test.ts tests/rag/v2/variants-fusion.test.ts tests/rag/v2/search-stages.test.ts` | ⬜ pending |
| 06-27-01 | 6 | tdd | `npx vitest run tests/rag/query/history.test.ts` | ⬜ pending |
| 06-27-02 | 6 | tdd | `npx vitest run tests/rag/chat-query-layer.test.ts tests/rag/characterize-chat.test.ts tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/chat-source-images.test.ts` | ⬜ pending |
| 06-27-03 | 6 | tdd | `npx vitest run tests/rag/embed-query-layer.test.ts tests/rag/characterize-embed.test.ts tests/rag/embed-route.test.ts` | ⬜ pending |
| 06-28-01 | 6 | tdd | `npx vitest run tests/rag/voice-rag-route.test.ts tests/rag/voice-rag-two-tenant.test.ts tests/rag/characterize-voice.test.ts tests/rag/entrypoints-voice.test.ts` | ⬜ pending |
| 06-28-02 | 6 | tdd | `npx vitest run tests/rag/query/voice-budget.test.ts tests/rag/v2/voice-budget.test.ts` | ⬜ pending |
| 06-29-01 | 6 | tdd | `npx vitest run tests/eval-route-query-layer.test.ts tests/eval-route-v2.test.ts tests/eval-route-auth.test.ts` | ⬜ pending |
| 06-29-02 | 6 | tdd | `node --import tsx --test tests/rag-db/eval-query-layer-overlay.test.mts tests/rag-db/eval-v2-overlay.test.mts && npm run test-rag -- --run-config eval/config/runs/query-layer-llamaindex.json --no-gate --out eval/out/p6-29-ql` | ⬜ pending |
| 06-30-01 | 6 | tdd | `uv run --directory rag-sidecar --frozen --no-sync pytest -q tests/test_cache_service.py` (environment synced with the cache extra by the orchestrator in 06-22 Task 2) | ⬜ pending |
| 06-30-02 | 6 | tdd | `uv run --directory rag-sidecar --frozen --no-sync pytest -q tests/test_cache_endpoints.py tests/test_auth.py tests/test_boot.py` | ⬜ pending |
| 06-31-01 | 7 | tdd | `cd voice-agent && npm test` | ⬜ pending |
| 06-31-02 | 7 | tdd | `cd voice-agent && npm test && cd .. && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 06-32-01 | 7 | tdd | `npx vitest run tests/rag/v2/config-hash-query.test.ts tests/rag/v2/params-hash.test.ts` | ⬜ pending |
| 06-32-02 | 7 | tdd | `npx vitest run tests/rag/cache/stage.test.ts tests/rag/v2/variants-fusion.test.ts tests/rag/query/run-layer.test.ts` | ⬜ pending |
| 06-32-03 | 7 | tdd | `npx vitest run tests/rag/cache/stage-hit.test.ts tests/rag/query/status.test.ts tests/rag/status.test.ts` | ⬜ pending |
| 06-33-01 | 7 | tdd | `npx vitest run tests/rag/prompt-answer-language.test.ts && node --import tsx --test tests/prompt-context.test.mts` | ⬜ pending |
| 06-33-02 | 7 | tdd | `npx vitest run tests/rag/prompt-answer-language.test.ts tests/rag/characterize-chat.test.ts tests/rag/characterize-embed.test.ts tests/eval-harness.test.ts` | ⬜ pending |
| 06-34-01 | 7 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_latency_contract.py` | ⬜ pending |
| 06-34-02 | 7 | tdd | `npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts && uv run --directory rag-sidecar … (full command in the plan)` | ⬜ pending |
| 06-34-03 | 7 | tdd | `uv run --directory eval pytest -q tests/test_report_query.py tests/test_report_v2.py tests/test_latency_report.py` | ⬜ pending |
| 06-35-01 | 7 | tdd | `npx vitest run tests/rag/query/langchain-adapter.test.ts -t "chat model" && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 06-35-02 | 7 | tdd | `npx vitest run tests/rag/query/langchain-adapter.test.ts` | ⬜ pending |
| 06-35-03 | 7 | tdd | `npx vitest run tests/rag/query/langchain-adapter.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 06-36-01 | 8 | tdd | `npx vitest run tests/rag/cache/store-after.test.ts` | ⬜ pending |
| 06-36-02 | 8 | tdd | `npx vitest run tests/rag/chat-cache-hit.test.ts tests/rag/characterize-chat.test.ts tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/chat-source-images.test.ts` | ⬜ pending |
| 06-36-03 | 8 | tdd | `npx vitest run tests/rag/embed-cache.test.ts tests/rag/characterize-embed.test.ts tests/rag/embed-route.test.ts` | ⬜ pending |
| 06-37-01 | 8 | tdd | `npx vitest run tests/rag/query/framework-parity.test.ts tests/rag/query/langchain-adapter.test.ts` | ⬜ pending |
| 06-37-02 | 8 | tdd | `npx vitest run tests/rag/query/langchain-ensemble.test.ts tests/rag/v2/retrieval-port.test.ts tests/rag/query/run-layer.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 06-37-03 | 8 | tdd | `node --import tsx --test tests/rag-db/query-layer-langchain.test.mts && npx vitest run tests/rag/config.test.ts` | ⬜ pending |
| 06-38-01 | 7 | auto | `mkdir -p eval/out/p6-38-pre && cp eval/baselines/fixture-baseline.json eval/baselines/fixture-ingest-baseline.json eval/out/p6-38-pre/ && npm run test-rag -- --out eval/out/p6-38-legacy && jq -e '.passed == true and .paired.all_zero == true' … (full command in the plan)` | ⬜ pending |
| 06-38-02 | 7 | tdd | `uv run --directory eval pytest -q tests/test_golden_phase6.py tests/test_fixture_coverage.py tests/test_split.py && uv run --project rag-sidecar python -m rag_sidecar.contracts.validate --model GoldenItem --jsonl eval/fixtures/golden.jsonl && npx … (full command in the plan)` | ⬜ pending |
| 06-38-03 | 7 | auto | `jq -n -e --slurpfile a eval/out/p6-38-pre/fixture-baseline.json --slurpfile b eval/baselines/fixture-baseline.json '[$a[0].items \| keys[] as $k \| select($a[0].items[$k] != $b[0].items[$k])] \| length == 0' && jq -n -e --slurpfile a … (full command in the plan)` | ⬜ pending |
| 06-39-01 | 8 | tdd | `uv run --directory eval pytest -q tests/test_golden_phase6.py tests/test_fixture_coverage.py tests/test_split.py && uv run --project rag-sidecar python -m rag_sidecar.contracts.validate --model GoldenItem --jsonl eval/fixtures/golden.jsonl` | ⬜ pending |
| 06-39-02 | 8 | auto | `jq -n -e --slurpfile a eval/out/p6-39-pre/fixture-baseline.json --slurpfile b eval/baselines/fixture-baseline.json '[$a[0].items \| keys[] as $k \| select($a[0].items[$k] != $b[0].items[$k])] \| length == 0' && jq -n -e --slurpfile a … (full command in the plan)` | ⬜ pending |
| 06-40-01 | 9 | tdd | `npx vitest run tests/rag/semantic-cache-admin-route.test.ts tests/api/admin-auth.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 06-40-02 | 9 | tdd | `npx vitest run tests/ui/config-query-layer-panel.test.ts -t "status"` | ⬜ pending |
| 06-40-03 | 9 | tdd | `npx vitest run tests/ui/config-query-layer-panel.test.ts && node scripts/check-config.mjs` | ⬜ pending |
| 06-41-01 | 9 | tdd | `npx vitest run tests/eval-route-cache.test.ts tests/eval-route-query-layer.test.ts tests/rag/cache/store-after.test.ts` | ⬜ pending |
| 06-41-02 | 9 | tdd | `node --import tsx --test tests/rag-db/cache-pairs.test.mts && npm run test-rag -- --run-config eval/config/runs/query-layer-llamaindex.json --cache-pairs --no-gate --out eval/out/p6-41-pairs` | ⬜ pending |
| 06-41-03 | 9 | tdd | `uv run --directory eval pytest -q tests/test_calibrate_cache.py && uv run --directory eval python -m rag_eval.calibrate cache --pairs eval/out/p6-41-pairs/cache-pairs.json --check` | ⬜ pending |
| 06-41-04 | 9 | tdd | `npx vitest run tests/rag/cache/threshold.test.ts tests/rag/cache/stage.test.ts` | ⬜ pending |
| 06-42-01 | 9 | tdd | `node --import tsx --test tests/rag-db/semantic-cache-canary.test.mts tests/rag-db/semantic-cache-invalidation.test.mts` | ⬜ pending |
| 06-42-02 | 9 | tdd | `node --import tsx --test tests/rag-db/v2-two-tenant-matrix.test.mts && npx vitest run tests/rag/v2/routes-two-tenant-v2.test.ts` | ⬜ pending |
| 06-43-01 | 10 | tdd | `uv run --directory eval pytest -q tests/test_compare_frameworks.py tests/test_paired.py` | ⬜ pending |
| 06-43-02 | 10 | auto | `uv run --directory eval python -m rag_eval.compare frameworks --fixtures --out eval/reports/frameworks-fixture && jq -e '.languages \| length >= 3' eval/reports/frameworks-fixture/report.json` | ⬜ pending |
| 06-43-03 | 10 | tdd | `uv run --directory eval python ../scripts/ci/check-workflows.py && uv run --directory eval pytest -q ../scripts/tests/test_check_workflows.py` | ⬜ pending |
| 06-44-01 | 11 | tdd | `uv run --directory eval pytest -q tests/test_phase_compare.py` | ⬜ pending |
| 06-44-02 | 11 | auto | `uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase6-comparison.json --out eval/reports/phase-06 && jq -e '.passed == true' eval/reports/phase-06/comparison.json && npx vitest run … (full command in the plan)` | ⬜ pending |
| 06-45-01 | 12 | tdd | `node --import tsx --test --test-reporter=tap --test-name-pattern="single-tenant setup" tests/rag-db/schema-equality.test.mts && node --import tsx --test --test-reporter=tap --test-name-pattern="multi-tenant setup" tests/rag-db/schema-equality.test.mts` | ⬜ pending |
| 06-45-02 | 12 | auto | `npx vitest run && node --import tsx --test tests/*.test.mts tests/rag-db/*.test.mts && uv run --directory eval pytest -q && uv run --directory rag-sidecar pytest -q && node scripts/check-config.mjs && node scripts/ci/check-rag-boundary.mjs && node … (full command in the plan)` | ⬜ pending |
| 06-46-01 | 13 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 06-46-02 | 13 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 06-46-03 | 13 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 06-46-04 | 13 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `tests/rag/query/` and `tests/rag/cache/` suites with shared fakes: the native fake query LLM (`eval/harness/fake-query-llm.mts`, plan 06-10) and the LangChain fake chat model (`src/lib/rag/query/langchain/fake.ts`, plan 06-35), both reading `eval/fixtures/query-llm/transforms.json`.
- [ ] PGlite suites for migrations 0601 to 0603 in `tests/rag-db/` (plans 06-04, 06-08, 06-12), reusing the Phase 4 harness and role shim.
- [ ] Contract samples for every new Pydantic model in `tests/fixtures/contracts/samples.json` (plans 06-05, 06-11, 06-34).
- [ ] `eval/config/rag-eval-env.json` pins every new RAG_* name and NEXT_PUBLIC_MCP_SYSTEM_ENABLED (plan 06-02).
- [ ] Sidecar cache tests with a fake SemanticCache, plus the import-path case under the `cache` extra (plan 06-30).
- [ ] `scripts/tests/check-zod-isolation.node-test.mjs` with fixture trees, skipping with a notice until LangChain is installed (plan 06-22).

---

## Manual-Only Verifications

| Behaviour | Requirement | Why Manual | Test Instructions |
|-----------|-------------|------------|-------------------|
| Package legitimacy of @langchain/core 1.5.0, @langchain/classic 1.0.62, @langchain/openai 1.8.5, redisvl 0.32.0, redis 8.1.0 | QRY-08, CACHE-01 (A-9) | Never auto-approvable (planner package gate) | 06-22 Task 1 |
| Phase 6 migrations on the real Supabase project; anon refused with the real anon key | XLG-01, CACHE-01 | No hosted Supabase here | 06-46 Task 1 |
| Query model quality in zh, en and it; per-transform p50 and p95 for chat and voice; budgets replaced with measured numbers | QRY-01, QRY-05, QRY-07 (A-8, D-29) | Needs live keys | 06-46 Task 2 |
| LlamaIndex versus LangChain on the real golden set | QRY-08 (D-40) | Needs live keys and the real golden set | 06-46 Task 3 |
| RedisVL against a real Redis with the Query Engine; live cache calibration for the production embedding profile | CACHE-01 (D-35, D-37) | No Redis Query Engine or Docker here | 06-46 Task 4 |
| Config UI Query layer panel walk-through | QRY-08 (D-44) | Visual check | 06-40 Task 3 `<human-check>` |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or a checkpoint
- [x] Sampling continuity: no 3 consecutive tasks without an automated verify
- [x] Wave 0 covers all missing test references
- [x] No watch-mode flags
- [x] Feedback latency under 60 s for per-task commands
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
