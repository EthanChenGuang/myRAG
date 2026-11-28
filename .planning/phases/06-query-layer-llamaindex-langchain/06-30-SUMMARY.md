---
phase: 06-query-layer-llamaindex-langchain
plan: 30
subsystem: rag-sidecar
tags: [semantic-cache, redisvl, sidecar, security, tdd]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: cache contracts (06-09, 06-11); cache extra redisvl 0.32.0 / redis 8.1.0 locked (06-22); REDIS_URL in the five config locations and env-manifest (06-02); app adapter src/lib/rag/cache/redisvl-http.ts (06-21)
  - phase: 05-verified-citations-groundedness
    provides: last main.py / settings.py edit before Phase 5.1 (05-12)
  - phase: 05.1-prompt-injection-defense
    provides: last Phase 5.1 edit of main.py and settings.py (05.1-07)
  - phase: 03.1-tiered-parsing-incremental-queue-bulk-backfill
    provides: sidecar app layout (03.1-37)
provides:
  - "rag_sidecar.cache: CacheService (check, store, invalidate), RedisvlQueries, RefusalNotCached, CacheBackendUnavailable, CacheVectorMismatch, INDEX_PREFIX"
  - "POST /v1/cache/check, /v1/cache/store, /v1/cache/invalidate behind SharedSecretMiddleware"
  - "SidecarSettings.redis_url (SecretStr, from REDIS_URL); REDIS_URL= in rag-sidecar/.env.example"
  - "create_app(cache_service=...) injection seam"
affects: [06-21, 06-46]

actuals:
  tasks: 2
  commits: 5
plan_head_before: ebf45973

tech-stack:
  added: []
  patterns:
    - "Lazy redisvl imports: the default image (no cache extra) imports rag_sidecar.main unchanged and answers 503"
    - "Filters only through redisvl's escaping builders (Tag, FilterQuery), never string concatenation"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/cache/__init__.py
    - rag-sidecar/src/rag_sidecar/cache/service.py
    - rag-sidecar/src/rag_sidecar/cache/router.py
    - rag-sidecar/tests/test_cache_service.py
    - rag-sidecar/tests/test_cache_endpoints.py
  modified:
    - rag-sidecar/src/rag_sidecar/main.py
    - rag-sidecar/src/rag_sidecar/settings.py
    - rag-sidecar/.env.example

requirements-completed: [CACHE-01]
---

# Plan 06-30 Summary: RedisVL semantic-cache backend in the sidecar

The sidecar now serves the optional RedisVL backend (D-35) with the same contract as pgvector. The app adapter from 06-21 (`RAG_SEMANTIC_CACHE=redisvl`) can call it. Real Redis remains a live-verification item for 06-46.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | be615ac3 | test(06-30): RED RedisVL cache service tenant/key-hash filters, per-profile indexes, refusal guard |
| 1 GREEN | 750970bf | feat(06-30): RedisVL cache service with per-profile SemanticCache, tenant and key-hash tag filters |
| 2 RED | 514d0db4 | test(06-30): RED /v1/cache endpoints, REDIS_URL setting and env template |
| 2 GREEN | a4d214ab | feat(06-30): serve /v1/cache/check, store and invalidate behind the shared secret |
| Summary | (this commit) | docs(06-30): plan summary |

## What changed

- **CacheService** keeps one `SemanticCache` per embedding profile (index `rag_semcache_<profile>`). Each one has a stub `CustomVectorizer` that returns zeros of the vector's dimension (vectors are always passed in), `distance_threshold=0.2` (the contract maximum), `ttl=None`, `refresh_ttl_on_hit=False` and tag fields `tenant_key` and `key_hash`. One Redis client is shared.
  - `check`: `vector`, `num_results=1`, the request's `max_distance` as `distance_threshold`, and `(Tag("tenant_key") == tk) & (Tag("key_hash") == kh)`. Before serving a hit, the service checks the hit's tenant tag, key-hash tag and own-index key prefix again, validates the stored `CachedAnswer` JSON and re-checks the distance. It never serves a refusal or an unparsable payload.
  - `store`: masked prompt, the `CachedAnswer` JSON as the response, the vector, `metadata={"source_versions": [...]}`, `filters` with both tags, and `ttl=ttl_seconds`, which is absolute because hits do not refresh it. An answer with `is_refusal` true raises `RefusalNotCached` before any SemanticCache call (plan-check W1).
  - `invalidate`: takes the union of the in-process indexes and `FT._LIST` names that start with `rag_semcache_`, so indexes created before a restart are covered. Each one is opened with `SearchIndex.from_existing` and queried with `FilterQuery(Tag("tenant_key") == tk, return_fields=["entry_id"], num_results=500)` from offset 0. The found keys are dropped and the loop repeats until a page is empty. The response counts distinct keys.
  - A vector whose dimension differs from the profile's index raises `CacheVectorMismatch`, which the endpoint maps to 422 `vector_dimension_mismatch`.
- **Router** (`build_cache_router`, included under `/v1` in `create_app`):
  - Missing REDIS_URL → 503 `semantic_cache_not_configured`.
  - Cache extra not importable → 503 `semantic_cache_unavailable`.
  - Any backend exception → 503 `semantic_cache_backend_error`. The log line holds only the operation and the exception class.
  - Malformed body (for example a bad `tenant_key`) → 422 `invalid_cache_request`.
  - Refusal store → 422 `refusal_not_cached`.
  - Body over 2 MiB → 413.
  - Success: store answers 204, check and invalidate answer the contract JSON. Blocking Redis calls run in the threadpool.
- **Settings**: `REDIS_URL_ENV_VAR`, `redis_url: SecretStr | None` (whitespace counts as unset). It is not logged, and `repr` / `str` mask it.
- **rag-sidecar/.env.example**: one comment line naming the cache extra, followed by `REDIS_URL=`.

## RedisVL import paths verified against the installed 0.32.0 wheel (A-10)

- `from redisvl.extensions.cache.llm import SemanticCache`
- `from redisvl.utils.vectorize import CustomVectorizer` (re-exported from `redisvl.utils.vectorize.custom`)
- `from redisvl.query.filter import Tag`
- `from redisvl.query import FilterQuery`
- `from redisvl.index import SearchIndex` (for `from_existing` during invalidate)
- Recorded escaping: `(Tag("tenant_key") == "o:0a1b2c3d-0000-4000-8000-00000000abcd") & (Tag("key_hash") == <64 hex>)` renders `(@tenant_key:{o\:0a1b2c3d\-0000\-4000\-8000\-00000000abcd} @key_hash:{<64 hex>})`, and `s:default` renders `@tenant_key:{s\:default}`.
- `test_import_paths_match_the_installed_redisvl_wheel_and_tags_are_escaped` passed. It was run, not skipped.

## Security notes

- **T-06-65.** Every check is filtered by both tags through the builder, from values the contract has already regex-validated.
  - Hits are verified a second time in Python against the tenant tag, the key-hash tag and the key prefix.
  - Found in the wheel source: redisvl passes the index prefix to `FT.CREATE` unchanged (`IndexDefinition(prefix=[name])`), with no separator. So index `rag_semcache_p1` also indexes keys `rag_semcache_p10:*` of another profile that has the same dimension. The key-prefix check (`<index>:`) turns such a hit into a miss.
  - Invalidate deduplicates keys across indexes. The overlap stays inside one tenant, because the tenant tag still applies.
  - A test covers both a leaked tenant tag and a leaked prefix.
- **T-06-66.** The existing middleware covers `/v1/cache/*`; a test checks each path without the secret.
- **T-06-67.** REDIS_URL is a SecretStr and is never logged. A test checks the log text with a placeholder password.
- **T-06-99.** Refusals are never written to Redis.

## Tests that failed before the change

- RED be615ac3: 11 of 12 cases in `test_cache_service.py` failed on assertions against the stub (no filter or index use, no refusal error, no dimension check, import-path rendering `'None'`).
- RED 514d0db4: 14 of 17 cases in `test_cache_endpoints.py` failed (404 instead of 503/422/200, `redis_url` not loaded, no `REDIS_URL=` line). The three shared-secret cases passed already: the middleware guards every `/v1` path. They stay as characterization tests.

## Gates run

- `uv run --directory rag-sidecar --frozen --no-sync pytest -q tests/test_cache_service.py`: 12 passed. `-k import_paths`: 1 passed.
- `uv run --directory rag-sidecar --frozen --no-sync pytest -q tests/test_cache_endpoints.py tests/test_auth.py tests/test_boot.py`: 36 passed.
- Full sidecar suite `uv run --frozen --no-sync pytest -q` (main.py and settings.py are shared): 2147 passed, 11 skipped. It was run after `python3 scripts/ci/fill-tiktoken-cache.py`. One earlier run without the cache failed `test_docling_adapter` and passed once the cache was filled.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all exit 0.
- `npm run gen:schemas`: no diff. No contract changed.
- vitest: not run. No TypeScript file changed, so no test imports a changed module.
- Not applicable: rag-db, workflows, eval pytest, `test-rag` and the UI design gate. This plan touches no SQL, workflow, eval, retrieval or UI code.

## Deviations

1. **Environment sync.** The brief's install step syncs only `--extra chunking --extra preflight`, so `import redisvl` failed at first. In this fresh session I ran `uv sync --locked --extra chunking --extra preflight --extra cache` in rag-sidecar. That installed redisvl 0.32.0, redis 8.1.0 and their locked transitives from the existing lockfile. Nothing was added, upgraded or re-locked, and `git status` stayed clean. The plan's "orchestrator syncs" step cannot carry over into a separate container.
2. **Invalidate ignores `document_ids`.** Entry metadata is not a filterable field, so every invalidate drops all entries of the tenant. This is a superset and safe, as the plan's truth states. A test pins it.
3. **Invalidate drops by Redis key.** It calls `SearchIndex.drop_keys` instead of `SemanticCache.drop(ids=)`, because indexes found through `FT._LIST` after a restart have no SemanticCache instance. The effect is the same.
4. Extra hardening beyond the plan: the key-prefix check on hits, the dimension-mismatch 422, the 2 MiB body cap, and `semantic_cache_backend_error` 503 for Redis failures.

## Pre-existing issue (not caused by this plan)

`uv sync --locked --all-extras` in `eval/` fails on exec/06-22 with "The lockfile at `uv.lock` needs to be updated". `uv lock --check` fails too. The likely cause is that eval's path dependency on rag-sidecar gained the `cache` extra in 06-22 without an eval lock refresh. That matches how 03.2-36 and 05-05 each refreshed eval/uv.lock after adding a sidecar extra. I did not re-lock. The orchestrator should refresh eval/uv.lock on the 06-22 line.

## Decisions for STATE

- D-35 implementation: sidecar RedisVL backend with the index name `rag_semcache_<profile>` and an absolute TTL. Invalidation is tenant-wide, and refusals are never stored in Redis.
- The redisvl prefix overlap between profile ids is handled in the service by the key-prefix check, not by renaming indexes.

## Operator actions

- Live check (06-46): run against a Redis with the query engine (Redis 8 or Redis Stack) and the cache extra. Use a placeholder tenant to store, check, invalidate and restart, then invalidate again. The local `redis-server` 7.0.15 in this container has no `FT.*` commands, so no live run was possible here.
- Deploy: set `REDIS_URL` only on the sidecar, and build the image with the cache extra when `RAG_SEMANTIC_CACHE=redisvl`.

## Deferred

- Narrowing invalidation by document id (needs a filterable source field or a metadata scan).
- Eval lock refresh (pre-existing, see above).
