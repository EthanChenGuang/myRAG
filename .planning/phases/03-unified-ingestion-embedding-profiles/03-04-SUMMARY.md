---
phase: 03-unified-ingestion-embedding-profiles
plan: 04
subsystem: infra
tags: [ci, boundary-check, node-test, single-writer, doc-type-lint]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: scripts/ci/check-rag-boundary.mjs with an appendable RULES array, ALLOWLIST and checkBoundary (plan 02-20)
provides:
  - chunk-writer, document-insert, writer-rpc and doc-type-branching rules in the boundary check
  - exported LEGACY_WRITERS allow-list (three entries, each with removedBy) and legacyWriterProblems validator
  - 12 new self-test cases (30 in total) including a stale-entry guard
affects: [03-10, 03-13, 03-31, 03-23, 03-24, 03-32, 03-33 (any plan that touches a legacy writer or adds ingest code), Phase 7 release defaults]

status: complete
actuals:
  tokens: 6000
  tasks: 2
  commits: 2
plan_head_before: ccfcd7e0e02d332cc60a779fc7a84197888bf557
plan_head_after: 4a83df97f63738fabf18981a8f9447228fba6021

tech-stack:
  added: []
  patterns:
    - "Writer rules exempt src/lib/rag/ingest/ by path and a per-path, per-rule LEGACY_WRITERS list; the scanner is untouched"
    - "Allow-list entries are validated by legacyWriterProblems and must still exempt a real violation (stale entries fail the self-test)"

key-files:
  created: []
  modified:
    - scripts/ci/check-rag-boundary.mjs
    - scripts/tests/check-rag-boundary.node-test.mjs

key-decisions:
  - "LEGACY_WRITERS lists exactly the three files that write the tables directly today (process-document route, ai-to-rag route, supabase.ts storeDocument), each removedBy 'Phase 7 release defaults (RAG_INGEST_PIPELINE removal)'"
  - "document-insert also blocks .upsert( on documents, because an upsert can create a row and would bypass the single writer"
  - "The mint-scope rule is unchanged (F-13); two fixtures pin that ingest code may import scopeKey and assertTenantScope but not mintScope"
  - "Exemptions are keyed by path and rule id, so a legacy file calling a writer RPC or branching on doc type is still flagged"

patterns-established:
  - "New boundary rules are appended to RULES with appliesTo built from the exemption helpers; LEGACY_WRITERS entries are deleted by the plan that removes the writer"

requirements-completed: [DATA-01, DATA-04]

coverage:
  - id: D1
    description: "Chunk writes (insert, update, upsert), document inserts and ingest writer RPC calls outside src/lib/rag/ingest/ fail the boundary check"
    requirement: "DATA-04"
    verification:
      - kind: unit
        ref: "scripts/tests/check-rag-boundary.node-test.mjs#chunk-writer, document-insert, writer-rpc cases"
        status: pass
    human_judgment: false
  - id: D2
    description: "Doc-type comparisons and switches in src/ outside src/lib/rag/ingest/profiles/ fail the check (D-13)"
    requirement: "DATA-01"
    verification:
      - kind: unit
        ref: "scripts/tests/check-rag-boundary.node-test.mjs#doc-type-branching cases"
        status: pass
    human_judgment: false
  - id: D3
    description: "Legacy writers sit in an exported LEGACY_WRITERS list where every entry names its removal owner; the check passes on the real tree"
    requirement: "DATA-04"
    verification:
      - kind: unit
        ref: "scripts/tests/check-rag-boundary.node-test.mjs#LEGACY_WRITERS cases"
        status: pass
      - kind: other
        ref: "node scripts/ci/check-rag-boundary.mjs (620 files, zero violations)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-11-24
---

# Phase 3 Plan 04: Single-Writer and Doc-Type Boundary Rules Summary

**Boundary check extended with chunk-writer, document-insert, writer-rpc and doc-type-branching rules plus an exported LEGACY_WRITERS allow-list, so only src/lib/rag/ingest/ writes chunks and documents and only the profiles module branches on a document type.**

## Performance

- **Duration:** about 20 min
- **Started:** 2026-11-24T00:11:00Z
- **Completed:** 2026-11-24T00:31:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Four rules appended to the exported `RULES` array; the scanner, `stripComments`, `listImports` and the seven Phase 2 rules are untouched.
- `LEGACY_WRITERS` (`{ path, rules, reason, removedBy }`) holds the three real legacy writers. Without it the real tree reports six violations (a document insert and a chunk write in each of those files); with it the tree passes (620 files, zero violations).
- Self-test grew from 18 to 30 cases: one or more fixtures per behaviour in the plan, plus the `legacyWriterProblems` validator, a per-path and per-rule exemption test, and a stale-entry guard.

## TDD Gate Compliance

- **RED (95cedcd):** the new fixtures were committed against the unchanged script. 10 of 30 tests failed on assertions; `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (reason `target_test_failed`, target "chunk-writer: insert, update and upsert on document_chunks fail outside src/lib/rag/ingest"). The two mint-scope fixtures and the doc-type pass-case test passed before the change, as the plan expected, because they pin behaviour that already held or only assert absence of violations. The new exports are read through a namespace import so the missing exports fail on assertions, not on module linking. Semantic assessment: the target ran and failed on the planned `deepEqual` (empty actual list versus three expected `file:rule` pairs); no import, syntax or fixture fault.
- **GREEN (4a83df9):** all 30 tests pass; `node scripts/ci/check-rag-boundary.mjs` exits 0.
- **REFACTOR:** none needed.

## Task Commits

1. **Task 1: Self-test fixtures for the new rules** - `95cedcd` (test)
2. **Task 2: Implement the rules and the legacy-writer allow-list** - `4a83df9` (feat)

**Plan metadata:** the docs commit that adds this file.

## Files Created/Modified

- `scripts/ci/check-rag-boundary.mjs` - four new rules, `WRITER_RPCS`, `LEGACY_WRITERS`, `legacyWriterProblems`
- `scripts/tests/check-rag-boundary.node-test.mjs` - 12 new cases

## Decisions Made

- `LEGACY_WRITERS` entries exempt only the rules they list (`chunk-writer`, `document-insert`), by exact path. A legacy file that calls a writer RPC or compares a doc type is still flagged.
- `document-insert` covers `insert` and `upsert` on `documents`; `update` and `delete` stay allowed (the documents route patches `metadata.external_url`, and deletes stay explicit user actions).
- Chain matching tolerates whitespace, newlines, `as` casts and a generic argument between `.from(` and the call, and ignores matches in comments. It cannot see a table name held in a variable (`const t = 'document_chunks'`), which is a known limit of a text scan.
- The doc-type rule matches `doc_type` and `docType` with `==`, `===`, `!=`, `!==` on either side of the comparison, and `switch (...)`. Assignments, object keys and `.eq('doc_type', ...)` filters are not comparisons and pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] document-insert also blocks `.upsert(` on documents**
- **Found during:** Task 2
- **Issue:** the plan lists only `.insert(` for documents. An upsert can create a document row, so leaving it out would let a writer bypass the single-writer rule.
- **Fix:** the pattern is `insert|upsert`; a fixture pins it. The real tree has no upsert on `documents`, so nothing else changed.
- **Files modified:** scripts/ci/check-rag-boundary.mjs, scripts/tests/check-rag-boundary.node-test.mjs
- **Committed in:** 95cedcd, 4a83df9

**2. [Scope note] document-processor.ts is not in LEGACY_WRITERS**
- **Found during:** Task 2
- **Issue:** the plan names document-processor.ts among the legacy writers "found on the real tree". It has no direct table write; it calls `storeDocument` from `src/lib/supabase.ts`, which is listed.
- **Fix:** no entry. A dormant exemption would widen the allow-list for nothing, and the stale-entry test would reject it. Anything that later writes tables from that file is flagged and must be justified then.

**3. [Addition] Stale-entry guard and validator**
- **Why:** T-03-12 asks that every allow-list entry names its removal owner. `legacyWriterProblems` checks path, rules, reason and `removedBy`, and a test requires each entry to still exempt a real violation, so the plan that removes a legacy writer must delete its entry in the same change.

**4. [Attribution] Commit trailers name the executing model**
- The common brief shows a different model name; the commits use the attribution supplied by the session for the model that ran, as 02-20 did. No model identifiers appear in code or comments.

---

**Total deviations:** 4 (1 Rule 2 addition, 3 documented scope or process notes)
**Impact on plan:** none on behaviour required by the plan; the upsert and stale-entry additions tighten enforcement.

## Issues Encountered

None. No other legacy writer exists on the real tree beyond the three listed. Scripts (`scripts/rag/reprocess-documents.js`) keep their 02-20 allow-list exemption.

## Gate Results (worktree)

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 108 files, 1333 tests passed (tests/rag/langfuse-pins.test.ts did not fail here)
- `node --import tsx --test tests/*.test.mts`: 136 passed
- `node --test scripts/tests/check-rag-boundary.node-test.mjs`: 30 passed
- `node scripts/ci/check-rag-boundary.mjs`: ok, 620 files, no violations
- `python3 scripts/ci/check-workflows.py`: OK
- `node scripts/check-config.mjs`: 79 variables match the manifest
- rag-sidecar untouched, so its pytest was not run

## User Setup Required

None - no external service configuration required.

## Known Stubs

None.

## Threat Flags

None. The change is a read-only CI script and its self-test; no endpoints, auth paths or schema.

## Next Phase Readiness

- 03-10 and 03-13 can add the writer under `src/lib/rag/ingest/`; the rules already exempt it.
- Each plan that routes a write path through `ingest()` keeps its legacy branch listed until Phase 7 release defaults remove it; the removing plan must delete the matching `LEGACY_WRITERS` entry or the stale-entry test fails.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | retrospective / plan predates gate | n/a |
| Impeccable | retrospective | n/a |
| web-design-guidelines | retrospective (no re-audit this pass) | pass (all findings resolved) |

## Self-Check: PASSED

- scripts/ci/check-rag-boundary.mjs and scripts/tests/check-rag-boundary.node-test.mjs present; 30 of 30 tests pass
- commits 95cedcd and 4a83df9 are ancestors of HEAD
- acceptance greps: rule ids 4 (>= 4), LEGACY_WRITERS 2 (>= 2), removedBy 5 (>= 4), fixture ids 20 (>= 4)

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
