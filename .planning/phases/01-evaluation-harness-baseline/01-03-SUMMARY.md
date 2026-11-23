---
phase: 01-evaluation-harness-baseline
plan: 03
subsystem: testing
tags: [pydantic, zod, golden-set, json-schema, contracts]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-01 contract path (CONTRACTS registry, gen-zod, ConversationTurn)"
provides:
  - "GoldSpan and GoldenItem Pydantic contracts with the D-04 shape and answerability rules"
  - "GoldenSplitManifest pinning the D-14 split rule literal"
  - "DraftedItemProposal and DraftedItemBatch, the drafting LLM structured output"
  - "Generated GoldenItemSchema, GoldenSplitManifestSchema, DraftedItemBatchSchema in contracts.generated.ts"
affects: [01-04, 01-06, 01-13, 01-15, 01-19, 01-21]

plan_head_before: faeb6752939b3a35327c0ffdac39970347214f43
plan_head_after: 30d68839bc7fbd93fa46e8360a9b98778cb5df09

actuals:
  tokens: 4930
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Golden-set rules live in a Pydantic model validator; Zod inherits structure (additionalProperties false) but not cross-field rules"
    - "TDD RED uses a shape-only skeleton so tests fail on assertions instead of import errors"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/golden.py
    - rag-sidecar/tests/test_golden_contract.py
    - rag-sidecar/schemas/GoldenItem.schema.json
    - rag-sidecar/schemas/GoldenSplitManifest.schema.json
    - rag-sidecar/schemas/DraftedItemBatch.schema.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - src/lib/rag-eval/contracts.generated.ts

key-decisions:
  - "Cross-field golden rules (answerability, spans, multi_turn conversation, duplicate spans) are enforced only in Pydantic; the generated Zod enforces structure, enums, id pattern, quote min length and rejects chunk_id keys"
  - "DraftedItemProposal omits provenance as well as id, review_status and split, since the drafting tool assigns all four"

patterns-established:
  - "Golden contracts import ConversationTurn from eval_run rather than redefining it"

requirements-completed: [EVAL-03, EVAL-02]

coverage:
  - id: D1
    description: "GoldenItem carries exactly the D-04 fields and is generated into GoldenItemSchema; a chunk_id key is rejected in Python and TypeScript"
    requirement: EVAL-03
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_golden_contract.py (46 passed)"
        status: pass
      - kind: integration
        ref: "Task 2 verify node check: valid item accepted, chunk_id on item and on span rejected by GoldenItemSchema"
        status: pass
    human_judgment: false
  - id: D2
    description: "GoldenItem rejects bad enums, answerability contradictions, missing spans or answer, span-bearing no_answer, empty multi_turn conversation, short quote, duplicate spans and malformed ids"
    requirement: EVAL-03
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_golden_contract.py"
        status: pass
    human_judgment: false
  - id: D3
    description: "GoldenSplitManifest pins the D-14 rule and dev/test values; DraftedItemBatch carries no id, review_status or split"
    requirement: EVAL-02
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_golden_contract.py (split manifest and drafted proposal cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Regeneration after commit leaves schemas and contracts.generated.ts unchanged"
    requirement: EVAL-02
    verification:
      - kind: other
        ref: "npm run gen:schemas followed by git status --short (clean)"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 03: Golden Set Contracts Summary

**Pydantic `GoldenItem`, `GoldenSplitManifest` and `DraftedItemBatch` with answerability and span rules enforced in the model, generated into strict Zod (never chunk IDs)**

## Performance

- **Duration:** 6 min
- **Tasks:** 2
- **Files modified:** 8 (5 created, 3 modified)

## Accomplishments
- `GoldenItem` enforces the D-04 field set with explicit Literals, id pattern `^[a-z0-9][a-z0-9._-]{2,63}$`, and a model validator: `no_answer` iff not answerable, answerable needs spans and a non-blank expected answer, `no_answer` has no spans, `multi_turn` needs a conversation, duplicate spans rejected. `GoldSpan.quote` needs at least 2 characters.
- `GoldenSplitManifest` records the D-14 rule literal `sha256-first8hex-mod100-lt70-dev` and per-id `dev`/`test` assignments.
- `DraftedItemBatch` wraps `DraftedItemProposal` (no id, review status, provenance or split).
- Three contracts registered in `CONTRACTS` (serialization mode); `npm run gen:schemas` produced three schema files and three Zod schemas, and the generated `GoldenItemSchema` rejects `chunk_id` on the item and on a span.

## Task Commits

1. **Task 1: GoldSpan and GoldenItem** (TDD)
   - RED - `e145e5d` (test)
   - GREEN - `a96690f` (feat)
2. **Task 2: Split manifest, drafted items, registry, Zod** (TDD)
   - RED - `a88372e` (test)
   - GREEN - `30d6883` (feat)

## TDD Evidence

- **Task 1 RED:** `pytest tests/test_golden_contract.py` with a shape-only skeleton: 23 failed, 10 passed. Failures were all "DID NOT RAISE ValidationError" on the planned rules (chunk ids, enums, answerability, spans, ids); no import or syntax faults. A first attempt failed at collection with an ImportError, which was treated as an invalid RED and replaced by the skeleton. **GREEN:** 33 passed.
- **Task 2 RED:** 8 failed, 38 passed, all assertion failures (rule literal, split value, unknown key, assigned fields, registration KeyError). **GREEN:** 46 passed.
- Gate order: `test(01-03)` precedes `feat(01-03)` for both tasks.

## Files Created/Modified
- `rag-sidecar/src/rag_sidecar/contracts/golden.py` - five golden contracts
- `rag-sidecar/src/rag_sidecar/contracts/__init__.py` - re-exports
- `rag-sidecar/src/rag_sidecar/export_schemas.py` - three new `CONTRACTS` entries
- `rag-sidecar/schemas/{GoldenItem,GoldenSplitManifest,DraftedItemBatch}.schema.json` - generated
- `src/lib/rag-eval/contracts.generated.ts` - regenerated (7 schemas), never hand-edited
- `rag-sidecar/tests/test_golden_contract.py` - 46 cases

## Decisions Made
- Cross-field golden rules exist only in Pydantic. JSON Schema cannot express them, so the generated Zod does not enforce answerability or span-count rules. Consumers that need those rules on the TypeScript side (eval core, plan 01-06) must not assume `GoldenItemSchema.parse` implies them; items should be validated through the sidecar or re-checked.
- `DraftedItemProposal` also omits `provenance` (the plan lists id, review_status and split); the drafting tool assigns it, and a proposal carrying it is rejected as an unknown key.

## Deviations from Plan

None - plan executed exactly as written. The shape-only skeleton in the RED commits is a TDD mechanic (valid RED), not a scope change.

## Issues Encountered
None.

## Known Stubs
None.

## User Setup Required
None.

## Next Phase Readiness
- Plan 01-04 can validate golden lines with `GoldenItemSchema`; 01-06, 01-13, 01-15 and 01-19 read and write these shapes.
- The TS-side gap on cross-field rules (see Decisions Made) is worth a TS check in the eval core.

## Self-Check: PASSED

All created files exist, the four commits (`e145e5d`, `a96690f`, `a88372e`, `30d6883`) are ancestors of HEAD, `npm run gen:schemas` leaves a clean tree, and the full sidecar suite passes (46 passed).

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
