---
phase: 06-query-layer-llamaindex-langchain
plan: 09
subsystem: contracts
tags: [pydantic, contracts, semantic-cache, golden-set]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: contracts/query.py Lang and the last contracts/__init__.py edit (06-01)
  - phase: 05-citations-groundedness
    provides: CitationRecord and AnswerGroundedness in contracts/answers.py (05-01)
  - phase: 05.1-prompt-injection-defense
    provides: last Phase 5.1 edits of golden.py and contracts/__init__.py (05.1-03, 05.1-24)
provides:
  - rag_sidecar.contracts.cache (CachedAnswer, CachedSource, CachedSourceVersion, CacheCheckRequest, CacheCheckResponse, CacheStoreRequest, CacheInvalidateRequest, CacheInvalidateResponse, CacheSplitMetrics, SemanticCacheProfileCalibration, SemanticCacheCalibration)
  - module constants TENANT_KEY_PATTERN, KEY_HASH_PATTERN, EMBEDDING_PROFILE_ID_PATTERN, CACHE_MAX_DISTANCE (0.2), CACHE_MAX_TTL_SECONDS (86400)
  - GoldenItem categories cache_paraphrase, cache_near_miss, small_talk and the optional pair_of field
affects: [06-11, 06-17, 06-21, 06-30, 06-36, 06-38, 06-41]

actuals:
  tokens: 45000
  tasks: 2
  commits: 5
plan_head_before: 80e8668

tech-stack:
  added: []
  patterns:
    - "One tenant-key regex constant (same text as the SQL guards in 0315) used through a shared Annotated type in every cache request model"
    - "Cached groundedness reuses Phase 5 AnswerGroundedness and narrows it with a validator to scored+verified or not_checked"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/cache.py
    - rag-sidecar/tests/test_cache_contracts.py
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/golden.py
    - rag-sidecar/tests/test_golden_contract.py
    - rag-sidecar/schemas/GoldenItem.schema.json, DraftedItemBatch.schema.json, EvalReport.schema.json, JudgeReport.schema.json (regenerated)
    - src/lib/rag-eval/contracts.generated.ts, tests/fixtures/contracts/samples.json (regenerated)

requirements-completed: []
requirements-progressed: [CACHE-01]
---

# Phase 6 Plan 09: Semantic-cache and golden contracts

The Pydantic contracts for the semantic cache are in place: the cached answer, the five `/v1/cache/*` bodies and the per-profile calibration file. The golden set can now hold cache pairs and small talk. There is no runtime code yet, and every existing golden item still validates.

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1 Cache contracts | c8aaefa test(06-09): add failing tests for semantic-cache contracts | 6f49b3f feat(06-09): add semantic-cache contracts |
| 2 Golden categories and pair_of | e235e71 test(06-09): add failing tests for cache pair and small-talk golden items | 1e1dfa0 feat(06-09): add cache pair and small-talk golden categories |

The RED commits failed on assertions (`DID NOT RAISE`, unexpected `ValidationError`, a missing attribute), not on a missing module. Task 1's RED commit carried a permissive skeleton `cache.py` so the imports resolved.

## Contract shape

- **CachedAnswer:** `answer_text`, `citations` (Phase 5 `CitationRecord`, text snapshots included), `sources` (`{document_id, name, version}`), `source_versions` (`{document_id, version}`, version ≥ 1, unique per document), `answer_language` (`Lang`), `rag_mode` (`strict | balanced`), `is_refusal`, `groundedness` (Phase 5 `AnswerGroundedness`), `trace_id`, `created_at`.
  - Validators reject `possibly_unreliable` and `pending` groundedness (T-06-16).
  - Every cited document and every shown source must have a `source_versions` entry, so the version re-check on a hit covers all of them.
  - A refusal carries no citations.
- **CacheCheckRequest:** `tenant_key`, `key_hash`, `embedding_profile_id`, `vector` (1–4096 finite floats), `max_distance` (0–0.2).
- **CacheCheckResponse:** `hit`, plus `entry_id`, `distance` and `answer`, which are all present on a hit and all absent on a miss.
- **CacheStoreRequest:** the same key fields, plus `query_text_masked`, `vector`, `answer` and `ttl_seconds` (1–86400).
- **CacheInvalidateRequest:** `tenant_key` and `document_ids` (`None` means the whole tenant; an empty list is rejected). **CacheInvalidateResponse:** `deleted` ≥ 0.
- **Shared key patterns:** `tenant_key` must be `s:default` or `[uo]:<lower-case uuid>`, and `key_hash` must be 64 lower-case hex characters. The embedding profile id is also restricted to `[A-Za-z0-9._-]`, because the RedisVL backend uses it in index names (T-06-15).
- **SemanticCacheCalibration:** `schema_version: 1` and `profiles: SemanticCacheProfileCalibration[]`, one entry per embedding profile id.
  - Each entry holds `max_distance` (≤ 0.2), `source` (`default | calibrated`), `fitted_at`, and `dev`/`test` split metrics: the paraphrase and near-miss pair counts, the paraphrase hit rate and the near-miss wrong-hit rate.
  - `calibrated` requires both splits, `fitted_at`, pairs of both kinds and a near-miss wrong-hit rate of 0 on both splits.
- **GoldenItem:** gains `pair_of` (same id pattern as `id`, default `None`), which is required exactly for `cache_paraphrase` and `cache_near_miss` and may not name the item itself.
  - `answerable` is false if and only if the category is `no_answer` or `small_talk`.
  - Unanswerable items carry no evidence. All other rules are unchanged.

## Behaviour changes

None at runtime: the change is contracts only. Generated artifacts changed:
- The `GoldenItem` JSON Schema and Zod gain `pair_of` and the three categories.
- The schemas embedding `Category` (DraftedItemBatch, EvalReport, JudgeReport) gain the categories.
- `samples.json` gains `pair_of: null`.

`eval/fixtures/golden.jsonl` is untouched and its sha is unchanged.

## Tests that failed before the fix

- `tests/test_cache_contracts.py`: 25 of 29 failed against the skeleton.
- `tests/test_golden_contract.py`: 5 new cases failed, covering the cache-pair categories, `pair_of`, `small_talk` and the drafted-batch category.

## Gate results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | 0 diagnostics |
| `npx vitest run` | 254 files, 4077 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1262 pass, 4 fail, 4 skipped in the full run. The 4 failures are all subtests of `tests/rag-db/ingest-mode-routing.test.mts`. Rerun alone, that file passes 13/13: load flakiness, not caused by this plan, which touches no TS runtime or SQL |
| `check-rag-boundary` + node test | ok, 38 pass |
| `node scripts/check-config.mjs` | ok, 125 variables |
| `check-workflows.py` | OK |
| rag-sidecar pytest | 1380 passed, 11 skipped |
| eval pytest | 702 passed |
| `npm run gen:schemas` | no diff after the commit |
| `npm run test-rag -- --out eval/out/06-09` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/06-09-ingest` | gate PASS (7 skipped) |

## Deviations

1. **Generated schemas are committed in this plan.** The plan defers schemas to 06-11. Adding `pair_of` and the categories changes the already-exported `GoldenItem` (and the schemas that embed `Category`), so the gate "`npm run gen:schemas` leaves no diff" required regenerating them here. The new cache models are not added to `CONTRACTS`; that stays with 06-11.
2. **Extra models and integrity rules beyond the plan text.** I added:
   - `SemanticCacheProfileCalibration` and `CacheSplitMetrics`, which make up the per-profile file, and `CachedSource` / `CachedSourceVersion` for the source lists.
   - The rule that cited and shown documents must appear in `source_versions`.
   - The rule that a refusal has no citations.
   - The self-reference ban on `pair_of`.
   - The embedding-profile-id pattern.
   - The 4096-dimension vector cap.
3. **`max_distance` on `CacheCheckRequest` is capped at 0.2**, the same as the calibration cap. If `RAG_SEMANTIC_CACHE_MAX_DISTANCE` is set above 0.2, the request fails validation, and under D-36 fail-open that becomes a miss. 06-02 may want to validate the env var against the same cap.

## Decisions for STATE

- D-06-09-a: one `TENANT_KEY_PATTERN` constant, `^(s:default|[uo]:<uuid lower>)$`, identical to the SQL guards, used in every cache request.
- D-06-09-b: `CachedAnswer` accepts only scored+verified or not_checked groundedness; `rag_mode` is `strict | balanced`.
- D-06-09-c: `SemanticCacheCalibration` is `{schema_version: 1, profiles: [...]}` with unique `embedding_profile_id`; `calibrated` entries need a zero near-miss wrong-hit rate on dev and test; `max_distance` ≤ 0.2 always.
- D-06-09-d: `small_talk` joins `no_answer` as an unanswerable category; `pair_of` is required exactly for the two cache-pair categories.
- Requirement progressed: CACHE-01 (contracts only).

## Operator actions

None.

## Deferred

- Export of the cache models into `CONTRACTS`, their samples and Zod: plan 06-11.
- Cache-pair and small-talk golden items: plan 06-38.
