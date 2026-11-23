---
phase: 01-evaluation-harness-baseline
plan: 04
subsystem: testing
tags: [rag-eval, next-route, pglite, zod, timingSafeEqual, jsonl-trace]

requires:
  - phase: 01-02
    provides: "PGlite fixture database, 127.0.0.1 fake edge, fixtureProcessEnv"
  - phase: 01-03
    provides: "Generated GoldenItemSchema, RagRunRequestSchema, RagTraceSchema"
provides:
  - "POST /api/internal/rag/run: authenticated eval route running today's unmodified enhancedRetrieveChunks plus a replica of the chat route's post-retrieval logic, returning a schema-valid RagTrace"
  - "checkEvalAccess: 404/503/401 matrix with SHA-256 + timingSafeEqual and a production gate"
  - "applyLegacyPostFilter / legacyQueryTerms: pure replica of Filter 1, context assembly, Filter 2 and the strict refusal decision, known quirks included"
  - "buildEffectiveConfig / canonicalJson / configHash / ENDPOINT_VERSION"
  - "runEval / prepareInProcessEval and the run-smoke CLI behind npm run test-rag (exit 0 or 3)"
  - "Tracer golden item en-general-001 and the first trace over it"
affects: [01-09, 01-10, 01-11, 01-17, baseline runs, characterization tests]

plan_head_before: 5c3d4f77d5d0289f87f18fbd1443e246e56592e5
plan_head_after: 6273a9cf4884c8bbe9cfb3393971e361f1c93cd7

actuals:
  tokens: 6600
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Eval route reads secrets through env.ts and gates on checkEvalAccess before the body is read"
    - "Harness imports the route dynamically only after RAG_* are cleared and fixtureProcessEnv is applied; route console output is redirected to harness.log"
    - "Post-filter replica takes pre-fetched Supabase lookups as plain maps so it stays pure and synchronous"

key-files:
  created:
    - src/lib/rag-eval/auth.ts
    - src/lib/rag-eval/legacy-post-filter.ts
    - src/lib/rag-eval/trace.ts
    - src/app/api/internal/rag/run/route.ts
    - eval/harness/run-eval.mts
    - eval/harness/run-smoke.mts
    - eval/fixtures/golden.jsonl
  modified:
    - src/lib/env.ts
    - package.json

key-decisions:
  - "Trace `kept` is the list of chunks that enter the context (chunks whose document survived Filter 1), matching the chat route; a chunk that did not pass Filter 1 itself inherits the kept_by reason that admitted its document"
  - "The route does one document_chunks metadata lookup per candidate and feeds it to both the image-url merge and the URL collection, instead of the chat route's two separate lookups; the replica output is identical because both read the same row"
  - "trace.ts reads process.env directly instead of env.ts so it loads outside Next without the OPENAI_API_KEY requirement"
  - "RAG_FINAL_RESULT_COUNT is read through a Record cast because it is not an envVars key; it is undefined today, as in the chat route (D-25)"

patterns-established:
  - "isGPTModel is false when no generator is configured (generator_model null in the trace)"
  - "Single-tenant ignores options.organization_id, as the chat route does"

requirements-completed: [EVAL-06, EVAL-11]

coverage:
  - id: D1
    description: "npm run test-rag posts the tracer item in-process with the correct secret and writes a RagTrace whose kept list contains a refund-policy.en.md chunk, from unmodified retrieval over PGlite loaded from supabase/single-tenant-setup.sql"
    requirement: EVAL-06
    verification:
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/tracer, then node check: one line, item_id en-general-001, refused false, kept contains refund-policy.en.md"
        status: pass
    human_judgment: false
  - id: D2
    description: "checkEvalAccess returns 404 (production, not enabled), 503 (secret empty or under 32 chars), 401 (missing or wrong header) and ok for the right secret; the route calls it before reading the body"
    requirement: EVAL-06
    verification:
      - kind: unit
        ref: "Task 1 inline node check (exit 0) and scratch in-process route probe: missing secret 401 on an unparseable body, wrong secret 401, valid secret with empty query 400"
        status: pass
    human_judgment: false
  - id: D3
    description: "Traces parse with RagTraceSchema before being written and golden lines with GoldenItemSchema"
    requirement: EVAL-06
    verification:
      - kind: integration
        ref: "run-eval.mts RagTraceSchema.parse before appendFileSync and GoldenItemSchema.safeParse per line; test-rag run passes"
        status: pass
    human_judgment: false
  - id: D4
    description: "The harness exits 3 when the fake edge recorded any unsupported or failed request"
    requirement: EVAL-06
    verification:
      - kind: other
        ref: "run-eval.mts throws on edge.errors.length > 0 and run-smoke.mts maps every error to exit 3 (code path; no failing-edge test in this plan, covered by plan 01-09)"
        status: partial
    human_judgment: false
  - id: D5
    description: "No effective_config value contains the value of a SECRET/KEY/TOKEN/PASSWORD variable; prompts appear only as SHA-256 digests"
    requirement: EVAL-06
    verification:
      - kind: unit
        ref: "Task 1 inline check: RAG_EVAL_SECRET and RAG_TEST_TOKEN values absent from buildEffectiveConfig output"
        status: pass
    human_judgment: false
  - id: D6
    description: "applyLegacyPostFilter reproduces Filter 1, context assembly, Filter 2 and strict refusal, including the empty term for the Chinese query"
    requirement: EVAL-06
    verification:
      - kind: unit
        ref: "legacyQueryTerms('年度订阅可以在多少天内退款？') includes '' (Task 1 inline check); line-for-line port reviewed against chat route L2165-2580; unit tests locked by plan 01-17"
        status: partial
    human_judgment: false
  - id: D7
    description: "Production retrieval and generation code and supabase/*.sql stay byte-identical to 325a2c9"
    requirement: EVAL-06
    verification:
      - kind: other
        ref: "git diff --quiet 325a2c9 -- src/app/api/chat/route.ts src/lib/enhanced-rag-retrieval.ts src/lib/document-processor.ts src/lib/supabase.ts src/lib/thinking-rag-enhancer.ts supabase/ exits 0"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 04: Eval Route and test-rag Tracer Summary

**An authenticated `POST /api/internal/rag/run` runs today's unmodified `enhancedRetrieveChunks` and a line-for-line replica of the chat route's post-filter over PGlite, and `npm run test-rag` writes the first schema-valid trace, which keeps the refund-policy chunks**

## Performance

- **Duration:** about 20 min (start time was not captured at launch; estimate)
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 9 (7 created, 2 modified)

## Accomplishments
- Tracer run: retrieval returns two `refund-policy.en.md` chunks (similarity 0.621 annual, 0.481 monthly); both are kept, `refused` is false, the context holds the `=== RELEVANT INFORMATION FROM DOCUMENTS ===` block, and the edge recorded zero errors. The multi-tenant mode also runs end to end (one trace, user_id defaulted to the fixture user).
- Access check verified for all four outcomes; the route probe confirmed auth runs before the body is parsed (garbage body with no secret gives 401, not 400).
- Effective config is `{}` for `rag_env` in the fixture run because inherited `RAG_*` are cleared; prompt digests are SHA-256 of the empty string when unset.

## Task Commits

1. **Task 1: Eval env entries, access check, post-filter replica, config hashing** - `6488cff` (feat)
2. **Task 2: Eval route and `npm run test-rag`** - `6273a9c` (feat)

**Plan metadata:** committed separately (docs: complete plan)

## Decisions Made
See `key-decisions` above. The notable one is what `kept` means: the chat route puts every chunk of a surviving document into the context, even a chunk that failed Filter 1 on its own, so `kept` follows the context rather than the per-chunk test. If plan 01-07 or later metrics want the stricter per-chunk reading it is recoverable from `similarity` and `candidates`.

## Deviations from Plan

None - plan executed exactly as written. (Two minor implementation choices, the single chunk-metadata lookup and the `kept_by` inheritance, are recorded under key-decisions; neither changes what the replica outputs for the route's logic.)

## Issues Encountered
- Behavior to carry forward: on the tracer item `kept_by` is `name` for both chunks, because the query terms ("refund", "window", "annual", "plans") appear in the document content. Filter 1 therefore passes almost anything in this small corpus; later plans measuring precision should expect that, not treat it as a harness fault.
- ESLint reports three `no-unused-vars` warnings in `eval/harness/run-eval.mts` on parameter names inside function type signatures (false positives); no errors.

## Known Stubs
None.

## Threat Flags
None beyond the plan's register. T-01-01 (constant-time compare, 503 under 32 chars), T-01-02 (404 gate in production, `RAG_EVAL_ENDPOINT_ENABLED` defaults to `'false'`, auth before body) and T-01-04 (secret-like names dropped, prompts hashed, logs carry counts and ids only) are implemented as planned.

## User Setup Required
None. Plan 01-11 mirrors the four new env variables into `scripts/init-env.js`, `scripts/config-server.js` and the Config UI.

## Next Phase Readiness
- Plan 01-09 can build the route matrix and harness tests on `prepareInProcessEval` (returns `{ POST, secret, edge, fixtureUserId, close }`); note `env` in `src/lib/env.ts` is read once at import, so tests that flip `RAG_EVAL_*` between requests need a fresh module import.
- Plan 01-10 consumes `runEval`'s result (`tracesPath`, `itemCount`, `tier`, `deploymentMode`, `edgeErrors`) for the run manifest.
- Plan 01-17 should lock the replica with unit tests; the Chinese empty-term quirk is preserved as-is.

## Self-Check: PASSED

All 7 created files exist, commits `6488cff` and `6273a9c` are ancestors of HEAD, `npm run test-rag -- --out eval/out/tracer` exits 0 with the expected trace, and the protected-file `git diff --quiet 325a2c9` check exits 0.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
