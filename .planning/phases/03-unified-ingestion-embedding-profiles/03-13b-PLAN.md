---
phase: 03-unified-ingestion-embedding-profiles
plan: 13b
type: execute
wave: 4
depends_on: ["03-13"]
files_modified:
  - src/lib/rag/ingest/stages/store-original.ts
  - src/lib/rag/ingest/stages/scan-injection.ts
  - src/lib/rag/ingest/stages/enrich.ts
  - src/lib/rag/ingest/stages/extract.ts
  - src/lib/rag/ingest/stages/images.ts
  - src/lib/rag/ingest/runner.ts
  - tests/rag/ingest/runner.test.ts
  - src/lib/rag/ingest/trace.ts
  - src/lib/rag/ingest/status.ts
  - src/lib/rag/trace/collector.ts
  - src/lib/rag/ingest/index.ts
  - src/lib/rag/index.ts
  - tests/rag/ingest/ingest-trace.test.ts
autonomous: true
requirements: [DATA-01, DATA-02]

estimate:
  tokens: 50000
  raw_tokens: 50000
  tasks: 2
  confidence: low

must_haves:
  truths:
    - "ingest runs all thirteen D-02 stages in order (identify, file_hash_dedup, store_original, parse, content_hash_dedup, scan_injection, chunk, enrich, extract, images, embed, write, publish); each is a separate module, checks the request deadline before it starts, and, once the document row exists, persists processing_status and processing_state (lastCompleted plus its slice) after it finishes"
    - "When the deadline cannot fit the next stage, ingest returns status processing with the document id, and resumeIngest(scope, documentId) continues from the stage after lastCompleted without duplicating chunks"
    - "enrich gives every chunk lexical_text with the path prefix, language, chunk content_hash and the URL metadata keys urls, has_urls, url_count and url_categories, so chunk metadata keeps storeDocument's keys (DATA-02)"
    - "Stages switched off by default keep today's behaviour: store_original records no_object_store until plan 03-17, scan_injection passes when RAG_INJECTION_SCAN=off and fails the run closed with injection_scan_unavailable when it is quarantine until plan 03-20, extract records `extractor_unavailable:<name>` until plans 03-18 and 03-29, images passes when RAG_PDF_IMAGE_CHUNKS=false"
    - "Each ingest run produces one trace with one span per stage named exactly as the stage, exported through the Phase 2 Langfuse path with profile ingest, never as a review candidate and never with document content (also with LANGFUSE_REVIEW_SAMPLE_RATE=1 and LANGFUSE_CAPTURE_CONTENT=true); otherwise a single `[Ingest Trace]` line that contains no document text"
    - "ingest, resumeIngest, getIngestStatus and IngestResult are exported from @/lib/rag; getIngestStatus for another tenant's document id returns null"
    - "Stages never compare a doc type; they read the processing profile's chunker kind, extractors and parser options (D-13)"
  artifacts:
    - path: "src/lib/rag/ingest/runner.ts"
      provides: "Ordered resumable stage list with deadline, state persistence and spans"
      exports: ["runIngestStages", "INGEST_STAGES"]
    - path: "src/lib/rag/ingest/trace.ts"
      provides: "Per-stage ingestion trace on the Phase 2 export path with the `[Ingest Trace]` fallback"
      exports: ["createIngestTrace", "finishIngestTrace"]
    - path: "src/lib/rag/ingest/status.ts"
      exports: ["getIngestStatus", "resumeIngest"]
    - path: "src/lib/rag/index.ts"
      provides: "Public exports ingest, resumeIngest, getIngestStatus and the ingest types"
  key_links:
    - from: "src/lib/rag/ingest/trace.ts"
      to: "src/lib/rag/trace/langfuse.ts"
      via: "exportTrace(CollectedTrace without review or content) scheduled with scheduleAfterResponse"
      pattern: "exportTrace"
    - from: "src/lib/rag/index.ts"
      to: "src/lib/rag/ingest/index.ts"
      via: "export { ingest, resumeIngest, getIngestStatus } from './ingest'"
      pattern: "resumeIngest"
---

<objective>
Complete the ingest() that the tracer (plan 03-13) proved end to end: register the five remaining D-02 stages with their switch-off behaviour, give the runner its deadline, state persistence, abort handling and resume, add the per-stage ingestion trace, the status and resume entry points, and export the public surface from `@/lib/rag`.

Purpose: DATA-01's stage contract (D-02) needs every named stage, resumable within a request deadline, before the feature plans fill the stages; DATA-02 needs the enrich stage so chunk metadata matches storeDocument's; D-46 makes each ingestion observable per stage.
Output: five stage modules, the runner's deadline, state and resume, ingest/trace.ts, ingest/status.ts, the collector's `ingest` profile, the `@/lib/rag` exports, and two test files.

Runs after Phase 2 is complete (every 02-* plan has a SUMMARY) and after plan 03-13 (split from it to fit the per-plan budget).

Phase 2 files this plan edits: src/lib/rag/trace/collector.ts (02-08, 02-23) and src/lib/rag/index.ts (02-07, 02-08, 02-09, 02-10, 02-11, 02-12, 02-13, 02-16, 02-18). Re-read both at HEAD and those SUMMARY.md files before editing; 02-23 has merged, so the collector now carries setReviewContent and reviewContent and finishTrace samples review candidates with LANGFUSE_REVIEW_SAMPLE_RATE. Do not rely on any line number quoted in an older plan.

Design rule for every later Phase 3 plan (set here): stages switched off by default keep today's behaviour, as listed in must_haves; the owning plans (03-17, 03-18, 03-20, 03-29, 03-32, 03-38) replace those branches.

Deviations from CONTEXT.md (research adjustments adopted):
- F-12 amends D-21: every stage checks the remaining request time (default 50 s), not only parse polling.
- D-14 lists the `urls` extractor only for general and product_technical, but D-07 keeps the URL metadata unchanged and storeDocument extracts it for every document, so enrich writes URL metadata on every chunk (DATA-02 parity); the profile entry stays in the data.
- D-46 with the delivered 02-23 shape: ingest traces reuse exportTrace and the trace sampling, but they are never review candidates and never carry content, because the review queue holds retrieval answers and ingest content is document text.

Commit rule for every task: plain `git commit`; the message ends with the attribution lines (Co-Authored-By and the session link) that the executor's own session supplies; never copy them from a plan.
No model identifiers in code comments or commit messages; no document text in logs or traces.
</objective>

<execution_context>
@.claude/gsd-core/workflows/execute-plan.md
@.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/phases/03-unified-ingestion-embedding-profiles/03-CONTEXT.md
@.planning/phases/03-unified-ingestion-embedding-profiles/03-RESEARCH.md
@.planning/phases/03-unified-ingestion-embedding-profiles/03-13-SUMMARY.md
@.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-22-SUMMARY.md
@.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-23-SUMMARY.md
@src/lib/rag/ingest/runner.ts
@src/lib/rag/ingest/types.ts
@src/lib/rag/trace/collector.ts
@src/lib/rag/trace/finish.ts
@src/lib/rag/trace/langfuse.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: The remaining five stages with deadline, state persistence and resume</name>
  <files>src/lib/rag/ingest/stages/store-original.ts, src/lib/rag/ingest/stages/scan-injection.ts, src/lib/rag/ingest/stages/enrich.ts, src/lib/rag/ingest/stages/extract.ts, src/lib/rag/ingest/stages/images.ts, src/lib/rag/ingest/runner.ts, tests/rag/ingest/runner.test.ts</files>
  <read_first>
    - 03-RESEARCH.md Pattern 1 "Rules that make resume safe", pitfall P-7
    - src/lib/rag/ingest/runner.ts, types.ts and writer.ts as left by plan 03-13, and 03-13-SUMMARY.md
    - src/lib/url-extractor.ts (enrichChunkWithURLs, extractURLs: kept verbatim)
  </read_first>
  <behavior>
    - the runner executes all thirteen stages in D-02 order; a fake stage list records the order
    - with a fake clock, a stage whose minMsNeeded exceeds the remaining time yields: the result is processing, processing_state.lastCompleted names the previous stage, and the next stage did not run
    - resume from lastCompleted 'chunk' runs enrich..publish only; running the same resume twice writes the same chunk ids (no duplicates)
    - an aborted signal stops before the next stage and the version is marked failed with reason aborted; a stage throwing marks failed with `<stage>_failed`
    - enrich sets lexical_text (path prefix plus content), language, chunk content_hash and the URL metadata keys (urls, has_urls, url_count, url_categories) on every chunk, as storeDocument does; extract records `extractor_unavailable:<name>` warnings for listed extractors that do not exist yet
    - scan_injection with RAG_INJECTION_SCAN=quarantine fails the run with reason injection_scan_unavailable until the scanner exists; with off it passes
    - images with RAG_PDF_IMAGE_CHUNKS=false passes; store_original records warning no_object_store
  </behavior>
  <action>
Per D-02, D-21 (with F-12), D-24 and D-32: add the five stage modules with the behaviour above and register them at their D-02 positions in the runner plan 03-13 left. The runner gains: `if (ctx.deadline - deps.now() < spec.minMsNeeded)` yields processing; after each stage, when the row exists, writer.saveState(lastCompleted plus the stage's slice); throwIfAborted between stages, with an abort marked failed with reason aborted. Read switches through loadIngestConfig(deps.ingestEnv()). Tests first with injected deps and a recording fake RpcClient; the 03-13 tracer test must keep passing unchanged.
  </action>
  <verify>
    <automated>npx vitest run tests/rag/ingest/runner.test.ts && node --import tsx --test tests/rag-db/ingest-tracer.test.mts</automated>
    <fails_when>any test fails or a resumed run duplicates chunks</fails_when>
  </verify>
  <acceptance_criteria>
    - `ls src/lib/rag/ingest/stages/ 2>/dev/null | grep -cE '^(store-original|scan-injection|enrich|extract|images)\.ts$'` >= 5 [HEAD=0 EXPECT>=5 @847de63]
    - `grep -c "saveState" src/lib/rag/ingest/runner.ts` >= 1 [HEAD=error:2 EXPECT>=1 @847de63]
    - `npx vitest run tests/rag/ingest/runner.test.ts` reports at least 9 passed and 0 failed
  </acceptance_criteria>
  <done>Every D-02 stage exists, runs in order, respects the deadline and can be resumed idempotently.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Ingestion trace, status and resume entry points, and the public exports</name>
  <files>src/lib/rag/ingest/trace.ts, src/lib/rag/ingest/status.ts, src/lib/rag/trace/collector.ts, src/lib/rag/ingest/index.ts, src/lib/rag/index.ts, tests/rag/ingest/ingest-trace.test.ts</files>
  <read_first>
    - Phase 2 touched two of these files: re-read src/lib/rag/trace/collector.ts at HEAD with 02-08-SUMMARY.md and 02-23-SUMMARY.md, and src/lib/rag/index.ts at HEAD with the 02-07, 02-08, 02-09, 02-10, 02-11, 02-12, 02-13, 02-16 and 02-18 SUMMARY.md files (all under .planning/phases/02-unified-retrieval-pipeline-tenant-scope/) before editing
    - src/lib/rag/trace/finish.ts, langfuse.ts (CollectedTrace, exportTrace), sample.ts (isSampled prefixes trace and review), schedule.ts, log.ts and mask.ts as delivered by 02-22 and 02-23
    - tests/rag-langfuse-review.test.mts and tests/rag-langfuse-export.test.mts (fake Langfuse endpoint, review-candidate assertions)
    - 03-CONTEXT.md D-46
  </read_first>
  <behavior>
    - a run creates one collector with profile 'ingest' and tenantKey from scopeKey; each stage records a span named as the stage with status, latency and the fixed detail fields parser_used, pages, chunk count, doc type and origin, fallback reason, dedup or quarantine outcome
    - with Langfuse usable and LANGFUSE_SAMPLE_RATE=1, finishIngestTrace sends one trace to the fake Langfuse endpoint, tagged profile:ingest
    - with LANGFUSE_REVIEW_SAMPLE_RATE=1 and LANGFUSE_CAPTURE_CONTENT=true, the exported ingest trace has no review block, no content block and no review_candidate tag, and the collector's reviewContent() is still null after the run
    - when the trace is not sampled or the export fails, exactly one `[Ingest Trace]` line is written; a distinctive phrase from the ingested document never appears in the export payload or in that line
    - getIngestStatus(scope, id) returns status, version, processingStatus, lastCompleted, parserUsed, docType; an id of another tenant returns null
    - resumeIngest(scope, id) for a ready document returns its ready result without running stages; for a processing document it continues after lastCompleted
  </behavior>
  <action>
Per D-46: widen `profile` in TraceCollector and TraceCollectorOptions to `Profile | 'ingest'`, leaving the review-content methods, finishTrace, logRagTrace and every retrieval caller as 02-23 left them. ingest/trace.ts creates the collector, wraps stage spans, and finishes by building a CollectedTrace (tags rag-ingest, profile:ingest and tenant:<key>; status and reason from the IngestResult; stages from the collector) with neither review nor content. It samples with isSampled(traceId, sampleRate, 'trace') only, never with the review prefix, exports through scheduleAfterResponse and a dynamic import of ../trace/langfuse exportTrace, and falls back to the single `[Ingest Trace]` line with a fixed field list (traceId, tenantKey, profile, status, reason, and per stage name, status, reason, latency_ms and the fixed detail fields). This reuses the Phase 2 export path without duplicating it and keeps the retrieval-specific finishTrace untouched. status.ts implements getIngestStatus and resumeIngest (resume reuses runIngestStages from Task 1). ingest/index.ts exports resumeIngest and getIngestStatus; src/lib/rag/index.ts re-exports ingest, resumeIngest, getIngestStatus, IngestResult and the public input and source types, appended to the delivered export list without reordering it. Tests first.
  </action>
  <verify>
    <automated>npx vitest run tests/rag/ingest/ingest-trace.test.ts tests/rag/trace-log.test.ts && node --import tsx --test tests/rag-langfuse-review.test.mts tests/rag-langfuse-export.test.mts && npm run typecheck:new && node scripts/ci/check-rag-boundary.mjs</automated>
    <fails_when>any test fails, document text reaches a log or trace, an ingest trace is exported as a review candidate, typecheck:new fails, or the boundary check fails</fails_when>
  </verify>
  <acceptance_criteria>
    - `grep -c "\[Ingest Trace\]" src/lib/rag/ingest/trace.ts` >= 1 [HEAD=error:2 EXPECT>=1 @847de63]
    - `grep -c "'ingest'" src/lib/rag/trace/collector.ts` >= 1 [HEAD=0 EXPECT>=1 @847de63]
    - `grep -c "resumeIngest\|getIngestStatus" src/lib/rag/index.ts` >= 2 [HEAD=0 EXPECT>=2 @847de63]
    - `npx vitest run tests/rag/ingest/ingest-trace.test.ts` reports at least 6 passed and 0 failed
  </acceptance_criteria>
  <done>Each ingestion is observable per stage without leaking content or entering the review queue, and callers import ingest, status and resume from `@/lib/rag`.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| ingest() to logs and traces | Sinks outside the tenant boundary |
| Request deadline to the function runtime | A killed function would leave a half-written version |
| Ingested text to retrieval | Injection phrasing must not reach retrieval while the scanner is absent |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-03-39 | Information disclosure | traces and logs | high | mitigate | fixed span fields; test with a distinctive document phrase; Phase 2 masking and sampling reused |
| T-03-40 | Denial of service | runaway requests | medium | mitigate | request deadline per stage, processing status and resume instead of a killed function |
| T-03-41 | Tampering | quarantine bypass while the scanner is absent | high | mitigate | scan_injection fails closed when RAG_INJECTION_SCAN=quarantine before the scanner lands |
| T-03-137 | Information disclosure | review queue and content capture on ingest traces | high | mitigate | ingest traces sample with the trace prefix only and carry neither review nor content; test with review sampling 1 and content capture on |
| T-03-SC | Tampering | packages | low | accept | no package changes |
</threat_model>

<verification>
- `npx vitest run tests/rag/ingest`
- `node --import tsx --test tests/rag-db/ingest-tracer.test.mts tests/rag-langfuse-review.test.mts tests/rag-langfuse-export.test.mts`
- `npm run typecheck:new` and `node scripts/ci/check-rag-boundary.mjs`
</verification>

<success_criteria>
A Markdown document ingested through `ingest()` from `@/lib/rag` is retrievable for its tenant only, through thirteen named, resumable, traced stages whose traces never carry document text.
</success_criteria>

<output>
Create `.planning/phases/03-unified-ingestion-embedding-profiles/03-13b-SUMMARY.md` when done.
</output>
