---
phase: "01"
slug: "evaluation-harness-baseline"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-23"
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.1.1 (TypeScript), `node --import tsx --test` (real `createEnhancedRAGPrompt`), pytest 9.x (`rag-sidecar/`, `eval/`) |
| **Config file** | `vitest.config.ts`, `tests/setup-env.ts`, `rag-sidecar/pyproject.toml`, `eval/pyproject.toml` — none yet, Wave 0 installs |
| **Quick run command** | `npx vitest run <file>` / `uv run --project rag-sidecar pytest -q` / `uv run --project eval pytest -q <file>` |
| **Full suite command** | `npm test && node scripts/check-config.mjs && npm run typecheck:new && npm run test-rag && uv run --project rag-sidecar pytest -q && uv run --project eval pytest -q` |
| **Estimated runtime** | ~120 seconds |

---

## Sampling Rate

- **After every task commit:** Run the single relevant quick command for that task
- **After every plan wave:** Run `npm test`, `node scripts/check-config.mjs`, and both pytest projects
- **Before `/gsd-verify-work`:** Full suite must be green, plus the degraded-config negative-control run
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

Requirement-level map from RESEARCH.md § Validation Architecture; task IDs are filled in when plans exist.

| Requirement | Test Type | Automated Command | File Exists | Status |
|-------------|-----------|-------------------|-------------|--------|
| EVAL-01 | unit (httpx TestClient) | `uv run --project rag-sidecar pytest tests/test_auth.py tests/test_health.py` | ❌ W0 | ⬜ pending |
| EVAL-01 | lock/build | `uv sync --project rag-sidecar --locked --no-dev` (docker build runs in CI only) | ❌ W0 | ⬜ pending |
| EVAL-02 | script + vitest | `npm run gen:schemas && git diff --exit-code && npx vitest run tests/contracts.test.ts` | ❌ W0 | ⬜ pending |
| EVAL-03 | pytest | `uv run --project eval pytest tests/test_golden_contract.py` | ❌ W0 | ⬜ pending |
| EVAL-04 | pytest | `uv run --project eval pytest tests/test_fixture_coverage.py` | ❌ W0 | ⬜ pending |
| EVAL-05 | pytest | `uv run --project eval pytest tests/test_draft.py` | ❌ W0 | ⬜ pending |
| EVAL-06 | vitest | `npx vitest run tests/eval-route.test.ts tests/eval-harness.test.ts` | ❌ W0 | ⬜ pending |
| EVAL-07 | pytest | `uv run --project eval pytest tests/test_metrics.py` | ❌ W0 | ⬜ pending |
| EVAL-08 | pytest | `uv run --project eval pytest tests/test_judge.py` | ❌ W0 | ⬜ pending |
| EVAL-09 | pytest | `uv run --project eval pytest tests/test_baseline.py` | ❌ W0 | ⬜ pending |
| EVAL-10 | pytest | `uv run --project eval pytest tests/test_gate.py` | ❌ W0 | ⬜ pending |
| EVAL-11 | e2e | `npm run test-rag` | ❌ W0 | ⬜ pending |
| EVAL-12 | vitest + tsx | `npx vitest run tests/chat-*.test.ts && node --import tsx --test tests/prompt-context.test.mts` | ❌ W0 | ⬜ pending |
| EVAL-13 | node:test | `node --test scripts/check-config.test.mjs && node scripts/check-config.mjs` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest.config.ts`, `tests/setup-env.ts` — Vitest config and placeholder env (set before any `@/lib` import)
- [ ] `tests/chat-strict.test.ts`, `tests/chat-websearch.test.ts`, `tests/chat-source-images.test.ts`, `tests/prompt-context.test.mts`, `tests/eval-route.test.ts`, `tests/contracts.test.ts`
- [ ] `rag-sidecar/pyproject.toml`, `eval/pyproject.toml`, `uv.lock` files, pytest configs
- [ ] `eval/fixtures/*` corpus and golden set, `eval/config/*`, `eval/baselines/`
- [ ] `.gitignore` entries: `eval/golden/private/`, `eval/out/`, `.venv`
- [ ] Framework install: `vitest@5.1.1`, `vite@7.3.8`, `@electric-sql/pglite@0.5.17`, `@electric-sql/pglite-pgvector@0.0.18`, `json-schema-to-zod@2.8.1`, `tsx`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Sidecar Docker image builds and runs | EVAL-01 | No Docker daemon in this environment | CI job `docker build rag-sidecar`; locally `docker build rag-sidecar && docker run -e RAG_SIDECAR_SECRET=... -p 8080:8080` then `curl /health` |
| Real-workspace golden drafting | EVAL-05 | Needs a real knowledge base and an LLM key | Run the drafting CLI against a workspace with keys set; review items in `eval/golden/private/` |
| Nightly judge run with a real judge | EVAL-08 | Needs an OpenRouter key | Trigger the nightly workflow with the secret set; hand-check 20 items per language |
| Real knowledge-base baseline | EVAL-09 | Needs live Supabase and embeddings | Run `npm run test-rag -- --base-url <deployment>` with keys, record a separate live baseline |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
