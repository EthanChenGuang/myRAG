---
phase: "04"
slug: "hybrid-retrieval-reranking-calibrated-refusal"
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-11-23"
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Every executable task in 04-01 to 04-42, 04-44 and 04-45 has an `<automated>` command; the only non-automated items are the three live-service checkpoints in 04-43 and one Config UI walk-through in 04-36 (end-of-phase human checks).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.1.1 (`tests/**/*.test.ts`); `node --import tsx --test` for `.test.mts` (DB tests live in `tests/rag-db/`, collected by the CI glob from plan 03-01); pytest 9.2.0 for `eval/` and `rag-sidecar/` |
| **Config file** | `vitest.config.ts`; `eval/pyproject.toml`; `rag-sidecar/pyproject.toml` |
| **Quick run command** | `npx vitest run tests/rag/<area>` (plus `node --import tsx --test tests/rag-db/<file>.test.mts` for SQL work) |
| **Full suite command** | `npx vitest run && node --import tsx --test tests/*.test.mts tests/rag-db/*.test.mts && uv run --directory eval pytest -q && uv run --directory rag-sidecar pytest -q && node scripts/check-config.mjs && npm run typecheck:new && node scripts/ci/check-rag-boundary.mjs` |
| **Estimated runtime** | quick: under 30 s per area; full: about 6 to 10 minutes (PGlite suites dominate); smoke tier about 2 minutes per mode |

No test calls a live service. Database tests use PGlite with pgvector 0.8.7; rerankers use recorded responses under `tests/fixtures/rerank/` or the deterministic fake reranker; the judge is skipped with a notice without a key.

---

## Sampling Rate

- **After every task commit:** the task's `<automated>` command (always scoped to the touched area) plus `npm run typecheck:new` for TypeScript changes.
- **After every plan wave:** the full suite command above, plus the legacy smoke tier: `npm run test-rag -- --out eval/out/p4-wave && jq -e '.passed == true and .paired.all_zero == true' eval/out/p4-wave/gate.json` (from wave 7 on, also with `--fixture-mode ingest`).
- **Before `/gsd-verify-work`:** plan 04-42 Task 2 command chain green, `eval/reports/phase-04/comparison.json` passed (plan 04-40), and `npm run gen:schemas` with a clean diff on generated files.
- **Max feedback latency:** 60 seconds for per-task commands (smoke-tier and comparison runs are per-wave or per-plan gates).

---

## Requirement → Test Map (Nyquist map)

| Req | Behaviour that must be observable | Plans | Automated command |
|-----|-----------------------------------|-------|-------------------|
| RET-01 | Backend accepts only a branded TenantScope; scopeKey is the only tenant input; legs shape; isReady true; conformance suite is backend-agnostic | 04-01, 04-17, 04-19, 04-40, 04-41 | `npx vitest run tests/rag/v2-contract-types.test.ts tests/rag/backend/pgvector-adapter.test.ts tests/rag/backend-conformance` |
| RET-02 | Dense and lexical legs filtered before ranking in one RPC; RRF k=60 with chunk-id ties; one-leg case equals dense order | 04-06, 04-11, 04-15, 04-17, 04-19, 04-29 | `npx vitest run tests/rag/fusion tests/rag/v2/search-stages.test.ts && node --import tsx --test tests/rag-db/hybrid-search.test.mts tests/rag-db/hybrid-filters.test.mts tests/rag-db/v2-tracer.test.mts` |
| RET-03 | One tokenizer for chunks and queries (zh words and Han bigrams, codes whole and in parts, en/it folds); lexical index; resumable relex with zero parser and embedding calls; zh exact term in `legs.lexical` | 04-03, 04-06, 04-15, 04-16, 04-17 | `npx vitest run tests/rag/lexical tests/rag/lexical-tokenize.test.ts tests/rag/backend-conformance && node --import tsx --test tests/rag-db/lexical-index.test.mts tests/rag-db/relex.test.mts` |
| RET-04 | anon and authenticated get 42501 on the function; the fake edge with the anon key is refused; malformed and wrong-mode keys raise; two-tenant result equals the workspace predicate; folded setup files keep the revokes | 04-01, 04-05, 04-07, 04-15, 04-17, 04-41, 04-42 | `node --import tsx --test tests/rag-db/harness-roles.test.mts tests/rag-db/hybrid-grants.test.mts tests/rag-db/hybrid-tenant.test.mts tests/rag-db/schema-equality.test.mts` |
| RET-10 | On an indexed synthetic database: iterative scan off returns fewer than k (negative control), relaxed and strict order recall at least 0.9, exact cutoff equals exact search, the same numbers written by the `--report` mode; selective_filter golden category under 3% of rows | 04-02, 04-15, 04-18, 04-37, 04-40 | `node --import tsx --test tests/rag-db/selective-filter.test.mts && uv run --directory eval pytest -q tests/test_fixture_coverage.py` |
| DATA-08 | Date, source, document, type and language filters alone and combined on both legs; empty arrays rejected; filters only narrow; chat, embed and eval bodies validated; invoice filters | 04-02, 04-04, 04-14, 04-15, 04-17, 04-20, 04-21, 04-29, 04-37, 04-41 | `npx vitest run tests/rag/query tests/rag/v2/route-filters.test.ts && node --import tsx --test tests/rag-db/hybrid-filters.test.mts tests/rag-db/v2-invoice-filters.test.mts` |
| RNK-01 | Cohere and Voyage adapters parse recorded responses (no top_n or top_k sent); local_bm25 on zh text; provider, tier and per-language model selection; versioned rerank text; rerank HTTP only under `src/lib/rag/rerank/` | 04-09, 04-10, 04-23, 04-40, 04-45 | `npx vitest run tests/rag/rerank && node scripts/ci/check-rag-boundary.mjs` |
| RNK-02 | Sweep picks the smallest configuration within the noise band, dev split only, never writes params from a fixture run; fixture sweep recorded; the runtime reads the committed params and honours overrides only for eval | 04-04, 04-21, 04-25, 04-39, 04-44 | `uv run --directory eval pytest -q tests/test_sweep_retrieval.py tests/test_fixture_calibration_outputs.py && npx vitest run tests/rag/v2/params-hash.test.ts` |
| RNK-03 | Adjacent merge, token budget, best-at-edges order of document groups; switch off equals rank order; legacy byte identity | 04-12, 04-22, 04-40 | `npx vitest run tests/rag/context tests/rag/v2/context-stages.test.ts tests/rag/assemble.test.ts && node --import tsx --test tests/rag-assemble-differential.test.mts` |
| RNK-04 | Compression off leaves the context byte-identical; kept text verbatim with codepoint offsets; tables, images, short and parent blocks untouched | 04-12, 04-22, 04-40 | `npx vitest run tests/rag/context/compress.test.ts tests/rag/v2/context-stages.test.ts` |
| RNK-05 | Gate refuses only on calibrated cells; floor applies only when the gate is not_applied (D-30); refusal routes through buildContext so strict mode answers information not available (D-31); fit on dev, one-shot holdout, poisoned test scores change nothing; fixture outcome improves correct refusal | 04-04, 04-08, 04-13, 04-20, 04-21, 04-26, 04-30, 04-34, 04-36, 04-38, 04-39, 04-40 | `npx vitest run tests/rag/refusal tests/rag/v2/refusal-routing.test.ts tests/chat-strict.test.ts && uv run --directory eval pytest -q tests/test_calibrate_refusal.py tests/test_calibrate_holdout.py tests/test_fixture_calibration_outputs.py` |
| RNK-06 | Timeout, HTTP error, abort, partial response and budget exhaustion keep the fused order, give degraded and refusal not_applied/reranker_unavailable; `none` is disabled | 04-02, 04-09, 04-13, 04-23, 04-26 | `npx vitest run tests/rag/v2/rerank-stage.test.ts tests/rag/rerank/http-adapters.test.ts tests/rag/refusal/gate.test.ts` |
| CHK-03 | Parents stored separately, only children indexed; a parent once at its best child's rank inside the budget; tenant-scoped fetch; switch off unchanged; clause-slice Recall gain in eval | 04-07, 04-27, 04-31, 04-33, 04-35, 04-38, 04-40, 04-41 | `npx vitest run tests/rag/parents tests/rag/ingest/parent-child-chunker.test.ts && node --import tsx --test tests/rag-db/parents-schema.test.mts tests/rag-db/parents-fetch.test.mts tests/rag-db/profile-chunk-writer.test.mts` |
| CHK-04 | Validation rules equal in Pydantic, TypeScript and the Config UI JS, with the child limit taken from the embedding registry's per-provider maxInputTokens; side-by-side rebuild from stored parse output with zero parser calls; activation gates (incomplete, open_gaps, no_evidence, eval_failed, stale_evidence) and rollback; admin routes behind the S7 guard | 04-04, 04-07, 04-31, 04-32, 04-33, 04-34, 04-35, 04-36 | `uv run --directory rag-sidecar pytest -q tests/test_retrieval_contracts.py && npx vitest run tests/rag/embeddings/registry.test.ts tests/rag/chunking tests/rag/chunking-profile-routes.test.ts tests/ui/config-chunking-panel.test.ts && node --import tsx --test tests/rag-db/rechunk.test.mts tests/rag-db/chunking-activation.test.mts tests/rag-db/chunking-cli.test.mts` |
| CHK-05 | Chunking sweep reports Recall@k, MRR, refusal rates, judge correctness or a skipped notice, context tokens and latency overall and by doc type, language and question kind; gate against legacy; decision recorded with its numbers; report visible to admins | 04-04, 04-26, 04-34, 04-35, 04-36 | `uv run --directory eval pytest -q tests/test_sweep_chunking.py tests/test_report_v2.py && node --import tsx --test tests/rag-db/eval-chunking-profiles.test.mts && npx vitest run tests/rag/chunking-profile-routes.test.ts` |
| LAT-01 | Variants searched concurrently with one signal; dedupe by chunk and parent; rerank input capped (50 to 100); counts in the span | 04-08, 04-11, 04-19, 04-24, 04-25, 04-28, 04-39, 04-44 | `npx vitest run tests/rag/v2/params-hash.test.ts tests/rag/fusion/dedupe.test.ts tests/rag/v2/search-stages.test.ts tests/rag/v2/translation-seam.test.ts tests/rag/stage-runner.test.ts` |
| LAT-02 | Voice uses the fast tier with a 250 ms deadline-capped rerank and stays under 800 ms p95 with injected delays, skipping rerank when the deadline is near | 04-02, 04-23, 04-26, 04-28, 04-40, 04-44, 04-45 | `npx vitest run tests/rag/v2/voice-budget.test.ts tests/rag/rerank/select.test.ts tests/rag/config.test.ts` |
| XLG-03 | Translated variant drives the lexical leg and local_bm25; hosted rerankers get the original; cross-lingual cells calibrated and compared with same-language cells; cross-language golden cells filled | 04-10, 04-13, 04-14, 04-20, 04-23, 04-24, 04-30, 04-38, 04-39, 04-40, 04-45 | `npx vitest run tests/rag/v2/translation-seam.test.ts tests/rag/rerank/local-bm25.test.ts && uv run --directory eval pytest -q tests/test_calibrate_refusal.py tests/test_golden_phase4.py` |

### Cross-cutting checks

| Check | Source | Plans | Automated command |
|-------|--------|-------|-------------------|
| Tenant isolation on every v2 path, profile and route, every switch on | Project constraint C-3, D-01, D-04 | 04-15, 04-17, 04-27, 04-29, 04-31, 04-33, 04-41 | `node --import tsx --test tests/rag-db/v2-two-tenant-matrix.test.mts tests/rag-db/hybrid-tenant.test.mts tests/rag-db/parents-fetch.test.mts && npx vitest run tests/rag/v2/routes-two-tenant-v2.test.ts tests/rag/backend-conformance` |
| Switch off restores today's behaviour (RAG_PIPELINE=legacy, all D-23 switches off): no v2 stage, no startup probe, no retrievalFilters parsing on chat and embed, no ingestion dual-write; stored-data changes (tokenizer v2 lexical_text, D-07/D-08; mintScope lower-casing, D-33) proven by parity instead | ROADMAP rule "behind a switch", D-23 | 04-01, 04-02, 04-03, 04-08, 04-17, 04-19, 04-21, 04-31 (named legacy guards); every plan touching shared paths; 04-42 | `npm run test-rag -- --out eval/out/p4-check && jq -e '.passed == true and .paired.all_zero == true' eval/out/p4-check/gate.json` and the same with `--fixture-mode ingest`; `node --import tsx --test tests/rag-legacy-differential.test.mts`; `npx vitest run tests/rag/v2/route-filters.test.ts -t "RAG_PIPELINE=legacy ignores retrievalFilters"`; `npx vitest run tests/rag/ingest/profile-dual-write.test.ts -t "RAG_PIPELINE=legacy skips dual-write"`; `npx vitest run tests/rag/v2/startup.test.ts -t "RAG_PIPELINE=legacy runs no startup check"` |
| Strict "information not available" preserved under v2 defaults | AGENTS.md §14, D-30, D-31 | 04-13, 04-20, 04-41 | `npx vitest run tests/chat-strict.test.ts tests/rag/v2/refusal-routing.test.ts` |
| Admin routes gated by the S7 guard (checkAdmin: signed admin_session cookie, else the requireRagAdmin session or Bearer path), fail closed, forged cookie and literal bearer refused | ROADMAP "authenticated from the start", Phase 3 D-45 and plan-check W1 | 04-34, 04-36 | `npx vitest run tests/rag/chunking-profile-routes.test.ts tests/api/admin-auth.test.ts tests/rag/rag-admin-guard.test.ts` |
| Env switches in the five config places and the manifest | AGENTS.md rule 5, D-23 | 04-02 | `node scripts/check-config.mjs && npx vitest run tests/rag/config.test.ts` |
| Pydantic source with generated Zod, no drift | Project constraint (Pydantic v2) | 04-04, 04-26 | `npm run gen:schemas && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts` |
| No query, chunk text or key in trace logs | F-22, C-7 | 04-08 | `npx vitest run tests/rag/trace-log.test.ts` |
| No current document silently dropped under an active non-legacy chunking profile: legacy-row fallback in both legs, coverage count in the v2 startup warning, admin list and Config UI, in-place repair by rag:rechunk | D-21, D-23, plan-check pass 2 W1 | 04-15, 04-32, 04-33, 04-34, 04-36 | `node --import tsx --test --test-name-pattern="legacy fallback" tests/rag-db/hybrid-filters.test.mts tests/rag-db/hybrid-tenant.test.mts && node --import tsx --test --test-name-pattern="legacy-mode upload under an active profile" tests/rag-db/chunking-cli.test.mts && node --import tsx --test --test-name-pattern="rechunk repairs an active profile in place" tests/rag-db/rechunk.test.mts && npx vitest run tests/rag/v2/startup.test.ts -t "v2 startup warns about documents missing from the active chunking profile"` (each run must report at least one pass and no failure) |
| Folded setup files apply cleanly on PGlite and equal the migrations, each mode on its own | D-04, Phase 3 D-05, plan-check pass 1 W2 | 04-42 | `node --import tsx --test --test-reporter=tap --test-name-pattern="single-tenant setup" tests/rag-db/schema-equality.test.mts` and the same with `"multi-tenant setup"`, each with `# fail 0` and at least 3 passed |
| Phase completion against the baseline (D-28 a to d) | ROADMAP rule "proven against the baseline", D-28 | 04-40, 04-42 | `uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase4-comparison.json --out eval/reports/phase-04 && jq -e '.passed == true' eval/reports/phase-04/comparison.json` |

---

## Per-Task Verification Map

Requirements and threat references per plan are in `04-PLAN-INDEX.md`. Kind: tracer, tdd (test first), auto, checkpoint.

| Task ID | Wave | Kind | Automated Command | Status |
|---------|------|------|-------------------|--------|
| 04-01-01 | 1 | tdd | `npx vitest run tests/rag/tenant-brand.test.ts tests/rag/tenant-predicate.test.ts tests/rag/resolve-chat-scope.test.ts` | ⬜ pending |
| 04-01-02 | 1 | auto | `npx vitest run tests/rag/v2-contract-types.test.ts tests/rag/status.test.ts tests/rag/pipeline-assembly.test.ts && npm run typecheck:new` | ⬜ pending |
| 04-02-01 | 1 | tdd | `node --test scripts/check-config.test.mjs` | ⬜ pending |
| 04-02-02 | 1 | auto | `node scripts/check-config.mjs && npx vitest run tests/eval-env-pin.test.ts` | ⬜ pending |
| 04-02-03 | 1 | tdd | `npx vitest run tests/rag/config.test.ts tests/rag/stage-runner.test.ts tests/rag/status.test.ts && npm run typecheck:new` | ⬜ pending |
| 04-03-01 | 1 | tdd | `npx vitest run tests/rag/lexical-tokenize.test.ts tests/rag/lexical/tokenize-v2.test.ts` | ⬜ pending |
| 04-03-02 | 1 | tdd | `npx vitest run tests/rag/lexical/chunk-text.test.ts tests/rag/lexical/tokenize-v2.test.ts tests/rag/ingest` | ⬜ pending |
| 04-03-03 | 1 | tdd | `npx vitest run tests/rag/exact-id.test.ts tests/rag/tax-id-vectors.test.ts` (acceptance adds both legacy smoke tiers with `paired.all_zero`) | ⬜ pending |
| 04-04-01 | 1 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_retrieval_contracts.py` | ⬜ pending |
| 04-04-02 | 1 | auto | `npm run gen:schemas && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts && uv run --directory rag-sidecar pytest -q` | ⬜ pending |
| 04-04-03 | 1 | tdd | `uv run --directory eval pytest -q tests/test_config_files.py && uv run --directory eval python -m rag_eval.config_files init` | ⬜ pending |
| 04-05-01 | 1 | tdd | `node --import tsx --test tests/rag-db/harness-roles.test.mts tests/rag-db/schema-migrations.test.mts` | ⬜ pending |
| 04-05-02 | 1 | tdd | `node --import tsx --test tests/fixture-edge.test.mts && npm run test-rag -- --out eval/out/p4-05 && jq -e '.passed == true and .paired.all_zero == true' eval/out/p4-05/gate.json` | ⬜ pending |
| 04-06-01 | 1 | tdd | `node --import tsx --test tests/rag-db/lexical-index.test.mts tests/rag-db/schema-migrations.test.mts` | ⬜ pending |
| 04-06-02 | 1 | tdd | `node --import tsx --test tests/rag-db/lexical-index.test.mts` | ⬜ pending |
| 04-07-01 | 1 | tdd | `node --import tsx --test tests/rag-db/parents-schema.test.mts` | ⬜ pending |
| 04-07-02 | 1 | tdd | `node --import tsx --test tests/rag-db/parents-schema.test.mts tests/rag-db/schema-migrations.test.mts && npm run test-rag -- --out eval/out/p4-07 && jq -e '.paired.all_zero == true' eval/out/p4-07/gate.json` | ⬜ pending |
| 04-07-03 | 1 | tdd | `node --import tsx --test tests/rag-db/parents-schema.test.mts` | ⬜ pending |
| 04-08-01 | 2 | tdd | `npx vitest run tests/rag/stage-runner.test.ts tests/rag/status.test.ts` | ⬜ pending |
| 04-08-02 | 2 | tdd | `npx vitest run tests/rag/trace-log.test.ts tests/rag/langfuse-pins.test.ts` | ⬜ pending |
| 04-09-01 | 2 | tdd | `npx vitest run tests/rag/rerank/http-adapters.test.ts` | ⬜ pending |
| 04-09-02 | 2 | tdd | `npx vitest run tests/rag/rerank/http-adapters.test.ts` | ⬜ pending |
| 04-09-03 | 2 | tdd | `node --test scripts/tests/check-rag-boundary.node-test.mjs && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 04-10-01 | 2 | tdd | `npx vitest run tests/rag/rerank/local-bm25.test.ts tests/rag/local-hybrid.test.ts` | ⬜ pending |
| 04-10-02 | 2 | tdd | `npx vitest run tests/rag/rerank/fake-reranker.test.ts tests/helpers-fakes.test.ts` | ⬜ pending |
| 04-10-03 | 2 | tdd | `node --import tsx --test tests/fixture-edge.test.mts` | ⬜ pending |
| 04-11-01 | 2 | tdd | `npx vitest run tests/rag/fusion/rrf.test.ts` | ⬜ pending |
| 04-11-02 | 2 | tdd | `npx vitest run tests/rag/fusion/dedupe.test.ts` | ⬜ pending |
| 04-12-01 | 2 | tdd | `npx vitest run tests/rag/context/assembly-helpers.test.ts` | ⬜ pending |
| 04-12-02 | 2 | tdd | `npx vitest run tests/rag/context/build-context-order.test.ts tests/rag/assemble.test.ts tests/rag/legacy-chat-assembly-oracle.test.ts && node --import tsx --test tests/rag-assemble-differential.test.mts` | ⬜ pending |
| 04-12-03 | 2 | tdd | `npx vitest run tests/rag/context/compress.test.ts` | ⬜ pending |
| 04-13-01 | 2 | tdd | `npx vitest run tests/rag/refusal/gate.test.ts` | ⬜ pending |
| 04-13-02 | 2 | tdd | `npx vitest run tests/rag/refusal/floor.test.ts` | ⬜ pending |
| 04-14-01 | 2 | tdd | `npx vitest run tests/rag/query/filters.test.ts` | ⬜ pending |
| 04-14-02 | 2 | tdd | `npx vitest run tests/rag/query/timeframe.test.ts tests/rag/query/language.test.ts` | ⬜ pending |
| 04-15-01 | 2 | tdd | `node --import tsx --test tests/rag-db/hybrid-search.test.mts tests/rag-db/hybrid-grants.test.mts` | ✅ 35/35 trunk |
| 04-15-02 | 2 | tdd | `node --import tsx --test tests/rag-db/hybrid-tenant.test.mts` (includes `legacy fallback stays inside the tenant`) | ✅ (same run) |
| 04-15-03 | 2 | tdd | `node --import tsx --test tests/rag-db/hybrid-filters.test.mts && npm run test-rag -- --out eval/out/p4-15 && jq -e '.paired.all_zero == true' eval/out/p4-15/gate.json` (includes `legacy fallback for a document missing from the active profile`) | ✅ filters in suite; smoke deferred (uv) |
| 04-16-01 | 2 | tdd | `node --import tsx --test tests/rag-db/relex.test.mts` | ✅ 9/9 trunk |
| 04-16-02 | 2 | auto | `node --import tsx --test tests/rag-db/relex.test.mts tests/two-tenant-fixture.test.mts && npm run test-rag -- --out eval/out/p4-16 && jq -e '.passed == true and .paired.all_zero == true' eval/out/p4-16/gate.json` | ✅ 8/8 two-tenant; smoke deferred (uv ENOENT) |
| 04-17-01 | 3 | tdd | `npx vitest run tests/rag/backend/pgvector-adapter.test.ts` | ✅ trunk |
| 04-17-02 | 3 | tdd | `npx vitest run tests/rag/backend-conformance` | ✅ 42 tests total w/ startup |
| 04-17-03 | 3 | tdd | `npx vitest run tests/rag/v2/startup.test.ts tests/rag/instrumentation.test.ts && node scripts/ci/check-rag-boundary.mjs` | ✅ boundary ok |
| 04-18-01 | 3 | auto | builder smoke: import `createSelectiveFilterDatabase` and count rows (exact command in 04-18-PLAN.md Task 1) | ⬜ pending |
| 04-18-02 | 3 | tdd | `node --import tsx --test tests/rag-db/selective-filter.test.mts` | ⬜ pending |
| 04-18-03 | 3 | tdd | `node --import tsx --test tests/rag-db/selective-filter.test.mts` (report-mode case; moved from 04-40) | ⬜ pending |
| 04-44-01 | 3 | tdd | `npx vitest run tests/rag/v2/params-hash.test.ts` | ✅ 15 trunk |
| 04-44-02 | 3 | tdd | `npx vitest run tests/rag/v2/params-hash.test.ts` | ✅ (same) |
| 04-45-01 | 3 | tdd | `npx vitest run tests/rag/rerank/text.test.ts` | ✅ trunk |
| 04-45-02 | 3 | tdd | `npx vitest run tests/rag/rerank/select.test.ts` | ✅ 13 total |
| 04-19-01 | 4 | tracer | `node --import tsx --test tests/rag-db/v2-tracer.test.mts && node --import tsx --test tests/rag-legacy-differential.test.mts` | ✅ trunk 6 |
| 04-19-02 | 4 | tdd | `npx vitest run tests/rag/v2/search-stages.test.ts tests/rag/status.test.ts` | ✅ 18 |
| 04-20-01 | 5 | tdd | `npx vitest run tests/rag/v2/refusal-routing.test.ts tests/rag/v2/search-stages.test.ts` | ⬜ pending |
| 04-20-02 | 5 | tdd | `npx vitest run tests/rag/v2/refusal-routing.test.ts tests/rag/status.test.ts` | ⬜ pending |
| 04-20-03 | 5 | tdd | `npx vitest run tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/rag/characterize-chat.test.ts` | ⬜ pending |
| 04-21-01 | 5 | tdd | `npx vitest run tests/eval-route-v2.test.ts tests/eval-route-auth.test.ts tests/eval-harness.test.ts` | ⬜ pending |
| 04-21-02 | 5 | tdd | `node --import tsx --test tests/rag-db/eval-v2-overlay.test.mts && npm run test-rag -- --run-config eval/config/runs/v2-all-off.json --no-gate --out eval/out/p4-21-v2-all-off` | ⬜ pending |
| 04-21-03 | 5 | tdd | `npx vitest run tests/rag/v2/route-filters.test.ts tests/rag/characterize-chat.test.ts tests/rag/characterize-embed.test.ts tests/rag/embed-route.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 04-22-01 | 5 | tdd | `npx vitest run tests/rag/v2/context-stages.test.ts tests/rag/assemble.test.ts` | ⬜ pending |
| 04-22-02 | 5 | tdd | `npx vitest run tests/rag/v2/context-stages.test.ts` | ⬜ pending |
| 04-23-01 | 6 | tdd | `npx vitest run tests/rag/v2/rerank-stage.test.ts tests/rag/v2/refusal-routing.test.ts` | ⬜ pending |
| 04-23-02 | 6 | auto | v2-recommended fixture run with every rerank stage ok (exact command in 04-23-PLAN.md Task 2) | ⬜ pending |
| 04-24-01 | 6 | tdd | `npx vitest run tests/rag/v2/translation-seam.test.ts` | ⬜ pending |
| 04-24-02 | 6 | tdd | `npx vitest run tests/rag/v2/translation-seam.test.ts tests/rag/v2/search-stages.test.ts` | ⬜ pending |
| 04-25-01 | 6 | tdd | `uv run --directory eval pytest -q tests/test_sweep_retrieval.py -k harness` | ⬜ pending |
| 04-25-02 | 6 | tdd | `uv run --directory eval pytest -q tests/test_sweep_retrieval.py` | ⬜ pending |
| 04-26-01 | 6 | tdd | `uv run --directory eval pytest -q tests/test_bounds.py` | ⬜ pending |
| 04-26-02 | 6 | tdd | `uv run --directory eval pytest -q tests/test_report_v2.py tests/test_report_runner.py && npm run gen:schemas && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts` | ⬜ pending |
| 04-26-03 | 6 | auto | `npm run gen:schemas && npx vitest run tests/contracts.test.ts && uv run --directory eval pytest -q` | ⬜ pending |
| 04-27-01 | 6 | tdd | `npx vitest run tests/rag/parents/expand.test.ts` | ⬜ pending |
| 04-27-02 | 6 | tdd | `npx vitest run tests/rag/v2/context-stages.test.ts tests/rag/parents/expand.test.ts && node --import tsx --test tests/rag-db/parents-fetch.test.mts` | ⬜ pending |
| 04-28-01 | 7 | tdd | `npx vitest run tests/rag/characterize-voice.test.ts tests/rag/voice-rag-route.test.ts tests/rag/entrypoints-voice.test.ts` | ⬜ pending |
| 04-28-02 | 7 | tdd | `npx vitest run tests/rag/v2/voice-budget.test.ts` | ⬜ pending |
| 04-29-01 | 7 | tdd | `npx vitest run tests/rag/v2/exact-id-rrf.test.ts tests/rag/v2/search-stages.test.ts tests/rag/exact-id.test.ts` | ⬜ pending |
| 04-29-02 | 7 | tdd | `node --import tsx --test tests/rag-db/v2-invoice-filters.test.mts` | ⬜ pending |
| 04-30-01 | 7 | tdd | `uv run --directory eval pytest -q tests/test_calibrate_refusal.py` | ⬜ pending |
| 04-30-02 | 7 | tdd | `uv run --directory eval pytest -q tests/test_calibrate_holdout.py` | ⬜ pending |
| 04-30-03 | 7 | tdd | `uv run --directory eval pytest -q tests/test_calibrate_refusal.py tests/test_calibrate_holdout.py` | ⬜ pending |
| 04-31-01 | 7 | tdd | `node --import tsx --test tests/rag-db/profile-chunk-writer.test.mts` | ⬜ pending |
| 04-31-02 | 7 | tdd | `npx vitest run tests/rag/ingest/parent-child-chunker.test.ts tests/rag/ingest/legal-clauses.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 04-31-03 | 7 | tdd | `npx vitest run tests/rag/ingest/profile-dual-write.test.ts tests/rag/ingest && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 04-37-01 | 7 | tdd | corpus loader tests, per-item baseline equality in both modes (jq over `.items`), smoke gate (exact chain in 04-37-PLAN.md Task 1) | ⬜ pending |
| 04-37-02 | 7 | tdd | `uv run --directory eval pytest -q tests/test_fixture_coverage.py tests/test_split.py && uv run --project rag-sidecar python -m rag_sidecar.contracts.validate --model GoldenItem --jsonl eval/fixtures/golden.jsonl` | ⬜ pending |
| 04-37-03 | 7 | auto | per-item baseline equality for every pre-existing id, then both smoke tiers with `paired.all_zero` (exact chain in 04-37-PLAN.md Task 3) | ⬜ pending |
| 04-32-01 | 8 | tdd | `node --import tsx --test tests/rag-db/rechunk.test.mts` (includes `rechunk repairs an active profile in place`) | ⬜ pending |
| 04-32-02 | 8 | auto | `node --import tsx --test tests/rag-db/rechunk.test.mts` | ⬜ pending |
| 04-38-01 | 8 | tdd | `uv run --directory eval pytest -q tests/test_golden_phase4.py tests/test_fixture_coverage.py tests/test_split.py` | ⬜ pending |
| 04-38-02 | 8 | tdd | `uv run --directory eval pytest -q tests/test_ingest_golden.py` | ⬜ pending |
| 04-38-03 | 8 | auto | per-item baseline equality in both modes, then both smoke tiers with `paired.all_zero` against the re-recorded baselines (exact chain in 04-38-PLAN.md Task 3) | ⬜ pending |
| 04-41-01 | 8 | tdd | `node --import tsx --test tests/rag-db/v2-two-tenant-matrix.test.mts tests/rag-two-tenant.test.mts tests/two-tenant-fixture.test.mts` | ⬜ pending |
| 04-41-02 | 8 | tdd | `npx vitest run tests/rag/v2/routes-two-tenant-v2.test.ts tests/rag/chat-two-tenant.test.ts` | ⬜ pending |
| 04-33-01 | 9 | tdd | `node --import tsx --test tests/rag-db/chunking-activation.test.mts tests/rag-db/profile-chunk-writer.test.mts` (includes `rag_chunking_coverage counts documents missing from each profile`) | ⬜ pending |
| 04-33-02 | 9 | tdd | `npx vitest run tests/rag/embeddings/registry.test.ts tests/rag/chunking/profile-validate.test.ts && npm run typecheck:new` | ⬜ pending |
| 04-33-03 | 9 | tdd | `node --import tsx --test tests/rag-db/chunking-cli.test.mts && npm run typecheck:new && node scripts/ci/check-rag-boundary.mjs` (includes `legacy-mode upload under an active profile stays retrievable and is counted missing`) | ⬜ pending |
| 04-39-01 | 9 | auto | `uv run --directory eval python -m rag_eval.sweep retrieval --run-config eval/config/runs/v2-recommended.json --out eval/reports/retrieval-sweep-fixture && git diff --exit-code eval/config/retrieval-params.json` | ⬜ pending |
| 04-39-02 | 9 | auto | calibration run twice with identical checksums (exact chain in 04-39-PLAN.md Task 2) | ⬜ pending |
| 04-39-03 | 9 | tdd | `uv run --directory eval pytest -q tests/test_fixture_calibration_outputs.py` | ⬜ pending |
| 04-35-01 | 10 | tdd | `node --import tsx --test tests/rag-db/eval-chunking-profiles.test.mts tests/rag-db/eval-v2-overlay.test.mts` | ⬜ pending |
| 04-35-02 | 10 | tdd | `uv run --directory eval pytest -q tests/test_sweep_chunking.py tests/test_sweep_retrieval.py` | ⬜ pending |
| 04-35-03 | 10 | auto | `uv run --project rag-sidecar python -m rag_sidecar.contracts.validate --model ChunkingSweepReport --json eval/reports/chunking-sweep.json && uv run --project rag-sidecar python -m rag_sidecar.contracts.validate --model ChunkingDecision --json eval/decisions/chunking/contract_legal.json` | ⬜ pending |
| 04-34-01 | 11 | tdd | `npx vitest run tests/rag/chunking-profile-routes.test.ts tests/api/admin-auth.test.ts && npm run typecheck:new` (includes missing_from_active in GET /) | ⬜ pending |
| 04-34-02 | 11 | tdd | `npx vitest run tests/rag/chunking-profile-routes.test.ts tests/routes/async-params.test.ts` | ⬜ pending |
| 04-34-03 | 11 | tdd | `npx vitest run tests/rag/refusal/status.test.ts tests/rag/refusal tests/rag/v2/startup.test.ts` | ⬜ pending |
| 04-40-01 | 11 | tdd | `uv run --directory eval pytest -q tests/test_phase_compare.py` | ⬜ pending |
| 04-40-02 | 11 | auto | `uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase4-comparison.json --out eval/reports/phase-04 && jq -e '.passed == true' eval/reports/phase-04/comparison.json` | ⬜ pending |
| 04-36-01 | 12 | tdd | `npx vitest run tests/ui/config-chunking-panel.test.ts && node --check scripts/config-ui/rag-panels/chunking-validate.js` | ⬜ pending |
| 04-36-02 | 12 | tdd + human-check | `npx vitest run tests/ui/config-chunking-panel.test.ts tests/ui/config-rag-panels.test.ts && node --check scripts/config-ui/rag-panels/chunking-profiles.js && node scripts/check-config.mjs` | ⬜ pending |
| 04-36-03 | 12 | tdd | `npx vitest run tests/ui/config-chunking-panel.test.ts && node --check scripts/config-ui/rag-panels/refusal-calibration.js` | ⬜ pending |
| 04-42-01 | 13 | tdd | `node --import tsx --test tests/rag-db/schema-equality.test.mts` (acceptance runs the single-tenant and multi-tenant cases separately) | ⬜ pending |
| 04-42-02 | 13 | auto | full gate chain with the defaults (exact chain in 04-42-PLAN.md Task 2) | ⬜ pending |
| 04-42-03 | 13 | auto | `grep -c "RAG_PIPELINE" AGENTS.md && grep -c "rag:chunking" AGENTS.md` | ⬜ pending |
| 04-43-01 | 14 | checkpoint | live Supabase (human) | ⬜ pending |
| 04-43-02 | 14 | checkpoint | live rerankers (human) | ⬜ pending |
| 04-43-03 | 14 | checkpoint | live calibration and sweep (human) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Sampling continuity: no wave has three consecutive tasks without an automated command; the only non-automated tasks are the three 04-43 checkpoints in the last wave.

---

## Wave 0 Requirements

Research §"Wave 0 Gaps" items and the plan that closes each (they are early-wave tasks, not a separate wave):

- [ ] PGlite shim with Supabase-like roles and default privileges (`eval/harness/pglite-supabase.mts`) — 04-05
- [ ] Fake edge with role mapping by API key, `hybrid_search_chunks`, fake Cohere and Voyage endpoints (`eval/harness/fake-edge.mts`) — 04-05, 04-10
- [ ] `tests/rag/backend-conformance/cases.ts` and `pgvector.test.ts` — 04-17
- [ ] Synthetic selective-filter database builder (`eval/harness/selective-filter.mts`) — 04-18
- [ ] Recorded vendor responses under `tests/fixtures/rerank/` — 04-09
- [ ] Deterministic fake reranker and its test — 04-10
- [ ] Contracts (RetrievalParams, RetrievalFilters, RefusalThresholds, RefusalCalibrationConfig, ChunkingProfile, ChunkingSweepReport, ChunkingDecision; RagRunOptions.retrieval_overrides; RagTrace additions; Category selective_filter) — 04-04 (report fields 04-26)
- [ ] Eval harness run configs, overrides and report slices — 04-21, 04-26
- [ ] `src/lib/rag/config.ts` v2 parsing, stage names, profile-prefixed timeouts — 04-02
- [ ] Trace `counts` and numeric `refusal` in the log payload — 04-08
- [ ] Tenant ids lower-cased at mint time — 04-01
- [ ] Golden additions after parity (selective_filter, no-answer near-miss incl. cross-language, English test items, clause items) — 04-37, 04-38
- [ ] `tests/rag/status.test.ts` refusal-precedence cases — 04-20
- [ ] CI: new DB suites live in `tests/rag-db/` (collected by the plan 03-01 glob step); new vitest suites under `tests/**/*.test.ts`; no workflow edit needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Chunking profiles panel walk-through (create with warning, build, refused activation, rollback, report table) | CHK-04, CHK-05 | Needs the running Config UI and an admin sign-in | 04-36 Task 2 `<human-check>` |
| Hosted migration, relex, anon refusal and Chinese lexical search on the real Supabase project; pgvector version and lc_ctype | RET-03, RET-04, RET-10 | No live Supabase project in this environment | 04-43 Task 1 |
| Cohere and Voyage live latency (p50, p95 for 75 chunks), response shapes, rerank-3 versus rerank-2.5 on zh and it | RNK-01, LAT-02, XLG-03 | No live vendor keys | 04-43 Task 2 |
| Live threshold calibration (dev fit, holdout check) and live retrieval sweep on the real golden set; Config UI warnings | RNK-02, RNK-05, XLG-03, CHK-05 | Needs real keys and the real golden set | 04-43 Task 3 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are live-service checkpoints
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (mapped to plans above)
- [x] No watch-mode flags
- [x] Feedback latency < 60 s for per-task commands
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
