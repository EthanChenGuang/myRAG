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
- Fresh projects run `supabase/single-tenant-setup.sql` or `supabase/multi-tenant-setup.sql`, then apply ordered files under `supabase/migrations/` (common file first, then `.single-tenant.sql` / `.multi-tenant.sql` for that mode). Folded setup files already include Phase 3 (0301–0320), Phase 3.1 (0351–0359, 0420–0424) and Phase 4 (0401–0413); Phase 6 migrations are not folded yet; migrations remain the upgrade path and must be idempotent on top. pgvector must stay in schema `public`: 0425 stops with 55000 otherwise, so do not act on Supabase lint 0014 (`extension_in_public`) for `vector`.
- Switches (defaults in `src/lib/env.ts`): `RAG_INGEST_PIPELINE=legacy` (legacy writers vs unified pipeline), `RAG_EMBEDDING_PROFILES=off`, `RAG_INJECTION_SCAN=off`, `RAG_EXACT_ID_LOOKUP=false`, `RAG_PDF_IMAGE_CHUNKS=false`.
- Originals land in the private **`rag-originals`** storage bucket; quarantined documents stay out of retrieval (D-08 filter on current, ready rows—no env switch).
- Writer and search RPCs (`rag_*`, `match_chunks_by_profile`) are **service_role** only; tests assert anon/authenticated cannot execute them.

### Ingestion queue (Phase 3.1)
- Write paths call `submitIngest()`: inline `ingest()` with `RAG_INGEST_ASYNC=off`, the `ingestion_jobs` ledger with it on (unified pipeline only). Defaults reproduce Phase 3 and write no ledger, cache or budget row (`tests/rag-e2e/defaults-equal-phase3.test.mts`).
- Switches (defaults in `src/lib/env.ts`, read by `src/lib/rag/ingest/queue-config.ts`): `RAG_PARSE_ROUTING=fixed`, `RAG_PARSER_ALLOW_CLOUD=true`, `RAG_PARSE_PREMIUM_PAGE_BUDGET=0`, `RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC=200`, `RAG_PARSE_ESCALATION=on`, `RAG_PARSE_VLM_DETECT=false`, `RAG_PARSE_VLM_MODEL=` (empty: the captioning model), `RAG_INGEST_ASYNC=off`, `RAG_INGEST_WORKER_CONCURRENCY=2`, `RAG_PARSE_PROGRESSIVE=false`, `RAG_EMBED_BATCH_MODE=sync`, `NEXT_PUBLIC_RAG_INGEST_REALTIME=false`. `tiered` routing needs `RAG_INGEST_PIPELINE=unified` and `RAG_INGEST_ASYNC=on`; an invalid combination falls back to Phase 3 behaviour with a warning.
- The worker runs in the sidecar: `RAG_INGEST_WORKER=on` (default off: the sidecar starts no worker) with `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RAG_APP_INTERNAL_URL` and `RAG_SIDECAR_SECRET`; it calls back into `/api/internal/rag/ingest/jobs/[id]/*`.
- Bulk import: `npm run rag:backfill -- --tenant <key> --source <folder|bucket|manifest>:<ref> --budget <USD>`. The sample dry run always runs first; without `--budget`, or with `--dry-run`, the command stops after the report (exit 2). `--resume <batch_id>` continues a batch.
- `RAG_PARSER_ALLOW_CLOUD=false` applies in every pipeline: no request reaches LlamaParse or the vision model; the legacy knowledge-base PDF upload answers 503 `cloud_parsing_disabled`, the unified chain parses locally.
- Tier routing thresholds and presets live in `config/rag/parse-routing.json` (read by the app and the sidecar). The sidecar image ships copies of it and `processing-profiles.json` from `rag-sidecar/config/rag/` (as `/app/config/rag/`); edit both, a sidecar test fails when they differ.

### Hybrid retrieval (Phase 4)
- `RAG_PIPELINE=legacy` (default) runs none of Phase 4. `RAG_PIPELINE=v2` runs the v2 stage graph; with every sub-switch off it is dense-only search through `hybrid_search_chunks`, then RRF over one leg and the Phase 2 assembly.
- Sub-switches (defaults in `src/lib/env.ts`, all off): `RAG_LEXICAL_SEARCH=false`, `RAG_RERANKER=none` (`cohere | voyage | local_bm25`), `RAG_RERANK_TIER_CHAT=quality`, `RAG_RERANK_TIER_VOICE=fast`, `RAG_RERANK_VOYAGE_MODEL_BY_LANG=`, `COHERE_API_KEY=`, `COHERE_BASE_URL=`, `RAG_REFUSAL_THRESHOLD=false`, `RAG_CONTEXT_EDGE_ORDER=false`, `RAG_CONTEXT_COMPRESSION=false`, `RAG_CONTEXT_TOKEN_BUDGET=6000`, `RAG_PARENT_CHILD=false`, `RAG_HNSW_ITERATIVE_SCAN=off`, `RAG_EXACT_SCAN_CUTOFF=0`, `RAG_LEXICAL_TRANSLATION=false`.
- `hybrid_search_chunks`, `rag_fetch_parents`, `rag_assert_tenant_key` and the relex, chunk-writer, rechunk and chunking-profile functions are **service_role** only. The app calls them on the admin client with `scopeKey` as the only tenant input; the SQL guard rejects a tenant key of the other deployment mode.
- Commands: `npm run rag:relex` (rebuild lexical text), `npm run rag:rechunk` (build a chunking profile), `npm run rag:chunking` (status, activate, rollback), `python -m rag_eval.sweep retrieval|chunking|chunking-decide` and `python -m rag_eval.calibrate refusal` (from `eval/`).
- Only those tools write `eval/config/retrieval-params.json`, `eval/config/refusal-thresholds.json` and the chunking decisions; do not edit them by hand. Fixture-fitted cells and the fixture similarity floor (`RAG_EVAL_RETRIEVAL_MIN_SIMILARITY`) apply only in eval, never in production.
- Chunking profiles: documents uploaded while `RAG_PIPELINE=legacy` are not written into non-legacy profiles; under v2 they are answered from their legacy chunks and counted as missing (v2 startup warning, admin list, Config UI), and `npm run rag:rechunk -- --profile <id>` repairs an active profile in place.

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
}
```

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

---

## 11. WhatsApp Integration
- Provider factory selects Fly.io or Koyeb Baileys deployment via `WHATSAPP_PROVIDER`.
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
- Under `RAG_PIPELINE=v2` strict mode still answers "information not available" with the default `RAG_RERANKER=none`: without a calibrated rerank threshold the refusal stage applies the embedding profile's similarity floor (legacy 0.65 when the profile has no calibration).
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
| `cd rag-sidecar && docker build --target docling` | Docling parse image; host sizing start ~4 GB RAM, 2 CPUs, one parse worker |
| `scripts/init-env.js` | Default environment template |

---

## 17. Supplementary Documentation
- **[README_VOICE_INTEGRATION.md](README_VOICE_INTEGRATION.md)** – Voice architecture, mobile support, troubleshooting
- **[README_NANGO_INTEGRATION.md](README_NANGO_INTEGRATION.md)** – Cloud connectors setup
- **[README_DEPLOYMENT_MODES.md](README_DEPLOYMENT_MODES.md)** – Single vs Multi-tenant

Keep this guide current—when architecture or workflows change, update this file so every agent stays aligned.
