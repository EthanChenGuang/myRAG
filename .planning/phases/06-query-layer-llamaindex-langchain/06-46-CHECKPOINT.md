# 06-46 Checkpoint: Phase 6 live verification (owner)

Status: **waiting for the owner.** All four tasks in 06-46 are `checkpoint:human-verify` (blocking). The plan has no autonomous task. No live result is recorded here and none was made up. 06-46-SUMMARY.md gets written only after the owner reports results.

Where these steps run: **only** the eval Supabase project `fsgaeysipkukqoocgzbx`, or the owner's own machine (the app at `http://localhost:3000`, the sidecar, Redis). Never the production Supabase project or Vercel.

What to record: SQLSTATEs, HTTP statuses, booleans, counts, latencies, rates and verdicts. Do not record key values, real queries, rewrites, chunk text, document names or tenant ids, here or in commit messages (T-06-96).

## What the executor checked (no live service used)

| Check | Result |
|---|---|
| Every plan in depends_on, transitive (226 plans) | each has a SUMMARY on origin/main |
| 06-45-SUMMARY | both per-mode schema-equality runs pass (43/43, `# fail 0`) |
| Migrations 0601, 0602, 0603 | present; `bash scripts/setup-database.sh --list-migrations single-tenant` lists them at positions 70-72 of 177 |
| `hybrid_search_chunks` is redefined after 0602 | yes, by 0802, 0856 and 0930. See the Task 1 warning |
| Plan Task 2 command (run config + `--base-url`) | **refused by the harness**: `a run-config env overlay applies to in-process runs only; omit --base-url or drop its env` (exit 2). The corrected command is below |
| Plan Task 3 command (`compare frameworks --base-url`) | **not a flag**: `one of the arguments --fixtures --llamaindex is required`. The corrected command is below |
| `--cache-pairs --base-url` without `--allow-live-cache` | refused as designed: `... pass --allow-live-cache (plan 06-46)` |
| `--base-url` without `--baseline` / `--no-gate` | refused: `a --base-url run needs --baseline <live baseline> or --no-gate` |
| Real golden set | **none in the repo**: no `eval/golden/`, and `eval/config/gate-population.json` is `mode: legacy`. Task 3's precondition is not met yet |
| Live baseline | none in `eval/baselines/` (fixture baselines only). Task 1 step 4 records one first |

The two command errors are mistakes in the plan text, not in the code. The harness guards behave as designed. Below I give the working commands instead of the ones in the plan.

## Common setup (owner machine)

```bash
git fetch origin && git checkout origin/main        # or the branch under test
npm ci --ignore-scripts
(cd eval && uv sync --locked --all-extras)
(cd rag-sidecar && uv sync --locked --extra chunking --extra preflight --extra cache)
python3 scripts/ci/fill-tiktoken-cache.py
```

In `.env.local` (Config UI `npm run config` or by hand): point `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` at **`fsgaeysipkukqoocgzbx`**. Set `RAG_EVAL_SECRET` (at least 32 characters, same value in the shell that runs the eval), plus `OPENROUTER_API_KEY`, `RAG_SUPPORTED_LANGUAGES=zh,en,it` and `RAG_PRIMARY_LANGUAGE=en`. Start the app with `npm run dev`. A live `--base-url` run takes its settings from the **app's** env, not from a run config. So every "configure the app" step below means: edit `.env.local`, then restart `npm run dev`.

Make sure no `LANGSMITH_*` or `LANGCHAIN_*` variable is set, in the app shell or in `.env.local` (`env | grep -E '^(LANGSMITH|LANGCHAIN)_'` prints nothing).

---

## Task 1: Live Supabase: migrations, grants, language shares, cache invalidation

**Where:** SQL editor or `psql "$DATABASE_URL"` (direct connection, not the pooler) on `fsgaeysipkukqoocgzbx`; PostgREST at `https://fsgaeysipkukqoocgzbx.supabase.co`; the app on localhost.

**Preconditions:** Phase 4 migrations applied (04-43). Take a backup first (Dashboard → Database → Backups, or `pg_dump "$DATABASE_URL" -Fc -f before-06-46.dump`).

**Warning (executor finding):** do **not** apply 0602 on its own if the project already has 0802, 0856 or 0930. Those files redefine `hybrid_search_chunks` after 0602, and running 0602 alone would roll the function back to an older body. Apply the ordered list from 0601 **through the end** instead. Every migration is idempotent, per AGENTS.md.

Steps:
1. Check what is applied: `SELECT to_regclass('public.rag_semantic_cache'), to_regprocedure('public.rag_tenant_language_shares(text)');`
2. Apply the files, for the project's mode (`single-tenant` or `multi-tenant`):
   ```bash
   bash scripts/setup-database.sh --list-migrations <mode> | sed -n '/0601_/,$p' > /tmp/06-46-migrations.txt
   while read f; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break; done < /tmp/06-46-migrations.txt
   ```
   Pass: no error. Then `SELECT count(*) FROM pg_proc WHERE proname = 'hybrid_search_chunks';` returns **1**. If it returns 2 or more, record the `pg_get_function_identity_arguments(oid)` of each and stop.
3. SQL privileges. Every value must be **false**:
   ```sql
   SELECT r, f, has_function_privilege(r, f, 'EXECUTE')
   FROM unnest(ARRAY['anon','authenticated']) r,
        unnest(ARRAY[
          'public.rag_tenant_language_shares(text)',
          'public.rag_cache_check(text,text,text,public.halfvec,double precision)',
          'public.rag_cache_invalidate(text,uuid[])',
          'public.rag_cache_sources_current(text,jsonb)',
          'public.rag_cache_resolve_sources(text,uuid[])']) f;
   SELECT p.oid::regprocedure, r, has_function_privilege(r, p.oid, 'EXECUTE')
   FROM pg_proc p, unnest(ARRAY['anon','authenticated']) r
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('rag_cache_store','hybrid_search_chunks');
   SELECT r, has_table_privilege(r, 'public.rag_semantic_cache', 'SELECT'),
             has_table_privilege(r, 'public.rag_semantic_cache', 'INSERT')
   FROM unnest(ARRAY['anon','authenticated']) r;
   SELECT relrowsecurity, (SELECT count(*) FROM pg_policies WHERE tablename = 'rag_semantic_cache')
   FROM pg_class WHERE oid = 'public.rag_semantic_cache'::regclass;   -- expect true, 0
   ```
4. PostgREST, once with the anon key and once with a signed-in **test** user's JWT (`Authorization: Bearer <jwt>`, `apikey: <anon key>`). Use placeholder arguments only:
   ```bash
   B=https://fsgaeysipkukqoocgzbx.supabase.co/rest/v1
   for fn in rag_tenant_language_shares rag_cache_invalidate rag_cache_resolve_sources rag_cache_sources_current rag_cache_check rag_cache_store hybrid_search_chunks; do
     curl -s -o /dev/null -w "$fn %{http_code}\n" -X POST "$B/rpc/$fn" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{"p_tenant_key":"s:placeholder"}'
   done
   curl -s -w ' %{http_code}\n' "$B/rag_semantic_cache?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN"
   curl -s -w ' %{http_code}\n' -X POST "$B/rag_semantic_cache" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"tenant_key":"s:placeholder"}'
   ```
   Pass: every RPC answers 401/403 with code `42501`, or 404 `PGRST202` (the function is not exposed to that role). The table read answers 401/403, or 200 with `[]`. The write is refused (401/403, `42501`). Record the status and code per call.
5. Cache invalidation, on a **test** tenant: set `RAG_PIPELINE=v2`, `RAG_SEMANTIC_CACHE=pgvector` and restart. Ask one knowledge-base question twice in strict mode: the second answer's message metadata carries `cache: hit`, and `SELECT count(*) FROM public.rag_semantic_cache WHERE tenant_key = '<test key>'` is ≥ 1. Then upload or replace any document in that tenant and run the count again. Pass: **0**.
6. Legacy parity: set `RAG_PIPELINE=legacy` and `RAG_SEMANTIC_CACHE=off`, then restart.
   ```bash
   npm run test-rag -- --base-url http://localhost:3000 --no-gate --out eval/out/live-06-46-legacy-a
   (cd eval && uv run python -m rag_eval.baseline record-reports --report out/live-06-46-legacy-a/report.json --out out/live-06-46-legacy-baseline.json)
   npm run test-rag -- --base-url http://localhost:3000 --baseline eval/out/live-06-46-legacy-baseline.json --gates-mode report --out eval/out/live-06-46-legacy-b
   ```
   Pass: `jq '.passed' eval/out/live-06-46-legacy-b/gate.json` is `true`, with no slice beyond the noise band. Use the real golden set with `--golden <file>` once one exists. Until then the run uses the fixture golden file against live data, and only parity is meaningful.

**Report back:** step 2 count; step 3 booleans (all false), RLS on and policy count 0; step 4 status and code per call; step 5 before and after counts; step 6 `passed`.

---

## Task 2: Query model quality and per-transform latency

**Where:** owner machine (app on localhost, data in `fsgaeysipkukqoocgzbx`). Precondition: Task 1 approved.

For each model `M` in `openai/gpt-4.1-nano`, `mistralai/mistral-small-3.2-24b-instruct` and `openai/gpt-4o-mini`:
1. Configure the app with `RAG_PIPELINE=v2`, `RAG_QUERY_LAYER=true`, `RAG_QUERY_FRAMEWORK=llamaindex`, `RAG_QUERY_LLM_MODEL=M` and `RAG_SEMANTIC_CACHE=off`, then restart.
2. Chat profile: `npm run test-rag -- --base-url http://localhost:3000 --no-gate --out eval/out/live-06-46-qm-<short M>`
   Do **not** pass `--run-config eval/config/runs/query-layer-llamaindex.json` together with `--base-url`. The harness refuses that combination; the app's env carries the same two settings.
3. Read the report's query-layer section (`jq '.query_layer' eval/out/live-06-46-qm-<short M>/report.json`, or the "Query layer" section of `report.md`). Record per transform (condense, translate, expand, decompose, normalize_dates): p50, p95 and skip rate; the protected-token loss rate; and the whole pre-retrieval group p95 against `pre_generation.chat.p95_ms` = 2000.
4. Voice profile: run a voice session (`cd voice-agent && npm run dev`, `VOICE_SERVER_QUERY_REWRITE=true`) with about 20 turns, or post to `/api/internal/voice-rag` with `history`. Read the `query` stage timings from Langfuse or the trace. Pass: total under `pre_generation.voice.p95_ms` = 800.
5. In the traces, read 10 rewrites per language (zh, en, it) and give each model a verdict: good, acceptable or poor. Write no rewrite text down.
6. Budgets: for the chosen model, replace the starting numbers in `eval/config/latency-budgets.json` under `profiles.chat.stages` and `profiles.chat.groups.query` (and `profiles.voice.stages` plus `profiles.voice.groups.query`, today 300 ms p95) with the measured p95 (p50 where the key is `p50_ms`), rounded up to 50 ms. **Keep the `scope_gate` keys** (Phase 6.2, 06.2-03) and every other key unchanged. Afterwards check that `npx vitest run tests/rag/config.test.ts tests/rag/query-additions-config.test.ts tests/rag/monitor-rules.test.ts` and `uv run --directory eval pytest -q tests/test_latency_report.py tests/test_report_query.py tests/test_committed_contract_files.py` still pass.
7. If the chosen model is not `openai/gpt-4.1-nano`, record that a gap-closure plan is needed for the five-place default change. Do not change the default in this plan.

**Pass:** per-transform p95 and the pre-retrieval totals are inside the budgets (chat about 2 s, voice 800 ms) for the chosen model; protected-token loss is 0 or recorded with its rate; the quality verdict for the chosen model is at least "acceptable" in all three languages.

**Report back:** a latency table (model × transform × p50/p95/skip), loss rates, the three-language verdict per model, the chosen model, and the budget diff.

---

## Task 3: Live LlamaIndex versus LangChain comparison

**Where:** owner machine. Preconditions: Task 2 approved; a **real** golden set with a frozen split and a live baseline exists (`eval/golden/private/…`, `gate-population.json` `mode: real`). **This is not met today.** If it is still missing, report "blocked: no real golden set" for Task 3.

1. Configure the app with `RAG_PIPELINE=v2`, `RAG_QUERY_LAYER=true`, the chosen model and `RAG_QUERY_FRAMEWORK=llamaindex`, then restart:
   `npm run test-rag -- --base-url http://localhost:3000 --golden <real golden.jsonl> --golden-manifest <its manifest> --no-gate --out eval/out/live-frameworks/llamaindex`
2. Change only `RAG_QUERY_FRAMEWORK=langchain`, restart, and run the same command with `--out eval/out/live-frameworks/langchain`.
3. `uv run --directory eval python -m rag_eval.compare frameworks --llamaindex out/live-frameworks/llamaindex --langchain out/live-frameworks/langchain --out out/live-frameworks/compare`
   (The plan's `--base-url` form does not exist. The tool compares two finished run directories.)
4. Check that `env | grep -E '^(LANGSMITH|LANGCHAIN)_'` was empty in both the app and the eval shells during the runs.

**Pass:** the tool reports no run problems (no missing query plan, no framework fallback, no transform skipped with error); paired differences per language and per category are recorded; tie-order differences are counted separately from rank differences; per-framework latency is recorded.

**Report back:** the paired difference with 95% CI per language and category, the counts of identical, tie_only and rank, per-framework p50/p95, and the tracing-variable check.

---

## Task 4: Real Redis run and live cache calibration

**Where:** owner machine. Run Redis 8 or Redis Stack locally (for example `docker run -d -p 6379:6379 redis:8`; Redis 8 includes the Query Engine), with the sidecar on the same machine. Precondition: Tasks 1-3 approved.

1. Sidecar: `cd rag-sidecar && REDIS_URL=redis://localhost:6379 RAG_SIDECAR_SECRET=<same as app> uv run --extra cache uvicorn rag_sidecar.main:app --port 8088` (or the image built with the `cache` extra). App: `RAG_PIPELINE=v2`, `RAG_SEMANTIC_CACHE=redisvl`, `RAG_SIDECAR_URL=http://localhost:8088`, `RAG_SEMANTIC_CACHE_TTL=120` (short TTL for this check only), then restart.
2. Isolation: in two **test** tenants A and B (multi-tenant mode, two orgs, or two single-tenant projects), ask the same question twice in each. Pass: A's second ask is `cache: hit` with A's trace id, B's first ask is a miss, and B never gets A's answer.
3. TTL: wait more than 120 s and ask again in A. Pass: miss.
4. Invalidation: build a hit in A again, upload or replace a document in A, and ask again. Pass: miss in A; B is unaffected.
5. Latency: set `RAG_SEMANTIC_CACHE_TTL=3600` and run `npm run test-rag -- --base-url http://localhost:3000 --no-gate --out eval/out/live-06-46-cache` twice. Record hit and miss p50/p95 from the second report (`jq '.query_layer' …`, cache rows).
6. Calibration, with the production embedding profile active in the app:
   ```bash
   npm run test-rag -- --cache-pairs --base-url http://localhost:3000 --allow-live-cache --no-gate --out eval/out/live-06-46-pairs
   uv run --directory eval python -m rag_eval.calibrate cache --pairs out/live-06-46-pairs/cache-pairs.json --write --check
   ```
   Pass: exit 0, and `near_miss_wrong_hit_rate` is 0.0 on **dev and test** for the production profile's entry in `eval/config/semantic-cache.json` (the tool writes that file; do not edit it by hand). Commit only the tool-written change.
7. Afterwards, clear the test tenants' cache (`POST /api/rag/admin/semantic-cache {tenantKey}`) and stop Redis.

**Report back:** isolation pass or fail, TTL pass or fail, invalidation pass or fail, hit/miss p50/p95, and the calibrated `max_distance` with the dev and test pair counts and wrong-hit rates.

---

## After the owner answers

Send "approved" per task with the numbers above, or describe the failure. A resumed executor then:
- writes `06-46-SUMMARY.md` (numbers and verdicts only) and commits the tool-written `eval/config/semantic-cache.json` and the measured `eval/config/latency-budgets.json`;
- opens gap-closure plans for: any default model change (five places), any code failure found, and fixing the plan text (Task 2 run config with `--base-url`, Task 3 `--base-url`).
