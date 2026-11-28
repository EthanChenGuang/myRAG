---
phase: 06-query-layer-llamaindex-langchain
plan: 41
subsystem: rag-eval
tags: [semantic-cache, calibration, cache-pairs, eval-route, d-37, d-38, b2]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-29 eval route and harness; 06-32/06-36 cache stage and store rules; 06-34 report cache counts contract; 06-37 last run-layer edit; 06-39 golden cache pairs"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-30 calibrate dispatcher and the dev-fit, test-check pattern"
  - phase: 05-verified-citations-groundedness
    provides: "05-19 last edit of calibrate/__main__.py"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-19 last Phase 5.1 edit of the eval route and run-eval.mts"
provides:
  - "storeCacheAnswerNow: the eval route's awaited store (scheduleCacheStore rules, eval tickets only)"
  - "Eval route: cache context with the semantic_cache override, cache hits served as the trace answer, trace.cache, 403 cache_seed_answer_not_allowed in production"
  - "semantic_cache stage counts: hit (1/0) and distance, or bypass_<reason> (the contract the 06-34 report already reads)"
  - "CachePairsRun / CachePairResult contract (Pydantic, generated Zod) for cache-pairs.json"
  - "npm run test-rag -- --cache-pairs [--allow-live-cache]: golden pairs through the real route and pgvector on PGlite"
  - "python -m rag_eval.calibrate cache (--pairs, --write, --check, --profile, --config, --default-distance)"
  - "eval/config/semantic-cache.json (fixture-ngram, source default 0.05)"
  - "src/lib/rag/cache/threshold.ts effectiveCacheThreshold, passed by the semantic_cache stage as the check distance"
affects: [06-43, 06-44, 06-46]

actuals:
  tokens: 160000
  tasks: 4
  commits: 13

key-files:
  created:
    - eval/harness/cache-pairs.mts
    - eval/src/rag_eval/calibrate/cache.py
    - eval/config/semantic-cache.json
    - src/lib/rag/cache/threshold.ts
    - rag-sidecar/schemas/CachePairsRun.schema.json
    - tests/eval-route-cache.test.ts
    - tests/rag-db/cache-pairs.test.mts
    - tests/rag/cache/threshold.test.ts
    - eval/tests/test_calibrate_cache.py
  modified:
    - src/lib/rag/cache/store-after.ts
    - src/lib/rag/query/run-layer.ts
    - src/lib/rag/index.ts
    - src/app/api/internal/rag/run/route.ts
    - eval/harness/run-eval.mts
    - eval/harness/run-smoke.mts
    - eval/src/rag_eval/calibrate/__main__.py
    - rag-sidecar/src/rag_sidecar/contracts/cache.py
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - rag-sidecar/tests/test_cache_contracts.py
    - rag-sidecar/tests/test_cache_contract_export.py
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - tests/rag/cache/stage.test.ts

key-decisions:
  - "Pair distances are measured at a probe of 0.2 (the contract cap), with the eval cache cleared before each pair, so every row's distance is the distance to its own anchor; calibration recomputes hits at any candidate threshold from the distances"
  - "The fixture run names the fixture-ngram profile (the harness's embedder id), never the legacy profile id the fixture tickets carry, so a fixture entry can never apply in production; fixture pairs refuse to calibrate any other profile (P-13)"
  - "A refused anchor is not stored (eval has no localized refusal text); a source_images turn stays unstored like chat"
  - "No safe paraphrase distance on dev writes source default at RAG_SEMANTIC_CACHE_MAX_DISTANCE (0.05) with the metrics recorded"

requirements-completed: [CACHE-01]
---

# Phase 6 Plan 41: Cache pairs, threshold calibration and the wrong-hit gate

**Eval runs can now seed and probe the semantic cache through the real path, the golden cache pairs run end to end on PGlite, `python -m rag_eval.calibrate cache` fits the distance on dev and checks it on test with near-miss wrong hits gated at zero, and the app checks the cache at the calibrated distance of the active embedding profile.**

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | `4b5b12a` | test(06-41): add failing eval-route cache store, single-tenant isolation and production seed tests |
| 1 GREEN | `00eef61` | feat(06-41): store eval cache answers synchronously and refuse seed answers in production |
| 2 (contract) | `36ec0b8` | feat(06-41): add the CachePairsRun contract for cache-pairs.json |
| 2 RED | `f1ce7ff` | test(06-41): add failing cache-pair run tests on PGlite |
| 2 GREEN | `3d3cb94` | feat(06-41): add the cache-pair run mode (--cache-pairs) |
| 3 RED | `c83a18e` | test(06-41): add failing cache threshold calibration and wrong-hit gate tests |
| 3 GREEN | `84bea99` | feat(06-41): calibrate the semantic-cache distance and gate near-miss wrong hits |
| 3 | `9277e56` | style(06-41): sort imports and drop unused names in the cache calibration |
| 4 RED | `39e6059` | test(06-41): add failing calibrated cache threshold tests |
| 4 GREEN | `ab87dc8` | feat(06-41): check the semantic cache at the calibrated distance of the active profile |
| gates | `4ba14d0` | fix(06-41): type the cache-pair rows and the eval cache context import |
| gates | `316483d` | fix(06-41): import RetrievalCacheContext through the @/lib/rag boundary |

## Behaviour

- **Eval route (D-37, D-38, B2).** With `options.semantic_cache` set (not `off`) the route passes a cache context (resolved generator model, hash of the eval prompt template plus citation strategy, no tools). The pipeline derives the `eval` entry profile, so every eval entry lives in the eval key namespace. After generation the route awaits `storeCacheAnswerNow` with the generated answer, else an accepted `cache_seed_answer`; a hit is served as the trace answer (with `include_answer`) and nothing is stored. `trace.cache` is `hit`, `miss` or `bypass`. A request carrying `cache_seed_answer` on a server with `NODE_ENV=production` gets 403 `{ "error": "cache_seed_answer_not_allowed" }` right after body validation, before scope, retrieval, check or store. Without the override the request and trace are unchanged (no cache context, no `cache` field, no stage counts).
- **Stage counts.** The `semantic_cache` stage records `{ hit: 1, distance }` or `{ hit: 0 }` on a check and `{ bypass_<reason>: 1 }` on a bypass. This fills the counts contract the 06-34 report (`cache_outcome`) already reads; for chat and embed it is additive trace data only.
- **Cache pairs (D-37).** `npm run test-rag -- --run-config eval/config/runs/query-layer-llamaindex.json --cache-pairs --no-gate --out <dir>` builds a fresh fixture database, sets `RAG_SEMANTIC_CACHE=pgvector` and the probe `RAG_SEMANTIC_CACHE_MAX_DISTANCE=0.2` as trusted harness variables, and per pair clears `public.rag_semantic_cache`, sends the anchor with its expected answer as `cache_seed_answer`, then the candidate. Pair requests carry only scope, generator and query-layer options plus the cache override (no max_results, degrade, filters, bindings or references). `cache-pairs.json` (validated by `CachePairsRun`) has pair id, anchor id, category, split, language, outcome, hit, distance, bypass reason and anchor outcome. With `--base-url` the run is refused unless `--allow-live-cache` is given; a live run does not clear the cache. A run without `--cache-pairs` is unchanged.
- **Calibration (D-37).** `python -m rag_eval.calibrate cache --pairs <file> [--write [path]] [--check]` fits on dev only: among the observed dev hit distances, the one with no near-miss wrong hit and the best paraphrase hit rate (ties: the largest). It checks once on test. Bypasses and failures count as misses and are reported by reason. A test-split wrong hit, missing pairs, or no safe paraphrase distance writes `source: default` at `--default-distance` (0.05) with the metrics recorded. `--check` exits 1 on any near-miss wrong hit at the effective distance (a calibrated entry of the file, else the default) on either split. Fixture pairs calibrate only `fixture-ngram`.
- **App threshold (D-37).** `effectiveCacheThreshold(profileId, config)` returns a `calibrated` entry's `max_distance` for that embedding profile, else `RAG_SEMANTIC_CACHE_MAX_DISTANCE`; an invalid file logs one `[Semantic Cache]` warning and uses the env value. The stage passes it as `CacheQuery.maxDistance`. The committed file has only `fixture-ngram` at `source: default`, so production behaviour is unchanged (the env value, default 0.05).

## Fixture result

27 golden pairs on the fixture embedder: 6 code/number near misses bypass with `protected_tokens`; dev paraphrase hits at the probe sit at 0.096 and 0.188, and the dev date near miss `en-cache-near-miss-005` hits at 0.0517. No dev distance lets a paraphrase hit without that near miss, so the file is `source: default` at 0.05 (reason `no_safe_paraphrase_distance`). The gate passes at 0.05 on both splits, with only about 0.002 of margin to that date near miss. This proves the tooling only (research P-13); the production profile gets its threshold from live calibration in 06-46.

## Deviations

1. **New contract `CachePairsRun` / `CachePairResult`** (rag-sidecar `contracts/cache.py`, export registry, sample, generated schema and Zod). The plan named no contract for `cache-pairs.json`; the project rule puts every structured eval output in Pydantic with generated Zod. `npm run gen:schemas` leaves no diff.
2. **`eval/harness/run-smoke.mts`** gained `--cache-pairs` and `--allow-live-cache`: the CLI flags live there, not in `run-eval.mts`. `run-eval.mts` holds the mode itself (`cachePairs`, `allowLiveCache`, `cachePairsPath`).
3. **`src/lib/rag/index.ts`** exports `storeCacheAnswerNow`, `CacheStoreOutcome` and the `RetrievalCacheContext` type, so the route imports through the RAG boundary.
4. **Probe distance.** The pair run checks at 0.2 instead of the configured distance, so that calibration has distances to fit. If a `calibrated` entry is ever committed for the legacy profile id `openai-3-small-1536`, fixture pair runs would probe at that distance instead (the fixture tickets carry that id). The committed file names only `fixture-ngram`.
5. **`uv sync --locked` failed for `eval/`** (the lockfile needs an update, which predates this plan, last touched in 03.2-36). I installed with `uv sync --frozen --all-extras` (still from the lockfile only) and restored `eval/uv.lock` each time a `uv run` without `--frozen` (inside `npm run test-rag`) rewrote it. No lockfile change is committed.
6. Task 3's RED commit failed with AttributeError on an empty `cache.py` module (the module existed), not on module-not-found.

## Tests that failed before the change

- `tests/eval-route-cache.test.ts`: the seed is stored and the second request hits; the single-tenant eval seed is a chat miss and the eval re-check hits; production refuses the seed with 403; the protected-token query records the bypass. These 4 failed on assertions; the no-override test passed before and after.
- `tests/rag-db/cache-pairs.test.mts`: request shape, live refusal, the PGlite run (3 of 3 failed).
- `eval/tests/test_calibrate_cache.py`: 8 of 8 failed.
- `tests/rag/cache/threshold.test.ts` (the calibrated distance and the invalid-file warning) and the new `maxDistance` assertion in `tests/rag/cache/stage.test.ts`.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run` (full suite: shared `run-layer.ts` and generated contracts changed): 8464 passed, 8 skipped
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: pass
- `node --import tsx --test tests/rag-db/cache-pairs.test.mts tests/rag-db/eval-query-layer-overlay.test.mts tests/rag-db/in-process-eval-lifecycle.test.mts` plus `tests/rag-db/*cache*`, `*grants*`, `*search-path*`: 273 passed
- `npm run gen:schemas`: no diff
- `npm run test-rag -- --out eval/out/06-41`: gate PASS; `npm run test-rag -- --fixture-mode ingest --out eval/out/06-41-ingest`: gate PASS
- `npm run test-rag -- --run-config eval/config/runs/query-layer-llamaindex.json --cache-pairs --no-gate --out eval/out/p6-41-pairs`: 27 rows
- `uv run --directory eval python -m rag_eval.calibrate cache --pairs eval/out/p6-41-pairs/cache-pairs.json --check`: exit 0
- eval pytest (full, without `test_parse_fixtures.py`): 1242 passed; rag-sidecar pytest (full): 2125 passed, 11 skipped
- Not run (not touched): check-workflows.py, the UI design gate

## Decisions for STATE

- Cache-pair distances are measured at the 0.2 probe with the eval cache cleared per pair; `cache-pairs.json` is the `CachePairsRun` contract.
- Fixture calibration writes only the `fixture-ngram` profile; fixture pairs refuse any other profile id (P-13).
- `eval/config/semantic-cache.json` is written only by `python -m rag_eval.calibrate cache --write`, like the other tool-written eval config files.

## Operator actions

- Live calibration for the production embedding profile (plan 06-46): `npm run test-rag -- --base-url <url> --cache-pairs --allow-live-cache --embedding-profile <id> --no-gate --out <dir>`, then `python -m rag_eval.calibrate cache --pairs <dir>/cache-pairs.json --write --check`. This seeds the eval key namespace of the live tenant only, and it needs a non-production `NODE_ENV` for the seed answers. I did not run it.

## Deferred

- The CI job that runs `calibrate cache --check` comes in plan 06-43.
- AGENTS.md does not mention `--cache-pairs` or `calibrate cache` yet (left for the phase doc update, 06-44/06-45).
- `eval/uv.lock` needs re-locking (pre-existing); not done here because the brief forbids re-locking.

## Self-Check: PASSED
