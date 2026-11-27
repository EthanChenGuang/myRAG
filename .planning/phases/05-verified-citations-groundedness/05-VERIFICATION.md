---
phase: 05-verified-citations-groundedness
verified: 2026-11-27T10:48:13Z
status: human_needed
score: 6/6 success criteria verified offline (live halves of 1, 3 and 6 routed to human verification)
covered_files: [".planning/phases/05-verified-citations-groundedness/05-01-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-01-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-02-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-02-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-03-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-03-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-04-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-04-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-05-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-05-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-06-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-06-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-07-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-07-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-08-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-08-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-09-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-09-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-10-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-10-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-11-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-11-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-12-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-12-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-13-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-13-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-14-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-14-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-15-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-15-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-16-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-16-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-17-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-17-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-18-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-18-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-19-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-19-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-20-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-20-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-21-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-21-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-22-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-22-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-23-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-23-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-24-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-24-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-25-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-25-SUMMARY.md", ".planning/phases/05-verified-citations-groundedness/05-26-PLAN.md", ".planning/phases/05-verified-citations-groundedness/05-26-SUMMARY.md", "eval/config/phase5-comparison.json", "eval/reports/phase-05/comparison.json", "rag-sidecar/Dockerfile", "scripts/check-config.mjs", "src/lib/chat/badge-state.ts", "src/lib/env.ts", "src/lib/rag/generation/answer-finish.ts", "src/lib/rag/generation/citations/claude.ts", "src/lib/rag/generation/citations/marker-parser.ts", "src/lib/rag/generation/citations/record.ts", "src/lib/rag/generation/citations/session.ts", "src/lib/rag/generation/citations/strategy.ts", "src/lib/rag/generation/feedback.ts", "src/lib/rag/generation/groundedness.ts", "supabase/migrations/0501_rag_answer_records.sql"]
covered_digest: "v4:sha256:a89ec106280c7fcdfb221107e594ab5d2a4e564f5cc5269c5e6b591f98c84bb3"
behavior_unverified: 0
overrides_applied: 0
gaps: []
human_verification:
  - test: "05-26 Task 2: Vectara HHEM-2.3 with a real VECTARA_API_KEY (sidecar only), RAG_GROUNDEDNESS=true and RAG_GROUNDEDNESS_VECTARA_OPT_IN=true, single-tenant test deployment, synthetic documents: about 20 en and zh calls, about 20 source texts and one very long premise"
    expected: "p50/p95 recorded against 8000 ms; host, header, rate limits and source_texts limit confirmed; data-retention terms recorded before RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK is ever set true (it stays false)"
    why_human: "Needs a Vectara key and an operator decision on retention terms; no key exists in this environment"
  - test: "05-26 Task 2: Langfuse scores and tags (research A2, A7) with real Langfuse keys"
    expected: "groundedness NUMERIC and groundedness_label CATEGORICAL scores appear; user_feedback is overwritten when a vote changes; review_candidate and review:feedback_negative tags are merged, not replaced"
    why_human: "Needs Langfuse credentials; fixture tests only assert the request shapes"
  - test: "05-26 Task 4 step 1: apply 0501 and the mode's 0502 on the eval Supabase project first (not production ppvywaxrycaxrtrrditl without a backup and owner approval), then run the RLS SQL in 05-26-SUMMARY.md"
    expected: "relrowsecurity true, anon_select false, auth_insert false, one select policy (user_id = auth.uid()); REST GET with the anon key refused; two test users cannot read each other's rows"
    why_human: "Live database; PGlite RLS tests pass, but the hosted project was never checked"
  - test: "05-26 Task 4 step 2: Claude-strategy nightly leg (RAG_CLAUDE_CITATIONS=true, real ANTHROPIC_API_KEY) plus judge, compared with the off and chunk-alias legs"
    expected: "invalid_citation_rate 0, retrieval identical, Faithfulness within the noise band of the off leg"
    why_human: "Needs the Anthropic key on the nightly; only the 9-turn spike ran live"
  - test: "Faithfulness on the real golden set (ROADMAP live verification), and the -0.017 DeepEval Faithfulness drop seen with chunk-alias on the fixture set with a live generator"
    expected: "Rerun all legs on a real golden set (eval/golden/private/ does not exist yet); no slice beyond the noise band before citations become a default (Phase 7, ADM-02)"
    why_human: "No real golden set exists; ship decision belongs to Phase 7"
  - test: "05-26 Task 4 step 3: groundedness threshold calibration on a real labelled pair set"
    expected: "python -m rag_eval.calibrate groundedness --pairs <file> --scorer sidecar passes holdout, then --write; until then the 0.5 defaults in eval/config/groundedness-thresholds.json stay"
    why_human: "No real labelled pairs exist"
---

# Phase 5: Verified Citations & Groundedness Verification Report

**Phase Goal:** Every RAG answer cites only chunks that were actually sent to the model, its citations survive later document changes, and users can see whether the answer was checked for groundedness.
**Verified:** 2026-11-27T10:48:13Z
**Status:** human_needed
**Re-verification:** No. Initial verification (no earlier 05-VERIFICATION.md).
**Code verified:** branch `verify/05` = `origin/main` at `7651adbc` (all 26 plans merged; 05-26 Task 1 commits `0a1b8383`/`114bde4d` and the hhem config fix `a881a710` are ancestors of main).
**Mode:** fixture only. No live key was used. No Supabase project or Vercel deployment was touched.

## Goal Achievement

All six ROADMAP success criteria hold on code, unit, route, PGlite and fixture-eval evidence. The phase has 26 PLAN files and 26 SUMMARY files. 05-26 is the live-verification plan and its SUMMARY is `status: partial`. Its open items need vendor keys, the live database or a real golden set, so they are human_needed, not gaps. No code is missing or broken.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: a Claude model on an eligible turn goes to the direct Anthropic API with Citations, one plain-text document per chunk and no structured output. The OpenRouter-to-Anthropic map passes the five-location check. Tools, MCP and webSearch turns keep working or fall back | VERIFIED (offline) + live spike recorded | `src/lib/rag/generation/citations/claude.ts:70-79` builds one `file` part per block (`mediaType: 'text/plain'`, bytes, `citations: { enabled: true }`). `:82-100` sets `maxRetries: 0` and no output/format option. Tests: `claude-request.test.ts` "sends one citation-enabled plain-text document per block, in alias order, before the question" and "carries no output, format or sampling field…". `chat-claude-route.test.ts` "sends one citation document per block and streams [S<k>] markers with claude-citations records" and "an ineligible turn with RAG_CITATIONS on takes chunk-alias". `strategy.ts:54,83`: `CLAUDE_WEB_SEARCH_ELIGIBLE = false`, so webSearch turns are ineligible and use the existing path. `fallback.ts:11` has the 8 s first-token gate. Five locations: `anthropicId` is identical in `src/lib/env.ts:412-414`, `scripts/init-env.js:13`, `scripts/config-server.js:169` and the three `scripts/config-ui/index.html` arrays (18765, 18809, 18871). `node scripts/check-config.mjs` gives "ok: 257 variable(s) match the manifest", exit 0. `.env.local` is not in the repo. Live: 9/9 direct turns took `claude-citations`, and A1 holds (05-26-TASK1-RESULTS.md) |
| 2 | SC2: other models get chunk-ID markers parsed split-safe; unknown or not-sent IDs are dropped; the validated list is returned. Both paths persist the same `citations[]` with a snapshot that survives re-chunk and replace | VERIFIED | `marker-parser.ts:27,88`. `marker-parser.test.ts`: "every two-way split…", "every three-way split…", "character-by-character feeding…", "validates aliases against the request set", plus a random-split property test. `chat-citations-route.test.ts` "labels the blocks, validates the streamed markers and sends CitationRecord[] in the finish metadata". "Structured output" here means the Zod/Pydantic-validated `CitationRecord[]`, not JSON mode (05-CONTEXT.md:72, D-04). `record.ts:11` `buildCitationRecords` is shared by both strategies. Snapshot survival: `tests/rag-db/answer-records-snapshot.test.mts` "after runRechunkBatch…", "after rag_publish_document_version publishes version 2", "after rag_soft_delete_document", "after a hard DELETE of the documents rows", all pass |
| 3 | SC3: groundedness runs after the stream (fake Vectara, stub local model), stores score and status in metadata and logs, and never blocks. Vectara runs only with key and opt-in (en, zh); local HHEM-2.1-Open covers en; other languages are not checked | VERIFIED (offline) + HHEM image live-checked | `answer-finish.ts:8,329` uses `scheduleAfterResponse`, which calls `after()` (`src/lib/rag/trace/schedule.ts:13`). `answer-finish-groundedness-route.test.ts` "completes the SSE response before the sidecar is called, and the row later reads not_checked timeout". `answer-finish-groundedness.test.ts`: "inserts, scores and updates the row once…", "writes one [Groundedness] line with codes and numbers only…", "gives unsupported_language … for Traditional Chinese", "takes allow_vectara from allowVectaraFor, including the multi-tenant acknowledgement". Sidecar `rag-sidecar/tests/test_groundedness.py`: "test_en_with_vectara_allowed_uses_vectara", "…_but_no_key_uses_local", "test_zh_hans_without_vectara_allowed_is_scorer_unavailable", "test_unsupported_languages_never_call_a_scorer". The hhem image built and scored offline in 05-26 Task 3. Vectara itself is live-pending |
| 4 | SC4: three-state badge (verified / possibly unreliable / not checked), never a number, strict and balanced only | VERIFIED | `src/lib/chat/badge-state.ts:7` `SHOWN_MODES = {strict, balanced}`. Its return type is the three-label union only. `badge-state.test.ts` "the result is never a number and never contains the score". `tests/ui/answer-quality-controls.test.ts` "shows the badge and the feedback control for a recorded answer" and "labels are localized in zh and it". Frontend design SUMMARY gate: `node scripts/ci/check-frontend-design-summary.mjs .planning/phases/05-verified-citations-groundedness` gives "PASS (5 UI plan summary file(s) checked of 26)" |
| 5 | SC5: Phase 1 characterization still passes (strict "information not available", webSearch + Exa, `source_images`, `{{context}}`), and the fixture eval shows no slice drop beyond noise | VERIFIED | `tests/rag/characterize-chat.test.ts` and `tests/chat-strict.test.ts` pass in the vitest run. `chat-claude-route.test.ts` "still writes source_images and the metadata part first on the direct path". `chat-citations-route.test.ts` "with RAG_CITATIONS=false sends the same system prompt as a request without capabilities". I re-ran `uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase5-comparison.json --out <scratch>/phase-05`: **PASS**, exit 0. off-prechunked and off-ingest pass `paired_all_zero` and `characterization`. on-prechunked and on-ingest pass `retrieval_unchanged`, `no_slice_drop`, `citation_validity` (invalid_citation_rate 0.0000) and `strict_refusal`. Citation coverage is 0.8554 and 0.8671 |
| 6 | SC6: any RAG answer can be voted helpful / not helpful; the vote is stored, sent to Langfuse as a score, and not-helpful votes and possibly-unreliable results enter the review queue | VERIFIED (offline) | `src/lib/rag/generation/feedback.ts:42` `SCORE_NAME = 'user_feedback'`. `feedback.test.ts`: "stores a helpful vote … then lets a later not_helpful vote replace it", "writes the vote before any Langfuse call…", "posts user_feedback 1 or 0 on the traceId…", "appends feedback_negative once…", "a possibly_unreliable label appends groundedness_flagged once…". `tests/api/review-candidates.test.ts` covers the admin guard, tenant scoping and masking. `eval/tests/test_review_queue.py` passes (`--source db`). Real Langfuse behaviour (A2, A7) is live-pending |

**Score:** 6/6 criteria verified offline. 0 present but behaviour-unverified. 0 failed. The live halves of SC1 (Claude nightly leg), SC3 (Vectara) and SC6 (Langfuse) are routed to Human Verification.

### Required Artifacts (spot-checked)

| Artifact | Status |
|----------|--------|
| `src/lib/rag/generation/citations/` (blocks, claude, claude-transform, fallback, instructions, marker-parser, models, record, session, strategy, transforms; 1189 lines) | present, wired from `src/app/api/chat/route.ts` (`scheduleAnswerFinish` at 2451 and 4360) |
| `supabase/migrations/0501_rag_answer_records.sql`, `0502_*.{single,multi}-tenant.sql` | present; folded into both setup files (`multi-tenant-setup.sql:18821`) |
| `src/app/api/rag/answers/route.ts`, `[answerId]/route.ts`, `[answerId]/feedback/route.ts`, admin review-candidates | present, tested |
| `rag-sidecar` `/v1/groundedness` router and `hhem` Docker target | present; hhem stage copies `config/` (`a881a710`, `test_image_config.py[hhem]`) |
| `src/lib/chat/badge-state.ts`, `src/components/ui/groundedness-badge.tsx` | present |
| `eval/config/phase5-comparison.json`, `eval/reports/phase-05/comparison.json` | present, PASS |

### Security checks

| Check | Result |
|-------|--------|
| `rag_answer_records` RLS | `0501:38` enables RLS. `:40` revokes all from PUBLIC, anon and authenticated. `:41` grants SELECT to authenticated only. `:45-47` adds the select-own policy `user_id = auth.uid()`. Writes are service_role only. `tests/rag-db/answer-records-rls.test.mts` passes in both modes |
| Logs carry no text | "writes one [Groundedness] line with codes and numbers only…" and `test_router_never_logs_request_text` pass |
| Vectara multi-tenant gate | `allowVectaraFor` requires `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK`, which defaults to false (`src/lib/env.ts`) |
| Defaults off | `src/lib/env.ts:234-242`: `RAG_CITATIONS`, `RAG_CLAUDE_CITATIONS`, `RAG_GROUNDEDNESS` and `RAG_ANSWER_FEEDBACK` default to `'false'`. The off runs of the comparison pass `paired_all_zero` |

### Behavioral Spot-Checks (commands I ran)

| Command | Result |
|---------|--------|
| `npx vitest run <48 Phase 5 *.test.ts files named in the SUMMARYs>` | 48 files, 1262 passed, 1 skipped, 0 failed |
| `node --import tsx --test <10 Phase 5 *.test.mts files>` | first run 131/137 pass. The 5 failures and 1 parent failure were all `tests/rag-db/ingest-mode-routing.test.mts`, caused by the environment: empty tiktoken cache, then missing `docling_core` in the venv. After `python3 scripts/ci/fill-tiktoken-cache.py` and the CI venv sync (`uv sync --directory rag-sidecar --locked --extra chunking --extra preflight`), that file passed 13/13. The 05-06, 05-13, 05-15 and 05-20 SUMMARYs record the same cold-cache failure. That file is Phase 3.1 ingestion code |
| `cd rag-sidecar && uv run pytest -q <8 Phase 5 test files>` | 258 passed, 1 skipped |
| `cd eval && uv run pytest -q <7 Phase 5 test files>` | 287 passed, 5 skipped |
| `phase_compare --spec eval/config/phase5-comparison.json` | PASS (4/4 runs) |
| `check-config`, `check-rag-boundary`, `check-language-literals`, `check-settings-classification` | all exit 0 |
| `check-frontend-design-summary.mjs` (phase 05) | PASS |

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| GEN-01 | SATISFIED (offline); live spike done, Claude nightly leg pending | SC1 |
| GEN-02 | SATISFIED | SC2 |
| GEN-03 | SATISFIED | SC2 snapshot tests; record shared by both strategies |
| GEN-04 | SATISFIED | no output option on the Claude call (`claude.ts:82-100`, test "carries no output, format or sampling field"); the alias list is a validated schema record |
| GEN-05 | SATISFIED (offline); Vectara live pending | SC3 |
| GEN-06 | SATISFIED | SC3 storage and logs, SC4 badge, answers never blocked (`after()`) |
| GEN-07 | SATISFIED | SC5 characterization and `paired_all_zero` |
| EVAL-16 | SATISFIED (offline); Langfuse live pending | SC6 |

REQUIREMENTS.md still lists these as Pending. Updating the traceability table is left to the phase-completion step.

### Notes (not gaps)

- The committed `eval/reports/phase-05/comparison.json` shows lower absolute numbers (off-prechunked Recall@5 0.5116) than my re-run (0.6709). The fixture corpus and baselines changed in later phases. Every check passes against today's committed baselines. Regenerating the report is optional.
- 05-26 opened two follow-ups that do not block any Phase 5 criterion. (1) webSearch turns on the direct Claude path: SC1 allows the fallback, and `CLAUDE_WEB_SEARCH_ELIGIBLE` stays false. (2) Ragas judge output truncation (`IncompleteOutputException` with `gpt-5-mini`) in `eval/src/rag_eval/judge/ragas_judge.py`. It affects only the live judge tier.
- HHEM host sizing: about 1.7 GB RSS at the 3000-token cap, and the 5 s p95 needs about 4 vCPU. This goes to the Phase 7 defaults work.
- `badge-state.ts` shows the badge when `ragMode` is null (shared-chat metadata). This is intended (`badge-state.test.ts` "an unknown ragMode … follows the reason rules"), and records exist only for RAG answers.

### Human Verification Required

See `human_verification` in the frontmatter. There are six items: Vectara, Langfuse, live `rag_answer_records` RLS on the eval project, the Claude-strategy nightly leg, Faithfulness on the real golden set, and groundedness calibration on real pairs.

### Gaps Summary

None. Status is `human_needed` because the live checks above need an operator and vendor keys.
