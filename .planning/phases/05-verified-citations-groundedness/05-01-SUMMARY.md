---
phase: 05-verified-citations-groundedness
plan: 01
subsystem: contracts
tags: [pydantic, zod, contracts, citations, groundedness, feedback]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: last edits to export_schemas.py, samples.py and the generated files (04-04, 04-26)
  - phase: 01-evaluation-harness-baseline
    provides: npm run gen:schemas pipeline and contract parity tests
provides:
  - CitationRecord (D-01, camelCase, strategy enum, alias/quoteHash patterns)
  - AnswerGroundedness, AnswerFeedback, AnswerFeedbackRequest, AnswerRecord (D-15, D-18)
  - GroundednessRequest, GroundednessResult, GroundednessThresholdCell, GroundednessThresholds (D-11, D-13)
  - Generated Zod schemas CitationRecordSchema, AnswerRecordSchema, AnswerFeedbackRequestSchema, GroundednessRequestSchema, GroundednessResultSchema, GroundednessThresholdsSchema
  - eval/config/groundedness-thresholds.json (vendor 0.5 default, three cells)
affects: [05-03, 05-06, 05-07, 05-08, 05-09, 05-12, 05-14, 05-18, 05-19, 05-21, 05-22, 05-23]

actuals:
  tokens: 17800
  tasks: 2
  commits: 4
plan_head_before: 21f611b
plan_head_after: b4ec9c9

tech-stack:
  added: []
  patterns:
    - "Status-dependent field rules live in Pydantic model validators; Zod gets the field-level constraints only"
    - "Reason codes are a snake_case pattern (^[a-z][a-z0-9_]{0,63}$), not an enum, so later plans can add codes without a contract change"
    - "Unique reason chips are enforced in Pydantic (field validator) and in Zod (uniqueItems via json_schema_extra)"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/answers.py
    - rag-sidecar/src/rag_sidecar/contracts/groundedness.py
    - rag-sidecar/tests/test_answer_contracts.py
    - rag-sidecar/schemas/CitationRecord.schema.json
    - rag-sidecar/schemas/AnswerRecord.schema.json
    - rag-sidecar/schemas/AnswerFeedbackRequest.schema.json
    - rag-sidecar/schemas/GroundednessRequest.schema.json
    - rag-sidecar/schemas/GroundednessResult.schema.json
    - rag-sidecar/schemas/GroundednessThresholds.schema.json
    - eval/config/groundedness-thresholds.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "AnswerGroundedness scored rows must carry the label that score >= threshold implies (D-13); a mismatched label is rejected"
  - "Pending AnswerGroundedness carries no scorer as well as no score and no label"
  - "GroundednessThresholdCell.scorer excludes none (only scorers that produce a score have thresholds); language is a free non-empty string to match GroundednessRequest"
  - "answerId and chatId are UUID typed (Zod z.string().uuid()); traceId stays a non-empty string"
  - "Samples use placeholder UUIDs and invented leave-policy text; three variants added (AnswerRecord pending/unlinked, GroundednessResult not_checked, AnswerFeedbackRequest vote only)"

requirements-completed: [GEN-02, GEN-03, GEN-04, GEN-05, EVAL-16]

coverage:
  - id: D1
    description: "Phase 5 Pydantic contracts with the locked D-01 and D-11 field names and per-status validation"
    requirement: GEN-02
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_answer_contracts.py"
        status: pass
  - id: D2
    description: "Generated Zod schemas and samples, parity with Pydantic"
    requirement: GEN-03
    verification:
      - kind: unit
        ref: "tests/contracts.test.ts, tests/schema-parity.test.ts, rag-sidecar/tests/test_contract_export.py"
        status: pass
  - id: D3
    description: "Default groundedness thresholds file validates against GroundednessThresholds"
    requirement: GEN-05
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_answer_contracts.py#test_committed_thresholds_file_holds_the_vendor_default_for_every_scorable_cell"
        status: pass
---

# Phase 5 Plan 01: Answer and groundedness contracts Summary

Every new Phase 5 shape (citation record, answer record, feedback request, groundedness wire contract and thresholds) is now one Pydantic v2 model with generated Zod, plus the default thresholds file.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | d78ca43 | test(05-01): add failing tests for answer and groundedness contracts |
| 1 GREEN | 2daa694 | feat(05-01): answer and groundedness contract models |
| 2 | b4ec9c9 | feat(05-01): register Phase 5 contracts, regenerate Zod, default groundedness thresholds |

The RED commit shipped permissive stub classes (extra="allow") so the 64 failing cases failed on assertions, not on import.

## Tests

- `uv run --directory rag-sidecar pytest -q tests/test_answer_contracts.py`: 67 passed, 0 failed (acceptance needs at least 20).
- Before the fix (RED): 64 failed, 2 passed.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 222 files, 3382 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 163 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 794 pass, 0 fail |
| check-rag-boundary + node test | exit 0; 38 pass |
| `node scripts/check-config.mjs` | exit 0 |
| check-workflows.py | OK |
| rag-sidecar pytest | 898 passed, 10 skipped |
| eval pytest | 523 passed, 3 failed (pre-existing, see below) |
| `npm run gen:schemas` after commit | no diff |
| test-rag | not run: no retrieval, ingest or golden-set change |

Pre-existing failures: `eval/tests/test_parse_fixtures.py` (`test_recorded_outputs_exist_for_every_page_and_preset`, `test_recorded_vlm_verdicts_validate`, `test_recorded_premium_markdown_for_invoice_and_scanned`). They fail identically on trunk `claude/ecstatic-hamilton-86gtwv` (checked in a worktree: 3 failed, 5 passed). The regenerated PDFs hash differently in this container, so the recorded paths are missing. Fixtures were restored with `git checkout -- eval/fixtures/parse/`.

## Deviations

- Reason codes (`AnswerGroundedness.reason`, `GroundednessResult.reason`) are a snake_case pattern, not a closed enum. The plan says "short code such as …", and later plans use codes not in that list (for example `reasoning_unsupported`, `refusal`).
- Added `uniqueItems` to the feedback `reasons` JSON Schema so the generated Zod also rejects repeated chips; without it only Pydantic would.
- The generated Zod cannot express the model validators (status rules, threshold-cell uniqueness, label-from-score rule). App code that builds these values (05-14, 05-18) must construct them correctly or check them itself; the Zod schemas enforce field types, enums, ranges and patterns only.

## Notes for later plans

- 05-07 aliases `TraceCitation` to `CitationRecord`; this plan did not touch `eval_run.py`.
- `AnswerRecord` has no review-reasons field; `review_reasons` stays server-side.

## Self-Check: PASSED
