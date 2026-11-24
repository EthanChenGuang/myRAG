# Phase 5 Plan Index

26 plans in 8 waves. Plans in the same wave share no file in `files_modified`, every file touched by two plans is ordered by a `depends_on` path, and the dependency graph is acyclic (checked by script, see "Validation run"). Every plan runs after Phase 4 and Phase 3.1 are complete; each plan's `depends_on` also names the Phase 3, 3.1 and 4 plans whose outputs it extends (for example 04-27 for the v2 context stage, 03-05 for the multi-stage sidecar Dockerfile and torch index, 03.1-39 for `rag_soft_delete_document`), and those cross-phase ids do not affect wave numbers. The phase tracer is 05-08 Task 1 (web-chat request with the citations capability, through the 05-04 blocks and labeler, the labelled prompt, the real `streamText` with the 05-03 parser transform, to a validated CitationRecord list in the finish metadata). Human checkpoints: 05-05 Task 1 (package legitimacy, blocking-human, before any install), 05-10 Task 1 (which Claude models get an anthropicId, blocking-human decision) and 05-26 (four live-service checks); everything else is automated (see `05-VALIDATION.md`).

Execution note: plans that build PGlite databases (05-04 and 05-06 in wave 1, 05-09 in wave 2, 05-25 in wave 7) must not run at the same time in one working tree (`workflow.use_worktrees` is false); in wave 1 run 05-04 to completion before 05-06. Both plans carry the note.

Migrations: 0501 rag_answer_records (common: table, constraints, indexes, RLS, grants) and 0502 per mode (generated tenant_key), both in 05-06; folded into both setup files by 05-25.

## Waves

| Wave | Plans | Theme |
|------|-------|-------|
| 1 | 05-01, 05-02, 05-03, 05-04, 05-05, 05-06 | New Pydantic contracts with generated Zod and the default thresholds file; ten env switches, check-config ANTHROPIC_ tracking, call-time config reader; shared marker grammar and split-safe parser; context blocks and the labeler hook (legacy, v2, refs); package checkpoint and installs (autonomous: false); rag_answer_records migration and RLS |
| 2 | 05-07, 05-08, 05-09, 05-10 | Existing-contract changes (TraceCitation to CitationRecord, run options, review reasons, budgets, scorers, report fields); TRACER: alias citations end to end; answer-record store, read routes and snapshot survival; anthropicId decision and five-location mapping (autonomous: false) |
| 3 | 05-11, 05-12, 05-13, 05-14 | Claude Citations module on the real provider with recorded-shape SSE; sidecar /v1/groundedness with Vectara and local HHEM; answerId and post-stream record insert; groundedness eligibility, premise, language, Vectara gate, labels and sidecar client |
| 4 | 05-15, 05-16, 05-17, 05-18, 05-19 | Client metadata persistence and polling; Claude eligibility, first-token gate and route wiring; hhem Docker target and bake; post-stream scoring, log, span and Langfuse scores; groundedness calibration tool and pairs |
| 5 | 05-20, 05-21, 05-22 | Citation chips and sources-panel snapshots; feedback route, review export, admin review route and `--source db`; eval endpoint citations and groundedness with fixture fakes |
| 6 | 05-23, 05-24 | Badge and feedback UI; eval citation metrics, strategy slices and report-only groundedness budgets |
| 7 | 05-25 | Fold migrations, D-25 comparison, AGENTS.md, full gates |
| 8 | 05-26 | Live verification checkpoints (autonomous: false) |

## D-26 rollout order

| Step | Plans |
|------|-------|
| 1 contracts and gen:schemas | 05-01, 05-07 (and the switches in 05-02) |
| 2 alias map, block labelling, marker parser | 05-03, 05-04, 05-08 |
| 3 rag_answer_records migration, RLS and routes | 05-06, 05-09, then the record writer 05-13 |
| 4 message-metadata persistence | 05-15 |
| 5 citation chips and sources panel | 05-20 |
| 6 anthropicId in five locations | 05-10 |
| 7 @ai-sdk/anthropic and the Claude strategy | 05-05 (install), 05-11, 05-16 |
| 8 sidecar endpoint, Vectara client, hhem target | 05-05 (extra), 05-12, 05-17 |
| 9 post-stream scheduling, read endpoint, badge | 05-13, 05-14, 05-18, 05-23 |
| 10 feedback, Langfuse scores, review reasons | 05-18 (scores client), 05-21, 05-23 |
| 11 groundedness calibration | 05-19 |
| 12 eval metrics and final comparison | 05-22, 05-24, 05-25 |

Deviations from the literal order, all from interface-first dependencies: the package checkpoint (steps 7 and 8) is wave 1 so the one pause happens before dependent plans start; the answerId and record writer (05-13, part of step 9) come before step 4 because the client polls by answerId; calibration (step 11) runs in wave 4 because it only needs the contracts and the sidecar contract.

## Requirement coverage

| Requirement | Plans |
|-------------|-------|
| GEN-01 | 05-02, 05-05, 05-10, 05-11, 05-16, 05-25, 05-26 |
| GEN-02 | 05-01, 05-03, 05-04, 05-07, 05-08, 05-20, 05-22, 05-24, 05-25 |
| GEN-03 | 05-01, 05-04, 05-06, 05-07, 05-09, 05-13, 05-15, 05-20, 05-25 |
| GEN-04 | 05-01, 05-03, 05-08, 05-11, 05-16, 05-25 |
| GEN-05 | 05-01, 05-02, 05-05, 05-07, 05-12, 05-14, 05-17, 05-18, 05-19, 05-22, 05-24, 05-25, 05-26 |
| GEN-06 | 05-06, 05-09, 05-13, 05-14, 05-15, 05-18, 05-19, 05-23, 05-25, 05-26 |
| GEN-07 | 05-02, 05-04, 05-08, 05-13, 05-16, 05-22, 05-24, 05-25, 05-26 |
| EVAL-16 | 05-01, 05-02, 05-06, 05-07, 05-09, 05-13, 05-15, 05-21, 05-23, 05-25 |

## Decision coverage (05-CONTEXT.md)

| Decision | Implemented in | Decision | Implemented in |
|----------|----------------|----------|----------------|
| D-01 | 05-01, 05-08, 05-11, 05-16 | D-14 | 05-13, 05-14, 05-18, 05-23 |
| D-02 | 05-04, 05-08 | D-15 | 05-01, 05-09, 05-13, 05-15, 05-18 |
| D-03 | 05-01, 05-06, 05-09, 05-15, 05-20 | D-16 | 05-06, 05-09, 05-13, 05-25 |
| D-04 | 05-03, 05-08, 05-20 | D-17 | 05-09, 05-21 |
| D-05 | 05-07, 05-08, 05-13, 05-15, 05-22 | D-18 | 05-01, 05-21, 05-23 |
| D-06 | 05-02, 05-08, 05-13, 05-16, 05-20 | D-19 | 05-07, 05-21 |
| D-07 | 05-03, 05-04 | D-20 | 05-20, 05-23 |
| D-08 | 05-10, 05-25, 05-26 | D-21 | 05-02, 05-12, 05-14, 05-25 |
| D-09 | 05-05, 05-11, 05-16 | D-22 | 05-01, 05-07, 05-22 |
| D-10 | 05-11, 05-16 | D-23 | 05-07, 05-24 |
| D-11 | 05-01, 05-12, 05-14 | D-24 | 05-11, 05-12, 05-19, 05-22, 05-24 |
| D-12 | 05-05, 05-07, 05-12, 05-17 | D-25 | 05-08 (e), 05-22, 05-25, 05-26 |
| D-13 | 05-01, 05-14, 05-18, 05-19 | D-26 | rollout order across all plans (each objective names its step) |

Deferred ideas (embed-widget citations, webSearch citations on the Claude path, an LLM-judge fallback for unsupported languages, per-tenant Vectara opt-in, treating zero-citation strict answers as unsupported, sentence highlighting and click-through, blocking on groundedness, chunk-row garbage collection) appear in no plan. The Config UI review-queue screen and shipped defaults stay in Phase 7.

## ROADMAP success criteria

| # | Shown by |
|---|----------|
| 1 | 05-11 (request shape and recorded-shape streams on the real provider), 05-16 (eligibility, tools, MCP and webSearch on the existing path, one fallback), 05-10 (five-location model check); 05-26 Task 1 live |
| 2 | 05-03 (split at every boundary), 05-08 (unknown and not-sent ids dropped, validated list in finish metadata), 05-09 Task 3 (snapshots after re-chunk, replace, soft and hard delete), 05-15 (persisted with the message) |
| 3 | 05-12 (fake Vectara, stub local model, routing), 05-14 and 05-18 (after the stream, stored, logged, never blocking); 05-26 Tasks 2 and 3 live |
| 4 | 05-23 (three-state badge, no number, strict and balanced only) |
| 5 | 05-08 Task 2 and 05-16 Task 3 (characterization, strict refusal, webSearch, source_images, {{context}} byte-identical), 05-25 Task 2 (no slice beyond the noise band, retrieval paired differences zero) |
| 6 | 05-21 (stored, Langfuse score, review queue for negative votes and unreliable results), 05-23 (control) |
| Live | 05-26 |

## Research open questions, resolved as recommended

1. Which Claude models get an anthropicId: blocking decision 05-10 Task 1, recommending the 5.5 family and leaving the 4.5 and 4.1 entries unmapped.
2. Referenced documents on the Claude path: one block and alias per referenced section (05-04 Task 2), so every Claude document has citations enabled.
3. Traditional versus Simplified Chinese: committed script heuristic, no new package (05-14 Task 1).
4. RagTrace.schema_version: stays 1; committed traces hold empty citation lists (05-07; bump only if a committed trace is non-empty).
5. Aborted streams: record inserted with groundedness not_checked reason aborted and the citations validated so far (05-13).
6. hhem image sizing: about 2 GB documented in AGENTS.md (05-25), confirmed live (05-26 Task 3).

Assumptions A1 to A8 each have a closing step: A1 (citations with tools) and A6 (OpenRouter ids) in 05-26 Task 1 and 05-10 Task 1; A2 (tag merging) and A7 (categorical scores) in 05-26 Task 2; A3 and A8 (memory) and A4 (sentencepiece) in 05-26 Task 3 and 05-17; A5 (8 s first-token timeout) in 05-16 with the live TTFT record in 05-26 Task 1.

## Planner resolutions (not covered verbatim by CONTEXT)

- rag_answer_records.chat_id is nullable. The web client creates a new chat's row only after the first answer finishes (src/app/page.tsx debouncedSave then safeCreateChat), so the server cannot link the first answer at insert time. 05-13 links only when the session user owns the chat and the organization matches; 05-09 attaches unlinked records when the owner's chat row lists the answerId (GET ?chatId=), and 05-21 does the same on feedback. The foreign key and ON DELETE CASCADE of D-16 are kept.
- The web client now sends chatId (and the ghost- id in incognito mode) with capabilities, because the route needs it for D-05 and D-16; WhatsApp, voice and embed bodies are unchanged.
- chunk-alias on ineligible turns requires RAG_CITATIONS; with only RAG_CLAUDE_CITATIONS on, ineligible turns take today's path. The pre-first-token fallback always uses chunk-alias, as D-10 states.
- Reasoning on the direct path sends thinking {type: adaptive} only. Effort lives in output_config, which D-09 forbids on the citation call; models that only support budget thinking make reasoning turns ineligible (05-11, 05-16).
- webSearch turns stay ineligible for the direct path in this phase. The fixture with a tool call proves the plumbing; D-10 opens them only after real coexistence is recorded (05-26 Task 1, then a gap plan).
- 404 (retired model) and a refusal with no text are fallback reasons next to D-10's list (research Pattern 5).
- Refusal and knowledge-base-unavailable responses are produced before streamText and carry no answerId, so they get no record, badge or feedback control (CONTEXT code_context: citation and groundedness code never sees them).
- AnswerRecord carries feedbackEnabled (read-time value of RAG_ANSWER_FEEDBACK), because the client cannot read the server switch; the control appears only once a record was read (research P-4).
- The UI has no Italian locale today, so the Phase 5 strings live in src/translations/answer-quality.ts keyed by language code with en fallback (D-20 "in src/translations").
- RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS defaults to 3000 cl100k tokens and the first-token timeout to 8 s (research P-10, A3, A5).
- CitationRecord.strategy uses the D-01 values claude-citations and chunk-alias, and labels use the D-13 values verified, possibly_unreliable and not_checked; 05-PATTERNS.md suggested other spellings, CONTEXT wins.
- The groundedness span and scores are posted when the request trace was sampled or the label is possibly_unreliable; the review copy for D-19 reasons is exported regardless of the sample rate.

## Validation run (this revision)

- `gsd-tools frontmatter validate --schema plan`: valid for all 26 plans.
- `gsd-tools verify plan-structure`: valid for all 26 plans, 0 errors; 2 warnings (05-06 Task 1 and 05-25 Task 1 carry `one-way` reversibility without a checkpoint:decision). D-16 settles the table as one-way in CONTEXT, so no checkpoint is added (the Phase 4 precedent).
- `gsd-tools check decision-coverage-plan`: passed, 52 of 52 trackable entries covered (D-01 to D-26).
- Wave and overlap script: every plan's wave equals one more than its highest in-phase dependency; no same-wave file overlap; every file shared by two plans is ordered by a depends_on path (shared files: the five config files 05-02 then 05-10; contract outputs 05-01 then 05-07; route.ts 05-08, 05-13, 05-16; index.ts 05-08, 05-13, 05-18, 05-21; session.ts 05-08, 05-16, 05-22; answer-finish.ts 05-13, 05-18, 05-21; groundedness.ts 05-14, 05-18; chat-message.tsx and answer-quality.ts 05-20 then 05-23); no cycle; at most 15 files and 4 tasks per plan.
- Comment-text discipline: no literal of a negative grep gate appears in any action body.
- Acceptance greps were measured against the working tree at HEAD 768653f and recorded as [HEAD=... EXPECT...]; gates that already passed at HEAD are either rewritten (05-05 transformers pin, now on the new hhem extra; 05-08 prompt guard, now a content check) or marked GUARD.
- Threat ids: T-05-01 to T-05-82, plus T-05-SC in every plan.
