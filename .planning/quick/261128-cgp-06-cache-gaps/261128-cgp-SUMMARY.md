---
quick_id: 261128-cgp
slug: 06-cache-gaps
status: complete
date: 2026-11-28
branch: exec/quick-06-cache-gaps
base: origin/exec/quick-term-glossary-wiring (b4a0b8e3)
closes: 06-SECURITY W-1, W-2, W-4 (W-8); 06-VERIFICATION Gap 2 (SC7 / CACHE-01); Gap 1 follow-up (translate)
requirements: [CACHE-01, QRY-01, QRY-03]
key-files:
  created:
    - tests/rag/cache/writer-invalidation.test.ts
    - tests/rag/cache/cached-answer-schema.test.ts
  modified:
    - src/lib/rag/cache/bypass.ts
    - src/lib/rag/query/run-layer.ts
    - src/lib/rag/cache/emit.ts
    - src/lib/rag/ingest/scopes/admin.ts
    - src/lib/rag/ingest/versions/effective-dates.ts
    - src/lib/rag/ingest/approval/admin.ts
    - src/lib/rag/ingest/attributes/apply.ts
    - src/lib/rag/cache/store-after.ts
    - rag-sidecar/src/rag_sidecar/contracts/cache.py
    - rag-sidecar/schemas/CachedAnswer.schema.json (+ CacheCheckResponse, CacheStoreRequest, generated)
    - src/lib/rag-eval/contracts.generated.ts (generated)
    - .planning/phases/06-query-layer-llamaindex-langchain/06-01-PLAN.md (T-06-01 text)
---

# Quick 261128-cgp: Phase 6 semantic-cache gaps

Source reports: `origin/verify/06` @ `8d582e87`, `06-VERIFICATION.md` (Gap 2) and `06-SECURITY.md` (W-1, W-2, W-4, W-8).
Base branch already carries the Gap 1 glossary wiring for condense and HyDE (quick 261127-tgw).

## 1. W-1: request retrieval filters and the cache (security, medium, same tenant)

**Choice: bypass, not key parts.** Any client `retrievalFilters` field that is set (`dateRange`, `sources`, `documentIds`,
`docTypes`, `languages`, `invoice`, `scopes`/`scopesIncludeUntagged`, `attributes`) makes the stage record
`bypass=retrieval_filters` at check time, and `storeBypassReason` repeats the rule at store time. Why bypass:

- Smallest and safest change: nothing filtered is ever read from or written to the cache, so a filtered answer or a filtered refusal
  (stored 600 s on pgvector) can never reach an unfiltered question, and the reverse.
- Hashing filters into the key would need a canonical form for every field (attributes are maps, dateRange has `includeUndated`,
  invoice amounts are numbers) and would have to be kept in step with every future filter. The bypass check walks every field except
  `versionScope` (which keeps its own `version_scope` rule), so a filter added later fails closed to a bypass.
- Filtered turns are rare UI/API requests, so the hit-rate cost is small.

The check uses `input.retrievalFilters` (the request's own filters). The query layer's date-normalisation merge builds a separate
object later, so unfiltered questions with a normalised date are unaffected. `cacheKeyFilterParts` stays unused (it was never called);
empty values (`{}`, `[]`, `{ attributes: {} }`) count as no filter.

**Key unchanged:** with no filter the key parts and hash are byte-identical (the stage test asserts the `{}`-filters key equals the
no-filters key; `keys.test.ts`, `binding-cache-key.test.ts`, `terminology-key.test.ts` pass unchanged).

## 2. Gap 2: RedisVL invalidation from in-place writers (SC7, CACHE-01)

New `scheduleRedisvlInvalidation(tenantKey, documentIds)` in `src/lib/rag/cache/emit.ts`: the same after-response
`invalidateTenant(scope, ids)` call `publish.ts` makes, a no-op unless `RAG_SEMANTIC_CACHE=redisvl`, never throws. The scope is minted
with `storeScopeForTenantKey` from the tenant key the writer's route guard admitted and its RPC accepted (never request data); a
malformed key sends nothing. Called after a successful write in:

| Writer | File | Documents |
|---|---|---|
| `setDocumentScopes` (`rag_set_document_scopes`) | `ingest/scopes/admin.ts` | the document |
| `applyEffectiveDates` (admin) | `ingest/versions/effective-dates.ts` | the document |
| `recordExtractedEffectiveDates` (`apply` outcome `set`) | same | the document |
| `approveUpload` (`rag_approve_upload`) | `ingest/approval/admin.ts` | approved and superseded version |
| `importAttributeRows` (`rag_import_document_attributes`, non-dry run) | `ingest/attributes/apply.ts` | `changed_document_ids` |

Attribute writers in 1005: `rag_set_document_attributes` has no TypeScript caller today (nothing to wire);
`rag_apply_document_attributes` writes a version that is still being ingested, which the publish-stage emit covers.

Tests (`writer-invalidation.test.ts`, fake RedisVL backend): each writer emits exactly once with the right tenant and ids under
`redisvl`; nothing with `pgvector` or `off`; nothing on a failed write; nothing on an attribute dry run.

## 3. Gap 1 follow-up: translate template

**No change.** The query `translate` transform (XLG-01) does not take the terminology glossary:
- QRY-01 and QRY-03 (amended by 4.1.1) name only the rewrite (condense) and HyDE prompts; XLG-01 has no glossary clause
  (06-VERIFICATION, requirement table).
- The terminology glossary maps same-language surface forms to canonical terms. A translated query needs the target-language term,
  which is a `kind = translation` pair (TERM-12) that never expands a query and is read through `getTerminologyLexicon`.
- Enforcing those pairs in query translation, document translation and rewriting is XLG-05, planned in Phase 6.2 behind
  `RAG_TRANSLATION_GLOSSARY` (06.2-04, 06.2-22, 06.2-30, 06.2-39). Adding the same-language glossary to the translate prompt now would
  pre-empt that design and could push source-language canonical terms into a target-language query.

## 4. Minor items

- **W-2:** the `_storable` rules JSON Schema can state are now on the Pydantic model (`json_schema_extra`): groundedness
  `scored`+`verified` or `not_checked`, and a refusal carries no citations. `gen:schemas` emits them into `CachedAnswerSchema`
  (`.and(z.intersection(...))`), so every `safeParse` (pgvector, RedisVL, store-after) enforces them. The `source_versions`
  uniqueness/membership rules stay Pydantic-only (not expressible). The `CachedAnswer` type is now narrowed accordingly; `store-after.ts`
  checks its draft against `CachedAnswerDraft`, and the test answer builders type against an unnarrowed field type.
- **W-4:** the code is right per 06-15 (wire bound 16 so a longer list is cut, not discarded; D-15 cuts to `max_sub_questions` 4).
  Corrected the threat text T-06-01 in `06-01-PLAN.md`. `06-SECURITY.md` lives on `verify/06` only (not merged here); its T-06-01 row
  should take the same wording when that branch lands.

## Commits

- `a537c065` test: RED W-1 bypass (bypass and stage, chat and embed) and Gap 2 writers; failed on assertions (11 + 5).
- `ac27468e` fix: W-1 `retrieval_filters` bypass.
- `fdc10f33` fix: Gap 2 RedisVL emits.
- `4049034b` test: RED W-2 schema rules (5 failed on assertions).
- `102843e9` fix: W-2 JSON-Schema `_storable` rules, regenerated schemas and Zod, store-after draft type.
- `783084d4` docs: W-4 threat text.
- `67fcde06` test: rag-db answer builders typed for the narrowed `CachedAnswer`.

## Behaviour

- Cache off (default) or pgvector without filters: unchanged. With filters: the cache stage records `bypass=retrieval_filters`, so
  those turns are neither checked nor stored.
- RedisVL: in-place scope-tag, effective-date, approval and attribute-import writes now drop the affected entries after the response.
- Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed: untouched.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: no Phase 1 type errors.
- `node scripts/ci/check-rag-boundary.mjs`, `scripts/check-config.mjs`, `check-language-literals.mjs`,
  `check-settings-classification.mjs`, `check-zod-isolation.mjs`: all pass.
- `npx vitest run tests/rag/cache tests/rag/query` plus every test importing a changed module and the related routes
  (chat-cache-hit, embed-cache, eval-route-cache, scope-routes, upload-approval-routes, effective-dates-routes, attribute routes,
  config UI panels): 122 files, 2251 tests, pass.
- `npm run gen:schemas`: no diff after the commit.
- rag-sidecar pytest: `test_cache_contracts`, `test_cache_contract_export`, `test_cache_service`, `test_cache_endpoints`,
  `test_contract_export`: pass (73, 1 skipped).
- rag-db, foreground, cache files only (each covers the modes it defines): `semantic-cache`, `semantic-cache-adapter`,
  `semantic-cache-canary`, `semantic-cache-invalidation`, `access-cache`, `cache-pairs`: 229/229 pass.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-06-cache-gaps-ingest`: gate PASS, absolute gate PASS.

Not run: full `npx vitest run` (no core type, env or setup change), full rag-db suite (merge train), no SQL change so no grants or
search-path files.

## Deviations

- W-2 narrows the generated `CachedAnswer` type (a consequence of carrying the rule into Zod); three test builders and
  `store-after.ts` adjusted. No runtime change for valid answers.

## Operator actions

- 06-46 Task 4 (real Redis and live calibration) can now run, since Gap 2 is closed.
- Owner: register W-1 as T-06-111 (mitigated by `retrieval_filters` bypass) if wanted.

## Deferred

- `rag_set_document_version_label` (D-49) may change version-label text shown in cached answers; whether its SQL invalidates pgvector
  was not checked here. Low; same tenant; only with `RAG_VERSION_LABELS=true`.
- The RedisVL hit re-check (`rag_cache_sources_current`) still ignores scope tags and effective dates; the new emits cover the writes,
  the re-check stays as designed.
