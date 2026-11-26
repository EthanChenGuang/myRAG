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
- Fresh projects run `supabase/single-tenant-setup.sql` or `supabase/multi-tenant-setup.sql`, then apply ordered files under `supabase/migrations/` (common file first, then `.single-tenant.sql` / `.multi-tenant.sql` for that mode). Folded setup files already include Phase 3 (0301–0320), Phase 3.1 (0351–0359, 0420–0424), Phase 3.1.1 (0440–0442), Phase 4 (0401–0413, 0425) and Phase 5 (0501–0502); 0426, 0427, Phase 3.2 (0801–0822) and Phase 6 migrations are not folded yet; migrations remain the upgrade path and must be idempotent on top. pgvector must stay in schema `public`: 0425 stops with 55000 otherwise, so do not act on Supabase lint 0014 (`extension_in_public`) for `vector`.
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
- Migrations 0801–0822 (0811 unused) are not folded into the setup files; they replace functions last defined in older files, so after re-running any older migration or setup file, re-run the whole 08xx block in order. Each new store has a service-role `rag_purge_hook_<name>(p_tenant_key, p_lineage_id, p_document_ids)` (scope tags, supersession, rebuild, recaption, chunk translations and their gaps).
- Observability: the ingestion trace carries `language_shares`, `und_count`, `ingest_fingerprint`, `scan.injection`, `scan.hidden_text`, `scan.links`, `approval_state`, `translation.translated` and `translation.gaps`, each only while the switch that produces it is on; log prefixes `[RAG Languages]`, `[Ingest]`, `[RAG Security]`, `[Translation]` carry counts, reason kinds and ids only.

### Hybrid retrieval (Phase 4)
- `RAG_PIPELINE=legacy` (default) runs none of Phase 4. `RAG_PIPELINE=v2` runs the v2 stage graph; with every sub-switch off it is dense-only search through `hybrid_search_chunks`, then RRF over one leg and the Phase 2 assembly.
- Phase 4.1 tested v2 with lexical search, `RAG_RERANKER=auto` and the refusal threshold as the shipped default and did not flip it (`eval/decisions/04.1-retrieval-defaults.md`, status `not_flipped`): an unset `RAG_PIPELINE` serves legacy and reads no language settings. v2 is opt-in with `RAG_PIPELINE=v2`, which answers status `error` with reason `languages_not_configured` until the supported languages are chosen (`RAG_SUPPORTED_LANGUAGES`, `RAG_PRIMARY_LANGUAGE` or the Config UI picker; the chat route reports it as the knowledge-base outage) and `backend_error` while the Phase 4 migrations are missing. Setting `RAG_PIPELINE=legacy`, or removing the variable, switches back; the CI legacy smoke tiers require an explicit-legacy run to match the committed baselines exactly.
- Sub-switches (defaults in `src/lib/env.ts`, all off): `RAG_LEXICAL_SEARCH=false`, `RAG_RERANKER=none` (`cohere | voyage | local_bm25 | auto`; `auto` uses Cohere when `COHERE_API_KEY` is set, which sends query and candidate text to Cohere, else `local_bm25`; Voyage runs only when named), `RAG_RERANK_TIER_CHAT=quality`, `RAG_RERANK_TIER_VOICE=fast`, `RAG_RERANK_VOYAGE_MODEL_BY_LANG=`, `COHERE_API_KEY=`, `COHERE_BASE_URL=`, `RAG_REFUSAL_THRESHOLD=false`, `RAG_REFUSAL_FLOOR=similarity` (`legacy_rule`), `RAG_CONTEXT_EDGE_ORDER=false`, `RAG_CONTEXT_COMPRESSION=false`, `RAG_CONTEXT_TOKEN_BUDGET=6000`, `RAG_PARENT_CHILD=false`, `RAG_HNSW_ITERATIVE_SCAN=off`, `RAG_EXACT_SCAN_CUTOFF=0`, `RAG_LEXICAL_TRANSLATION=false`.
- `hybrid_search_chunks`, `rag_fetch_parents`, `rag_assert_tenant_key` and the relex, chunk-writer, rechunk and chunking-profile functions are **service_role** only. The app calls them on the admin client with `scopeKey` as the only tenant input; the SQL guard rejects a tenant key of the other deployment mode.
- Commands: `npm run rag:relex` (rebuild lexical text), `npm run rag:rechunk` (build a chunking profile), `npm run rag:chunking` (status, activate, rollback), `python -m rag_eval.sweep retrieval|chunking|chunking-decide` and `python -m rag_eval.calibrate refusal` (from `eval/`).
- Only those tools write `eval/config/retrieval-params.json`, `eval/config/refusal-thresholds.json` and the chunking decisions; do not edit them by hand. Fixture-fitted cells and the fixture similarity floor (`RAG_EVAL_RETRIEVAL_MIN_SIMILARITY`) apply only in eval, never in production.
- Chunking profiles: documents uploaded while `RAG_PIPELINE=legacy` are not written into non-legacy profiles; under v2 they are answered from their legacy chunks and counted as missing (v2 startup warning, admin list, Config UI), and `npm run rag:rechunk -- --profile <id>` repairs an active profile in place.

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
- Phase 3.2 is additive: with every Phase 3.2 switch at its default, strict "information not available", webSearch with Exa, `source_images`, the `{{context}}` placeholder, voice and embed chat behave as before; quarantined and `pending_review` versions never reach retrieval, and an ingestion-side setting change never rebuilds anything without an admin starting it.
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
| `npm run rag:fingerprint` | Ingestion fingerprint backfill (Phase 3.2) |
| `npm run rag:rebuild` | Admin-started rebuild after an ingestion-side change, eval record, security rescan |
| `npm run rag:translate` | Document translation backfill and translation re-embed |
| `npm run rag:reembed -- --recaption` | Redo image captions (resume, rollback) |
| `cd rag-sidecar && docker build --target docling` | Docling parse image; host sizing start ~4 GB RAM, 2 CPUs, one parse worker |
| `scripts/init-env.js` | Default environment template |

---

## 17. Supplementary Documentation
- **[README_VOICE_INTEGRATION.md](README_VOICE_INTEGRATION.md)** – Voice architecture, mobile support, troubleshooting
- **[README_NANGO_INTEGRATION.md](README_NANGO_INTEGRATION.md)** – Cloud connectors setup
- **[README_DEPLOYMENT_MODES.md](README_DEPLOYMENT_MODES.md)** – Single vs Multi-tenant

Keep this guide current—when architecture or workflows change, update this file so every agent stays aligned.
