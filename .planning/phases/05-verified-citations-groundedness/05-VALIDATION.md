---
phase: "05"
slug: "verified-citations-groundedness"
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-11-24"
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Every executable task in 05-01 to 05-25 has an `<automated>` command. The only non-automated items are the package-legitimacy checkpoint (05-05 Task 1), the model-mapping decision (05-10 Task 1), the four live-service checkpoints in 05-26, and three `<human-check>` UI walk-throughs (05-15, 05-20, 05-23) collected at the end of the phase.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.1.1 (`tests/**/*.test.ts`, node environment); `node --import tsx --test` for `.test.mts` (database tests in `tests/rag-db/`); pytest 9.2.0 for `eval/` and `rag-sidecar/` |
| **Config file** | `vitest.config.ts`; `eval/pyproject.toml`; `rag-sidecar/pyproject.toml` |
| **Quick run command** | `npx vitest run tests/rag/citations` (plus the touched area, for example `tests/rag/generation`, `tests/lib`, `tests/api/rag-answers.test.ts`, or `uv run --directory rag-sidecar pytest -q tests/test_groundedness.py`) |
| **Full suite command** | `npx vitest run && node --import tsx --test tests/*.test.mts tests/rag-db/*.test.mts && uv run --directory eval pytest -q && uv run --directory rag-sidecar pytest -q && node scripts/check-config.mjs && npm run typecheck:new && node scripts/ci/check-rag-boundary.mjs` |
| **Estimated runtime** | quick: under 30 s per area; full: about 8 to 12 minutes (PGlite suites dominate); smoke tier about 2 minutes per mode |

No test calls a live service. The alias path runs on the real `streamText` with `MockLanguageModelV3` from `ai/test`; the Claude path runs the real `@ai-sdk/anthropic` provider against recorded-shape SSE fixtures under `tests/fixtures/anthropic/` (a fetch fake, or a local HTTP server for route tests); the sidecar uses stub scorers and an `httpx.MockTransport` Vectara; Langfuse uses `tests/helpers/fake-langfuse.mts`; the database uses PGlite with the Phase 4 role shim; the fixture eval uses the deterministic fake citation generator and the fake groundedness endpoint from plan 05-22.

---

## Sampling Rate

- **After every task commit:** the task's `<automated>` command (scoped to the touched area), plus `npm run typecheck:new` for TypeScript changes.
- **After every plan wave:** the full suite command above, plus the legacy smoke tier: `npm run test-rag -- --out eval/out/p5-wave && jq -e '.passed == true and .paired.all_zero == true' eval/out/p5-wave/gate.json` (from wave 5 on, also with `--citations --groundedness`).
- **Before `/gsd-verify-work`:** plan 05-25 Task 3 command chain green, `eval/reports/phase-05/comparison.json` passed (plan 05-25 Task 2), and `npm run gen:schemas` with a clean diff on generated files.
- **Max feedback latency:** 60 seconds for per-task commands (smoke-tier and comparison runs are per-wave or per-plan gates).

---

## Requirement → Test Map (Nyquist map)

| Req | Behaviour that must be observable | Plans | Automated command |
|-----|-----------------------------------|-------|-------------------|
| GEN-01 | Claude models with an anthropicId take the direct Anthropic path with one citation-enabled plain-text document per block, bytes not strings, explicit base URL, no output or sampling fields; citations become [S<k>] markers and claude-citations records; the five-location anthropicId check passes; tools, MCP and webSearch turns are ineligible and keep the OpenRouter path; pre-first-token failures (400, 401, 404, 429, 5xx, refusal, timeout) fall back once with a trace reason | 05-02, 05-05, 05-10, 05-11, 05-16, 05-25, 05-26 | `npx vitest run tests/rag/citations/claude-request.test.ts tests/rag/citations/claude-stream.test.ts tests/rag/citations/strategy.test.ts tests/rag/citations/fallback.test.ts tests/rag/citations/chat-claude-route.test.ts tests/rag/citations/models.test.ts tests/rag/citations/provider-pin.test.ts && node --test scripts/check-config.test.mjs` |
| GEN-02 | Markers split at every character boundary are found; [S3, S5], [S3][S5] and full-width forms parse; unknown aliases and aliases not in the request's AliasMap are dropped and counted; the validated list arrives once in finish metadata; unvalidated markers are hidden in the UI | 05-01, 05-03, 05-04, 05-07, 05-08, 05-20, 05-22, 05-24 | `npx vitest run tests/lib/marker-grammar.test.ts tests/rag/citations/marker-parser.test.ts tests/rag/citations/alias-transform.test.ts tests/rag/citations/chat-citations-route.test.ts tests/lib/citation-markers.test.ts` |
| GEN-03 | Both strategies produce the same CitationRecord with a snapshot; message metadata carries it (quote capped at 1,000) through save and reload; the full record lives in rag_answer_records; citations still render after a new version, soft delete, hard delete and re-chunk | 05-01, 05-04, 05-06, 05-07, 05-09, 05-13, 05-15, 05-20, 05-25 | `npx vitest run tests/chat-messages-roundtrip.test.ts tests/ui/citation-sources.test.ts tests/rag/context/context-blocks.test.ts && node --import tsx --test tests/rag-db/answer-records-snapshot.test.mts tests/rag-db/answer-records-store.test.mts` |
| GEN-04 | No JSON mode or response format on any streamed answer; the alias path's structured output is the schema-validated CitationRecord list; the Claude call has no output or format field | 05-01, 05-03, 05-08, 05-11, 05-16, 05-25 | `npx vitest run tests/rag/citations/claude-request.test.ts tests/rag/citations/chat-citations-route.test.ts tests/contracts.test.ts` (plus the negative grep gates in 05-08 and 05-11) |
| GEN-05 | Sidecar /v1/groundedness routes en and zh-Hans to Vectara only with allow_vectara and a key, en to local HHEM-2.1-Open otherwise, everything else not_checked; Vectara failure falls to local for en and not_checked for zh without retry; auth fails closed; the app scores after the stream with a timeout, labels with the thresholds file and stores the result; multi-tenant Vectara needs the acknowledgement | 05-01, 05-02, 05-05, 05-07, 05-12, 05-14, 05-17, 05-18, 05-19, 05-22, 05-24, 05-25, 05-26 | `uv run --directory rag-sidecar pytest -q tests/test_groundedness.py tests/test_groundedness_vectara.py tests/test_hhem_bake.py tests/test_image_boundary.py && npx vitest run tests/rag/generation tests/rag/lang-script.test.ts` |
| GEN-06 | Score and status stored in the record and message metadata and logged as one [Groundedness] line without text; the answer is never delayed; the badge shows verified, possibly unreliable or not checked, never a number, only in strict and balanced, hidden while pending, on refusals and ghost chats | 05-06, 05-09, 05-13, 05-14, 05-15, 05-18, 05-19, 05-23, 05-25, 05-26 | `npx vitest run tests/rag/generation/answer-finish-groundedness.test.ts tests/lib/badge-state.test.ts tests/lib/use-answer-records.test.ts tests/api/rag-answers.test.ts` |
| GEN-07 | With every Phase 5 switch off, or without the web-chat capability (WhatsApp), or for voice and embed, the system prompt and SSE body are byte-identical; strict Information Not Available still streams in the user's language with citations and groundedness on; webSearch, source_images and {{context}} unchanged; retrieval paired differences zero with switches off and on | 05-02, 05-04, 05-08, 05-13, 05-16, 05-22, 05-24, 05-25, 05-26 | `npx vitest run tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/chat-source-images.test.ts tests/rag/characterize-chat.test.ts tests/rag/characterize-embed.test.ts tests/rag/characterize-voice.test.ts && uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase5-comparison.json --out eval/reports/phase-05` |
| EVAL-16 | Helpful / not helpful with optional reason chips and text; stored first in the record and the message metadata; changeable; user_feedback score with a deterministic id and masked comment; [RAG Feedback] log fallback; feedback_negative and groundedness_flagged reach review_reasons, a tagged masked Langfuse copy, and `review_queue pull --source db` with dedupe | 05-01, 05-02, 05-06, 05-07, 05-09, 05-13, 05-15, 05-21, 05-23, 05-25 | `npx vitest run tests/rag/generation/feedback.test.ts tests/api/rag-answers-feedback.test.ts tests/api/review-candidates.test.ts tests/lib/answer-feedback-client.test.ts && uv run --directory eval pytest -q tests/test_review_queue.py` |

### Cross-cutting checks

| Check | Source | Plans | Automated command |
|-------|--------|-------|-------------------|
| rag_answer_records isolation: select-own RLS, no client writes, anon refused, same-organization users isolated, tenant_key generated, 404 (never 403) for foreign records, feedback only on own records, chat linking only to own chats with a matching organization | Project constraint (multi-tenant), D-16, D-17 | 05-06, 05-09, 05-13, 05-21, 05-25 | `node --import tsx --test tests/rag-db/answer-records-rls.test.mts tests/rag-db/answer-records-schema.test.mts tests/rag-db/answer-records-store.test.mts && npx vitest run tests/api/rag-answers.test.ts tests/api/rag-answers-feedback.test.ts tests/rag/generation/answer-finish.test.ts` |
| Vectara fails closed in multi-tenant mode without the acknowledgement; no key or text in sidecar or app logs | D-21, specifics | 05-12, 05-14, 05-18 | `npx vitest run tests/rag/generation/groundedness.test.ts tests/rag/generation/answer-finish-groundedness.test.ts && uv run --directory rag-sidecar pytest -q tests/test_groundedness_vectara.py` |
| Switches off restore today's behaviour; ghost chats persist nothing | D-05, D-06, D-21 | 05-08, 05-13, 05-15, 05-16, 05-25 | `npx vitest run tests/rag/citations/chat-citations-route.test.ts tests/rag/citations/chat-answer-record-route.test.ts tests/rag/citations/chat-claude-route.test.ts tests/rag/characterize-chat.test.ts` and `npm run test-rag -- --out eval/out/p5-check && jq -e '.passed == true and .paired.all_zero == true' eval/out/p5-check/gate.json` |
| Config sync in five places and the manifest; anthropicId agreement | AGENTS.md rule 5 and §7, D-08, D-21 | 05-02, 05-10 | `node --test scripts/check-config.test.mjs && node scripts/check-config.mjs` |
| Pydantic source with generated Zod, no drift | Project constraint (Pydantic v2), D-22 | 05-01, 05-07 | `npm run gen:schemas && git diff --exit-code -- src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts` |
| Package pins and image boundary (exact @ai-sdk/anthropic 3.0.143 on the v6 line; hhem extra optional; default image slim; HF revisions and hash asserted at bake) | D-09, D-12, T-05-SC | 05-05, 05-17 | `npx vitest run tests/rag/citations/provider-pin.test.ts && uv run --directory rag-sidecar pytest -q tests/test_dependency_boundary.py tests/test_image_boundary.py tests/test_hhem_bake.py` |
| Deep-import boundary for new server modules; client code never imports the pipeline index | check-rag-boundary rules | 05-08, 05-13, 05-15, 05-16, 05-18, 05-21 | `node scripts/ci/check-rag-boundary.mjs` |
| Folded setup files equal the migrations, each mode on its own | D-16, Phase 3 D-05 | 05-25 | `node --import tsx --test --test-reporter=tap --test-name-pattern="single-tenant setup" tests/rag-db/schema-equality.test.mts` and the same with `"multi-tenant setup"`, each with `# fail 0` and at least 3 passed |
| Phase completion against the baseline (D-25 a to e) | ROADMAP rule "proven against the baseline", D-25 | 05-25 | `uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase5-comparison.json --out eval/reports/phase-05 && jq -e '.passed == true' eval/reports/phase-05/comparison.json` |

---

## Per-Task Verification Map

Requirements and threat references per plan are in `05-PLAN-INDEX.md`. Kind: tracer, tdd (test first), auto, checkpoint.

| Task ID | Wave | Kind | Automated Command | Status |
|---------|------|------|-------------------|--------|
| 05-01-01 | 1 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_answer_contracts.py` | ⬜ pending |
| 05-01-02 | 1 | auto | `npm run gen:schemas && git diff --exit-code -- src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts && uv run --directory rag-sidecar pytest -q` | ⬜ pending |
| 05-02-01 | 1 | tdd | `node --test scripts/check-config.test.mjs` | ⬜ pending |
| 05-02-02 | 1 | auto | `node scripts/check-config.mjs && npx vitest run tests/eval-env-pin.test.ts tests/lib/env-file.test.ts` | ⬜ pending |
| 05-02-03 | 1 | tdd | `npx vitest run tests/rag/generation/config.test.ts && npm run typecheck:new` | ⬜ pending |
| 05-03-01 | 1 | tdd | `npx vitest run tests/lib/marker-grammar.test.ts` | ⬜ pending |
| 05-03-02 | 1 | tdd | `npx vitest run tests/rag/citations/marker-parser.test.ts tests/lib/marker-grammar.test.ts` | ⬜ pending |
| 05-04-01 | 1 | tdd | `npx vitest run tests/rag/context/context-blocks.test.ts tests/rag/assemble.test.ts tests/rag/legacy-chat-assembly-oracle.test.ts tests/rag/assemble-switch.test.ts && node --import tsx --test tests/rag-assemble-differential.test.mts tests/rag-assemble-query-count.test.mts` | ⬜ pending |
| 05-04-02 | 1 | tdd | `npx vitest run tests/rag/context/context-blocks.test.ts tests/rag/refs.test.ts tests/rag/pipeline-assembly.test.ts tests/rag/entrypoints-call-pipeline.test.ts` | ⬜ pending |
| 05-04-03 | 1 | tdd | `npx vitest run tests/rag/v2/context-blocks-v2.test.ts tests/rag/v2/context-stages.test.ts && npm run typecheck:new` | ⬜ pending |
| 05-05-01 | 1 | checkpoint | package legitimacy (blocking-human, before any install) | ⬜ pending |
| 05-05-02 | 1 | tdd | `npx vitest run tests/rag/citations/provider-pin.test.ts && npm ls ai @ai-sdk/anthropic` | ⬜ pending |
| 05-05-03 | 1 | tdd | `uv sync --directory rag-sidecar --locked && uv run --directory rag-sidecar pytest -q tests/test_dependency_boundary.py tests/test_image_boundary.py` | ⬜ pending |
| 05-06-01 | 1 | tdd | `node --import tsx --test tests/rag-db/answer-records-schema.test.mts tests/rag-db/schema-migrations.test.mts` | ⬜ pending |
| 05-06-02 | 1 | tdd | `node --import tsx --test tests/rag-db/answer-records-rls.test.mts tests/rag-db/answer-records-schema.test.mts` | ⬜ pending |
| 05-07-01 | 2 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_answer_contracts.py tests/test_contract_models.py tests/test_latency_contract.py tests/test_review_contract.py` | ⬜ pending |
| 05-07-02 | 2 | auto | `npm run gen:schemas && git diff --exit-code -- src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json && npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts tests/rag/eval-route-rows.test.ts && uv run --directory rag-sidecar pytest -q && uv run --directory eval pytest -q` | ⬜ pending |
| 05-08-01 | 2 | tracer | `npx vitest run tests/rag/citations/chat-citations-route.test.ts tests/rag/characterize-chat.test.ts` | ⬜ pending |
| 05-08-02 | 2 | tdd | `npx vitest run tests/rag/citations/session.test.ts tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/chat-source-images.test.ts tests/rag/characterize-chat.test.ts tests/rag/characterize-embed.test.ts tests/rag/characterize-voice.test.ts` | ⬜ pending |
| 05-08-03 | 2 | tdd | `npx vitest run tests/rag/citations/alias-transform.test.ts tests/rag/citations/marker-parser.test.ts && npm run typecheck:new` | ⬜ pending |
| 05-09-01 | 2 | tdd | `node --import tsx --test tests/rag-db/answer-records-store.test.mts` | ⬜ pending |
| 05-09-02 | 2 | tdd | `npx vitest run tests/api/rag-answers.test.ts && npm run typecheck:new` | ⬜ pending |
| 05-09-03 | 2 | tdd | `node --import tsx --test tests/rag-db/answer-records-snapshot.test.mts` | ⬜ pending |
| 05-10-01 | 2 | checkpoint | decision: which Claude models get an anthropicId (blocking-human) | ⬜ pending |
| 05-10-02 | 2 | tdd | `node --test scripts/check-config.test.mjs` | ⬜ pending |
| 05-10-03 | 2 | tdd | `npx vitest run tests/rag/citations/models.test.ts tests/rag/characterize-chat.test.ts && node scripts/check-config.mjs` | ⬜ pending |
| 05-11-01 | 3 | tdd | `npx vitest run tests/rag/citations/claude-request.test.ts` | ⬜ pending |
| 05-11-02 | 3 | tdd | `npx vitest run tests/rag/citations/claude-stream.test.ts tests/rag/citations/claude-request.test.ts tests/rag/citations/alias-transform.test.ts && npm run typecheck:new` | ⬜ pending |
| 05-12-01 | 3 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_groundedness.py tests/test_auth.py tests/test_health.py` | ⬜ pending |
| 05-12-02 | 3 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_groundedness_vectara.py tests/test_groundedness.py` | ⬜ pending |
| 05-12-03 | 3 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_groundedness.py tests/test_dependency_boundary.py` | ⬜ pending |
| 05-13-01 | 3 | tdd | `npx vitest run tests/rag/generation/answer-finish.test.ts` | ⬜ pending |
| 05-13-02 | 3 | tdd | `npx vitest run tests/rag/citations/chat-answer-record-route.test.ts tests/rag/citations/chat-citations-route.test.ts tests/rag/characterize-chat.test.ts tests/chat-strict.test.ts tests/chat-source-images.test.ts tests/rag/chat-trace-flush.test.ts` | ⬜ pending |
| 05-14-01 | 3 | tdd | `npx vitest run tests/rag/lang-script.test.ts tests/rag/lang-detect.test.ts` | ⬜ pending |
| 05-14-02 | 3 | tdd | `npx vitest run tests/rag/generation/groundedness.test.ts && npm run typecheck:new` | ⬜ pending |
| 05-14-03 | 3 | tdd | `npx vitest run tests/rag/generation/groundedness-client.test.ts` | ⬜ pending |
| 05-15-01 | 4 | tdd | `npx vitest run tests/chat-messages-roundtrip.test.ts tests/lib/chat-utils-tool-parts.test.ts && npm run typecheck:new` | ⬜ pending |
| 05-15-02 | 4 | tdd | `npx vitest run tests/lib/answer-metadata.test.ts tests/lib/use-answer-records.test.ts` | ⬜ pending |
| 05-15-03 | 4 | auto | `npx vitest run tests/ui tests/chat-messages-roundtrip.test.ts tests/lib/use-answer-records.test.ts && npm run typecheck:new` (+ human-check) | ⬜ pending |
| 05-16-01 | 4 | tdd | `npx vitest run tests/rag/citations/strategy.test.ts` | ⬜ pending |
| 05-16-02 | 4 | tdd | `npx vitest run tests/rag/citations/fallback.test.ts` | ⬜ pending |
| 05-16-03 | 4 | tdd | `npx vitest run tests/rag/citations/chat-claude-route.test.ts tests/rag/citations tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/chat-source-images.test.ts tests/chat-tool-parts.test.ts tests/rag/characterize-chat.test.ts` | ⬜ pending |
| 05-17-01 | 4 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_hhem_bake.py tests/test_dependency_boundary.py` | ⬜ pending |
| 05-17-02 | 4 | tdd | `uv run --directory rag-sidecar pytest -q tests/test_image_boundary.py tests/test_hhem_bake.py` | ⬜ pending |
| 05-18-01 | 4 | tdd | `npx vitest run tests/rag/trace-scores.test.ts` | ⬜ pending |
| 05-18-02 | 4 | tdd | `npx vitest run tests/rag/generation/answer-finish-groundedness.test.ts tests/rag/generation/groundedness.test.ts` | ⬜ pending |
| 05-18-03 | 4 | tdd | `npx vitest run tests/rag/generation/answer-finish-groundedness.test.ts tests/rag/generation/answer-finish.test.ts tests/rag/citations/chat-answer-record-route.test.ts tests/rag/chat-trace-flush.test.ts tests/rag/hot-path-logs.test.ts` | ⬜ pending |
| 05-19-01 | 4 | tdd | `uv run --directory eval pytest -q tests/test_calibrate_groundedness.py tests/test_fixture_pii.py` | ⬜ pending |
| 05-19-02 | 4 | tdd | `uv run --directory eval pytest -q tests/test_calibrate_groundedness.py tests/test_calibrate_refusal.py tests/test_calibrate_holdout.py` | ⬜ pending |
| 05-20-01 | 5 | tdd | `npx vitest run tests/lib/citation-markers.test.ts tests/lib/marker-grammar.test.ts` | ⬜ pending |
| 05-20-02 | 5 | tdd | `npx vitest run tests/ui/citation-sources.test.ts tests/ui && npm run typecheck:new` | ⬜ pending |
| 05-20-03 | 5 | auto | `npx vitest run tests/ui tests/lib/citation-markers.test.ts && npm run typecheck:new` (+ human-check) | ⬜ pending |
| 05-21-01 | 5 | tdd | `npx vitest run tests/rag/generation/feedback.test.ts tests/api/rag-answers-feedback.test.ts` | ⬜ pending |
| 05-21-02 | 5 | tdd | `npx vitest run tests/rag/generation/feedback.test.ts tests/rag/generation/answer-finish-groundedness.test.ts && node --import tsx --test tests/rag-langfuse-review.test.mts` | ⬜ pending |
| 05-21-03 | 5 | tdd | `npx vitest run tests/api/review-candidates.test.ts tests/api/admin-auth.test.ts && uv run --directory eval pytest -q tests/test_review_queue.py` | ⬜ pending |
| 05-22-01 | 5 | tdd | `npx vitest run tests/rag/eval-route-citations.test.ts tests/rag/eval-route-rows.test.ts tests/rag/eval-route-stage-overrides.test.ts tests/eval-route-auth.test.ts tests/eval-answer-sentinel.test.ts` | ⬜ pending |
| 05-22-02 | 5 | tdd | `npx vitest run tests/rag/eval-fake-generator.test.ts && npm run test-rag -- --citations --groundedness --out eval/out/p5-22 && jq -e '.passed == true and .paired.all_zero == true' eval/out/p5-22/gate.json` | ⬜ pending |
| 05-23-01 | 6 | tdd | `npx vitest run tests/lib/badge-state.test.ts` | ⬜ pending |
| 05-23-02 | 6 | tdd | `npx vitest run tests/lib/answer-feedback-client.test.ts tests/lib/citation-markers.test.ts` | ⬜ pending |
| 05-23-03 | 6 | auto | `npx vitest run tests/ui tests/lib && npm run typecheck:new` (+ human-check) | ⬜ pending |
| 05-24-01 | 6 | tdd | `uv run --directory eval pytest -q tests/test_citation_metrics.py tests/test_metrics.py` | ⬜ pending |
| 05-24-02 | 6 | tdd | `uv run --directory eval pytest -q tests/test_report_citations.py tests/test_latency_report.py tests/test_report_runner.py tests/test_judge_config.py` | ⬜ pending |
| 05-25-01 | 7 | tdd | `node --import tsx --test tests/rag-db/schema-equality.test.mts tests/rag-db/schema-migrations.test.mts tests/rag-db/answer-records-rls.test.mts` | ⬜ pending |
| 05-25-02 | 7 | tdd | `uv run --directory eval pytest -q tests/test_phase_compare.py && uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase5-comparison.json --out eval/reports/phase-05 && jq -e '.passed == true' eval/reports/phase-05/comparison.json` | ⬜ pending |
| 05-25-03 | 7 | auto | `npx vitest run && node --import tsx --test tests/*.test.mts tests/rag-db/*.test.mts && uv run --directory eval pytest -q && uv run --directory rag-sidecar pytest -q && node scripts/check-config.mjs && npm run typecheck:new && node scripts/ci/check-rag-boundary.mjs && npm run gen:schemas && git diff --exit-code -- src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json` | ⬜ pending |
| 05-26-01 | 8 | checkpoint | live: Anthropic spike (ANTHROPIC_API_KEY) | ⬜ pending |
| 05-26-02 | 8 | checkpoint | live: Vectara and Langfuse (VECTARA_API_KEY, Langfuse keys) | ⬜ pending |
| 05-26-03 | 8 | checkpoint | live: HHEM image build and run (Docker) | ⬜ pending |
| 05-26-04 | 8 | checkpoint | live: Supabase migration, Faithfulness vs baseline, calibration | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Sampling continuity: apart from the four live checkpoints of 05-26, which make up the last wave on their own, no wave has three consecutive tasks without an automated command; the other non-automated tasks are the blocking checkpoints 05-05 Task 1 (wave 1) and 05-10 Task 1 (wave 2), each followed by automated tasks.

---

## Wave 0 Requirements

Research §"Wave 0 Gaps" items and the plan that closes each (they are early-wave tasks, not a separate wave):

- [ ] Recorded-shape Anthropic SSE fixtures `tests/fixtures/anthropic/{citations,thinking-citations,websearch-tool,error-before-first-token,refusal-before-first-token}.sse` and the fetch fake `tests/helpers/fake-anthropic.ts` — 05-11
- [ ] `tests/rag/citations/` (parser, transforms, session, request, stream, strategy, fallback, route tests) — 05-03, 05-08, 05-11, 05-16; badge rule `tests/lib/badge-state.test.ts` — 05-23
- [ ] `tests/rag-db/answer-records-{schema,rls,store,snapshot}.test.mts` on the PGlite harness — 05-06, 05-09
- [ ] `rag-sidecar/tests/test_groundedness.py` and `test_groundedness_vectara.py` with stub scorers and `httpx.MockTransport` — 05-12; `test_hhem_bake.py` — 05-17
- [ ] Langfuse scores: the fake server already captures `/api/public/scores` (202 and 207); the TypeScript client and its tests — 05-18
- [ ] Contracts (CitationRecord, AnswerGroundedness, AnswerFeedback, AnswerFeedbackRequest, AnswerRecord, GroundednessRequest, GroundednessResult, GroundednessThresholds; RagTrace citations, RagRunOptions, ReviewQueueItem.reasons, LatencyBudgets groundedness, SidecarReady.scorers, EvalReport citation fields) — 05-01, 05-07
- [ ] Env switches and the call-time reader — 05-02
- [ ] Fixture fakes for the eval (fake citation generator, fake groundedness endpoint) — 05-22; labelled groundedness pairs — 05-19
- [ ] CI: new database suites live in `tests/rag-db/` (collected by the plan 03-01 glob step), new vitest suites under `tests/**/*.test.ts`, new sidecar and eval tests under their `tests/` folders; no workflow edit needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Package legitimacy of @ai-sdk/anthropic 3.0.143, torch (CPU), transformers 5.23.0 and the two pinned HF revisions | GEN-01, GEN-05 | Planner rule: legitimacy checkpoints are never auto-approved | 05-05 Task 1 |
| Which Claude models get an anthropicId | GEN-01 | Product decision (Sonnet 4.5 retires 2026-11-30, Opus 4.1 retired) | 05-10 Task 1 |
| Web chat request carries capabilities and chatId; polling stops; reload fetches records once; incognito makes no record calls | GEN-03, GEN-06 | Needs a browser and a running app | 05-15 Task 3 `<human-check>` |
| Chips and the sources-panel snapshot entry, including the "updated or removed" note after deleting a document | GEN-02, GEN-03 | Visual | 05-20 Task 3 `<human-check>` |
| Badge states and visibility, feedback control and vote change | GEN-06, EVAL-16 | Visual, needs the sidecar running | 05-23 Task 3 `<human-check>` |
| Anthropic spike (model ids via GET /v1/models, Citations with thinking, tools, MCP and webSearch on real streams, TTFT) | GEN-01 | No ANTHROPIC_API_KEY here | 05-26 Task 1 |
| Vectara host, header, limits and retention; Langfuse score types and tag merging | GEN-05, EVAL-16 | No VECTARA_API_KEY or Langfuse keys here | 05-26 Task 2 |
| HHEM image build and run, memory and latency at 1k, 3k and 6k tokens | GEN-05 | No Docker daemon here | 05-26 Task 3 |
| Live migration and RLS on Supabase; Faithfulness on the real golden set against the baseline; live calibration | GEN-03, GEN-07, GEN-05 | No live project or judge keys here | 05-26 Task 4 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are checkpoints listed above
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (mapped to plans above)
- [x] No watch-mode flags
- [x] Feedback latency < 60 s for per-task commands
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
