# 03-48 Live verification summary

**Status:** Task 1 recorded (box agent, multi-tenant Supabase `ppvywaxrycaxrtrrditl`). Tasks 2–3 **pending** (vendor keys, Nango, unified ingest build). No secrets in this file.

## Task 1 — Live Supabase (2026-11-24, ppvywaxrycaxrtrrditl, multi-tenant)

- Backup before change: logical backup via Supabase management SQL (box egress cannot reach Postgres, no pg_dump): off-DB JSON of 11 non-empty tables + full catalog, sha256 recorded; in-DB schema backup_pre0301_20261124 (row counts verified, anon/authenticated revoked).
- Inventory: documents 1 (source upload), document_chunks 1, DB 14 MB, pgvector 0.8.0, no migration history, no 0301+ objects.
- `multi-tenant-setup.sql` NOT applied (42710, not idempotent), rolled back cleanly.
- Applied all 22 in `--list-migrations multi-tenant` order: 0301, 0301.multi-tenant, 0302–0305, 0306.multi-tenant, 0307–0315, 0316_quarantine_access.multi-tenant, 0316_quarantine_admin, 0317, 0318, 0319, 0351. Recorded in `supabase_migrations.schema_migrations`.
- `tenant_key` populated (`u:<user>`); legacy doc → version 1, current, ready, general, `source_key` `legacy:<id>`, source upload→config_upload; chunk promoted columns populated. Public tables 23 → 36. Active profile `openai-3-small-1536` (legacy_column); voyage/qwen3 profiles available.
- `rag-originals` bucket private (public=false, 20 MB, 0 policies): **PASS**. Tenant-prefix upload: **NOT RUN** (needs app with unified pipeline).
- Parity (`npm run test-rag` legacy): **NOT RUN** (prod build of 19 Nov predates 03-47). halfvec HNSW: **NOT RUN** (`chunk_embeddings` 0 rows, needs Voyage/Qwen3 keys).
- PostgREST and production app **200** after migration.
- Findings: **SECURITY DEFINER** RPCs still **EXECUTE**-able by `anon` on live (23 functions), including `match_document_chunks_by_org` and `match_documents_by_workspace` — caller-supplied org/user ids without `auth.uid()` check; `match_document_chunks_by_org` also returns `organization_id IS NULL` chunks to any caller. Root cause: `CREATE OR REPLACE` in **0306** left prior grants. **Follow-up:** integration-branch migration + PGlite test (queued). See D-08 isolation follow-ups (03-20, 03-37, patch `supabase/patches/2026-11-search-rpc-revoke-multi-tenant.sql`).
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

## Task 2 — Parsers, embeddings, sidecar (pending)

Blocked: `LLAMA_CLOUD_API_KEY`, Docker sidecar image, Voyage/Qwen/DeepInfra/OpenRouter keys. See `03-48-LIVE-PREFLIGHT.md`.

## Task 3 — Re-embed, profiles, Nango, Config UI (pending)

Blocked: Task 2 + running app with auth + Nango connector test.