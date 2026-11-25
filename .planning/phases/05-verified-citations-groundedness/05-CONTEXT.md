# Phase 5: Verified Citations & Groundedness - Context

**Gathered:** 2026-11-24
**Status:** Ready for planning
**Mode:** `--auto`. Every gray area was resolved with the recommended option, per the user's standing instruction "all questions follow your recommendations".

<domain>
## Phase Boundary

This phase changes the generation layer of the web chat. It does not change retrieval. It delivers five things:
- **Claude Citations path (GEN-01, GEN-04):** when the selected model maps to an Anthropic model and the turn is eligible, the answer is generated through the direct Anthropic API with Citations. Each context block is one citation-enabled plain-text document. That call never uses structured output.
- **Chunk-alias path (GEN-02, GEN-04):** every other model gets short aliases (`[S1]`…) in its context and is asked to cite them. The server parses the markers from the stream, including markers split across tokens, drops unknown aliases and aliases that were not in the context sent, and emits the validated list as a schema-validated structured record.
- **One persisted citation record (GEN-03):** both paths produce the same `citations[]` record with a text snapshot, so citations still resolve after the cited document is re-chunked, replaced or deleted.
- **Post-stream groundedness (GEN-05, GEN-06):** after the answer finishes streaming, the sidecar scores it. HHEM-2.3 runs through Vectara only with a key and an explicit opt-in (zh, en). HHEM-2.1-Open runs locally for English when there is no key. Everything else is recorded as "not checked". The UI shows a three-state badge in strict and balanced modes only. Answers are never delayed or blocked.
- **Answer feedback (EVAL-16):** a helpful / not helpful control on every RAG answer. The vote is stored with the message and sent to Langfuse as a score. "Not helpful" votes and "possibly unreliable" results enter the review queue.

GEN-07 is a constraint on all of the above. Existing behaviour must not change: strict "information not available" in the user's language, webSearch + Exa, `source_images`, `{{context}}`, the voice and embed paths. Every new switch defaults to off, and with all of them off the chat route behaves byte-for-byte as it does today.

In scope: GEN-01 to GEN-07 and EVAL-16.

Out of scope:
- Prompt-injection tagging (`<documents><doc id>`) and retrieval-time injection checks: Phase 5.1. This phase's aliases are the ids that Phase 5.1 will put in those tags (D-07).
- Retrieval, rerank, refusal thresholds and context assembly: Phases 2 and 4. This phase consumes the final ordered context blocks.
- Blocking or rewriting answers based on the HHEM score (PROJECT.md Out of Scope).
- Sentence-level highlighting (UX-01) and click-through to the source page (UX-02): v2 requirements.
- Citations in the embed widget, voice and WhatsApp (D-05).
- The Config UI review-queue screen and promotion from it: Phase 7 (EVAL-17 / ADM).
- Choosing shipped defaults: Phase 7 (ADM-02). Every switch added here stays off by default.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements
- `.planning/ROADMAP.md` §"Phase 5: Verified Citations & Groundedness": the goal, the six success criteria and the live verification items (the Anthropic spike, the Vectara host, header, limits and retention, the HHEM-2.1-Open run, Faithfulness compared with the baseline).
- `.planning/REQUIREMENTS.md`: GEN-01 to GEN-07 and EVAL-16. Also read for constraints: EVAL-06 (trace citations), EVAL-15 (review queue), OBS-01 (the `groundedness` stage span), OBS-02 (budgets), PIPE-06 (only a verified `empty` refuses), and UX-01 and UX-02 (deferred).
- `.planning/PROJECT.md` §Constraints and §Key Decisions: Claude Citations only for Claude models; HHEM records without blocking; HHEM-2.3 through Vectara with opt-in and Italian "not checked"; Pydantic → Zod; the sidecar over HTTP; config sync; no secrets.
- `AGENTS.md` §6 (Image RAG: images are not cited), §7 (the `Model` schema and the five model locations) and §14 (behaviour to preserve).

### Prior phase decisions
- `.planning/phases/01-evaluation-harness-baseline/01-CONTEXT.md`: D-02 (eval endpoint), D-06 (gen:schemas), D-13 (span match), D-14 (split), D-15 and D-22 (judge), D-21 (sidecar auth).
- `.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-CONTEXT.md`, including "Adjustments after research": D-01 (`RetrievalResult`), D-05 and D-06 (status and the in-band error mapping), D-07 and D-08 (`TenantScope`, chat scope), D-16 (`assembleContext`), D-18 to D-20 (Langfuse, `after()` flush, scores endpoint, `[RAG Trace]`), D-21 (budgets), D-26 (review queue, PII masker, online judge).
- `.planning/phases/03-unified-ingestion-embedding-profiles/03-CONTEXT.md`: D-05 (migrations convention), D-06, D-07 and D-11 (versions, `is_current`, old rows kept so citations resolve), D-31 (quarantine).
- `.planning/phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-CONTEXT.md`: D-27 (`rag_soft_delete_document`), D-30 (provisional versions).
- `.planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-CONTEXT.md`: D-15 and D-16 (merged blocks, edge order, extractive compression keeps verbatim text), D-17 and D-18 (calibration pattern reused in D-13), D-19, D-30 and D-31 (refusal semantics), D-21 (chunking profiles and re-chunk), D-24 (stage names).

### Research
- `.planning/research/STACK.md` rows 1, 2, 11 and 12, and §"Claude Citations via `@ai-sdk/anthropic@3`": what the provider supports (text/plain file parts, `source` parts, no `search_result`), the 400 when combined with structured outputs, positional `document_index`, the `ai-v6` dist-tag, the Vectara endpoint and the HHEM-2.1-Open notes.
- `.planning/research/ARCHITECTURE.md` §"Citations: Claude Citations vs chunk aliases", the `Citation` and `CitationStrategy` sketch, and the generation data flow.
- `.planning/research/PITFALLS.md`: Pitfall 1 (HHEM availability and languages), Pitfall 4 (latency; groundedness off the answer path), Pitfall 9 (citation-id drift and the Claude/structured-output conflict).
- `.planning/research/FEATURES.md` F1 to F3, GEN-01 to GEN-14 and EVL-15.
- `.planning/research/SUMMARY.md` §"Phase 6: Generation — citations and groundedness" (research numbering; this roadmap's Phase 5).

### Code
- `src/app/api/chat/route.ts`:
  - `documentReferenceTool` (~L70);
  - `ragMode` (~L1246);
  - the strict refusal (~L2136–2186);
  - the tool set and webSearch (~L3193);
  - the `isClaudeSonnet4` handling (~L3422);
  - `buildFinishMetadata`, `createUIMessageStream` and `messageMetadata` (~L3890–3970).
- `src/types/chat.ts`: `toDBMessages` and `fromUIMessage` keep only `ragTraceId` today (~L212–247).
- `src/app/page.tsx` (~L2772, the client chat load and save) and `src/components/ui/chat-message.tsx` (source extraction ~L2839), plus `src/components/ui/sources-button.tsx` and `src/components/providers/sources-provider.tsx`.
- `src/lib/rag/generation/prompt.ts` (`createEnhancedRAGPrompt`), `src/lib/rag/generation/messages.ts`, `src/lib/rag/context/`, `src/lib/rag/trace/schedule.ts` (`after()`).
- `src/lib/env.ts` (~L220, the model lists), `scripts/init-env.js`, `scripts/config-server.js`, `scripts/config-ui/index.html`, `scripts/rag/env-manifest.json`, `scripts/check-config.mjs`.
- `supabase/single-tenant-setup.sql` and `supabase/multi-tenant-setup.sql` (`chats` table, ~L259 in multi-tenant), `supabase/migrations/`.
- `rag-sidecar/src/rag_sidecar/` (`main.py`, `auth.py`, `settings.py`, `contracts/eval_run.py` `TraceCitation`, `contracts/review.py` `ReviewQueueItem`), `rag-sidecar/Dockerfile`, `rag-sidecar/pyproject.toml`.
- `eval/config/latency-budgets.json`, `eval/config/judge.json`, the `eval/src/rag_eval/` review_queue and calibrate modules.
- `src/lib/whatsapp/webhook-handler.ts` (~L371, which calls `/api/chat`).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The chat route already wraps `streamText` in `createUIMessageStream`. It injects `source_images` and `metadata` parts before merging, and attaches `ragTraceId` through `messageMetadata` on `start` and `finish`. `answerId` and `citations` ride the same hooks.
- `src/lib/rag/trace/schedule.ts` already schedules work with `after()` under a guard. Groundedness uses it.
- The Langfuse scores client (Phase 2 D-18, `POST /api/public/scores`) and the PII masker (D-26) are reused for groundedness and feedback scores.
- The sidecar's auth, settings, contracts and `export_schemas.py` pipeline give `/v1/groundedness` its pattern. The Phase 4 calibration tool gives the groundedness calibration its pattern.
- The PGlite harness and the migrations loader cover the new table and its RLS tests.

### Established Patterns
- Messages persist client-side as a JSONB array in `chats.messages`, so server-side results must reach the client and be merged into the message. The server must not patch the array.
- Zod via `zod/v3`; Pydantic is the source; bracketed log prefixes (`[Groundedness]`, `[RAG Feedback]`, `[Citations]`); env read through `src/lib/env.ts`; every switch is mirrored in five places.
- Models are reached only through OpenRouter today. There is no Anthropic SDK in `package.json`, and model ids follow the OpenRouter form (`anthropic/claude-sonnet-4.5`).
- Strict refusal and the knowledge-base-unavailable message are produced before `streamText`. Citation and groundedness code never sees them.

### Integration Points
- `src/lib/rag/generation/citations/` (strategies, alias map, parser), `src/lib/rag/generation/groundedness.ts`, the chat route's stream assembly, `src/types/chat.ts`, the chat message UI and sources panel, the new `src/app/api/rag/answers/` routes, the sidecar `/v1/groundedness` router and the `hhem` Docker target, a migration, the eval contracts and metrics, and the five config locations.

</code_context>

<specifics>
## Specific Ideas

- Citations must never be decoration. Every rendered citation chip corresponds to a block that was actually in that request's context. Validation happens server-side, and unvalidated markers are hidden.
- Answer and chunk text leave the deployment only through an explicit opt-in (Vectara). The multi-tenant use of Vectara also needs a recorded retention confirmation.
- No live keys are available in this environment. The Anthropic spike, the real Vectara call, the real HHEM-2.1-Open download and run, and the Faithfulness comparison on the real golden set are the ROADMAP live verification items.

</specifics>

<deferred>
## Deferred Ideas

- Citations in the embed widget (rendering plus persistence): the widget has no message store today. Backlog.
- Citations for webSearch (Exa) results on the Claude path, as `search_result` or documents (research GEN-13), only after GEN-01 is stable.
- An LLM-judge faithfulness fallback for Italian, Traditional Chinese and other "not checked" languages. Backlog; it would need its own egress and cost decision.
- Per-tenant Vectara opt-in, instead of the deployment-level switch.
- Treating strict-mode answers with zero valid citations as unsupported (warning or refusal). This phase only records `citation_coverage`.
- Sentence-level highlighting (UX-01) and click-through to the source page (UX-02).
- Using groundedness to block or regenerate answers (out of scope for v1).
- Garbage collection of superseded chunk rows, now safe for citations because of the snapshots (Phase 3 deferred list).

</deferred>

---

*Phase: 05-verified-citations-groundedness*
*Context gathered: 2026-11-24*
