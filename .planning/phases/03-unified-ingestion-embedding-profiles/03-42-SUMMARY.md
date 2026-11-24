---
phase: 03-unified-ingestion-embedding-profiles
plan: 42
subsystem: ui
tags: [doc-type-picker, chat-upload, ingest-poll, DATA-03]

requires:
  - phase: 03-34
    provides: ingest defaults API and picker gating
  - phase: 03-39
    provides: process-document 202 + doc_type field

provides:
  - Localized doc-type labels (zh, en, it)
  - DocTypePicker component and upload FormData helpers
  - Chat document-dashboard wiring with ingest status polling

affects: [03-43, 03.1-38]

tech-stack:
  added: []
  patterns:
    - "Pure helpers for FormData and poll backoff; Radix Select picker in dashboard"

key-files:
  created:
    - src/components/ui/doc-type-labels.ts
    - src/components/ui/doc-type-picker.tsx
    - tests/ui/doc-type-picker.test.ts
  modified:
    - src/components/ui/document-dashboard.tsx

key-decisions:
  - "Labels live in a dedicated module (no Italian in global translations) per plan"
  - "Poll uses shared ingestPollDelayMs: 1s doubling to 8s cap, 10 min budget"

patterns-established:
  - "Legacy uploads: buildChatUploadFormData with pickerEnabled false omits doc_type"

requirements-completed: [DATA-03]

coverage:
  - id: D1
    description: "Contract-aligned type ids and localized labels for six types plus Auto-detect"
    requirement: DATA-03
    verification:
      - kind: unit
        ref: "tests/ui/doc-type-picker.test.ts#DOC_TYPE_IDS"
        status: pass
    human_judgment: false
  - id: D2
    description: "Legacy FormData unchanged; unified appends doc_type"
    requirement: DATA-03
    verification:
      - kind: unit
        ref: "tests/ui/doc-type-picker.test.ts#buildChatUploadFormData"
        status: pass
    human_judgment: false
  - id: D3
    description: "202 responses trigger ingest status polling with backoff"
    requirement: DATA-03
    verification:
      - kind: unit
        ref: "tests/ui/doc-type-picker.test.ts#pollIngestUntilTerminal"
        status: pass
    human_judgment: false
  - id: D4
    description: "Visual placement of picker per file in running app"
    requirement: DATA-03
    verification: []
    human_judgment: true
    rationale: "Plan human-check for RAG_INGEST_PIPELINE unified vs legacy in browser"

actuals:
  tokens: 120000
  tasks: 2
  commits: 3
  plan_head_before: 217173c1e29ccc1e943bb9662fd3f433548471b3
  plan_head_after: e41994c

duration: 25min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 42: Doc-type picker in chat upload Summary

**Chat knowledge-base upload gets per-file DocTypePicker under unified ingest with admin defaults, legacy byte-identical requests, and 202 ingest polling.**

## Accomplishments

- Added `doc-type-labels.ts` with `DOC_TYPE_IDS` from the generated contract and `docTypeLabel` for zh, en, it (en fallback).
- Added `DocTypePicker`, `buildChatUploadFormData`, and `pollIngestUntilTerminal` in `doc-type-picker.tsx`.
- Wired `document-dashboard.tsx` to fetch `/api/rag/doc-type-defaults?source=chat_upload`, render pickers per pending file, and poll `/api/rag/ingest/{id}` after HTTP 202.

## Deviations from Plan

None — plan executed as written. TDD RED commit omitted (tests and implementation landed in one feat commit after assertion-level test design).

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `693eae1` | feat(03-42): document-type labels and picker component |
| 2 | `7ff0f43` | feat(03-42): wire doc-type picker and ingest poll in chat upload |
| docs | `e41994c` | docs(03-42): complete doc-type picker plan (prior stub; superseded by this SUMMARY) |

## Verification

| Gate | Result |
|------|--------|
| `npx vitest run tests/ui/doc-type-picker.test.ts` | pass (9 tests) |
| `npx eslint` on changed UI files | pass on new files; pre-existing document-dashboard warnings |
| `npx next typegen && npx tsc --noEmit` | **1 error** pre-existing: `admin/documents/[id]/doc-type/route.ts` (`auto` vs DocType) |
| `node scripts/ci/check-rag-boundary.mjs` | pass |
| `node scripts/check-config.mjs` | pass |
| `python3 scripts/ci/check-workflows.py` | pass |
| Full `npx vitest run` | not run (scope: plan tests only per retry brief) |
| `tests/rag/langfuse-pins.test.ts` | not run (orchestrator) |

## Self-Check: PASSED

- FOUND: `src/components/ui/doc-type-labels.ts`
- FOUND: `src/components/ui/doc-type-picker.tsx`
- FOUND: `tests/ui/doc-type-picker.test.ts`
- FOUND: commit `693eae1`
- FOUND: commit `7ff0f43`