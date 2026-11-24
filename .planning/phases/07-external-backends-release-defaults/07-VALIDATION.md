---
phase: "07"
slug: "external-backends-release-defaults"
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-11-24"
---

# Phase 07 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Every executable task in 07-01 to 07-31, and Task 4 of 07-33, has an `<automated>` command. The non-automated items are the package-legitimacy checkpoint for @weaviate/node 3.15.5 and @qdrant/js-client-rest 1.20.0 (07-01 Task 1, blocking-human, never auto-approvable), the three human decisions and actions in 07-32 (Vercel plan and scheduler, hosting with region and read-only keys, backend-canary branch protection), the three live checkpoints in 07-33, and one Config UI walk-through in 07-29 (a `<human-check>` under end-of-phase mode).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (`tests/**/*.test.ts`); `node --import tsx --test` for `.test.mts` (PGlite DB tests in `tests/rag-db/`); `node --test` for `scripts/**/*.node-test.mjs` and `scripts/check-config.test.mjs`; pytest through `uv` for `eval/` and `rag-sidecar/`; `unittest` for `scripts/tests/test_check_workflows.py` |
| **Config file** | `vitest.config.ts`; `eval/pyproject.toml`; `rag-sidecar/pyproject.toml` |
| **Services** | None in the default run. Weaviate and Qdrant run only where `QDRANT_URL` / `WEAVIATE_URL` are set: locally through `docker-compose.backends.yml` (digest-pinned, plan 07-01) or in the `backend-canary` CI job (plan 07-16). The pgvector leg runs on PGlite 0.5.17 with pgvector everywhere |
| **Quick run command** | `npx vitest run tests/rag/sync tests/rag/backend tests/rag/canary` (plus `node --import tsx --test tests/rag-db/<file>.test.mts` for SQL work) |
| **Full suite command** | `npx vitest run && node --import tsx --test tests/*.test.mts tests/rag-db/*.test.mts && uv run --directory eval pytest -q && uv run --directory rag-sidecar pytest -q && node --test scripts/tests/check-rag-boundary.node-test.mjs scripts/tests/gen-vendor-doc.node-test.mjs scripts/tests/check-release-defaults.node-test.mjs scripts/check-config.test.mjs && node scripts/check-config.mjs && node scripts/ci/check-rag-boundary.mjs && node scripts/check-release-defaults.mjs && node scripts/rag/gen-vendor-doc.mjs --check && node scripts/rag/gen-pipeline-doc.mjs --check && npm run typecheck:new`, plus the `backend-canary` job: `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant npx vitest run tests/rag/canary tests/rag/backend-conformance` |
| **Estimated runtime** | quick: under 30 s per area; full: about 10 to 14 minutes (PGlite suites dominate); backend-canary job: about 10 minutes including image pulls; fixture regression (07-25): about 1 hour |

No test calls a live vendor. Stores are the in-process fake store (`src/lib/rag/sync/stores/fake.ts`, plan 07-06) or the pinned containers; SQL runs on PGlite (single connection, so claim concurrency is tested as sequential claims plus lease expiry; the concurrent `SKIP LOCKED` case runs live in 07-33 Task 1); provider probes use fetch fakes; the sidecar uses TestClient with a mocked transport.

---

## Sampling Rate

- **After every task commit:** the task's `<automated>` command, plus `npm run typecheck:new` for TypeScript changes.
- **After every plan wave:** the full suite command, plus the default smoke tier `npm run test-rag -- --out eval/out/p7-wave && jq -e '.passed == true and .paired.all_zero == true' eval/out/p7-wave/gate.json` (Phase 7 off equals Phase 6). From wave 3 on, also the compose-backed run of `tests/rag/backend-conformance` where a Docker daemon exists; otherwise the `backend-canary` job on the pull request is the gate.
- **Before `/gsd-verify-work`:** plan 07-31 Task 2 command chain green, `backend-canary` green on the pull request, `eval/config/release-defaults.json` validates (provisional until 07-33), and `npm run gen:schemas` with a clean diff.
- **Max feedback latency:** 60 seconds for per-task commands (smoke tiers, the regression and the canary job are per-wave or per-plan gates).

---

## Requirement → Test Map (Nyquist map)

| Req | Behaviour that must be observable | Plans | Automated command |
|-----|-----------------------------------|-------|-------------------|
| RET-05 | Statement-level triggers enqueue once per document and target on insert, synced-column update, delete and FK cascade, tenant move and profile flip, and are a no-op with no enabled target; claim with per-entity live-lease exclusion, backoff through lease_until, dead at 8; drain converges stores to servable rows (quarantine, supersede, soft delete, release, re-embed) in bounded, resumable slices; route, kick and CLI; reconcile detects and repairs injected drift on the fake store and on real stores | 07-02, 07-05, 07-06, 07-09, 07-10, 07-11, 07-13, 07-16 | `node --import tsx --test tests/rag-db/vector-sync-triggers.test.mts tests/rag-db/vector-sync-claim.test.mts tests/rag-db/vector-sync-tracer.test.mts tests/rag-db/vector-sync-reconcile.test.mts tests/rag-db/vector-sync-cli.test.mts && npx vitest run tests/rag/sync` and, in backend-canary, `npx vitest run tests/rag/canary/reconcile-drift.test.ts` |
| RET-06 | One canonical lower-case tenant key; Qdrant wrapper scopes the top-level filter, every prefetch and the IDF corpus and rejects lookup_from, shard_key and global IDF; every adapter and store request passes assertScoped; Weaviate reached only through withTenant, missing tenant means not ready; one collection per profile, is_tenant index before data | 07-01, 07-03, 07-07, 07-08 | `npx vitest run tests/rag/backend/tenant-key.test.ts tests/rag/backend/qdrant-scoped.test.ts tests/rag/backend/qdrant-adapter.test.ts tests/rag/sync/qdrant-store.test.ts tests/rag/backend/weaviate-adapter.test.ts tests/rag/sync/weaviate-store.test.ts && node --test scripts/tests/check-rag-boundary.node-test.mjs` |
| RET-07 | rag_validate_chunks returns exactly current, ready, in-tenant, servable ids with a profile vector (legacy_column branch included), service role only, no switch; every external hit re-validated and hydrated from Supabase, dropped ids counted and logged as `[RAG Security]` with counts only; a planted foreign point is dropped | 07-06, 07-12, 07-14 | `node --import tsx --test tests/rag-db/validate-chunks.test.mts && npx vitest run tests/rag/backend/external-backend.test.ts tests/rag/canary/foreign-point.test.ts` |
| RET-08 | Canary cases (personal vs organization, null organization, s:default, removed member, delete with cascade, version replace, re-embed and activation, quarantine and release, planted foreign point, semantic cache) on pgvector, Weaviate and Qdrant through ingest, outbox and drain; the guard fails, never skips, when a backend is missing in CI; backend-canary is a required check | 07-14, 07-16, 07-28, 07-32 | `npx vitest run tests/rag/canary` (pgvector leg) and `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant npx vitest run tests/rag/canary tests/rag/backend-conformance` (backend-canary job) |
| RET-09 | Index state per (target, profile, tenant) from reconcile; isReady with a 30 s TTL and the lag bound; not ready → pgvector degraded backend_not_ready; error or 800 ms timeout → backend_error; A-8 race → backend_slow; filter_unsupported routes to pgvector; voice uses RAG_RETRIEVAL_BACKEND_VOICE; legacy ignores the backend; activation refused while an enabled backend is not ready | 07-02, 07-04, 07-05, 07-10, 07-11, 07-12, 07-15, 07-25 | `npx vitest run tests/rag/backend/readiness.test.ts tests/rag/backend/fallback.test.ts tests/rag/v2/search-backend.test.ts tests/rag/config.test.ts && node --import tsx --test tests/rag-db/activation-gate-external.test.mts tests/rag-db/eval-external-backend.test.mts` |
| RET-01..03, RET-10 (every backend) | The Phase 4 conformance suite, unchanged (cases.ts not edited), passes on Weaviate and Qdrant: zh, en and it exact terms on the lexical leg over the shared tokenizer, native pre-filters, current versions only, two-tenant isolation, selective_filter equal to exact search, empty and stopword-only lexical queries | 07-07, 07-08, 07-16 | `npx vitest run tests/rag/backend-conformance` with `QDRANT_URL` and `WEAVIATE_URL` set (compose or backend-canary) |
| ADM-01 | Ten D-24 names in the five locations; manifest metadata (group, label, type, options, requires, default, provider) enforced by check-config; generated RAG pipeline section with masked secrets (set or unset plus last 4 at 20 or more characters), Test-connection through the real adapters (admin only, provider enum, 10 s, no key echo), index-compat warnings (not ready, dimension mismatch, legacy pipeline, sync off, dead letters), sync-target toggles | 07-04, 07-15, 07-18, 07-19, 07-20 | `node --test scripts/check-config.test.mjs && node scripts/check-config.mjs && npx vitest run tests/rag/admin tests/scripts/config-server-security.test.ts tests/ui/config-rag-pipeline-panel.test.ts && uv run --directory rag-sidecar pytest -q tests/test_providers_test.py` |
| ADM-02 | Paired p-value on the shared bootstrap; decision rule with noise band, gated slices with min n, latency, injection ASR 0, Holm correction, backend only beyond the CI width, security wins ties, invalid runs on fallback or fake stores; pre-registered plans and the test-split ledger; fixture record provisional; shipped defaults equal the latest record in every D-18 location | 07-17, 07-24, 07-25, 07-30 | `uv run --directory eval pytest -q tests/test_paired.py tests/test_regression_rules.py tests/test_regression.py && node --test scripts/tests/check-release-defaults.node-test.mjs && node scripts/check-release-defaults.mjs` |
| ADM-03 | README_RAG_PIPELINE.md covers sidecar, providers and switches (generated tables), sync and scheduler, backends and the eval workflow; `.env` template grouped by manifest group; AGENTS.md section and §2, §6, §16, §17 | 07-27 | `npx vitest run tests/rag/rag-pipeline-doc.test.ts tests/rag/env-template-groups.test.ts tests/rag/agents-guide.test.ts && node scripts/rag/gen-pipeline-doc.mjs --check` |
| ADM-04 | Vendor data-flow inventory validated by VendorDataFlow for all fifteen vendors, lexical_text and vectors listed as content for Weaviate and Qdrant, generated Markdown checked in CI, check-config ties every url or secret provider to an entry | 07-17, 07-21 | `node --test scripts/tests/gen-vendor-doc.node-test.mjs scripts/check-config.test.mjs && node scripts/rag/gen-vendor-doc.mjs --check && node scripts/check-config.mjs` |
| EVAL-17 | Promote via a ReviewPromotion file: production provenance, frozen split, exact-quote spans, 3-gram Jaccard ≥ 0.85 needs a recorded confirm, no delete, loader fails on a missing manifest id, the next eval run includes the item; pull fills retrieved chunk ids; review-chunks route returns text only for the trace's ids under the trace's tenant, audited; config-server panel promotes with execFile and no shell; failure report by layer and category, nightly when private data exists | 07-17, 07-22, 07-23, 07-26, 07-29 | `uv run --directory eval pytest -q tests/test_matching.py tests/test_split.py tests/test_review_queue.py tests/test_failure_report.py && npx vitest run tests/rag/admin/review-chunks.test.ts tests/rag/trace/langfuse-retrieved-ids.test.ts tests/scripts/config-server-review.test.ts tests/ui/config-review-queue-panel.test.ts` |

### Cross-cutting checks

| Check | Source | Plans | Automated command |
|-------|--------|-------|-------------------|
| Off state equals today: with the defaults (pgvector for chat and voice, no sync target, no secret) no outbox row is written over a full lifecycle, no vendor client is built, no readiness call is made, the kick is a no-op, the drain route answers 503 and the pgvector config hash is unchanged; switching a target or backend on and off restores that state; with every switch at its default both smoke tiers are all-zero against the baseline | D-24, ROADMAP "behind a switch" | 07-02, 07-12, 07-13, 07-28, 07-31 | `node --import tsx --test tests/rag-db/phase7-off-parity.test.mts && npx vitest run tests/rag/backend/fallback.test.ts -t "defaults" && npm run test-rag -- --out eval/out/p7-check && jq -e '.passed == true and .paired.all_zero == true' eval/out/p7-check/gate.json` and the same with `--fixture-mode ingest` |
| Two-tenant test per backend adapter: pgvector (Phase 4 conformance two-tenant case and the canary), Qdrant (filter-evaluating fake plus filter-ignoring fake dropped by re-validation), Weaviate (per-tenant-shard fake plus wrong-shard fake), the external-backend wrapper and both sync stores | Project constraint: cross-tenant leak is the worst failure | 07-06, 07-07, 07-08, 07-14 | `npx vitest run tests/rag/backend/qdrant-adapter.test.ts tests/rag/backend/weaviate-adapter.test.ts tests/rag/sync/qdrant-store.test.ts tests/rag/sync/weaviate-store.test.ts -t "two-tenant" && npx vitest run tests/rag/backend/external-backend.test.ts tests/rag/canary/tenancy.test.ts` |
| Four isolation layers each tested on its own: adapter tenancy (07-03, 07-07, 07-08), re-validation (07-06), servable-only sync (07-09), canaries including the planted foreign point and the cache (07-14, 07-28) | D-07, D-08, D-10, D-02, D-12 | 07-03, 07-06, 07-07, 07-08, 07-09, 07-14, 07-28 | `npx vitest run tests/rag/backend/qdrant-scoped.test.ts -t "negative control" && node --import tsx --test tests/rag-db/validate-chunks.test.mts && npx vitest run tests/rag/sync/drain.test.ts -t "quarantine" tests/rag/canary/foreign-point.test.ts` |
| Vendor clients importable only in the two adapter folders and the sync module; all four Weaviate names and @qdrant/qdrant-js blocked elsewhere | D-09, A-1 | 07-01 | `node --test scripts/tests/check-rag-boundary.node-test.mjs && node scripts/ci/check-rag-boundary.mjs` |
| Package legitimacy: no vector-store client installed before the blocking human checkpoint; exact pins; no install scripts; images pinned by digest | A-1, A-9, planner package gate | 07-01, 07-16 | checkpoint (blocking-human) plus `grep -c '"@qdrant/js-client-rest": "1.20.0"' package.json` and `uv run --directory eval python ../scripts/ci/check-workflows.py` |
| The canary job cannot pass by skipping: guard test in CI mode, no continue-on-error, digests equal to the compose file, retry loop, no secrets in pr-smoke | A-9, research Pitfalls 10 and 11 | 07-14, 07-16 | `! (CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector npx vitest run tests/rag/canary/guard.test.ts) && uv run --directory eval python -m unittest discover -s ../scripts/tests -p 'test_check_workflows.py'` |
| Migrations fold: both setup files apply cleanly on fresh PGlite and equal the migrations, each mode on its own; no client-role privilege on any Phase 7 object | D-01, Phase 3 D-05 | 07-31 | `node --import tsx --test --test-reporter=tap --test-name-pattern="single-tenant setup" tests/rag-db/schema-equality.test.mts` and the same with `"multi-tenant setup"`, each with `# fail 0` |
| Env names in the five config locations and the manifest with metadata; eval pin derived from init-env.js | AGENTS.md rule 5, D-14, D-24 | 07-04, 07-18, 07-27 | `node --test scripts/check-config.test.mjs && node scripts/check-config.mjs && npx vitest run tests/eval-env-pin.test.ts` |
| Pydantic source with generated Zod, no drift | Project constraint (Pydantic v2) | 07-05, 07-17 | `npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts` |
| No chunk text, lexical_text, tenant key or secret in `[Vector Sync]`, `[RAG Security]`, `[RAG Admin]` or `[Failure Report]` output; secrets never leave config-server.js | D-25, D-14, Conventions | 07-06, 07-09, 07-19, 07-20, 07-23, 07-26, 07-29 | `npx vitest run tests/rag/sync/log.test.ts -t "marker" tests/rag/backend/external-backend.test.ts tests/rag/admin/provider-probes.test.ts -t "never leaks" tests/scripts/config-server-security.test.ts tests/scripts/config-server-review.test.ts && uv run --directory eval pytest -q tests/test_failure_report.py` |
| Fail-closed auth: drain route (POST and GET) 503 without a 32-character secret and 401 otherwise; admin routes (providers/test, index-compat, vector-sync/targets, review/chunks) 401, 403 or 503 before any read; sidecar probe endpoint behind the shared secret | ROADMAP "authenticated from the start", D-04, D-15, D-21 | 07-13, 07-15, 07-19, 07-23 | `npx vitest run tests/rag/sync/drain-route.test.ts tests/rag/admin && uv run --directory rag-sidecar pytest -q tests/test_providers_test.py tests/test_auth.py` |
| Shipped defaults equal the latest decision record; a provisional fixture record never moves a default | D-18 | 07-25, 07-30, 07-33 | `node scripts/check-release-defaults.mjs && node --test scripts/tests/check-release-defaults.node-test.mjs` |
| Strict "information not available", webSearch with Exa, `source_images` and `{{context}}` preserved; degraded fallback never reported as information not available | AGENTS.md §14 | 07-12, 07-31 | `npx vitest run tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/chat-source-images.test.ts tests/rag/agents-guide.test.ts` |

---

## Per-Task Verification Map

Requirements and threat references per plan are in each plan and in `07-PLAN-INDEX.md`. Kind: tracer, tdd (test first), auto, checkpoint. Commands longer than one line are shortened here; the plan holds the full command.

| Task ID | Wave | Kind | Automated Command | Status |
|---------|------|------|-------------------|--------|
| 07-01-01 | 1 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 07-01-02 | 1 | tdd | `node --test scripts/tests/check-rag-boundary.node-test.mjs && node scripts/ci/check-rag-boundary.mjs && npm ls @qdrant/js-client-rest >/dev/null && (npm ls @weaviate/node >/dev/null \|\| npm ls weaviate-client >/dev/null)` | ⬜ pending |
| 07-01-03 | 1 | auto | `test "$(grep -cE 'image: [^ ]+@sha256:[0-9a-f]{64}' docker-compose.backends.yml)" -ge 2 && (docker compose -f docker-compose.backends.yml config >/dev/null 2>&1 \|\| node -e … (full command in the plan)` | ⬜ pending |
| 07-02-01 | 1 | tdd | `node --import tsx --test tests/rag-db/vector-sync-schema.test.mts tests/rag-db/schema-migrations.test.mts` | ⬜ pending |
| 07-02-02 | 1 | tdd | `node --import tsx --test tests/rag-db/vector-sync-triggers.test.mts` | ⬜ pending |
| 07-02-03 | 1 | tdd | `node --import tsx --test tests/rag-db/vector-sync-claim.test.mts` | ⬜ pending |
| 07-03-01 | 1 | tdd | `npx vitest run tests/rag/backend/tenant-key.test.ts` | ⬜ pending |
| 07-03-02 | 1 | tdd | `npx vitest run tests/rag/backend/qdrant-scoped.test.ts` | ⬜ pending |
| 07-04-01 | 1 | tdd | `node --test scripts/check-config.test.mjs && node scripts/check-config.mjs && npx vitest run tests/eval-env-pin.test.ts` | ⬜ pending |
| 07-04-02 | 1 | tdd | `npx vitest run tests/rag/config.test.ts && npm run typecheck:new` | ⬜ pending |
| 07-05-01 | 1 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_vector_sync_contracts.py tests/test_contract_models.py` | ⬜ pending |
| 07-05-02 | 1 | auto | `npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts` | ⬜ pending |
| 07-06-01 | 2 | tracer | `node --import tsx --test tests/rag-db/vector-sync-tracer.test.mts` | ⬜ pending |
| 07-06-02 | 2 | tdd | `node --import tsx --test tests/rag-db/validate-chunks.test.mts` | ⬜ pending |
| 07-06-03 | 2 | tdd | `npx vitest run tests/rag/backend/external-backend.test.ts` | ⬜ pending |
| 07-07-01 | 3 | tdd | `npx vitest run tests/rag/sync/qdrant-store.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 07-07-02 | 3 | tdd | `npx vitest run tests/rag/backend/qdrant-adapter.test.ts && npm run typecheck:new` | ⬜ pending |
| 07-07-03 | 3 | tdd | `npx vitest run tests/rag/backend-conformance/qdrant.test.ts && (test -z "$QDRANT_URL" \|\| QDRANT_URL="$QDRANT_URL" npx vitest run tests/rag/backend-conformance/qdrant.test.ts)` | ⬜ pending |
| 07-08-01 | 3 | tdd | `npx vitest run tests/rag/sync/weaviate-store.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 07-08-02 | 3 | tdd | `npx vitest run tests/rag/backend/weaviate-adapter.test.ts && npm run typecheck:new` | ⬜ pending |
| 07-08-03 | 3 | tdd | `npx vitest run tests/rag/backend-conformance/weaviate.test.ts && (test -z "$WEAVIATE_URL" \|\| WEAVIATE_URL="$WEAVIATE_URL" npx vitest run tests/rag/backend-conformance/weaviate.test.ts)` | ⬜ pending |
| 07-09-01 | 3 | tdd | `npx vitest run tests/rag/sync/servable.test.ts` | ⬜ pending |
| 07-09-02 | 3 | tdd | `npx vitest run tests/rag/sync/drain.test.ts` | ⬜ pending |
| 07-09-03 | 3 | tdd | `npx vitest run tests/rag/sync/log.test.ts tests/rag/sync/drain.test.ts` | ⬜ pending |
| 07-10-01 | 3 | tdd | `node --import tsx --test tests/rag-db/activation-gate-external.test.mts` | ⬜ pending |
| 07-10-02 | 3 | tdd | `npx vitest run tests/rag/embeddings/profile-ops-external.test.ts tests/rag/embeddings` | ⬜ pending |
| 07-11-01 | 4 | tdd | `node --import tsx --test tests/rag-db/vector-sync-reconcile.test.mts` | ⬜ pending |
| 07-11-02 | 4 | tdd | `npx vitest run tests/rag/sync/reconcile.test.ts` | ⬜ pending |
| 07-12-01 | 4 | tdd | `npx vitest run tests/rag/backend/readiness.test.ts` | ⬜ pending |
| 07-12-02 | 4 | tdd | `npx vitest run tests/rag/backend/fallback.test.ts && npm run typecheck:new` | ⬜ pending |
| 07-12-03 | 4 | tdd | `npx vitest run tests/rag/v2/search-backend.test.ts tests/rag/v2 tests/rag/trace-log.test.ts && npm run typecheck:new` | ⬜ pending |
| 07-13-01 | 5 | tdd | `npx vitest run tests/rag/sync/drain-route.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 07-13-02 | 5 | tdd | `npx vitest run tests/rag/sync/kick.test.ts tests/rag/ingest tests/rag/embeddings` | ⬜ pending |
| 07-13-03 | 5 | tdd | `node --import tsx --test tests/rag-db/vector-sync-cli.test.mts && node -e "const p=require('./package.json'); if(!p.scripts['rag:vector-sync']\|\|!p.scripts['rag:reconcile']) process.exit(1)"` | ⬜ pending |
| 07-14-01 | 5 | tdd | `npx vitest run tests/rag/canary/guard.test.ts && ! (CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector npx vitest run tests/rag/canary/guard.test.ts)` | ⬜ pending |
| 07-14-02 | 5 | tdd | `npx vitest run tests/rag/canary/tenancy.test.ts tests/rag/canary/lifecycle.test.ts` | ⬜ pending |
| 07-14-03 | 5 | tdd | `npx vitest run tests/rag/canary/foreign-point.test.ts` | ⬜ pending |
| 07-15-01 | 6 | tdd | `npx vitest run tests/rag/admin/index-compat.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 07-15-02 | 6 | tdd | `npx vitest run tests/rag/admin/vector-sync-targets.test.ts` | ⬜ pending |
| 07-16-01 | 6 | tdd | `npx vitest run tests/rag/canary/reconcile-drift.test.ts` | ⬜ pending |
| 07-16-02 | 6 | tdd | `uv run --directory eval python ../scripts/ci/check-workflows.py && uv run --directory eval python -m unittest discover -s ../scripts/tests -p 'test_check_workflows.py'` | ⬜ pending |
| 07-17-01 | 7 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_release_contracts.py tests/test_contract_models.py` | ⬜ pending |
| 07-17-02 | 7 | auto | `npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts` | ⬜ pending |
| 07-18-01 | 7 | tdd | `node --test scripts/check-config.test.mjs` | ⬜ pending |
| 07-18-02 | 7 | auto | `node scripts/check-config.mjs && node --test scripts/check-config.test.mjs` | ⬜ pending |
| 07-19-01 | 7 | tdd | `npx vitest run tests/rag/admin/provider-probes.test.ts` | ⬜ pending |
| 07-19-02 | 7 | tdd | `npx vitest run tests/rag/admin/providers-test-route.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 07-19-03 | 7 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_providers_test.py tests/test_auth.py` | ⬜ pending |
| 07-20-01 | 8 | tdd | `npx vitest run tests/scripts/config-server-security.test.ts` | ⬜ pending |
| 07-20-02 | 8 | tdd | `npx vitest run tests/ui/config-rag-pipeline-panel.test.ts tests/scripts/config-server-security.test.ts` | ⬜ pending |
| 07-20-03 | 8 | tdd | `npx vitest run tests/ui/config-rag-pipeline-panel.test.ts tests/ui && node scripts/check-config.mjs` | ⬜ pending |
| 07-21-01 | 8 | tdd | `node --test scripts/tests/gen-vendor-doc.node-test.mjs && node scripts/rag/gen-vendor-doc.mjs --check` | ⬜ pending |
| 07-21-02 | 8 | tdd | `node --test scripts/check-config.test.mjs && node scripts/check-config.mjs && uv run --directory eval python ../scripts/ci/check-workflows.py` | ⬜ pending |
| 07-22-01 | 8 | tdd | `uv run --directory eval pytest -q tests/test_matching.py tests/test_split.py tests/test_report_runner.py` | ⬜ pending |
| 07-22-02 | 8 | tdd | `uv run --directory eval pytest -q tests/test_review_queue.py` | ⬜ pending |
| 07-22-03 | 8 | tdd | `uv run --directory eval pytest -q tests/test_review_queue.py` | ⬜ pending |
| 07-23-01 | 8 | tdd | `npx vitest run tests/rag/trace/langfuse-retrieved-ids.test.ts && node --import tsx --test tests/rag-langfuse-review.test.mts tests/rag-langfuse-export.test.mts` | ⬜ pending |
| 07-23-02 | 8 | tdd | `npx vitest run tests/rag/admin/review-chunks.test.ts && node scripts/ci/check-rag-boundary.mjs` | ⬜ pending |
| 07-24-01 | 8 | tdd | `uv run --directory eval pytest -q tests/test_paired.py tests/test_gate.py` | ⬜ pending |
| 07-24-02 | 8 | tdd | `uv run --directory eval pytest -q tests/test_regression_rules.py` | ⬜ pending |
| 07-24-03 | 8 | tdd | `uv run --directory eval pytest -q tests/test_regression.py tests/test_regression_rules.py tests/test_paired.py` | ⬜ pending |
| 07-25-01 | 9 | tdd | `node --import tsx --test tests/rag-db/eval-external-backend.test.mts tests/rag-db/eval-v2-overlay.test.mts && npm run test-rag -- --out eval/out/p7-25-default && jq -e '.passed == true and … (full command in the plan)` | ⬜ pending |
| 07-25-02 | 9 | auto | `uv run --project rag-sidecar python -c "import json; from rag_sidecar.contracts.release import DefaultsDecision, RegressionPlan; … (full command in the plan)` | ⬜ pending |
| 07-26-01 | 8 | tdd | `uv run --directory eval pytest -q tests/test_failure_report.py` | ⬜ pending |
| 07-26-02 | 8 | tdd | `uv run --directory eval python ../scripts/ci/check-workflows.py && uv run --directory eval python -m unittest discover -s ../scripts/tests -p 'test_check_workflows.py'` | ⬜ pending |
| 07-27-01 | 10 | tdd | `npx vitest run tests/rag/rag-pipeline-doc.test.ts && node scripts/rag/gen-pipeline-doc.mjs --check` | ⬜ pending |
| 07-27-02 | 10 | tdd | `npx vitest run tests/rag/env-template-groups.test.ts tests/eval-env-pin.test.ts && node scripts/check-config.mjs` | ⬜ pending |
| 07-27-03 | 10 | tdd | `npx vitest run tests/rag/agents-guide.test.ts` | ⬜ pending |
| 07-28-01 | 6 | tdd | `npx vitest run tests/rag/canary/semantic-cache.test.ts tests/rag/canary/guard.test.ts tests/rag/canary/tenancy.test.ts` | ⬜ pending |
| 07-28-02 | 6 | tdd | `npx vitest run tests/rag/canary/semantic-cache.test.ts` | ⬜ pending |
| 07-29-01 | 9 | tdd | `npx vitest run tests/scripts/config-server-review.test.ts tests/scripts/config-server-security.test.ts` | ⬜ pending |
| 07-29-02 | 9 | tdd | `npx vitest run tests/ui/config-review-queue-panel.test.ts tests/ui && node scripts/check-config.mjs` | ⬜ pending |
| 07-30-01 | 10 | tdd | `node --test scripts/tests/check-release-defaults.node-test.mjs` | ⬜ pending |
| 07-30-02 | 10 | auto | `node scripts/check-release-defaults.mjs && uv run --directory eval python ../scripts/ci/check-workflows.py` | ⬜ pending |
| 07-31-01 | 11 | tdd | `node --import tsx --test --test-reporter=tap --test-name-pattern="single-tenant setup" tests/rag-db/schema-equality.test.mts && node --import tsx --test --test-reporter=tap … (full command in the plan)` | ⬜ pending |
| 07-31-02 | 11 | tdd | `node --import tsx --test tests/rag-db/phase7-off-parity.test.mts && npm run test-rag -- --out eval/out/p7-final && jq -e '.passed == true and .paired.all_zero == true' eval/out/p7-final/gate.json && … (full command in the plan)` | ⬜ pending |
| 07-32-01 | 12 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 07-32-02 | 12 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 07-32-03 | 12 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 07-33-01 | 13 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 07-33-02 | 13 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 07-33-03 | 13 | checkpoint | `human checkpoint (see plan)` | ⬜ pending |
| 07-33-04 | 13 | auto | `node scripts/check-release-defaults.mjs && node scripts/check-config.mjs && npx vitest run tests/eval-env-pin.test.ts tests/rag/rag-pipeline-doc.test.ts && node scripts/rag/gen-pipeline-doc.mjs --check && npm run typecheck:new` | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `tests/rag-db/` PGlite suites for migrations 0701 to 0707 (plans 07-02, 07-06, 07-10, 07-11), reusing `eval/harness/pglite-supabase.mts` with the plan 04-05 role shim, and the Phase 7 RPCs registered in `eval/harness/fake-edge.mts` (plans 07-06 and 07-11).
- [ ] `src/lib/rag/sync/stores/fake.ts`: in-memory VectorStore with per-(collection, tenant) partitions, a cosine dense leg and a token-overlap lexical leg, and writer recording (plan 07-06).
- [ ] Recording fake clients for Qdrant (filter-evaluating and filter-ignoring modes) and Weaviate (per-tenant shards, rejects untenanted handles), inside the adapter and store tests (plans 07-07 and 07-08).
- [ ] `tests/rag/backend-conformance/external-seed.ts` and the Qdrant and Weaviate factories, seeding only through outbox and drain (plans 07-06 to 07-08).
- [ ] `tests/rag/canary/` factory, seed helper and the CI guard (plan 07-14); the cache-aware entry point (plan 07-28).
- [ ] `docker-compose.backends.yml` with digest-pinned images and placeholder keys (plan 07-01); the `backend-canary` job with services, waits and random keys (plan 07-16).
- [ ] Contract samples for every new Pydantic model in `tests/fixtures/contracts/samples.json` (plans 07-05 and 07-17).
- [ ] `eval/tests/test_regression.py`, `test_regression_rules.py`, `test_failure_report.py` with synthetic reports and fixture traces (plans 07-24 and 07-26); extended `test_review_queue.py`, `test_matching.py`, `test_split.py` (plan 07-22).

---

## Manual-Only Verifications

| Behaviour | Requirement | Why Manual | Test Instructions |
|-----------|-------------|------------|-------------------|
| Package legitimacy of @weaviate/node 3.15.5 and @weaviate/core 3.15.5 ([SUS] too-new) and @qdrant/js-client-rest 1.20.0 | RET-06, RET-07 (A-1) | Never auto-approvable (planner package gate) | 07-01 Task 1 |
| Vercel plan and the drain scheduler (pg_cron plus pg_net, Vercel Cron on Pro, or Schedules on Hobby) | RET-05 (D-04 b, A-6) | Depends on the account plan | 07-32 Task 1 |
| Hosting, region and read-only key availability for Weaviate and Qdrant | RET-06, ADM-04 (D-09, A6) | Account and data-residency decision | 07-32 Task 2 |
| backend-canary as a required status check on main | RET-08 (D-12) | Needs repository admin rights | 07-32 Task 3 |
| Phase 7 migrations on the real Supabase project; anon refused with the real anon key; concurrent SKIP LOCKED on real Postgres; drain slices under 60 s on Vercel; canary suite against hosted backends | RET-05 to RET-09 | No hosted Supabase, backends or Docker here | 07-33 Task 1 |
| Test-connection for every real provider; vendor retention and training terms; voice latency end to end | ADM-01, ADM-04 | Needs live keys | 07-33 Task 2 |
| Full regression on the real locked test split with all real keys; review of the decision record | ADM-02 (D-17, D-18) | Needs the private golden set and live keys | 07-33 Task 3 (Task 4 applies the defaults automatically) |
| Review-queue panel walk-through with text selection and promotion | EVAL-17 (D-21, D-22) | Browser interaction | 07-29 Task 2 `<human-check>` |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or a checkpoint
- [x] Sampling continuity: no 3 consecutive tasks without an automated verify in 07-01 to 07-31; the exception is the human-only tail by design (07-32 Tasks 1 to 3 and 07-33 Tasks 1 to 3, six checkpoints in a row), which ends with the automated 07-33 Task 4 and follows the full-gate run of 07-31 Task 2
- [x] Wave 0 covers all missing test references
- [x] No watch-mode flags
- [x] Feedback latency under 60 s for per-task commands
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
