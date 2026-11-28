---
phase: 05-verified-citations-groundedness
plan: 22
subsystem: eval
tags: [citations, groundedness, eval, harness, fixtures, gate]

requires:
  - phase: 05-verified-citations-groundedness
    provides: "RagRunOptions.citations/groundedness and the RagTrace citation fields (05-07); session.ts, strategy selection and the Claude path (05-08, 05-16); scoreAnswerGroundedness (05-18)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "last eval route edit (04-21) and last run-eval/run-smoke edit (04-35)"
provides:
  - "CitationSession.ingestFullText(text): one parse over a non-streamed chunk-alias answer, same records as the stream transform"
  - "Eval route: options.citations (with include_answer) labels blocks, decorates the prompt, returns CitationRecord[], citation_strategy and invalid_citations; the direct Claude path runs only with RAG_CLAUDE_CITATIONS, a key and a mapped model, with one chunk-alias fallback"
  - "Eval route: options.groundedness scores the answer through scoreAnswerGroundedness and returns trace.groundedness"
  - "src/lib/rag-eval/answer.ts: resolveEvalPromptTemplate, decorateSystemPrompt input on generateEvalAnswer, setEvalGroundednessRequest seam"
  - "eval/harness/fake-citation-generator.mts (installFakeCitationGenerator, fakeCitationAnswer, splitForStreaming)"
  - "eval/harness/fake-groundedness.mts (startFakeGroundedness)"
  - "--citations and --groundedness on run-smoke, run-eval (RunEvalOptions) and run-nightly; EvalGenerator 'fake'"
  - "Gate scope ignores the answer-only options generator_model, citations and groundedness"
  - "detectLanguage exported from @/lib/rag"
affects: [05-24, 05-25, 05-26]

actuals:
  tasks: 2
  commits: 8

tech-stack:
  added: []
  patterns:
    - "Harness seams in src/lib/rag-eval/answer.ts take functions (model factory, groundedness request); the fakes live under eval/harness and src/ never imports them"
    - "Fixture groundedness goes through the real groundedness client over HTTP to a node:http fake that keeps the shared-secret check"

key-files:
  created:
    - eval/harness/fake-citation-generator.mts
    - eval/harness/fake-groundedness.mts
    - tests/rag/eval-route-citations.test.ts
    - tests/rag/eval-fake-generator.test.ts
  modified:
    - src/lib/rag/generation/citations/session.ts
    - src/app/api/internal/rag/run/route.ts
    - src/lib/rag-eval/answer.ts
    - src/lib/rag/index.ts
    - eval/harness/run-eval.mts
    - eval/harness/run-smoke.mts
    - eval/harness/run-nightly.mts
    - eval/src/rag_eval/gate.py
    - eval/tests/test_gate.py

requirements-completed: []
requirements-advanced: [GEN-02, GEN-05, GEN-07]

duration: ~2.5h
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 22: Citations and groundedness in the eval

**An eval run can now ask for citations and groundedness. With `options.citations` and `include_answer`, the internal eval endpoint labels the context blocks, adds the citation instruction to the prompt, parses the answer with the same marker parser as chat, and returns validated `CitationRecord[]` with `citation_strategy` and `invalid_citations`. With `options.groundedness` it scores the answer through `scoreAnswerGroundedness`. Without either option the trace is unchanged. `npm run test-rag -- --citations --groundedness` runs on the fixture corpus with no live key: a deterministic fake generator answers, a fake sidecar scores, and the retrieval gate passes with every paired difference zero.**

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. Eval endpoint citations and groundedness (D-05, D-22, D-24) | `b8f81df`: 5 of 9 cases failed on assertions (no `[S1]` in the context, no sidecar call, `ingestFullText` not a function) | `c78f686` |
| 2. Fixture fakes and harness flags (D-24) | `33a74b5`: 10 of 10 cases failed against skeleton fakes | `3f7e318` |
| 2b. Gate scope (deviation 1) | `38d556f`: 3 gate tests failed on the old scope | `64df0d6` |
| Boundary fix (deviation 2) | — | `cd0b921` |

## Behaviour

- **Eval route, citations.** Only with `options.citations` *and* `include_answer`. The run counts as having the citations capability, and the session is built with `citations: true` whatever `RAG_CITATIONS` says. The labeler is passed to `runRetrieval`; the answer is parsed with `ingestFullText`. The trace carries the full records (quote = the whole block text on chunk-alias), `citation_strategy` and `invalid_citations`. `citations: []` is no longer a literal in the route.
- **Claude in the eval.** The session gets eval facts (no MCP, no multi-step, no webSearch, no reasoning, no attachments), so `claude-citations` is chosen only with `RAG_CLAUDE_CITATIONS=true`, `ANTHROPIC_API_KEY` and a model with `anthropicId`. A failure or an empty answer from the direct call falls back once to the OpenRouter path with chunk-alias. The fixture tier never sets the switch or a key.
- **Eval route, groundedness.** Only with `options.groundedness` and an answer request. Eligibility uses the run's `ragMode`, the retrieval status, the non-image blocks and whether the answer was refused. The premise is the blocks sent to the model. Requests go to `RAG_SIDECAR_URL` unless the harness installed a request function. Without a sidecar the result is `not_checked`, `scorer_unavailable`.
- **Unchanged without the options.** No labeler, no prompt change, no sidecar call, `citations` empty, and no new trace fields. Candidates, kept chunks and used documents are identical with and without `options.citations`; only the context string gains labels (test).
- **Fake generator.** `installFakeCitationGenerator(seed)` returns a factory for `setEvalLanguageModelFactory`. The answer depends only on the system prompt, the question and the seed. It cites one or two labelled blocks, quoting the first content sentence of each block. About one question in five also gets `[S99]`. Streaming cuts every marker across chunks. On the fixture corpus: 75 of 77 answered items cite, and 14 invalid markers were dropped.
- **Fake sidecar.** `startFakeGroundedness()` serves `POST /v1/groundedness`. It answers 401 without the shared secret and 422 for a body that fails the contract. `en` is scored as `hhem_2_1_open` from token overlap. `zh-Hans` is scored as `hhem_2_3_vectara` only with `allow_vectara`; otherwise it is `scorer_unavailable`, as in the real router. Every other language is `unsupported_language`. Fixture run: 19 verified, 24 `scorer_unavailable` (zh), 32 `unsupported_language`, 71 `not_eligible` (refused).
- **Harness flags.** Either flag implies `include_answer`. In-process runs use the `fake` generator unless `live` is asked for (nightly). `--base-url` runs pass the options through and the server generates. The manifest records `citations` and `groundedness` only when they are set, so runs without the flags hash as before.

## Deviations

1. **Gate scope (Rule 3, blocking the plan's own check).** `rag_eval.gate` treated any `request_options` difference except `max_results` and `degrade` as a data mismatch, so `--citations --groundedness` (which sets `generator_model`, `citations` and `groundedness`) could never be compared with the baseline, and `jq '.passed'` failed. Every gated metric (recall@5/10, MRR, correct and false refusal) is decided before generation. The scope now also excludes `generator_model`, `citations` and `groundedness`. The existing assertion that a different `generator_model` is a mismatch was changed to pass. A new test shows these options are judged by metrics: a regression still fails, and an `organization_id` change is still a mismatch. The mismatch label names the excluded fields.
2. **Boundary.** The route first deep-imported `@/lib/rag/lang/detect`. `check-rag-boundary` rejects that, so `detectLanguage` is now exported from `@/lib/rag` (`src/lib/rag/index.ts`, not in the plan's file list).
3. **Sidecar target in the harness.** The plan says to point `RAG_SIDECAR_URL` and `RAG_SIDECAR_SECRET` at the fake. `@/lib/env` snapshots those values at first import, and ingest mode imports it before the eval session. So the harness installs a request function instead, through `setEvalGroundednessRequest`. It calls the real `requestGroundedness` with the fake's URL and secret. The real client, the secret header and the contract are still exercised.
4. **Eval Claude path without the first-token gate.** The eval uses `await stream.result.text` and falls back on an error or an empty answer. It does not use the chat route's 8 s `firstTokenGate`; a hung call is bounded by the harness's 120 s request timeout. The fallback reason is logged (`[RAG Eval]`) but is not written to the trace.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 296 files, 4703 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 172 passed. The first run had 3 failures in the sidecar module launcher (tiktoken cache not yet filled; known environment issue). They passed after `scripts/ci/fill-tiktoken-cache.py`. |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1457 passed |
| `check-rag-boundary` + node test | ok (after `cd0b921`), 38 passed |
| `node scripts/check-config.mjs` | pass |
| `check-workflows.py` | pass |
| rag-sidecar pytest | 1393 passed, 11 skipped |
| eval pytest | 736 passed |
| `npm run gen:schemas` | no diff (contracts untouched) |
| `npm run test-rag -- --out eval/out/05-22` | gate PASS, paired all_zero |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/05-22-ingest` | gate PASS, paired all_zero |
| `npm run test-rag -- --citations --groundedness --out eval/out/p5-22` | gate PASS, paired all_zero |
| `grep -rlE "fake-citation-generator\|fake-groundedness" src` | 0 |

## Decisions for STATE

- The eval answers citations only when `include_answer` is set; `options.citations` alone changes nothing.
- The gate's comparability scope excludes answer-only options (`generator_model`, `citations`, `groundedness`), because the gated metrics are decided before generation.
- Fixture groundedness goes through a request-function seam, not the env snapshot.

## Operator actions

- None for fixtures. The nightly `--citations` comparison of Faithfulness per strategy with the live generator, and a Claude strategy run (`RAG_CLAUDE_CITATIONS=true` plus a key), are live verification items (05-26).

## Deferred

- The metrics `invalid_citation_rate`, `citation_coverage` and `cited_gold_hit`, and the groundedness label counts in the report, belong to plan 05-24.
- Recording `citation_strategy_fallback` on the eval trace, and the first-token gate on the eval Claude path.
