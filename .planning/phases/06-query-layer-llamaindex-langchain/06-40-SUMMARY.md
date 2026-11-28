---
phase: 06-query-layer-llamaindex-langchain
plan: 40
subsystem: rag-cache, config-ui
tags: [qry-08, cache-01, d-44, d-22, p-10, admin-route, config-ui, semantic-cache]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-02 Query layer card env fields; 06-21 cache backends and fail-open wrapper; 06-36 last index.ts edit and hashedTenantKey"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-34 admin route guard pattern (requireAdminOrDeny); 04-36 panel modules and rag-fetch.js"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-12 last Phase 5.1 edit of config-server.js and index.html"
provides:
  - "POST /api/rag/admin/semantic-cache: admin-only per-tenant cache clear, returns { success, deleted, backend }"
  - "src/lib/rag/cache/admin.ts: clearTenantSemanticCache, SEMANTIC_CACHE_ADMIN_TIMEOUT_MS (exported from @/lib/rag)"
  - "src/lib/rag/cache/index.ts: createSemanticCacheBackend (unwrapped backend); getSemanticCache now wraps it"
  - "RagDeps.semanticCacheAdmin: the backend without the fail-open wrapper"
  - "GET /api/config/query-layer/status in scripts/config-server.js"
  - "scripts/config-ui/rag-panels/query-layer.js: Query layer panel module"
affects: [06-41, 06-43, 06-46]

actuals:
  tasks: 3
  commits: 8

key-files:
  created:
    - src/lib/rag/cache/admin.ts
    - src/app/api/rag/admin/semantic-cache/route.ts
    - tests/rag/semantic-cache-admin-route.test.ts
    - scripts/config-ui/rag-panels/query-layer.js
    - tests/ui/config-query-layer-panel.test.ts
  modified:
    - src/lib/rag/cache/index.ts
    - src/lib/rag/deps.ts
    - src/lib/rag/index.ts
    - scripts/config-server.js
    - scripts/config-ui/index.html

requirements-completed: [QRY-08, CACHE-01]
---

# Phase 6 Plan 40: Query layer panel and authenticated clear-cache action

Admins can now see the query layer's calibration and warnings in the Config UI, and clear one tenant's semantic cache through an admin-only route that fails closed.

## Accomplishments
- `POST /api/rag/admin/semantic-cache` checks `requireAdminOrDeny` before doing anything else. It validates `{ tenantKey }` with a strict `zod/v3` schema. `clearTenantSemanticCache` then parses the key with `parseTenantKey`, refuses a key from the other deployment mode, and resolves the scope inside the tenant module (`backfillScope`, which checks that the organization or user exists in multi-tenant mode). The route answers 401, 403 or 503 for auth failures, a structured 400 (`invalid_request`, `invalid_tenant_key`, `unknown_tenant`), 503 `semantic_cache_unavailable`, or 200 `{ success, deleted, backend }` with `Cache-Control: no-store`.
- `RAG_SEMANTIC_CACHE=off` answers `{ deleted: 0, backend: 'off' }` and calls neither the database nor a backend.
- The clear action uses the backend without the fail-open wrapper (`RagDeps.semanticCacheAdmin`, built by the new `createSemanticCacheBackend`) under a 10 s deadline. A backend failure is reported as 503 instead of being served as `deleted: 0`. The request path keeps the fail-open cache unchanged.
- Log lines use `[Semantic Cache]` with only `hashedTenantKey`. Backend error text is never logged or returned.
- `GET /api/config/query-layer/status` returns:
  - the framework, the cache backend and the pipeline;
  - `langchain_installed` (whether `@langchain/classic` resolves from the repo root, rechecked on disk);
  - `calibration` from `eval/config/semantic-cache.json`: `{ calibrated, state: missing|invalid|ok, profiles[{ embedding_profile_id, max_distance, source, fitted_at }] }`, validated against the `SemanticCacheCalibration` bounds;
  - `warnings` in this fixed order: `cache_under_legacy`, `langchain_missing`, `langsmith_tracing_set`.

  It never returns env values.
- `query-layer.js`, loaded after `rag-fetch.js`, attaches to the existing Query layer card:
  - It shows the calibrated distance per profile as a read-only table, or a not-calibrated note.
  - Each warning appears as a `role="alert"` block.
  - The LangChain install hint shows next to the framework select whenever the current selection is `langchain` and the package is missing.
  - "Clear cache for tenant" asks for confirmation, then posts `{ tenantKey }` through `ragFetch` and shows the deleted count, or the error text on 401, 403 or 503.

  The existing HyDE and voice help text (voice always uses the native condense, D-22) is unchanged.

## Task Commits
1. Task 1, clear-cache route: `8bc11f6f` (RED test), `e90673d2` (feat)
2. Task 2, config-server status: `333c7940` (RED test), `e152c8ff` (feat)
3. Task 3, panel module: `d42ba911` (RED test), `4283049a` (feat), `8809a743` (confirmation before the destructive clear, from the web-design-guidelines review)
4. SUMMARY: the final docs commit

## Tests that failed before the change
- `tests/rag/semantic-cache-admin-route.test.ts`: 11 of 12 failed against the stub route, all on assertions (the runtime-export case passed).
- `tests/ui/config-query-layer-panel.test.ts` status block: 6 of 7 failed on assertions (404). The foreign-Host case already passed through the existing security middleware.
- `tests/ui/config-query-layer-panel.test.ts` panel block: 7 of 7 failed on assertions against the stub module.

## Behaviour changes
- New admin route and new config-server read-only endpoint. Nothing changes on the chat, embed, voice or eval paths. With every switch off, strict "information not available", webSearch with Exa, `source_images` and `{{context}}` are unchanged, because no request-path code changed.
- `getSemanticCache` behaves exactly as before: it is now `withFailOpen(createSemanticCacheBackend(...))`, with the same one-time RedisVL "needs RAG_SIDECAR_URL" warning.

## Deviations from Plan
- Endpoint path: `/api/config/query-layer/status` instead of `/api/query-layer/status`. It follows the config-server convention (`/api/config/injection-defense`) and is served behind the same loopback and CSRF gate. The acceptance grep `query-layer/status` still matches.
- Added `RagDeps.semanticCacheAdmin` and `createSemanticCacheBackend`. The fail-open wrapper turns every error into 0, which would make a failed admin clear look like a successful one; the plan wants failures to fail closed.
- Tenant resolution reuses `backfillScope` (tenant module). Its refusal log line reads `[Backfill] tenant scope refused`. That is cosmetic, and only the reason is logged.
- A key with the wrong mode or a malformed key gives 400 `invalid_tenant_key`. An organization or user that does not exist gives 400 `unknown_tenant`. The service client being unavailable gives 503.
- The calibration file `eval/config/semantic-cache.json` does not exist yet (plan 06-41 writes it). The panel shows "Not calibrated yet" until then.
- No new env variables, so no five-place or env-manifest sync was needed.

## Gate results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/rag/semantic-cache-admin-route.test.ts tests/api/admin-auth.test.ts`: 38 passed
- `npx vitest run tests/ui/` (includes the new panel test, `config-query-layer-card` and the XSS script scans): 506 passed before the confirmation commit; the panel and XSS-script tests were re-run after it: 29 passed
- Full `npx vitest run` (shared `src/lib/rag/deps.ts` changed): 457 files, 7564 passed, 4 skipped, 0 failed
- `node scripts/ci/check-rag-boundary.mjs`: ok (1617 files)
- `node scripts/check-config.mjs`: ok (192 variables)
- `node --import tsx --test tests/rag-db/semantic-cache*.test.mts`: 194 passed (the route calls the existing `rag_cache_invalidate` RPC; no SQL changed)
- `node scripts/ci/check-frontend-design-summary.mjs .planning/phases/06-query-layer-llamaindex-langchain`: PASS
- Not run, and why: `npm run gen:schemas` (no contract change), `test-rag` (no retrieval, ingest, generation or golden change), workflow and Python checks (not touched)

## Design skills
| Skill | Outcome |
| --- | --- |
| frontend-design | n/a. The additions extend the existing Query layer card with the established daisyUI patterns (`rounded-box bg-base-100` sub-panels as in the Prompt-injection defense summary, `alert alert-warning`, `table table-sm`) and set no new visual direction. |
| Impeccable | pass. Structural critique against `reference/critique.md` and `harden.md`: the warnings sit above the calibration table, so the problems are read first. The calibration is visibly read-only (a caption and no controls). The destructive clear sits in its own sub-panel with a warning-colored outline button and a confirmation. Empty, invalid and unreachable states each have their own line. No screenshot was taken, because the Config UI loads Tailwind and daisyUI from a CDN. |
| web-design-guidelines | pass (all findings resolved). The tenant input has a label (`sr-only`), `autocomplete="off"`, `spellcheck="false"`, `translate="no"`, and a placeholder that ends with `…`. The button has visible text. Results and the framework hint use `role="status"` with `aria-live`; warnings use `role="alert"`. The table has a caption and `th scope="col"`. Values are inserted with `textContent` only. One finding (the destructive action had no confirmation) was fixed in `8809a743`. zh/en/it parity does not apply: the Query layer card copy is English-only and has no doc-type labels. |

## Decisions for STATE
- The admin cache clear uses the unwrapped backend (`RagDeps.semanticCacheAdmin`) so that failures surface as 503. Request-path callers keep the fail-open `RagDeps.semanticCache`.
- The Query layer status lives at `/api/config/query-layer/status` on the config server and reports only choices, booleans, distances and warning codes.

## Operator actions
- End-of-phase walk-through (plan human-check): run `npm run config`, switch the framework to LangChain and back, check the warnings and the calibrated-distance view, and clear the cache for a test tenant while signed in as admin in the main app.

## Deferred
- The real calibrated distances appear once plan 06-41 commits `eval/config/semantic-cache.json`.
- Config UI copy translation (zh/it) for the Query layer card, if the card system adopts i18n later.

## Self-Check: PASSED
