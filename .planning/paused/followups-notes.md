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
