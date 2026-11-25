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

## Re-check (pass 2)

**Verdict: ISSUES FOUND, revision required**: 5 blockers, 1 warning, 3 info. B1-B3 and W2-W5 are resolved; W1 is only partly resolved. The new blockers all come from security fixes landing after the plans were written: four write paths do not lock in the session requirement or the nango ownership fix, and 03-07 still creates the admin guard from scratch.

### First-pass items

- **B1 resolved.** 03-30 now builds on the documents-route fix: it has a precondition (`resolveTenantScope` present in the route, plus `tests/rag/documents-route.test.ts`). It reads and deletes with `tenant_key = scopeKey(scope)` and returns 404 across tenants. It has a two-tenant DELETE/PATCH test, and T-03-86 is corrected.
- **B2 resolved.** The section is retitled `## Open Questions (RESOLVED)`, and each of Q1-Q6 carries a RESOLVED line naming a plan or 03-48 live item.
- **B3 resolved.** 03-13 now has 14 files and 2 tasks (55k tokens); 03-13b has 13 files and 2 tasks (50k). The union is the original 25 files, so nothing was lost. `runner.ts` and `index.ts` appear in both plans, but in waves 3 and 4, so they never run together. `trace/collector.ts` moved to 03-13b, which says to re-read it after 02-23.
- **W1 partly resolved.** 03-01 and 03-11 now have scope notes. 03-02 (21 files) and 03-46 (15 files) still have neither a split nor a generated-files note. See finding 6.
- **W2 resolved.** 03-04 has a plan-level precondition. 03-11, 03-13b and 03-26 have `read_first` bullets that re-read the 02-2x files at HEAD.
- **W3 resolved.** 03-21 must_haves fix the exact `[Embedding Profile] MISMATCH ` and `STARTUP CHECK TIMEOUT` lines and the stored verdict, and Task 2 asserts them.
- **W4 resolved.** 03-30 depends on 03-01's legacy-shape trigger test and adds a legacy-writer row inserted after the migrations to its fixture.
- **W5 resolved.** 03-37 states that admin is deployment-scoped (T-03-136). It tests that a non-admin, including the document's owner or an organization member, gets 403 on list, release and delete, with no RPC called.

### Split and waves (check 2)

A script over all 49 plans found that every `depends_on` target exists and every plan's wave is greater than each dependency's wave. No two plans in the same wave share a `files_modified` entry. Every plan that consumes 03-13 also depends on 03-13b. 03-48 is in wave 12. Pass.

### Findings

**1. BLOCKER [context compliance / security], 03-07 Task 1: 03-07 must work correctly whether or not `requireRagAdmin` already exists at `src/lib/rag/tenant/admin.ts`.**
Evidence: the file does not exist at HEAD yet, but the running fix is building it to this plan's spec. 03-07 still says "implement requireRagAdmin" and "Output: tenant/admin.ts", and its tests are written first and expected to fail. If the guard lands first, the executor overwrites the security fix's file and tests. The gates are also wrong: `grep -c admin_users ... [HEAD=error:2]` and the `index.ts` gate `[HEAD=0 EXPECT>=3]` both have the wrong HEAD value.
Fix: add a precondition branch. If `src/lib/rag/tenant/admin.ts` exists, re-read it and its test file at HEAD. Verify it against the must_haves contract (401, 403 and 503 cases, the literal bearer `admin` rejected, no caching, the signal passed through). Add only the missing cases and the `@/lib/rag` export, and keep the fix's tests. Create the file only when it is absent. Make the grep gates hold in both cases, for example by asserting the end state without a HEAD notation that assumes the file is missing.

**2. BLOCKER [security, S6], 03-31 Task 1: under unified, a `/api/process-document` request with no session must return 401 in single-tenant mode as well.**
Evidence: the behavior line says "no session 401 in multi-tenant", which leaves single-tenant writes without a session allowed. HEAD now returns 401 without a session (route.ts L579-583, L601-643). `read_first` still cites the pre-fix "L548-845".
Fix: state in must_haves and behavior that no session gives 401 in both modes before any ingest call, with a single-tenant test where ingest is not called. Drop the quoted line range and re-read the route as the S6 fix left it.

**3. BLOCKER [security, S6], 03-23 Task 2: scrape and crawl under unified must require a session in single-tenant mode.**
Evidence: the single-tenant behavior line only says "the adapter gets s:default". The 401 case is listed only under multi-tenant. `read_first` cites "L40-120 ... verifyUserOrganizationAccess today", which describes the routes before the scrapers fix.
Fix: add "unified, single-tenant: no session gives 401 and the adapter is not called; with a session the adapter gets s:default". Replace the line-number bullet with a re-read of both routes at HEAD after the scrapers fix, and keep the fix's checks ahead of the pipeline branch, as 03-24 does.

**4. BLOCKER [security, S6], 03-32 Task 3: the unified upload branch must keep the upload fix's session check in both modes.**
Evidence: Task 3 edits `src/app/api/upload/route.ts`. HEAD now returns 401 'Authentication required' (L58-65). Neither must_haves nor behavior mentions a session or a 401, and `read_first` cites "L20-226 ... near L174-195" from before the fix. Under unified, the `after()` ingest path could run without a session.
Fix: add a must_have and behavior cases. No session gives 401 in single-tenant and in multi-tenant, and neither ingest nor `after()` is called. The scope comes from `resolveTenantScope` after the session check. Re-read the route at HEAD instead of using the quoted lines.

**5. BLOCKER [dependency / security], 03-33: 03-33 must run after the nango fix and build on it. The owner must be the session user who owns the connection, and `UNIQUE(connection_id)` must hold.**
Evidence: the plan has no precondition on the nango fix. It takes the owner from "the connection row's owner" without saying which row or column the fix makes authoritative, and it never mentions `UNIQUE(connection_id)`. Its gate `nangoOwnerScope ... [HEAD=0 @cf070c3]` and the `@src/lib/nango/document-adapter.ts` context predate the fix. The nango fix is still running and touches the same files, so the two can collide or 03-33 can rebuild the ownership lookup the fix replaces.
Fix: add a plan precondition. The nango fix has landed: its test file exists, the connections table carries `UNIQUE(connection_id)`, and connections are bound to the session user. Add `read_first` bullets to re-read `src/lib/nango/*` and `src/app/api/nango/*` at HEAD. State that `nangoOwnerScope` takes the owner from the single connection row the fix guarantees. Add a test where a sync for connection C never writes to or deletes from a tenant other than C's owner's.

**6. WARNING [scope], 03-02 (21 files) and 03-46 (15 files): each over-threshold plan should either be split or say which files are generated by one command.**
Evidence: W1 asked for this. Only 03-01 and 03-11 added scope notes.
Fix: add a scope note to each plan in the 03-11 form (which files come from `npm run gen:schemas` and how many are authored per task), or split 03-02 into ingest/parse and profile/eval contract groups.

**7. INFO, 03-30 objective: the "Finding for the orchestrator" about GET /api/images having no membership check is now out of date.** The images security fix has landed; `resolveTenantScope` appears in `src/app/api/images/route.ts`. Fix: delete the note, and have Task 1 re-read the images route at HEAD and keep its scope check.

**8. INFO, plan bodies: a `Claude-Session: https://claude.ai/...` commit-trailer line appears inside 49 plan files** (for example 03-23 L53, 03-30 L63, 03-33 L49). It does not affect execution. Fix: remove it from the plan prose.

**9. INFO, 03-21: the startup verdict reaches operators through the log line and through 03-26's per-request error, not through the Config UI status that W3 suggested.** This is acceptable. Optional: have 03-43 show `getStartupVerdict()`.

### Recommendation

5 blockers and 1 warning require revision. Findings 1-5 are local edits to 03-07, 03-23, 03-31, 03-32 and 03-33; none needs a re-plan or a wave change, apart from 03-33 gaining a precondition on the nango fix.

## Re-check (pass 3)

**Verdict: ISSUES FOUND, advisory-level only: 0 blockers, 1 warning, 1 info.** Every pass-2 blocker and W1 is resolved in the plan text. Execution can proceed once the warning is either fixed or explicitly accepted.

### Pass-2 items
- **1 (03-07) resolved.** L52/L54/L81 add a precondition: `admin.ts` must export requireRagAdmin and isAdminUser, and the plan stops if it does not. It also says "never recreates or rewrites the file", and the fix's tests become the regression set.
- **2 (03-31) resolved.** must_haves L23: no session gives 401 and a failing lookup gives 503 "in both pipelines and in both deployment modes", before any parse, ingest or storeDocument call. `read_first` L82 re-reads the route at HEAD.
- **3 (03-23) resolved.** L25 covers both modes and both pipelines, and the adapter is not touched. L106 re-reads both routes at HEAD.
- **4 (03-32) resolved.** L31 and L149: no session gives 401 in both modes, and neither storage, ingest nor `after()` runs. The scope is resolved before `after()`.
- **5 (03-33) resolved.** L54 adds a precondition on the nango fix (its test files, `unique_nango_connection_id` in both SQL files, the end_user check, and `session-user.ts`). L23 says the owner comes from the unique `nango_connections.user_id` row. T-03-95 adds a two-owner write and delete test.
- **W1 resolved.** 03-02 L70 and 03-46 L61 add scope notes that name the generated files.
- **Info 8 resolved.** No plan file contains the trailer line any more.

### Standard checks
- All 49 plans parse. Every depends_on target exists, and each dependency sits in an earlier wave. No two plans in the same wave share a file.
- The other checks from pass 2 still hold, and the revisions did not change them: requirement coverage, toggles that restore the old behaviour, the 03-48 baseline comparison, and tenant tests on new paths.
- 03-05 is still `autonomous: false`. Task 1 is `checkpoint:human-verify gate="blocking-human"` and is never auto-approved. **It remains a human gate.**

### S7 consistency
- No plan reintroduces a public write, `CORS *`, or a secret echo. 03-43 L55 forbids loosening the config and MCP routes or dropping forwarded auth headers.
- The 03-43 gate `/api/rag/` `[HEAD=0]` still measures 0 at HEAD.

**1. WARNING [S7 consistency], 03-37/03-39/03-40/03-43**
- **Required property:** the RAG admin routes use the same admin guard as the config and MCP routes. The Config UI reaches them with the admin session it already has, not a second sign-in.
- **Evidence:** the routes call requireRagAdmin, which accepts only a Supabase session or Bearer, and not the signed `admin_session` cookie. Because of that, 03-43 L27/L55 builds a separate Supabase password sign-in that keeps the access token in sessionStorage. L27 also forwards only "the Authorization header". S7's `withAuthHeaders` (config-server.js L75) already forwards both Cookie and Authorization, and `src/lib/admin-route-auth.ts` `requireAdminOrDeny` → `requireAdminRequest` accepts the cookie or Bearer, with the same 401/403/503 results.
- **Recommendation (the 03-43 question): yes, accept `requireAdminRequest` as well as Bearer.** The RAG admin routes should gate with `requireAdminOrDeny`/`checkAdmin` from `@/lib/admin-route-auth`. 03-43 should route its `/api/rag/*` proxy through `withAuthHeaders`. The Supabase password sign-in, the anon-key endpoint and the sessionStorage token should be dropped, or kept only as an optional fallback. The deny-path tests in 03-37/39/40 stay as they are, plus one case where a valid admin cookie is admitted and one where a forged cookie gets 401.

**2. INFO, S8 (not merged).** S8 touches generate-*, mcp/tools, config/reload, organizations, members, nango/sync and Polar. 03-33's precondition already waits on the nango fix. If S8 changes nango/sync scoping, 03-33 should re-read `src/app/api/nango/sync*` at HEAD, which its `src/app/api/nango/*` read_first already covers. No change is needed.

### Recommendation
Advisory only for blockers. Fix W1 with a local edit to 03-37/39/40 (the guard import) and 03-43 (the proxy and sign-in), or accept it as a known deviation.
