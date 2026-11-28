<!-- generated-by: gsd-doc-writer -->
# Live runbook for the operator

Steps you run by hand against the real Supabase project, the sidecar host and the vendor accounts. Written 2026-11-25 from trunk `claude/ecstatic-hamilton-86gtwv`. Every key, URL, tenant and path below is a placeholder.

**Conventions**

- `$DATABASE_URL` is the direct Postgres connection string (Supabase dashboard, Project Settings, Database, direct connection, not the pooler). Run all SQL with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1`. Do not run schema changes through PostgREST or the management API: the `authenticator` role has an 8 s statement timeout.
- `$MODE` is your deployment mode: `single-tenant` or `multi-tenant` (`MYRAG_DEPLOYMENT_MODE` in `.env.local`, default `single-tenant`). The live project recorded in the Phase 3 live summary is `multi-tenant`.
- Run commands from the repository root on trunk.
- When a step fails, stop. Migrations are idempotent, but they are one-way: the backup from step 1.1 is the only rollback.
- Evidence you send back (section 7) is counts, verdicts and numbers only. Never paste keys, tenant ids, file names, queries, chunk text or document text.

Terms: RLS = row-level security. SQLSTATE = the five-character Postgres error code. p50 / p95 = 50th / 95th percentile. vCPU = virtual CPU. HHEM = Hughes Hallucination Evaluation Model.

---

## 1. Before you start

**1.1 Back up, or rehearse on a copy.**
Take a full backup (dashboard backup, or `pg_dump "$DATABASE_URL" -Fc -f backup.dump`). Better: restore it into a Supabase branch or a second project and run sections 2 to 4 there first, then repeat on production.
Check: you can name the backup and its date. If it fails, stop; do not migrate without it.

**1.2 Deploy trunk to the app first.**
Migrations 0409 and 0410 remove anon and authenticated access to the search functions. The previous app version searched with the user client and stops finding documents after that. Every server that runs chat or embed retrieval needs `SUPABASE_SERVICE_ROLE_KEY`.
Check: ask one question in the deployed app and get an answer with sources. If it fails, roll back the app and do not apply block B in section 2.

**1.3 Check that pgvector is in schema `public`.** (query from the header of 0425)

```sql
SELECT extname, extnamespace::regnamespace FROM pg_catalog.pg_extension WHERE extname = 'vector';
SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'vector';
SHOW lc_ctype;
SELECT count(*) FROM document_chunks;
```

Check: `vector` is in `public`; version 0.7.0 or later (needed for `halfvec`), ideally 0.8.0 or later; record `lc_ctype` and the chunk count.
If it fails: if `vector` is in another schema, stop; 0425 stops with SQLSTATE 55000. Send the output to Claude. Do not act on Supabase lint 0014 (`extension_in_public`) for `vector`.
Below 0.8.0: keep `RAG_HNSW_ITERATIVE_SCAN=off`; the exact-scan cutoff covers it.

**1.4 Find the first migration that is not live.**

```sql
SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 5;
SELECT to_regprocedure('public.rag_claim_ingestion_jobs(text,integer,boolean,text)');   -- NULL: 0352 is not applied
```

Check: the last migration confirmed live is 0351 (multi-tenant project, 2026-11-24). Migrations pasted into the SQL editor may not appear in `schema_migrations`, so also trust the catalog. If your database is older than 0351, list everything with `bash scripts/setup-database.sh --list-migrations $MODE` and start from the first file you lack. Fresh projects use the setup file instead: run `supabase/single-tenant-setup.sql` or `supabase/multi-tenant-setup.sql`, then the ordered files under `supabase/migrations/`. The setup files already fold 0301 to 0320, 0351 to 0359, 0401 to 0413 and 0420 to 0424 (per `AGENTS.md` section 6); Phase 6 is not folded yet. So on a fresh project apply the setup file, then continue at block D below (0425 and later), keeping the verification queries and the 0425 dry run. Never re-run a setup file on an existing database.

---

## 2. Apply migrations, in order, per deployment mode

Print the order for your mode (common file first, then the `.single-tenant.sql` or `.multi-tenant.sql` file of the same number):

```bash
bash scripts/setup-database.sh --list-migrations $MODE | sed -n '/0352_ingestion_claim/,$p'
```

Helper for the blocks below (stops at the first error):

```bash
apply() { for f in "$@"; do echo "== $f"; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "supabase/migrations/$f" || return 1; done; }
```

Never re-run a setup file on an existing database. After any re-run of a migration below 0425, re-run 0425 (common file, then mode file).
Only if the database is older than 0316: apply `0316_quarantine_access.$MODE.sql` before `0316_quarantine_admin.sql` (two stems; `--list-migrations` already prints this order). The live multi-tenant project has both.

### Verification queries (run after every block)

**V1. Function grants.** Only the real-time topic helper may be executable by `authenticated`, and nothing by `anon`.

```sql
SELECT p.oid::regprocedure AS fn,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
FROM pg_catalog.pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND (p.proname LIKE 'rag\_%' OR p.proname IN ('match_chunks_by_profile', 'hybrid_search_chunks'))
  AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
ORDER BY 1;
```

Expect: zero rows before block A; afterwards exactly one row, `rag_ingest_realtime_topic_allowed(text)` with `anon = f`, `authenticated = t`.

**V2. `search_path` of definer and `rag_*` functions.**

```sql
SELECT p.oid::regprocedure AS fn, p.proconfig
FROM pg_catalog.pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
  AND (p.prosecdef OR p.proname LIKE 'rag\_%')
  AND NOT (coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']);
```

Expect: through block C, no row has `proconfig` NULL (rows with `search_path=pg_catalog, public` or `search_path=public` are normal until 0425). After block D: zero rows. Do not fix rows by hand; send them to Claude.

**V3. RLS on the new tables.**

```sql
SELECT relname, relrowsecurity FROM pg_catalog.pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
  AND relname IN ('ingestion_jobs','ingestion_batches','ingestion_jobs_archive','rag_parse_cache','rag_parse_budget_usage',
                  'rag_parse_budget_reservations','rag_parse_tier_overrides','rag_embed_batches','chunking_profiles','chunking_build_runs',
                  'chunking_build_gaps','document_parents','rag_answer_records','rag_semantic_cache','vector_sync_outbox',
                  'rag_vector_sync_targets','rag_backend_index_state')
ORDER BY 1;
```

Expect: every listed row has `relrowsecurity = t`. Tables of blocks you have not applied yet are absent.

**V4. Anon and authenticated are refused.**

```sql
\set VERBOSITY verbose
BEGIN; SET LOCAL ROLE anon;          SELECT * FROM public.rag_claim_ingestion_jobs('check', 1, false); ROLLBACK;
BEGIN; SET LOCAL ROLE authenticated; SELECT * FROM public.rag_claim_ingestion_jobs('check', 1, false); ROLLBACK;
BEGIN; SET LOCAL ROLE anon;          SELECT count(*) FROM public.ingestion_jobs; ROLLBACK;
```

Expect: `permission denied`, SQLSTATE 42501, on each. A table read that returns 0 rows instead of an error is protected by RLS only: record it and tell Claude.
Through PostgREST with the real anon key (placeholders):

```bash
curl -s -w '\n%{http_code}\n' "$SUPABASE_URL/rest/v1/rpc/rag_claim_ingestion_jobs" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' \
  -d '{"p_worker":"check","p_limit":1,"p_allow_batch":false}'
```

Expect HTTP 401 or 403 with code `42501`.

If any query fails its expectation, stop and send the output to Claude. Do not apply the next block.

### Block A: Phase 3.1 ledger (0352 to 0359)

```bash
apply 0352_ingestion_claim.sql 0353_ingestion_transitions.sql 0353_ingestion_transitions.$MODE.sql \
      0354_parse_budget.sql 0355_parse_cache.sql 0356_backfill.sql 0357_soft_delete.sql 0358_progressive.sql 0359_vectors_complete.sql
```

Check: V1, V2, V3, V4. Also (real-time policy):

```sql
SELECT policyname, cmd FROM pg_catalog.pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages';
SELECT pg_catalog.pg_get_functiondef('public.rag_ingest_realtime_topic_allowed(text)'::regprocedure);
```

Expect: policy `rag_ingest_broadcast_read` is present and is the only policy these migrations created on `realtime.messages`. On a multi-tenant project the function definition never contains `s:default`; on single-tenant it allows only `rag-ingest:s:default`. In the dashboard (Project Settings, Realtime), `Allow public access` must be off.

### Block B: Phase 4 (0401 to 0413; includes the grants lock-down 0409, 0410 and 0411)

If `document_chunks` is large (the 1.3 count is in the tens of thousands or more), tell Claude before this block: the lexical GIN (generalized inverted index) should be built with `CREATE INDEX CONCURRENTLY` on a direct session first.

```bash
apply 0401_lexical_index.sql 0402_relex_batch.sql 0403_tenant_key_guard.$MODE.sql 0404_document_parents.sql \
      0405_document_parents_rls.$MODE.sql 0406_chunking_profiles.sql 0407_hybrid_search_chunks.sql 0408_profile_chunk_writer.sql \
      0409_search_rpc_revoke.sql 0410_security_definer_rpc_grants.sql 0411_security_definer_search_path.sql \
      0412_rechunk_functions.sql 0413_chunking_activation.sql
```

Check: V1 to V4. Then `NOTIFY pgrst, 'reload schema';` is already issued by the files; if PostgREST says "function not found", run it once more.

### Block C: Phase 3.1 queue follow-ups (0420 to 0424)

```bash
apply 0420_ingestion_queue_retention.sql 0421_ingestion_queue_indexes.sql 0422_ingestion_dead_letter.sql \
      0423_ingestion_claim_lease_dead_letter.sql 0424_write_chunks_null_vector.sql
```

Check: V1 to V3.

### Block D: 0425 empty `search_path` (dry run first)

Run the md5 dry run after block C and before 0425. It compares the live body of every function 0425 will replace with the hash the repository expects before 0425 (`supabase/migrations/0425_expected_pre_hashes.json`):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
\set expected `cat supabase/migrations/0425_expected_pre_hashes.json`
\set mode multi-tenant
SELECT x.sig, x.md5 AS expected, pg_catalog.md5(p.prosrc) AS live
  FROM pg_catalog.jsonb_each_text((:'expected')::jsonb -> :'mode') AS x(sig, md5)
  LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(x.sig)
 WHERE p.oid IS NULL OR pg_catalog.md5(p.prosrc) <> x.md5
 ORDER BY 1;
SQL
```

Change `multi-tenant` to `single-tenant` if that is your mode. This is the header query of 0425 with the two placeholders filled by psql variables.
Check: no rows. A row means that function is missing or its live body differs from the expected one (a skipped body-only migration such as 0424, or a hand fix). 0425 would overwrite it without notice.
If rows appear: compare `pg_get_functiondef` of each with the repository, apply any skipped earlier migration, re-run the dry run. Send unexplained rows to Claude. Do not apply 0425 until the list is empty or explained.

Then:

```bash
apply 0425_search_path_empty.sql 0425_search_path_empty.$MODE.sql
```

Check: V1 to V4. V2 must now return zero rows. If the first block of 0425 stops with 55000, see 1.3.

### Block E: Phase 5 answer records (0501, 0502)

```bash
apply 0501_rag_answer_records.sql 0502_rag_answer_records_tenant.$MODE.sql
```

Check: V1 to V3. One-way (the table, its policies and grants).

### Block F: Phase 6 (0601 to 0603), then 0410 again

```bash
apply 0601_tenant_language_shares.sql 0602_hybrid_include_undated.sql 0603_semantic_cache.sql
apply 0410_security_definer_rpc_grants.sql
```

0602 replaces a published function signature (one-way; callers that omit the new parameter keep working). 0603 adds a table, functions, triggers and grants (one-way). Re-running 0410 locks the three new trigger functions.
Check: V1 to V3.

### Block G: Phase 7 vector sync (0701 to 0703), then 0410 once more

```bash
apply 0701_vector_sync_outbox.sql 0702_vector_sync_triggers.sql 0703_vector_sync_claim.sql
apply 0410_security_definer_rpc_grants.sql
```

Both backends ship disabled and nothing is enqueued, so there is no behaviour change. The second 0410 run is my addition: 0410 also lists the ten `rag_vector_sync_*` trigger functions, so running it last is harmless and closes any default grant they received.
Check: V1 to V4 once more. If a new `NOTIFY` is needed, run `NOTIFY pgrst, 'reload schema';`.

---

## 3. Phase 3.1 live checkpoints (03.1-53 and 03.1-54)

Run after section 2 block A (and ideally all blocks).

### 3.1 Choose the sidecar worker host (03.1-53, task 1)

**Decision.** The worker polls the queue, so the host must stay on: no scale-to-zero, one machine, at least 4 GB RAM and 2 vCPU as the starting point, one parse worker (the voice agent's 512 MB machine is far too small for Docling layout, table and OCR models). Example: a Fly.io machine with `min_machines_running = 1` and auto-stop off. Record host, size and region.

**Build the image** from the `docling` target:

```bash
docker build --target docling -t rag-sidecar:docling rag-sidecar
```

**Set these in the host's secret store** (never in the repository). Worker stays off until step 3.4:

```
RAG_SIDECAR_SECRET=<same value as the app, 32+ characters>
NEXT_PUBLIC_SUPABASE_URL=<https://project-ref.supabase.co>
SUPABASE_SERVICE_ROLE_KEY=<service role key: legacy JWT or sb_secret_ form>
RAG_APP_INTERNAL_URL=<production app URL the host can reach; not a protected preview>
RAG_INGEST_WORKER=off
RAG_INGEST_WORKER_CONCURRENCY=2
```

The other worker settings (`RAG_INGEST_APP_RATE`, `RAG_INGEST_MAINTENANCE*`, `RAG_INGEST_JOB_RETENTION_DAYS`) have defaults in `rag-sidecar/.env.example`. The app side needs `RAG_SIDECAR_URL` (this host) and the same `RAG_SIDECAR_SECRET`.

**Check:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<sidecar host>/health                                   # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "x-sidecar-secret: $RAG_SIDECAR_SECRET" https://<sidecar host>/ready   # 200
```

If it fails: `/ready` without the header answers 503 by design. If it is 503 with the header, read the machine log and the memory (out-of-memory kills look like restarts); raise RAM before anything else.

**Known open problem, ask Claude to fix before step 3.5:** `rag-sidecar/Dockerfile` copies no `config/` directory, so `config/rag/parse-routing.json` and `processing-profiles.json` are missing in the image and a deployed worker cannot run tiered jobs. It was still true on trunk when this runbook was written.

### 3.2 Schema checks on the live project (03.1-53, task 2)

Section 2 block A and V1 to V4 are this task. In addition, with every Phase 3.1 switch at its default, upload one document through the app.
Check: no `ingestion_jobs` row appears (`SELECT count(*) FROM ingestion_jobs;` is unchanged).
If it fails: a switch is not at its default (`RAG_INGEST_ASYNC` must be `off`); fix `.env.local` and the deployment environment, then repeat.

### 3.3 Concurrent-claim proof on real Postgres (03.1-53, task 3)

**A. Local real-Postgres test (the main proof).** `tests/rag-db/ingestion-ledger-pg.test.mts` starts its own throwaway PostgreSQL on 127.0.0.1 port 55432, applies the setup file and migrations 0351 and 0352, enqueues 600 jobs, then drains them with 8 concurrent sessions and asserts every job is claimed exactly once. It never touches the live project. Requirements: Node 22, a non-root user (`initdb` refuses root), `pg_ctl` on `PATH` or under `/usr/lib/postgresql/*/bin`, and pgvector 0.7 or later installed for that PostgreSQL.

```bash
id -u                                    # must not print 0
pg_ctl --version
grep default_version "$(pg_config --sharedir)/extension/vector.control"
node --import tsx --test tests/rag-db/ingestion-ledger-pg.test.mts
```

Check: the test `600 jobs claimed once across 8 concurrent sessions when pg_ctl is available` is reported as passed, not skipped. A skipped run prints the reason (`pg_ctl not found`, `initdb refuses to run as root`, `pgvector extension not installed for this PostgreSQL`, or `pgvector older than 0.7`); a skip is not proof.
If it fails: `duplicate claim <id>` is a real defect: do not turn the worker on, send the output to Claude. If port 55432 is busy, stop the other PostgreSQL. Allow up to 3 minutes.

**B. Live-database claim check (03.1-53 task 3, optional once A passes).** Needs a dedicated test user and an enqueue helper that the plan does not name: ask Claude for the exact enqueue command when you get here. The plan: enqueue 50 `dry_run` jobs for the test tenant against one small synthetic PDF (`eval/fixtures/parse/pdf/digital-text.pdf`), run two workers at once (the deployed sidecar with `RAG_INGEST_WORKER=on` plus a second local sidecar on the same project) until the queue is empty, then:

```sql
SELECT count(*), count(DISTINCT id) FROM ingestion_jobs WHERE tenant_key = '<test tenant>' AND kind = 'dry_run';
```

Check: both counts are 50 and every job has exactly one initial attempt. Delete the test jobs and cache rows for the test tenant, then set `RAG_INGEST_WORKER` back to the value you intend.

### 3.4 Deployed worker and real-time status (03.1-54, task 1)

Set on the sidecar host: `RAG_INGEST_WORKER=on`. Set on the app, in a non-production environment only: `RAG_INGEST_PIPELINE=unified`, `RAG_INGEST_ASYNC=on`.

1. Upload a 10 to 20 page digital PDF in the chat knowledge base. Check: the upload answers 202 and the badge moves to `ready`. Note the seconds from upload to ready.
2. Set `NEXT_PUBLIC_RAG_INGEST_REALTIME=true`, redeploy, repeat. Check in the browser network panel: broadcast events arrive on your private topic. While a job runs, sign in as a user of another tenant in a second browser: no events arrive there.
3. Stop the sidecar during a job, restart it. Check: the job resumes after its lease expires and the document has no duplicate chunks.

If it fails: read the sidecar log first (callback URL unreachable, wrong secret, service key rejected are the usual causes); then send the log lines without document content to Claude.

### 3.5 Routed dry run on your real documents (03.1-54, task 2)

Needs a representative folder or bucket of your documents, `LLAMA_CLOUD_API_KEY` set, `RAG_PARSE_ROUTING=tiered` (needs `RAG_INGEST_PIPELINE=unified` and `RAG_INGEST_ASYNC=on`; otherwise it falls back to Phase 3 behaviour with a warning), the Dockerfile fix from 3.1, and your decision on `RAG_PARSE_PREMIUM_PAGE_BUDGET`.

1. Dry run, no budget (the command stops after the report, exit 2):
   ```bash
   npm run rag:backfill -- --tenant <tenant> --source folder:<path>
   ```
   Record the class shares, projected pages per tier, projected L2 and L3 pages, projected cost and wall time from the printed report.
2. If you agree with the projection, run with a budget slightly above it:
   ```bash
   npm run rag:backfill -- --tenant <tenant> --source folder:<path> --budget <USD>
   ```
   Record actual against projected cost, the `needs_review` count and its reasons. If interrupted, `--resume <batch_id>` continues.
3. During the run, upload five digital PDFs of at most 20 pages and record each 202-to-ready time. Check: p95 is at or under the 60 s target; per-stage p95 comes from `ingestion_jobs.timings`.
4. If real cost or seconds per page are far from `config/rag/parse-routing.json`, only record the measured values. Do not edit thresholds.

If it fails: a failed dry run costs nothing; send the error. If actual cost exceeds the budget, the run stops by design; record it.

### 3.6 Real Batch API job and real parser numbers (03.1-54, task 3)

1. With `OPENAI_API_KEY` set and `RAG_EMBED_BATCH_MODE=batch_api`, run a backfill of about 20 small documents with a budget:
   ```bash
   RAG_EMBED_BATCH_MODE=batch_api npm run rag:backfill -- --tenant <tenant> --source folder:<path of 20 small documents> --budget <USD>
   ```
   Check: the batch is recorded before polling, completes, vectors map by `custom_id`, the documents publish and are retrievable. Record batch duration and billed tokens.
2. Parser numbers: record real outputs of the parse test set with the `docling` image and with LlamaParse (the real-recording mode of the `03.1-13` builder, `eval/fixtures/parse/build_recorded.py`), then run `python -m rag_eval.parser_eval` on them (from `eval/`). Record per-tier text similarity, table F1, reading order, headings, seconds and cost per page next to the CI numbers.

If it fails: send the error text; for a batch that never completes, send the batch id and status (not document content).

---

## 4. Phase 4 live checkpoints (04-43)

Run after section 2 blocks B to D. Keys are placeholders in `.env.local`; never commit it.

### 4.1 Live Supabase: inventory, relex, Chinese search, anon, parity (task 1)

Inventory is step 1.3; migrations are blocks B to D; V1 to V4 already cover the grants.

1. Rebuild the lexical text: dry run, then the real run; interrupt it once with Ctrl-C and run it again to confirm it resumes; then vacuum.
   ```bash
   npm run rag:relex -- --dry-run
   npm run rag:relex
   npm run rag:relex                       # after one Ctrl-C of the previous run
   psql "$DATABASE_URL" -c 'VACUUM (ANALYZE) document_chunks;'
   ```
   Record rows per tenant and the duration. If it fails, rerun: it is resumable.
2. Chinese exact-term search: in a non-production app with `RAG_PIPELINE=v2` and `RAG_LEXICAL_SEARCH=true`, ask for a Chinese exact term (a model number or ID from your real knowledge base), once per tenant kind (personal and organization on multi-tenant). Check: the expected chunk appears in the lexical leg (see the `[Document Search]` log or the evaluation trace). The plan names the call but no script; ask Claude for a helper if you prefer. Record only found or not, the leg and the rank.
3. Anon refused through PostgREST (real anon key):
   ```bash
   curl -s -w '\n%{http_code}\n' "$SUPABASE_URL/rest/v1/rpc/hybrid_search_chunks" \
     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' \
     -d '{"p_tenant_key":"s:default","p_profile_id":"openai-3-small-1536","p_query_embedding":"[0]","p_lexical_tokens":["x"],"p_dense_limit":1,"p_lexical_limit":1}'
   ```
   Check: SQLSTATE 42501. If you get 404 `PGRST202` the call shape did not match; rely on V1 (it lists `hybrid_search_chunks`) and tell Claude.
4. Legacy parity run against the live app:
   ```bash
   npm run test-rag -- --base-url <app url> --baseline <live baseline> --out eval/out/live-p4-parity
   ```
   Check: no regression beyond the noise band. If it regresses, set the Phase 4 switches back to their defaults and send the report path.

### 4.2 Live rerankers (task 2)

Set in `.env.local` of a non-production app: `RAG_PIPELINE=v2`, `RAG_RERANKER=cohere` (then `voyage`), `COHERE_API_KEY=<key>`, `VOYAGE_API_KEY=<key>`. Real chunk text and queries leave your deployment for the vendor while a hosted reranker is on.

1. Latency for `rerank-v5.0-pro`, `rerank-v5.0-fast` (Cohere) and `rerank-3`, `rerank-3-lite`, `rerank-2.5` (Voyage): rerank a real 75-chunk pool 20 times each; record p50, p95 and billed units. No script for this exists in the repository and the plan names none; the eval report shows per-stage latency, so you can read the rerank stage row from an eval run per reranker, or ask Claude for a helper. Rule: if chat p95 exceeds 600 ms or voice p95 exceeds 250 ms, lower `rerankInputCap` toward 50 or move chat to the fast tier (`RAG_RERANK_TIER_CHAT=fast`); record the choice.
2. Response shapes: Cohere returns `relevance_score` and `relevant_spans`, Voyage returns `data[]` with `relevance_score`, and no request sends `top_n` or `top_k`. Check against `tests/fixtures/rerank`.
3. Voyage per language: run the eval on the real golden set's zh and it slices with `rerank-3` and with `rerank-2.5`. Set `RAG_RERANK_VOYAGE_MODEL_BY_LANG` only for a language where `rerank-2.5` wins beyond the noise band. Record the numbers.

### 4.3 Calibration, sweep, XLG-03, watch item and Config UI (task 3)

Needs the real golden set with its frozen dev and test split and live baseline, and `RAG_EVAL_SECRET` set for the eval endpoint. Do not edit the files these tools write (`eval/config/retrieval-params.json`, `eval/config/refusal-thresholds.json`).

1. Retrieval sweep (picks pool size, rerank cap and top-k):
   ```bash
   uv run --directory eval python -m rag_eval.sweep retrieval --run-config <live v2 config> --base-url <app url> --out eval/out/live-sweep --write-params
   ```
   Check: pool, cap (50 to 100) and top-k are chosen and `eval/config/retrieval-params.json` now has provenance `sweep`.
2. Refusal calibration, once per live reranker and model:
   ```bash
   uv run --directory eval python -m rag_eval.calibrate refusal --run-config <live v2 config> --base-url <app url> --out eval/out/live-calibration --write-thresholds
   ```
   Read the per-cell dev and holdout numbers with 95% upper bounds. Record which cells are calibrated and whether correct refusal strictly improves over the baseline at the target false-refusal rate (the fixture result was a tie, 0.333 against 0.333).
3. XLG-03 (cross-language refusal thresholds): in the same report, compare cross-language cells with same-language cells. Check: cross-language false refusal is not above same-language beyond the noise band. On the fixture every cross cell was `insufficient_data`.
4. Watch item, zh|same (Chinese questions against Chinese documents) on the test split: check that no no-answer item is answered by the rerank gate while its best dense similarity is below the similarity floor. On the fixture `zh-no-answer-003` was answered (gate 0.0446, best dense 0.0595, floor 0.1159). Record the count and item ids only.
5. Optional chunking sweep for one document type with stored parse output: `python -m rag_eval.sweep chunking`, record a decision with `chunking-decide`, then build and activate the profile from the Config UI, ask a few clause questions, and roll back.
6. Config UI check in a browser: run `npm run config`, open `http://localhost:3333` in the same browser and on the same host where you are signed in to the main app as admin. In the Chunking profiles panel: create, build, compare, activate and roll back a profile; hard errors and warnings read as in the UI spec. In the Refusal calibration panel: warnings match the state (no `refusal_on_without_calibrated_cell` for calibrated languages) and each cell shows the point estimate, the 95% upper bound and n. Known issue: if clicking "RAG administration" does not load a panel, reload the page and use the panel's own link; record it, it is not a blocker.

Commit rule for the tool-written files: send the numbers; Claude commits `eval/config/*.json`. If you commit them yourself, commit only those files.

---

## 5. Phase 5 package approval (05-05)

**Summary of the verification report** (`.planning/phases/05-verified-citations-groundedness/05-05-PACKAGE-VERIFICATION.md`, checked 2026-11-25, nothing installed): all seven items are OK, with no mismatch. `@ai-sdk/anthropic` 3.0.143 comes from `vercel/ai` with provenance, has no install scripts and sits on the `ai-v6` line (`ai` stays 6.0.3). `transformers` 5.23.0 and `torch` 2.15.0+cpu are the versions `rag-sidecar/uv.lock` already resolves. The HHEM repository `vectara/hallucination_evaluation_model` at revision `de9a5e6b…` matches the expected size and sha256, and its two Python files only load `google/flan-t5-base` through `from_pretrained`. `google/flan-t5-base` at revision `7bcac572…` holds only data files. `sentencepiece` 0.2.3 is legitimate but probably not needed. No look-alike names. Limits: npmjs.com refused automated fetches (facts come from the registry), Sigstore signatures were read but not verified cryptographically, and the `sentencepiece` conclusion comes from reading source, not from running a load.

**Two things need your explicit acceptance** because installing the provider changes the lockfile beyond the one package, and the install task stops on unlisted changes:

- the shared `eventsource-parser` moves from 3.0.6 to 3.1.1 (the streaming path uses it; run one streaming chat as a smoke test after the install);
- a new nested `undici` 6.29.1 appears under `@ai-sdk/anthropic`.

Send this after 04-43 and 03.1-54 are done (the checkpoint requires their summaries to exist). **Recommended reply, exactly:**

```
approved, no sentencepiece. I accept the eventsource-parser 3.0.6 to 3.1.1 bump and the nested undici 6.29.1.
```

To decline either change, reply `approved, no sentencepiece` and name what you do not accept; the install then stops there. To drop an item, list it; Claude must replace it in the plan first.

---

## 6. Other pending human actions

From `STATE.md` (Pending Human Actions), the follow-up notes and the plan summaries, de-duplicated. Items already covered above are not repeated.

**Deploy and configuration**

1. Voice rollout: deploy the voice agent (Fly.io) first, then the app; roll back the app first. Voice is briefly unavailable between the two. `VOICE_MAX_ACTIVE_ROOMS` (app) must equal `VOICE_AGENT_MAX_SESSIONS` (agent).
2. Production sets `WHATSAPP_WEBHOOK_SECRET`; the Baileys and app clocks must be within 5 minutes.
3. Production sets `POLAR_WEBHOOK_SECRET` before the Polar webhook is used (503 until then).
4. Multi-tenant embed needs `RAG_EMBED_TENANT`; voice needs `RAG_VOICE_TOKEN_SECRET` (32 or more characters).
5. The Config UI on port 3333 needs you signed in as admin on the main app in the same browser and host.
6. Heads-up for users: anonymous single-tenant users lose AI titles, name extraction, speech-to-text and text-to-speech, temporary document processing and image, video and 3D generation (they now need a login). Admins must log in again (signed cookie).

**Database patches and data**

7. `supabase/patches/2026-11-security-review-$MODE.sql` (adds `tool_execution_states.user_id` checks and the `nango_connections` UNIQUE on `connection_id`; removes duplicate rows first). Apply if not already applied.
8. `supabase/patches/2026-11-search-rpc-revoke-multi-tenant.sql` is superseded by 0409 and 0410 (block B). Skip it when block B is applied; on an older multi-tenant database apply it only after the app deploy.
9. `supabase/patches/2026-11-chat-images-rag-prefix.sql` keeps document pictures out of bucket listings; not tracked in `STATE.md`. Confirm with Claude whether it was applied.
10. After migrations 0301 to 0312: `npm run rag:backfill-hashes -- --dry-run` (then the real run if the counts look right).
11. Before turning `RAG_EMBEDDING_PROFILES` on or running a re-embed: fill `score_calibration` for a non-legacy profile before activating it, and decide on billing. Voyage on the free tier allows 3 requests and 10K tokens per minute, so a real re-embed needs billing. Restart the app after fixing a startup `MISMATCH`.
12. Documents ingested before 0319 keep `content = ''` until re-ingested.

**Live checks still open**

13. Phase 1: the open items in `.planning/phases/01-evaluation-harness-baseline/01-VERIFICATION.md` (Docker build and run of the sidecar, first GitHub run, live judge hand-check, real golden-set drafting, live three-run baseline).
14. Phase 2: the 11 items in `02-VERIFICATION.md`, including the multi-tenant upgrade on a database copy (security-review patch, deploy app, then the revoke patch), the strict-mode "knowledge base unavailable" bubble in chat and embed, embed with `RAG_EMBED_TENANT` unset, a live voice session, Langfuse trace ids and review tags, and Node 22 on the Vercel project.
15. Phase 3 live summary (`03-48-SUMMARY.md`): the Docling OCR run (`docker build --target docling rag-sidecar`, zh and it scans, `docker stats` peak memory), DeepInfra parity (needs a funded second host), re-embed and profile comparison, Nango sync, Config UI upload as signed-in admin (`documents.source = 'config_upload'`), real image upload (caption quality, finishing in 60 s), resume route against a real sidecar job, Firecrawl PDF output, real profile activation and rollback, and PostgREST request size for multi-MB documents. Optional: `run-profile-compare.mts` (03-46).
16. Phase 3.1: run `.github/workflows/ray-optional.yml` once by hand (`workflow_dispatch`) after it is on trunk.

**Later checkpoints (not runnable yet)**: 05-26 (Anthropic Citations spike, Vectara, HHEM image, live groundedness calibration), 06-46 (live grants, query models, LlamaIndex against LangChain, Redis), 07-33 (hosted backends, real-Postgres concurrent claim for the vector sync queue, live regression, shipped defaults). Claude will ask when each is ready.

Already done, no action: package approvals for Phase 3 (03-05) and Phase 3.1 (`pdfplumber` 0.11.11, `ray[data]` 2.60.1), both approved 2026-11-24.

---

## 7. What to send back

Send one message per checkpoint. Numbers, verdicts and ids of golden-set items only.

- [ ] **1. Before you start:** backup date and kind (or branch used); app deployed (yes/no); pgvector schema and version; `lc_ctype`; chunk count; first migration applied.
- [ ] **2. Migrations:** blocks applied (A to G) and any block that stopped; the dry-run result of 0425 (row count, explanation of each row); V1 to V4 output per block (row counts, SQLSTATEs); real-time policy and function variant; `Allow public access` off (yes/no).
- [ ] **03.1-53 task 1:** host, RAM, vCPU, region; always-on setting; `/health` and `/ready` status codes.
- [ ] **03.1-53 task 2:** migrations 0351 to 0359 applied; SQLSTATEs for anon and authenticated; V3 rows; real-time checks; default-switch upload created no job row (yes/no).
- [ ] **03.1-53 task 3:** local test result line (passed or skipped, with reason), PostgreSQL and pgvector versions, 600 of 600 claimed once; live check counts (total, distinct, attempts per job) if run.
- [ ] **03.1-54 task 1:** upload-to-ready seconds; real-time events on own topic (yes/no) and none on the other tenant (yes/no); restart test: resumed (yes/no), duplicate chunks (count).
- [ ] **03.1-54 task 2:** dry-run report numbers (class shares, projected pages per tier, L2 and L3 pages, projected cost, wall time); chosen budget; actual cost; `needs_review` count and reasons; five upload times and p95; per-stage p95.
- [ ] **03.1-54 task 3:** batch duration, billed tokens, documents published and retrievable (count); per-tier parser numbers next to the CI numbers.
- [ ] **04-43 task 1:** relex rows per tenant, duration, resume worked (yes/no); `VACUUM` done; Chinese term found (yes/no), leg and rank per tenant kind; anon SQLSTATE; parity run verdict against the noise band.
- [ ] **04-43 task 2:** latency table (5 models: p50, p95, billed units); chat and voice verdict and any cap or tier change; response shapes match (yes/no), no `top_n` or `top_k` (yes/no); zh and it comparison numbers and whether `RAG_RERANK_VOYAGE_MODEL_BY_LANG` was set.
- [ ] **04-43 task 3:** chosen pool, cap, top-k and provenance `sweep`; calibrated cells with dev and holdout numbers and 95% upper bounds; strict correct-refusal gain; XLG-03 comparison; zh|same watch result; optional chunking decision; Config UI panel verdicts.
- [ ] **05-05:** the reply from section 5, and after the install the streaming smoke test result (pass/fail).
- [ ] **6. Other actions:** the item numbers you completed, skipped or could not do.

Never include: API keys or secrets, tenant ids, user ids, file or document names, queries, answers, chunk text, or the Chinese exact term.
