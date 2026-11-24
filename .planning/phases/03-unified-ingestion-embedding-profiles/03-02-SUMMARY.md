---
phase: 03-unified-ingestion-embedding-profiles
plan: 02
subsystem: ingestion-contracts
tags: [pydantic, zod, json-schema, processing-profiles, docling, invoice, prompt-injection]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: Pydantic to JSON Schema to Zod contract pipeline (export_schemas.py, gen-zod.mjs, schema parity tests)
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: Phase 2 closed (02-36 summary present), generated contracts and samples at HEAD
provides:
  - Pydantic v2 contracts for ProcessingProfile(Set), DocTypeDetection, InjectionRuleSet, ParseJobRequest/Accepted/State, ParseResult, InvoiceExtractRequest, InvoiceFields
  - Nine exported JSON Schemas and their generated Zod twins (no hand-written Zod)
  - config/rag/processing-profiles.json with one profile per D-12 type (D-14 starting values, D-25 clause patterns as data)
  - src/lib/rag/ingest/profiles/load.ts (validated, memoised lookup; clause patterns compiled once)
affects: [03-04, 03-12, 03-13, 03-14, 03-19, 03-20, 03-22, 03-29, 03-31, 03-41]

actuals:
  tokens: 30763
  tasks: 3
  commits: 6
plan_head_before: ccfcd7e0e02d332cc60a779fc7a84197888bf557
plan_head_after: 8b2132c508ee49aab96c29deedf316af96641bc8

tech-stack:
  added: []
  patterns:
    - "Rules JSON Schema cannot express (one profile per type, id = doc_type@version, overlap < max_tokens, tier order, backreference ban, unique ids) live in Pydantic validators and are mirrored by hand in load.ts"
    - "Decimal money as strings with pattern ^-?\\d+(\\.\\d{1,4})?$ so Python and TypeScript agree without float rounding"
    - "Path-safe identifiers (job_id, artifact names, image_ref) enforced by schema pattern on both sides"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/ingest.py
    - rag-sidecar/tests/test_ingest_contracts.py
    - rag-sidecar/tests/test_processing_profiles_file.py
    - tests/ingest-contracts.test.ts
    - tests/rag/ingest/profiles.test.ts
    - config/rag/processing-profiles.json
    - src/lib/rag/ingest/profiles/load.ts
    - rag-sidecar/schemas/ProcessingProfileSet.schema.json
    - rag-sidecar/schemas/DocTypeDetection.schema.json
    - rag-sidecar/schemas/InjectionRuleSet.schema.json
    - rag-sidecar/schemas/ParseJobRequest.schema.json
    - rag-sidecar/schemas/ParseJobAccepted.schema.json
    - rag-sidecar/schemas/ParseJobState.schema.json
    - rag-sidecar/schemas/ParseResult.schema.json
    - rag-sidecar/schemas/InvoiceExtractRequest.schema.json
    - rag-sidecar/schemas/InvoiceFields.schema.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "ProcessingProfile id must equal <doc_type>@<version> (pattern plus validator); load.ts repeats the check"
  - "ParentChild reserved shape is {parent_max_tokens, child_max_tokens} with child < parent; unused until CHK-04"
  - "min_chunk_tokens (not in D-14) set to 32, and 0 for invoice so a small receipt header is never merged; overlap 0 for contract_legal and invoice_receipt, 64 elsewhere"
  - "Docling picture generation off for contract_legal and invoice_receipt (stamps and logos add caption noise); table_mode accurate for financial_report and invoice_receipt, fast elsewhere"
  - "ParseJobState enforces result present iff succeeded and error_class present iff failed"
  - "Nested-quantifier rejection for regex injection rules is left to the TypeScript matcher/loader (Pattern 11); Pydantic enforces length cap 200 and back-reference ban only, as the plan states"

patterns-established:
  - "New wire contracts: Pydantic first, register in CONTRACTS with validation (requests) or serialization (responses), add a synthetic sample, run npm run gen:schemas"
  - "TDD RED for a contract task uses a permissive skeleton (loose types, no constraints) so every RED failure is an assertion, never an import error"

requirements-completed: [DATA-03, DATA-04, DATA-05, DATA-09, SEC-01, CHK-02]

coverage:
  - id: D1
    description: "Profile, doc-type detection and injection-rule contracts exist once in Pydantic with generated Zod twins"
    requirement: "DATA-03"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_ingest_contracts.py (profile, set, injection rule, detection cases)"
        status: pass
      - kind: unit
        ref: "tests/contracts.test.ts and tests/schema-parity.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Parse job and invoice extraction wire contracts exist on both sides, reject unknown keys and unsafe identifiers"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_ingest_contracts.py (parse job, ParseResult, InvoiceFields cases)"
        status: pass
      - kind: unit
        ref: "tests/ingest-contracts.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Six processing profiles as data, validated by Pydantic and the generated Zod schema, loaded once per process"
    requirement: "DATA-04"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_processing_profiles_file.py"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/profiles.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-14 starting values and D-25 clause patterns suit real documents (chunk sizes, OCR and table options)"
    requirement: "CHK-02"
    verification: []
    human_judgment: true
    rationale: "Values are starting points the later chunker, Docling and ingest-mode eval plans tune against real documents; no test can judge suitability"

duration: 14min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 02: Ingest Contracts and Processing Profiles Summary

**Pydantic v2 contracts with generated Zod for profiles, doc-type detection, injection rules, parse jobs and invoice extraction, plus six processing profiles as validated data and a memoised loader**

## Performance

- **Duration:** 14 min
- **Started:** 2026-11-24T00:27:13Z
- **Completed:** 2026-11-24T00:41:25Z
- **Tasks:** 3 (each RED then GREEN)
- **Files modified:** 21 (11 generated by `npm run gen:schemas`, 10 authored)

## Accomplishments

- Nine contracts in `rag-sidecar/src/rag_sidecar/contracts/ingest.py` (plus nested models), exported as JSON Schema and turned into Zod by `scripts/gen-zod.mjs`; `npm run gen:schemas` reproduces the committed files byte for byte.
- `ParseResult` carries markdown, chunks (text, contextualized_text, headings, pages, is_table, table_header), pictures (page, bbox, image_ref, page_area_share), page_count, language, parser, parser_version, warnings, partial, artifacts and optional text_layer_page_share (F-4).
- `config/rag/processing-profiles.json` holds exactly one profile per D-12 type with D-14 values, the six D-25 clause patterns and zh/en/it lead-in phrases, the invoice header template and explicit null reserved fields (`min_tier`, `max_tier`, `parent_child`).
- `load.ts` validates with `ProcessingProfileSetSchema`, repeats the Pydantic-only rules, compiles clause patterns once with the `u` flag and exposes `loadProcessingProfiles`, `getProcessingProfile`, `getClausePatterns`.

## Task Commits

1. **Task 1: Profile, doc-type detection and injection-rule contracts** - `3ebd66b` (test, RED), `7acf374` (feat)
2. **Task 2: Parse job and invoice contracts** - `d6ce65e` (test, RED), `ff9b319` (feat)
3. **Task 3: Processing profiles as data and the validating loader** - `a4c4b2d` (test, RED), `8b2132c` (feat)

**Plan metadata:** the commit that adds this file (docs).

## RED evidence (semantic assessment)

The plan is `type: execute` with `tdd="true"` tasks and `workflow.tdd_mode` is unset, so the `tdd-red-evidence` classifier was not run. Each RED run was inspected by hand:

- **Task 1:** 48 failed, 18 passed. 46 failures were `DID NOT RAISE ValidationError` for the planned constraints, 2 were assertions on missing export registration and the missing `maxLength` in the exported schema. No import or syntax errors. The skeleton models had the field names with loose types and no constraints.
- **Task 2:** Python 45 failed, 91 passed (43 `DID NOT RAISE`, registration assertions). Vitest 15 of 18 failed with `AssertionError: generated schema for X: expected undefined to be defined`.
- **Task 3:** Python 10 failed, 2 passed (value and normal-form assertions against placeholder data). Vitest 17 of 19 failed (value assertions, `toThrow` not thrown, parse spy called 0 times). Placeholder data was six generic profiles so no failure came from a missing file.

## Files Created/Modified

- `rag-sidecar/src/rag_sidecar/contracts/ingest.py` - all ingest wire and data contracts
- `rag-sidecar/src/rag_sidecar/contracts/{__init__,samples}.py`, `export_schemas.py` - exports, synthetic samples (Partita IVA 99999999990, USCC 91000000MA0000000N), CONTRACTS registration
- `rag-sidecar/schemas/*.schema.json` (9 new), `src/lib/rag-eval/contracts.generated.ts`, `tests/fixtures/contracts/samples.json` - generated
- `config/rag/processing-profiles.json` - six profiles
- `src/lib/rag/ingest/profiles/load.ts` - loader
- `rag-sidecar/tests/test_ingest_contracts.py` (136 cases), `rag-sidecar/tests/test_processing_profiles_file.py` (12), `tests/ingest-contracts.test.ts` (18), `tests/rag/ingest/profiles.test.ts` (19)

## Decisions Made

See `key-decisions` above. The ones later plans must honour: profile id equals `<doc_type>@<version>`; `ParentChild` shape; the 32 and 0 `min_chunk_tokens` values and the overlap values; picture generation and table mode per type; `ParseJobState` outcome invariants; the TS injection-rule loader (03-20) must add the nested-quantifier check itself.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Bounds and path-safety added beyond the listed behaviours**
- **Found during:** Task 2 (T-03-05 tampering mitigation)
- **Issue:** The plan lists field names but not size or path limits; unbounded markdown and tables on a sidecar request body, and free-form `job_id`, artifact names and `image_ref` used as path segments by the artifacts route, would weaken the T-03-05 mitigation.
- **Fix:** `job_id` matches `^[A-Za-z0-9_-]{1,64}$`; artifact names and `image_ref` match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; `InvoiceExtractRequest.markdown` max 2,000,000 chars, at most 500 tables of at most 500,000 chars; `error_class` is a lower-snake token; `table_header` only on table chunks.
- **Files modified:** rag-sidecar/src/rag_sidecar/contracts/ingest.py
- **Verification:** reject cases in test_ingest_contracts.py and tests/ingest-contracts.test.ts
- **Committed in:** ff9b319

**2. [Rule 2 - Missing Critical] Loader repeats the Pydantic-only rules**
- **Found during:** Task 3
- **Issue:** The generated Zod schema cannot express one profile per type, id consistency, overlap < max_tokens or tier order, so `ProcessingProfileSetSchema.parse` alone would accept a set Pydantic rejects.
- **Fix:** `parseProcessingProfileSet` in load.ts applies the same checks and compiles clause patterns (T-03-06: compiled once at load).
- **Files modified:** src/lib/rag/ingest/profiles/load.ts
- **Verification:** ten rejection cases in tests/rag/ingest/profiles.test.ts
- **Committed in:** 8b2132c

---

**Total deviations:** 2 auto-fixed (2 missing critical)
**Impact on plan:** Both strengthen the stated T-03-05 and T-03-06 mitigations. No scope creep.

## Issues Encountered

- One of the 136 `node --test tests/*.test.mts` cases failed on the first run (a PGlite-based suite logged `Enhanced RAG ... code XX000`); two consecutive reruns passed 136 of 136 with no change in between. Not related to this plan's files; noted for the orchestrator to watch.
- The commit guard's per-agent branch allow-list (`agent-*`) does not match the orchestrator-assigned branch `exec/03-02`. The brief names that branch explicitly, HEAD was not on a protected branch, so commits proceeded there.

## Gate results (worktree)

`npx next typegen && npx tsc --noEmit -p tsconfig.json` 0 errors; `npx vitest run` 110 files, 1388 tests passed (including tests/rag/langfuse-pins.test.ts); `node --import tsx --test tests/*.test.mts` 136 passed (see Issues Encountered); `node scripts/ci/check-rag-boundary.mjs` ok; `python3 scripts/ci/check-workflows.py` ok; `node scripts/check-config.mjs` ok; sidecar `uv run --frozen pytest -q` 337 passed; `npm run typecheck:new` clean; `npm run gen:schemas` leaves the tree clean.

## Known Stubs

None. No env variables, packages or lockfiles were touched.

## Threat Flags

None. The plan adds contracts and a read-only data loader; no endpoint, auth path or schema change.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Wave-1 dependants can import `ProcessingProfileSetSchema`, `ParseResultSchema`, `InvoiceFieldsSchema`, `InjectionRuleSetSchema`, `DocTypeDetectionSchema` from `@/lib/rag-eval/contracts.generated` and `getProcessingProfile` from `@/lib/rag/ingest/profiles/load`.
- `config/rag/injection-rules.json` does not exist yet; its owner (03-20) validates it with `InjectionRuleSetSchema` and must add the nested-quantifier rejection in TypeScript.

## Self-Check: PASSED

All 16 created files and 5 modified files exist; commits 3ebd66b, 7acf374, d6ce65e, ff9b319, a4c4b2d, 8b2132c are ancestors of HEAD; every acceptance criterion re-ran green (class ProcessingProfile 2, ProcessingProfileSetSchema in generated 2, ParseResult/InvoiceFields/ParseJobState schemas 6, load.ts schema reference 4, six profiles, test counts 136 / 18 / 19).

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
