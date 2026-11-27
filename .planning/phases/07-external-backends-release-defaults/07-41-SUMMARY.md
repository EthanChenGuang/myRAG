---
phase: 07-external-backends-release-defaults
plan: 41
subsystem: rag-trace-languages
tags: [lang-10, obs-03, langfuse, online-judge, calibration]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-40 (TraceLanguages, LanguageConfidenceCalibration), 07-12 (last editor of collector.ts, log.ts, rag-eval/trace.ts)"
  - phase: 05.1.1-feedback-loop
    provides: "FBK-01 language derivation (05.1.1-05) and the answer-language holder (05.1.1-07); closing plan 05.1.1-22"
  - phase: 03.2-language-support-ingestion-hardening
    provides: "chunk language (LANG-05); closing plan 03.2-68"
  - phase: 05-verified-citations-groundedness
    provides: "closing plan 05-25; 05-VERIFICATION.md status human_needed"
  - phase: 05.1-prompt-injection-defense
    provides: "closing plan 05.1-22; 05.1-VERIFICATION.md status human_needed"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "closing plan 06-45; 06-VERIFICATION.md status human_needed"
provides:
  - "TraceLanguages block on every finished trace: `[RAG Trace]` field `languages`, Langfuse root observation metadata query_language / query_language_confidence / chunk_languages / answer_language, eval RagTrace.languages"
  - "src/lib/rag/feedback-loop/log-languages.ts: logLanguageCodes, the one derivation shared by the FBK-01 row and the trace (re-exported from retrieval-log.ts)"
  - "src/lib/rag/trace/languages.ts: TraceLanguages, sanitizeTraceLanguages, traceLanguagesOf (re-exported from collector.ts)"
  - "online judge summary `by_language` (traces, n and mean per metric; und for traces without the block)"
  - "src/lib/rag/lang/confidence.ts: mappedQueryLanguageConfidence, calibratedQueryLanguageConfidence, loadLanguageConfidenceCalibration, lengthBucketOf, scriptClassOf"
  - "eval/harness/calibrate-language-confidence.mts (write, --check) and the tool-written eval/config/language-confidence-calibration.json"
affects: [07-46]

actuals:
  tasks: 3
  commits: 7  # RED, Task 1, Task 2, refactor, Task 3, fix, SUMMARY

tech-stack:
  added: []
  patterns:
    - "A derivation needed both by a lazily imported writer and by always-loaded code lives in a light module the writer re-exports, so the off state still never loads the writer"

key-files:
  created:
    - src/lib/rag/feedback-loop/log-languages.ts
    - src/lib/rag/trace/languages.ts
    - src/lib/rag/lang/confidence.ts
    - eval/harness/calibrate-language-confidence.mts
    - eval/config/language-confidence-calibration.json
    - tests/rag/trace/trace-languages.test.ts
    - tests/rag/trace/eval-trace-languages.test.ts
    - tests/rag/lang-confidence.test.ts
    - eval/tests/test_online_judge_languages.py
  modified:
    - src/lib/rag/feedback-loop/retrieval-log.ts
    - src/lib/rag/trace/collector.ts
    - src/lib/rag/trace/log.ts
    - src/lib/rag/trace/finish.ts
    - src/lib/rag/trace/langfuse.ts
    - src/lib/rag/pipeline.ts
    - src/lib/rag-eval/trace.ts
    - src/app/api/internal/rag/run/route.ts
    - eval/src/rag_eval/online_judge.py
    - tests/rag/trace-log.test.ts

key-decisions:
  - "logLanguageCodes lives in feedback-loop/log-languages.ts and retrieval-log.ts re-exports it (with queryLanguageConfidence). The plan said to export it from retrieval-log.ts and import it in the collector, but the collector is always loaded and finish-log.test asserts the retrieval-log writer module is never imported while RAG_RETRIEVAL_LOG is off. What the writer stores is unchanged."
  - "The collector holds the block (setLanguages / languages). finishTrace records it before the `[RAG Trace]` line and again inside the after-response export task, so an answer language put on the holder after finishTrace still reaches Langfuse. The bufferedCollector in pipeline.ts forwards both to its parent."
  - "Langfuse: the four fields are flat keys in the root observation metadata, which is what the online judge reads (observations API, rag-request root). A null field is dropped by Langfuse and counts as und in the judge."
  - "The answer language comes from the holder, which the chat and embed routes fill only while RAG_RETRIEVAL_LOG is on (05.1.1 D-07). With the log off, answer_language is null on production traces. No route change was made for this (outside the plan's files); 07-46 or a follow-up can set it unconditionally."
  - "Eval trace: the eval route sets the holder's answer language by the chat route's rule (cached answer language on a hit, the registry language on a model refusal, else detectLanguage of the answer, null without an answer) and then reads the collector block. RagTrace.languages is now always present on eval traces."
  - "Online judge: `by_language` is a new key next to the unchanged totals; the posted Langfuse scores are unchanged. A query_language that is not a code counts under und."
  - "Calibration inputs: eval/fixtures/golden.jsonl (the Phase 3.2 language slices), eval/fixtures/domain/golden.jsonl, eval/fixtures/ingest/golden-ingest.jsonl and eval/fixtures/lang-detect/cases.jsonl when present (Phase 6.2 is not executed, so it is absent today). src/lib/rag/lang/detect.ts and config/rag/language-packs.json are listed as inputs with their sha256 too, because they decide every result."
  - "Bins: length short <= 20, medium <= 60 characters (code points of the trimmed text); script class mixed when the text holds both Han and Latin letters. Detections with no language are left out (mapped and calibrated are both null there). Correct means detected == labelled language. detector id `heuristic`."
  - "generated_at is kept from the existing file while nothing else changes, so two runs write byte-identical files; `--check` recomputes with that timestamp and compares the whole file."
  - "calibratedQueryLanguageConfidence returns null wherever the mapped rule returns null (no language or a detected language different from the stored one), the bin value for a calibrated bin and the mapped value for a mapped_fallback bin. It is not wired in; 07-46 switches it on behind RAG_LANG_CONFIDENCE."

requirements-completed: []  # LANG-10 completes with 07-46 (alerts); OBS-03 calibration file ready

duration: ~60min
completed: 2026-11-27
---

# Phase 7 Plan 41: Trace languages, per-language judge scores and confidence calibration Summary

**Every trace now carries the query language and its confidence, the kept chunks' languages and the answer language as codes. Online judge scores are reported per query language. Query-language confidence has a reproducible, tool-written calibration.**

## Accomplishments
- `[RAG Trace]` lines, Langfuse root observations and eval RagTraces carry the LANG-10 block. It comes from the same derivation as the FBK-01 retrieval log, and a test checks that both give the same codes for one request.
- Codes only. A value that is not a LanguageCode becomes null, or `und` for a chunk. Tests check that no query, chunk or answer text reaches the log line or the exported spans.
- The online judge summary gained `by_language`.
- The calibration tool and the committed file: 7 calibrated bins and 5 mapped_fallback bins, validated by both the Zod and the Pydantic contract.

## Task Commits
1. RED: `fff2d21c` test(07-41): failing tests for the trace languages block
2. Task 1: `acf3e289` feat(07-41): languages on every trace
3. Task 2: `a069db9d` feat(07-41): eval trace languages and per-language online judge scores
4. `6d93a1e2` refactor(07-41): trace languages helpers in a light module
5. Task 3: `18d27fa8` feat(07-41): tool-written query-language confidence calibration
6. `31a91e74` fix(07-41): buffered v2 collector forwards the languages block; typed log field
7. SUMMARY (this commit)

## Behaviour changes
- The `[RAG Trace]` line has a new field `languages` (codes and one number).
- Langfuse root observation metadata has four new keys.
- Eval RagTrace has `languages`.
- The online judge's JSON summary has `by_language`.
- No response, prompt, retrieval or stored row changes. There is no switch, as the plan decided. With Langfuse off, nothing is sent, as before.

## Tests that failed before the change
- `tests/rag/trace/trace-languages.test.ts`: 4 of 5 tests failed on assertions at the RED commit (`expected undefined to deeply equal ...`, missing Langfuse metadata). The "no text" test passes either way.
- `tests/rag/trace-log.test.ts` "logs exactly one [RAG Trace] line with the fixed fields" was updated to include `languages`.
- For Task 2 and Task 3, I wrote the tests before the code and checked them against the old code. They failed on the missing exports (`evalTraceLanguages is not a function`, `by_language` import error), not on assertions, so I committed them together with the code instead of as a separate RED commit.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- Full `npx vitest run` (shared trace core changed): 735 files passed, 3 skipped; 13302 tests passed, 90 skipped, 0 failed
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all exit 0
- `node --import tsx --test tests/rag-langfuse-export.test.mts tests/rag-langfuse-review.test.mts` (langfuse.ts changed): 21 passed
- `uv run --directory eval pytest -q tests/test_online_judge_languages.py tests/test_online_judge.py tests/test_online_judge_mirror.py`: 27 passed
- `npx tsx eval/harness/calibrate-language-confidence.mts --check`: exit 0; the committed file also validates with the Pydantic LanguageConfidenceCalibration model
- `npm run gen:schemas`: no diff
- `npm run test-rag -- --out eval/out/07-41`: exit 11 on the known pre-existing failure only (`false_refusal_rate language:en: measured 0.3143 vs max 0.2500`, which also fails on main). gate.json has `paired.all_zero == true`.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/07-41-ingest`: PASS (8 skipped)
- Not run (area not touched): rag-db tests (no SQL or RPC), the workflow check, the sidecar pytest, the frontend design summary

## Deviations from Plan
- **log-languages.ts instead of a direct export from retrieval-log.ts (Rule 3, blocking).** A static import of retrieval-log.ts into the collector would load the writer in the off state, which breaks finish-log.test's `imported === 0` checks. retrieval-log.ts re-exports the helper, so the plan's "export from retrieval-log.ts" still holds.
- **src/lib/rag/trace/languages.ts (Rule 3).** run-eval.mts imports rag-eval/trace.ts under tsx. Importing collector.ts there would have pulled in deps.ts (Supabase, env), so the block helpers live in a light module.
- **Files outside files_modified:** `src/lib/rag/pipeline.ts` (bufferedCollector must implement the two new collector methods; tsc failed without it) and `src/app/api/internal/rag/run/route.ts` (the eval RagTrace is built there).
- **Tracer scope:** the test builds the v2 chat RetrievalResult directly (zh query, zh/en/undetermined kept chunks, an `it` candidate that is not kept) and runs it through finishTrace and the real fake-Langfuse OTLP server. It does not run a full chat request over the fixture corpus. The eval route path is covered by `npm run test-rag` (both modes), whose traces are validated by RagTraceSchema including `languages`.
- The plan's `npx vitest run tests/rag-eval` path does not exist. The eval-trace test is `tests/rag/trace/eval-trace-languages.test.ts`.

## Threat model
- T-07-137: the block is codes only and pattern-checked twice (in the derivation and in sanitizeTraceLanguages). Tests check that no text reaches the log line or the Langfuse spans.
- T-07-138: the calibration file records the sha256 of every input, including the detector source and registry. `--check` recomputes and fails on any difference, and a test proves that a one-byte input change makes it exit 1.
- T-07-SC: no package installed.

## Operator actions
- Live check, when Langfuse is configured on the eval project: confirm that a sampled trace shows the four metadata keys and that `python -m rag_eval.online_judge --dry-run` prints `by_language`. Not run here.

## Deferred
- Answer language on production traces while RAG_RETRIEVAL_LOG is off (see key-decisions).
- Wiring calibratedQueryLanguageConfidence behind RAG_LANG_CONFIDENCE (07-46).
- Re-run the tool after Phase 6.2 adds eval/fixtures/lang-detect/cases.jsonl. `--check` will fail until then by design, because the input list changes.
- Any edit to golden.jsonl, the domain or ingest golden files, detect.ts or language-packs.json requires re-running `npx tsx eval/harness/calibrate-language-confidence.mts` and committing the file. Merge-train note.

## Self-Check: PASSED
