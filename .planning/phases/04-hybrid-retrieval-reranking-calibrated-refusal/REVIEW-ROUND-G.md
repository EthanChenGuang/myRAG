---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
round: G
reviewed: 2026-11-24T00:00:00Z
depth: deep
trunk: 1240877
files_reviewed: 17
files_reviewed_list:
  - src/app/api/rag/admin/ingest-jobs/_lib.ts
  - src/app/api/rag/admin/ingest-jobs/route.ts
  - src/app/api/rag/admin/ingest-jobs/[id]/route.ts
  - src/app/api/rag/admin/ingest-jobs/[id]/retry/route.ts
  - src/app/api/rag/admin/parse-budget/route.ts
  - src/app/api/rag/admin/parse-tiers/route.ts
  - src/lib/rag/ingest/parse-admin.ts
  - src/lib/rag/parents/expand.ts
  - src/lib/rag/v2/stages/context.ts
  - supabase/migrations/0408_profile_chunk_writer.sql
  - src/lib/rag/ingest/profile-chunks.ts
  - src/lib/rag/ingest/stages/embed-write.ts
  - src/lib/rag/ingest/chunkers/parent-child.ts
  - src/lib/rag/ingest/writer.ts
  - src/app/api/process-document/route.ts
  - src/lib/document-processor.ts
  - src/lib/rag/ingest/guard/cloud-budget.ts
findings:
  blocker: 1
  high: 1
  medium: 7
  low: 5
  total: 14
status: issues_found
---

# Round G review: admin ingest routes, parent expansion, profile chunk writer, legacy cloud guard, cloud budget

Read-only review of trunk `1240877` (plans 03.1-24, 04-27, 04-31, 03.1-21, 03.1-19). Round F findings are not repeated here.

## Summary

- **Cross-tenant leaks: none found.** `rag_fetch_parents` filters on `tenant_key`, `expandParents` checks the tenant key again and only attaches a parent from the child's own document, and `rag_write_profile_chunks` takes the tenant, organization and version from the document row it locked with `d.tenant_key = p_tenant_key`. A child from tenant A cannot reach tenant B's parent text.
- **Admin auth:** all seven handlers call `checkAdmin` before doing anything else. That check requires the cookie plus a live Supabase session for the same user, or `requireRagAdmin`. Job ids cannot be used across tenants (no IDOR): `rag_get_ingestion_job` filters by tenant key, and the retry and delete SQL re-check `rag_admin_tenant_keys`.
- **The main problem is functional (BLOCKER-1).** On a real PostgREST the job detail, retry and delete routes answer 404 for every existing job. The ledger reads single-composite RPC answers as if they were arrays. Neither the fake edge nor the PGlite adapters reproduce PostgREST's object answer, so no test can catch it.
- **The cloud switch fails open (HIGH-1)** for values like `0`, `off`, `no` and `disabled`.
- **Weaker than claimed:** org-scoped admin reads accept any membership role, the keyset cursor drops and repeats rows, and `document_parents.is_current` is never maintained.

## Verification performed

- `npx vitest run` on `tests/rag/ingest/admin-ingest-routes.test.ts`, `tests/rag/parents/expand.test.ts`, `tests/rag/v2/context-stages.test.ts`, `tests/rag/legacy-cloud-guard.test.ts`, `tests/rag/ingest/parent-child-chunker.test.ts` and `tests/rag/ingest/profile-dual-write.test.ts`: 148/148 pass.
- `node --import tsx --test tests/rag-db/parents-fetch.test.mts tests/rag-db/profile-chunk-writer.test.mts`: 24/24 pass.
- I ran a temporary PGlite probe, now deleted, against the migrations. It confirmed MEDIUM-3 (a parent stays `is_current = true` after its version is superseded, and `rag_fetch_parents` still returns it) and the three budget behaviours in MEDIUM-6.
- A tsx probe confirmed HIGH-1 (`loadQueueConfig` with `0`, `off`, `no` or `disabled` gives `parserAllowCloud: true`) and MEDIUM-2 (the cursor repeats and skips rows).
- I diffed the `rag_write_chunks` bodies in 0313 and 0408. They differ in exactly one line, the `chunking_profile_id = 'legacy'` predicate.
- BLOCKER-1 has not been run against a live PostgREST, because no live database is available. It rests on PostgREST's documented RPC semantics: a non-`SETOF` function answers with a single JSON value. The codebase already relies on this in `parse-admin.ts:66` and `backfill/batch-api.ts:228`.

---

## BLOCKER

### BLOCKER-1: The job detail, retry and delete routes answer 404 for every existing job on real PostgREST

**File:** `src/lib/rag/ingest/ledger.ts:103-125` (`callRpc` / `callOne`), `:240-254` (`getJobForScope`). Consumers: `src/app/api/rag/admin/ingest-jobs/[id]/route.ts:34,57`, `[id]/retry/route.ts:32`. SQL: `supabase/migrations/0353_ingestion_transitions.sql:361,410,466` (`RETURNS public.ingestion_jobs`, not `SETOF`).

**Issue:**
- `rag_get_ingestion_job`, `rag_retry_ingestion_job` and `rag_delete_ingestion_job` return a single composite. PostgREST answers a non-`SETOF` function with one JSON object, not an array.
- `callRpc` returns `(response.data ?? []) as Row[]`, and `getJobForScope` then reads `rows[0]`. On an object that is `undefined`, so `!row?.id` holds and the function returns `null`.

**Failure scenario:**
- An admin opens `GET /api/rag/admin/ingest-jobs/<id>` for a job the list just showed, and gets `404 Job not found`.
- Retry and delete look the job up through `getJobForScope` first, so they also answer 404 and can never run.
- The list works, because `rag_list_ingestion_jobs` is `SETOF`.

**Wider impact:** the same pattern affects every other ledger call to a single-composite function: `enqueueJob`, `claimJob` (single), `advanceJob`, `failJob`, `getJobForDocument` and `getJobInternal`. These fail with `no_row`, or return `null`, in production.

**Why tests are green:**
- `eval/harness/fake-edge.mts:527` always answers an RPC with `result.rows`, an array.
- The PGlite adapters run `SELECT * FROM fn(...)`, which also gives an array.
- The 03.1-24 executor normalised this correctly in `parse-admin.ts:66` but reused the ledger as it was.

**Fix:**
```ts
// ledger.ts callRpc
const data = response.data as unknown;
if (data === null || data === undefined) return [];
const rows = (Array.isArray(data) ? data : [data]) as Row[];
return rows.filter((row) => row && typeof row === 'object' && row.id !== null);
```
Then make the fake edge answer non-`SETOF` functions with `rows[0] ?? null`, checking `proretset` in `pg_proc`, so the suites model PostgREST.

---

## HIGH

### HIGH-1: `RAG_PARSER_ALLOW_CLOUD` fails open for every value except `false`

**File:** `src/lib/rag/ingest/queue-config.ts:93-101`, read live by `src/lib/rag/ingest/guard/cloud-budget.ts:90-99` (`liveConfig`). Every guard call depends on it, including the new legacy guard (`process-document/route.ts:191,910`, `document-processor.ts:167`).

**Issue:**
- `parseCloudAllowed` returns `true` for `''`, for `'true'` and for anything unrecognised. It only warns.
- Verified by running: `0`, `off`, `no` and `disabled` all give `parserAllowCloud: true`.
- The comment in `cloud-budget.ts:89` calls the switch a hard constraint (D-08, D-18). Elsewhere in the codebase an unknown boolean falls back to `false` (`queue-config.ts:85-90`).

**Failure scenario:** an operator who must keep documents in the deployment sets `RAG_PARSER_ALLOW_CLOUD=0` or `off`. Every upload still goes to LlamaCloud, and the only trace is a warning line.

**Fix:** treat `false`, `0`, `off`, `no` and `disabled` as `false`, and treat any other non-empty value as `false` too (fail closed, with the warning). Keep empty or unset as `true` so the current default does not change.

---

## MEDIUM

### MEDIUM-1: Org-scoped admin reads accept any membership role, but the SQL write paths require owner or admin

**File:** `src/app/api/rag/admin/ingest-jobs/_lib.ts:66-70` → `src/lib/rag/tenant/ingest-scope.ts:39-66` → `src/lib/rag/tenant/membership.ts:12-28` (no role filter). Compare `supabase/migrations/0316_quarantine_admin.sql:79-83` (`rag_admin_tenant_keys`: `role IN ('owner','admin')`).

**Issue:**
- `GET /ingest-jobs?organizationId=X`, `GET /ingest-jobs/<id>?organizationId=X` and `GET /parse-budget?organizationId=X` are honoured for an `admin_users` operator holding any `organization_members` row in X, including a plain member.
- The same operator is not in X's tenant keys for `rag_retry_ingestion_job`, `rag_delete_ingestion_job` or `rag_list_quarantine`.

**Failure scenario:**
- An operator who was added to a customer org as a `member` can list that org's job filenames, document ids, error classes, costs, page counts and monthly budget. These reads go beyond what the database grants that operator elsewhere.
- Retry and delete on those jobs then answer `409 not_retryable` / `409 not_deletable`. The SQL's `job_not_found` refusal is reported as a status conflict, which also contradicts the routes' "reads like an unknown id" contract.

**Fix:**
- For the admin routes, resolve the workspace against `rag_admin_tenant_keys(adminUserId)`, or add a `roles: ['owner','admin']` option to `isOrganizationMember`. Answer 403 otherwise.
- Map `ingest_refused` whose message is `job_not_found` to 404 rather than 409.

### MEDIUM-2: The keyset cursor compares at millisecond precision but the SQL order is microsecond, so pages repeat and skip rows

**File:** `src/app/api/rag/admin/ingest-jobs/_lib.ts:104-109`, used by `ingest-jobs/route.ts:132-150`. SQL order: `0353_ingestion_transitions.sql:525` (`ORDER BY created_at DESC, id DESC`, microseconds).

**Issue:** `isAfterCursor` compares `Date.parse()` values, which have millisecond precision. When two jobs fall in the same millisecond but differ in microseconds, the code falls back to comparing ids. That disagrees with the database order.

**Failure scenario:** verified with three rows created at `.123900`, `.123500` and `.123100`. With the cursor at the middle row, the next page returns the first row again and never returns the third. Jobs created in quick succession (backfill enqueue, Nango sync) are therefore hidden from, or listed twice to, the operator.

**Fix:** move the keyset into SQL by adding `p_before_created_at timestamptz, p_before_id uuid` with `WHERE (j.created_at, j.id) < (p_before_created_at, p_before_id)`. This also removes the 100-call scan (LOW-2). At minimum, compare the full microsecond timestamp strings after normalising them to UTC.

### MEDIUM-3: `document_parents.is_current` is always `true` and never updated, so the currency filter in `rag_fetch_parents` does nothing

**File:** `supabase/migrations/0408_profile_chunk_writer.sql:105` (parents insert `true`) and `:117` (upsert keeps it). `0313_write_chunks_profiles.sql` `rag_publish_document_version` flips only `documents` and `document_chunks`. `0404_document_parents.sql:108` filters on `p.is_current`.

**Issue:**
- The 0408 header says the currency of every row is copied from the document row. For parents it is not.
- Verified by running: before publish the document is not current but its parent is; after v2 supersedes v1, v1's parent is still `is_current = true`, and `rag_fetch_parents` still returns it.

**Impact:**
- This is not a cross-tenant path. `expandParents` requires the parent's `document_id` to equal the child's, and children come from current rows only.
- It does make the SQL currency filter, and the JS `is_current === false` check, inert. Any future caller that fetches by parent id gets superseded, unpublished or quarantined text.
- The 0405 RLS policy is safe because it joins `documents` itself.

**Fix:** in `rag_fetch_parents`, join `documents d ON d.id = p.document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'`. Write `doc.is_current` in 0408, and have the publish and quarantine functions update `document_parents.is_current` alongside `document_chunks`.

### MEDIUM-4: The deployment-wide parse-tier override can be changed by any operator, affecting every tenant

**File:** `src/app/api/rag/admin/parse-tiers/route.ts:97-127`, `src/lib/rag/ingest/parse-admin.ts:157-166`, SQL `0354_parse_budget.sql:264-330`. The table `rag_parse_tier_overrides` has no tenant column, as the executor flagged.

**Issue:**
- In multi-tenant mode, any `admin_users` operator, including one scoped to their own tenants elsewhere, can set `minTier: 'premium'` for a document type.
- That moves every tenant's queued documents of that type to the premium cloud tier, which changes both spend and where the bytes are sent.
- The audit row is written with tenant `s:default` even in multi-tenant mode.
- The SQL checks only that `p_actor` is not null, not that it is in `admin_users`. That is unlike `rag_admin_tenant_keys`.

**Fix:**
- In multi-tenant mode, refuse PUT unless the actor is a deployment owner (a new flag on `admin_users`), or make the overrides per tenant (`tenant_key` in the primary key, falling back to a global row).
- Check `admin_users` inside `rag_set_parse_tier_override`.

### MEDIUM-5: Dual-write children leave out image and invoice-header chunks, so an active profile hides them from retrieval

**File:** `src/lib/rag/ingest/stages/embed-write.ts:150-218` (builds children from `ctx.work.parseText` only), `src/lib/rag/ingest/stages/images.ts:313-341` (picture chunks are appended to the legacy set), `supabase/migrations/0407_hybrid_search_chunks.sql:106-112`.

**Issue:** `hybrid_search_chunks` uses a document's legacy rows only when it has no rows of the effective profile.

**Failure scenario:**
1. A PDF is ingested with `RAG_PDF_IMAGE_CHUNKS=true` under `RAG_PIPELINE=v2`.
2. A non-legacy profile for its doc type is later activated, or set through `p_chunking_override` in evaluation.
3. Text retrieval now returns profile children, and the document's legacy `chunk_kind='image'` rows can no longer be retrieved.
4. `source_images` stop streaming for that document, which regresses behaviour AGENTS.md §14 says to preserve.

The same happens to extractor-added `invoice_header` chunks.

**Fix:** copy the image and invoice-header drafts into each profile as parentless children (`parent_index: null`), or have the hybrid predicate always keep legacy rows whose `chunk_kind IN ('image','invoice_header')`.

### MEDIUM-6: The budget reservation contract breaks for batches without a budget, retried jobs and repeated VLM calls

**File:** `src/lib/rag/ingest/guard/cloud-budget.ts:166-197`, SQL `0354_parse_budget.sql:20-80,171-204`, `0351_ingestion_schema.sql:253` (`UNIQUE (job_id, attempt_no, kind)`).

All three behaviours below were verified by running. No caller sets `request.guard` yet (the 03.1-19 summary defers this to 03.1-34), so the problem is latent, but 03.1-34 inherits it.

1. **Batches without a budget:** `rag_reserve_batch_budget` updates only rows where `budget_usd IS NOT NULL`. A batch created with no budget (`rag_create_backfill_batch`, where `p_budget_usd` defaults to NULL) therefore refuses every metered call with `batch_budget_exhausted`.
2. **Retried jobs:** `attemptNo ?? 1`, together with the unique constraint, means that once a reservation has been settled or released, a new reserve for the same job, attempt and kind does not return false. It raises `23505`, which surfaces as `CloudGuardError` (a hard failure, not a refusal). A job requeued by `rag_retry_ingestion_job` (which resets `retries = 0`) hits this as soon as the attempt number repeats.
3. **Repeated VLM calls:** only one VLM reservation can exist per attempt. A second L3 call in the same attempt gets `false`, reported as `budget_exhausted` even with budget left, while the first is open, and gets the unique-violation error after it is settled.

**Fix:**
- Treat `budget_usd IS NULL` as unlimited (`RETURN true`).
- Have the SQL return `true` when an open reservation already exists (idempotent).
- Derive `attempt_no` from `rag_record_parse_attempt`, which grows monotonically.
- Key VLM reservations by a per-call sequence, or reserve all VLM pages for an attempt at once.

### MEDIUM-7: The public `@/lib/rag` export `listJobs` lists every tenant's jobs when no scope is passed

**File:** `src/lib/rag/index.ts:118`, `src/lib/rag/ingest/ledger.ts:279-301` (`scope?: TenantScope | null`, giving `p_tenant_key = NULL`), SQL `0353:518` (`p_tenant_key IS NULL OR ...`).

**Issue:**
- This round made `listJobs` part of the public RAG API. Any route can call `listJobs({ statuses: null }, …)` and receive every tenant's jobs, including filenames.
- That is a switch that turns the tenant check off, which AGENTS.md §6 rules out.
- The admin route passes a scope today, so nothing leaks yet.

**Fix:** make `scope` required on the exported function, and keep an internal `listJobsAllTenants` for worker or ops code that is not exported from the index.

---

## LOW

### LOW-1: The batch's USD reservation is never refunded, and settle under-counts pages

**File:** `cloud-budget.ts:186-196,212-230`, `0354:82-129,171-204`.

- `release()` gives back pages but never the batch's `spent_usd`, so failed cloud calls permanently use up the batch budget.
- `settle` records `LEAST(p_pages_used, rec.pages)`. When the actual page count is higher than the estimate, the monthly budget is under-counted.

**Fix:** add `rag_release_batch_budget(job, usd)`, called by `giveBack` and `release`, and record the actual pages on settle, flagging any overrun.

### LOW-2: Listing with a cursor scans up to 100 sequential RPCs, never reaches past 10,000 jobs, and can duplicate rows

**File:** `ingest-jobs/route.ts:121-150`.

- Each cursored request re-reads from offset 0.
- Any job older than position 10,000 cannot be reached (`Cursor is too far back`).
- A job inserted during the scan shifts later offsets by one, so a row can appear twice in `found`.

**Fix:** the SQL keyset described under MEDIUM-2.

### LOW-3: One row that fails the strict schema makes the whole list answer 503

**File:** `ledger.ts:97-101,300`, `contracts.generated.ts` (`IngestionJobSchema … .strict()`, strict `settings`).

A single legacy or malformed job row makes `parseJobRow` throw `invalid_row`. That fails the whole list for the tenant, and the admin cannot find the row to delete it.

**Fix:** in `listJobs`, skip rows that fail validation and count them, logging the id only.

### LOW-4: The legacy guard still logs file names on refused requests, and image captions are not gated

**File:** `process-document/route.ts:784,876` (`[ProcessDocument] File:`, `Processing file:`) and `document-processor.ts:392` (`Processing document: ${filename}`).

- These lines predate this round but run before the new guard, so a refused request still logs the file name. The new guard lines themselves are clean.
- `processImageDocument` (GPT-4o vision, `/api/upload`) still sends bytes out when the switch is off. The 03.1-21 summary discloses this.

**Fix:** drop the name from those lines, or log its length only, and gate `processImageDocument` with `assertCloudAllowed('vlm')`. Decide the second point in a follow-up plan.

### LOW-5 (predates this round, next to the 03.1-21 change): path traversal in the legacy processor's temp file

**File:** `src/lib/document-processor.ts:399-401`.

- `path.join(os.tmpdir()/myrag, filename)` writes the file to a path built from a provider-supplied name (Nango `file.name`, `sync-manager.ts:396,550,1265,1376`). Google Drive allows `/` in file names.
- A shared file named `../../<path>` is written outside the temp directory on self-hosted deployments.

**Fix:** use `path.join(tempDir, `${randomUUID()}${path.extname(path.basename(filename))}`)`.

---

## Checked and not an issue

- **Admin auth:** `checkAdmin` runs first in all seven handlers (list GET, detail GET and DELETE, retry POST, parse-budget GET, parse-tiers GET and PUT). The `admin_session` cookie only works with a matching live Supabase session and a fresh `admin_users` lookup (`admin-session.ts:109-130`). Retry and delete never read a body, and the actor is the verified id.
- **Job id across tenants (IDOR):** `rag_get_ingestion_job` filters on `tenant_key`. Retry and delete re-check `rag_admin_tenant_keys` under `FOR UPDATE`, and the job's tenant cannot change between the lookup and the write.
- **Cursor tampering:** the cursor schema is strict (a datetime and a UUID). A forged cursor can only change which of the caller's own jobs are scanned; the scope comes from the server.
- **Field allow-list:** `projectJob` and `projectJobDetail` never return `original_ref`, `settings`, `stage_state`, `source_key`, `file_sha256`, `locked_by`, `timings` or `trace_id`. `attempts` and `page_ranges` are enum and number data only.
- **Error leaks:** all routes log only `error.name` plus the RPC and code, and answer fixed strings.
- **04-27 tenant isolation:** `rag_fetch_parents` is `SECURITY INVOKER` with execute granted to service_role only, and calls `rag_assert_tenant_key`. JS re-checks the tenant key, that the id was asked for, and that the document is the same. Scope keys are lowercased at mint time. When the stage fails it falls back to the selection without parents ("skip").
- **0408 writer:** it locks the document with `tenant_key = p_tenant_key` (otherwise `tenant_mismatch`) and refuses `failed`/`deleted` documents, `legacy`, and retired profiles or profiles for another doc type. Tenant, organization, version and status come from the document row. Parent and child ids include the document id, and the `ON CONFLICT … WHERE document_id` guard holds. It is `SECURITY DEFINER` with `search_path = pg_catalog, public`. PUBLIC, anon and authenticated lose execute, service_role gets it, and both 0408 and 0410 apply that.
- **0408 `rag_write_chunks`:** identical to 0313 apart from the `chunking_profile_id = 'legacy'` predicate (diffed).
- **Legacy behaviour:** dual-write runs only under `RAG_PIPELINE=v2`. Legacy readers (`match_documents*`, `match_document_chunks*`, `match_chunks_by_profile`) keep `status = 'ready'`, and the 0404 trigger turns profile children into `variant`.
- **03.1-21:** the guard comes after the session, KB-write and organization checks and before any LlamaCloud request. `uploadToLlamaCloud` and `uploadAndParseDocument` check again. Markdown stays local.
- **03.1-19:** the monthly reservation is atomic (a conditional upsert under the row lock). The tenant comes from the job row on the server, never from the caller. Any database error, missing database or unexpected answer fails closed.

---

_Reviewer: Claude (gsd-code-reviewer), round G, depth deep_
