---
phase: 03-unified-ingestion-embedding-profiles
plan: 22
subsystem: ingestion
tags: [doc-type, defaults, auto-detect, rls, tenant-isolation, llm-classifier, pgvector-schema]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest() with the thirteen D-02 stages, writer.ts and StageContext (03-13, 03-13b); processing profiles loader (03-02, 03-06); generated DocTypeDetection schema (03-02)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "TenantScope minting, scopeKey, assertTenantScope, RpcClient"
provides:
  - "rag_doc_type_defaults table (migration 0312): RLS on, no policies, closed to anon and authenticated, read and written only through service-role functions filtered by tenant_key"
  - "resolveDocType: picked > Nango folder > Nango connection > source > tenant > general, with origin picked / source_default / tenant_default / auto / fallback; a winning auto runs detection"
  - "detectDocType: deterministic rules-first detection returning { doc_type, confidence, signals, method: 'rules' }, general below 0.6"
  - "detectDocTypeWithLlm behind RAG_DOC_TYPE_LLM_DETECT, validated by the generated DocTypeDetection schema, falling back to the rules result"
  - "refineDocTypeAfterParse (the hook plan 03-27 calls from the parse stage): changes an auto-detected type at most once and reports whether the parser options differ"
  - "getDocTypeDefaults, setDocTypeDefault, deleteDocTypeDefault for the admin routes of plan 03-39"
affects: [03-27, 03-31, 03-32, 03-33, 03-39, 03-42, 03-43]

actuals:
  tokens: 27000
  tasks: 3
  commits: 6
plan_head_before: 63a758b1dad8537a16d286c4c17692ff5a2d3931
plan_head_after: 6a19db51ddbf71197bb0177a16002074a91415bb

tech-stack:
  added: []
  patterns:
    - "Admin-only data lives behind SECURITY DEFINER functions granted to service_role only; the route that calls them owns the admin check (requireRagAdmin or checkAdmin), the database refuses everyone else"
    - "Resolver functions take their dependencies explicitly ({ db, config, signal }) so the module has no import-time dependency on env or Supabase"
    - "Optional LLM steps load their SDK and environment lazily and report a warning code instead of throwing"

key-files:
  created:
    - supabase/migrations/0312_doc_type_defaults.sql
    - src/lib/rag/ingest/profiles/resolve-doc-type.ts
    - src/lib/rag/ingest/profiles/detect-doc-type.ts
    - src/lib/rag/ingest/profiles/llm-detect.ts
    - tests/rag/ingest/resolve-doc-type.test.ts
    - tests/rag/ingest/detect-doc-type.test.ts
    - tests/rag-db/doc-type-defaults.test.mts
    - tests/fixtures/ingest/llm-detect-recorded.json
  modified:
    - src/lib/rag/ingest/stages/identify.ts
    - src/lib/rag/ingest/stages/enrich.ts
    - src/lib/rag/ingest/types.ts

key-decisions:
  - "The defaults functions are executable by service_role only and the table has RLS with no policies; whoever may change a default is decided by the calling route (plan 03-39 uses checkAdmin and passes the guard's userId as updatedBy). SQL tests run in both deployment modes and prove anon and authenticated are refused by a real SET ROLE call"
  - "Tenant keys are validated in SQL (s:default in the single-tenant schema, lower-case u:<uuid> or o:<uuid> in the multi-tenant one), so single-tenant refuses any foreign key. The TypeScript layer also drops any returned row whose tenant_key is not the caller's"
  - "source_ref holds a Nango connection id or a Nango folder id in the same column, as D-15 says; the resolver matches the folder id first, then the connection id. A connection id equal to a folder id string would resolve as the folder (not a realistic collision)"
  - "An unreadable defaults table (migration not applied, database error) resolves to general with origin fallback and the warning doc_type_defaults_unavailable; it does not fail the ingest. The type only selects processing, never access, and failing every upload for a missing optional table would be worse than today's behaviour"
  - "A picked type never reads the defaults table. A picked or default value of auto runs detection and records origin auto, including when the detector answers general below 0.6"
  - "Detection stays a rules function with no network; the LLM step lives in the resolver wrapper, runs only with RAG_DOC_TYPE_LLM_DETECT=true, a rules confidence below 0.6 and non-empty text, sends at most 8000 characters, and its free-text signals are cut to at most six lower-case codes of 48 characters prefixed llm:"
  - "Refinement only touches a type whose origin is auto. A picked type, an admin default or the fallback is never changed by detection"
  - "metadata.doc_type_detection and the final doc_type, doc_type_origin and processing profile are written by the enrich stage, after parse and any refinement and before chunks are written, because the document row does not exist during identify"

patterns-established:
  - "Detection signals are fixed codes (filename:keyword:<word>, text:keyword:<word>, text:invoice_number, text:vat_id, text:clause_headings, text:table_rows, ext:image, probe:text_layer_share:<n>); they never echo document text"

requirements-completed: [DATA-03, DATA-04, DATA-10]

coverage:
  - id: D1
    description: "rag_doc_type_defaults is closed to anon and authenticated (RLS on, no policies, no grants), and its get, set and delete functions are executable by service_role only, in both deployment modes"
    requirement: DATA-10
    verification:
      - kind: integration
        ref: "tests/rag-db/doc-type-defaults.test.mts#the table is closed to anon and authenticated, open to service_role, RLS on with no policies"
        status: pass
      - kind: integration
        ref: "tests/rag-db/doc-type-defaults.test.mts#the three functions are executable by service_role only, and anon and authenticated are refused when they call"
        status: pass
    human_judgment: false
  - id: D2
    description: "resolveDocType follows picked > Nango folder > connection > source > tenant > general with the right origin for all 32 presence combinations, and a winning auto runs detection"
    requirement: DATA-10
    verification:
      - kind: unit
        ref: "tests/rag/ingest/resolve-doc-type.test.ts#resolveDocType precedence (D-15)"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/resolve-doc-type.test.ts#resolveDocType with auto (D-16)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Defaults of tenant A never affect tenant B, including a Nango folder default with the same ref string, and an organization is separate from the personal tenant of its member; single-tenant refuses foreign tenant keys"
    requirement: DATA-10
    verification:
      - kind: integration
        ref: "tests/rag-db/doc-type-defaults.test.mts#defaults of tenant A never affect tenant B, including a Nango folder with the same ref string"
        status: pass
      - kind: integration
        ref: "tests/rag-db/doc-type-defaults.test.mts#single-tenant refuses a key that is not s:default"
        status: pass
    human_judgment: false
  - id: D4
    description: "detectDocType is deterministic and rules-first for filename, zh/en/it keywords, invoice-number and VAT-id shapes, clause headings, table rows, image files and the text-layer share, and returns general below 0.6 with signals that never contain document text"
    requirement: DATA-03
    verification:
      - kind: unit
        ref: "tests/rag/ingest/detect-doc-type.test.ts#detectDocType rules (D-16)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Detection runs in two steps: a provisional result before parse and refineDocTypeAfterParse on the parsed text, which changes an auto type at most once and reports a differing parser profile for at most one re-parse"
    requirement: DATA-03
    verification:
      - kind: unit
        ref: "tests/rag/ingest/detect-doc-type.test.ts#detection in two steps (F-10)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The optional LLM classifier is never called with the switch off, validates the recorded response with the generated schema, falls back to rules with llm_detect_invalid or llm_detect_failed, and its model id is in the default OpenRouter model list"
    requirement: DATA-03
    verification:
      - kind: unit
        ref: "tests/rag/ingest/detect-doc-type.test.ts#optional LLM classifier (D-16)"
        status: pass
    human_judgment: false
  - id: D7
    description: "identify resolves picked, auto, tenant default and Nango folder default into the begin call, the identify span records doc type and origin, and enrich stores the final type and metadata.doc_type_detection"
    requirement: DATA-04
    verification:
      - kind: unit
        ref: "tests/rag/ingest/resolve-doc-type.test.ts#identify resolves the type and the profile"
        status: pass
    human_judgment: false
  - id: D8
    description: "A real call to the OpenRouter classifier with the live key returns a valid DocTypeDetection for a real document"
    requirement: DATA-03
    verification: []
    human_judgment: true
    rationale: "No live key or network is available in this worktree; the call path was exercised only with a mock language model (schema accepted by generateObject) and recorded responses"

duration: 22min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 22: Document-type resolution Summary

**Admin defaults table (migration 0312, service-role functions only) with the picked > Nango folder > connection > source > tenant > general order, rules-first zh/en/it detection with an optional LLM classifier, and the identify stage deciding every document's type and origin**

## Performance

- **Duration:** about 22 min
- **Started:** 2026-11-24T02:42:29Z
- **Completed:** 2026-11-24T03:05Z (approximate)
- **Tasks:** 3 (all TDD, six commits)
- **Files:** 8 created, 3 modified (2143 insertions, 22 deletions)

## Accomplishments

- Migration 0312 creates `rag_doc_type_defaults` (unique on tenant, kind and coalesced ref; CHECKs on kind, type and ref), RLS on with no policies, nothing granted to anon or authenticated. `rag_get_doc_type_defaults`, `rag_set_doc_type_default` and `rag_delete_doc_type_default` are SECURITY DEFINER, executable by service_role only, always filtered by `tenant_key`, and refuse a malformed tenant key, an unknown type or kind, a ref on a kind other than `nango`, and a blank actor. Both tenant modes are tested, including real `SET ROLE anon` and `SET ROLE authenticated` calls that are refused.
- `resolveDocType(scope, input, deps)` implements the D-15 order once. A picked type reads no table. Rows of another tenant are dropped even if returned. An unreadable table gives general with a warning. A table-driven test walks all 32 combinations of the five levels using one distinct type per level.
- `detectDocType` scores weighted signals into a confidence in [0, 1]: filename keyword 0.6, a defining keyword in the opening of the text 0.45, supporting keywords 0.1 each, invoice number and VAT-id shapes 0.3 each, two clause headings 0.4, table rows with a financial keyword 0.2, an image file 0.7, a text-layer share under 0.2 or 0.4 gives 0.85 or 0.6. Below 0.6 the type is general. Input is cut to the first 20,000 characters and a hostile 200,000-character input returns in well under a second.
- The optional classifier (`RAG_DOC_TYPE_LLM_DETECT`, off by default) runs only for a weak rules result with text, sends at most 8000 characters, validates with the generated `DocTypeDetectionSchema`, and falls back to the rules result with `llm_detect_invalid`, `llm_detect_failed` or `llm_detect_unavailable`. Its SDK and environment are loaded lazily.
- `refineDocTypeAfterParse(ctx, { text, textLayerPageShare })` re-detects on parsed text for an auto-detected type only, changes it at most once, and reports `parserOptionsDiffer` (true only when the parser options differ and no re-parse has happened yet).
- `identify` calls `resolveDocType`, keeps the detection in `state.docTypeDetection`, and `enrich` writes the final `doc_type`, `doc_type_origin`, profile id and version and `metadata.doc_type_detection`. The identify span shows doc type and origin through the existing span facts.

## Task Commits

1. **Task 1: Defaults table, its functions and resolveDocType with the two-tenant test**
   - RED `c735a68` (test): 52 unit tests, 50 failed on assertions, 2 passed (the empty-defaults case and the foreign-tenant case, which the neutral stub satisfies); 17 DB tests, all failed on the assertion "migration 0312 must create rag_doc_type_defaults"
   - GREEN `bdd27f8` (feat): 52 unit and 17 DB tests pass
2. **Task 2: Rules-first detection with two steps and the optional LLM classifier**
   - RED `af618d0` (test): 41 tests, 26 failed on assertions, 15 passed (stub already satisfied the plain-prose, determinism and model-id cases)
   - GREEN `3d7f638` (feat): 41 tests pass
3. **Task 3: identify stage resolves the type and profile**
   - RED `f7cf180` (test): 60 tests, 7 failed on assertions, 53 passed (including the picked-type case, which already worked)
   - GREEN `6a19db5` (feat): 60 tests pass

**Plan metadata:** the SUMMARY commit follows this file (docs).

## RED evidence

The plan is `type: execute` with task-level `tdd="true"`, and `workflow.tdd_mode` is off in this project, so `gsd_run check tdd-red-evidence` was not run (it rejects vitest's TAP output for the same reason noted in 03-13b). RED was assessed by hand from the vitest and node:test output at each RED commit. The two new modules existed only as neutral stubs (`resolveDocType` returning general/fallback, `detectDocType` returning general/0, `detectDocTypeWithLlm` returning unavailable), so every failing test failed on an `AssertionError` for the planned behaviour, never on a module-not-found or syntax fault. The DB tests start every case with an explicit schema assertion so they fail on an assertion and not on "function does not exist".

## Files Created/Modified

- `supabase/migrations/0312_doc_type_defaults.sql` - table, tenant-key helper and the three service-role functions
- `src/lib/rag/ingest/profiles/resolve-doc-type.ts` - resolveDocType, refineDocTypeAfterParse, getDocTypeDefaults, setDocTypeDefault, deleteDocTypeDefault, DocTypeDefaultsError
- `src/lib/rag/ingest/profiles/detect-doc-type.ts` - DOC_TYPE_CONFIDENCE_FLOOR, detectDocType and the keyword data
- `src/lib/rag/ingest/profiles/llm-detect.ts` - detectDocTypeWithLlm, DOC_TYPE_LLM_MODEL_ID, setLlmDetectForTests
- `src/lib/rag/ingest/stages/identify.ts` - resolves the type through resolveDocType
- `src/lib/rag/ingest/stages/enrich.ts` - stores the final type and detection (13 lines)
- `src/lib/rag/ingest/types.ts` - `IngestInput.docType` accepts `'auto'`, `IngestOptions` names `nangoConnectionId` and `nangoFolderId`, the state slice may carry the detection
- Tests: `tests/rag/ingest/resolve-doc-type.test.ts` (60), `tests/rag/ingest/detect-doc-type.test.ts` (41), `tests/rag-db/doc-type-defaults.test.mts` (17: 8 single-tenant, 9 multi-tenant), `tests/fixtures/ingest/llm-detect-recorded.json`

## Decisions Made

See `key-decisions` above. The ones later plans depend on:

- **Plan 03-39 (admin routes):** gate `setDocTypeDefault` and `deleteDocTypeDefault` with `checkAdmin` / `requireRagAdmin` before calling them, pass the guard's `userId` as `updatedBy`, and pass `{ db: getIngestDeps().db, signal }` as deps (the functions take explicit deps; there is no default). Validate a user-supplied `source` against the ingest source list before building a selector.
- **Plan 03-27 (parse stage):** call `refineDocTypeAfterParse(ctx, { text, textLayerPageShare })` with the real `StageContext`; when `parserOptionsDiffer` is true, re-parse once and set `ctx.state.docTypeDetection.reparsed = true`. The new type is already on `ctx.identity`; enrich persists it.
- **Plans 03-31/32/33 (callers):** pass the user's pick as `docType` (a `DocType` or `'auto'`); Nango sync passes `options.nangoConnectionId` and `options.nangoFolderId`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The detection is persisted by enrich.ts, not identify.ts**
- **Found during:** Task 3
- **Issue:** The plan says to store the detection with `writer.setFields` from identify, but the document row does not exist until `file_hash_dedup` calls `begin`. The only other stage that could write it is `dedup.ts`, which parallel plan 03-16 owns and is rewriting.
- **Fix:** `enrich` (after parse and any refinement, before chunks are written) writes `doc_type`, `doc_type_origin`, the profile id and version and `metadata.doc_type_detection` in one `setFields` call when a detection exists. This also stores a refined type, which an identify-time write could not.
- **Files modified:** `src/lib/rag/ingest/stages/enrich.ts` (outside the plan's file list)
- **Verification:** `tests/rag/ingest/resolve-doc-type.test.ts#identify resolves the type and the profile` (the end-to-end ingest case and the direct enrich case)
- **Committed in:** `6a19db5`

**2. [Rule 3 - Blocking] types.ts edited, outside the plan's file list**
- **Found during:** Tasks 1 and 3
- **Issue:** `IngestInput.docType` had no way to carry `'auto'`, `IngestOptions` had no named Nango ids, and the state slice had no place for the detection that refinement and enrich need.
- **Fix:** additive changes only: `docType?: DocType | 'auto'`, two optional string keys on `IngestOptions`, and an optional `detection` on `state.docTypeDetection`.
- **Verification:** `tsc` clean; the existing ingest unit and DB suites pass unchanged.
- **Committed in:** `bdd27f8` (state slice), `6a19db5` (docType and options)

**3. [Interpretation] Dependencies are an explicit parameter**
- The plan names `resolveDocType(scope, input, deps)`. I made `deps` required on every exported function (no default built from `getIngestDeps()`), so the module does not pull `@/lib/env` and Supabase at import time (the `.mts` DB test imports it without env). Callers pass `{ db, config, signal }`.

**4. [Interpretation] The LLM step is wired in the resolver, not in detectDocType**
- The plan's `detectDocType` is deterministic and synchronous, so the classifier call sits in `runDetection` inside `resolve-doc-type.ts`, shared by `resolveDocType` and `refineDocTypeAfterParse`. Tests for the classifier live in `detect-doc-type.test.ts` as planned and go through those two entry points.

**5. [Rule 2 - Missing Critical] Defence in depth on tenant isolation**
- Beyond the planned `tenant_key` filter: SQL validates the tenant key shape and mode, and the TypeScript layer drops (and logs) any returned row whose `tenant_key` differs from the caller's.

---

**Total deviations:** 5 (2 blocking edits outside the file list, 2 interpretation notes, 1 missing-critical hardening)
**Impact on plan:** no scope creep; every must_haves truth holds.

## Issues Encountered

- The first full `node --import tsx --test tests/*.test.mts` run had one failure, `tests/rag-langfuse-export.test.mts` ("waitFor timed out" in the export-after-response case), while other agents were running their own gates on the same machine. The file passes alone (8 of 8), and the whole suite passed on the rerun (143 of 143). I did not touch Langfuse code.
- Task 1's GREEN commit needed the stubbed `detect-doc-type.ts` from the RED commit; the three "auto" unit tests of Task 1 therefore use a canned detection (a `vi.mock` that falls through to the real detector when none is set), and the real detector is exercised from Task 2 on and in the Task 3 ingest tests.

## Gate Results (worktree /home/user/wt/03-22, branch exec/03-22)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 126 files, 1703 tests passed, 0 failed |
| `node --import tsx --test tests/*.test.mts` | 143 passed, 0 failed (one load-induced timeout in rag-langfuse-export on the first run, passed on the rerun and alone) |
| `node --import tsx --test tests/rag-db/*.test.mts` | 177 tests: 174 passed, 0 failed, 3 skipped (the single-tenant variants skipped by design in earlier plans) |
| `node --import tsx --test tests/rag-db/doc-type-defaults.test.mts` | 17 passed (8 single-tenant, 9 multi-tenant) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 692 files, no violations (no doc-type comparison outside `profiles/`) |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables match the manifest (no new variable) |
| rag-sidecar pytest | not run, sidecar untouched |
| `tests/rag/langfuse-pins.test.ts` | passed here, no ENOENT |
| `tests/rag-db/schema-migrations.test.mts`, `schema-equality.test.mts`, `embedding-profiles.test.mts` | pass unchanged (no edit to the shared migration test was needed) |

Plan acceptance greps: `rag_doc_type_defaults` in the migration 11 (EXPECT >=2); `DOC_TYPE_CONFIDENCE_FLOOR = 0.6` 1 (EXPECT ==1); `DocTypeDetectionSchema` in llm-detect.ts 3 (EXPECT >=1); `resolveDocType` in identify.ts 2 (EXPECT >=1); resolve-doc-type tests 60 passed (EXPECT >=8); detect-doc-type tests 41 passed (EXPECT >=9). No model identifier appears in comments or commit messages; the single model id is the `DOC_TYPE_LLM_MODEL_ID` constant the plan requires.

## Threat Surface

T-03-62 (cross-tenant defaults): every function filters by the tenant key of the minted scope; two-tenant tests prove B never sees or inherits A's tenant, source, connection or folder rows, and that B setting the same folder ref does not change A. T-03-63 (table exposure): RLS on with no policies, `REVOKE ALL` from PUBLIC, anon and authenticated, functions granted to service_role only, tested in both modes with real role switches. T-03-64 (LLM output): zod validation from the generated contract, fallback to rules on any invalid or failed answer, off by default, signals sanitised, text bounded. T-03-SC: no package changes.

## Known Stubs

None. The RED-phase stubs were replaced by the real implementations. `refineDocTypeAfterParse` has no caller until plan 03-27 wires it into the parse stage (a planned hand-off, not a stub).

## User Setup Required

None for configuration: no new environment variable (the config sync rule has nothing to mirror; `RAG_DOC_TYPE_LLM_DETECT` was added by 03-03). One operator action: apply migration `supabase/migrations/0312_doc_type_defaults.sql` (listed automatically by `scripts/setup-database.sh --list-migrations`). Until it is applied the unified pipeline logs `[Ingest] doc type defaults unavailable` and resolves untyped documents to general.

## Next Phase Readiness

- 03-27 can call `refineDocTypeAfterParse` and 03-39 can wrap `getDocTypeDefaults`, `setDocTypeDefault` and `deleteDocTypeDefault`.
- No blockers. No package was installed or locked.

## Self-Check: PASSED

All created files exist on disk. Commits `c735a68`, `bdd27f8`, `af618d0`, `3d7f638`, `f7cf180` and `6a19db5` are ancestors of HEAD; the measured commit count from the ledger is 6.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
