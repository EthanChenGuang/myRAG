---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 22
subsystem: observability
tags: [langfuse, opentelemetry, tracing, pii-masking, sampling, after-response]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: trace collector and finishTrace log fallback (02-08); eval route on the shared pipeline (02-11)
provides:
  - exact-pinned Langfuse and OpenTelemetry packages with a version assertion test
  - exportTrace: after-the-fact span replay (root plus one span per stage) on an isolated, never-global tracer provider
  - maskPII, isSampled (per-purpose hash prefix), scheduleAfterResponse (after() with detached fallback)
  - finishTrace integration: sampled export after the response, one [RAG Trace] line for every other path
  - fake Langfuse endpoint (OTLP traces, v2 observations paging, scores) for tests, reused by plan 02-23
affects: [02-23]

requirements-completed: [OBS-01]

actuals:
  tokens: 10100
  tasks: 3
  commits: 4
plan_head_before: 63dbafbbb91cf43d3439141d594d7f3ef7ddad14
plan_head_after: a53ac3a0359f6851d820b1264d5fdedae4bd7985

tech-stack:
  added:
    - "@langfuse/tracing 6.1.1, @langfuse/otel 6.1.1"
    - "@opentelemetry/sdk-trace-base 2.12.1, core 2.12.1, exporter-trace-otlp-http 0.223.2, otlp-exporter-base 0.223.2, api 1.9.0"
  patterns:
    - "Langfuse config is read from process.env at call time (readLangfuseConfig) and every value is passed to the processor explicitly; the processor is built lazily and only when enabled with both keys"
    - "finish.ts loads trace/langfuse.ts with a dynamic import inside the scheduled task, so a disabled or unsampled request never loads the SDK"
    - "Export failure and flush timeout throw out of exportTrace and the scheduled task writes the single [RAG Trace] line"

key-files:
  created:
    - src/lib/rag/trace/langfuse.ts
    - src/lib/rag/trace/config.ts
    - src/lib/rag/trace/mask.ts
    - src/lib/rag/trace/sample.ts
    - src/lib/rag/trace/schedule.ts
    - tests/rag/langfuse-pins.test.ts
    - tests/rag/mask.test.ts
    - tests/rag/sample.test.ts
    - tests/helpers/fake-langfuse.mts
    - tests/rag-langfuse-export.test.mts
  modified:
    - package.json
    - package-lock.json
    - src/lib/rag/trace/finish.ts
    - src/lib/rag/pipeline.ts
    - src/app/api/internal/rag/run/route.ts

key-decisions:
  - "Registry check (repository under langfuse-js or opentelemetry-js, no install scripts, not deprecated) passed for all seven pins; installed with --ignore-scripts, no human checkpoint, per the locked D-18 adjustment"
  - "Stage spans are created with the top-level startObservation and an explicit parentSpanContext (the child method's typings do not accept startTime)"
  - "A stage with no candidate count exports -1 for candidates_in / candidates_out, because Langfuse drops null attributes and the plan requires the attribute on every stage span"
  - "tenantKey is carried on every span as user.id, a tenant:<key> tag and langfuse.trace.metadata.tenantKey; no e-mail"
  - "Masking order: e-mail, IBAN, CN resident ID, IT codice fiscale, Luhn-checked card, international phone, CN mobile (IDs before cards so an 18-digit ID is never read as a card)"

patterns-established:
  - "Sampling is deterministic: first 8 hex of sha256(prefix:requestId) / 2^32 < rate; prefix 'trace' now, 'review' for plan 02-23"

coverage:
  - id: D1
    description: "Packages pinned exactly and resolved versions asserted; no OTel node SDK dependency"
    requirement: OBS-01
    verification:
      - kind: unit
        ref: "tests/rag/langfuse-pins.test.ts (15 tests)"
        status: pass
  - id: D2
    description: "maskPII, isSampled and scheduleAfterResponse behave as specified"
    requirement: OBS-01
    verification:
      - kind: unit
        ref: "tests/rag/mask.test.ts (9), tests/rag/sample.test.ts (8)"
        status: pass
  - id: D3
    description: "Sampled request yields one trace (collector trace id), 1 + stages spans named as the stage_latency_ms keys, attributes and tenant key on every span, exact start and end times, posted to /api/public/otel/v1/traces with Basic auth"
    requirement: OBS-01
    verification:
      - kind: integration
        ref: "tests/rag-langfuse-export.test.mts (tests 1 and 2, fake endpoint)"
        status: pass
  - id: D4
    description: "Response completes while the export is still held open (eval route, in process); disabled-with-keys sends nothing and builds no processor; unsampled, hanging and HTTP 500 endpoints each write exactly one [RAG Trace] line"
    requirement: OBS-01
    verification:
      - kind: integration
        ref: "tests/rag-langfuse-export.test.mts (route test, disabled, unsampled, hang, 500)"
        status: pass
  - id: D5
    description: "Content (query, kept chunks) exported only with LANGFUSE_CAPTURE_CONTENT=true and masked"
    requirement: OBS-01
    verification:
      - kind: integration
        ref: "tests/rag-langfuse-export.test.mts (content test)"
        status: pass
  - id: D6
    description: "Live Langfuse UI shows the replayed root as the trace root with the pre-generated trace id (research assumption A1)"
    requirement: OBS-01
    verification:
      - kind: manual
        ref: "needs a live Langfuse project and keys; not run in this environment"
        status: not-run

duration: 40min
completed: 2026-11-23
---

# Phase 2 Plan 22: Langfuse tracing via OpenTelemetry Summary

Sampled requests replay the in-request stage records as one Langfuse trace (root plus one span per stage) on an isolated tracer provider after the response, with a time-boxed flush and a single `[RAG Trace]` line for every other case.

## What was built

- **Packages (Task 1).** Seven exact pins, installed with `--ignore-scripts`. `tests/rag/langfuse-pins.test.ts` asserts declared (no ranges) and resolved versions, and that `@opentelemetry/sdk-node` is absent.
- **Masking, sampling, scheduling (Task 2, TDD).** RED commit with stubs failing on assertions (12 failures), then GREEN (17 tests).
- **Exporter and integration (Task 3).** `exportTrace` builds a `LangfuseSpanProcessor` lazily with explicit values inside a `BasicTracerProvider` registered only through `setLangfuseTracerProvider`; it is rebuilt if base URL or keys change. `finishTrace` decides per request: enabled, both keys present and sampled schedules the export after the response, otherwise it logs immediately.
- **Query passthrough.** `runRetrieval` (own-trace path) and the eval route pass `{ query }` to `finishTrace` so the query can be exported when content capture is on.

### Registry check outputs (`npm view <pkg>@<version> repository.url scripts.postinstall scripts.install scripts.preinstall deprecated --json`)

| Package | repository.url | install scripts | deprecated |
|---|---|---|---|
| @langfuse/tracing@6.1.1 | https://github.com/langfuse/langfuse-js.git | none | no |
| @langfuse/otel@6.1.1 | https://github.com/langfuse/langfuse-js.git | none | no |
| @opentelemetry/sdk-trace-base@2.12.1 | git+https://github.com/open-telemetry/opentelemetry-js.git | none | no |
| @opentelemetry/exporter-trace-otlp-http@0.223.2 | git+https://github.com/open-telemetry/opentelemetry-js.git | none | no |
| @opentelemetry/otlp-exporter-base@0.223.2 | git+https://github.com/open-telemetry/opentelemetry-js.git | none | no |
| @opentelemetry/core@2.12.1 | git+https://github.com/open-telemetry/opentelemetry-js.git | none | no |
| @opentelemetry/api@1.9.0 | git+https://github.com/open-telemetry/opentelemetry-js.git | none | no |

The lockfile diff is additions only (227 lines, no removals).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extra module src/lib/rag/trace/config.ts**
- **Found during:** Task 3
- **Issue:** `src/lib/env.ts` is an import-time singleton, so tests cannot toggle `LANGFUSE_*`, and finish.ts must not import the SDK statically.
- **Fix:** small dependency-free `readLangfuseConfig` / `isLangfuseUsable` that read `process.env` at call time; finish.ts takes an optional `config` for injection.
- **Commit:** a53ac3a

**2. [Rule 1 - Bug] Child span start time not accepted by the typed child method**
- **Found during:** Task 3 (`typecheck:new`)
- **Fix:** children created with top-level `startObservation` plus explicit `parentSpanContext`; a test asserts the exact start and end times.
- **Commit:** a53ac3a

**3. [Rule 2 - Missing critical] Null candidate counts dropped by Langfuse**
- **Fix:** export -1 for a null count so the attribute is always present (see key-decisions).
- **Commit:** a53ac3a

**4. [Scope] One-line edits outside the plan's file list:** `src/lib/rag/pipeline.ts` and `src/app/api/internal/rag/run/route.ts` now pass `{ query }` to `finishTrace`. Without it LANGFUSE_CAPTURE_CONTENT=true could never export the query. `src/lib/rag/index.ts` was not touched.
- **Commit:** a53ac3a

### Test environment note
`tests/rag-langfuse-export.test.mts` calls `prepareInProcessEval` before importing any `src/lib` module, because `src/lib/env.ts` snapshots the environment on first import. It is a `node:test` file, so it runs with `node --import tsx --test` (not vitest) and is not yet listed in `.github/workflows/pr-smoke.yml`.

## Verification

- `npx vitest run`: 48 files, 517 tests pass
- `node --import tsx --test tests/rag-langfuse-export.test.mts`: 8 pass (plan asked for 7); `tests/eval-answer.test.mts` still passes (22 total in the combined run)
- `npm run typecheck:new`: no Phase 1 type errors; `npx next typegen && node scripts/ci/tsc-ratchet.mjs`: ok (58 errors, ratchet not exceeded)
- Acceptance greps: `setLangfuseTracerProvider` 3, `setGlobalTracerProvider` 0, `/api/public/ingestion` 0, `sdk-node` in package.json 0

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model (T-02-60..63, T-02-SC all mitigated as planned). Note: `npm install` ran through the `node_modules` symlink to the main checkout, so the seven packages now also exist in the shared `node_modules`; only the lockfile and manifest in this worktree changed.

## Live items for the orchestrator

- Confirm in the Langfuse UI that the replayed root shows as the trace root with the pre-generated trace id (research assumption A1).
- Confirm the Hobby quota assumption (about 7-9 units per sampled trace).

## Self-Check: PASSED

All ten created files exist; commits 1186bc0, 9a457da, 9eb8890 and a53ac3a are ancestors of HEAD.
