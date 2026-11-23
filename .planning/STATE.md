---
gsd_state_version: "1.0"
milestone: v5.0
current_phase: 01
current_phase_name: Evaluation Harness & Baseline
status: executing
stopped_at: Completed 01-19-PLAN.md
last_updated: "2026-11-23T11:04:29.892Z"
last_activity: 2026-11-23
last_activity_desc: Phase 01 execution started
state_head: 554cd6b993e7fef29c937bc855410cf3bd0227e7
progress:
  total_phases: 8
  completed_phases: 0
  total_plans: 22
  completed_plans: 19
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-22)

**Core value:** Questions the knowledge base can answer get correct answers with accurate citations; questions it cannot answer get an explicit "I don't know". Both are proven by eval scores.
**Current focus:** Phase 01 — Evaluation Harness & Baseline

## Current Position

Phase: 01 (Evaluation Harness & Baseline) — EXECUTING
Plan: 20 of 22
Status: Ready to execute
Last activity: 2026-11-23 — Phase 01 execution started

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 7min | 2 tasks | 16 files |
| Phase 01 P02 | 15min | 2 tasks | 9 files |
| Phase 01 P03 | 6min | 2 tasks | 8 files |
| Phase 01 P04 | 20min | 2 tasks | 9 files |
| Phase 01 P05 | 5min | 2 tasks | 18 files |
| Phase 01 P06 | 12min | 2 tasks | 9 files |
| Phase 01 P07 | 12min | 2 tasks | 6 files |
| Phase 01 P08 | 10min | 2 tasks | 8 files |
| Phase 01 P09 | 8min | 2 tasks | 6 files |
| Phase 01 P10 | 15min | 2 tasks | 5 files |
| Phase 01 P11 | 15min | 2 tasks | 6 files |
| Phase 01 P12 | 8min | 2 tasks | 9 files |
| Phase 01 P13 | 14min | 2 tasks | 7 files |
| Phase 01 P14 | 20 min | 2 tasks | 11 files |
| Phase 01 P15 | 25min | 3 tasks | 7 files |
| Phase 01 P16 | 10min | 2 tasks | 3 files |
| Phase 01 P17 | 5min | 3 tasks | 8 files |
| Phase 01 P18 | 35min | 2 tasks | 10 files |
| Phase 01 P19 | 25min | 2 tasks | 13 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Research's 9 phases compressed to 7 for standard granularity: ingestion + embeddings merged (Phase 3); external backends + closeout merged (Phase 7)
- [Roadmap]: Query layer ships two switchable frameworks (`RAG_QUERY_FRAMEWORK=llamaindex|langchain`, default `llamaindex`); LangChain is confined to one adapter that wraps `src/lib/rag/` as a retriever, with zod 4 isolated from the app's zod 3 (user scope change, QRY-08)
- [Roadmap]: RET-01..03 are mapped to Phase 4 (adapter contract, pgvector, shared tokenizer, backend-agnostic conformance tests); their "every backend" clauses are re-verified in Phase 7 criterion 3
- [Roadmap]: The lexical approach is fixed by RET-03 (one shared application tokenizer writing `lexical_text`); Node.js 22 is fixed by PIPE-10 and enforced in Phase 2
- [Roadmap]: Phases 5 and 6 can run in parallel after Phase 4
- [Phase 01]: 01-01: contract tests for gen-zod use node:test in scripts/tests/*.node-test.mjs (outside vitest globs)
- [Phase 01]: 01-01: npm ci needs --ignore-scripts in sandbox (onnxruntime-node CUDA postinstall 404)
- [Phase 01]: 01-02: chunk embeddings use raw chunk text (as process-document does); PGRST116 406 is not counted as a fake-edge error
- [Phase 01]: 01-02: fake edge supports limit param on table reads (chat route uses it); all other params rejected and recorded
- [Phase 01]: 01-03: Golden cross-field rules (answerability, spans, multi_turn conversation) are enforced only in Pydantic; generated Zod enforces structure, enums, id pattern, quote min length and rejects chunk_id keys
- [Phase 01]: 01-04: trace kept = chunks entering the context (inherits document's kept_by when the chunk itself failed Filter 1)
- [Phase 01]: 01-04: eval route does one chunk-metadata lookup per candidate feeding both image-url merge and URL collection
- [Phase 01]: 01-05: NoiseConfig.metrics defaults to the five report metrics (false_refusal_rate lower); JudgeConfig.temperature required and bounded ge=0 le=0 so Zod enforces the pin
- [Phase 01]: 01-06: freeze_splits overrides split of new ids with the rule-assigned split and raises only when an existing manifest id disagrees; manifest written only when new ids are added
- [Phase 01]: 01-07: English fixture corpus kept plain and untuned; image document loads as warehouse-floorplan.png (filename from fixture-meta)
- [Phase 01]: 01-09: vitest only collects tests/**/*.test.ts; node:test .mts files stay outside npm test
- [Phase 01]: 01-10: request_options normalized with nulls before hashing; run_config_hash excludes golden_path, run_id, created_at, git_sha
- [Phase 01]: 01-11: check-config manifest seeded by measurement (64 vars, 4 managed, 44 legacy with gaps); knownGaps limited to the four tracked locations
- [Phase 01]: 01-12: secret under 32 chars is treated as unset (503); probe exemption is exact-match /health and /ready only
- [Phase 01]: 01-13: aggregate returns a dict keyed by EvalReport field names and only supports k_values (5, 10); a refused trace scores zero hits; score_items raises on missing or duplicate traces
- [Phase 01]: 01-14: stub generator records generator_model stub/extractive-v1 so stub and live traces never share a config hash
- [Phase 01]: 01-14: eval answer prompt replicates the chat route's env-configured branch and is tied to it by a source-reading sentinel test
- [Phase 01]: 01-15: fixture golden set is 72 items (24 per language) with per-language no_answer items 001-002 near-miss and 003-004 out-of-domain; every gold quote matches exactly one chunk
- [Phase 01]: 01-16: categories-report-only statement is a fixed line in report.md; notes carry only the zh Filter 1 quirk
- [Phase 01]: 01-18: Judge provider rejections (credentials, temperature 0, structured output) raise JudgeFatalError and exit 4 instead of being recorded as per-item judge_error
- [Phase 01]: 01-18: build_ragas_live verifies Ragas sends temperature 0 because Ragas rewrites it to 1.0 for recognized reasoning-model ids
- [Phase 01]: 01-19: Claude drafting sends no temperature and no forced tool_choice (claude-sonnet-5-5 rejects both); tool input validated with DraftedItemBatch
- [Phase 01]: 01-19: Ragas style/length/persona recorded in a gitignored <out>.notes.json sidecar instead of a new GoldenItem field

### Pending Todos

None yet.

### Blockers/Concerns

- [Env]: No live vendor keys or Supabase project. The Docker CLI is present but its daemon is not running, and only the `psql` client is installed. DB-backed tests need CI service containers or an in-process Postgres with pgvector; real-key steps are each phase's **Live verification** items.
- [Docs]: PROJECT.md (Active query-layer item, Key Decisions row) and REQUIREMENTS.md Out of Scope ("LangChain (any layer)") still say no LangChain. The QRY-06 rewording and the QRY-08 text are pending from the coordinator.
- [Phase 1]: Golden-set curation effort; Ragas zh/it adaptation; DeepEval/Ragas telemetry variable names unverified; the Pydantic-to-Zod generator must target the app's Zod 3.
- [Phase 3]: Docling OCR on scanned zh/it; Qwen3 host details (dimension parameter, `input_type` vs manual prefix); `halfvec` HNSW build cost.
- [Phase 4]: Voyage `rerank-3` ID and zh/it quality vs `rerank-2.5`; real thresholds need the real golden set.
- [Phase 5]: Deepest uncertainty: whether AI SDK v6 Anthropic Citations survive streaming with tools/MCP/webSearch (spike first); Vectara host, limits and retention.
- [Phase 6]: `@langchain/core` zod 4 isolation from the app's zod 3; LangChain HyDE has no stock retriever and is a port.
- [Phase 7]: Weaviate hybrid inside a tenant and Chinese tokenizer availability on Cloud; Qdrant per-prefetch filters; drain worker under the 60 s cap.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-11-23T11:04:29.833Z
Stopped at: Completed 01-19-PLAN.md
Resume file: None
