---
phase: "02"
slug: "unified-retrieval-pipeline-tenant-scope"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-23"
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 5.1.1 (`tests/**/*.test.ts`), `node --test` via tsx 4.23.15 (`tests/*.test.mts`, `scripts/**/*.node-test.mjs`, `voice-agent/test/*.test.ts`), pytest 9.x (`eval/tests`, `rag-sidecar/tests`) |
| **Config file** | `vitest.config.ts`, `tests/setup-env.ts`, `tsconfig.typecheck-new.json`, `eval/pyproject.toml`, `rag-sidecar/pyproject.toml`; voice-agent gains a `test` script in plan 02-17 |
| **Quick run command** | `npx vitest run tests/rag` + `npm run typecheck:new` (+ `node scripts/ci/check-rag-boundary.mjs` from plan 02-20 on) |
| **Full suite command** | `npx vitest run && node --import tsx --test tests/*.test.mts && node --test scripts/check-config.test.mjs scripts/typecheck-new.test.mjs scripts/tests/*.node-test.mjs && uv run --directory eval pytest -q && uv run --directory rag-sidecar pytest -q && npm run test-rag && node scripts/check-config.mjs && npx next typegen && node scripts/ci/tsc-ratchet.mjs` (plan 02-36 replaces the ratchet with `npx tsc --noEmit -p tsconfig.json`) |
| **Estimated runtime** | ~240 seconds (full); ~30 seconds (quick) |

---

## Sampling Rate

- **After every task commit:** the task's `<automated>` command (each runs in under 120 s except the smoke tier, about 60 s)
- **After every plan wave:** full suite command
- **Parity checkpoints:** `npm run test-rag` with `paired.all_zero == true` after plans 02-04, 02-11, 02-12, 02-13, 02-19, 02-21 and 02-29 (unchanged golden set); after 02-26 against the re-recorded baseline plus `paired-vs-before.json` all zero
- **Before `/gsd-verify-work`:** full suite green, negative control exits 10 with an overall-MRR margin of at least 0.05, `npx next typegen && npx tsc --noEmit -p tsconfig.json` zero errors
- **Max feedback latency:** 120 seconds per task (smoke tier excepted)

---

## Requirement → Test Map (from RESEARCH §Validation Architecture)

| Req | Behaviour | Command | Plan |
|-----|-----------|---------|------|
| PIPE-01 | No embedding/RPC/reranker use outside `src/lib/rag/`; entry routes call runRetrieval | `node scripts/ci/check-rag-boundary.mjs && node --test scripts/tests/check-rag-boundary.node-test.mjs`; `npx vitest run tests/rag/entrypoints-call-pipeline.test.ts` | 02-20, 02-11..02-18 |
| PIPE-01 / SC1 (D-15) | Zero tsc errors | `npx next typegen && npx tsc --noEmit -p tsconfig.json` (ratchet until then) | 02-01, 02-29..02-36 |
| PIPE-02 | Brand; chat scope (403, personal, org, no_tenant, single); two-tenant SQL isolation | `npm run typecheck:new && npx vitest run tests/rag/tenant-brand.test.ts tests/rag/resolve-chat-scope.test.ts tests/rag/chat-two-tenant.test.ts && node --import tsx --test tests/rag-two-tenant.test.mts` | 02-07, 02-10, 02-12, 02-13 |
| PIPE-03 | Embed scope from config; mismatch 403; unconfigured fails closed | `npx vitest run tests/rag/embed-scope.test.ts tests/rag/embed-route.test.ts` | 02-10, 02-14 |
| PIPE-04 | Voice token mint/verify; LiveKit identity/metadata; voice-rag 401/403/503; agent forwarding | `npx vitest run tests/rag/voice-token.test.ts tests/rag/livekit-token-route.test.ts tests/rag/voice-rag-route.test.ts tests/rag/voice-chat-route.test.ts && (cd voice-agent && npm test)` | 02-10, 02-15, 02-16, 02-17 |
| PIPE-05 | Characterization; byte-identical assembly; fixed query count | `npx vitest run tests/rag/characterize-*.test.ts && node --import tsx --test tests/rag-assemble-differential.test.mts tests/rag-assemble-query-count.test.mts` | 02-06, 02-09, 02-12..02-16 |
| PIPE-06 | Fault injection; refusal only on empty; localized error | `npx vitest run tests/rag/status.test.ts tests/rag/chat-status.test.ts tests/chat-strict.test.ts` | 02-08, 02-12 |
| PIPE-07 | Switches, timeouts, skip, abort | `npx vitest run tests/rag/stage-runner.test.ts tests/rag/config.test.ts` | 02-08 |
| PIPE-08 | Retired modules deleted, re-home proofs kept | `node scripts/ci/check-rag-boundary.mjs && npx next typegen && node scripts/ci/tsc-ratchet.mjs` | 02-19, 02-20 |
| PIPE-09 | Parity with all paired diffs zero; negative control exit 10 with margin | `npm run test-rag -- --out eval/out/smoke && jq -e '.paired.all_zero == true' eval/out/smoke/gate.json`; `npm run test-rag -- --degrade drop_top_candidate --out eval/out/neg; test $? -eq 10` | 02-04, 02-11, 02-21 |
| PIPE-10 | engines ^22.12.0, .nvmrc, Dockerfile, CI check | `node scripts/ci/check-node-runtime.mjs && node --test scripts/tests/check-node-runtime.node-test.mjs` | 02-02 |
| OBS-01 | One trace, span per stage, after response, fallback log, masking, off by default; trace id in message metadata | `node --import tsx --test tests/rag-langfuse-export.test.mts tests/rag-langfuse-review.test.mts && npx vitest run tests/chat-messages-roundtrip.test.ts` | 02-08, 02-22, 02-23 |
| OBS-02 | Per-stage p50/p95 vs budgets | `uv run --directory eval pytest -q tests/test_latency_report.py` | 02-24 |
| EVAL-14 | Categories, provenance slices, production gate population, new fixture items | `uv run --directory eval pytest -q tests/test_fixture_coverage.py tests/test_metrics.py tests/test_report_runner.py tests/test_gate.py` | 02-25, 02-26 |
| EVAL-15 | Review queue pull/promote; online judge posts score arrays, 207 not retried, family rule | `uv run --directory eval pytest -q tests/test_review_queue.py tests/test_online_judge.py` | 02-23, 02-27, 02-28 |
| D-28 | Five-place config sync incl. LANGFUSE_* discovery | `node scripts/check-config.mjs && node --test scripts/check-config.test.mjs` | 02-03 |

---

## Per-Task Verification Map

File Exists: ✅ = the test file exists at 172c2ad; W0 = created by the task itself (test written first).

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | PIPE-01 | T-02-01 | — | static | `npx tsc --noEmit -p tsconfig.json --pretty false > /tmp/tsc-02-01.txt 2>&1; test "$(grep 'error TS' /tmp/tsc-02-01.txt \| wc -l)" -eq 224 && npm run typecheck:new` | ✅ | ⬜ pending |
| 02-01-02 | 01 | 1 | PIPE-01 | T-02-02 | ratchet never self-rewrites | node:test | `node --test scripts/tests/tsc-ratchet.node-test.mjs && npx next typegen && node scripts/ci/tsc-ratchet.mjs` | W0 | ⬜ pending |
| 02-01-03 | 01 | 1 | PIPE-01 | T-02-SC | lockfile installs, --ignore-scripts | static | `node --test scripts/tests/tsc-ratchet.node-test.mjs && uv run --directory eval python ../scripts/ci/check-workflows.py` | W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | PIPE-10 | T-02-03 | engines range cannot float | node:test | `node --test scripts/tests/check-node-runtime.node-test.mjs && node scripts/ci/check-node-runtime.mjs` | W0 | ⬜ pending |
| 02-02-02 | 02 | 2 | PIPE-10 | T-02-04 | — | static | `grep -q "22.12" AGENTS.md && grep -q "22.12" README.md && grep -q "22.12" .claude/CLAUDE.md` | ✅ | ⬜ pending |
| 02-03-01 | 03 | 1 | OBS-01 | T-02-06 | LANGFUSE_* drift detected | node:test | `node --test scripts/check-config.test.mjs` | ✅ | ⬜ pending |
| 02-03-02 | 03 | 1 | PIPE-07, OBS-01, EVAL-15 | T-02-05 | secrets are empty placeholders | static + e2e | `node scripts/check-config.mjs && npx tsx eval/harness/eval-env.mts --check && npm run test-rag -- --out eval/out/env-sync` | ✅ | ⬜ pending |
| 02-04-01 | 04 | 2 | PIPE-09 | T-02-08 | — | pytest | `npm run gen:schemas && uv run --directory eval pytest -q tests/test_paired.py` | W0 | ⬜ pending |
| 02-04-02 | 04 | 2 | PIPE-09 | T-02-07 | baseline re-recorded only from unchanged code | e2e | `npm run test-rag -- --out eval/out/paired && jq -e '.passed == true and .paired.all_zero == true' eval/out/paired/gate.json` | ✅ | ⬜ pending |
| 02-05-01 | 05 | 1 | PIPE-02 | T-02-09 | fakes filter, tests cannot pass by ignoring filters | vitest | `npx vitest run tests/helpers-fakes.test.ts tests/chat-strict.test.ts` | W0 | ⬜ pending |
| 02-05-02 | 05 | 1 | PIPE-02, PIPE-05 | T-02-10 | two-tenant SQL predicate isolation | node:test | `node --import tsx --test tests/fixture-edge.test.mts tests/two-tenant-fixture.test.mts` | W0 | ⬜ pending |
| 02-06-01 | 06 | 2 | PIPE-05 | T-02-11 | — | vitest snapshot | `npx vitest run tests/rag/characterize-embed.test.ts tests/rag/characterize-voice.test.ts tests/rag/characterize-chat.test.ts` | W0 | ⬜ pending |
| 02-06-02 | 06 | 2 | PIPE-05 | T-02-12 | — | vitest | `npx vitest run tests/rag/legacy-chat-assembly-oracle.test.ts` | W0 | ⬜ pending |
| 02-07-01 | 07 | 3 | PIPE-01, PIPE-09 | T-02-14 | RPC args derived only from the scope | tracer (node:test) | `node --import tsx --test tests/rag-legacy-differential.test.mts && npm run typecheck:new` | W0 | ⬜ pending |
| 02-07-02 | 07 | 3 | PIPE-02 | T-02-13 | unminted scope rejected (type + runtime) | type + vitest | `npx vitest run tests/rag/tenant-brand.test.ts tests/rag/tenant-predicate.test.ts && npm run typecheck:new` | W0 | ⬜ pending |
| 02-08-01 | 08 | 4 | PIPE-07 | T-02-16 | core stages cannot be disabled | vitest | `npx vitest run tests/rag/config.test.ts` | W0 | ⬜ pending |
| 02-08-02 | 08 | 4 | PIPE-06, PIPE-07 | T-02-18 | abort stops all in-flight work | vitest | `npx vitest run tests/rag/stage-runner.test.ts tests/rag/status.test.ts` | W0 | ⬜ pending |
| 02-08-03 | 08 | 4 | OBS-01 | T-02-17 | log line carries no query or chunk text | vitest | `npx vitest run tests/rag/trace-log.test.ts` | W0 | ⬜ pending |
| 02-09-01 | 09 | 5 | PIPE-05 | T-02-19 | — | vitest | `npx vitest run tests/rag/assemble.test.ts tests/legacy-post-filter.test.ts` | W0 | ⬜ pending |
| 02-09-02 | 09 | 5 | PIPE-05 | T-02-20 | — | node:test | `node --import tsx --test tests/rag-assemble-differential.test.mts tests/rag-assemble-query-count.test.mts` | W0 | ⬜ pending |
| 02-10-01 | 10 | 6 | PIPE-02 | T-02-21 | non-member 403, query error 503 | vitest + node:test | `npx vitest run tests/rag/resolve-chat-scope.test.ts && node --import tsx --test tests/rag-two-tenant.test.mts` | W0 | ⬜ pending |
| 02-10-02 | 10 | 6 | PIPE-03 | T-02-22 | embed tenant only from config | vitest | `npx vitest run tests/rag/embed-scope.test.ts` | W0 | ⬜ pending |
| 02-10-03 | 10 | 6 | PIPE-04 | T-02-23 | forged/expired/short-secret tokens refused, constant time | vitest | `npx vitest run tests/rag/voice-token.test.ts` | W0 | ⬜ pending |
| 02-11-01 | 11 | 7 | PIPE-01 | T-02-26 | eval scope via allow-list only | vitest | `npx vitest run tests/eval-route-auth.test.ts tests/eval-harness.test.ts tests/rag/entrypoints-call-pipeline.test.ts` | ✅ | ⬜ pending |
| 02-11-02 | 11 | 7 | PIPE-09 | T-02-27 | — | e2e | `npm run test-rag -- --out eval/out/parity-eval && jq -e '.passed == true and .paired.all_zero == true' eval/out/parity-eval/gate.json` | ✅ | ⬜ pending |
| 02-12-01 | 12 | 8 | PIPE-05 | T-02-30 | `{{context}}` contract unchanged | vitest | `npx vitest run tests/rag/prompt.test.ts && node --import tsx --test tests/prompt-context.test.mts` | W0 | ⬜ pending |
| 02-12-02 | 12 | 8 | PIPE-02, PIPE-06 | T-02-28 | 403 before streaming; refusal only on empty | vitest | `npx vitest run tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/chat-source-images.test.ts tests/rag/chat-status.test.ts tests/rag/characterize-chat.test.ts` | ✅ | ⬜ pending |
| 02-12-03 | 12 | 8 | PIPE-05, PIPE-09 | T-02-29 | — | e2e | `npm run test-rag -- --out eval/out/parity-chat && jq -e '.paired.all_zero == true' eval/out/parity-chat/gate.json` | ✅ | ⬜ pending |
| 02-13-01 | 13 | 9 | PIPE-02 | T-02-32 | out-of-scope references never read | vitest | `npx vitest run tests/rag/refs.test.ts` | W0 | ⬜ pending |
| 02-13-02 | 13 | 9 | PIPE-01 | T-02-34 | overview fallback scoped | vitest snapshot | `npx vitest run tests/rag/characterize-chat-overview.test.ts tests/rag/characterize-chat.test.ts` | W0 | ⬜ pending |
| 02-13-03 | 13 | 9 | PIPE-02 | T-02-33 | no cross-tenant phrase in any prompt | vitest | `npx vitest run tests/rag/chat-two-tenant.test.ts` | W0 | ⬜ pending |
| 02-14-01 | 14 | 10 | PIPE-03, PIPE-05 | T-02-35 | workspace mismatch 403; unconfigured fails closed | vitest | `npx vitest run tests/rag/characterize-embed.test.ts tests/rag/embed-route.test.ts` | W0 | ⬜ pending |
| 02-14-02 | 14 | 10 | PIPE-06 | T-02-37 | generic error text only | vitest | `npx vitest run tests/rag/embed-widget-error.test.ts` | W0 | ⬜ pending |
| 02-15-01 | 15 | 7 | PIPE-04 | T-02-38 | server identity, metadata token, no self-metadata update, busy 409 | vitest | `npx vitest run tests/rag/livekit-token-route.test.ts` | W0 | ⬜ pending |
| 02-15-02 | 15 | 7 | PIPE-04 | T-02-39 | — | static | `npx tsc --noEmit -p tsconfig.json --pretty false 2>&1 \| grep -E "src/components/voice/" \| wc -l \| xargs test 0 -eq` | ✅ | ⬜ pending |
| 02-16-01 | 16 | 11 | PIPE-05 | T-02-46 | `.or()` injection impossible | vitest | `npx vitest run tests/rag/local-hybrid.test.ts` | W0 | ⬜ pending |
| 02-16-02 | 16 | 11 | PIPE-04, PIPE-06 | T-02-43 | no global fallback; bare userId 401 | vitest | `npx vitest run tests/rag/characterize-voice.test.ts tests/rag/voice-rag-route.test.ts` | W0 | ⬜ pending |
| 02-16-03 | 16 | 11 | PIPE-04 | T-02-47 | saves only under the token's tenant | vitest | `npx vitest run tests/rag/voice-chat-route.test.ts` | W0 | ⬜ pending |
| 02-17-01 | 17 | 12 | PIPE-04 | T-02-49 | token header only when present | node:test | `cd voice-agent && npm ci --ignore-scripts && npm test` | W0 | ⬜ pending |
| 02-17-02 | 17 | 12 | PIPE-04 | T-02-48 | one active user per agent | static + node:test | `cd voice-agent && npx tsc --noEmit -p tsconfig.json && npm test` | W0 | ⬜ pending |
| 02-17-03 | 17 | 12 | PIPE-04 | T-02-50 | — | static | `uv run --directory eval python ../scripts/ci/check-workflows.py && grep -q "RAG_VOICE_TOKEN_SECRET" README_VOICE_INTEGRATION.md` | ✅ | ⬜ pending |
| 02-18-01 | 18 | 12 | PIPE-01 | T-02-51 | — | vitest | `npx vitest run tests/rag/media-context.test.ts` | W0 | ⬜ pending |
| 02-18-02 | 18 | 12 | PIPE-02, PIPE-06 | T-02-52 | media context only from the caller's workspace | vitest | `npx vitest run tests/rag/media-routes.test.ts` | W0 | ⬜ pending |
| 02-19-01 | 19 | 13 | PIPE-01 | T-02-53 | — | e2e | `npm run test-rag -- --out eval/out/ingest-rewire && jq -e '.paired.all_zero == true' eval/out/ingest-rewire/gate.json && npx vitest run` | ✅ | ⬜ pending |
| 02-19-02 | 19 | 13 | PIPE-08 | T-02-54 | — | node:test + vitest | `node --import tsx --test tests/rag-legacy-differential.test.mts tests/prompt-context.test.mts tests/fixture-edge.test.mts && npx vitest run tests/rag/prompt.test.ts tests/rag/local-hybrid.test.ts` | ✅ | ⬜ pending |
| 02-19-03 | 19 | 13 | PIPE-08 | T-02-53 | dead unscoped RPC code removed | static + e2e | `npx next typegen && node scripts/ci/tsc-ratchet.mjs && npm run test-rag -- --out eval/out/after-delete && jq -e '.paired.all_zero == true' eval/out/after-delete/gate.json` | ✅ | ⬜ pending |
| 02-20-01 | 20 | 14 | PIPE-01, PIPE-02 | T-02-55 | boundary and mint-scope rules enforced | node:test | `node --test scripts/tests/check-rag-boundary.node-test.mjs && node scripts/ci/check-rag-boundary.mjs` | W0 | ⬜ pending |
| 02-20-02 | 20 | 14 | PIPE-01 | T-02-57 | — | static | `uv run --directory eval python ../scripts/ci/check-workflows.py` | ✅ | ⬜ pending |
| 02-21-01 | 21 | 15 | PIPE-09 | T-02-58 | degrade honoured only for profile eval | vitest | `npx vitest run tests/rag/degrade.test.ts` | W0 | ⬜ pending |
| 02-21-02 | 21 | 15 | PIPE-09 | T-02-59 | — | pytest | `uv run --directory eval pytest -q tests/test_gate.py` | ✅ | ⬜ pending |
| 02-21-03 | 21 | 15 | PIPE-09 | T-02-59 | gate rejects a real regression | e2e | `(npm run test-rag -- --degrade drop_top_candidate --out eval/out/negative-degrade; test $? -eq 10) && npm run test-rag -- --out eval/out/parity-final && jq -e '.paired.all_zero == true' eval/out/parity-final/gate.json` | ✅ | ⬜ pending |
| 02-22-01 | 22 | 8 | OBS-01 | T-02-SC | exact pins, registry check, no install scripts | vitest | `npx vitest run tests/rag/langfuse-pins.test.ts` | W0 | ⬜ pending |
| 02-22-02 | 22 | 8 | OBS-01 | T-02-60 | PII masked | vitest | `npx vitest run tests/rag/mask.test.ts tests/rag/sample.test.ts` | W0 | ⬜ pending |
| 02-22-03 | 22 | 8 | OBS-01 | T-02-61 | no export when disabled; response never waits | node:test (fake OTLP) | `node --import tsx --test tests/rag-langfuse-export.test.mts` | W0 | ⬜ pending |
| 02-23-01 | 23 | 11 | EVAL-15 | T-02-64 | review content masked, separate sample | node:test (fake OTLP) | `node --import tsx --test tests/rag-langfuse-review.test.mts` | W0 | ⬜ pending |
| 02-23-02 | 23 | 11 | OBS-01 | T-02-65 | — | vitest | `npx vitest run tests/chat-messages-roundtrip.test.ts tests/rag/characterize-chat.test.ts` | ✅ | ⬜ pending |
| 02-24-01 | 24 | 16 | OBS-02 | T-02-66 | — | pytest | `npm run gen:schemas && uv run --directory rag-sidecar pytest -q` | ✅ | ⬜ pending |
| 02-24-02 | 24 | 16 | OBS-02 | T-02-66 | — | pytest + e2e | `uv run --directory eval pytest -q tests/test_latency_report.py && npm run test-rag -- --out eval/out/latency` | W0 | ⬜ pending |
| 02-25-01 | 25 | 17 | EVAL-14 | T-02-67 | — | pytest | `npm run gen:schemas && uv run --directory rag-sidecar pytest -q` | ✅ | ⬜ pending |
| 02-25-02 | 25 | 17 | EVAL-14 | T-02-67 | population change forces re-record | pytest + e2e | `uv run --directory eval pytest -q tests/test_metrics.py tests/test_report_runner.py tests/test_gate.py && npm run test-rag -- --out eval/out/provenance` | ✅ | ⬜ pending |
| 02-26-01 | 26 | 18 | EVAL-14 | T-02-69 | synthetic items, PII test | pytest | `uv run --directory eval pytest -q tests/test_fixture_coverage.py tests/test_fixture_quotes.py tests/test_fixture_pii.py` | ✅ | ⬜ pending |
| 02-26-02 | 26 | 18 | EVAL-14 | T-02-68 | old items provably unchanged | e2e | `npm run test-rag -- --out eval/out/golden-v2 && jq -e '.all_zero == true' eval/out/golden-v2/paired-vs-before.json` | ✅ | ⬜ pending |
| 02-27-01 | 27 | 19 | EVAL-15 | T-02-71 | keys from env only | pytest (fake Langfuse) | `uv sync --directory eval --locked --all-extras && uv run --directory eval pytest -q tests/test_review_queue.py -k "api or contract"` | W0 | ⬜ pending |
| 02-27-02 | 27 | 19 | EVAL-15 | T-02-70 | queue only in gitignored private path | pytest | `uv run --directory eval pytest -q tests/test_review_queue.py` | W0 | ⬜ pending |
| 02-28-01 | 28 | 20 | EVAL-15 | T-02-73 | judge family differs from generator | pytest | `uv run --directory eval pytest -q tests/test_judge_config.py` | ✅ | ⬜ pending |
| 02-28-02 | 28 | 20 | EVAL-15 | T-02-74 | 207 never retried; deterministic ids | pytest (fake Langfuse, stub judge) | `uv run --directory eval pytest -q tests/test_online_judge.py` | W0 | ⬜ pending |
| 02-28-03 | 28 | 20 | EVAL-15 | T-02-72 | secrets only via step env | static | `uv run --directory eval python ../scripts/ci/check-workflows.py` | ✅ | ⬜ pending |
| 02-29-01 | 29 | 12 | PIPE-01 | T-02-75 | — | vitest + static | `npx vitest run tests/chat-strict.test.ts tests/rag/characterize-chat.test.ts && npx next typegen && node scripts/ci/tsc-ratchet.mjs` | ✅ | ⬜ pending |
| 02-29-02 | 29 | 12 | PIPE-01 | T-02-76 | custom chunk wire format unchanged | vitest + e2e | `npx vitest run tests/chat-tool-parts.test.ts tests/chat-source-images.test.ts && npm run test-rag -- --out eval/out/chat-types` | W0 | ⬜ pending |
| 02-30-01 | 30 | 2 | PIPE-01 | T-02-78 | header values never logged | vitest | `npx vitest run tests/mcp/transports.test.ts` | W0 | ⬜ pending |
| 02-30-02 | 30 | 2 | PIPE-01 | T-02-77 | — | vitest | `npx vitest run tests/mcp/discovery.test.ts` | W0 | ⬜ pending |
| 02-30-03 | 30 | 2 | PIPE-01 | T-02-77 | approval JSON unchanged | vitest + static | `npx vitest run tests/mcp && npx next typegen && node scripts/ci/tsc-ratchet.mjs` | W0 | ⬜ pending |
| 02-31-01 | 31 | 2 | PIPE-01 | T-02-79 | — | vitest | `npx vitest run tests/whatsapp/clients.test.ts` | W0 | ⬜ pending |
| 02-31-02 | 31 | 2 | PIPE-01 | T-02-80 | conversations route authenticates on an awaited client | vitest | `npx vitest run tests/whatsapp` | W0 | ⬜ pending |
| 02-32-01 | 32 | 2 | PIPE-01 | T-02-81 | no tenant fields sent from the embed window | vitest | `npx vitest run tests/ui/embed-window-request.test.ts` | W0 | ⬜ pending |
| 02-32-02 | 32 | 2 | PIPE-01 | T-02-81 | — | vitest | `npx vitest run tests/ui` | W0 | ⬜ pending |
| 02-33-01 | 33 | 3 | PIPE-01 | T-02-82 | — | static + vitest | `npx vitest run` | ✅ | ⬜ pending |
| 02-33-02 | 33 | 3 | PIPE-01 | T-02-82 | — | vitest | `npx vitest run tests/ui/sidebar-reducer.test.ts` | W0 | ⬜ pending |
| 02-34-01 | 34 | 3 | PIPE-01 | T-02-83 | system prompts byte-identical | vitest | `npx vitest run tests/rag/characterize-chat.test.ts tests/chat-strict.test.ts` | ✅ | ⬜ pending |
| 02-34-02 | 34 | 3 | PIPE-01 | T-02-84 | — | vitest | `npx vitest run tests/lib/semantic-chunker.test.ts` | W0 | ⬜ pending |
| 02-34-03 | 34 | 3 | PIPE-01 | T-02-84 | stored chats keep rendering | vitest | `npx vitest run tests/lib/chat-utils-tool-parts.test.ts tests/chat-messages-roundtrip.test.ts` | W0 | ⬜ pending |
| 02-35-01 | 35 | 2 | PIPE-01 | T-02-86 | Stripe API version unchanged | vitest | `npx vitest run tests/lib/misc-type-fixes.test.ts` | W0 | ⬜ pending |
| 02-35-02 | 35 | 2 | PIPE-01 | T-02-SC | — | static + vitest | `npx vitest run` | ✅ | ⬜ pending |
| 02-35-03 | 35 | 2 | PIPE-01 | T-02-85 | handlers use awaited ids | vitest + static | `npx vitest run tests/routes/async-params.test.ts && npx next typegen && node scripts/ci/tsc-ratchet.mjs` | W0 | ⬜ pending |
| 02-36-01 | 36 | 21 | PIPE-01 | T-02-87 | — | static | `npx next typegen && npx tsc --noEmit -p tsconfig.json` | ✅ | ⬜ pending |
| 02-36-02 | 36 | 21 | PIPE-01 | T-02-88 | — | build | `NEXT_TELEMETRY_DISABLED=1 timeout 900 npx next build > /tmp/next-build-02-36.log 2>&1; ! grep -qE "Type error\|Failed to type check" /tmp/next-build-02-36.log` | ✅ | ⬜ pending |

The full per-task `<automated>` commands are in each plan; the commands above are the decisive part of each.

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/helpers/chat-route-fakes.ts` — real `in`/`is`/`eq`/`ilike` semantics and a call recorder (P-02) — plan 02-05
- [ ] `eval/harness/fake-edge.mts` — `in.(…)`, voice-fallback operators, tenant filters, organization tables (P-03) — plan 02-05
- [ ] `eval/harness/two-tenant.mts` — two-tenant multi-tenant PGlite fixture — plan 02-05
- [ ] `tests/helpers/route-fixture.ts` and characterization snapshots (embed, voice, chat) — plan 02-06
- [ ] `tests/fixtures/legacy-chat-assembly.ts` — frozen chat assembly oracle — plan 02-06
- [ ] `tests/rag/` registered for typecheck:new (`src/lib/rag/` added to PHASE1_PATHS and the typecheck-new include) — plan 02-01
- [ ] `tests/helpers/fake-langfuse.mts` — fake OTLP traces / observations / scores — plan 02-22; Python twin `eval/tests/fake_langfuse.py` — plan 02-27
- [ ] voice-agent test runner (`npm test` via tsx) — plan 02-17
- [ ] Packages: `@langfuse/tracing@6.1.1`, `@langfuse/otel@6.1.1`, `@opentelemetry/sdk-trace-base@2.12.1`, `@opentelemetry/core@2.12.1`, `@opentelemetry/exporter-trace-otlp-http@0.223.2`, `@opentelemetry/otlp-exporter-base@0.223.2`, `@opentelemetry/api@1.9.0` — plan 02-22 (automated registry check replaces the human checkpoint per the D-18 adjustment)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Tenant resolution against a real Supabase project (personal and organization memberships, single-tenant and multi-tenant) | PIPE-02, PIPE-03 | No live Supabase here | Deploy to a preview; as a member and a non-member, POST /api/chat with and without organizationId; embed with RAG_EMBED_TENANT set and unset; confirm 403 / scoped answers |
| Voice session with the running voice-agent using the signed token | PIPE-04 | Needs LiveKit, the agent image and keys | Deploy the agent first, then the app; start a voice session; ask a knowledge-base question; check `x-rag-scope-token` reaches voice-rag (logs) and that a second user gets "voice busy" |
| voice-agent image on node:22-slim | PIPE-10 | No Docker daemon here | `docker build voice-agent` and connect to LiveKit (native rtc-node binaries) |
| Vercel Node.js setting and a Vercel build with type checks on | PIPE-10, PIPE-01 | Live platform | Confirm the project uses Node 22 (engines `^22.12.0`); a preview build passes with `ignoreBuildErrors: false` |
| Legacy parity on the real golden set | PIPE-09 | Needs live Supabase and embeddings | `npm run test-rag -- --base-url <deployment> --baseline <live baseline>` with keys |
| Langfuse trace tree and trace id as root | OBS-01 | Needs Langfuse Cloud keys | Enable LANGFUSE_ENABLED with sample rate 1 on a preview; check one trace with a span per stage and the message's ragTraceId matching (assumption A1) |
| Review queue and online judge with real keys | EVAL-15 | Needs Langfuse and judge keys | Set LANGFUSE_REVIEW_SAMPLE_RATE > 0 on a preview, run `python -m rag_eval.review_queue pull` and the nightly online-judge job; confirm scores on traces |
| Embed widget shows the error message on a third-party page | PIPE-06 | Browser on a third-party page | Unset RAG_EMBED_TENANT in multi-tenant preview; load the widget; send a message; the generic error text appears |

---

## Planner Judgment Calls

| # | Call | Plan | Rests on |
|---|------|------|----------|
| 1 | OTel/Langfuse packages get an automated registry check (repository URL, no install scripts, not deprecated) and `--ignore-scripts`, no human checkpoint | 02-22 | D-18 (adjusted) |
| 2 | Phase tracer is 02-07, after config (02-01/03) and characterization (02-05/06) | 02-07 | D-15 (adjusted: config first), D-29 |
| 3 | Route-level chat snapshot in addition to function-level oracle | 02-06 | D-16, D-17 |
| 4 | Optional `refs` stage for document references and `@mention` | 02-13 | D-03 (stage list is open), D-12 |
| 5 | Voice wire contract keeps `debug_info` | 02-16 | D-16 (adjusted: `{results, source_images, debug_info}`) |
| 6 | Voice "busy" enforced twice: 409 from the token route and a guard in the agent | 02-15, 02-17 | D-10 (adjusted) |
| 7 | Media routes keep "continue without context" on retrieval error, log it, add `rag_status` | 02-18 | D-06 |
| 8 | Non-retrieval type-fix plans run early (waves 2–3); the ratchet accepts decreases, so no later plan edits the baseline | 02-30..02-35 | D-15 (adjusted) |
| 9 | Online-judge model id chosen at execution time (newest non-OpenAI flash model in OpenRouter's public list), stored only as a config value in eval/config/judge.json | 02-28 | D-26 (adjusted: non-OpenAI judge for `openai/*`) |

Plans with four tasks that edit `src/app/api/chat/route.ts` (02-12, 02-13, 02-16, 02-19) are executed one at a time with a fresh executor context; each task is guarded by the 144 chat snapshots, so they are not split further.

The AGENTS.md line added by 02-36 is covered by D-15 and AGENTS.md's own "keep this guide current" rule.

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s (smoke tier excepted, about 60 s per run)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
