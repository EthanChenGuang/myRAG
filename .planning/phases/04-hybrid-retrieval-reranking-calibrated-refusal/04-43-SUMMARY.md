---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 43
subsystem: database
tags: [live-verification, supabase, pgvector, lexical, grants, rerank, voyage, cohere, latency]
requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "migrations 0401-0413 folded into the setup files (04-42), rag:relex (04-16), Cohere/Voyage adapters and tier selection (04-09, 04-23, 04-28), sweep and calibration tools (04-25, 04-30, 04-35, 04-36)"
provides:
  - "Recorded verdicts for every Phase 4 live check this session could reach: hosted pgvector version and lc_ctype, relex coverage, real-data exact-identifier lexical search, grants (catalog, role switch and PostgREST with the real anon and publishable keys), Chinese tokenization on the hosted database, reranker p50/p95 on a real 75- and 50-chunk pool, live response shapes, and the F-8 rule"
  - "An Operator pending list with copy-paste steps for the checks that need a running non-production app, the service-role key, a real golden set or a paid Cohere key"
affects: [04.1, 07, ADM-02]
actuals:
  tokens: 4500
  tasks: 3
  commits: 1
tech-stack:
  added: []
  patterns: []
key-files:
  created:
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-43-SUMMARY.md
  modified: []
key-decisions:
  - "Live target is the eval project myrag-medical (multi-tenant, Italian-only public AIFA leaflets), not production; production was not touched"
  - "F-8 for the production reranker (Voyage rerank-3, chat quality tier): rule does not fire; keep rerankInputCap 75 and the quality tier"
  - "RAG_RERANK_VOYAGE_MODEL_BY_LANG stays empty: the zh/it rerank-3 vs rerank-2.5 comparison needs a real golden set (none exists)"
  - "RAG_HNSW_ITERATIVE_SCAN stays off by default (D-28); pgvector 0.8.2 supports it, so it is a Phase 7 option, not a requirement"
  - "No retrieval-params.json or refusal-thresholds.json write: the sweep and calibration tools were not run, because a fixture run would record fixture provenance as live"
requirements-completed: []
coverage:
  - id: D1
    description: "Hosted inventory: pgvector version/schema, locale, chunk counts, indexes"
    requirement: RET-03
    verification:
      - kind: manual_procedural
        ref: "Management API SQL on myrag-medical (Task 1 table)"
        status: pass
  - id: D2
    description: "anon and publishable keys refused by the real function grants through PostgREST"
    requirement: RET-04
    verification:
      - kind: manual_procedural
        ref: "POST /rest/v1/rpc/{hybrid_search_chunks,match_chunks_by_profile,rag_fetch_parents,rag_assert_tenant_key}"
        status: pass
  - id: D3
    description: "Exact-identifier lexical leg on real data"
    requirement: RET-03
    verification:
      - kind: manual_procedural
        ref: "30 sampled identifiers, hybrid_search_chunks dense_limit 0, lexical_limit 50"
        status: pass
  - id: D4
    description: "Reranker latency and response shapes on a real pool, F-8 applied"
    requirement: LAT-02
    verification:
      - kind: manual_procedural
        ref: "Voyage rerank-3 / rerank-3-lite / rerank-2.5, Cohere rerank-v5.0-pro (partial) live calls"
        status: pass
  - id: D5
    description: "Live parity, Voyage zh/it comparison, retrieval sweep, refusal calibration, XLG-03, chunking and Config UI checks"
    requirement: RNK-05
    verification:
      - kind: manual_procedural
        ref: "Operator pending"
        status: unknown
---

# Phase 4 Plan 43: live verification summary

**Status: partially verified.** I ran every check this session could reach on the eval Supabase project and the vendor APIs, and all of them passed. The rest are listed under "Operator pending": they need a running non-production app, the service-role key, a real golden set or a paid Cohere key. No requirement is marked complete by this plan: RET-03, RET-04, RET-10, RNK-01, RNK-02, RNK-05, LAT-02, XLG-03, CHK-04 and CHK-05 keep their status from plans 04-01 to 04-42, which have fixture evidence only.

This summary replaces `04-43-LIVE-PROGRESS.md` (2026-11-25, a different live project that has almost no data) as the record for this plan. The earlier file stays for reference. Its synthetic-text Cohere numbers are the only Cohere latency evidence: the Cohere trial key reached its monthly cap during this run.

## Scope and rules followed

- **Target:** the eval project `fsgaeysipkukqoocgzbx` (myrag-medical, Postgres 17, eu-west-1), reached through the Supabase Management API via the proxy. The Supabase MCP tool refused access to this project, so the Management API was used instead. Production (`ppvywaxrycaxrtrrditl`) and production Vercel settings were not touched.
- **Writes:** none. Every SQL statement was read-only or ran inside a transaction that was rolled back. No migration was applied.
- **Keys:** only the two public keys (legacy anon and `sb_publishable_`) were read. They stayed in process memory, and a temporary file holding them was deleted. A request for the secret keys was refused by the session's permission classifier, and I did not try again. No key is recorded here.
- **Data:** the corpus is public Italian drug leaflets (AIFA RCP/FI). Chunk text from it was sent to Voyage and Cohere for the latency runs. The probe queries were generic Italian questions written for the test. This summary records no query, term, chunk text, document name or tenant id.
- **Autonomy:** the owner delegated every checkpoint decision. For each one I took the recommended option and record the reason below.

## Task 1: live Supabase

| Item | Result | Verdict |
|---|---|---|
| pgvector | 0.8.2, schema `public` | pass. `hnsw.iterative_scan` is available (version 0.8.0 or later), so the "below 0.8.0" rule does not apply. `RAG_HNSW_ITERATIVE_SCAN` stays off by default (D-28). |
| Locale | `datctype` / `datcollate` `en_US.UTF-8`, provider `i`, encoding UTF8 | pass. The verbatim builder `rag_lexical_tsvector` produces the same tokens under any locale. |
| Deployment mode | multi-tenant; one organization tenant (`o:`). `s:default` is refused with 22023 | pass |
| Inventory | 827 documents, 25,656 chunks, all `language = it`. Table plus indexes 520 MB. HNSW index on `embedding` and the lexical GIN index both present. 11 embedding profiles, active `openai-3-small-1536` | recorded |
| Migrations | schema_migrations ends at train 29 (`0410_r13_delta`, 2026-11-26). Phase 4 objects are present with their final signatures | pass. Migrations were already applied by the merge train, so step 2 (`CREATE INDEX CONCURRENTLY`, apply in order) was not needed. |
| Relex (step 3) | 25,654 of 25,656 chunks have a non-empty `lexical_tsv`, all `lexical_version = 2`. The 2 empty rows match no lexical query (they do not break it) | pass on coverage. The kill-and-resume run and `VACUUM (ANALYZE)` were not run, because they write: see Operator pending. |
| Exact-identifier lexical search on real data (step 4) | 30 identifier lexemes (letters and digits, 4 to 20 characters) sampled from 30 random chunks. Each was searched as a lexical-only call (`p_dense_limit 0`, `p_lexical_limit 50`) under the real organization key. **All 21 identifiers that match fewer than 50 chunks were found in the lexical leg:** rank 1 for 4 of them, top 10 for 12, median rank 8, worst rank 46. The other 9 match more than 50 chunks, so the source chunk is legitimately outside the 50-row pool (these are common codes, not unique IDs). Each call took about 750 ms through the Management API. | pass |
| Chinese lexical behaviour on the hosted database | `rag_lexical_tsvector('型号 xr-2000 xr2000 设备')` = `'xr-2000':2 'xr2000':3 '型号':1 '设备':4`, and `to_tsvector('simple', …)` splits off `'-2000'`. The whole code `xr-2000` matches through the verbatim builder and does not match through `simple`. This is exactly the result in 04-RESEARCH F-1. | pass (synthetic text). The corpus contains no Chinese characters (0 chunks), so the step 4 Chinese check on real data cannot run on this project: see Operator pending. |
| Grants, catalog | `hybrid_search_chunks`, `match_chunks_by_profile`, `rag_fetch_parents`, `rag_assert_tenant_key`, `rag_lexical_tsvector`, `rag_lexical_tsquery`, `rag_relex_batch`: anon false, authenticated false, service_role true, all `search_path=""`. Only two `rag_*` / search functions are executable by `authenticated`: `rag_ingest_realtime_topic_allowed(text)` and `rag_is_domain_expert(text)`, both by design (realtime policy and expert RLS) and both refused to anon. | pass |
| Anon and publishable keys through PostgREST (T-04-92) | HTTP 401, SQLSTATE 42501 `permission denied for function …` for all four RPCs with both keys. A first call with a partial argument set got 404 PGRST202 (no matching signature), and the call was repeated with the real argument names. | pass |
| Legacy invoker search functions | `match_document_chunks` and `match_documents_by_organization` are still executable by anon and authenticated, but they are SECURITY INVOKER. In a rolled-back transaction: anon got 0 rows from both and 0 rows from `document_chunks`; authenticated without a JWT, passing the real organization id, got 0 rows. | pass. RLS holds. A follow-up note is recorded below. |
| V2 `search_path` | One row: `rls_auto_enable()`, a platform event-trigger function that is not from the repository (`search_path=pg_catalog`; an event trigger cannot be called through RPC) | pass (not a repository function) |
| V3 RLS | RLS is on for all 10 RAG tables checked | pass |
| Security advisors | No ERROR-level items. WARN: 5 anon-executable SECURITY DEFINER functions (`check_admin_status`, `is_org_admin`, `is_org_member`, `is_org_owner`, `rls_auto_enable`; none from Phase 4), 4 `function_search_path_mutable` (pre-Phase-4 helpers), `extension_in_public` (vector; do not act on it, per AGENTS.md), leaked-password protection off | recorded; no Phase 4 item |
| Live legacy parity (step 5) | not run | Operator pending |

Observation (no bug): `hybrid_search_chunks` creates `pg_temp._hybrid_eff_profile ... ON COMMIT DROP`, so a second call in the same transaction fails with 42P07. The app makes one PostgREST call per request, so each call runs in its own transaction and is not affected. Anyone calling it twice in one SQL transaction (an ad-hoc script, a future batch RPC) will hit this error. Recorded for Phase 4.2 / 6 authors.

## Task 2: live rerankers

Method: a real pool of 75 Italian chunks (about 1,460 characters each) was drawn from the eval corpus, together with 10 generic Italian questions used in rotation. For each model: 1 warm-up call that is not counted, then 20 timed calls. Wall time was measured from this container through the HTTPS proxy. p50 and p95 use linear interpolation. The request bodies match the app adapters: Voyage `{model, query, documents, truncation: true, return_documents: false}`, Cohere `{model, query, documents}`.

### Latency, real pool

| Model | Pool | p50 ms | p95 ms | min / max | over 600 ms | over 250 ms | billed per call |
|---|---|---|---|---|---|---|---|
| Voyage `rerank-3` (production) | 75 | 175 | 256 | 133 / 368 | 0 / 20 | 2 / 20 | 33.4k total_tokens |
| Voyage `rerank-3-lite` (fast tier) | 75 | 140 | 250 | 117 / 312 | 0 / 20 | 1 / 20 | 33.4k |
| Voyage `rerank-2.5` (per-language override) | 75 | 164 | 231 | 138 / 289 | 0 / 20 | 1 / 20 | 33.4k |
| Voyage `rerank-3` | 50 | 150 | 245 | 127 / 259 | 0 / 20 | 1 / 20 | 22.3k |
| Voyage `rerank-3-lite` | 50 | 125 | 231 | 105 / 318 | 0 / 20 | 1 / 20 | 22.3k |
| Cohere `rerank-v5.0-pro` | 75 | 418 | 492 | 410 / 504 | 0 / 4 | 4 / 4 | 26.0k input_tokens; upstream p50/p95 380/384 |
| Cohere `rerank-v5.0-fast` | — | not measured | | | | | trial key at its 1000-calls-per-month cap (HTTP 429) |

The Cohere pro row has only 4 samples, because the trial cap was reached after the 4th call. For Cohere, the 20-sample synthetic-text numbers in `04-43-LIVE-PROGRESS.md` (pro p95 637 ms, fast p95 465 ms) are the evidence of record.

### Response shapes

All Voyage responses had `data[]` with 75 (or 50) entries, each with `index` and `relevance_score`, and `usage.total_tokens`. The Cohere responses had `results[]` with `index` and `relevance_score`, and `meta.billed_units.input_tokens`. This matches the recorded fixtures, except that the fixtures show `search_units`. The adapter treats `billed_units` as opaque, so no code change is needed (already noted in the progress file). No request sent `top_n` or `top_k`: the adapter request-body spy in the progress file covers this, and the bodies above carry neither field.

### F-8 rule (if p95 for 75 documents exceeds the timeout, lower `rerankInputCap` toward 50 or move chat to the fast tier)

| Profile (timeout) | Provider | Finding | Decision |
|---|---|---|---|
| chat (600 ms), quality | Voyage `rerank-3` (production) | p95 256 ms, 0 of 20 calls over 600 ms | Rule does not fire. **Keep the quality tier and cap 75.** |
| voice (250 ms), fast | Voyage `rerank-3-lite` | p95 250 ms at cap 75 (1 of 20 over) and 231 ms at cap 50 (1 of 20 over) | Right at the limit, so I expect rerank to be skipped on about 5% of voice turns. **Keep cap 75 and the 250 ms timeout**, because cap 50 gives no clear gain (one slow call either way). Watch `rerank_skipped_rate` from the deployment region. |
| chat (600 ms), quality | Cohere `rerank-v5.0-pro` | real pool p95 492 ms (n = 4); synthetic p95 637 ms (n = 20) | The synthetic run stands: if Cohere is chosen, set `RAG_RERANK_TIER_CHAT=fast`. Not the production provider. |
| voice (250 ms), fast | Cohere `rerank-v5.0-fast` | synthetic p50 292 ms | Do not use Cohere for voice (decision unchanged). |

The real-pool Voyage numbers agree with the synthetic run within about 10 ms at p50, which confirms that the pool content barely moves latency. Caveat: these were measured from this container, not from the Vercel `iad1` region.

### Voyage per-language comparison (step 3)

Not run. It needs a real golden set with zh and it items and a running app. `RAG_RERANK_VOYAGE_MODEL_BY_LANG` stays empty. Note: the eval corpus is Italian only, so a future it-slice comparison can run on this project, but a zh slice cannot.

## Task 3: calibration, sweep, Config UI

Not run. No real golden set exists: the only golden file is `eval/fixtures/golden.jsonl` (synthetic). No reachable non-production app runs the Phase 4 code against this project, no live baseline exists, and `RAG_EVAL_SECRET` is not available to this session. Running the tools with `--write-params` / `--write-thresholds` on fixtures would record fixture provenance as live, so they were not run. Defaults stay off (D-28), and the choice of defaults stays with Phase 7 (ADM-02).

## Operator pending

Run these on your own machine, from the repository root on trunk. Report back counts and verdicts only.

1. **Point a local app at the eval project.** In `.env.local` set `NEXT_PUBLIC_SUPABASE_URL=https://fsgaeysipkukqoocgzbx.supabase.co`, the anon key and `SUPABASE_SERVICE_ROLE_KEY` for that project (Dashboard, Project Settings, API), `MYRAG_DEPLOYMENT_MODE=multi-tenant`, `RAG_PIPELINE=v2`, `RAG_LEXICAL_SEARCH=true`, `RAG_RERANKER=voyage`, `RAG_REFUSAL_FLOOR=legacy_rule`, `RAG_SUPPORTED_LANGUAGES=it`, `RAG_PRIMARY_LANGUAGE=it`, `RAG_EVAL_SECRET=<32+ random chars>` and `VOYAGE_API_KEY=<key>`. Then run `npm run dev`.
2. **Relex resume check (Task 1 step 3).** Run `npm run rag:relex -- --dry-run`, then `npm run rag:relex`, press Ctrl-C once partway through, and run `npm run rag:relex` again to resume. Then run `VACUUM (ANALYZE) document_chunks;` in the SQL editor. Record the rows processed and the duration. Expected: the job finds about 2 rows to do.
3. **Real golden set (unblocks everything below).** Run `uv run --directory eval python -m rag_eval.draft --source supabase --user <uuid> --out eval/golden/private/golden.jsonl --n 100 --split-manifest eval/golden/private/split-manifest.json`, then review the items by hand. Never commit this file.
4. **Live baseline and parity (Task 1 step 5).** Record a legacy baseline with `RAG_PIPELINE=legacy`, then run `npm run test-rag -- --base-url http://localhost:3000 --golden eval/golden/private/golden.jsonl --baseline <that baseline> --out eval/out/live-p4-parity`. Expected: no regression beyond the noise band.
5. **Voyage it comparison (Task 2 step 3).** Run the eval on the it slice with `rerankModel` set to `rerank-3`, then to `rerank-2.5`. Set `RAG_RERANK_VOYAGE_MODEL_BY_LANG=it:rerank-2.5` only if rerank-2.5 wins beyond the noise band. A zh comparison needs a project with zh documents.
6. **Sweep and calibration (Task 3 steps 1 and 2).** Run `uv run --directory eval python -m rag_eval.sweep retrieval --run-config <live v2 config> --golden eval/golden/private/golden.jsonl --base-url http://localhost:3000 --out eval/out/live-sweep --write-params`, then `uv run --directory eval python -m rag_eval.calibrate refusal --run-config <live v2 config> --golden eval/golden/private/golden.jsonl --base-url http://localhost:3000 --out eval/out/live-calibration --write-thresholds`. Commit only the files the tools write.
7. **Chinese exact term on real data (Task 1 step 4, zh part).** This needs a project with at least one zh document that contains a model number. Ask that term in chat and read the leg and rank from the `[Document Search]` trace.
8. **Cohere.** The trial key is at its monthly cap. Re-measure `rerank-v5.0-pro` / `-fast` (20 calls each) next month or with a production key, but only if Cohere is considered for production.
9. **Config UI (Task 3 step 4).** Run `npm run config`, open `http://localhost:3333`, and check the Refusal calibration panel warnings after step 6.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all pass
- vitest, rag-db, pytest, `test-rag`, gen:schemas: not applicable (no code, SQL, Python, contract or golden-set change)

## Deviations

- The live target was the eval project instead of "the user's Supabase project", per the brief. The Supabase MCP refused this project, so the Management API was used.
- Backup and the migration steps were skipped: the migrations were already live (train 29), and nothing was written.
- The real-data lexical check used Italian identifiers, because the corpus has no Chinese. The Chinese check ran on synthetic text on the hosted database.
- Cohere measurements are incomplete (trial cap).
- `uv sync` for rag-sidecar and eval was not run: no Python gate applies to this plan.

## Follow-ups (not gaps in Phase 4)

- `match_document_chunks` and `match_documents_by_organization` are pre-Phase-4 SECURITY INVOKER functions that anon can still execute. RLS returns nothing today, but revoking anon would remove a needless surface. A candidate for a later hardening plan; no change here.
- `hybrid_search_chunks` allows only one call per transaction (42P07 on `_hybrid_eff_profile`). Any future batch caller must account for this.

## Self-Check: PASSED
