---
phase: 05-verified-citations-groundedness
plan: 03
subsystem: api
tags: [citations, rag, streaming, parser, grammar]

requires: []
provides:
  - "src/lib/citations/marker-grammar.ts: one citation-marker grammar for server and client (findCitationMarkers, stripCitationMarkers, neutralizeCitationMarkers, MAX_MARKER_HOLD_CHARS, isOpenMarkerPrefix, isMarkerOpener)"
  - "src/lib/rag/generation/citations/marker-parser.ts: split-safe incremental parser keyed by text id with per-request alias validation (createMarkerParser, parseAnswerMarkers, MarkerParseResult)"
affects: [05-04, 05-08, 05-20, 05-22, 05.1]

actuals:
  tokens: 3640
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Grammar module outside src/lib/rag with no imports, so client components can share it without crossing the @/lib/rag deep-import boundary"
    - "Incremental parser keeps only the tail from the earliest still-viable opener (at most opener + 16 chars), so results do not depend on split points"

key-files:
  created:
    - src/lib/citations/marker-grammar.ts
    - src/lib/rag/generation/citations/marker-parser.ts
    - tests/lib/marker-grammar.test.ts
    - tests/rag/citations/marker-parser.test.ts
  modified: []

key-decisions:
  - "A marker spans at most MAX_MARKER_HOLD_CHARS (16) characters after its opener, closer included, and the length cap is part of the grammar itself. findCitationMarkers, strip, neutralize and the streaming parser therefore agree exactly, and the one-shot result equals every split. Consequence: a single bracket with many aliases (e.g. [S1, S2, S3, S4, S5], 19 chars after the opener) is not a marker; up to four short aliases ([S1, S2, S3, S4]) or [S1, S2, S3, S12] fit. Models that cite many sources should use adjacent markers [S1][S2]; plan 05-08's prompt instruction should say so."
  - "The opener is held only while the text after it is a viable marker prefix (state check), not blindly for 16 chars; a dead opener is released immediately."
  - "Any opener may close with any closer ([S3】 is a marker), per the plan's action text."
  - "Spaces are allowed only around separators; [ S3] and [S3 ] are not markers (strict, matches the [S 3] rule)."
  - "invalidAliases lists each invalid alias once (first-appearance order); invalidCitations counts every occurrence."
  - "Across text ids, valid aliases are ordered by when their marker completed (discovery order)."
  - "finish() is idempotent; feed() after finish() is ignored; end(id) discards a pending opener."
  - "stripCitationMarkers removes horizontal whitespace before a marker, and whitespace after a marker that sits at the start of a line; newlines and punctuation are kept."
  - "neutralizeCitationMarkers inserts U+200B between S and the digits of every alias inside every marker (one per alias) and returns the same string when there is no marker."

patterns-established:
  - "Exhaustive split testing: every 2-way and 3-way split, char-by-char feeding, and a seeded random fuzz over marker-like alphabets compared with the one-shot result"

requirements-completed: [GEN-02, GEN-04]

coverage:
  - id: D1
    description: "Shared marker grammar: listed forms accepted, non-markers rejected, strip and neutralize"
    requirement: GEN-02
    verification:
      - kind: unit
        ref: "tests/lib/marker-grammar.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Split-safe incremental parser with alias validation and invalid counts"
    requirement: GEN-02
    verification:
      - kind: unit
        ref: "tests/rag/citations/marker-parser.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Validated MarkerParseResult shape ({valid, invalidCitations, invalidAliases}) for the structured citation record"
    requirement: GEN-04
    verification:
      - kind: unit
        ref: "tests/rag/citations/marker-parser.test.ts#parseAnswerMarkers"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 03: Marker Grammar and Split-Safe Parser Summary

**One shared `[S<k>]` citation-marker grammar (ASCII and full-width brackets and separators) plus a pure incremental parser that finds the same validated aliases whatever the token split.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2
- **Files created:** 4 (2 source, 2 test)

## Accomplishments

- `src/lib/citations/marker-grammar.ts` (no imports): `findCitationMarkers` returns `{start, end, aliases}` with UTF-16 offsets; `stripCitationMarkers` removes every marker form; `neutralizeCitationMarkers` inserts U+200B so block text can no longer form a marker; `MAX_MARKER_HOLD_CHARS = 16`. Also exports `isOpenMarkerPrefix` and `isMarkerOpener`, which the parser uses.
- `src/lib/rag/generation/citations/marker-parser.ts`: `createMarkerParser({aliases})` → `{feed(textId, delta), end(textId), finish()}`, and the one-shot `parseAnswerMarkers(text, aliases)` for the eval endpoint (05-22). No `ai` or `@ai-sdk/*` imports. The parser only observes and never changes text.

## Task Commits

1. **Task 1: Shared marker grammar**
   - RED `851758b` test(05-03): add failing tests for the shared citation marker grammar (23 of 37 failed on assertions against an export-only stub)
   - GREEN `e51330c` feat(05-03): shared citation marker grammar for server and client
2. **Task 2: Split-safe parser**
   - RED `561025a` test(05-03): add failing split-safe marker parser tests (8 of 13 failed on assertions against an export-only stub)
   - GREEN `7436b20` feat(05-03): split-safe incremental citation marker parser with alias validation (adds the seeded fuzz test)

## Deviations from Plan

- **Hold-back cap is part of the grammar.** The plan states the 16-character hold for the streaming parser only. Applying the same cap in `findCitationMarkers` keeps the one-shot parse, client stripping and streaming parse identical, as the plan's equivalence truths require. Side effect: a bracket with more than 16 characters after the opener is plain text everywhere (see key-decisions).
- **Extra exports** `isOpenMarkerPrefix` and `isMarkerOpener` in the grammar module (the plan lists four exports). They keep the viable-prefix logic in the one grammar file.
- No migration, env variable, contract or Python change; `npm run gen:schemas` and `test-rag` were not required (no retrieval, ingest or golden-set code touched; the new modules are not wired in yet).

## Gate Results

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 224 files, 3421 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 163 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 794 pass, 0 fail, 3 skipped
- `check-rag-boundary.mjs` and its node test: pass (38/38)
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: pass
- `npm run typecheck:new` (plan verification): reports 45 diagnostic lines, all in `tests/rag-db/*`; the same 45 appear on trunk `21f611b`; none are in this plan's files.

## Next Phase Readiness

- 05-08 wraps `createMarkerParser` in an `experimental_transform` (feed on `text-delta`, `end` on `text-end`, `finish` before finish metadata) and applies `neutralizeCitationMarkers` in the block labeler.
- 05-20 chips import `stripCitationMarkers` / `findCitationMarkers` from `@/lib/citations/marker-grammar`.
- The prompt instruction (05-08) should ask for adjacent markers `[S1][S2]` when citing more than a few sources (16-char marker cap).
