---
gsd_state_version: "1.0"
milestone: v5.0
current_phase: 02
current_phase_name: Unified Retrieval Pipeline & Tenant Scope
status: executing
stopped_at: Completed waves 4-7 (02-08, 02-09, 02-10, 02-15)
last_updated: "2026-11-23T14:27:14.194Z"
last_activity: 2026-11-23
last_activity_desc: Phase 02 plans 11, 12, 16, 17, 18, 22 merged
state_head: 3facf75a846e7a13be2716bdf7768179dca6018b
progress:
  total_phases: 9
  completed_phases: 0
  total_plans: 58
  completed_plans: 35
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-22)

**Core value:** Questions the knowledge base can answer get correct answers with accurate citations; questions it cannot answer get an explicit "I don't know". Both are proven by eval scores.
**Current focus:** Phase 02 — Unified Retrieval Pipeline & Tenant Scope (Phase 01 code complete; its human verification items remain open)

## Current Position

Phase: 02 (Unified Retrieval Pipeline & Tenant Scope) — EXECUTING
Plan: 25 of 36 complete (02-01..18, 02-22, 02-30..35)
Status: Executing sequentially
Last activity: 2026-11-23 — 02-08, 09, 10, 15 merged; tsc ratchet 58; 480 vitest tests pass; Phase 3 research + patterns committed

Progress: [███████░░░] 69%

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
| Phase 01 P20 | 20min | 2 tasks | 9 files |
| Phase 01 P21 | 6min | 2 tasks | 6 files |
| Phase 01 P22 | 12min | 2 tasks | 7 files |
| Phase 02 P01 | 25 min | 3 tasks | 9 files |
| Phase 02 P03 | 9 min | 2 tasks | 9 files |
| Phase 02 P05 | 5 min | 2 tasks | 6 files |
| Phase 02 P02 | 12 min | 2 tasks | 13 files |
| Phase 02 P04 | 8 min | 2 tasks | 14 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:
- [02-11] Eval refusal is `refusalCandidate` with reason `no_relevant_context`; a route that passes `trace` owns `finishTrace`; `stage_status` is part of RagTrace; pipeline error or incomplete assembly in eval is HTTP 500.
- [02-12] Chat route resolves scope before the stream (403/503 JSON); retrieval error or degraded-without-documents streams a localized "knowledge base temporarily unavailable" error part; org owner without a member row is backfilled by `repairOwnerMembership` only when `organizations.owner_id` matches.
- [02-14] Embed tenant comes only from `RAG_EMBED_TENANT`; a body naming another workspace gets 403; unconfigured/unknown/unavailable tenant or retrieval error streams the localized unavailable part (language from Accept-Language); embed context now uses the chat assembly format (snapshot regenerated, differences listed in 02-14-SUMMARY).
- [02-16] Voice payload travels in `RetrievalResult.voice`; voice-rag maps error/degraded-without-results to 503, empty to `{results: []}`; scope doc lookup capped at 500, chunk queries batched by 100. Gap fix: single-tenant tokens carry a signed `act` claim and voice-chat saves under it; body user ids are ignored.
- [02-17] Voice agent sends `x-rag-scope-token`; one active user per agent (guard covers connect/disconnect handlers); a failed KB turn is spoken but not stored.
- [02-18] Media profile = embed, search (k=10, threshold 0.3, admin client), assemble, scoped by `resolveTenantScope`; `rag_status` added to media responses.
- [02-13] `refs` is an optional stage (5000 ms, skip on failure = degraded); out-of-scope and nonexistent document ids are both ignored and logged under `[RAG Tenant]`; the no-query overview fallback searches only the caller's scope; retired legacy imports are gone from the chat route.
- [02-22] Langfuse via OTel replay after response; tenantKey on every span; sampling hashes request id with a per-purpose prefix; masking order e-mail, IBAN, CN ID, IT CF, Luhn card, phones.

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
- [Phase 01]: 01-20: allow-spread relaxes only metric-value check; run_config_hash must always match across baseline runs
- [Phase 01]: 01-20: gate data mismatch (exit 2) covers golden, corpus and embedder identity only; live baselines must live under eval/golden/private
- [Phase 01]: 01-21: null and default cases live as named variants in samples.json so Pydantic and Zod validate the same Python-built values
- [Phase 01]: 01-22: gh could not resolve action releases; pinned checkout@v4, setup-node@v4, setup-uv@v5, upload-artifact@v4 (confirm on first GitHub run)
- [Phase 01]: 01-22: every CI job running eval pytest or the harness syncs eval with --locked --all-extras, enforced by scripts/ci/check-workflows.py
- [Phase 02]: Root tsconfig excludes voice-agent and baileys-whatsapp and allows .mts import extensions; a per-file tsc ratchet (baseline 231 with route types) is the interim gate until plan 02-36
- [Phase 02]: voice-agent and baileys-whatsapp both install cleanly and type-check at 0 errors; both are ratcheted in the sibling-types CI job (baileys via Corepack Yarn 4 --immutable --mode=skip-build)
- [Phase 02]: RAG_VOICE_TOKEN_ prefix and RAG_EMBED_TENANT excluded from eval pins; RAG_PIPELINE, RAG_DISABLED_STAGES, RAG_STAGE_TIMEOUTS pinned at legacy/empty for parity runs
- [Phase 02]: check-config NAME_PATTERN covers LANGFUSE_*; new Phase 2 env vars land in all five places in plan 02-03 so later plans only read env.X
- [Phase 02]: 02-05: Fake edge operators are opt-in per table and column; tenant filters on documents only, or/image_url on document_chunks only
- [Phase 02]: 02-05: match_documents_by_workspace does not check membership, so (O, B) returns O chunks; the application layer must enforce the organization_members gate
- [Phase 02]: 02-06: characterization snapshots (embed/voice/chat) change only via UPDATE_CHARACTERIZATION=1; switch plans list every snapshot diff as intended; frozen chat assembly oracle verbatim from 172c2ad
- [Phase 02]: 02-30: RoutedTool is the exported type for routed MCP tools; transport headers go through requestInit; discovery/health/approve runtime bugs fixed
- [Phase 02]: 02-31: WhatsApp webhook uses validateWebhookSignature (401 on bad signature); signature compare must become constant-time in code review
- [Phase 02]: 02-32: embed window body built by toEmbedRequestBody on the v6 useChat
- [Phase 02]: 02-35: dynamic route handlers await Promise params; PATCH /api/user/preferences returns 401 with no user; Stripe version pinned by typed cast
- [Phase 02]: 02-07: runRetrieval equals enhancedRetrieveChunks on all 72 golden questions; scopeKey s:default|u:<id>|o:<id>; RPC errors raise RetrievalBackendError in the re-homed search; 02-20 must forbid importing mintScope outside src/lib/rag/tenant/ and tests
- [Phase 02]: 02-33: Folder imported from @/types/folder; SidebarState.searchQuery added for UPDATE_SEARCH_QUERY
- [Phase 02]: 02-34: semantic chunker maxTokens ReferenceError fixed (Phase 3 must re-measure chunking on oversized branches); v6 tool-part envelopes unwrapped with legacy fallback; Chat.folder_id is string | null
- [Phase 02]: 02-08: config-disabled stages are `disabled`, never degrade the result; RPC errors keep reason `backend_error`; whoever creates the trace collector calls finishTrace; RagDeps.ragEnv() is the injectable config source
- [Phase 02]: 02-09: post_filter and assemble run for chat, embed and eval (not voice or media); status `empty` with candidates present uses reason `no_relevant_context`; strict refusal needs refusalCandidate AND status empty; PostgREST URL length for 100 ids still a live check
- [Phase 02]: 02-10: resolvers lowercase ids after the UUID check (mintScope unchanged); embed scope from server config, raw body compared before schema strip; voice org tokens must carry uid; org owners without an organization_members row get 403 — 02-12 must backfill or repair first
- [Phase 02]: 02-15: LiveKit identity and room (myrag-voice) are server-assigned; any other `user-` participant means 409 voice_busy; deploy voice agent (02-17) before the app
- [Phase 02]: Node engines pinned to ^22.12.0 (not >=) so Vercel stays on Node 22
- [Phase 02]: Paired statistics take slice membership from gate-split report items and one fixed-seed RNG per (slice, metric) cell; all_zero needs at least one cell with data

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

Last session: 2026-11-23T14:27:14.060Z
Stopped at: Completed waves 4-7 (02-08, 02-09, 02-10, 02-15)
Resume file: None
