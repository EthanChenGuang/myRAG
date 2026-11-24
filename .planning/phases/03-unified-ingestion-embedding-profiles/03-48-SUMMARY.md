# 03-48 Live verification summary

**Status:** Task 1 + Task 2 (API-level, fake data) recorded from operator box (2026-11-24 ~13:13 Europe/Rome). Task 3 pending. No secrets in this file.

## Task 1 — Live Supabase (2026-11-24, ppvywaxrycaxrtrrditl, multi-tenant)

- Backup before change: logical backup via Supabase management SQL (box egress cannot reach Postgres, no pg_dump): off-DB JSON of 11 non-empty tables + full catalog, sha256 recorded; in-DB schema backup_pre0301_20261124 (row counts verified, anon/authenticated revoked).
- Inventory: documents 1 (source upload), document_chunks 1, DB 14 MB, pgvector 0.8.0, no migration history, no 0301+ objects.
- `multi-tenant-setup.sql` NOT applied (42710, not idempotent), rolled back cleanly.
- Applied all 22 in `--list-migrations multi-tenant` order: 0301, 0301.multi-tenant, 0302–0305, 0306.multi-tenant, 0307–0315, 0316_quarantine_access.multi-tenant, 0316_quarantine_admin, 0317, 0318, 0319, 0351. Recorded in `supabase_migrations.schema_migrations`.
- `tenant_key` populated (`u:<user>`); legacy doc → version 1, current, ready, general, `source_key` `legacy:<id>`, source upload→config_upload; chunk promoted columns populated. Public tables 23 → 36. Active profile `openai-3-small-1536` (legacy_column); voyage/qwen3 profiles available.
- `rag-originals` bucket private (public=false, 20 MB, 0 policies): **PASS**. Tenant-prefix upload: **NOT RUN** (needs app with unified pipeline).
- Parity (`npm run test-rag` legacy): **NOT RUN** (prod build of 19 Nov predates 03-47). halfvec HNSW: **NOT RUN** (`chunk_embeddings` 0 rows, needs Voyage/Qwen3 keys).
- PostgREST and production app **200** after migration.
- Findings: **SECURITY DEFINER** RPCs still **EXECUTE**-able by `anon` on live (23 functions), including `match_document_chunks_by_org` and `match_documents_by_workspace` — caller-supplied org/user ids without `auth.uid()` check; `match_document_chunks_by_org` also returns `organization_id IS NULL` chunks to any caller. Root cause: `CREATE OR REPLACE` in **0306** left prior grants. **Follow-up (03-48-sec-rpc):** `supabase/migrations/0409_search_rpc_revoke.sql` + `tests/rag-db/search-rpc-grants-pglite.test.mts` on integration branch; apply on live after promote. See D-08 (03-20, 03-37, patch `supabase/patches/2026-11-search-rpc-revoke-multi-tenant.sql`).
- Supabase management SQL timed out until Postgres restart at **11:40 UTC** (12:40 Europe/Rome); healthy since.
- **PostgREST `authenticator` role:** `statement_timeout` and `lock_timeout` each **8s** — profile activation and heavy DDL must fit within that window or use a **direct Postgres session** (not PostgREST).

### Migrations on integration branch not yet applied live (after 0351)

Apply in repo order when promoting past Task 1 baseline:

| Migration file(s) | Phase / plan |
|-------------------|--------------|
| `0352_ingestion_claim.sql` | 03.1-07 |
| `0353_ingestion_transitions.sql` + `.multi-tenant.sql` / `.single-tenant.sql` | 03.1-08 |
| `0354_parse_budget.sql` | 03.1-09 |
| `0355_parse_cache.sql` | 03.1-10 |
| `0401_lexical_index.sql` | 04-06 |
| `0402_relex_batch.sql` | 04-06 |
| `0403_tenant_key_guard.*.sql` | 04-07 |
| `0404_document_parents.sql` | 04-07 |
| `0405_document_parents_rls.*.sql` | 04-07 |
| `0406_chunking_profiles.sql` | 04-07 |

Further numbered migrations (e.g. after **04-07** on trunk) must be re-listed at each live promotion.

## Task 2 — Live parsers and embedding providers (2026-11-24, API-level, fake data)

Recorded from operator box (13:13 Europe/Rome). No customer data; no API key material in this file.

- **T2.1 LlamaParse v2 — PASS:** v2 upload+poll as in `llamaparse-v2.ts` (`tier` `cost_effective`, `version` `latest`); fake 2-page en/it/zh invoice PDF with 3-col table; **COMPLETED** in 5.1 s, 2/2 pages, items heading/table/text; table HTML on page markdown matches item html so `applyTables` swap applies; item md is GFM with header row, empty cell kept; Italian diacritics and Chinese verbatim. `/api/v2/parse/versions` **200:** `cost_effective` 2026-11-09, `agentic` 2026-11-09, `fast` 2026-11-12 (**pin `cost_effective` 2026-11-09** if pinning).
- **T2.2 Docling OCR — NOT RUN (operator box):** needs Docker sidecar image (`docker build --target docling rag-sidecar`, zh/it fake scans, `docker stats` peak memory). **CI-only on cloud VM** (no Docker daemon here). Same gate for integration-branch CI unless a runner with Docker is added.
- **T2.3 Voyage `voyage-4-large` — PASS:** dim **2048** n=200 in 1.4 s, norms 1.0; en–it 0.901, en–zh 0.963, it–zh 0.891, unrelated 0.470; query ranks relevant > unrelated (0.546/0.525/0.489 vs 0.205). dim **1024** n=200, similar (0.904/0.965/0.893/0.460). Account has no payment method: free tier 3 RPM / 10K TPM, one **429** then retry OK — real reembed needs billing (owner decision); reembed CLI must respect 429/backoff.
- **T2.4a Qwen3-Embedding-8B via OpenRouter — PASS:** **200** in 1.16 s, **4096** dims, norm 1.0, upstream provider reported DeepInfra; Instruct/Query prefix changes query vector as intended (0.579 vs 0.735 without); MRL to **2048** per `mrl.ts` norm 1.000000; ranking identical full vs truncated (en>zh>it>off), max pairwise cosine delta 0.028.
- **T2.4b DeepInfra direct vs OpenRouter `cosine>0.999` — BLOCKED:** DeepInfra **402** (no balance). OpenRouter routes this model to DeepInfra; a real two-host check should pin a different OpenRouter provider.

**Task 2 verdict (plan):** partial — parser API + embedding providers verified; **Docling OCR path open until CI Docker run (T2.2)**; DeepInfra parity (T2.4b) open until funded second host.

## Task 3 — Re-embed, profiles, Nango, Config UI (pending)

Blocked: live re-embed / profile compare (billing + keys), unified ingest build, Nango connector test in Config UI. Task 2 embedding APIs OK for dev; production reembed still needs owner billing decision (Voyage free-tier limits).