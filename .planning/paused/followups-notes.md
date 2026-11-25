# Phase 2 sequential execution order (frontmatter wave, then id)
W1: 01 03 05 | W2: 02 04 06 30 31 32 35 | W3: 07 33 34 | W4: 08 | W5: 09 | W6: 10
W7: 11 15 | W8: 12 22 | W9: 13 | W10: 14 | W11: 16 23 | W12: 17 18 29 | W13: 19
W14: 20 | W15: 21 | W16: 24 | W17: 25 | W18: 26 | W19: 27 | W20: 28 | W21: 36
Dispatch: gsd-executor, model sonnet, background; prompt = same template as 02-01 (paths, root-pin.sh, tdd.md). Push after each plan.
After all: code review gate -> regression gate -> verifier -> update roadmap.
## Parallel mode (user: "能使用并行就使用并行")
- Phase 3 + Phase 4 discuss agents running (no commits; orchestrator commits their phase dirs). Then research/pattern/plan for each; Phase 3.1 discuss after 03-CONTEXT exists.
- Phase 2: after 02-04 finishes, run wave-2 rest (06,30,31,32,35) in parallel with isolation:"worktree"; executors must NOT touch STATE/ROADMAP/REQUIREMENTS; symlink node_modules; orchestrator merges branches + updates STATE/ROADMAP.
- 02-32 merged (ff 23b6ae2). Decisions: embed body via toEmbedRequestBody helper; shared page title fallback; ExtendedFormEvent typed data. Human check: embed window send one message. PIPE-01 shared.
- 02-31 merged. Decisions: webhook uses validateWebhookSignature (401 on bad sig, was silently 200); abstract provider methods widest shape; conversations DELETE via SSR client + user_id filter. Open: signature compare not constant-time (fix in review).
- 02-12: org owner with no organization_members row gets 403 from resolveTenantScope; backfill owner rows or call verifyUserOrganizationAccess repair first (from 02-10).
- 02-18 follow-up: chat-input.tsx image/video fetches (~L1741, ~L2045) don't send organizationId; multi-tenant org users get personal-workspace media context only. Fix in a later plan (02-12 scope or Phase 2 gap).
- 02-16 follow-ups: (a) drop unused `embedding` column from voice keyword step-2 select + regenerate voice snapshots (02-19); (b) single-tenant dedupe quirk (image chunk twice) kept for snapshot parity; (c) 2 TS2790 sites in semanticRerank remain until 02-19; (d) single-tenant voice-chat save regression -> gap fix running (actor id in token).
- 02-22: add tests/rag-langfuse-export.test.mts to pr-smoke.yml (node:test list). Live: Langfuse root trace id, Hobby quota.
- 02-17: check-workflows needs `uv run --directory eval --all-extras --frozen`. Live voice session with token pending. Agent unavailable line English-only.
- 02-12: 02-13 must tenant-scope the no-query overview match_document_chunks (admin, no predicate!) + remove dead enhancedRetrieveChunks/thinking imports. chat-strict now asserts first call only.
- 02-13 pre-existing bug: chat route collapses text+document array message to plain text unless an image_url part exists, so document parts rarely reach retrieval. Needs decision/gap plan. characterize-chat still mocks thinking-rag-enhancer (drop in 02-19).
- 02-14 human check: load /embed/chat.js with RAG_EMBED_TENANT unset (multi-tenant) -> generic error bubble, no dots; valid tenant -> normal stream.
- 02-23: pre-existing — metadata object in createUIMessageStream onFinish is ignored by SDK (never reaches client); 02-23 added real messageMetadata for ragTraceId only. Live: review tags in a real Langfuse project.

## From 03-01 (2026-11-24)
- D-08 quarantine/not-current filter covers only the 8 search RPCs. Direct readers still see quarantined or non-current chunks: voice keyword fallback, `refs/resolve`, `context/fetch-rows`, documents routes, and the table SELECT policies (single-tenant `USING (true)`, multi-tenant owner/member). No Phase 3 plan names these paths explicitly. Check in the Phase 3 code review; add a gap plan if 03-30/03-37 do not close it.
- Security backlog (05.1 research F-11): `baileys-whatsapp/server.ts:119` fetches link previews server-side for any URL in a reply (exfiltration/SSRF channel). Fix with an allowlist or disable previews for assistant replies.

## Phase 3 wave 5 follow-ups (2026-11-24, orchestrator)
- Quarantine bypass readers left after 03-20 (fold into 03-30 / 03-37 / a gap plan):
  - `GET /api/documents` lists quarantined rows and derives `ready` from chunk count (03-30; decide whether owners see their own quarantined docs, status `quarantined`).
  - `GET /api/images` and `GET /api/scrapers/status` read chunks/documents unfiltered (03-30 Task 2: add `is_current` AND `status='ready'`).
  - Table SELECT RLS: single-tenant `FOR SELECT USING (true)` on documents/document_chunks lets anon read quarantined text via PostgREST; multi-tenant lets owner/org members. Needs a migration in both setup files + schema-equality test (03-37 migration or gap plan).
  - `get_document_chunks(doc_id)` (ST SQL) unfiltered and not revoked from anon/authenticated; same migration.
  - `fetch-rows.ts` by-id reads stay unfiltered on purpose (ids come from filtered RPCs).
  - Legacy writers never scanned while `RAG_INGEST_PIPELINE=legacy` (T-03-58, accepted). Image captions (03-38) and invoice party names (03-29) must call `scanText`.
- 03-29 hand-offs:
  - Register `invoice` in CHUNKERS and EXTRACTORS; restore `extractor_unavailable`-free assertions in tests/rag/ingest/extractors.test.ts, runner.test.ts; drop the stand-in chunker in resolve-doc-type.test.ts.
  - Real Docling merges adjacent short Latin lines: `extract_invoice` returned confidence 0 on real en/it invoice Markdown (zh fine). Make the extractor tolerate merged lines.
  - Old bug: `_table_header` in rag-sidecar docling_adapter.py returns None when a table starts after the first six lines of a chunk. Fix with a failing-first test.
- 03-17: resume rehydrate re-runs chunk/enrich/extract; images output is kept in processing_state.images (03-32/03-38).
- Operator: apply migrations 0311 (private rag-originals bucket + rag_get_ingest_origin) and 0312 (doc type defaults); run `npm run rag:backfill-hashes -- --dry-run` after 0301..0312.

## Phase 3 wave 6 follow-ups (2026-11-24, orchestrator)
- 03-26: post-filter thresholds in `src/lib/rag/context/assemble.ts` (0.65 chunk, 0.6 document, 0.25 image) are still legacy constants. Before a non-legacy embedding profile is activated, pass `context_threshold` / `context_image_threshold` from the profile's `score_calibration` into `AssembleInput` (plan 04-20 or 04-13). Seeded Voyage/Qwen rows have `{}` calibration and warn `CALIBRATION MISSING`.
- 03-27: LlamaParse v2 response shapes (upload field, job.status location, items/bbox, image hosts) verified only against a local fake; 03-48 live item 1. LlamaParse chunks have null page_start/page_end. 03-38 rebuilds the picture list from processing_state.artifacts + docling.json.
- 03-28: `rag_record_backfill_gap` takes `p_tenant_key`; 04-31 calls `resolveEmbeddingTargets(writer)`. Live Voyage/Qwen dual-write unverified.
- 03-23: Firecrawl `pdf` output (`actions.pdfs`) unverified live.
- Flaky under load: `tests/rag/injection-scan.test.ts` 1 MB < 1 s timing bound; `tests/rag-langfuse-export.test.mts` waitFor timeout. Fix if they fail in the main tree.
- Operator: apply migration 0313 (dual-write writer) before enabling RAG_EMBEDDING_PROFILES or a backfill; fill score_calibration before activating a non-legacy profile; restart after fixing a startup MISMATCH.
- 03-30: lineage DELETE does not remove stored originals / parse.md / docling.json in the private `rag-originals` bucket (orphaned objects). No plan owns it — gap fix using `removeArtifacts`, with a two-tenant test. Images DELETE removes only the named document, not the lineage. Dashboard (`document-dashboard.tsx`) does not know `quarantined` (03-43). Response gained `version` (1 for legacy rows).
- Still open after 03-30 (03-37 or gap plan): table SELECT RLS on documents/document_chunks (ST `USING (true)`), `get_document_chunks(doc_id)` unrevoked.

## Phase 3 wave 7 follow-ups (03-31)
- process-document multi-tenant: a throwing session lookup answers 500 (outer catch), not 503; nothing is parsed or written. Legacy kept unchanged per plan. Add a try/catch returning 503 in the Phase 3 review fix pass.
- Unified upload response has no `text`; `src/app/page.tsx` `fileType === 'document'` branch requires it. Not reached today (temporary uploads stay legacy). Must be handled before Phase 7 makes unified the default.
- Live check: Config UI upload as signed-in admin (admin_session + Supabase session), confirm `documents.source = 'config_upload'`.
- (03-35) Voice/media do not run exact_id_lookup; eval StageName contract lacks `exact_id_lookup` (cannot disable/time per eval request). EU VAT checksum only IT/DE/FR/AT/BE/NL.

## Phase 3 wave 7 follow-ups (03-33) — fix in review pass, each with a failing test first
- OLD BUG: legacy generic-provider multi-folder branch writes nango sync status `'synced'`, rejected by the CHECK; `document_id`/`last_synced_at` never saved. Fix legacy to `'completed'`.
- OLD BUG (data loss risk): `fetchGoogleDriveFiles` reads only one page (≤ NANGO_MAX_FILES_PER_SYNC); in a larger folder a synced file off page 1 looks orphaned and is deleted. Orphan delete must skip when the listing is truncated.
- Orphan deletes and documents DELETE leave stored originals/artifacts in the object store (same as 03-37 item).

## Phase 3 wave 7 follow-ups (03-34)
- Reaper uses `rag_mark_document_failed`, which does not require `status='processing'`; a row quarantined between read and mark could be marked failed. Review pass: conditional SQL (new migration) with a failing test.
- Single-tenant resume is admin-only until the unified writer records an owner in single-tenant mode.
- Live: resume route against a real sidecar job (03-48 checklist).

## Phase 3 wave 7 follow-ups (03-32)
- `scripts/config-ui/index.html` `uploadKBImage` does not send `upload_source=config_upload`; Config UI image uploads get the session scope. Fix in 03-43 or the review pass.
- Unified image uploads: identical bytes from one tenant dedup (legacy made two documents); accepted.
- Live (03-48): real image upload on a deployed project — caption quality, after() finishing inside 60 s.
- DATA-11 stays open until 03-38 (PDF images).

## Phase 3 wave 7 follow-ups (03-37)
- Admin quarantine scope = administered tenants (own `u:` + orgs where owner/admin; `s:default` single-tenant), narrower than the plan's deployment-wide list. Accepted (safer). One place: `rag_admin_tenant_keys`.
- 03-47 must fold BOTH 0316 stems (`0316_quarantine_access.<mode>.sql`, `0316_quarantine_admin.sql`) into setup files; until then a setup-file re-run reopens SELECT policies.
- Service-role SQL functions without D-08 filter and no app caller: `get_documents_by_type_slug`, `get_documents_by_type_slug_workspace`, `get_workspace_context` (multi-tenant). Review pass: filter or drop, with tests.
- `DELETE /api/documents/{id}` still leaves stored objects in `rag-originals` (only admin delete removes them). Review pass fix.
- 03-43 panel: show `detected_by`; handle delete 200 `{artifacts_failed}`.

## Phase 3 wave 8 follow-ups (03-41a)
- 03-41 deferred item (empty documents.content) resolved by 03-41a / migration 0319 (operator: apply after 0318).
- Unified docs ingested before 0319 keep content = '' until re-ingested (no backfill).
- Full parse text goes in one rag_set_document_fields call; watch PostgREST request size for multi-MB documents (live check).
- Correct-refusal on the fixture no-answer slice is 0.333 in both modes (6 of 9 answered wrongly); Phase 5 abstention work should target it.
- (03-40) CLI/route completeness does not count the legacy `embedding` column (no SQL function exposes it); the activation gate still counts it in the flip transaction. A profile flip refreshes only the local process cache (others within 30 s TTL). Live: real project activation + rollback.

## From the 2026-11-25 session (Claude Code takeover)
- 03.1-40: `rag-sidecar/Dockerfile` copies no `config/` directory, so `parse-routing.json` and `processing-profiles.json` are missing in the image; a deployed worker cannot run tiered jobs. Fix before 03.1-53/54 live work.
- 03.1-40: `tests/rag-e2e/queued-callbacks-two-tenant.test.mts` still expects 400 for native mode (03.1-34 made native work) — 3 stale assertions.
- 03.1-40: attempt cost key mismatch — contract `est_cost_usd`, SQL 0353 reads `est_cost`; worker writes the job total instead (open since 03.1-22).
- 03.1-41: batch USD reserved for L3 has no refund (same as 03.1-19).
- 04-41: `rag_exact_id_documents` has no filter arguments, so the exact-id leg stands down on filtered requests; adding filter args would restore recall.
- Phase 3 verification (03-VERIFICATION.md): W1–W5 being fixed in exec/03-gaps; live: apply 0409/0410/0411 to the live DB (anon can still call match_document_chunks_by_org there).
- `legacy-cloud-guard.test.ts` LOW-5 temp-dir check is not isolated: concurrent processes writing to os.tmpdir make it fail.
- Timing tests (`lexical-tokenize` "under one second", `injection-scan`, `voice-budget`) fail under heavy local load.

## Added 2026-11-25 (orchestrator, batch 3)
- 03.1-49: rag_write_chunks (0408) fails with "cannot get array length of a scalar" when a profile's vector list has a null entry; `jsonb_typeof(...)='array' AND jsonb_array_length(...)` is not guaranteed to short-circuit (PGlite reproduces; real PG may too). Needs a CASE guard + failing test.
- 03.1-49: under RAG_PIPELINE=v2, chunking-profile children are embedded synchronously even in batch_api backfill.
- 04-46: ingest-mode lexical hit flips between identical runs (ordering instability); single-item category slices count a 1-rank move as a drop.
- 04-UI-SPEC: Ingestion panel passes literal `{appUrl}` to the shared sign-in label.
- Phase 4 verify: check-frontend-design-summary needs "## Design skills" in older 04 SUMMARYs (04-29..32, 04-44, 04-45 ...).
- 03.1-50: run .github/workflows/ray-optional.yml once by hand (workflow_dispatch) after it reaches trunk; real Ray path unverified.
- 04-36: Ingestion panel binds tab-link listeners in <head> before links exist, so clicking RAG administration doesn't init it; Document types / Embedding profiles bind only the first RAG admin link (mobile drawer link doesn't init). Needs failing UI test + fix.
- 04-36: manual live check of chunking/refusal panels with an admin session (operator).
- 03.1-51 deferred #10: classify_input should let a text MIME type win over an image extension (ledger doc_class + cost projection).
- 04-42: eval/tests/test_parse_fixtures.py::test_generation_is_deterministic rewrites committed parse PDFs/manifest in place; it should write to tmp_path.
- 04-42: rag-sidecar `chunking` extra lacks pypdfium2 (21 tests fail with only --extra chunking); CI syncs preflight too.
- Local env: eval venv lacks PyYAML/deepeval/ragas after uv sync --frozen in some worktrees (CI fine).
