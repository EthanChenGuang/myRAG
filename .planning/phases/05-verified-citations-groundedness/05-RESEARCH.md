# Phase 5: Verified Citations & Groundedness - Research

**Researched:** 2026-11-24
**Domain:** LLM answer generation: Claude Citations through the AI SDK v6, streamed citation-marker parsing, a post-stream groundedness scorer (Vectara HHEM-2.3 and local HHEM-2.1-Open), answer records with RLS, and feedback
**Confidence:** MEDIUM-HIGH. Provider behaviour was read from the `@ai-sdk/anthropic@3.0.143` source and the installed `ai@6.0.3`. Anthropic and Vectara behaviour comes from their live docs. Vectara limits and retention, real Anthropic streams and real HHEM runtime were not observed: there are no keys here, and no packages were installed.

<user_constraints>
## User Constraints (from CONTEXT.md)

The text below is copied verbatim from `05-CONTEXT.md`: `## Implementation Decisions` (D-01..D-26, Claude's Discretion and the decision index) and `## Deferred Ideas`. The planner MUST honor it.

### Locked Decisions, Claude's Discretion (verbatim)

### Citation strategy and record
- **D-01:** There is one `CitationStrategy` interface in `src/lib/rag/generation/citations/`, with two implementations:
  - `claude-citations`;
  - `chunk-alias`.

  `selectCitationStrategy({ modelId, turn, config })` is the only place that decides. Both strategies normalize to one Pydantic contract, `CitationRecord`, with Zod generated through `npm run gen:schemas`:
  - `n`: the display number, in order of first appearance in the answer;
  - `alias`: `S<k>`;
  - `chunkIds[]`: more than one when Phase 4 merged adjacent chunks into one block;
  - `documentId`, `documentName`, `documentVersion`;
  - `page` and `sectionPath` (both optional);
  - `quote`: the cited text. On the Claude path this is `cited_text`. On the alias path it is the whole block text exactly as sent to the model;
  - `quoteHash`;
  - `strategy`.

  The UI, persistence, eval traces and Langfuse all read only this shape.
  - **Reversibility:** costly. The persisted messages, the answer-record table, the eval `TraceCitation` contract and Phase 5.1's doc ids all depend on it.
- **D-02:** The citable unit is the final context block. Aliases are assigned after the last context step (Phase 4 rerank, edge ordering, merge, compression and the token budget). The order is never changed after that. Per request, an `AliasMap` maps each alias to its block, its chunk ids and its exact text. Under `RAG_PIPELINE=legacy` a block is a chunk.
  - Image-caption chunks get no alias and are never cited. They stay in the plain context text, and `source_images` keeps its current placement above the answer (AGENTS.md §6).
- **D-03:** Persistence and snapshots (GEN-03):
  - The full record lives in a new server-side table, `rag_answer_records` (D-15).
  - The assistant message metadata carries the same `citations[]` with `quote` capped at 1,000 characters. The full snapshot stays in the table.
  - The UI renders citations only from these snapshots. It never re-reads a chunk by id to display a citation. The document link uses `documentId` while the document still exists. Otherwise it shows "this document has since been updated or removed" together with the snapshot.
  - A test publishes a new version (Phase 3 `rag_publish_document_version`), soft-deletes (Phase 3.1 `rag_soft_delete_document`), hard-deletes, and re-chunks under a new chunking profile (Phase 4 D-21). After each one, an old message's citations must still render their quote, document name and number.

### Chunk-alias path (non-Claude models)
- **D-04:** Prompt and parsing:
  - With `RAG_CITATIONS=true`, each context block is prefixed with its alias label, e.g. `[S3] <document name, p.4 / section path>`.
  - A localized citation instruction (zh, en, it) is appended to the system prompt after the `{{context}}` substitution. `RAG_SYSTEM_PROMPT` and its `{{context}}` placeholder are unchanged.
  - The server runs an incremental marker parser over the text deltas. The parser:
    - holds back a partial `[S…` across chunks;
    - accepts `[S3]`, `[S3, S5]`, `[S3][S5]` and the full-width brackets `【S3】`;
    - validates every alias against that request's `AliasMap`;
    - drops unknown aliases and counts them in `invalid_citations`.

    Tests cover a marker split at every character boundary.
  - The validated list is sent once, in the `finish` message metadata.
  - "Structured output" for this path (GEN-04, success criterion 2) means the server emits the citation list as the Pydantic/Zod-validated `CitationRecord[]`. No `responseFormat` or JSON mode is used on the streamed answer, because that would break token streaming. Structured LLM output is used only on helper calls.
  - The streamed text keeps its raw markers, so the persisted text can re-render. The client renders markers that are in the validated list as numbered chips. After finish, any other `[S…]` token is hidden.

### Where citations apply
- **D-05:** Citations apply only to the web chat UI. The client sends `capabilities: { citations: true }` in the chat body.
  - WhatsApp calls `/api/chat` without that capability, so it gets today's prompt and today's text.
  - Voice (`/api/internal/voice-chat`) and the embed widget are unchanged.
  - Ghost/incognito chats (`ghost-` ids) get citations for display, but nothing is written to `rag_answer_records`, and neither groundedness nor feedback runs for them, so incognito stays unpersisted.
  - The eval endpoint gets citations when the run requests them.
- **D-06:** The existing source paths stay as they are:
  - the `useDocument` tracking tool;
  - `usedDocuments` and the `metadata` part;
  - the Claude Sonnet 4 `documentSources`;
  - `webSearch` results;
  - the sources panel.

  Citations are additive. The sources panel marks the documents that were cited, and web results are not cited in this phase. With `RAG_CITATIONS=false` and `RAG_CLAUDE_CITATIONS=false`, the Phase 1 characterization tests and the chat route's output stay byte-identical.
- **D-07:** The alias is also the block id that Phase 5.1 uses (`<doc id="S3">`). Phase 5.1 changes only the wrapper, never the alias scheme.

### Claude Citations path
- **D-08:** Model mapping (GEN-01):
  - The `Model` schema (AGENTS.md §7) gains an optional `anthropicId` field, for example `anthropic/claude-sonnet-4.5` maps to `claude-sonnet-4-5`. It is set in the five model locations, including the three fallback arrays in `scripts/config-ui/index.html`, and the five-location model check in `check-config` verifies that the field agrees everywhere.
  - A model without `anthropicId` never takes the direct path.
  - The researcher verifies every id against Anthropic's model list. The live check uses `GET /v1/models`.
  - **Reversibility:** costly. The schema field is spread across five config locations and the Config UI.
- **D-09:** Provider: `@ai-sdk/anthropic` on the v6-compatible 3.x line, installed with the `ai-v6` dist-tag at an exact pin (research: 3.0.143). It is never installed bare, because that resolves to the v7 line. `@anthropic-ai/sdk` is not added unless the spike proves the AI SDK path cannot carry citations.
  - Each context block becomes a user-message file part with `mediaType: 'text/plain'`, `filename` = its alias, a title of document name plus page or section, and `providerOptions.anthropic.citations.enabled = true` on every block.
  - `{{context}}` is replaced by a fixed localized sentence saying that the reference documents are attached. Image captions and the links section stay in that system text, without citations.
  - The call carries no `output_config` or structured output.
  - Citations come back as `source` parts with `citedText` and character indices. They map back through the alias in `filename`, and through `document_index`, which is positional, so blocks are never reordered after they are built.
  - **Reversibility:** costly. This is a new runtime dependency on the request path.
- **D-10:** Turn eligibility is decided in one function. The direct path runs only when every one of these holds:
  - `RAG_CLAUDE_CITATIONS=true`;
  - `ANTHROPIC_API_KEY` is set;
  - the model has an `anthropicId`;
  - the turn has knowledge-base context;
  - no MCP tool is planned or awaiting approval;
  - the turn is not a multi-step continuation.

  webSearch turns take the direct path, with the Exa `webSearch` tool attached as an AI SDK tool, but only after the spike or the recorded-stream test shows that citations and tool calls coexist. Until then, webSearch turns are ineligible. Every ineligible turn uses the existing OpenRouter path with the `chunk-alias` strategy.
  - If the direct call fails before the first token (401, 400, 429, 5xx or a timeout), the turn retries once on the OpenRouter path with `chunk-alias`. The trace records `citation_strategy_fallback` with the reason.
  - A failure after streaming has started is reported in-band with `formatErrorSSE`, as today.
  - Reasoning settings for Claude are mapped to the Anthropic provider's `thinking` budget. The research phase checks that Citations and thinking are compatible. If they are not, reasoning turns are ineligible.

### Groundedness scoring
- **D-11:** The sidecar exposes `POST /v1/groundedness`, authenticated with the existing shared secret and failing closed. It is defined by Pydantic contracts, with Zod generated from them:
  - `GroundednessRequest`: `request_id`, `language`, `premise_texts[]`, `hypothesis`, `allow_vectara`.
  - `GroundednessResult`: `status: scored | not_checked`, `scorer: hhem_2_3_vectara | hhem_2_1_open | none`, `score` (0..1, optional), `reason`, `truncated`, `latency_ms`.

  The sidecar returns only the raw score. The app maps it to a label (D-13).
  - Routing inside the sidecar:
    - (a) language `en` or `zh-Hans`, with `allow_vectara`, and `VECTARA_API_KEY` set in the sidecar's environment: Vectara `hhem_v2.3`;
    - (b) language `en` otherwise: local HHEM-2.1-Open;
    - (c) everything else (`it`, Traditional Chinese, mixed or unknown): `not_checked`, reason `unsupported_language`.
  - If Vectara errors or times out, the request is not retried against Vectara. For `en` it falls back to local HHEM-2.1-Open. For `zh` the result is `not_checked`, reason `scorer_unavailable`.
  - The researcher verifies the Vectara host, the `x-api-key` header and the request shape against the live docs.
  - **Reversibility:** costly. This is a sidecar wire contract with the app.
- **D-12:** HHEM-2.1-Open (`vectara/hallucination_evaluation_model`, Apache-2.0) is packaged as follows:
  - It lives in an optional `hhem` extra, with CPU-only `torch` and `transformers`, built as a separate Docker build target (`--target hhem`). The default sidecar image stays as small as Phases 3 and 3.1 left it.
  - The model is loaded with `trust_remote_code=True`, pinned to an exact Hugging Face commit revision. The weights are downloaded at image build time, never at request time.
  - `/ready` reports which scorers are available.
  - In tests, the local model sits behind an injectable scorer interface with a stub, so CI never downloads weights.
  - **Reversibility:** costly. This adds image size and deployment shape, and the remote code is pinned.
- **D-13:** Labels:
  - `score >= threshold` gives `verified`;
  - `score < threshold` gives `possibly_unreliable`;
  - no score gives `not_checked`.

  Thresholds live in a committed `eval/config/groundedness-thresholds.json` (Pydantic `GroundednessThresholds`), keyed by `(scorer, language)`. The default for every cell is the vendor's 0.5, recorded with `source: default`.
  - `python -m rag_eval.calibrate groundedness` fits each cell on labelled faithful and unfaithful pairs from the dev split and checks it on the test split, using the same fit and holdout pattern as Phase 4 D-18. A calibrated cell overrides the default.
  - The label, the threshold and the threshold source are stored with the score.
  - The user never sees a number.
- **D-14:** When scoring runs and with what input:
  - Scoring runs only when all of these hold:
    - `RAG_GROUNDEDNESS=true`;
    - the request came from the web chat with the citations capability (D-05);
    - `ragMode` is `strict` or `balanced`;
    - retrieval returned knowledge-base context (status `ok` or `degraded` with blocks);
    - the answer is not the strict refusal or the knowledge-base-unavailable message;
    - the chat is not a ghost chat.
  - It is skipped as `not_checked` with reason `tool_output` when an MCP tool result was used.
  - The premise is the evidence actually sent to the model: the alias blocks in order, plus the webSearch result texts when that tool ran.
  - The hypothesis is the final answer text with citation markers stripped.
  - When the premise is longer than `RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS`, the cited blocks are kept first and `truncated` is set. If the cited blocks alone exceed the cap, the result is `not_checked` with reason `too_long`.
  - The answer language comes from the same zh/en/it detector the pipeline already uses for queries (Phase 4 `analyze` / XLG language detection), applied to the answer text. Traditional Chinese, as detected by script, is `not_checked`.
  - Flexible and bypass modes are not scored, and no badge is shown in them.
- **D-15:** Execution and storage (success criterion 3). The answer is never delayed:
  - The route mints an `answerId` (UUID) at the start of the request and sends it in the `start` message metadata next to `ragTraceId`.
  - In the stream's `onFinish`, it inserts a `rag_answer_records` row with `groundedness.status = 'pending'` and schedules the sidecar call through the existing `after()` scheduler (`src/lib/rag/trace/schedule.ts`).
  - The sidecar call has a timeout of `RAG_GROUNDEDNESS_TIMEOUT_MS` (default 20000, which keeps it inside Vercel's 60 s limit). On timeout or error, the row becomes `not_checked` with that reason.
  - A row still `pending` after 120 s is reported as `not_checked`, reason `expired`, by the read endpoint. That covers function kills.
  - Each result is logged as one `[Groundedness]` line, with no answer or chunk text, and recorded as a `groundedness` span (the stage name from OBS-01) plus a numeric Langfuse score and a categorical `groundedness_label` score on the request's trace.

  The client keeps nothing open:
  - after `finish`, it polls `GET /api/rag/answers/{answerId}` with backoff (about 1, 2, 4 and 8 s, giving up after about 30 s);
  - on chat load, it fetches all the chat's records in one call;
  - it merges `groundedness` into the message metadata, which the existing client save persists.

  `src/types/chat.ts` `toDBMessages` and `fromUIMessage` are extended, because today they keep only `ragTraceId`. They also carry `answerId`, `citations`, `groundedness` and `feedback`.
  - **Reversibility:** costly. The persisted message-metadata shape changes, and old messages without the fields must keep loading.

### Answer record table and API
- **D-16:** `rag_answer_records` is a new table, added through the Phase 3 D-05 migrations convention: an ordered, idempotent file in `supabase/migrations/`, mirrored into both setup files, covered by the schema-equality test, and loaded by the PGlite harness. Its columns:
  - `id` (the `answerId`), `tenant_key`, `user_id`, `organization_id`;
  - `chat_id`, a foreign key to `chats` with `ON DELETE CASCADE`;
  - `trace_id`, `model_id`, `citation_strategy`, `rag_mode`, `answer_language`;
  - `citations` jsonb, `groundedness` jsonb, `feedback` jsonb, `review_reasons` text[];
  - the timestamps.

  Access rules:
  - RLS allows `SELECT` only where `user_id = auth.uid()`;
  - every write goes through server routes with the admin client, after verifying the session user owns the chat;
  - `anon` has no grants.

  Tests cover: two users in the same organization cannot read each other's records; an anonymous caller is refused; the tenant key matches the chat's scope (`TenantScope.tenantKey`).
  - The message JSONB is still written by the client, as today. The server never patches `chats.messages`, which avoids racing with client saves.
  - Shared chats render from the persisted message metadata only. They never read the table.
  - **Reversibility:** one-way. This is a new table, RLS policies and grants on real Supabase projects.
- **D-17:** Routes (Zod `zod/v3`, structured JSON errors, SSR session, fail closed):
  - `GET /api/rag/answers/{answerId}` and `GET /api/rag/answers?chatId=`, which read records;
  - `POST /api/rag/answers/{answerId}/feedback`, which sets the vote.

  A record the caller does not own returns 404, never 403, so existence is not revealed.

### Feedback (EVAL-16)
- **D-18:** Behind `RAG_ANSWER_FEEDBACK=true`, every assistant message that has an `answerId` gets a thumbs-up / thumbs-down control.
  - "Not helpful" opens an optional reason: preset chips (wrong, incomplete, not from my documents, bad citation) plus free text of up to 500 characters.
  - There is one vote per answer, and it can be changed. The latest vote wins.
  - The vote is stored in `rag_answer_records.feedback` and in the message metadata.
  - It is sent to Langfuse as the score `user_feedback` (1 or 0) on the `ragTraceId`. The reason is PII-masked with the Phase 2 D-26 masker and sent as the score comment.
  - Langfuse posting is time-boxed. When Langfuse is off or fails, the `[RAG Feedback]` log line is the fallback. The vote itself is never lost, because the database write comes first.
- **D-19:** The review queue keeps Phase 2 D-26's Langfuse mechanism and gains two entry reasons:
  - `feedback_negative`;
  - `groundedness_flagged` (the label is `possibly_unreliable`).

  When either reason fires:
  - it is appended to `review_reasons` on the record;
  - when Langfuse is on, the server attaches a PII-masked copy of the query, the answer and the cited snapshots to the trace, tagged `review_candidate` and `review:<reason>`. This happens whatever `LANGFUSE_REVIEW_SAMPLE_RATE` is, and it still respects the content-masking rules.

  `python -m rag_eval.review_queue pull` reads the Langfuse tags as before. It also gains `--source db`, which reads flagged records through an authenticated admin route, so the queue does not depend on Langfuse sampling. Items from both sources are deduplicated by trace id. `ReviewQueueItem` gains `reasons[]`.
  - The query and the answer for a negative vote are read server-side from the caller's own chat row. They are never taken from the request body.

### UI
- **D-20:** The groundedness badge (GEN-06):
  - It is a small pill in the message action row, localized in zh, en and it in `src/translations`. Other locales fall back to en.
  - It has three states: verified (check icon), possibly unreliable (amber warning icon) and not checked (grey).
  - A tooltip explains each state in one sentence. Nothing shows a number.
  - No badge is shown while the check is pending.
  - The badge shows only on RAG answers whose recorded `rag_mode` is strict or balanced. It does not show on refusals or ghost chats.
  - Citation chips are superscript numbers. Clicking one opens the existing sources panel at that citation's entry, which shows the document name, page or section, and the snapshot quote.
  - Components subscribe to stores with `useShallow` selectors.

### Switches, config and contracts
- **D-21:** New env vars. Each is mirrored in the five config locations, marked `managed` in `scripts/rag/env-manifest.json`, and `check-config` must pass. Secrets get placeholder values only.
  - `RAG_CITATIONS=false`
  - `RAG_CLAUDE_CITATIONS=false`
  - `ANTHROPIC_API_KEY=`
  - `ANTHROPIC_BASE_URL=` (for fakes and recorded streams)
  - `RAG_GROUNDEDNESS=false`
  - `RAG_GROUNDEDNESS_VECTARA_OPT_IN=false`
  - `RAG_GROUNDEDNESS_TIMEOUT_MS=20000`
  - `RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS` (default chosen by research from the HHEM and Vectara limits)
  - `RAG_ANSWER_FEEDBACK=false`
  - `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=false`

  The sidecar gets `VECTARA_API_KEY`, `VECTARA_BASE_URL` and `HHEM_MODEL_REVISION` in its own settings and `.env` example.

  In multi-tenant mode, `allow_vectara` is sent as true only if `RAG_GROUNDEDNESS_VECTARA_OPT_IN=true` and the data-retention confirmation from live verification has been recorded as `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=true`. Otherwise it fails closed to local or `not_checked`.

  With every Phase 5 switch off, the chat route matches today's behaviour exactly, and the characterization tests prove it.
- **D-22:** New Pydantic contracts, with Zod generated and checked in CI:
  - `CitationRecord`;
  - `GroundednessRequest` and `GroundednessResult`;
  - `GroundednessThresholds`;
  - `AnswerFeedback`;
  - `AnswerRecord`, the API response.

  `TraceCitation` in `eval_run.py` is replaced by, or aliased to, `CitationRecord`. `ReviewQueueItem` gains `reasons[]`.
- **D-23:** Latency. The direct Claude path must keep time-to-first-token within the existing chat budget. The eval reports TTFT by strategy, report-only. Groundedness adds per-scorer p50 and p95 entries to `eval/config/latency-budgets.json` (starting values: local 5000 ms, Vectara 8000 ms p95). These are report-only and outside the pre-first-token total, because the check is post-stream.

### Evaluation and completion
- **D-24:** Fixture evaluation, with no live keys:
  - a deterministic fake generator for the alias path that cites chosen blocks, including invalid aliases and markers split across tokens;
  - recorded or fake Anthropic SSE streams under `tests/fixtures/anthropic/`, with citations, a webSearch tool call and an error before the first token. They are written from the documented shapes and carry no secrets;
  - a fake Vectara HTTP endpoint and a stub local HHEM scorer in the sidecar tests;
  - synthetic labelled faithful and unfaithful pairs in en and zh, with it items that must come out `not_checked`.

  The eval reports gain deterministic citation metrics:
  - `invalid_citation_rate`, which must be 0 after validation;
  - `citation_coverage`, the share of answers with at least one valid citation;
  - `cited_gold_hit`, true when a cited block contains a gold span by the Phase 1 D-13 match.

  Groundedness label counts are reported by scorer and language. The nightly judge tier adds Faithfulness for each strategy.
- **D-25:** Phase completion is proven on the fixture corpus by five results:
  - (a) With all Phase 5 switches off, the characterization tests pass and every retrieval paired difference against the current baseline is zero.
  - (b) With the switches on, the retrieval metrics are unchanged, because citations do not touch retrieval. No slice drops beyond the noise band. `invalid_citation_rate = 0`.
  - (c) Success criteria 1 to 4 and 6 are covered by tests against the fakes.
  - (d) The tenant and RLS tests on `rag_answer_records` pass.
  - (e) The strict refusal still streams in the user's language with citations and groundedness on.

  The real Faithfulness comparison and the Vectara, Anthropic and HHEM checks are the ROADMAP live verification items.
- **D-26:** Rollout order inside the phase:
  1. contracts and gen:schemas;
  2. the alias map, block labelling and the marker parser;
  3. the `rag_answer_records` migration, RLS and routes;
  4. message-metadata persistence in `src/types/chat.ts`;
  5. citation chips and the sources-panel integration;
  6. the model `anthropicId` field across the five locations;
  7. `@ai-sdk/anthropic` and the Claude strategy with recorded streams, eligibility and fallback;
  8. the sidecar groundedness endpoint, the Vectara client and the HHEM image target;
  9. the post-stream scheduling, the read endpoint and the badge;
  10. the feedback control, the Langfuse scores and the review-queue reasons;
  11. groundedness calibration tooling;
  12. the eval metrics and the final comparison.

### Claude's Discretion
- File layout inside `src/lib/rag/generation/` beyond the paths named above.
- Exact wording of the citation instruction, the attached-documents sentence, the tooltips and the feedback reason chips (zh, en, it).
- Polling backoff constants within the bounds in D-15.
- Badge visual details (icons from `lucide-react`, colours from existing Tailwind tokens).
- Field names inside the `groundedness` and `feedback` jsonb, beyond those named.

### Decision index
These are the IDs the plans cite. Each entry summarizes a decision recorded above.
- **D-01:** one CitationStrategy interface (claude-citations | chunk-alias), selected in one function; one Pydantic CitationRecord {n, alias, chunkIds[], documentId, documentName, documentVersion, page?, sectionPath?, quote, quoteHash, strategy} (costly)
- **D-02:** citable unit is the final context block; aliases S1..Sn assigned after the last context step, no reordering after; per-request AliasMap; image chunks never aliased or cited
- **D-03:** full snapshot in rag_answer_records, message metadata quote capped at 1,000 chars; UI renders from snapshots only; test across version publish, soft delete, hard delete and re-chunk
- **D-04:** RAG_CITATIONS alias labels plus a localized instruction appended after {{context}}; incremental split-safe marker parser ([S3], [S3, S5], 【S3】), unknown aliases dropped and counted; validated list in finish metadata; "structured output" = the validated schema record, no JSON mode on the streamed answer; unvalidated markers hidden after finish
- **D-05:** citations only for the web chat (capabilities.citations); WhatsApp, voice and embed unchanged; ghost chats display citations but persist no record, groundedness or feedback
- **D-06:** existing useDocument, usedDocuments, documentSources, webSearch sources and sources panel unchanged; citations additive; all switches off = byte-identical
- **D-07:** alias = Phase 5.1 doc id
- **D-08:** Model schema gains optional anthropicId in the five locations, checked by check-config; no id = no direct path (costly)
- **D-09:** @ai-sdk/anthropic 3.x via the ai-v6 dist-tag, exact pin; one text/plain citation-enabled file part per block, filename = alias; {{context}} replaced by an attached-documents sentence; no structured output; source parts mapped back by alias (costly)
- **D-10:** one eligibility function (switch, key, anthropicId, KB context, no MCP, no multi-step; webSearch only after the spike or a recorded test); pre-first-token failure retries once on OpenRouter + chunk-alias with a trace reason; thinking mapped if compatible
- **D-11:** sidecar POST /v1/groundedness (Pydantic request/result, raw score only); routing: Vectara hhem_v2.3 for en/zh-Hans with allow_vectara and key, local HHEM-2.1-Open for en, otherwise not_checked; Vectara failure falls to local for en, not_checked for zh (costly)
- **D-12:** HHEM-2.1-Open in an optional hhem extra and Docker target, CPU torch, trust_remote_code pinned to a commit, weights at build time; /ready lists scorers; stub scorer in tests (costly)
- **D-13:** labels from eval/config/groundedness-thresholds.json per (scorer, language), default 0.5 with source default; calibrate groundedness fit on dev, holdout on test; no number shown
- **D-14:** score only for web chat, strict or balanced, with KB context, not refusals or ghost chats; MCP tool output gives not_checked; premise = blocks sent + webSearch texts; hypothesis = answer without markers; premise cap keeps cited blocks first; answer language from the existing detector; Traditional Chinese not_checked
- **D-15:** answerId minted per request and sent in start metadata; record inserted pending in onFinish; sidecar called in after() with a 20 s timeout; pending past 120 s reads as expired; [Groundedness] log, groundedness span and Langfuse scores; client polls GET with backoff and merges into message metadata; toDBMessages and fromUIMessage carry answerId, citations, groundedness, feedback (costly)
- **D-16:** rag_answer_records table via a migration mirrored in both setup files, chat_id cascade; RLS select own rows; server-only writes; no anon grants; tenant and RLS tests; server never patches chats.messages; shared chats read metadata only (one-way)
- **D-17:** GET /api/rag/answers/{id}, GET ?chatId=, POST /{id}/feedback; Zod, SSR session, 404 for not-owned
- **D-18:** RAG_ANSWER_FEEDBACK thumbs control with an optional reason (chips plus 500 chars); one changeable vote; database first, then the Langfuse score user_feedback with a masked comment; [RAG Feedback] log fallback
- **D-19:** review reasons feedback_negative and groundedness_flagged; review_reasons column; masked content attached with tags review_candidate and review:<reason> regardless of the sample rate; review_queue pull --source db with dedupe; ReviewQueueItem.reasons[]
- **D-20:** three-state localized badge pill, tooltip, no number, hidden while pending and outside strict/balanced; superscript citation chips open the sources panel entry with the snapshot
- **D-21:** env RAG_CITATIONS, RAG_CLAUDE_CITATIONS, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, RAG_GROUNDEDNESS, RAG_GROUNDEDNESS_VECTARA_OPT_IN, RAG_GROUNDEDNESS_TIMEOUT_MS, RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS, RAG_ANSWER_FEEDBACK, RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK in five places; sidecar VECTARA_API_KEY, VECTARA_BASE_URL, HHEM_MODEL_REVISION; multi-tenant Vectara fails closed without the acknowledgment
- **D-22:** Pydantic CitationRecord, GroundednessRequest/Result, GroundednessThresholds, AnswerFeedback, AnswerRecord; TraceCitation replaced; ReviewQueueItem.reasons[]
- **D-23:** TTFT by strategy report-only; groundedness per-scorer budgets (local 5000, Vectara 8000 ms p95) report-only and outside the pre-first-token total
- **D-24:** fixtures: fake alias generator, recorded Anthropic streams, fake Vectara, stub HHEM, labelled en/zh pairs plus it not_checked; metrics invalid_citation_rate, citation_coverage, cited_gold_hit; nightly Faithfulness per strategy
- **D-25:** completion: switches off = characterization tests and zero paired diffs; switches on = retrieval unchanged and invalid rate 0; fake-backed tests for success criteria 1 to 4 and 6; RLS tests; strict refusal intact
- **D-26:** rollout order: contracts, alias and parser, table and routes, metadata persistence, chips, anthropicId, Claude strategy, sidecar scorer, post-stream and badge, feedback and review, calibration, eval

### Deferred Ideas (OUT OF SCOPE, verbatim)

- Citations in the embed widget (rendering plus persistence): the widget has no message store today. Backlog.
- Citations for webSearch (Exa) results on the Claude path, as `search_result` or documents (research GEN-13), only after GEN-01 is stable.
- An LLM-judge faithfulness fallback for Italian, Traditional Chinese and other "not checked" languages. Backlog; it would need its own egress and cost decision.
- Per-tenant Vectara opt-in, instead of the deployment-level switch.
- Treating strict-mode answers with zero valid citations as unsupported (warning or refusal). This phase only records `citation_coverage`.
- Sentence-level highlighting (UX-01) and click-through to the source page (UX-02).
- Using groundedness to block or regenerate answers (out of scope for v1).
- Garbage collection of superseded chunk rows, now safe for citations because of the snapshots (Phase 3 deferred list).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md) | Research Support |
|----|-------------------------------|------------------|
| GEN-01 | Claude → direct Anthropic API with Citations, one plain-text document per chunk; OpenRouter-to-Anthropic map in the five model locations; tools/MCP/webSearch keep working or fall back | Pattern 3 (file part → `document` block), Pattern 4 (marker injection from `source` parts), Pattern 5 (pre-first-token fallback), P-1 (string data is read as a URL), P-3 (`ANTHROPIC_BASE_URL=` empty), P-6 (model retirements), the eligibility notes on thinking and sampling |
| GEN-02 | Other models: chunk-ID citations parsed from the stream, unknown IDs dropped, validated against the context sent | Pattern 2 (split-safe parser in an `experimental_transform`), P-7 (stale aliases in history), P-8 (marker-like text inside chunks) |
| GEN-03 | Same persisted `citations[]` with a snapshot, survives re-chunk/replace | Pattern 1 (AliasMap from structured blocks), P-5 (`toExtendedMessage` also strips metadata), Pattern 6 (record table) |
| GEN-04 | Structured output for the non-Claude citation list and helpers, never with Claude Citations | Anthropic returns 400 for citations + `output_config.format`, cited below; the record is validated by Pydantic/Zod, with no JSON mode on the stream |
| GEN-05 | Post-stream sidecar scoring: Vectara HHEM-2.3 (key + opt-in, zh/en), HHEM-2.1-Open local (en), else not checked | Vectara API section, HHEM packaging section, P-9 (the foundation tokenizer is a second HF repo), P-10 (memory grows with premise length) |
| GEN-06 | Score and status in metadata and logs; three-state badge in strict/balanced; never blocking | Pattern 7 (after() then poll), P-4 (insert inside after(); 404 while pending) |
| GEN-07 | Existing behaviour unchanged | P-2 (route fakes replace `streamText`, so transforms need their own tests), the Claude path must not inherit the `isClaudeSonnet4` hacks, byte-identity tests |
| EVAL-16 | Helpful/not-helpful vote stored, sent to Langfuse, negatives and flagged results reach the review queue | Pattern 8 (deterministic score id, so the latest vote wins), P-11 (there is no TS scores client yet), P-12 (adding tags to a trace that was already exported) |
</phase_requirements>

## Project Constraints (from CLAUDE.md / AGENTS.md)

- Keep `RAG_SYSTEM_PROMPT` and its `{{context}}` placeholder intact. Keep strict-mode "information not available", webSearch + Exa, `source_images`, voice and embed paths unchanged (AGENTS.md §6, §14).
- Every new `.env.local` variable must be mirrored in `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js` and the Config UI. Model changes go to five locations, including the three fallback arrays in `scripts/config-ui/index.html` (AGENTS.md §7).
- Validate API inputs with Zod from `zod/v3` through `withValidation`/`validateRequest`. Return structured JSON errors. Report streaming errors with `formatErrorSSE`.
- Prefix logs with a bracketed tag. Never log key values. Add no unconditional debug logs in hot paths.
- Use Zustand selectors with `useShallow`. Functional components only. Under the React Compiler, avoid manual `useMemo`/`useCallback`.
- Pydantic v2 (`pydantic>=2.14.4`) is the source for every structured contract. Zod is generated through `npm run gen:schemas`, and CI checks parity.
- The Python sidecar is reached over HTTP with the shared secret.
- Multi-tenant: RLS and tenant isolation must not get weaker. A cross-tenant leak is the worst failure.
- Every component has a switch. Off means today's behaviour. Each phase is proven against the baseline.
- No secrets in commits, tests or docs.
- GSD workflow enforcement: edits only through GSD commands.
- Quality gate: `npx next typegen && npx tsc --noEmit -p tsconfig.json` must report zero errors, and lint must pass.

## Summary

The Claude path works with the planned provider, but there are four traps. All four were confirmed by reading the code.
1. **Chunk text passed as a string `data` is treated as a URL.** In `ai@6.0.3`, `convertToLanguageModelV3DataContent` calls `new URL(content)` on any string. Typical chunk text such as `"Document: report.pdf. Chunk 1 of 3. ..."` parses as a URL with the `document:` scheme. Pass `new TextEncoder().encode(text)` as the data.
2. **An empty `ANTHROPIC_BASE_URL=` breaks every call.** The `ANTHROPIC_BASE_URL=` line that D-21 adds to `.env.local` makes the provider use base URL `''`, because `loadOptionalSetting` returns the empty string and `?? default` does not catch it. Always pass an explicit `baseURL`.
3. **Retired and retiring models.** The two Claude models in today's model lists are `anthropic/claude-sonnet-4.5`, whose Anthropic model retires on 2026-11-30, and `anthropic/claude-opus-4.1`, whose Anthropic model was retired on 2026-08-05. The D-08 example mapping (`claude-sonnet-4-5`) would therefore stop working six days from now.
4. **No position information on citations.** A streamed citation arrives as an AI SDK `source` part (`sourceType: 'document'`, `filename` = our alias, `providerMetadata.anthropic.citedText`). It carries no text-position id. It belongs to the text block that is currently open, and Anthropic sends `citations_delta` after that block's `text_delta`s. The way to get the same `[S3]` markers into the text as on the alias path is an `experimental_transform` that emits the pending aliases as a `text-delta` just before that block's `text-end`. The transform runs before `onChunk`, `onFinish` and `toUIMessageStream` in `ai@6.0.3`.

The alias path is a pass-through `experimental_transform` with an incremental parser. The route-level test fakes replace `streamText` completely (`tests/helpers/chat-route-fakes.ts`), so the parser and transforms need their own tests against the real `streamText` with `MockLanguageModelV3` from `ai/test`. The Claude path should be tested with the real `@ai-sdk/anthropic` and a fake `fetch` that replays recorded SSE. The provider accepts `fetch` and `baseURL` settings.

Groundedness is a sidecar HTTP call made inside `after()`. Vectara's endpoint is `POST https://api.vectara.io/v2/evaluate_factual_consistency` with an `x-api-key` header, body `{generated_text, source_texts[], model_parameters?.model_name}` and response `{score}`. No size limits, rate limits or retention terms are published. That keeps the D-21 multi-tenant acknowledgment gate necessary.

The local HHEM-2.1-Open model has two pins:
- the repo is pinned at commit `de9a5e6ba9ba49531a022dba17e35ffeb2a6fad8` (2026-10-06, "Support transformers 5");
- its remote code calls `AutoConfig/AutoTokenizer.from_pretrained("google/flan-t5-base")` with no revision, so a second repo (`7bcac572ce56db69c1ea7c8af255c5d7c9672fc2`) must be baked into the image and resolvable offline.

**Primary recommendation:** Build the blocks as structured data, in one module that produces the AliasMap, the labelled context string and the Claude file parts. Use one marker grammar (`[S<k>]`) on both paths: injected by a transform on the Claude path, parsed by a transform on the alias path. Persist through `after()`. Install exactly `@ai-sdk/anthropic@3.0.143`, behind a human-verify checkpoint.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Alias assignment, AliasMap, block labelling | API / Backend (`src/lib/rag/generation/citations/`) | — | Must see the final context blocks after Phase 4 assembly; per request |
| Strategy selection and eligibility | API / Backend | — | Depends on env, key, model `anthropicId`, MCP and multi-step state, all server-side |
| Marker parsing and validation | API / Backend (stream transform) | Browser (hide unvalidated markers after finish) | Validation must be server-side (CONTEXT "specifics"); the client only renders the validated list |
| Claude direct call | API / Backend (`@ai-sdk/anthropic`) | External (Anthropic API) | The key never reaches the browser |
| Groundedness scoring | Python sidecar | External (Vectara) | Locked: HHEM runs in the sidecar over HTTP |
| Scheduling and storage of scores | API / Backend (`after()`) | Database (`rag_answer_records`) | Off the answer path |
| Answer records, RLS | Database / Storage | API (admin-client writes after ownership check) | RLS select-own; writes are server-only |
| Badge, chips, feedback control | Browser / Client | API (read/feedback routes) | Renders from message metadata snapshots only |
| Message metadata persistence | Browser / Client (`chats.messages` save) | — | Client owns the JSONB; the server never patches it |
| Langfuse scores and review tags | API / Backend | External (Langfuse) | Time-boxed, masked, with a log fallback |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@ai-sdk/anthropic` | **3.0.143** (dist-tag `ai-v6`), exact pin | Direct Claude call with Citations | The v6-compatible line. It implements `providerOptions.anthropic.citations` on file parts and turns `char_location` citations into `source` parts [VERIFIED: npm registry `dist-tags.ai-v6 = 3.0.143`; read `src/convert-to-anthropic-messages-prompt.ts` and `src/anthropic-messages-language-model.ts` in the 3.0.143 tarball] |
| `ai` | 6.0.3 (installed, unchanged) | `streamText`, `experimental_transform`, `toUIMessageStream` | Already the app's runtime. `experimental_transform` and `sendSources` (default `false`) exist in 6.0.3 [VERIFIED: `node_modules/ai/dist/index.d.ts` lines 2188, 2515, 2692] |
| `zod` | 3.25.76 (installed) | Route validation, generated contracts | Matches the peer of `@ai-sdk/anthropic` (`^3.25.76 \|\| ^4.1.8`) [VERIFIED: npm view] |
| `httpx` | 0.28.1 (already in sidecar) | Sidecar → Vectara | Already a sidecar dependency [VERIFIED: `rag-sidecar/pyproject.toml:9` `"httpx==0.28.1",`] |

### Supporting (sidecar optional extra `hhem`, Docker target `hhem`)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `torch` (CPU wheel) | 2.15.0 (`+cpu`, from `https://download.pytorch.org/whl/cpu`) | HHEM-2.1-Open inference | Only in the `hhem` extra. A cp312 manylinux x86_64/aarch64 CPU wheel exists [VERIFIED: pytorch CPU index listing `torch-2.15.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl`; PyPI upload 2026-10-28]. **Align with the torch pin that Phase 3's `docling` extra resolves in `uv.lock`**: uv keeps one version per package across extras |
| `transformers` | 5.23.0 | Loads the HHEM remote code | 2026-11-13, 11 days old. The latest, 5.24.0, is 3 days old, below the 7-day floor. Requires `huggingface-hub>=1.31,<3`, `tokenizers>=0.23.1,<0.24`, `safetensors>=0.8.0` [VERIFIED: PyPI JSON]. The HHEM card states "Both transformers 4.x and 5.x are supported" [CITED: HF model card @de9a5e6] |
| HF model `vectara/hallucination_evaluation_model` | revision `de9a5e6ba9ba49531a022dba17e35ffeb2a6fad8` | HHEM-2.1-Open weights and remote code | HEAD as of 2026-10-06, commit title "Support transformers 5 and refresh model card". `model.safetensors` is 438,535,352 bytes, sha256 `634de18a38cf1e991c1acd0f7a9e0d30f7ea187fba42bb4798f862d3edd31e72`. Apache-2.0, not gated [VERIFIED: HF API `/api/models/...` and `/tree/de9a5e6…`] |
| HF model `google/flan-t5-base` | revision `7bcac572ce56db69c1ea7c8af255c5d7c9672fc2` | Config and tokenizer loaded by the HHEM remote code | Only `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json` and `spiece.model` are needed. Unchanged since 2023-07-17 [VERIFIED: HF API] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@ai-sdk/anthropic` file parts | `@anthropic-ai/sdk` with `search_result` blocks | Bypasses the AI SDK stream and UI message protocol. D-09 keeps it as an escape hatch only |
| Marker injection transform on the Claude path | Rendering chips from `source` parts by character offset | Offsets refer to the *document*, not to the answer text. No answer-position data exists, so markers are the only anchor |
| Bump `ai` to 6.0.336 | Keep 6.0.3 | 6.0.336 would dedupe `@ai-sdk/provider-utils` (4.0.67), but it changes the whole chat runtime. Keep 6.0.3 and accept a nested copy under `@ai-sdk/anthropic`. The V3 stream-part unions are identical in provider 3.0.0 and 3.0.19 [VERIFIED: diff of the `LanguageModelV3StreamPart` / `LanguageModelV3Content` declarations] |

**Installation (do not run in research; planner gates it behind `checkpoint:human-verify`):**
```bash
npm install --save-exact @ai-sdk/anthropic@3.0.143     # never bare: latest = 4.0.107 (v7 line)
```
```toml
# rag-sidecar/pyproject.toml (sketch)
[project.optional-dependencies]
hhem = ["torch==2.15.0", "transformers==5.23.0"]
# reuse Phase 3's [[tool.uv.index]] pytorch-cpu (explicit = true) and [tool.uv.sources] torch entry
```

## Package Legitimacy Audit

| Package | Registry | Pinned version / published | Downloads | Source Repo | Seam verdict | Disposition |
|---------|----------|----------------------------|-----------|-------------|--------------|-------------|
| `@ai-sdk/anthropic` | npm | 3.0.143 / 2026-11-17T18:39Z (7 days) | 25.0M/wk | github.com/vercel/ai | SUS (`too-new`: the seam checks `latest` 4.0.107, published 2026-11-20) | **Flagged.** The pinned 3.0.143 meets the 7-day floor. `postinstall`: none. Deps `@ai-sdk/provider 3.0.19`, `@ai-sdk/provider-utils 4.0.67` (which adds `undici ^6.28.0`, loaded lazily in `safe-node-fetch`). Peer `zod ^3.25.76 \|\| ^4.1.8`. Integrity `sha512-36o4TR2m…UHwg==`. Planner adds `checkpoint:human-verify` |
| `torch` | PyPI + pytorch CPU index | 2.15.0 / 2026-10-28 (27 days) | n/a (PyPI gives no count) | pytorch.org / github.com/pytorch/pytorch | SUS (`too-new`, `unknown-downloads`) | **Flagged.** Established project; the flag comes from the seam's latest-release age heuristic. Checkpoint required |
| `transformers` | PyPI | 5.23.0 / 2026-11-13 (11 days) | n/a | github.com/huggingface/transformers | SUS (`too-new`: latest 5.24.0 is 3 days old) | **Flagged.** Pin 5.23.0, not latest. Checkpoint required |
| `vectara/hallucination_evaluation_model` (HF model, remote code) | Hugging Face | `de9a5e6b…` / 2026-10-06 | 100,167 downloads | huggingface.co/vectara | n/a (not a package) | **Flagged.** `trust_remote_code=True` runs `modeling_hhem_v2.py` and `configuration_hhem_v2.py`. Both were read at this revision: about 80 lines, no network or file I/O beyond `from_pretrained`. Pin the revision and check the sha256 of the safetensors |
| `google/flan-t5-base` (HF config + tokenizer) | Hugging Face | `7bcac572…` / 2023-07-17 | — | huggingface.co/google | n/a | Approved with pin; data files only |

**Packages removed due to [SLOP]:** none.
**Packages flagged [SUS]:** `@ai-sdk/anthropic`, `torch`, `transformers`. The planner inserts one `checkpoint:human-verify` before the npm install (D-26 step 7) and one before the `hhem` extra and lock regeneration (D-26 step 8). The user previously approved Phase 3.1 packages the same way (STATE.md).

## Architecture Patterns

### System Architecture Diagram

```
 web chat (capabilities.citations=true) ─┐        WhatsApp / voice / embed ──► unchanged path
                                         ▼
 /api/chat ──► runRetrieval (Phase 2/4, unchanged) ──► final ordered blocks
                                         │
                                         ▼
                   buildCitationBlocks(blocks) ──► AliasMap {S1..Sn → chunkIds, text, doc}
                                         │
                selectCitationStrategy(model, turn, config)
              ┌──────────────────────────┴───────────────────────────┐
              ▼ claude-citations (eligible)                          ▼ chunk-alias (all others)
  system: {{context}} → "documents attached"          system: {{context}} → labelled blocks
  last user msg: N text/plain file parts               + localized cite instruction appended
   (Uint8Array, filename=alias, citations on)          OpenRouter streamText
  @ai-sdk/anthropic streamText (maxRetries 0)               │
     │ first chunk error? ──yes──► retry once on OpenRouter + chunk-alias (trace reason)
     ▼ no                                                   │
  transform: source(doc) → pending alias;                  transform: incremental parser
   on text-end emit " [S3]" text-delta                     validates [S…] against AliasMap
              └──────────────────────────┬───────────────────────────┘
                                         ▼
          toUIMessageStream: start{ragTraceId, answerId} … finish{citations: CitationRecord[]}
                                         │
                         stream closes ──► after():
                                         ├─ insert rag_answer_records (pending)   [not ghost]
                                         ├─ POST sidecar /v1/groundedness (≤20 s)
                                         │      ├─ en/zh-Hans + allow_vectara + key ─► Vectara hhem_v2.3
                                         │      ├─ en ─► local HHEM-2.1-Open
                                         │      └─ else ─► not_checked
                                         ├─ label via thresholds → update row
                                         └─ [Groundedness] log, span, Langfuse scores (sampled/time-boxed)
 browser: poll GET /api/rag/answers/{id} (1,2,4,8 s; 404 = not yet) ─► merge into metadata ─► client save
 browser: thumbs ─► POST /api/rag/answers/{id}/feedback ─► DB first ─► Langfuse score user_feedback
```

### Recommended Project Structure

```
src/lib/rag/generation/
├── citations/
│   ├── blocks.ts          # ContextBlock[] → AliasMap, labelled context, Claude file parts (one source of truth)
│   ├── strategy.ts        # CitationStrategy interface, selectCitationStrategy, eligibility
│   ├── marker-parser.ts   # pure incremental parser (no AI SDK imports)
│   ├── transforms.ts      # aliasParserTransform, claudeMarkerTransform (StreamTextTransform)
│   ├── claude.ts          # createAnthropic({ baseURL, apiKey, fetch? }), message building, fallback
│   ├── record.ts          # CitationRecord build, quote cap 1000, quoteHash, strip markers
│   └── instructions.ts    # localized zh/en/it cite instruction and attached-documents sentence
├── groundedness.ts        # eligibility (D-14), premise build, sidecar client, label mapping
└── feedback.ts            # Langfuse score client wrapper, review reasons
src/app/api/rag/answers/[answerId]/route.ts, [answerId]/feedback/route.ts, route.ts (?chatId=)
rag-sidecar/src/rag_sidecar/groundedness/{router.py, vectara.py, local_hhem.py, scorer.py}
```

### Pattern 1: Structured blocks before any string

**What:** The assembler today returns only `context: string` (`RetrievalResult.context`). Phase 4 groups chunks into `DocumentGroup {documentId, rank, runs}` (04-12 plan) and renders one header per document. Phase 5 needs the run list as data.
**How:** Add an additive `blocks: ContextBlock[]` output: `{ documentId, documentName, documentVersion, chunkIds[], page?, sectionPath?, text, isImage }`. Every renderer then consumes the same list. When citations are off, the legacy renderer stays byte-identical. Referenced documents (`refs/` `section(name, body)`) also become blocks, with `chunkIds` = the chunks used, or empty when the full text was used. On the Claude path every citation document must have citations enabled ("A request can't mix documents that have citations enabled with documents that don't" [CITED: platform.claude.com/docs/en/build-with-claude/citations]), so referenced documents cannot stay as uncited system text there.
**Image blocks:** no alias, no file part. They stay in the system text (D-02).

### Pattern 2: Split-safe alias parser as a pass-through transform

**What:** A `StreamTextTransform` that forwards every part unchanged and feeds `text-delta.text` into a pure parser. The parser is keyed by text `id`, so markers never span two text blocks. It flushes on `text-end` and on `finish`.
**Why a transform and not `onChunk`:** In `ai@6.0.3`, `transforms` are piped before `eventProcessor`, which calls `onChunk` and `onFinish` [VERIFIED: `node_modules/ai/dist/index.mjs` ~L6025-6034 and ~L5770-5776]. So by the time `toUIMessageStream` sees `finish` and calls `messageMetadata({part:{type:'finish'}})`, the parser has seen every delta.
**Grammar:** `[S3]`, `[S3, S5]`, `[S3][S5]`, `【S3】`, and also `［S3］` (full-width square brackets, which zh models emit) and `[S3，S5]` (full-width comma). Hold back from an unmatched `[`/`【`/`［` until it closes or until 16 chars pass without a match.

### Pattern 3: Claude request shape (`@ai-sdk/anthropic@3.0.143`)

- One user-message `file` part per block: `{ type: 'file', mediaType: 'text/plain', filename: 'S3', data: new TextEncoder().encode(block.text), providerOptions: { anthropic: { citations: { enabled: true }, title: '<doc name · p.4>', context?: '<section path>' } } }`. The provider maps it to `{type:'document', source:{type:'text', media_type:'text/plain', data}, title: metadata.title ?? part.filename, citations:{enabled:true}}` [VERIFIED: 3.0.143 `convert-to-anthropic-messages-prompt.ts` ~L536-561]. `title` and `context` are passed to the model but are not citable, and `title` is length-limited [CITED: citations doc].
- Put the file parts before the question text in the **current** user message only.
- The provider rebuilds the document list positionally from user-message file parts with citations enabled (`extractCitationDocuments`) and resolves `citation.document_index` against it. The `source` part's `filename` is our alias [VERIFIED: ~L97-153, ~L1290-1335].
- `sendSources` stays `false` (default). Source parts are consumed by our transform and never reach the client.
- No `responseFormat`/`output`. Do not reuse the OpenRouter `streamParams`. In particular, do not inherit the `isClaudeSonnet4` branch (which deletes tools, sets `experimental_providerMetadata.openrouter` and raw `max_tokens`) [VERIFIED: `src/app/api/chat/route.ts:3423-3480`, read this session].
- `temperature: 0.1`: the provider drops sampling parameters for models that reject them and emits a warning (`rejectsSamplingParameters`) [VERIFIED: ~L453-461]. Still, do not send it on this path.
- `maxRetries: 0`, so a 429 or 5xx falls back quickly instead of being retried twice inside the SDK.
- Thinking: `budget_tokens` is rejected with a 400 on Claude 4.7 and later, and adaptive thinking is the only mode there [CITED: platform.claude.com/docs/en/build-with-claude/extended-thinking]. Map reasoning to `providerOptions.anthropic.thinking = {type:'adaptive'}` plus `effort` for adaptive-capable models. Make reasoning turns ineligible on budget-only models (the 4.5 family). Citations and thinking coexist: Citations lists `claude-opus-5-5` and `claude-fable-5-2` as supported, and thinking cannot be disabled on those models [CITED: citations doc `supportedModels`; claude-api skill thinking table]. No source states this as a single sentence, so the recorded-stream test should include a thinking block.

### Pattern 4: Claude marker injection transform

```ts
// Source: derived from ai@6.0.3 TextStreamPart union (index.d.ts ~L2430-2505)
// and Anthropic streaming order (citations_delta after text_delta inside a block).
export function claudeMarkerTransform(aliases: ReadonlySet<string>): StreamTextTransform<ToolSet> {
  return () => {
    let pending: string[] = [];
    return new TransformStream({
      transform(part, controller) {
        if (part.type === 'source' && part.sourceType === 'document' && part.filename && aliases.has(part.filename)) {
          if (!pending.includes(part.filename)) pending.push(part.filename);
          return; // record via a side channel (onCitation) — not forwarded
        }
        if (part.type === 'text-end' && pending.length > 0) {
          controller.enqueue({ type: 'text-delta', id: part.id, text: pending.map((a) => `[${a}]`).join('') });
          pending = [];
        }
        controller.enqueue(part);
      },
    });
  };
}
```
The side channel records `{alias, citedText, startCharIndex, endCharIndex}` in arrival order. `quote` = `citedText` (D-01).

### Pattern 5: Pre-first-token fallback

`streamText` does not throw at call time. Errors surface as stream `error` parts. Inside `createUIMessageStream.execute`, read the Anthropic `toUIMessageStream()` and buffer parts until the first `text-delta` or `error`:
- `error` first, or a first-token timer fires (its own `AbortController`, cleared on the first chunk): discard the buffer, record `citation_strategy_fallback` with the reason (status 400/401/404/429/5xx/timeout), and merge the OpenRouter + chunk-alias stream instead.
- Otherwise flush the buffer and pipe the rest.

Emit the `start` metadata (`ragTraceId`, `answerId`) only once. Add **404** to D-10's list: a retired model returns `not_found_error`.

### Pattern 6: `rag_answer_records`

- `tenant_key` is a **generated column** (`s:default` / `u:<user>` / `o:<org>`), the same expression as Phase 3's documents, so it cannot disagree with the chat's scope.
- FK `chat_id → chats(id) ON DELETE CASCADE`.
- `REVOKE ALL ... FROM anon`. `GRANT SELECT` to `authenticated` with policy `user_id = auth.uid()`. No insert/update/delete policies (writes go through the service role).
- Index `(chat_id)` and `(user_id, created_at)`.
- Shared chats never read this table.

### Pattern 7: Post-stream scheduling

Do the `pending` insert **inside** the `scheduleAfterResponse` task, followed by the sidecar call. This keeps the DB round trip off the stream close. The client poll treats 404 as "not yet" within its ~30 s window. `scheduleAfterResponse` already swallows failures [VERIFIED: `src/lib/rag/trace/schedule.ts:4-17`, read this session]. Vercel `maxDuration: 60` covers the stream plus `after()`. A long stream followed by a 20 s check can be killed, and that case is what the 120 s `expired` read rule (D-15) covers.

### Pattern 8: Feedback score idempotency

Post `user_feedback` with a deterministic score `id` (e.g. sha256 of `traceId|user_feedback`), so a changed vote overwrites the earlier one. The Python online judge already uses deterministic ids and a batch array to `/api/public/scores`, and treats HTTP 202/207 as accepted or partial [VERIFIED: `eval/src/rag_eval/langfuse_api.py:12` `SCORES_PATH = "/api/public/scores"`, read this session; payload keys `id, traceId, name, value, dataType, comment` from `eval/src/rag_eval/online_judge.py` ~L96-102].

### Anti-Patterns to Avoid
- **`data: block.text` (string) on file parts:** the text is parsed as a URL (P-1).
- **JSON mode or `responseFormat` on the streamed answer:** this breaks streaming (D-04). On the Claude path it also returns HTTP 400 when combined with citation-enabled documents [CITED: citations doc].
- **Re-reading chunks by id to render a citation:** chunks are re-chunked or deleted (D-03).
- **Patching `chats.messages` from the server:** races with client saves (D-16).
- **Sending prior turns' `[S…]` markers back to the model:** aliases are per request (P-7).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Anthropic SSE parsing and citation decoding | Own fetch/SSE client | `@ai-sdk/anthropic@3.0.143` | Handles `citations_delta`, document index mapping, thinking and tool blocks |
| Stream interception | Wrapping `ReadableStream`s by hand around `toUIMessageStream` | `experimental_transform` | Runs before `onChunk`, `onFinish` and the UI stream, so persisted text matches what the user saw |
| Test fakes for the Anthropic stream | Mocking `streamText` | Real provider + `createAnthropic({ fetch })` replaying SSE fixtures; `MockLanguageModelV3`/`simulateReadableStream` from `ai/test` for the alias path [VERIFIED: `node_modules/ai/dist/test/index.d.ts` exports both] | Exercises the real decoding |
| HHEM inference | Re-implementing the T5 prompt and softmax | `AutoModelForSequenceClassification.from_pretrained(..., revision=, trust_remote_code=True).predict(pairs)` | Uses the exact trained prompt |
| PII masking for feedback reasons and review copies | New regexes | `maskPII` (`src/lib/rag/trace/mask.ts`) | D-18/D-19 reuse the Phase 2 masker |
| Schema parity | Hand-written Zod | `npm run gen:schemas` (`export_schemas.py` → `scripts/gen-zod.mjs`) | CI drift check |
| Tenant key | Computing it in TS for the insert | Generated column | Cannot drift from the chat's columns |

## Runtime State Inventory

The phase is mostly additive, but it changes persisted shapes. Each category was checked:

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | `chats.messages` JSONB: old assistant messages carry only `metadata.ragTraceId` (`toDBMessages`/`toExtendedMessage` keep only that key) | Code edit only. Old messages must keep loading without the new fields. No data migration |
| Live service config | Langfuse: new score names `groundedness`, `groundedness_label`, `user_feedback`, and tags `review:<reason>`. No dashboard config is stored in git | None in code. Note it for the operator |
| OS-registered state | None. The sidecar runs as a container; no OS registrations found | None |
| Secrets/env vars | New `ANTHROPIC_API_KEY` (app) and `VECTARA_API_KEY` (sidecar). No renames | Add placeholders only |
| Build artifacts | New sidecar Docker target `hhem` with baked HF cache. `uv.lock` must be regenerated for the new extra | Rebuild the image; CI keeps `uv sync --locked` without extras |

## Common Pitfalls

### P-1: Chunk text becomes a URL
**What goes wrong:** `data: "Document: a.pdf. Chunk 1 of 3. Content: …"` is parsed as `new URL(...)` with protocol `document:`. Node confirms: `"Document: report.pdf. Chunk 1 of 3. Content: hello" -> URL document:`, `"Note: x" -> URL note:` [VERIFIED: executed this session]. `ai@6.0.3` `convertToLanguageModelV3DataContent` tries `new URL(content)` for every string [VERIFIED: `node_modules/ai/dist/index.mjs` ~L979-1005]. A string that is not a URL is also wrong: it stays a string, and the provider's `convertToString` base64-decodes strings.
**How to avoid:** Always pass `Uint8Array`. Test with a chunk whose text starts with `Document:`.

### P-2: Route tests cannot see transforms
`createStreamTextCapture` replaces `streamText` and emits UI chunks directly [VERIFIED: `tests/helpers/chat-route-fakes.ts` ~L177-215]. Parser and injection behaviour needs unit tests on the real `streamText`. The route tests can still assert the finish metadata if the fake calls `messageMetadata` after the deltas, which it already does.

### P-3: `ANTHROPIC_BASE_URL=` empty string
`createAnthropic` computes `normalizeBaseURL(loadOptionalSetting({settingValue: options.baseURL, environmentVariableName: 'ANTHROPIC_BASE_URL'})) ?? 'https://api.anthropic.com/v1'`. `loadOptionalSetting` returns `process.env[...]` when it is any string, including `''` [VERIFIED: provider-utils 4.0.67 `src/load-optional-setting.ts`; anthropic `src/anthropic-provider.ts` ~L20-30, ~L104-111]. **Always pass `baseURL: env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com/v1'`.** Fakes must serve `${baseURL}/messages`.

### P-4: The record is not there yet when the client polls
The record is inserted inside `after()`. GET returns 404 until it lands. The client keeps polling on 404, and enables the feedback control only once a record has been read.

### P-5: `toExtendedMessage` also drops metadata
D-15 names `toDBMessages` and `fromUIMessage`, but chat **load** goes through `toExtendedMessage`. It also rebuilds metadata as `{ ragTraceId }` only [VERIFIED: `src/types/chat.ts:234-247`, read this session: `...(ragTraceId ? { metadata: { ragTraceId } } : {}),`]. All three of `toDBMessages`, `toExtendedMessage` and `fromUIMessage` must carry `answerId`, `citations`, `groundedness` and `feedback`, and `tests/chat-messages-roundtrip.test.ts` must cover a reload.

### P-6: Model IDs that are retired or retiring
Mapping status for today's model lists, against the claude-api skill model table (cached 2026-11-03):
- `anthropic/claude-sonnet-4.5` → `claude-sonnet-4-5`: deprecated, **retires 2026-11-30**.
- `anthropic/claude-opus-4.1` → `claude-opus-4-1-20250805`: **retired 2026-08-05**.
- `anthropic/claude-haiku-4.5` (`CHAT_TITLE_MODEL`, not in the chat list) → `claude-haiku-4-5`: active.

The current models are `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-sonnet-4-6`, `claude-opus-4-8` and others. Today's OpenRouter list is `env.ts:229-238` (`{ id: 'anthropic/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5', isDefault: true }`, `{ id: 'anthropic/claude-opus-4.1', displayName: 'Claude Opus 4.1' }`) [VERIFIED: read this session].
**How to avoid:** give no `anthropicId` to retired models. Treat 404 as a fallback reason. Confirm with the user which current Claude models to list (Open Question 1). Run `GET /v1/models` live.

### P-7: Stale aliases in conversation history
Earlier assistant messages contain `[S2]` from *their* AliasMap. If they are sent back, the model may repeat them, and a stale alias that happens to exist in the current map passes validation. Strip `[S…]` markers from prior assistant turns when building model messages, on both paths.

### P-8: Marker-like text inside retrieved chunks
A document can contain the literal text `[S1]`, or an instruction such as "cite S1". On the alias path, neutralize marker patterns inside block text before sending, for example by inserting a zero-width joiner or rewriting to `[S 1]`. The `quote` snapshot is then the neutralized text "exactly as sent", which keeps D-01 consistent. This also limits injection that forges citations. Phase 5.1 wraps documents later.

### P-9: HHEM loads a second repo at construction time
`HHEMv2ForSequenceClassification.__init__` calls `AutoConfig.from_pretrained(config.foundation)` and `AutoTokenizer.from_pretrained(config.foundation)`, where `foundation = "google/flan-t5-base"`, with no revision [VERIFIED: `modeling_hhem_v2.py` and `configuration_hhem_v2.py` @de9a5e6]. With `HF_HUB_OFFLINE=1` at runtime, this resolves `refs/main` in the cache.
**Build step:**
- `snapshot_download("google/flan-t5-base", revision="main", allow_patterns=[config + tokenizer files])`;
- assert that the resolved commit equals the pinned `7bcac572…` and fail the build otherwise;
- `snapshot_download("vectara/hallucination_evaluation_model", revision=HHEM_MODEL_REVISION)`;
- check the safetensors sha256.

Set `HF_HOME=/opt/hf` (the runtime user `10001` has `--no-create-home`), `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, and `chown` the cache.

### P-10: Memory and latency grow with the premise
The model card states "<600MB RAM at 32-bit, ~1.5 s for a 2k-token input on a modern x86 CPU", and HHEM-2.1-Open has "unlimited context length" [CITED: HF card @de9a5e6]. T5-base self-attention is O(n²). Rough estimate of attention scores per encoder layer for 12 heads × n² × 4 bytes: 4k tokens ≈ 0.77 GB, 6k ≈ 1.7 GB [ASSUMED: arithmetic, not measured]. Phase 4's context budget is 6000 cl100k tokens (04-CONTEXT D-15).
**Recommendation:**
- `RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS=3000` (cl100k, counted app-side), with cited blocks kept first (D-14);
- run local scoring in a threadpool with **concurrency 1** (a semaphore). When busy past a short queue wait, return `not_checked` with reason `scorer_busy`;
- measure at 1k/3k/6k during live verification.

### P-11: There is no TS Langfuse scores client yet
The TS trace code exports spans through OTel only (`exportTrace`). `/api/public/scores` exists only in Python (`langfuse_api.py`). CONTEXT says "reused", but the TS side needs a small time-boxed fetch client (Basic auth with public:secret, deterministic ids, 202/207 handling) mirroring the Python one.

### P-12: Review tags on an already-exported trace
`finishTrace` exports in `after()` at stream finish, and only when sampled (`isSampled(traceId, sampleRate, 'trace')` or the review sample) [VERIFIED: `src/lib/rag/trace/finish.ts` ~L55-75]. Groundedness arrives seconds later, and feedback arrives in a separate request. D-19 needs a second export, a single observation on the same `traceId` carrying `langfuse.trace.tags` with `review_candidate` and `review:<reason>` plus masked input and output, made regardless of sampling. Whether Langfuse merges tags across observations or replaces them is [ASSUMED]. Verify it with `tests/helpers/fake-langfuse.mts` and live.

### P-13: The citation instruction and `{{context}}`
`createEnhancedRAGPrompt` substitutes `{{context}}` inside the mode wrapper [VERIFIED: `src/lib/rag/generation/prompt.ts`]. Append the cite instruction to the returned string. Never edit `RAG_SYSTEM_PROMPT` or the wrappers. On the Claude path, the "attached documents" sentence takes the place of the context argument, and the link section and image captions stay in the system text.

### P-14: Contract naming
Existing sidecar contracts use snake_case fields with `extra="forbid", frozen=True` [VERIFIED: `rag-sidecar/src/rag_sidecar/contracts/review.py:6-7`, read this session]. D-01 locks camelCase field names (`chunkIds`, `documentId`, …). Define `CitationRecord` with the locked camelCase field names directly. Do not use an alias generator: generated Zod reads property names from the JSON Schema. `TraceCitation` (`document_id: str`, `chunk_id: str | None = None`, `eval_run.py:105-107`) becomes `CitationRecord` in `RagTrace.citations`. Existing traces carry `citations: []`, and `samples.py` builds one `TraceCitation`, which must be updated. `RagTrace.schema_version` is `Literal[1]`. Decide whether to bump it (Open Question 4).

## Code Examples

### Claude call skeleton
```ts
// Source: @ai-sdk/anthropic@3.0.143 provider settings (baseURL, apiKey, fetch) + file-part conversion
import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';

const anthropic = createAnthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  baseURL: env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com/v1', // P-3
});
const docs = aliasMap.blocks.map((b) => ({
  type: 'file' as const,
  mediaType: 'text/plain',
  filename: b.alias,                                   // e.g. 'S3'
  data: new TextEncoder().encode(b.text),              // P-1: never a string
  providerOptions: { anthropic: { citations: { enabled: true }, title: b.title } },
}));
const result = streamText({
  model: anthropic(model.anthropicId),
  system: systemWithAttachedSentence,
  messages: [...historyWithoutMarkers, { role: 'user', content: [...docs, { type: 'text', text: question }] }],
  maxRetries: 0,
  maxOutputTokens: 16384,
  experimental_transform: claudeMarkerTransform(new Set(aliasMap.aliases)),
  abortSignal: firstTokenController.signal,
});
```

### Sidecar Vectara call
```python
# Source: docs.vectara.com/docs/rest-api/evaluate-factual-consistency (path, body, model);
#         docs.vectara.com/docs/rest-api/vectara-rest-api-v-2 (host, x-api-key)
resp = await client.post(
    f"{settings.vectara_base_url}/v2/evaluate_factual_consistency",   # default https://api.vectara.io
    headers={"x-api-key": key.get_secret_value()},
    json={"generated_text": hypothesis, "source_texts": premise_texts,
          "model_parameters": {"model_name": "hhem_v2.3"}},
    timeout=httpx.Timeout(8.0, connect=2.0),
)
score = float(resp.json()["score"])   # 0..1, higher = more consistent
```

### Local HHEM
```python
# Source: HF model card @de9a5e6 ("Using with AutoModel")
model = AutoModelForSequenceClassification.from_pretrained(
    "vectara/hallucination_evaluation_model", revision=settings.hhem_model_revision,
    trust_remote_code=True)                      # HF_HUB_OFFLINE=1 at runtime (P-9)
score = float(model.predict([("\n\n".join(premise_texts), hypothesis)])[0])
```

## Anthropic Citations: confirmed behaviour

| Topic | Finding | Source |
|-------|---------|--------|
| Enabling | `citations: {enabled: true}` on every document. Mixing enabled and disabled documents is rejected | [CITED: citations doc] |
| Plain text | Sentence-chunked automatically. Put each RAG chunk in its own plain-text document. `char_location` indices are 0-indexed with an exclusive end. `document_index` is 0-indexed across all document blocks in the request, spanning messages | [CITED] |
| Streaming | `content_block_delta` with `delta.type = "citations_delta"` carries one citation for the current `text` block. In the doc's example it arrives after that block's `text_delta` | [CITED] |
| Structured outputs | Citations combined with `output_config.format` (or the deprecated `output_format`) returns **400** | [CITED] |
| Tokens | `cited_text` does not count toward output tokens, nor toward input tokens when passed back | [CITED] |
| Caching | Citation blocks cannot be cached. Document blocks can carry `cache_control` | [CITED] |
| Models | Supported list includes `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-5-20250929` | [CITED: `supportedModels`] |
| AI SDK mapping | `char_location`/`page_location` → `source` part with `{citedText, startCharIndex, endCharIndex}`. `web_search_result_location` → URL source. Other citation types (e.g. `content_block_location`) are dropped | [VERIFIED: provider source] |
| Tools | No incompatibility is documented. In multi-step turns the user message with the documents is resent, so indices stay stable. Tool results are not citable documents. Keep webSearch turns ineligible until the recorded test exists (D-10) | Absent evidence, so [ASSUMED] for "compatible" |

## Vectara HHEM-2.3

| Item | Finding | Tag |
|------|---------|-----|
| Endpoint | `POST /v2/evaluate_factual_consistency` | [CITED: docs.vectara.com/docs/rest-api/evaluate-factual-consistency] |
| Host | `https://api.vectara.io/v2/<resource>` (v1 retired 2025-08-16) | [CITED: docs.vectara.com/docs/rest-api/vectara-rest-api-v-2] |
| Auth | `x-api-key` header (or OAuth `Authorization: Bearer`, token TTL 30 min) | [CITED] |
| Request | `generated_text` (string), `source_texts` (array), optional `model_parameters.model_name`: `hhem_v2.3` default, `hhem_v2.2` served by 2.3, anything else → 400. No `language` field | [CITED] |
| Response | `{score}` 0.0–1.0, higher = more consistent. 400 invalid body, 403 key lacks permission | [CITED] |
| Languages | eng, deu, fra, spa, por, ara, kor, zho, rus, jpn, hin. Other languages "unreliable" | [CITED]. HHEM card lists "Chinese-Simplified" |
| Size and rate limits | Not stated on either page | **No observation.** Live verification |
| Data retention | Vectara's privacy policy excludes "personal information that we process on behalf of our customers" and gives no API retention period. No DPA reference was found | **No observation.** Keep `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK` fail-closed until the live check records terms |

## Latency Evidence

| Item | Evidence | Budget impact |
|------|----------|---------------|
| Pre-first-token chat budget | `chat.total_p50_ms: 1000`, `total_p95_ms: 2000`, stages `assemble 100`, `embed 200`, `search 400` [VERIFIED: `eval/config/latency-budgets.json:3-11`, read this session] | Citations add only labelling and block building (sub-ms) before the model call |
| Claude direct TTFT vs OpenRouter | Not measured (no key). The direct path skips one proxy hop. Citations add "a slight increase in input tokens" [CITED] | Report-only per strategy (D-23). The live spike records it |
| Fallback cost | A pre-first-token failure costs one failed request plus the first-token timeout. With `maxRetries: 0`, there are no SDK retries | Recommend a first-token timeout of 8 s [ASSUMED] |
| HHEM-2.1-Open local | ~1.5 s per 2k tokens on x86 CPU, <600 MB at fp32 [CITED: model card] | Fits the 5000 ms p95 starting value at a cap of ≤3000 tokens [ASSUMED] |
| Vectara | No published latency | 8000 ms p95 starting value (D-23) |
| Schema | `latency-budgets.json` has only `profiles` and `schema_version`. Per-scorer groundedness entries need a `LatencyBudgets` contract extension (sidecar `contracts/latency.py`) and Zod regeneration | Plan a contract task |

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `thinking: {type:'enabled', budget_tokens}` | `{type:'adaptive'}` + `effort`; budget rejected on 4.7+ | 2026 | Reasoning mapping in D-10 must not send budgets to current models |
| `output_format` | `output_config.format` (incompatible with citations) | 2025-26 | GEN-04 split remains correct |
| Vectara REST v1 | v2 only | 2025-08-16 | Use `/v2/...` |
| HHEM-2.1-Open on transformers 4.x | Remote code supports transformers 5 (`post_init`) | 2026-10-06 commit | Pin `de9a5e6…`, not older revisions |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Citations coexist with tool use and multi-step on the AI SDK path | Anthropic table | webSearch turns on the Claude path fail. They are already ineligible until the spike (D-10) |
| A2 | Langfuse merges `langfuse.trace.tags` from a later observation into the trace | P-12 | Review tags overwrite earlier tags, or are lost. Verify with fake and live |
| A3 | `RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS=3000` keeps local HHEM within about 1–1.5 GB RSS and 5 s | P-10 | OOM or timeouts in the sidecar. Measured in live verification |
| A4 | The flan-t5 tokenizer loads from `tokenizer.json` without `sentencepiece`/`protobuf` under transformers 5.23 | P-9 | Build fails. Add `sentencepiece==0.2.3` (2026-11-05) to the extra |
| A5 | First-token timeout of 8 s for the Claude fallback | Latency | Too short drops valid slow starts. Too long delays fallback |
| A6 | OpenRouter ids for current Claude models (e.g. `anthropic/claude-sonnet-5.5`) | P-6 | Wrong ids in five locations. Needs user and OpenRouter confirmation |
| A7 | Langfuse accepts `dataType: "CATEGORICAL"` for `groundedness_label` | Pattern 8 | Score rejected (207). Fallback: NUMERIC 0/1/2 plus a comment |
| A8 | Attention memory arithmetic in P-10 (eager attention) | P-10 | If SDPA is used, memory is lower and the cap can rise |

## Open Questions

1. **Which Claude models get an `anthropicId`?**
   - Known: Sonnet 4.5 retires on 2026-11-30, and Opus 4.1 is retired.
   - Recommendation: map none of today's two entries. Add a `checkpoint:decision` asking the user which current Claude models to add to the OpenRouter list, with `anthropicId` (e.g. `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`). Verify each with `GET /v1/models` in the live spike.
2. **Referenced documents (useDocument) on the Claude path.**
   - Recommendation: one block and alias per referenced document section (Pattern 1). They must become citation documents, because of the all-or-none rule.
3. **Traditional vs Simplified Chinese detection.**
   - Recommendation: an app-side script heuristic, a small committed list of frequent Traditional-only characters with a ratio threshold, unit-tested. No new package. An ambiguous result is treated as `zh-Hans` only when the Simplified-only count is higher. Otherwise `not_checked`.
4. **`RagTrace.schema_version` when `citations` changes type.**
   - Recommendation: keep `Literal[1]`. All recorded traces have empty citation lists, so they stay valid. Update `samples.py` and regenerate. If any committed baseline holds non-empty citations, bump to 2.
5. **Aborted streams (user presses stop).**
   - Recommendation: insert the record with `groundedness = not_checked`, reason `aborted`, keeping the citations validated so far. No scoring.
6. **Sidecar memory sizing for the `hhem` target.**
   - Recommendation: document a 2 GB minimum for the `hhem` image. Confirm during the live HHEM run.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | app, tests | ✓ | v22.23.5 | — |
| npm registry access | install `@ai-sdk/anthropic` | ✓ | npm 10.9.9 | — |
| Python | sidecar | ✓ (3.13.18 on host; sidecar requires `>=3.12,<3.13` via uv) | — | uv-managed 3.12 as in CI |
| PyPI / pytorch CPU index / HF Hub | `hhem` extra and weights | ✓ reachable | — | — |
| `ANTHROPIC_API_KEY` | live spike | ✗ | — | Recorded/fake SSE (D-24) |
| `VECTARA_API_KEY` | live Vectara check | ✗ | — | Fake Vectara (httpx `MockTransport`) |
| torch/transformers installed | real HHEM run | ✗ (not installed; research did not install) | — | Stub scorer in CI. Real run is live verification |
| Docker | `--target hhem` build | not probed | — | Nightly or manual |

**Missing with no fallback:** none for automated completion. Live items are ROADMAP live verification.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 5.1.1 (`vitest.config.ts`, `tests/**/*.test.ts`, node env); `node --import tsx --test tests/*.test.mts`; pytest 9.2.0 (sidecar, eval) |
| Config file | `vitest.config.ts`, `rag-sidecar/pyproject.toml [tool.pytest.ini_options]` |
| Quick run command | `npx vitest run tests/rag/citations` |
| Full suite command | `npx vitest run && node --import tsx --test tests/*.test.mts && uv run --directory rag-sidecar pytest -q && uv run --directory eval pytest -q && node scripts/check-config.mjs && npx next typegen && npx tsc --noEmit -p tsconfig.json` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GEN-01 | Request has one `document` per block, citations on, `filename=alias`, Uint8Array data, no `output_config` | unit (real provider + fake fetch) | `npx vitest run tests/rag/citations/claude-request.test.ts` | ❌ Wave 0 |
| GEN-01 | Recorded SSE (citations, thinking, error-before-first-token) → markers injected, CitationRecord with `citedText` | unit | `npx vitest run tests/rag/citations/claude-stream.test.ts` | ❌ Wave 0 (+ `tests/fixtures/anthropic/*.sse`) |
| GEN-01 | Eligibility matrix (switch, key, anthropicId, KB, MCP, multi-step, webSearch, reasoning) and fallback with trace reason incl. 404 and timeout | unit | `npx vitest run tests/rag/citations/strategy.test.ts` | ❌ Wave 0 |
| GEN-01 | `anthropicId` agrees across five locations | node test | `node --test scripts/check-config.test.mjs` | ✅ extend |
| GEN-02 | Marker split at every char boundary, full-width forms, lists, unknown dropped and counted | unit | `npx vitest run tests/rag/citations/marker-parser.test.ts` | ❌ Wave 0 |
| GEN-02 | Parser transform on real `streamText` + `MockLanguageModelV3` → finish metadata list | unit | `npx vitest run tests/rag/citations/alias-transform.test.ts` | ❌ Wave 0 |
| GEN-02/07 | WhatsApp body (no capability), voice, embed: prompt and text byte-identical | route | `npx vitest run tests/rag/characterize-chat.test.ts tests/rag/characterize-embed.test.ts tests/rag/characterize-voice.test.ts` | ✅ extend |
| GEN-03 | Snapshot survives publish/soft delete/hard delete/re-chunk | db (PGlite) | `node --import tsx --test tests/rag-db/answer-records-snapshot.test.mts` | ❌ Wave 0 |
| GEN-03 | Metadata round-trip through `toDBMessages` → `toExtendedMessage` → `fromUIMessage` | unit | `npx vitest run tests/chat-messages-roundtrip.test.ts` | ✅ extend |
| GEN-04 | Contracts validate; Zod parity | unit / CI | `npx vitest run tests/contracts.test.ts && node --test scripts/tests/gen-zod.node-test.mjs` | ✅ extend |
| GEN-05 | Routing matrix, Vectara failure → local (en) / not_checked (zh), auth fail-closed, `/ready` scorers | pytest | `uv run --directory rag-sidecar pytest tests/test_groundedness.py -q` | ❌ Wave 0 |
| GEN-05/06 | after() scheduling, timeout → not_checked, pending > 120 s → expired, ghost skipped, strict refusal skipped | unit | `npx vitest run tests/rag/groundedness.test.ts` | ❌ Wave 0 |
| GEN-06 | Badge state and visibility predicate (no number, strict/balanced only, hidden while pending) | unit (pure) | `npx vitest run tests/rag/citations/badge-state.test.ts` | ❌ Wave 0; visual check is manual UAT |
| GEN-07 | Switches off → byte-identical route output; strict refusal language intact with switches on | route | `npx vitest run tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/chat-source-images.test.ts tests/rag/characterize-chat.test.ts` | ✅ extend |
| D-16/17 | RLS select-own, anon refused, same-org other user 404, tenant_key generated | db + route | `node --import tsx --test tests/rag-db/answer-records-rls.test.mts && npx vitest run tests/api/rag-answers.test.ts` | ❌ Wave 0 |
| EVAL-16 | Vote stored first, changeable, Langfuse score with deterministic id, masked reason, log fallback; review reasons | unit + route | `npx vitest run tests/rag/feedback.test.ts tests/api/rag-answers-feedback.test.ts` | ❌ Wave 0 |
| EVAL-16 | `review_queue pull --source db`, dedupe by trace id, `reasons[]` | pytest | `uv run --directory eval pytest tests/test_review_queue.py -q` | ✅ extend |
| D-24 | Eval metrics `invalid_citation_rate=0`, `citation_coverage`, `cited_gold_hit` | pytest | `uv run --directory eval pytest -q -k citation` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the quick command for the touched module (≤30 s).
- **Per wave merge:** full suite command.
- **Phase gate:** full suite green plus the D-25 comparison before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `tests/fixtures/anthropic/{citations,thinking-citations,websearch-tool,error-before-first-token}.sse`, written from the documented event shapes. No secrets.
- [ ] `tests/rag/citations/` (parser, transforms, request, stream, strategy, badge-state)
- [ ] `tests/rag-db/answer-records-*.test.mts` on the PGlite harness
- [ ] `rag-sidecar/tests/test_groundedness.py` with a fake Vectara (`httpx.MockTransport`) and a stub scorer
- [ ] A fake Langfuse scores endpoint added to `tests/helpers/fake-langfuse.mts`

## Security Domain

`security_enforcement: true`, ASVS level 1.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Supabase SSR session on the new routes; sidecar `x-sidecar-secret` (`SECRET_HEADER = b"x-sidecar-secret"`, `auth.py:10`, read this session), fail-closed |
| V3 Session Management | yes | Existing Supabase cookies; no new session state |
| V4 Access Control | yes | RLS `user_id = auth.uid()` select-only; server writes after a chat-ownership check; **404 for not-owned and for nonexistent** (same body and timing path); no anon grants; feedback query and answer read from the caller's own chat row, never from the body (D-19) |
| V5 Input Validation | yes | `zod/v3`: `answerId`/`chatId` UUID, vote enum, reason chips enum, free text ≤500 chars; sidecar Pydantic `extra="forbid"` |
| V6 Cryptography | no new crypto | `quoteHash` = sha256 (integrity, not security); keys only in env |
| V7 Error/Logging | yes | `[Groundedness]` / `[RAG Feedback]` / `[Citations]` logs carry no answer or chunk text; no key values |
| V8 Data Protection | yes | Vectara egress only with opt-in, plus the multi-tenant ACK, fail-closed; Langfuse copies PII-masked; ghost chats persist nothing |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Reading another user's answer record (IDOR) | Information disclosure | RLS plus a route ownership check. 404 not 403. Tests for same-org users and anon |
| Cross-tenant feedback, or feedback on another user's answer | Tampering | Ownership check before the write; `tenant_key` generated from the chat; record lookup scoped by `user_id` |
| Forged citations through marker text in documents | Spoofing/Tampering | Server-side validation against the AliasMap; neutralize marker-like text in blocks (P-8); hide unvalidated markers |
| Prompt injection in cited text rendered in the UI | Tampering / XSS | Render `quote`, titles and names as plain text (React escaping, never markdown/HTML); cap quote length; Phase 5.1 adds tagging |
| Answer and chunk text leaving the deployment | Information disclosure | Vectara opt-in plus the multi-tenant ACK; Langfuse masking; no text in logs |
| Feedback flood or abuse | DoS | One vote per answer (upsert); 500-char cap; the endpoint requires a session. Consider the existing rate-limit helper if present |
| CSRF on the feedback POST | Tampering | Require `Content-Type: application/json` (no simple-form CSRF); SameSite cookies; no CORS headers added |
| Unpinned remote code in HHEM | Tampering (supply chain) | `trust_remote_code` pinned to a commit; weights sha256 check; offline at runtime |

## Sources

### Primary (HIGH confidence)
- npm registry: `@ai-sdk/anthropic` dist-tags and time, `ai` dist-tags, `@ai-sdk/provider-utils@4.0.67` deps. Tarballs of `@ai-sdk/anthropic@3.0.143`, `@ai-sdk/provider-utils@4.0.67` and `@ai-sdk/provider@3.0.19` were read in the session scratchpad (not installed in the project).
- Installed `node_modules/ai@6.0.3` (`dist/index.d.ts`, `dist/index.mjs`, `dist/test`) and `@ai-sdk/provider@3.0.0`.
- Hugging Face API: `vectara/hallucination_evaluation_model` (sha, commits, tree, config, remote code, README @de9a5e6) and `google/flan-t5-base`.
- PyPI JSON: torch, transformers, huggingface-hub, tokenizers, safetensors, sentencepiece, docling-ibm-models, docling-slim. The pytorch CPU wheel index.
- Repository files read this session: `src/app/api/chat/route.ts`, `src/types/chat.ts`, `src/lib/rag/trace/{schedule,finish,langfuse}.ts`, `src/lib/rag/context/assemble.ts`, `src/lib/rag/tenant/scope.ts`, `src/lib/env.ts`, sidecar `auth.py`, `contracts/{eval_run,review}.py`, `pyproject.toml`, `eval/config/latency-budgets.json`, `eval/src/rag_eval/langfuse_api.py`, `tests/helpers/chat-route-fakes.ts`.

### Secondary (MEDIUM; official docs; the seam rates the webfetch provider LOW)
- https://platform.claude.com/docs/en/build-with-claude/citations (enabling, indices, streaming, structured-output 400, tokens, caching, supported models)
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking (budget removed on 4.7+)
- claude-api skill `shared/models.md` (model status table, cached 2026-11-03)
- https://docs.vectara.com/docs/rest-api/evaluate-factual-consistency and https://docs.vectara.com/docs/rest-api/vectara-rest-api-v-2
- https://huggingface.co/vectara/hallucination_evaluation_model (model card @de9a5e6)

### Tertiary (LOW)
- https://www.vectara.com/legal/privacy-policy (no API retention terms found: no observation)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH for npm and provider behaviour (source read); MEDIUM for Python pins (registry-verified, not installed).
- Architecture: MEDIUM-HIGH. The transform ordering and request shape were read from code; Claude streaming with tools is unverified live.
- Pitfalls: HIGH for P-1, P-3, P-5, P-6 and P-9 (executed or read); MEDIUM for P-10 and P-12 (assumed).

**Research date:** 2026-11-24
**Valid until:** 2026-12-08. Fast-moving: the AI SDK publishes 3.0.x weekly, and Anthropic model retirements are scheduled.
