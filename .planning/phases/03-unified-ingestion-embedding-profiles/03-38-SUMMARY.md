---
phase: 03-unified-ingestion-embedding-profiles
plan: 38
subsystem: ingest
tags: [pdf-images, captioning, source_images, RAG_PDF_IMAGE_CHUNKS]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "images stage and captioner (03-32), parse artifacts (03-27), PDF chunking (03-25)"
provides:
  - "selectPictures and public-store uploads for PDF embedded pictures"
  - "PDF branch of the images stage behind RAG_PDF_IMAGE_CHUNKS"
  - "source_images streaming for PDF picture chunks through unchanged chat path"
affects: [03-44, DATA-11]

actuals:
  tokens: 0
  tasks: 2
  commits: 6

requirements-completed: [DATA-11]

coverage:
  - id: D1
    description: "PDF pictures become capped, area-filtered, captioned image chunks with resume"
    verification:
      - kind: unit
        ref: "tests/rag/ingest/pdf-images.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fixture PDF image chunks stream as source_images in chat"
    verification:
      - kind: unit
        ref: "tests/rag/ingest/pdf-images-source-images.test.ts"
        status: pass
    human_judgment: false

duration: 0min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 38: PDF image chunks Summary

**Behind `RAG_PDF_IMAGE_CHUNKS`, PDF pictures become tenant-scoped captioned image chunks (0.02 area floor, 30 cap, injection scan, resume without double-caption) and stream as `source_images` like uploaded images.**

## Task Commits

Restored from `.planning/paused/p3c/03-38-commits/` onto base `694b696`:

1. `3c7624a` — test Task 1 picture selection and ingest path
2. `d047766` — feat Task 1 images stage, select, public-store
3. `f0b6d68` — test Task 2 source_images streaming
4. `59b9e4e` — fix picture kept as document source image when text ranks first
5. `73668bb` — test tenant isolation for `rag/` picture keys
6. `f713bfc` — fix resume reuses stored picture captions

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | retrospective / plan predates gate | n/a |
| Impeccable | retrospective | n/a |
| web-design-guidelines | retrospective (no re-audit this pass) | pass (all findings resolved) |

## Verification (worktree)

- `npx vitest run tests/rag/ingest/pdf-images.test.ts tests/rag/ingest/pdf-images-source-images.test.ts` — 33 passed, 0 failed

## Gates (orchestrator, pre-merge)

Pending full main-tree gate list after merge onto `claude/ecstatic-hamilton-86gtwv`.