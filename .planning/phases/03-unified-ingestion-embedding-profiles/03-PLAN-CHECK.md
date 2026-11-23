# Phase 3 Plan Check

**Verdict: PASS WITH FIXES**: 3 blockers, 5 warnings, 4 info. All three blockers can be fixed locally. None needs a re-plan.

Method: goal-backward over 03-01..03-48 against ROADMAP Phase 3 (SC 1-10), REQUIREMENTS, 03-CONTEXT D-01..D-47 and 03-RESEARCH. `verify.plan-structure` returns valid with 0 errors for all 48 plans. A script compared every wave's `files_modified`, and diffed Phase 3 against the pending Phase 2 plans 02-20/21/23..29/36. The tree was read at HEAD to check the cited contracts.

## BLOCKERS

**B1. [tenant isolation] 03-30, Task 1: a lineage delete must remove only rows in the caller's server-verified tenant, and a two-tenant test must prove it.**
Evidence: the plan says the row is read "with the caller's client (RLS applies)" and the delete uses "the same authorization the route uses today" (must_haves and T-03-86). At HEAD, `src/app/api/documents/[id]/route.ts` uses `supabaseAdmin` and has no session check and no tenant predicate. There is no caller client and no RLS. Widening the delete from one id to `.eq('lineage_id', ...)` makes one unauthenticated request delete every version. The plan has no two-tenant test, and the action contradicts the code, so a Sonnet executor has to guess.
Fix: in DELETE and PATCH, resolve the scope with `resolveTenantScope`. Read the row, filtering `tenant_key = scopeKey(scope)`, and return 404 when it is missing. Delete by `lineage_id` and `tenant_key`. Add a two-tenant case to `tests/rag/documents-versions.test.ts`: B's DELETE or PATCH on A's id returns 404 and A's rows stay. Also correct T-03-86. Closing the existing unauthenticated delete is a security fix. Record it as a deliberate change to today's behaviour.

**B2. [research resolution] 03-RESEARCH.md `## Open Questions` (L1466): every open question must be marked resolved.**
Evidence: questions 1-6 each give a recommendation (several plans adopt them, for example Q4 in 03-31 and Q6 in 03-23), but none carries a RESOLVED marker, and the heading has no `(RESOLVED)`.
Fix: mark each question `RESOLVED: <decision> (plan 03-xx / live item in 03-48)` and retitle the section `## Open Questions (RESOLVED)`.

**B3. [scope] 03-13 (the tracer): each plan must fit the per-plan context budget.**
Evidence: 25 files in `files_modified` (the blocker threshold is 15), an estimate of 95k tokens, 3 tasks. It creates the runner, the writer, 11 stage files, the chunker, trace and status, and also edits `src/lib/rag/trace/collector.ts`, which pending plan 02-23 also owns.
Fix: split it into 13a (types, deps, runner, writer and identity, plus the runner test) and 13b (stage stubs, Markdown chunker, trace and status, plus the tracer DB test). Or keep the stage stubs in one file until each owning plan fills them in.

## WARNINGS

**W1. [scope] 03-01 (18 files), 03-02 (21), 03-11 (16) and 03-46 (15) are over the file threshold.** Most of those files are migrations, generated schemas or samples, so this is a warning rather than a blocker. Fix: split 03-02 into contract groups (ingest/parse and profile/eval), or record in each plan that the generated files are produced by one command.

**W2. [Phase 2 sequencing] Phase 3 edits files that pending Phase 2 plans own.** 03-02/11/45/46 share `contracts.generated.ts`, `samples.py`, `samples.json` and `export_schemas.py` with 02-21/24/25/27/28. 03-11 shares `golden.jsonl`, `split-manifest.json`, `fixture-baseline.json` and `test_fixture_coverage.py` with 02-26. 03-26 and 03-35 share `pipeline.ts` with 02-21. 03-13 shares `trace/collector.ts` with 02-23. 03-01/15/25/41 share `pr-smoke.yml` and `check-workflows.py` with 02-20/21/28/36. 03-04 extends 02-20's `check-rag-boundary.mjs`. The `02-36-SUMMARY.md exists` precondition in the wave-1 plans orders all of this, and later plans inherit it through `depends_on`. However, 03-04 puts the precondition only in Task 1, and plans in wave 2 and later do not restate it. Fix: give 03-04 a plan-level precondition. In 03-11, 03-13 and 03-26, state that the executor re-reads the files 02-2x delivered (`read_first`) rather than the line numbers quoted in the plan.

**W3. [verification] SC5 says a mismatch "fails loudly at startup", but 03-21 makes the startup check never throw (time-boxed to 3 s; it logs and stores status), with failure per request.** This follows research P-9. Fix: in 03-21's must_haves, state how the operator sees the startup failure (an exact `[Embedding Profile]` error line, plus the stored status shown in the Config UI by 03-43) and assert it in the test.

**W4. [shipped behaviour] 03-30 changes four readers with no switch.** The reason given is that legacy rows are always current v1. That is true only after 03-01's backfill and triggers. Fix: point the "byte-identical on legacy data" behaviour at the 03-01 legacy-compat trigger test, and add a row inserted by a legacy writer after the migration to the fixture.

**W5. [tenant isolation] 03-37: `rag_list_quarantine` lists every tenant.** That is correct for the deployment-admin model of `requireRagAdmin`, but no plan says so. Fix: state in 03-37's threat model that admin is deployment-scoped. Add a test that an authenticated non-admin gets 403 on the list, release and delete routes.

## INFO

- I1. The brief says `src/lib/rag/legacy/` is gone. It is not: `src/lib/rag/legacy/enhanced-retrieval.ts` still exists and nothing imports it under that path, while 02-19 deleted the eleven top-level modules. 03-26 correctly targets this file. 03-09's hedge ("or their re-homed copies") should name it outright.
- I2. The Phase 2 contracts at HEAD match how the plans use them: `resolveTenantScope`, `scopeKey`, `assertTenantScope`, `tenantPredicate` (tenant/scope.ts, resolve-chat.ts), `runStage` (exported from `@/lib/rag`), `embedText(text, {signal})` and `embedBatch` (embeddings/openai.ts), and `ragEnv` (deps/pipeline). `mintScope` is restricted as 03-04 (F-13) expects.
- I3. The dependency graph is acyclic and every wave is at least max(dependency wave)+1. No same-wave `files_modified` overlap was found. `scripts/config-server.js` is edited in waves 1, 6 and 9 (03-03, 03-31, 03-43), which is sequential.
- I4. Rollback switches: RAG_INGEST_PIPELINE, RAG_PARSER, RAG_INJECTION_SCAN, RAG_EMBEDDING_PROFILES, RAG_EXACT_ID_LOOKUP, RAG_PDF_IMAGE_CHUNKS, RAG_DOC_TYPE_LLM_DETECT, RAG_INVOICE_LLM_EXTRACT and RAG_QWEN_EMBED_FALLBACK are each wired in the five config locations by 03-03, and invalid values fall back to today's behaviour. The D-08 retrieval filter and the 03-30 readers have no switch, by stated design. Deferred ideas are not implemented; the LLM detectors stay off by default.

## Coverage

| Item | Plans | Status |
|---|---|---|
| DATA-01/02 one ingest(), same metadata (SC2) | 13, 23, 24, 31, 32, 33, 44 | Covered |
| DATA-03 doc types, defaults, picker (SC1, SC9) | 22, 25, 39, 42, 43 | Covered |
| DATA-04 single writer | 04, 10, 13 | Covered |
| DATA-05 Docling fallback, OCR, tables (SC4) | 12, 15, 19, 27 | Covered |
| DATA-06/07 dedup, versioning, old citations (SC3) | 10, 16, 30, 39 | Covered (B1 on 30) |
| DATA-09/10/11 invoices, exact id, PDF images (SC9) | 14, 29, 35, 38 | Covered |
| EMB-01..05 profiles, re-embed, activation (SC5, SC10) | 08, 09, 21, 26, 28, 36, 40, 45, 46 | Covered (W3) |
| CHK-01/02 section_path, clause chunker (SC6) | 06, 13, 19, 41 | Covered |
| SEC-01 injection quarantine and admin release (SC7) | 20, 37, 43 | Covered (W5) |
| XLG-02 cross_lingual baseline and per-pair compare (SC8) | 11, 45, 46 | Covered |
| Final gates and live verification | 47, 48 | Covered |
| Tenant isolation: two-tenant tests on new RPCs and readers | 09, 10, 16, 22, 29, 34, 35 (+23, 24, 31, 33 scope) | Gap in 30 (B1) |
| D-01..D-47 | each cited by at least one plan | Covered |
