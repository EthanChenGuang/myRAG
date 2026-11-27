---
phase: 07-external-backends-release-defaults
plan: 19
subsystem: rag-admin
tags: [test-connection, provider-probes, admin-routes, sidecar, ssrf, config-ui-backend]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "Qdrant and Weaviate read clients, health and collection describe (07-07, 07-08); last edit of src/lib/rag/index.ts and the admin route harness (07-15)"
  - phase: 01-evaluation-harness-baseline
    provides: "sidecar shared-secret middleware (01-12)"
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "embedding providers and active profile (03-08)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "Cohere and Voyage rerank adapters (04-09), requireAdminOrDeny route pattern (04-34)"
  - phase: 05-verified-citations-groundedness
    provides: "Anthropic config (D-09), sidecar-held Vectara key and scorer (D-11, D-21)"
  - phase: 05.1-prompt-injection-defense
    provides: "Lakera detector and security config"
provides:
  - "src/lib/rag/admin/provider-probes.ts: PROVIDER_IDS, PROVIDER_PROBE_CODES, PROVIDER_PROBE_MESSAGES, PROVIDER_PROBE_TIMEOUT_MS, isProviderId, runProviderProbe (exported through @/lib/rag)"
  - "POST /api/rag/admin/providers/test: { provider } -> { provider, ok, latencyMs, code, message }, admin only, fail closed, 10 s"
  - "Sidecar POST /v1/providers/test (shared secret): { provider: 'vectara' } -> the same shape"
  - "Contracts ProviderTestRequest and ProviderTestResult (Pydantic, JSON Schema, generated Zod)"
affects: [07-20]

actuals:
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "A probe result carries only the provider id, a code from a fixed enum, the fixed message for that code and a latency; every caught error is mapped to a code and dropped"
    - "Probe fetches go through a guard that replaces a thrown error (whose message can name host:port) with a code before any adapter sees it"

key-files:
  created:
    - src/lib/rag/admin/provider-probes.ts
    - src/app/api/rag/admin/providers/test/route.ts
    - rag-sidecar/src/rag_sidecar/providers_test.py
    - rag-sidecar/schemas/ProviderTestRequest.schema.json
    - rag-sidecar/schemas/ProviderTestResult.schema.json
    - tests/rag/admin/provider-probes.test.ts
    - tests/rag/admin/providers-test-route.test.ts
    - rag-sidecar/tests/test_providers_test.py
  modified:
    - src/lib/rag/index.ts
    - src/lib/rag/embeddings/bge-m3.ts
    - src/lib/rag/ingest/parsers/llamaparse-v2.ts
    - rag-sidecar/src/rag_sidecar/main.py
    - rag-sidecar/src/rag_sidecar/contracts/sidecar.py
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "Codes: the stable five (not_configured, unauthorized, timeout, unreachable, collection_missing) plus ok and the additions disabled, invalid_config, rate_limited, provider_error, bad_response. 401 and 403 are unauthorized, 429 rate_limited, any other HTTP error provider_error; a 200 the adapter cannot parse is bad_response"
  - "Probes per provider: embedding:openai one-token embed through createOpenAiProvider (OpenAI or OpenRouter per RAG_OPENAI_EMBEDDINGS_VIA, key of that host); embedding:voyage one-token query embed through createVoyageProvider at 1024 dims; embedding:deepinfra one-token embed through the hosted BGE-M3 provider (the cheapest DeepInfra model the app uses, so it also stands for the DeepInfra key); rerank:cohere and rerank:voyage query ok over documents a and b with the fast-tier models of the rerank selection (rerank-v5.0-fast, rerank-3-lite)"
  - "backend:qdrant: the read client (read key, write-key fallback as in buildQdrantClients) runs qdrantHealth and describeQdrantCollection for the active profile; backend:weaviate: the process's read client runs isReady and describeWeaviateCollection. A missing collection is collection_missing; an invalid URL or http with a key in production is invalid_config"
  - "sidecar: GET /ready (open to probes) and then GET /v1/info with the shared secret, because /ready does not check the secret; a wrong secret shows as unauthorized"
  - "vectara: the app posts { provider: 'vectara' } to the sidecar and accepts the answer only if it parses as the generated ProviderTestResultSchema with ok matching code; the app keeps its own message for the code and never relays the sidecar's message. The sidecar runs VectaraScorer.score on the fixed text ok (premise and hypothesis) with a 10 s bound"
  - "lakera: the real detector with a probe gate (key and base URL from the loaded config, the injection switches and the multi-tenant ack not required) on the fixed text ok; no tenant text is sent. A 200 without a breakdown or without the configured detector still counts as connected"
  - "langfuse: GET {LANGFUSE_BASE_URL}/api/public/projects with the public and secret key; LANGFUSE_ENABLED is not required, so an admin can test keys before enabling export"
  - "llamacloud: GET {LlamaCloud origin}/api/v1/projects with the key; with RAG_PARSER_ALLOW_CLOUD=false it answers disabled and sends nothing (the AGENTS.md rule that no request reaches LlamaParse then)"
  - "anthropic: GET {ANTHROPIC_BASE_URL}/models?limit=1 with x-api-key and anthropic-version; exa: POST https://api.exa.ai/search { query: ok, numResults: 1 } (Exa has no free authenticated read)"
  - "The loaded configuration is the process's env snapshot from @/lib/env (read once at start); the Weaviate probe uses the process's cached read client. Nothing in the request can change a URL or key"
  - "latencyMs is 0 for not_configured, disabled and invalid_config (no call made)"
  - "The sidecar endpoint validates the body with ProviderTestRequest (extra keys forbidden) and answers 422 invalid_provider_test_request for any other body, 413 above 1 KiB; its log line is [Providers] provider test with provider, ok and code"
---

# 07-19 Summary: Test-connection probes

**An admin can check each provider the app talks to with one minimal authenticated call through the app's own adapter, and gets back only `{ provider, ok, latencyMs, code, message }`: no key, URL, host, port or vendor text, on any path.**

## Task commits

| Task | RED | GREEN |
| --- | --- | --- |
| 1 Probe registry | b5d179c8 test(07-19): add failing tests for the Test-connection probe registry | 51f5ebe0 feat(07-19): add Test-connection probes over the real adapters |
| 2 Admin route | 318f9d27 test(07-19): add failing tests for the provider test route | 6ece85c0 feat(07-19): add the admin provider test route |
| 3 Sidecar endpoint | afc48e7d test(07-19): add failing tests for the sidecar provider test endpoint | fc1cf579 feat(07-19): probe sidecar-held keys through POST /v1/providers/test |

Each RED commit held a stub (a probe returning a wrong code, a route answering 501, a sidecar route answering 501), so the tests failed on assertions: 76 of 93, 10 of 11 and 13 of 16.

## Behaviour changes

- New admin route `POST /api/rag/admin/providers/test` and new sidecar route `POST /v1/providers/test`. Nothing else calls them, and no existing path changes.
- `createBgeM3Provider({ fetch })` now passes that fetch to the hosted OpenAI client too (before: sidecar mode only). No caller passed `fetch` for hosted mode, so production behaviour is unchanged.
- `llamaparse-v2.ts` exports `LLAMA_CLOUD_API_BASE` (same value as its private `API_BASE`).
- No new environment variable, no migration, no switch.

## Tests that failed before the change

All new tests failed against the stubs (see Task commits). The guard mutations the plan names are covered: returning the provider's error body as `message` fails "never leaks"; returning a fetch error's message fails "never leaks endpoint"; renaming `collection_missing` fails "stable contract".

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run` (full suite: the `@/lib/rag` barrel and `contracts.generated.ts` changed): 734 files passed, 3 skipped; 13373 tests passed, 90 skipped.
- `npx vitest run tests/rag/admin/provider-probes.test.ts tests/rag/admin/providers-test-route.test.ts tests/rag/bge-m3-provider.test.ts`: 93, 11 and 35 passed.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`, `node scripts/ci/check-zod-isolation.mjs`: all ok.
- `npm run gen:schemas`: run to add the two contracts; a second run leaves no diff.
- `uv run --directory rag-sidecar pytest -q` (full suite, shared contracts changed): 2694 passed, 12 skipped. Targeted: `tests/test_providers_test.py tests/test_auth.py tests/test_contract_export.py` 33 passed.
- `uv run --directory eval pytest -q tests/test_committed_contract_files.py tests/test_sweep_diversity.py`: 46 passed.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/07-19-ingest`: PASS (8 skipped).
- `npm run test-rag -- --out eval/out/07-19`: FAIL, exit 11, `false_refusal_rate_exceeded` (language:en measured 0.3143 vs max 0.2500). **Pre-existing:** the same command on `base/07-19-v2` (clean worktree, same dependencies) fails identically with the same 0.3143. This plan changes no retrieval, refusal or generation path.
- Not applicable: SQL/migrations (none), `tests/*.test.mts` (none touched), `.github/workflows` (none), UI (none; the buttons are plan 07-20).

## Deviations

1. **Files outside `files_modified`.** `src/lib/rag/embeddings/bge-m3.ts` (hosted client takes the injected fetch, so the DeepInfra probe runs through the real adapter and the test fake), `src/lib/rag/ingest/parsers/llamaparse-v2.ts` (exports the LlamaCloud origin so the probe has no second copy of it), and the sidecar contract files plus generated schemas, Zod and samples (the sidecar endpoint's request and response are Pydantic contracts per the project rule that sidecar interfaces are defined in Pydantic and the Zod side is generated).
2. **Sidecar probe is two calls.** The plan says `/ready` with the shared secret; `/ready` is exempt from the secret, so the probe also calls the authenticated `GET /v1/info` to detect a wrong secret.
3. **Additional codes** `disabled`, `invalid_config`, `rate_limited`, `provider_error`, `bad_response` and the success code `ok`, allowed by 07-UI-SPEC section 15 item 7 as additions. 07-20 words them through `test.fail.other`.
4. **Messages are short fixed English sentences**, not the UI's full sentences: the UI words each code itself (07-UI-SPEC 8.3) and uses `message` only as a fallback.

## Purge hooks (Phase 6.3 note)

No new store, so no purge hook or inventory registration.

## Requirement IDs and decisions for STATE

- ADM-01: Test-connection route and probes for every new provider (UI buttons in 07-20).
- D-15 implemented as recorded in key-decisions. For STATE: provider ids and the five failure codes are a stable contract (`PROVIDER_IDS`, `PROVIDER_PROBE_CODES`), additions only.

## Operator pending

- Live check (operator action, not run here): with real keys loaded in the eval deployment, press Test connection for each configured provider and confirm `ok: true`; then set one key to a wrong placeholder, restart, and confirm `unauthorized`. Exa and Vectara probes make one billable minimal call each.
- The `rerank-3-lite` model id is the app's existing fast-tier Voyage choice; if Voyage answers 400 for it in the live check, the probe reports `provider_error` and the rerank selection itself needs the same correction.

## Deferred

- The Config UI buttons and the manifest-id to probe-id map: plan 07-20.
- Forwarding through `config-server.js` (D-15 mentions it): plan 07-20 owns the Config UI side.

## Pre-existing failure to report

- `npm run test-rag -- --out <dir>` fails its absolute gate on the base branch (`false_refusal_rate` language:en 0.3143 > 0.25), unchanged by this plan.

## Self-Check: PASSED
