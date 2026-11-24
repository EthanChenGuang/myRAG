# 03-48 live verification — preflight (orchestrator, 2026-11-24)

Mechanical steps run **without** live Supabase, vendor keys, or Docker. Full SUMMARY verdicts remain open until real services are wired.

## Environment inventory (names only — no values)

| Variable / service | Cloud VM (this run) |
|--------------------|---------------------|
| `DATABASE_URL` (direct Supabase) | missing / placeholder |
| `SUPABASE_URL` | missing / placeholder |
| `SUPABASE_ANON_KEY` | missing / placeholder |
| `SUPABASE_SERVICE_ROLE_KEY` | missing / placeholder |
| `LLAMA_CLOUD_API_KEY` | missing / placeholder |
| `VOYAGE_API_KEY` | missing / placeholder |
| `DEEPINFRA_API_KEY` | missing / placeholder |
| `OPENROUTER_API_KEY` | missing / placeholder |
| `RAG_SIDECAR_SECRET` | missing / placeholder |
| `NANGO_SECRET_KEY` / `NANGO_PUBLIC_KEY` | missing / placeholder |
| **Docker daemon** | unavailable |
| **`.env.local`** | created from `init-env.js` template only (not committed) |

### Login / setup links (human only)

| Service | Link |
|---------|------|
| Supabase DB connection string | [Project Settings → Database](https://supabase.com/dashboard/project/_/settings/database) |
| LlamaCloud API key | [LlamaCloud API keys](https://cloud.llamaindex.ai/api-key) |
| Voyage AI | [Voyage dashboard → API keys](https://dash.voyageai.com/) |
| DeepInfra | [DeepInfra dashboard → API keys](https://deepinfra.com/dash/api_keys) |
| OpenRouter | [OpenRouter → Keys](https://openrouter.ai/keys) |
| Nango connector test | Config UI → Connectors (`npm run config` → http://localhost:3333) |

## Automated steps completed (Plan 03-48 preconditions)

| Step | Command / artifact | Result |
|------|-------------------|--------|
| Migration manifest (single-tenant) | `scripts/setup-database.sh --list-migrations single-tenant` | 0301–0319 + **0351** listed |
| PGlite schema parity | `node --import tsx --test tests/rag-db/schema-equality.test.mts` | **4 fail** — setup SQL not yet folded for **0351** / **0352** (expected until setup fold plan lands) |
| Phase 3 default gates | `03-47-SUMMARY.md` (`eval/out/p3-final*`) | recorded pass on executor |
| Package pins for Docling/L1 path | trunk lock `3e83978` | pdfplumber / ray optional extra |

## PostgREST (Task 1 note, 2026-11-24)

Role **`authenticator`**: `statement_timeout` **8s**, `lock_timeout` **8s**. Profile activation gates and long migrations must complete within that budget or use a **direct Postgres session** (management SQL / `psql`), not PostgREST.

## Task 1 recorded

See **`03-48-SUMMARY.md`** (box agent, project `ppvywaxrycaxrtrrditl`). Integration branch agents **do not** apply further live migrations.

## Blocked live tasks (need Guang or secrets injection)

| Task | Blocker |
|------|---------|
| 1 Supabase inventory, migrate, live parity, bucket, halfvec HNSW | `DATABASE_URL` + backup + direct session |
| 2 LlamaParse, Docling OCR, Voyage, Qwen hosts | API keys + Docker sidecar image |
| 3 Re-embed, profile compare, Nango sync, Config UI panels | Tasks 1–2 + running app with auth |

Do not commit `03-48-SUMMARY.md` until all three checkpoint verdicts are recorded (no key material).