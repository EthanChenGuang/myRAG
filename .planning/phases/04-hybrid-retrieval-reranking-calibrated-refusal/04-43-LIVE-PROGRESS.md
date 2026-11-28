# 04-43 live verification: progress (2026-11-25)

**Status: partial.** The read-only Supabase checks (Task 1 items 1 and 4, grants) and the reranker latency and response-shape checks (Task 2 items 1 and 2) are done. The `rag:relex` run, the Chinese term search on the real knowledge base, the live parity run, the zh/it Voyage comparison (Task 2 item 3) and all of Task 3 are blocked. This file is a progress record, not the plan SUMMARY; 04-43-SUMMARY.md is written when the plan is complete.

Scope and rules followed:
- Supabase: project `<live-project-ref>` (multi-tenant), through the Supabase MCP tools only. Every query was read-only; the role checks ran inside a transaction that was rolled back. No migration was applied and no data was written.
- Vendors: real Cohere and Voyage APIs, keys injected by the network proxy (the request carried a placeholder bearer). All text was synthetic (generated product-manual sentences in en, zh and it); no customer content left the container.
- Owner decisions applied: cost free (free/trial tiers only); the backup is waived until production.
- No code, config, STATE.md, ROADMAP.md or REQUIREMENTS.md change.

## Task 1: live Supabase

| Item | Result | Evidence | Verdict |
|---|---|---|---|
| 1. pgvector version | 0.8.0, schema `public` | `pg_extension.extversion` | done. 0.8.0 has `hnsw.iterative_scan`, so the "below 0.8.0" rule (research Open Question 1) does not apply; `RAG_HNSW_ITERATIVE_SCAN` stays off by default (D-28) and may be tried later. Session defaults: `hnsw.ef_search` 40, `hnsw.iterative_scan` off (the RPC sets `ef_search` per call, P-1) |
| 1. `lc_ctype` | `en_US.UTF-8` (collate `en_US.UTF-8`, encoding UTF8, locale provider `i`), Postgres 17.11 | `pg_database.datctype` / `datcollate` / `datlocprovider` (`SHOW lc_ctype` is not exposed through the MCP role: 42704) | done. With the verbatim builder `rag_lexical_tsvector` the locale does not affect tokens (research Open Question 1) |
| 1. Inventory counts | `document_chunks` 1 row, `documents` 1, `document_parents` 0, `chunking_profiles` 6, embedding profiles 5 (active `openai-3-small-1536`); one tenant key, kind `u:`; table 240 kB | count queries | done. The live knowledge base is effectively empty |
| 1. Indexes | HNSW on `embedding` (`m=64`, `ef_construction=200`) and GIN `idx_document_chunks_lexical_tsv` both present | `pg_indexes` | done. Table is tiny, so the CONCURRENTLY step (Task 1 step 2) is moot; the migrations were already applied (see `.planning/LIVE-MIGRATION-LOG-2026-11-25.md`) |
| Chinese lexical behaviour, hosted | Matches the repo expectation exactly | `rag_lexical_tsvector('型号 xr-2000 xr2000 设备')` = `'xr-2000':2 'xr2000':3 '型号':1 '设备':4`; `to_tsvector('simple', …)` = `'-2000':3 'xr':2 'xr2000':4 '型号':1 '设备':5` (both identical to 04-RESEARCH line 550, F-1). A synthetic zh sentence tokenized by the app's `lexicalText` (LEXICAL_VERSION 2: Intl.Segmenter words + Han bigrams + code forms; 31 tokens, 27 lexemes) matched the app's query tokens for "XR-2000 保修期多久" (`@@` true, `ts_rank_cd(…,1)` 0.2597), did not match "退货政策" (false); whole code `xr-2000` matched through the verbatim builder and did not match through `to_tsvector('simple', …)` | done (synthetic text; see the relex row for the real chunk) |
| 3. Relex of live rows | Not run. The one live chunk has `lexical_tsv` empty and `lexical_version` NULL, so the lexical leg currently finds nothing on live data | count of rows with a non-empty `lexical_tsv`: 0 of 1 | **blocked**: `npm run rag:relex` writes rows and needs `SUPABASE_SERVICE_ROLE_KEY` in this container (not available; read-only brief) |
| 4. Chinese exact term on the real knowledge base | Not run | — | **blocked**: needs relex first and a real document with a Chinese model number or ID; the live knowledge base has one document |
| Grants: `has_function_privilege` | `hybrid_search_chunks`, `rag_fetch_parents`, `rag_assert_tenant_key` (and `rag_lexical_tsvector`, `rag_lexical_tsquery`, `rag_relex_batch`, `match_chunks_by_profile`): anon false, authenticated false, PUBLIC no grant, service_role true; all with `search_path=""`; the first three are SECURITY INVOKER | `pg_proc` + `has_function_privilege` + `aclexplode` | done |
| Grants: `SET LOCAL ROLE` in a rolled-back transaction | anon: 42501 on all three; authenticated: 42501 on all three; service_role (positive control): `rag_assert_tenant_key` ok, `rag_fetch_parents` ok, `hybrid_search_chunks` with an unknown org returned 0 rows (with a bad profile id: 22023 `embedding_profile_mismatch`) | DO block returning SQLSTATEs through a final RAISE, then ROLLBACK | done |
| Tenant-key guard, hosted | `s:default` (wrong mode) 22023, malformed key 22023, `o:<uuid>` ok | same rolled-back DO block, as service_role | done |
| 4. Anon through PostgREST with the real key (T-04-92) | HTTP 401, SQLSTATE 42501 `permission denied for function …` for all three RPCs, with both the legacy anon JWT and the `sb_publishable_` key | `POST /rest/v1/rpc/<fn>`; keys were read through the MCP, kept in a temporary file and deleted, never printed | done |
| Security advisors | No ERROR-level items; same WARN/INFO set as the migration log (none names a Phase 4 RPC) | `get_advisors security` | done (no change) |
| 5. Live legacy parity run | Not run | — | **blocked**: no reachable non-production app on the Phase 4 code, no live baseline, no `RAG_EVAL_SECRET` (details under "Blockers") |

## Task 2: live rerankers

### Method
- Pool: 75 synthetic chunks, 292 to 444 tokens each (cl100k: p50 364, total 27,275), 50 en, 15 zh, 10 it. 30 synthetic queries (en, zh, it) rotated across calls.
- Per model: 1 warm-up call (not counted) and 20 timed calls; wall time from request to parsed response, measured from this container through the proxy, with a kept-alive connection. p50 and p95 by linear interpolation over the 20 samples (with n = 20, p95 sits between the 19th and 20th values, so one slow call moves it).
- Pacing: Cohere one call every 7 s (trial key: 10 calls per minute, 1000 per month); Voyage one call every 4 s. Cohere also returns `x-envoy-upstream-service-time` (server-side time), recorded as "upstream".
- Request bodies matched the app's adapters: Cohere `{model, query, documents}`; Voyage `{model, query, documents, truncation: true, return_documents: false}`.

### Latency, 75 chunks (the shipped `rerank_input_cap` is 75)

| Model | Tier in code | p50 ms | p95 ms | min / max ms | over 600 ms | over 250 ms | upstream p50 / p95 ms | billed per call | 429 |
|---|---|---|---|---|---|---|---|---|---|
| Cohere `rerank-v5.0-pro` | chat quality | 414 | 637 | 399 / 863 | 2 / 20 | 20 / 20 | 370 / 382 | ~25.4k input_tokens | 0 |
| Cohere `rerank-v5.0-fast` | chat or voice fast | 292 | 465 | 242 / 1716 | 1 / 20 | 18 / 20 | 248 / 330 | ~31.7k input_tokens | 1 (trial 10/min; retried after 15 s, ok) |
| Voyage `rerank-3` | quality default | 172 | 258 | 127 / 270 | 0 / 20 | 2 / 20 | n/a | ~29.5k total_tokens | 0 |
| Voyage `rerank-3-lite` | fast | 154 | 398 | 122 / 489 | 0 / 20 | 4 / 20 | n/a | ~29.5k total_tokens | 0 |
| Voyage `rerank-2.5` | per-language override | 170 | 231 | 140 / 386 | 0 / 20 | 1 / 20 | n/a | ~29.5k total_tokens | 0 |
| Voyage `rerank-2.5-lite` | not used by code (reference) | 151 | 276 | 124 / 487 | 0 / 20 | 2 / 20 | n/a | ~29.5k total_tokens | 0 |

Warm-up (first call, not counted): pro 774, fast 298, rerank-3 502, rerank-3-lite 170, rerank-2.5 194, rerank-2.5-lite 121 ms.

### Latency, 50 chunks (the F-8 "lower the cap toward 50" option)

| Model | p50 ms | p95 ms | over 600 ms | over 250 ms | upstream p50 / p95 ms |
|---|---|---|---|---|---|
| Cohere `rerank-v5.0-pro` | 379 | 710 | 2 / 20 | 20 / 20 | 306 / 394 |
| Cohere `rerank-v5.0-fast` | 339 | 472 | 1 / 20 | 20 / 20 | 257 / 271 |
| Voyage `rerank-3` | 204 | 491 | 0 / 20 | 4 / 20 | n/a |
| Voyage `rerank-3-lite` | 183 | 416 | 0 / 20 | 4 / 20 | n/a |

Cutting the pool from 75 to 50 lowered server time a little (Cohere pro upstream p50 370 to 306) but did not lower the client p95 of any model: the tail is dominated by network and per-request overhead, not by the number of documents.

### F-8 rule applied (research F-8: if p95 for 75 documents exceeds the timeout, lower `rerankInputCap` toward 50 or move chat to the fast tier)

| Profile (timeout) | Provider | Finding | Recommendation (not applied; no config edited) |
|---|---|---|---|
| chat (600 ms), tier quality | Cohere | `rerank-v5.0-pro` p95 637 > 600 (2 of 20 calls over). Cap 50 does not help (p95 710) | Rule fires. Choose "move chat to the fast tier": with `RAG_RERANKER=cohere`, set `RAG_RERANK_TIER_CHAT=fast` (`rerank-v5.0-fast` p95 465, 1 of 20 over 600). Keep `rerankInputCap` 75. Server time for pro is 382 ms at p95, so re-measure from the deployment region before deciding finally |
| chat (600 ms), tier quality | Voyage | `rerank-3` p95 258, 0 of 20 over | Rule does not fire. Keep quality tier and cap 75 |
| voice (250 ms), tier fast | Cohere | `rerank-v5.0-fast` p50 292 and p95 465; 18 of 20 calls over 250 (20 of 20 at cap 50) | Rule fires and neither option helps (voice is already on the fast tier; cap 50 is slower at p50). Rerank would be skipped on about 90% of voice requests. Do not use Cohere for voice; if the deployment picks Cohere, expect voice to run on fused order (D-11, refusal off) and watch `rerank_skipped_rate` |
| voice (250 ms), tier fast | Voyage | `rerank-3-lite` p50 154, p95 398; 4 of 20 over 250 (same at cap 50) | Rule fires on p95; cap 50 does not help. Expected skip rate about 20%. Keep the 250 ms timeout (research: keep timeouts) and watch `rerank_skipped_rate`; this is the better of the two providers for voice |
| overall | — | `RAG_RERANKER` is one setting for chat and voice | If a hosted reranker is enabled, Voyage meets the chat budget unchanged and gives the lowest voice skip rate; Cohere needs `RAG_RERANK_TIER_CHAT=fast` and effectively disables voice rerank. Phase 7 (ADM-02) makes the default choice; defaults stay `none` |

Caveat: measured from this cloud container through an HTTPS proxy, not from the Vercel region (`iad1`). The Cohere client-minus-upstream gap is about 45 ms at p50; the tail spikes (1.7 s for fast) were network or vendor-side. A trial Cohere key cannot serve production traffic (10 calls per minute).

### Response shapes

| Check | Result | Evidence | Verdict |
|---|---|---|---|
| Model ids accepted | All of `rerank-v5.0-pro`, `rerank-v5.0-fast`, `rerank-3`, `rerank-3-lite`, `rerank-2.5`, `rerank-2.5-lite` returned 200 | probe and benchmark calls | done; no id substitution needed |
| Cohere shape | `{id, results[{index, relevance_score}], meta{api_version, billed_units}}`; 75 results for 75 docs. With `relevant_spans: {mode: "enabled"}` each relevant result carries `relevant_spans[{start, end, score}]` (a result without a relevant span omits the field) | live calls | done; matches `tests/fixtures/rerank/cohere-basic.json` and `cohere-spans.json`. One difference: live `billed_units` is `{input_tokens: n}`, fixtures show `{search_units: 1}`. The adapter treats `billed_units` as an opaque `record<number>` and nothing reads `search_units`, so no code change; the fixture could be refreshed |
| Voyage shape | `{object: "list", data[{relevance_score, index}], model, usage{total_tokens}}`; 75 entries | live calls | done; matches `voyage-basic.json` |
| App adapters on live APIs | `createCohereReranker` (pro with spans, fast) and `createVoyageReranker` (`rerank-3`, `rerank-3-lite`, `rerank-2.5`) parsed live responses: all scores present, spans present when requested, usage keys `input_tokens` / `total_tokens` | adapters run under `node --import tsx` against the live APIs with a spy on the request body | done |
| No `top_n` / `top_k` sent | Request keys sent by the adapters: Cohere `model, query, documents` (+ `relevant_spans` when compression is on); Voyage `model, query, documents, truncation, return_documents`. `RerankOptions.topN` exists in `types.ts` but neither adapter sends it | spy on request bodies; `src/lib/rag/rerank/cohere.ts`, `voyage.ts` | done |
| 3. zh and it comparison, `rerank-3` vs `rerank-2.5` (research F-7) | Not run | — | **blocked**: needs the real golden set's zh and it slices and a running app. `RAG_RERANK_VOYAGE_MODEL_BY_LANG` stays empty |

Usage of free quota: Cohere 90 calls of the 1000-per-month trial allowance (about 2.0M input tokens); Voyage 131 calls (about 3.3M tokens).

## Task 3: calibration, sweep, Config UI

| Item | Result | Evidence | Verdict |
|---|---|---|---|
| Real golden set | None. The only golden file is `eval/fixtures/golden.jsonl`: 146 items, all `provenance: synthetic_fixture` (107 dev, 39 test). `eval/golden/private/` (the gitignored location the draft and review-queue tools write to) does not exist | `jq` over the file; `ls eval/golden` | **blocked** |
| Frozen dev/test split of a real set | Only the fixture split (`eval/fixtures/split-manifest.json`) | — | **blocked** |
| Live baseline | None. `eval/baselines/` holds `fixture-baseline.json`, `fixture-ingest-baseline.json` and history of fixture baselines | `ls eval/baselines` | **blocked** |
| Non-production app reachable | No. The Vercel project has two deployments, both production, from a commit 2,252 commits behind trunk that has no `src/lib/rag/v2/` and no `/api/internal/rag/run` eval endpoint. No preview deployment exists | Vercel `list_deployments`; `git ls-tree` of the deployed commit | **blocked** |
| `RAG_EVAL_SECRET` | Not available to this session | — | **blocked** |
| Retrieval sweep, refusal calibration, XLG-03, zh\|same watch item, chunking sweep, Config UI panels | Not run. Not run against fixtures either: that would write fixture provenance, not live results | — | **blocked** on all of the above |

## Blockers and what unblocks them

| Blocked item | Needs | Cheapest free option | Command once it exists |
|---|---|---|---|
| Task 1 step 3: relex | A shell with `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for `<live-project-ref>`, and owner approval to write `lexical_text` / `lexical_tsv` | Owner runs it locally (1 chunk today: seconds), or saves the service-role key as a session secret | `npm run rag:relex -- --dry-run`, `npm run rag:relex`, then `VACUUM (ANALYZE) document_chunks;` in the SQL editor |
| Task 1 step 4: Chinese exact term on real data | Relex done; at least one real document with a Chinese model number or ID in a personal and an organization workspace; the app on trunk with `RAG_PIPELINE=v2`, `RAG_LEXICAL_SEARCH=true` | Upload one real zh document per tenant kind through the app running locally against the live project (`npm run dev`) | ask the term in chat; read `[Document Search]` / the trace for leg and rank |
| Task 1 step 5: live parity | A non-production app on trunk pointing at the live project, `RAG_EVAL_SECRET` set there, a live baseline, and a real golden set (the baseline is recorded from it) | `npm run dev` on the owner's machine (free) or a Vercel preview deployment of trunk (Hobby is free) with `RAG_EVAL_SECRET` set; then record the baseline | `npm run test-rag -- --base-url <app url> --baseline <live baseline> --out eval/out/live-p4-parity` |
| Task 2 step 3: zh/it Voyage comparison | Real golden set with zh and it items, running app, `RAG_EVAL_SECRET` | same app as above; Voyage free tokens suffice | eval run with `RAG_RERANKER=voyage` and `rerankModel` override `rerank-3` vs `rerank-2.5` on the zh and it slices |
| Task 3: real golden set and frozen split | A knowledge base with real documents and a reviewed golden set (50 to 200 items) in `eval/golden/private/` | Draft with the repo tool from real documents, then human review: `uv run --directory eval python -m rag_eval.draft --source supabase --user <uuid> --out eval/golden/private/golden.jsonl --n 100 --split-manifest eval/golden/private/split-manifest.json` (or `--no-claude` to use only the free Ragas path; `--source dir:<path>` for local files) | — |
| Task 3: sweep and calibration | Golden set, live baseline, app URL, `RAG_EVAL_SECRET`, `COHERE_API_KEY` / `VOYAGE_API_KEY` in the app env. Note the Cohere trial cap (10 calls per minute, 1000 per month) limits how many calibration runs fit | same | `uv run --directory eval python -m rag_eval.sweep retrieval --run-config <live v2 config> --golden <real golden> --base-url <app url> --out eval/out/live-sweep --write-params`; `uv run --directory eval python -m rag_eval.calibrate refusal --run-config <live v2 config> --golden <real golden> --base-url <app url> --out eval/out/live-calibration --write-thresholds` |
| Task 3 step 4: Config UI panels | Running app plus `npm run config`, an admin session in a browser | owner's machine | `npm run config`, then `http://localhost:3333` |
