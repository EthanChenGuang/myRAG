# myRAG Agents Guide

This document is the working guide for anyone, human or AI assistant (Claude, Codex, Cursor, Gemini, etc.), changing the myRAG codebase.

---

## 1. Mission & Responsibilities
- Ship and maintain a production-grade AI chat experience featuring Retrieval-Augmented Generation (RAG), multi-model orchestration, and multi-modal creation (text, images, video, 3D).
- Preserve stability, performance, and developer ergonomics across the Next.js 16.0.10 + React 19.2.1 stack.
- Safeguard user data, adhere to Supabase Row Level Security, and prevent secret leakage.

---

## 2. Platform Snapshot
| Layer | Details |
| --- | --- |
| Frontend | Next.js 16.0.10 App Router (React Compiler enabled), React 19.2.1, TypeScript, Tailwind CSS, Framer Motion, Zustand |
| Backend | Next.js API routes, Supabase (PostgreSQL + pgvector HNSW, storage, auth, realtime) |
| AI Stack | Vercel AI SDK 6.0.3 (OpenRouter, OpenAI, Anthropic, DeepSeek, Gemini, MCP integrations) |
| Voice | LiveKit + AssemblyAI STT + Resemble.ai TTS + Silero VAD |
| Integrations | WhatsApp (Baileys), Stripe & Polar payments, Nango (Google Drive/Notion/Dropbox), Meshy/Luma/Runway |

---

## 3. Prerequisites & Core Commands
- Node.js 22 (`^22.12.0`, see `.nvmrc`), npm, Supabase project, API keys for embeddings and preferred models.
- `npm run dev` – boots the app, auto-creates `.env.local` if missing, enables fast refresh.
- `npm run config` – opens the visual configuration dashboard at `http://localhost:3333` for env management, admin users, and RAG prompt tuning.

---

## 4. Development Guidelines
1. Match existing patterns (functional React, strict TS, Tailwind classes, Zustand stores, streaming chat APIs).
2. Prefer Zustand selectors + `useShallow` (from `zustand/react/shallow`) over subscribing to entire stores.
3. Validate all API inputs, return structured JSON errors, prefer streaming responses.
4. Keep comments minimal; only touch documentation by explicit request.
5. Mirror any `.env.local` change in `scripts/init-env.js` and other config defaults.
6. Run lint, type-checks, and relevant scripts before handing off work.
7. Never commit secrets, real phone numbers, or customer data; use placeholder values in tests and docs.

---

## 5. Repository Orientation
```
myrag/
├── src/
│   ├── app/api/         # Chat, documents, MCP approval, auth, WhatsApp endpoints
│   ├── components/      # UI components and providers
│   │   └── voice/       # Voice mode overlay, orb visualizer
│   └── lib/             # AI providers, RAG pipeline, MCP router, Zustand stores
│       ├── mcp/         # MCP integration
│       └── whatsapp/    # WhatsApp providers
├── voice-agent/         # Real-time voice service (LiveKit, STT, TTS)
├── baileys-whatsapp/    # WhatsApp integration service (Baileys)
├── scripts/
│   ├── config-ui/       # Visual config UI
│   ├── rag/             # RAG diagnostics and reprocessing helpers
│   └── whatsapp/        # WhatsApp helper scripts
└── supabase/            # SQL setup scripts
```

---

## 6. RAG & Data Pipeline
- Keep `RAG_SYSTEM_PROMPT` strings intact with the `{{context}}` placeholder.
- Diagnostics: `node scripts/rag/decode-rag-prompt.js`, `node scripts/rag/check-rag-flow.js`, `node scripts/rag/test-rag-system.js`.
- Supabase stores chats, documents, embeddings, subscriptions, WhatsApp sessions—respect RLS policies.
- Vector search: 1536‑dim embeddings + HNSW indexes (`m=64`, `ef_construction=200`).
- Watch console logs for `[Document Search]` to analyse retrieval behaviour.
- Latency budgets (p50/p95, text chat and voice) live in `eval/config/latency-budgets.json`; eval reports show per-stage latency against them; report-only until live measurements ratify them.
- All knowledge-base retrieval goes through `@/lib/rag` (resolve a `TenantScope` with `resolveTenantScope` / `resolveEmbedScope` / `resolveVoiceScope`, then `runRetrieval`); `scripts/ci/check-rag-boundary.mjs` fails on embedding, retrieval-RPC or reranker use elsewhere. Tenant checks have no off switch. Retrieval searches on the service-role client, so `SUPABASE_SERVICE_ROLE_KEY` must be set. Multi-tenant embed needs `RAG_EMBED_TENANT`; voice needs `RAG_VOICE_TOKEN_SECRET` (32+ chars).

### Image RAG
- Images uploaded via Config UI are captioned by GPT-4o Vision and embedded.
- Image chunks stored in `document_chunks` with `metadata.image_url`.
- Retrieved images streamed as `source_images` in chat responses.
- Images displayed above AI text, not cited in sources.

### Unified ingestion
- Unified path entry point: `ingest()` and `resumeIngest()` in `src/lib/rag/ingest/` (13 stages: identify → file_hash_dedup → store_original → parse → content_hash_dedup → scan_injection → chunk → enrich → extract → images → embed → write → publish).
- Fresh projects run `supabase/single-tenant-setup.sql` or `supabase/multi-tenant-setup.sql`, then apply ordered files under `supabase/migrations/` (common file first, then `.single-tenant.sql` / `.multi-tenant.sql` for that mode). Folded setup files already include Phase 3 (0301–0320), Phase 3.1 (0351–0359, 0420–0424), Phase 3.1.1 (0440–0442), Phase 4 (0401–0413, 0425), Phase 4.1.1 (0471–0473), Phase 5 (0501–0502), Phase 5.1.1 (0531–0537), Phase 6 (0601–0603) and Phase 6.1 (0651–0654), which closes the file; 0426, 0427, Phase 3.2 (0801–0822) and the later 07xx–10xx blocks are not folded yet; migrations remain the upgrade path and must be idempotent on top. pgvector must stay in schema `public`: 0425 stops with 55000 otherwise, so do not act on Supabase lint 0014 (`extension_in_public`) for `vector`.
- Switches (defaults in `src/lib/env.ts`): `RAG_INGEST_PIPELINE=legacy` (legacy writers vs unified pipeline), `RAG_EMBEDDING_PROFILES=off`, `RAG_INJECTION_SCAN=off`, `RAG_EXACT_ID_LOOKUP=false`, `RAG_PDF_IMAGE_CHUNKS=false`.
- Originals land in the private **`rag-originals`** storage bucket; quarantined documents stay out of retrieval (D-08 filter on current, ready rows—no env switch).
- Writer and search RPCs (`rag_*`, `match_chunks_by_profile`) are **service_role** only; tests assert anon/authenticated cannot execute them.
- Domain embedding bindings (Phase 3.1.1): `RAG_DOMAIN_EMBEDDINGS=off` (default; needs `RAG_EMBEDDING_PROFILES=on`) binds a doc type, per tenant or deployment-wide, to a scoped profile; `npm run rag:embedding -- bindings` lists them, and an active binding adds one additive dense leg under v2 next to the global profile. Activation needs comparison evidence with real items (fixture evidence is refused); a binding goes stale after a global profile flip and stops serving. The bulk backfill writes no binding vectors; the scoped re-embed fills them.

### Ingestion queue (Phase 3.1)
- Write paths call `submitIngest()`: inline `ingest()` with `RAG_INGEST_ASYNC=off`, the `ingestion_jobs` ledger with it on (unified pipeline only). Defaults reproduce Phase 3 and write no ledger, cache or budget row (`tests/rag-e2e/defaults-equal-phase3.test.mts`).
- Switches (defaults in `src/lib/env.ts`, read by `src/lib/rag/ingest/queue-config.ts`): `RAG_PARSE_ROUTING=fixed`, `RAG_PARSER_ALLOW_CLOUD=true`, `RAG_PARSE_PREMIUM_PAGE_BUDGET=0`, `RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC=200`, `RAG_PARSE_ESCALATION=on`, `RAG_PARSE_VLM_DETECT=false`, `RAG_PARSE_VLM_MODEL=` (empty: the captioning model), `RAG_INGEST_ASYNC=off`, `RAG_INGEST_WORKER_CONCURRENCY=2`, `RAG_PARSE_PROGRESSIVE=false`, `RAG_EMBED_BATCH_MODE=sync`, `NEXT_PUBLIC_RAG_INGEST_REALTIME=false`. `tiered` routing needs `RAG_INGEST_PIPELINE=unified` and `RAG_INGEST_ASYNC=on`; an invalid combination falls back to Phase 3 behaviour with a warning.
- The worker runs in the sidecar: `RAG_INGEST_WORKER=on` (default off: the sidecar starts no worker) with `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RAG_APP_INTERNAL_URL` and `RAG_SIDECAR_SECRET`; it calls back into `/api/internal/rag/ingest/jobs/[id]/*`.
- Bulk import: `npm run rag:backfill -- --tenant <key> --source <folder|bucket|manifest>:<ref> --budget <USD>`. The sample dry run always runs first; without `--budget`, or with `--dry-run`, the command stops after the report (exit 2). `--resume <batch_id>` continues a batch.
- `RAG_PARSER_ALLOW_CLOUD=false` applies in every pipeline: no request reaches LlamaParse or the vision model; the legacy knowledge-base PDF upload answers 503 `cloud_parsing_disabled`, the unified chain parses locally.
- Tier routing thresholds and presets live in `config/rag/parse-routing.json` (read by the app and the sidecar). The sidecar image ships copies of it and `processing-profiles.json` from `rag-sidecar/config/rag/` (as `/app/config/rag/`); edit both, a sidecar test fails when they differ.

### Language support and ingestion hardening (Phase 3.2)
- Languages: `RAG_SUPPORTED_LANGUAGES=` (registry codes, comma-separated) and `RAG_PRIMARY_LANGUAGE=` (one of them), both empty by default. Read them only through `getLanguageSettings()` in `src/lib/rag/lang/settings.ts`; the one validator is `config/rag/validate-language-settings.cjs` (`validateLanguageSettings`, `normalizeLanguageSettings`), used by the app (`validateConfiguredLanguages`, startup check in `src/lib/rag/lang/startup.ts`), `scripts/init-env.js` and the Config UI Languages panel. One code is monolingual: no translation, no cross-lingual legs.
- Unset rule: with the two variables empty, every path that needs them (`RAG_PIPELINE=v2`, an explicit `RAG_INGEST_PIPELINE=unified` write, which answers 503) reports `languages_not_configured`; an unset `RAG_PIPELINE` serves legacy and reads no language setting. The eval pins its languages explicitly.
- Registry: `config/rag/language-packs.json` with its sidecar copy `rag-sidecar/config/rag/language-packs.json` (a test fails when they differ; the same holds for `hidden-text-rules.json` and `table-header-rules.json`). `node scripts/ci/check-language-literals.mjs` fails on language codes or per-language literals outside the registry; exceptions go in `scripts/ci/language-literal-allowlist.json`.
- Other switches (defaults in `src/lib/env.ts`): `RAG_LANGUAGE_AWARE_INGEST=off`, `RAG_TABLE_HEADER_REPEAT=always`, `RAG_TABLE_ROW_SERIALIZATION=false`, `RAG_CAPTION_LANGUAGE=en`, `RAG_BGE_M3_SERVING=hosted`, `RAG_DOC_TRANSLATION=off`, `RAG_DOC_TRANSLATION_MODEL=` (empty: `RAG_QUERY_LLM_MODEL`), `RAG_HIDDEN_TEXT_CHECK=off`, `RAG_INGEST_LINK_CHECK=off`, `RAG_OUTPUT_LINK_ALLOWLIST=`, `RAG_UPLOAD_APPROVAL=off`, `RAG_SCOPE_TAGS=false`, `RAG_SCOPE_TAG_SUGGEST=false`, `RAG_SUPERSESSION_DETECT=off`, `RAG_EFFECTIVE_DATES=false`, `RAG_EFFECTIVE_DATE_LLM_EXTRACT=false`. Each variable is classified ingestion- or query-side in `config/rag/settings-classification.json` (`node scripts/ci/check-settings-classification.mjs`).
- Ingestion fingerprint: every version records `ingest_fingerprint` (sha256 of the ingestion-side settings). Changing an ingestion-side setting shows the count of affected documents (admin `ingest-fingerprint` route, Config UI impact dialog) and starts nothing by itself. Commands: `npm run rag:fingerprint -- backfill [--tenant <key>] [--dry-run]`, `npm run rag:rebuild -- start --mechanism <reparse|rechunk|relex|reembed|recaption|retranslate> [--dry-run]`, `npm run rag:rebuild -- record-eval <run_id> --report <gate.json>`, `npm run rag:rebuild -- rescan --check <hidden_text|links>`.
- Tables: `RAG_TABLE_HEADER_REPEAT=always` repeats the header row in every table chunk, also for a table continued across a page; `profile` keeps each processing profile's own rule. The default `always` was decided from the eval comparison in `eval/decisions/03.2-table-header-default.json`. `RAG_TABLE_ROW_SERIALIZATION=true` adds column=value row lines to a table chunk's lexical text; chunk content never changes.
- Captions: `RAG_CAPTION_LANGUAGE=document` captions images in the document's language (quoted text stays as written); `en` sends the pinned English prompt unchanged. Existing captions are redone with `npm run rag:reembed -- --recaption [--tenant <key>] [--dry-run]` (`--resume <runId>`, `--rollback <runId>`).
- Security checks: `scan_injection` runs three independent checks, each with its own switch: injection rules (`RAG_INJECTION_SCAN`), hidden text (`RAG_HIDDEN_TEXT_CHECK`, sidecar `POST /v1/hidden-text` plus zero-width rules) and links (`RAG_INGEST_LINK_CHECK`); the last two take `off | flag | quarantine`. `flag` records a report; `quarantine` quarantines with a typed reason, and a check that cannot run fails the run closed. `documents.hidden_text_check` is `clean`, `hidden_found` or `not_checked` (text input has no styling checker, so it is never `clean`). Link targets are checked against `RAG_OUTPUT_LINK_ALLOWLIST` plus the host of `NEXT_PUBLIC_SITE_URL` (`src/lib/rag/security/link-allowlist.ts`, reused unchanged at answer time by Phase 5.2); no target is fetched. Hidden spans and link targets are shown in the Config UI as escaped text only and are never logged.
- Upload approval: `RAG_UPLOAD_APPROVAL=members` holds uploads of non-admins, `all` holds every upload except exemptions; a held version is written in full and stays `pending_review`, outside retrieval, until an admin (or the organization's admin for its tenant) approves it (`/api/rag/admin/upload-approvals`). The legacy writers cannot hold a document, so with approval on and `RAG_INGEST_PIPELINE=legacy` every knowledge-base write answers 503 `upload_approval_requires_unified_pipeline`.
- Scope tags, supersession, effective dates: `RAG_SCOPE_TAGS=true` filters retrieval by the tenant's scope vocabulary and document tags (`RAG_SCOPE_TAG_SUGGEST=true` suggests tags at upload); `RAG_SUPERSESSION_DETECT=on` proposes "replaces" candidates after publish for an admin to confirm, never automatically; `RAG_EFFECTIVE_DATES=true` makes v2 retrieval skip chunks outside their effective dates (rules-first extraction, `RAG_EFFECTIVE_DATE_LLM_EXTRACT=true` adds a small-model call; admins confirm dates).
- Document translation: two-level opt-in, the deployment switch `RAG_DOC_TRANSLATION=on` (more than one supported language) and the tenant's own target setting (`/api/rag/admin/translation-settings`). With `RAG_INGEST_ASYNC=off` a publish translates inline within its budget; with it on it enqueues `translate` jobs. Backfill: `npm run rag:translate -- --tenant <key> [--dry-run] [--budget <USD>] [--resume] [--language <code>]` (dry run first; without `--budget` it stops after the report, exit 2); `--reembed --budget <USD>` writes vectors for existing translations.
- Migrations 0801–0822 (0811 is the BGE-M3 profile, Phase 3.2.1) are not folded into the setup files; they replace functions last defined in older files, so after re-running any older migration or setup file, re-run the whole 08xx block in order. Each new store has a service-role `rag_purge_hook_<name>(p_tenant_key, p_lineage_id, p_document_ids)` (scope tags, supersession, rebuild, recaption, chunk translations and their gaps).
- Observability: the ingestion trace carries `language_shares`, `und_count`, `ingest_fingerprint`, `scan.injection`, `scan.hidden_text`, `scan.links`, `approval_state`, `translation.translated` and `translation.gaps`, each only while the switch that produces it is on; log prefixes `[RAG Languages]`, `[Ingest]`, `[RAG Security]`, `[Translation]` carry counts, reason kinds and ids only.

### BGE-M3 fallback embedding (Phase 3.2.1)
- Profile `bge-m3-1024` (`BAAI/bge-m3`, 1024 dims, halfvec, dense only, no query instruction) is seeded `available` by migration 0811, which is not folded into the setup files. It is activated only through `npm run rag:embedding` and the EMB-05 gate (backfill with `npm run rag:reembed -- --profile bge-m3-1024`, record comparison evidence, activate); nothing activates it automatically.
- Serving: `RAG_BGE_M3_SERVING=hosted|sidecar` (default `hosted`). `hosted` calls DeepInfra and reuses `DEEPINFRA_API_KEY`; `sidecar` posts to the sidecar `POST /v1/embed` (`RAG_SIDECAR_URL`, `RAG_SIDECAR_SECRET`). Sidecar mode never falls back to the hosted API: not configured, an HTTP error, a timeout or a different weights revision fails with `embedding_sidecar_unavailable`. `RAG_BGE_M3_VIA=deepinfra|openrouter` (default `deepinfra`) picks the host of hosted calls: `openrouter` uses `OPENROUTER_API_KEY`, pins the DeepInfra upstream (another upstream is refused as a model mismatch) and records host `openrouter` on the vectors it writes; `DEEPINFRA_BASE_URL` and `DEEPINFRA_API_KEY` are untouched. Serve `bge-m3-1024` through OpenRouter only after `npm run rag:embedding -- verify-route bge-m3` (or `--reference <vectors.json>` with DeepInfra-made vectors) reports `match` (min cosine 0.999).
- The sidecar extra `bge-m3` (same `torch` and `transformers` pins as `hhem`) ships in the `docker build --target bge-m3 rag-sidecar` image, with the weights baked at a pinned revision, sha256-checked and loaded offline; the app refuses a sidecar answering another revision. CPU serving: about 2.3 GB of weights, plan 4–5 GB of RAM; one batch at a time.
- Comparison: `node --import tsx eval/harness/run-profile-compare.mts` runs `bge-m3-1024` as one more arm beside the other profiles (every slice, `cross_lingual` per query and document language pair) with ingestion throughput, query embed latency and cost for each serving mode; a mode that was not measured reads `not measured`. A fixture run is wiring proof: it gives no verdict, and `rag:embedding record-evidence` refuses it as `fixture_evidence`. The real comparison is live verification.

### Hybrid retrieval (Phase 4)
- `RAG_PIPELINE=legacy` (default) runs none of Phase 4. `RAG_PIPELINE=v2` runs the v2 stage graph; with every sub-switch off it is dense-only search through `hybrid_search_chunks`, then RRF over one leg and the Phase 2 assembly.
- Phase 4.1 tested v2 with lexical search, `RAG_RERANKER=auto` and the refusal threshold as the shipped default and did not flip it (`eval/decisions/04.1-retrieval-defaults.md`, status `not_flipped`): an unset `RAG_PIPELINE` serves legacy and reads no language settings. v2 is opt-in with `RAG_PIPELINE=v2`, which answers status `error` with reason `languages_not_configured` until the supported languages are chosen (`RAG_SUPPORTED_LANGUAGES`, `RAG_PRIMARY_LANGUAGE` or the Config UI picker; the chat route reports it as the knowledge-base outage) and `backend_error` while the Phase 4 migrations are missing. Setting `RAG_PIPELINE=legacy`, or removing the variable, switches back; the CI legacy smoke tiers require an explicit-legacy run to match the committed baselines exactly.
- Sub-switches (defaults in `src/lib/env.ts`, all off): `RAG_LEXICAL_SEARCH=false`, `RAG_RERANKER=none` (`cohere | voyage | local_bm25 | auto`; `auto` uses Cohere when `COHERE_API_KEY` is set, which sends query and candidate text to Cohere, else `local_bm25`; Voyage runs only when named), `RAG_RERANK_TIER_CHAT=quality`, `RAG_RERANK_TIER_VOICE=fast`, `RAG_RERANK_VOYAGE_MODEL_BY_LANG=`, `COHERE_API_KEY=`, `COHERE_BASE_URL=`, `RAG_REFUSAL_THRESHOLD=false`, `RAG_REFUSAL_FLOOR=similarity` (`legacy_rule`), `RAG_CONTEXT_EDGE_ORDER=false`, `RAG_CONTEXT_COMPRESSION=false`, `RAG_CONTEXT_TOKEN_BUDGET=6000`, `RAG_PARENT_CHILD=false`, `RAG_HNSW_ITERATIVE_SCAN=off`, `RAG_EXACT_SCAN_CUTOFF=0`, `RAG_LEXICAL_TRANSLATION=false`.
- `hybrid_search_chunks`, `rag_fetch_parents`, `rag_assert_tenant_key` and the relex, chunk-writer, rechunk and chunking-profile functions are **service_role** only. The app calls them on the admin client with `scopeKey` as the only tenant input; the SQL guard rejects a tenant key of the other deployment mode.
- Commands: `npm run rag:relex` (rebuild lexical text), `npm run rag:rechunk` (build a chunking profile), `npm run rag:chunking` (status, activate, rollback), `python -m rag_eval.sweep retrieval|chunking|chunking-decide` and `python -m rag_eval.calibrate refusal` (from `eval/`).
- Only those tools write `eval/config/retrieval-params.json`, `eval/config/refusal-thresholds.json` and the chunking decisions; do not edit them by hand. Fixture-fitted cells and the fixture similarity floor (`RAG_EVAL_RETRIEVAL_MIN_SIMILARITY`) apply only in eval, never in production.
- Chunking profiles: documents uploaded while `RAG_PIPELINE=legacy` are not written into non-legacy profiles; under v2 they are answered from their legacy chunks and counted as missing (v2 startup warning, admin list, Config UI), and `npm run rag:rechunk -- --profile <id>` repairs an active profile in place.

### True BM25 lexical scoring (Phase 4.4)
- Switches (defaults in `src/lib/env.ts`, query-side): `RAG_LEXICAL_SCORING=ts_rank_cd` (`bm25`), `RAG_LEXICAL_BM25_K1=1.2` (0.5 to 3), `RAG_LEXICAL_BM25_B=0.75` (0 to 1); an invalid value falls back to the default with one `[RAG Config]` warning. `ts_rank_cd` makes no new call and writes no statistics row. Not flipped: `eval/decisions/04.4-lexical-scoring.md` (status `not_flipped`); a flip is an owner decision on the live evidence of plan 04.4-15, through `rag_eval.ship_check` once the gate population is `real`.
- `bm25` is effective only with `RAG_PIPELINE=v2` and `RAG_LEXICAL_SEARCH=true` (otherwise one warning and `ts_rank_cd`), and only for a tenant whose statistics are built: run `npm run rag:lexstats -- enable --all`, then `check --all`, before setting it. The lexical leg is then served by `rag_bm25_search_chunks` (two passes: at most `min(2000, max(500, 5 × limit))` candidates, then exact BM25).
- Fallback, never a refusal: a tenant without ready statistics, or a failed BM25 call, gets the `ts_rank_cd` leg of `hybrid_search_chunks`; the search stage records `lexical_stats_unavailable` or `lexical_bm25_failed` (`lexical_scoring_bm25` when BM25 served).
- Statistics are per tenant (`rag_lexical_stats_state`, `rag_lexical_df`, `rag_lexical_corpus`, `rag_lexical_stats_pending`; RLS on, service role only): a tenant's document frequencies and lengths never mix with another tenant's. Under `bm25` publish and relex compact the tenant they wrote; `npm run rag:lexstats -- <enable|rebuild|compact|check|status|disable>` (`--tenant <key>` or `--all`) maintains them by hand and prints tenant-key hashes and counts only. The optional `supabase/optional/lexical-stats-schedule.sql` (pg_cron, opt-in) compacts what those callers left. The purge hook is `rag_purge_hook_lexical_stats`.
- Migrations 0900 to 0904 are not folded into the setup files. `rag_bm25_search_chunks` (0904) repeats every filter of `hybrid_search_chunks`: any migration that adds a filter parameter to `hybrid_search_chunks` must add it, with the same predicate, to `rag_bm25_search_chunks` from its newest body (`tests/rag-db/bm25-filter-parity.test.mts` fails otherwise); after re-running 0904, re-run every later file that redefines it.
- Proof: `uv run --directory eval python -m rag_eval.phase44_gate --spec eval/config/phase44-comparison.json --out eval/reports/phase-04.4` (fixture, both modes); real set: `python -m rag_eval.lexical_compare` (from `eval/`).

### Terminology dictionary (Phase 4.1.1)
- Switches (defaults in `src/lib/env.ts`, all off and staying off until real colloquial items from Phase 5.1.1 pass the gate): `RAG_TERMINOLOGY=false`, `RAG_TERMINOLOGY_DENSE=false` (needs `RAG_TERMINOLOGY=true`), `RAG_TERMINOLOGY_MINING=false`. Off reproduces today's retrieval; the fixture comparison is `eval/reports/phase-04.1.1/comparison.json` (synthetic items only, report-only per EVAL-14).
- Query-time only: no synonym is written into the index. Under v2 the `terminology` stage matches the standalone query after the query transforms and before the semantic cache and embed, and adds one lexical-only list `term:0` (expansion tokens capped by `TerminologyParams`: matches, terms per match, expansion tokens, list weight); `reserve_slots` (default 2, 0 turns it off) lets expansion-only hits take the lowest places of the rerank input. `RAG_TERMINOLOGY_DENSE=true` adds one dense variant.
- Layers: a shared layer plus one per tenant (a tenant row can suppress a shared entry); every write is versioned and audited, admin-only, through `/api/rag/admin/terminology` and the Config UI Terminology panel. The `rag_term_*` functions are service-role only and called only from `src/lib/rag/terminology/`.
- Translation pairs (`kind = translation`) are stored and versioned here but never expand a query. `getTerminologyLexicon` from `@/lib/rag` is the stable, tenant-scoped read API for later phases (tokenizer dictionary, translation glossary).
- Mining is opt-in (`RAG_TERMINOLOGY_MINING=true` logs masked missed queries for 30 days) and never auto-applies: `npm run rag:terms:mine -- [--dry-run] [--tenant <key>]` proposes candidates that an admin accepts or dismisses.

### Retrieval tuning (Phase 4.2)
- Switches (defaults in `src/lib/env.ts`, all off; they act only under `RAG_PIPELINE=v2`): `RAG_LEXICAL_DICTIONARY=false`, `RAG_LEXICAL_STEM_IT=false` (kept off by the D-10 rule, `eval/decisions/04.2-lexical.md`), `RAG_VERSION_SCOPE=false`, `RAG_EMBED_VERSION_SCOPE=false`, `RAG_TABLE_LOOKUP=false`, `RAG_DUP_CLUSTERS=false`, `RAG_RESULT_DIVERSITY=off` (`collapse | mmr`), `RAG_IDENTIFIER_INDEX=false`, `RAG_IDENTIFIER_FILTER=false`. Invalid combinations resolve in `loadRagConfig` with one `[RAG Config]` warning: the identifier filter without the index runs unfiltered, version scope without `RAG_LEXICAL_SEARCH=true` scopes to current versions only, the embed switch without an effective version scope stays off, and `collapse` has nothing to act on while `RAG_DUP_CLUSTERS` is off. Off reproduces Phase 4.1 retrieval (`eval/reports/phase-04.2/gates.json`, off_identity).
- Effective lexical version: 2 with both lexical switches off, 3 with the dictionary, 4 with stemming, 5 with both. Refusal cells carry `tokenizer_version`, so turning a lexical switch on makes every cell calibrated at another version stale (the floor decides) until `python -m rag_eval.calibrate refusal --write-thresholds` recalibrates it. Refusal cells can be per mode (`base|strict`, `base|balanced`, `base|flexible`); a mode without a cell, voice and bypass use the shared cell.
- Rebuild commands: `npm run rag:relex -- --tenant <key> --stale-dictionary` (after dictionary changes), `npm run rag:table-rows`, `npm run rag:identifiers` (also after `rag:rechunk` and after identifier pattern changes) and `npm run rag:dup-clusters`. Tools (from `eval/`): `python -m rag_eval.calibrate dup-clusters`, `python -m rag_eval.sweep diversity`, `python -m rag_eval.phase42_gate --spec eval/config/phase42-gates.json --out eval/reports/phase-04.2`. Only these tools write `eval/config/dup-cluster-params.json`, `mmr_lambda` in `eval/config/retrieval-params.json` and the eval-only lambda of the diversity run config; fixture values apply in eval only.
- Duplicate collapse never merges chunks of two documents whose value tokens (numbers, dates, identifiers) differ: a conflicting value is not a duplicate. Collapsed copies are listed as `alsoIn` on the kept chunk.
- New tables `rag_table_rows`, `rag_dup_clusters`, `rag_dup_chunk_bands`, `rag_identifier_patterns` and every new function (`rag_table_lookup`, `rag_document_versions`, `rag_version_history_ok`, `rag_version_period_ok`, `rag_exact_id_documents`, the `rag_dup_*`, `rag_identifier_*`, `rag_index_*`, `rag_write_*`, `rag_relex_*_stamped`, `rag_lexical_stale_count`, `rag_chunk_lexical_dict_version` functions and the `rag_purge_hook_*` hooks) are **service_role** only. Migrations 0851–0864 are not folded: apply them in file order after the highest earlier migration (0854 needs 0853; 0864 redefines the 0852 purge hook, so after re-running 0852 re-run 0864; 0856 redefines `hybrid_search_chunks` once on top of Phase 3.2's 0802, so a later 3.2 redefinition rebases on 0856; 0863 runs only where `rag_retrieval_log` exists).
- Versions: a request's `retrievalFilters.versions` (`current`, `all` or a date range) applies only while `RAG_VERSION_SCOPE` is effective. Superseded versions keep losing their vectors at publish (owner-confirmed design, D-58), so history retrieval reaches them through the lexical and deterministic legs only (trace `superseded_dense_unavailable`). Embedded chat accepts `versions` only while `RAG_VERSION_SCOPE` and `RAG_EMBED_VERSION_SCOPE` are both on, always inside the embed's verified tenant (from the widget configuration, never from the request) and only for `status = ready` documents; anonymous visitors of that widget can then see superseded text of that tenant. Otherwise the field is ignored and the trace records `versions_ignored`. A non-current scope bypasses the semantic cache (`version_scope`).
- Voice timing: the agent measures text TTFT itself and posts it to `/api/internal/voice-timing` (shared secret, like `voice-rag`), which writes Langfuse scores and one ids-and-numbers log line; ship the app and the voice agent together.

### Document access groups (Phase 4.3)
- Switches (defaults in `src/lib/env.ts`): `RAG_DOC_ACCESS_GROUPS=off` (`on | off`) and `RAG_EMBED_ACCESS_GROUP=` (empty). Off sends no access argument, records no `access_scope` stage or trace access block and logs no access field; retrieval equals the pre-4.3 baseline (`tests/rag-e2e/defaults-equal-phase3.test.mts`), and the smoke tier with it on is `eval/config/runs/access-groups-on.json`.
- Labels: `documents.access_groups` holds `all`, `g:<group uuid>` or `u:<user uuid>` (default `{all}`) and is copied to chunks, parents and the derived stores by trigger; only the service role writes it. A new version inherits its lineage's label.
- Groups come only from verified identity: the session user (chat, media), the voice token's user, resolved again on every turn, the eval run's `options.user_id`, and for embedded chat `RAG_EMBED_ACCESS_GROUP` (empty: visitors see only `all` documents; an unknown key falls back to `all` with one `[RAG Access] embed_group_not_found` warning). A group named in a request body is ignored and logged once as `[RAG Access] body_group_claim_ignored`. Admins see every document of their tenant.
- Migrations 0920 to 0939 (0920–0926, 0930–0934 used) are not folded into the setup files and are idempotent. After re-running any older migration or setup file that defines a function this block replaces, re-run the block in order, then 0410; re-run 0933 after 0810, 0858, 0861 or 0862, and 0934 after 0501, 0531 or 0534.
- Enforcement flag: the environment is the source of truth. At startup (`verifyAccessGroupsStartup`, `src/instrumentation.ts`) the app writes the database flag (`rag_access_set_enforced`) from `RAG_DOC_ACCESS_GROUPS` and reads it back, then `rag_access_readiness` checks that every retrieval function and derived store filters and the backend declares `accessFilter`. With the switch on and the check not ready, retrieval is blocked: strict mode answers "knowledge base temporarily unavailable", never "information not available". The restrictive RLS policies on `documents`, `document_chunks` and `document_parents` apply while the flag is set.
- Admin API (access admins only, tenant resolved server-side): `/api/rag/access-groups` (groups, members, `documents` and `documents/access` labels, `connector-map`, `sharing-rules`, `impact`, `drift`, `status`, `status/sync`; `mine` lists the caller's own groups), used by the Config UI Access groups panel. Every access function is service_role only except `rag_access_enforced`, `rag_caller_access_keys` and `rag_caller_is_access_admin`, which the policies need.
- Read paths: a chat citing a restricted document gets no share link (403 `restricted_content`), and a shared link is re-checked against the current labels on every read; the document, image, scraper and ingest status routes show only what the caller may see.
- Seams for Phase 7: the caller's groups are read only through `scopeAccessFilter(scope)` from `@/lib/rag` and the chunk label column `document_chunks.access_groups`; renaming either breaks Phase 7.
- Limits: extracted images live in the public `chat-images` bucket, so groups cannot protect their bytes; restricted `source_images` URLs are never returned outside the groups (A-12). In multi-tenant mode connector documents stay in the owner's personal workspace, so connector permission mapping changes visibility only in single-tenant mode (A-10); connector scopes are in `README_NANGO_INTEGRATION.md`.
- Canaries (release gate in pr-smoke): `tests/rag-db/access-canary-matrix.test.mts` (every leg, both modes, zh/en/it) and `tests/rag/access/routes-access-canary.test.ts` (chat, embed, voice-rag, eval run and share routes).

### Verified citations and groundedness (Phase 5)
- Every Phase 5 switch defaults to off (`src/lib/env.ts`): `RAG_CITATIONS=false`, `RAG_CLAUDE_CITATIONS=false`, `ANTHROPIC_API_KEY=`, `ANTHROPIC_BASE_URL=`, `RAG_GROUNDEDNESS=false`, `RAG_GROUNDEDNESS_VECTARA_OPT_IN=false`, `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=false`, `RAG_GROUNDEDNESS_TIMEOUT_MS=20000`, `RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS=3000`, `RAG_ANSWER_FEEDBACK=false`. Off reproduces the pre-Phase-5 chat byte for byte.
- Citation strategies (`src/lib/rag/generation/citations/`): `chunk-alias` (`RAG_CITATIONS=true`) labels each context block with an alias, parses the markers the model writes and keeps only markers that name a block of that request's context; `claude-citations` (`RAG_CLAUDE_CITATIONS=true`, `ANTHROPIC_API_KEY` and a model with `anthropicId`) calls Anthropic directly with the blocks as documents. An ineligible turn (MCP, web search, attachments, multi-step) or a failure before the stream starts goes to `chunk-alias` when `RAG_CITATIONS=true`, else to today's uncited answer. Invalid markers are hidden, never rendered.
- Each `CitationRecord` carries a snapshot of the cited text, so a citation still resolves after its document is deleted or re-versioned. Images are never cited; they stay in `source_images`.
- Groundedness runs after the answer (`after()`), never on the answer path, through the sidecar `POST /v1/groundedness`: Vectara (en, zh-Hans) only with `RAG_GROUNDEDNESS_VECTARA_OPT_IN=true`, and in multi-tenant mode only when `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=true` too (set it only after the Vectara retention terms are recorded); otherwise local HHEM-2.1-Open (en) or `not_checked`. Labels: `verified`, `possibly_unreliable`, `not_checked`. Thresholds: `python -m rag_eval.calibrate groundedness` (from `eval/`).
- `rag_answer_records` (0501, 0502) holds one server-written row per RAG answer: citations, groundedness, feedback and `review_reasons`. RLS lets `authenticated` read only its own rows; `anon` has no grant; only the service role writes. Routes: `GET /api/rag/answers?chatId=`, `GET /api/rag/answers/{answerId}`, `POST /api/rag/answers/{answerId}/feedback` (`RAG_ANSWER_FEEDBACK=true`), admin `GET /api/rag/admin/review-candidates`.
- Review queue: a not-helpful vote adds `feedback_negative`, a `possibly_unreliable` label adds `groundedness_flagged`; `python -m rag_eval.review_queue pull --source db|both` reads them.
- Local HHEM needs the sidecar image built with `docker build --target hhem rag-sidecar` (baked weights, offline); plan about 2 GB of memory for the scorer. The default image scores nothing locally.
- Fixture proof: `python -m rag_eval.phase_compare --spec eval/config/phase5-comparison.json --out eval/reports/phase-05` (switches off: paired differences zero; on: retrieval unchanged, `invalid_citation_rate` 0).

### Prompt-injection defense (Phase 5.1)
- Every Phase 5.1 switch defaults to off (`src/lib/env.ts`): `RAG_CONTEXT_TAGGING=false`, `RAG_INJECTION_CHECK=off` (`flag | drop | downweight`), `RAG_INJECTION_PROMPT_GUARD=false`, `RAG_INJECTION_LAKERA=false`, `LAKERA_GUARD_API_KEY=`, `LAKERA_GUARD_BASE_URL=`, `RAG_INJECTION_LAKERA_MULTI_TENANT_ACK=false`, `RAG_TOOL_RESULT_GUARD=off` (`tag | tag_and_flag`), `NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST=false`. Off reproduces the pre-5.1 chat byte for byte.
- `RAG_CONTEXT_TAGGING=true` wraps each context block in `<doc>` inside `<documents>` with a fixed data-not-instructions notice and escapes look-alike tags in the content; citation quotes and groundedness keep the unescaped text.
- `injection_check` runs just before assembly in legacy and v2 (after `expand_parents`) on chunks, parents, references and captions. Rules always run when the check is on and share `config/rag/injection-rules.json` and `src/lib/rag/security/injection-scan.ts` with ingestion; `flag` records, `drop` removes, `downweight` moves flagged items last. A detector failure is `degraded/detector_unavailable`, never a refusal; when `drop` removes everything the result is `empty/injection_filtered`, so strict mode answers "information not available".
- Recommended configuration for the Phase 7 regression: `RAG_CONTEXT_TAGGING=true`, `RAG_INJECTION_CHECK=drop`, rules only (`eval/config/runs/sec-recommended.json`). Proof: `python -m rag_eval.phase_compare --spec eval/config/phase51-comparison.json --out eval/reports/phase-05.1` (all off equals the baseline; recommended holds attack success on `injection` and the rules false-positive count at 0 with no other category beyond the noise band).
- Listing `injection_check` in `RAG_DISABLED_STAGES` disables the check even while `RAG_INJECTION_CHECK` is on; the app logs one `[RAG Config]` warning.
- Operations: Lakera sends chunk text to a third party. In multi-tenant mode it runs only with `RAG_INJECTION_LAKERA_MULTI_TENANT_ACK=true` (set it only after the retention terms are recorded); `LAKERA_GUARD_BASE_URL` selects the region (empty: `https://api.lakera.ai`). Prompt Guard is the sidecar `POST /v1/injection/classify` (shared secret, `PROMPT_GUARD_ENABLED`); it covers en and it only (no zh) and is meant for a CPU warm cache or nightly runs. No model image ships yet: the optional `promptguard` target waits on the license and gated-access checkpoint (plans 05.1-18, 05.1-25).

### Feedback loop (Phase 5.1.1)
- Every Phase 5.1.1 switch defaults to off (`src/lib/env.ts`): `RAG_RETRIEVAL_LOG=off` (`ids | masked_query`), `RAG_RETRIEVAL_LOG_RETENTION_DAYS=30`, `RAG_REFUSAL_FEEDBACK=false`, `RAG_EMBED_FEEDBACK=false`, `RAG_EMBED_FEEDBACK_SECRET=` (secret, at least 32 characters; shorter means no token and the route answers 404), `RAG_SOURCE_OPEN_SIGNAL=false`, `RAG_DOMAIN_EXPERT_REVIEW=false` (expert routes, mining and the review panel; off answers 404). Off writes no row, changes no stream and renders no new control.
- `rag_retrieval_log` (0531–0533) holds one row per chat, embed or voice retrieval, written after the response, never on the request path: ids, ranks, scores, outcome, stage latency and feedback, with no answer, chunk or document text, no system prompt, IP address or user agent. The language columns hold codes only (`query_language`, `query_language_confidence`, `chunk_languages`, `answer_language`), never the text they were derived from. The masked query (`maskPII`, at most 2000 characters) and its fingerprint are stored only in `masked_query` mode; `ids` stores neither. Eval and media profiles and ghost chats are never logged. RLS on, no policy, service role only.
- Retention and deletion: `rag_purge_retrieval_log` deletes rows older than the retention days (default 30) from the weekly mining job, `npm run rag:feedback-loop -- purge` or the optional `supabase/optional/feedback-loop-schedule.sql`. A tenant can opt out or lower the level (`rag_tenant_feedback_settings`, `PUT /api/rag/admin/feedback-loop/tenant-settings`), never raise it; per-user opt-out is ghost mode. Deleting a user or a chat removes their log rows and review items (cascade on `user_id`, a delete trigger on `chats` for `chat_id`).
- Mining: `npm run rag:feedback-loop -- mine [--since YYYY-MM-DD] [--until YYYY-MM-DD]` (or `POST /api/rag/admin/feedback-loop/mine`) runs `rag_mine_failed_queries` with the thresholds in `config/rag/feedback-mining.json` and fills `rag_review_items` (0534, 0535, 0537), whose snapshot keeps the masked query, language codes and candidate ids after the log purge. It needs `RAG_DOMAIN_EXPERT_REVIEW=true` and `RAG_RETRIEVAL_LOG=masked_query`; otherwise it writes nothing.
- Expert isolation: experts read and label only the review items of tenants they were granted (`rag_domain_experts`, RLS through `rag_is_domain_expert`); grants are made by operator admins through `/api/rag/admin/domain-experts`. Single-tenant admins are experts of `s:default`. Nobody is implicitly an expert in multi-tenant mode, operator admins included. Evidence text is read under the item's tenant only, and `[Review]` logs carry ids, hashes and counts, never text.
- Hand-offs (private files under `eval/golden/private/`, never committed): `python -m rag_eval.review_queue promote-db --tenant <key> --base-url <url>` promotes labelled golden items into the domain set (document-group split, PII re-check); `python -m rag_eval.feedback_exports --tenant <key> --kind dictionary|training --base-url <url>` writes the Phase 4.1.1 dictionary candidates and the Phase 6.1 `TrainingPair` file. `held_out` pairs never train (their document group is in the frozen test split), and confirmed hard negatives are the ones an expert rejected. `python -m rag_eval.failure_report --since <date>` and `python -m rag_eval.weekly_report --since <date>` write counts, ids and hashes only.
- Gate population and ship rule: `eval/config/gate-population.json` (`mode: legacy` by default) switches the gate to the real domain set with `mode: real` (approved `production` and `human` items, at least `min_items`, else `real_set_too_small`). Once the mode is `real`, turning any `RAG_*` switch on by default or activating an embedding profile requires a passing ship check: `python -m rag_eval.ship_check --baseline <report.json> --candidate <report.json> --target <metric>` (both reports on the real population and the same frozen manifest, no slice beyond the noise band, the target's paired 95% interval above zero).
- Proof: `uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase5.1.1-comparison.json --out eval/reports/phase-05.1.1` (all off equals the Phase 5.1 baseline; on: retrieval unchanged and stage latency within `eval/config/latency-budgets.json`). Log prefixes `[Retrieval Log]`, `[Feedback Loop]`, `[Review]` carry counts and ids only.

### Grounded answers and output safety (Phase 5.2)
- Every Phase 5.2 switch defaults to off (`src/lib/env.ts`, read only by `readAnswerConfig()` in `src/lib/rag/generation/answer-config.ts`): `RAG_REGISTRY_TEXTS=false`, `RAG_PARTIAL_ANSWER_RULE=false`, `RAG_CONTEXT_RELEVANCE_RULE=false`, `RAG_CITATION_PER_SENTENCE=false` (needs `RAG_CITATIONS` or `RAG_CLAUDE_CITATIONS`), `RAG_CLAIM_CHECK=false` (needs `RAG_GROUNDEDNESS`), `RAG_GROUNDEDNESS_LLM_JUDGE=false` (needs a judge model), `RAG_GROUNDEDNESS_JUDGE_MODEL=` (a different model family than the generator, `config/rag/model-families.json`), `RAG_MAX_OUTPUT_TOKENS=off` (`off | auto | <integer ≥ 256>`; `auto` reads `eval/config/output-caps.json`), `RAG_OUTPUT_GUARD=off` (`flag | enforce`), `RAG_VERSION_LABELS=false`, `RAG_SECURITY_EVENTS=false`, `RAG_UPLOADER_ALERT_THRESHOLD=0` (0 records events, never alerts), `RAG_UPLOADER_ALERT_WINDOW_HOURS=24` (1–720), `RAG_UPLOADER_HOLD=off` (`manual | auto`). An invalid value or combination falls back to off with one `[Answer Rules]` warning. Off reproduces the Phase 5.1.1 chat; the only intended differences with every switch off are the WhatsApp stream parser fix (05.2-15, D-91: replies carry the answer text) and the escaped chat paragraph renderer (05.2-35).
- Migrations 0940–0945 are not folded into the setup files: 0940 (`rag_answer_records.checks`, `texts_source`), 0941 (`documents.version_label`), 0942 (`rag_security_events`, ids only), 0943 (alerts, uploader holds and their functions), 0944 (review reasons `claim_unsupported`, `output_guard`, `version_conflict`, `rag_enqueue_review_item`), 0945 (admin tenant resolution in SQL). Apply them after Phase 3.2's 0801–0810 and Phase 5.1.1's 0531–0535, in order, then re-run 0410. Every function is service_role only.
- Registry texts: notices, labels and instructions live under `texts` in `config/rag/language-packs.json` (sidecar copy kept equal) and are read only through `fixedText(key, language)` in `src/lib/rag/lang/texts.ts`. With `RAG_REGISTRY_TEXTS=true` and languages configured, refusal, knowledge-base-unavailable, citation and notice texts come from the registry in the answer language (`resolveAnswerLanguage`: confident detection among the enabled languages, then the previous turn, the UI language, `RAG_PRIMARY_LANGUAGE`); the English texts are byte-identical to today's (`tests/rag/lang/texts-equality.test.ts`).
- Answer rules: `composeAnswerRules` appends the enabled parts after the final system prompt (`RAG_SYSTEM_PROMPT` and `{{context}}` are untouched). With the partial-answer or relevance rule on, the model answers a context that does not answer with `%%NO_ANSWER_IN_CONTEXT%%`; the stream sentinel replaces it, also across tokens, with the registry "information not available" text (the webSearch variant when web search was offered) and marks the turn `refusalOrigin: model_relevance`. Balanced mode labels general-knowledge answers instead; strict webSearch answers label document and web parts separately.
- Output guard (`src/lib/rag/security/output-guard.ts`, rules in `config/rag/output-guard-rules.json`): `flag` records, `enforce` replaces links outside the allow rules (`RAG_OUTPUT_LINK_ALLOWLIST` plus the `NEXT_PUBLIC_SITE_URL` host, the turn's unflagged webSearch results, server-issued URLs, a verbatim part of the user message) with the `notices.link_removed` text and blocks credential requests. It holds back about one word while streaming, so split tokens are caught; chat, embed, the approve summary and WhatsApp replies are guarded.
- Claim check and judge: with `RAG_CLAIM_CHECK=true` each factual sentence is checked after the answer (`after()`, never on the answer path) through the sidecar `POST /v1/groundedness/claims` (HHEM for en, Vectara for zh-Hans only under the Phase 5 opt-in); unsupported sentences are marked "not confirmed by the documents", never removed. The judge sends the answer and its context blocks to OpenRouter (`https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`) for languages the scorers do not cover; it is opt-in, has no multi-tenant acknowledgement of its own, and labels from `eval/config/groundedness-judge-thresholds.json` or `judge_uncalibrated`.
- Security events, alerts and holds: with `RAG_SECURITY_EVENTS=true` retrieval injection, output guard, ingest injection, hidden text and untrusted link findings are recorded with the uploader resolved in SQL (`documents.user_id`), ids and counts only. Counts above `RAG_UPLOADER_ALERT_THRESHOLD` in the window raise an admin alert; `RAG_UPLOADER_HOLD=auto` holds the uploader (new uploads stay `pending_review` until an admin approves them; published documents are untouched), `manual` lets an admin hold from the Config UI Security events panel (`/api/rag/admin/security-events`). With a hold on and `RAG_INGEST_PIPELINE=legacy`, knowledge-base writes answer 503 `upload_approval_requires_unified_pipeline`. Admins see only their tenants' events, alerts, holds and uploader names.
- Version labels: `RAG_VERSION_LABELS=true` labels each block with its version and effective date; conflicting versions mark the older block, the answer gives the current value and names its version, and after the response both documents go to the supersession candidates (`answer_conflict`, never applied automatically) and, with `RAG_DOMAIN_EXPERT_REVIEW=true`, to the review queue as `version_conflict`.
- Eval tools (from `eval/`): `python -m rag_eval.sweep output-cap` (the only writer of `eval/config/output-caps.json`; per mode the smallest cap within the noise band whose truncation rate is below 2%; a fixture sweep must name another `--out`) and `python -m rag_eval.calibrate groundedness-judge --judge <model>` (writes the judge cells). Proof: `uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase52-comparison.json --out eval/reports/phase-05.2` (all off: paired differences zero; on: the D-54 answer-rule gates, the link-injection gate, truncation below 2% on the capped run). Log prefixes `[Answer Rules]`, `[RAG Security]`, `[Groundedness]`, `[Citations]` carry counts and ids only.

### Query layer and semantic cache (Phase 6)
- The query layer runs only under `RAG_PIPELINE=v2`, behind the master switch `RAG_QUERY_LAYER=false` (default). Off, or under `legacy` (one log line, nothing else), the pipeline is byte-identical to Phase 4. Sub-switches (defaults in `src/lib/env.ts`) default to the recommended profile and are inert while the master is off: `RAG_QUERY_FRAMEWORK=llamaindex` (`llamaindex | langchain`), `RAG_QUERY_LLM_MODEL=openai/gpt-4.1-nano`, `RAG_QUERY_CONDENSE=true`, `RAG_QUERY_EXPAND=true`, `RAG_QUERY_DECOMPOSE=true`, `RAG_QUERY_TRANSLATE=true`, `RAG_QUERY_DATE_NORMALIZE=true`, `RAG_QUERY_HYDE=false`, `RAG_QUERY_TRANSLATE_DISABLED_PROFILES=` (embedding profiles where the multilingual embedding alone is enough).
- Stage order (`src/lib/rag/v2/stages/query.ts`): `query_gate` (pure, rules only), `condense`, then the parallel transform group (translate, expand, decompose, HyDE, date normalization), then Phase 4.1.1's terminology stage, then `semantic_cache` and `embed`. The original query is always retrieved, so a skipped transform (`timeout | error | aborted | protected_token_lost`) marks the result `degraded` but never removes the original results; protected tokens stay verbatim in every variant. Per-transform timeouts are code defaults per profile (override with `RAG_STAGE_TIMEOUTS`); the `query` groups in `eval/config/latency-budgets.json` are report-only until live measurements ratify them.
- Translation (XLG-01) uses `rag_tenant_language_shares` (0601, service_role only, tenant checked by `rag_assert_tenant_key`), cached in process per tenant: it fires when the query language's share of the tenant's current, ready documents is 20% or less and targets the top two languages above 20%. When the answer and context languages differ, `createEnhancedRAGPrompt` appends one answer-language line; `RAG_SYSTEM_PROMPT` and `{{context}}` are untouched.
- Voice: `/api/internal/voice-rag` accepts an optional `history` (at most 6 turns) and the voice profile runs only `RAG_QUERY_VOICE_TRANSFORMS=condense_history,normalize_dates` (`translate` may be added; expand, HyDE and decompose are rejected for voice with a config warning). The agent's `VOICE_SERVER_QUERY_REWRITE` (default `false`) sends the history and skips its own rewrite; deploy the app with the layer on first, then the agent. The voice wire contract is unchanged.
- LangChain lives only in `src/lib/rag/query/langchain/` (lazy import; `serverExternalPackages`), and both frameworks implement the same `QueryTransformer` contract. Every query-LLM call goes through `src/lib/rag/query/llm`; the boundary check fails on either rule broken. LangChain brings its own nested zod 4; app code stays on zod 3 (`zod/v3`), checked by `node scripts/ci/check-zod-isolation.mjs`.
- Semantic cache: `RAG_SEMANTIC_CACHE=off` (`off | pgvector | redisvl`), `RAG_SEMANTIC_CACHE_TTL=3600`, `RAG_SEMANTIC_CACHE_REFUSAL_TTL=600`, `RAG_SEMANTIC_CACHE_MAX_DISTANCE=0.05`, `RAG_SEMANTIC_CACHE_EMBED_STORE=false` (embed is check-only unless on). The check runs after `condense`, only under v2, for chat and embed in `strict` and `balanced` modes; voice is never cached. A hit streams the cached answer, sources and citations through the normal stream and skips retrieval and generation; the store runs in `after()`. Bypass rules are deterministic (protected tokens, relative time, personal data, webSearch, MCP tools or `source_images` in the turn, `possibly_unreliable` groundedness, uncondensed follow-ups, skipped retrieval, `degraded`/`error` retrieval). Any cache error or timeout is a miss and never degrades the request; failures log with `[Semantic Cache]`.
- pgvector backend: `rag_semantic_cache` (0603) with RLS on and no policy, keyed by tenant, key hash and embedding profile; `rag_cache_*` functions are service_role only and live in `src/lib/rag/cache/`. A hit is re-checked against the cited documents' current versions, and statement triggers on `documents` (insert, update, delete) invalidate the affected tenant's rows. RedisVL backend: sidecar `POST /v1/cache/check|store|invalidate`, `REDIS_URL` set on the sidecar only and the image built with the `cache` extra. Admins clear one tenant's cache with `/api/rag/admin/semantic-cache` (POST `{ tenantKey }`) or from the Config UI.
- Calibration: `npm run test-rag -- --cache-pairs` runs the golden `cache_paraphrase` / `cache_near_miss` pairs, and `python -m rag_eval.calibrate cache` (`--pairs <dir>/cache-pairs.json --write --check`, from `eval/`) writes `eval/config/semantic-cache.json` per embedding profile (largest distance with zero near-miss wrong hits); the app uses it when present, else `RAG_SEMANTIC_CACHE_MAX_DISTANCE`. Only that tool writes the file.
- Proof: `uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase6-comparison.json --out eval/reports/phase-06` (layer off equals the Phase 4 baseline; layer on holds every slice; `python -m rag_eval.compare frameworks --fixtures` shows framework parity; cache near-miss wrong hits 0). The shipped defaults stay off.

### Embedding fine-tuning (Phase 6.1)
- `RAG_FINETUNE=off` (default, `src/lib/env.ts`): the two slot profiles `ft-a-1024` and `ft-b-1024` stay `available` with model `unbound` and are never searched; every fine-tune command except `ft-consent list` and `ft-models list` refuses. Off equals today's chat, embed, voice and eval (parity: `eval/reports/phase-06.1-comparison.md`).
- Slots are served by the operator's own endpoint: `RAG_FT_SLOT_A_*` / `RAG_FT_SLOT_B_*` (`BASE_URL`, `MODEL`, `QUERY_PROMPT`, `DOCUMENT_PROMPT`) and `RAG_FT_EMBED_API_KEY`.
- Data and training (from `eval/`): `uv run python -m rag_eval.finetune export|generate|filter|import-mined|mine|kit|train|evaluate|card|prune`, and `run --fixture` for the no-network fixture pipeline; settings in `eval/config/finetune.json`. Vectors: `npm run rag:finetune -- export-vectors|embed-queries`.
- Registry and serving: `npm run rag:embedding -- ft-consent grant|revoke|list`, `ft-models register|list|retire`, `ft-bind` (`--doc-types` binds a scoped slot through the Phase 3.1.1 bindings), `ft-clear`, `ft-release-rollback`, `ft-check`; activation is the unchanged EMB-05 path (re-embed, profile comparison, evidence, activate).
- Consent: a tenant's chunks are exported only with consent (`private` or `deployment`). Revoking taints every model version trained on that tenant (its evidence is dropped and its bindings stop serving) and prints the rollback, clear, artifact-delete and `prune` steps; `--prune-root <dir>` runs the prune, which deletes the tenant's text-bearing bundle files and keeps manifests and reports.
- `embedding_model_versions`, `rag_finetune_consent` and every `rag_finetune_*` function are service_role only. A tenant-scope model serves only its own tenant.
- Live items (plan 06.1-19): real export and training, endpoint binding, re-embed and the real-item profile comparison before activation. Fixture runs prove wiring only.

### Gates and monitoring (Phase 5.3)
- Six switches, all off by default (`src/lib/env.ts`, `PHASE53_SWITCH_DEFAULTS` in `src/lib/rag/monitor/config.ts`): `RAG_MONITOR=false`, `RAG_MONITOR_WEBHOOK_URL=` (https only), `RAG_MONITOR_WEBHOOK_SECRET=` (secret, at least 32 characters, else unset), `RAG_CONFIG_GATE=off` (`off | warn | enforce`), `RAG_CONFIG_GATE_LIVE=false`, `RAG_REPRESENTATIVE_SAMPLE=false`. Off writes no row to the 0960–0978 tables, changes no response, and the monitor, alert, judge-score, sample, drift and cluster routes answer 404 (`tests/rag-e2e/defaults-equal-phase53.test.mts`).
- Committed config files, each validated by its contract: `eval/config/quality-gates.json` (absolute ceilings and floors, set composition, lifecycle), `eval/config/monitor-alerts.json` and `eval/config/release-gate.json` (all three edited through pull requests), and `eval/config/judge-calibration.json`, written only by `python -m rag_eval.judge_calibration`. Thresholds live in these files, not in env vars.
- Absolute gates: `rag_eval.gate --gates` adds the false-answer and false-refusal ceilings and the composition and stale-share checks to the noise band; exit codes 10 (noise band), 11 (ceiling or floor), 12 (composition or stale share). `--gates-mode report` prints them without changing the exit code; the prechunked smoke tiers run in report mode until the ceilings are ratified (`eval/reports/phase-05.3/absolute-gate-measurement.md`). Golden set version and manifest hash: `python -m rag_eval.golden_set`.
- Config gate: with `RAG_CONFIG_GATE=enforce` a RAG-affecting save needs a passed check of the proposed settings hash or a recorded override reason on all five env writers (Config UI server `POST /api/config` and `POST /api/config/create` with force; app `POST /api/config`, `/api/config/models`, `/api/config/rag-prompt`) and on `POST /api/config/languages`; `warn` records and never blocks. Each written change gets a `rag_config_change_records` row (key names and hashes only). Backfill and re-embed completions request a tenant nightly (`rag_eval_run_requests`) only with the gate on; `python -m rag_eval.tenant_nightly` drains them.
- Release gate: the commit status `rag-release-gate` (`python -m rag_eval.release_gate`); `skipped` and `failed` both report `failure`, skipped is not passed. Production is promoted only through `promote-production` (`scripts/ci/promote-production.mjs`), on a `success` status from an accepted creator.
- Monitor: `npm run rag:monitor -- daily | sample [--tenant <key>] | drift-inputs --tenant <key> | record-change | test-alert --tenant <key>` (daily aggregation, rules and alerts need `RAG_MONITOR=true` and the retrieval log on; the weekly sample needs `RAG_REPRESENTATIVE_SAMPLE=true`, `RAG_RETRIEVAL_LOG=masked_query` and `RAG_DOMAIN_EXPERT_REVIEW=true`). `python -m rag_eval.drift` and `python -m rag_eval.representativeness` read counts and cluster shares only; `npm run rag:questions-import` imports historical questions masked and deduplicated, with provenance `historical`, and prints counts only.
- Migrations 0960–0978 are not folded into the setup files. Their tables and `rag_*` functions are service_role only. The DATA-24 purge hook `rag_purge_hook_golden_items` (0976) clears the golden evidence index and answer-check labels of a purged lineage.
- CI: jobs that need private eval data (tenant nightly, weekly report, weekly drift) always skip on hosted runners. Log prefixes `[Monitor]`, `[Config Gate]`, `[Release Gate]` carry counts and ids only.

---

## 7. AI Model Management
Models must stay synchronized across **five** locations:
1. `.env.local`
2. `scripts/init-env.js`
3. `src/lib/env.ts`
4. `scripts/config-server.js`
5. `scripts/config-ui/index.html` (three fallback arrays)

`Model` schema:
```ts
interface Model {
  id: string;
  displayName: string;
  isFree?: boolean;
  isOpenSource?: boolean;
  supportsReasoning?: boolean;
  reasoningMethod?: 'effort' | 'max_tokens' | 'both' | 'none';
  contextLength?: number;
  description?: string;
  anthropicId?: string; // Anthropic model id for the direct Claude Citations path, e.g. claude-<family>-<version>
}
```

`anthropicId` is optional and only allowed on `anthropic/` ids. When a model carries it, it must match in all five locations; `node scripts/check-config.mjs` fails otherwise. A model without it never takes the direct Claude path.

UI icon cues:
- 🧠 Reasoning/thinking (`supportsReasoning`)
- 🎁 Free model (`isFree`)
- 🔓 Open source (`isOpenSource`)

---

## 8. Voice Integration
Real-time voice conversations powered by:
- **LiveKit** – Audio transport and room management
- **AssemblyAI** – Streaming STT (48kHz, multilingual)
- **Resemble.ai** – TTS with word-level timestamps
- **Silero VAD** – Barge-in detection

Key files:
- `voice-agent/src/voice_agent.ts` – Pipeline, query rewriting, greeting
- `voice-agent/src/agent.ts` – LiveKit, VAD, audio mutex
- `src/components/voice/voice-mode-overlay.tsx` – Frontend voice UI
- Each voice session gets its own LiveKit room (`myrag-voice-<random>`), created by `/api/livekit/token` with the signed scope token in the room metadata; the agent watches for these rooms, serves only the identity named there and removes anyone else. Deploy the app and the agent together, and keep `VOICE_MAX_ACTIVE_ROOMS` (app) equal to `VOICE_AGENT_MAX_SESSIONS` (agent).
- `/api/internal/voice-rag` adds a tagged `context` field only with `RAG_CONTEXT_TAGGING=true`, and the agent uses it when present; the voice profile runs the injection rules only. When turning tagging on, deploy the app first, then the agent.

Running voice agent:
```bash
cd voice-agent && npm run dev
```

---

## 9. Cloud Connectors (Nango)
Unified OAuth for Google Drive, Notion, Dropbox:
- Provider: `@nangohq/node` + `@nangohq/frontend`
- Admin toggles in Config UI → Feature Toggles
- Documents synced to `document_chunks` automatically
- See `README_NANGO_INTEGRATION.md` for OAuth setup

---

## 10. MCP & Tooling
- Intent & tool detection: `src/lib/mcp/query-classifier.ts`, patterns under `src/lib/mcp/query-patterns`.
- Approval & execution pipeline: `src/app/api/chat/approve/route.ts` plus the Universal MCP router/client.
- Cache and approval metadata live on the server—keep tool IDs, schemas, and approval prompts consistent.
- In multi-tenant mode the operator's MCP account is admin-only; `chat/approve` executes exactly the approved parameters with per-caller state.
- Tool results (Exa web search, approved MCP results) are data, not instructions: with `RAG_TOOL_RESULT_GUARD=tag` the model's copy is escaped and wrapped under the same notice (`tag_and_flag` also records rule matches); results are never dropped and the UI keeps the raw results.
- With `NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED=true`, auto-approval is suspended for any turn whose context held flagged content; every MCP tool then needs explicit approval and the turn carries `injectionFlagged`.

---

## 11. WhatsApp Integration
- Provider factory selects Fly.io or Koyeb Baileys deployment via `WHATSAPP_PROVIDER`.
- With `RAG_OUTPUT_GUARD` on, WhatsApp replies are filtered as a whole before sending and sent with `linkPreview: false`; the Baileys service fetches a link preview only when `WHATSAPP_LINK_PREVIEW_HOSTS` lists every https host in the text, so no preview is fetched for non-allowlisted hosts.
- Baileys service located in `baileys-whatsapp/` subdirectory.
- Client implementations reside in `src/lib/whatsapp/`. Maintain webhook readiness, session persistence, and provider health checks.

---

## 12. Payments & Auth
- Authentication uses Supabase (GitHub OAuth, email/password, magic links); respect multi-tenant RLS.
- Stripe and Polar enable subscriptions and one-off sales—configure secrets only through environment scripts.
- A Supabase session is required for image/video/3D generation, audio POST, title, extract-name, web-search, upload and temporary process-document. Single-tenant knowledge-base writes are owner-or-admin and honour `read_only_doc_dashboard`. The `admin_session` cookie is valid only with a matching live Supabase session.

---

## 13. Multi-Modal Generation
- Image/video/3D pipelines span `src/lib/` and API routes (Meshy, Luma, Runway, Flux, etc.).
- Preserve status polling, placeholder UI, and Supabase storage URLs when modifying generators.

---

## 14. Behaviour to Preserve
- Strict RAG now allows safe tool results: when `webSearch` is enabled, strict mode may use Exa-powered web search rather than legacy `:online` model suffixes.
- When strict RAG returns a verified `empty` retrieval status and web search is disabled, the chat API returns a structured "information not available" response instead of letting the model answer from general knowledge. A knowledge-base failure (`error`, or `degraded` with no documents) is never reported as "information not available": strict mode with web search off streams a localized "knowledge base temporarily unavailable" message; with web search on, or in balanced/flexible mode, the answer continues without knowledge-base context and the trace is flagged `degraded`.
- Under `RAG_PIPELINE=v2` strict mode still answers "information not available" with the default `RAG_RERANKER=none`: without a calibrated rerank threshold the refusal stage applies the embedding profile's similarity floor (legacy 0.65 when the profile has no calibration). With `RAG_REFUSAL_FLOOR=legacy_rule` it applies the legacy relevance rule instead while no calibrated rerank threshold applies to the request; fixture-fitted cells never apply outside eval.
- Citations and groundedness are additive: strict refusal and the "knowledge base temporarily unavailable" message are produced before generation and never carry citations; webSearch with Exa, `source_images` and the `{{context}}` placeholder are unchanged with every Phase 5 switch on or off.
- The prompt-injection defense is additive: with every Phase 5.1 switch on or off, strict "information not available", the webSearch strict path with Exa and `source_images` are unchanged. `NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST=true` renders markdown images in answers only from same-origin, Supabase storage and configured image hosts (others become plain links); it is inlined at build time, so it takes effect only after a rebuild.
- The query layer is additive: small talk skips retrieval only under the layer (`RAG_QUERY_LAYER=true`), where the model answers conversationally instead of the strict "information not available" refusal; with the layer off strict refusal is unchanged, and a knowledge-base question still refuses as before. Cache hits carry `cache: hit` in the message metadata with the original trace id; webSearch with Exa, `source_images`, voice and embed chat behave as before with every Phase 6 switch off.
- Phase 5.3 is additive: with its six switches off, strict "information not available", webSearch with Exa, `source_images`, the `{{context}}` placeholder, voice and embed chat behave as before, and no monitor, sample or gate row is written.
- Phase 3.2 is additive: with every Phase 3.2 switch at its default, strict "information not available", webSearch with Exa, `source_images`, the `{{context}}` placeholder, voice and embed chat behave as before; quarantined and `pending_review` versions never reach retrieval, and an ingestion-side setting change never rebuilds anything without an admin starting it.
- Phase 5.2 is additive: with every Phase 5.2 switch off, strict "information not available", webSearch with Exa, `source_images`, the `{{context}}` placeholder, voice and embed chat behave as before. With the switches on, the strict refusal and the "knowledge base temporarily unavailable" message stream in the question's language, are never cut by the output cap and carry no citations; links and credential requests are filtered without blocking the rest of the answer.
- Source extraction now preserves `webSearch` tool results, document sources, and `source_images` through streaming and final message persistence; keep sidebar toggle click handling intact.
- Voice work recently focused on UI timing and audio reliability: the overlay keeps the three-dot state until text and word timings are ready, the agent dynamically resamples incoming audio for VAD/STT, and Resemble timestamp failures fall back to estimated timings.

---

## 15. Quality Checklist
- Code follows repository style and reuses existing utilities.
- Linting, type-checks, and domain scripts succeed prior to hand-off.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json` passes with zero errors; `next build` fails on type errors.
- No sensitive data introduced; configuration arrays remain synchronized.
- Task summaries stay concise and focused.
- Performance guardrails: avoid log spam; scope effects to streaming; prefer `useShallow`.
- `node scripts/ci/check-zod-isolation.mjs` passes (root zod 3.25 and openai 4; zod 4 only as LangChain's nested copy). `node scripts/ci/check-rag-boundary.mjs` also enforces that `@langchain/*` is imported only under `src/lib/rag/query/langchain/` and that query-LLM calls (`generateText`, `generateObject`, `streamText`, `streamObject` in the query layer) go only through `src/lib/rag/query/llm`.

---

## 16. Handy Scripts
| Command | Description |
|---------|-------------|
| `npm run dev` | Primary app server |
| `npm run config` | Configuration dashboard (port 3333) |
| `cd voice-agent && npm run dev` | Voice agent service |
| `node scripts/rag/*` | RAG health checks |
| `npm run rag:reembed` | Re-embed job over chunk rows (`src/lib/rag/ingest/reembed/cli.ts`) |
| `npm run rag:embedding` | Embedding profile admin CLI (list, activate, record evidence) |
| `npm run rag:backfill-hashes` | One-off hash backfill for legacy documents |
| `npm run rag:fingerprint` | Ingestion fingerprint backfill (Phase 3.2) |
| `npm run rag:rebuild` | Admin-started rebuild after an ingestion-side change, eval record, security rescan |
| `npm run rag:translate` | Document translation backfill and translation re-embed |
| `npm run rag:reembed -- --recaption` | Redo image captions (resume, rollback) |
| `npm run rag:lexstats` | Per-tenant BM25 lexical statistics: enable, rebuild, compact, check, status, disable (Phase 4.4) |
| `cd rag-sidecar && docker build --target docling` | Docling parse image; host sizing start ~4 GB RAM, 2 CPUs, one parse worker |
| `cd rag-sidecar && docker build --target bge-m3` | BGE-M3 embedding image (`RAG_BGE_M3_SERVING=sidecar`); weights baked at a pinned revision, plan 4–5 GB RAM on CPU |
| `npm run rag:monitor` | Phase 5.3 monitor CLI: `daily`, `sample`, `drift-inputs`, `record-change`, `test-alert` |
| `npm run rag:questions-import` | Import historical questions into the review queue (masked, deduplicated, counts only) |
| `uv run --directory eval python -m rag_eval.release_gate` | Release gate; posts the `rag-release-gate` commit status |
| `uv run --directory eval python -m rag_eval.tenant_nightly` | Drain the tenant nightly requests |
| `uv run --directory eval python -m rag_eval.judge_calibration` | Judge calibration; the only writer of `eval/config/judge-calibration.json` |
| `uv run --directory eval python -m rag_eval.golden_set` | Golden set lifecycle, version and manifest hash |
| `uv run --directory eval python -m rag_eval.drift` | Weekly query drift against the test set |
| `uv run --directory eval python -m rag_eval.representativeness` | Test-set coverage of the query clusters |
| `scripts/init-env.js` | Default environment template |

---

## 17. Supplementary Documentation
- **[README_VOICE_INTEGRATION.md](README_VOICE_INTEGRATION.md)** – Voice architecture, mobile support, troubleshooting
- **[README_NANGO_INTEGRATION.md](README_NANGO_INTEGRATION.md)** – Cloud connectors setup
- **[README_DEPLOYMENT_MODES.md](README_DEPLOYMENT_MODES.md)** – Single vs Multi-tenant

Keep this guide current—when architecture or workflows change, update this file so every agent stays aligned.
