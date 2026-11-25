---
phase: 03-unified-ingestion-embedding-profiles
plan: 06
subsystem: rag-ingest
tags: [sha256, nfkc, tiktoken, cl100k_base, intl-segmenter, lexical, language-detection, embedding-text]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: src/lib/rag/ module layout and the boundary check that scans the new modules
provides:
  - contentHash/normalizeForHash/fileSha256 with HASH_NORMALIZATION_VERSION = 1 and frozen zh/en/it vectors (D-09)
  - countTokens/truncateToTokens on a lazily created cl100k_base encoder (D-22)
  - IDENTIFIER_PATTERN, splitAtIdentifiers, extractIdentifiers (identifier shapes)
  - lexicalTokens/lexicalText with LEXICAL_VERSION = 1 (D-32)
  - detectLanguage returning zh, en, it or null
  - buildEmbeddingText/renderTemplateHeader with EMBEDDING_TEXT_VERSION = 1 (D-24)
affects: [03-13, 03-16, 03-19, 03-26, 03-29, phase-04-lexical, phase-04-exact-id]

actuals:
  tokens: 6000
  tasks: 3
  commits: 6

plan_head_before: ccfcd7e0e02d332cc60a779fc7a84197888bf557
plan_head_after: 45f39e0fe567c0f09efd27825ed8515af44c917d
commits: 6

tech-stack:
  added: []
  patterns:
    - "Pure, versioned text rules with an exported *_VERSION constant for anything persisted"
    - "Linear identifier regex: lookbehind limits the lookahead to the start of a run"
    - "Frozen test vectors computed independently (Python) of the TypeScript implementation"

key-files:
  created:
    - src/lib/rag/ingest/hash.ts
    - src/lib/rag/ingest/text/tokens.ts
    - src/lib/rag/ids/shapes.ts
    - src/lib/rag/lexical/tokenize.ts
    - src/lib/rag/lang/detect.ts
    - src/lib/rag/ingest/text/embedding-text.ts
    - tests/rag/ingest/hash.test.ts
    - tests/rag/ingest/tokens.test.ts
    - tests/rag/lexical-tokenize.test.ts
    - tests/rag/lang-detect.test.ts
    - tests/rag/ingest/embedding-text.test.ts
    - tests/fixtures/ingest/hash-vectors.json
  modified: []

key-decisions:
  - "Newline rule for content_hash: single newlines kept, blank-line runs collapse to one newline (as the plan fixed)"
  - "Identifier regex restructured to be linear (lookbehind + lookahead + non-punctuation tail) instead of the research sketch, which is quadratic on a long run without digits"
  - "Identifiers keep their case verbatim in lexical_text; only non-identifier Latin text is lowercased and folded"
  - "renderTemplateHeader rejects placeholders that are not own keys of the row (including constructor and __proto__) and names outside [a-z][a-z0-9_]*"
  - "detectLanguage returns null when neither the en nor the it stopword list has a hit and Han share is below 0.2"

patterns-established:
  - "Tokenizer, identifier shapes and hash live in separate pure modules under src/lib/rag/, each tested without I/O"

requirements-completed: [DATA-02, DATA-06, CHK-01]

coverage:
  - id: D1
    description: "contentHash is sha256 of the NFKC/whitespace/newline-normalised text, case kept, pinned by committed zh/en/it vectors and HASH_NORMALIZATION_VERSION = 1"
    requirement: DATA-06
    verification:
      - kind: unit
        ref: "tests/rag/ingest/hash.test.ts#matches every committed zh/en/it vector"
        status: pass
    human_judgment: false
  - id: D2
    description: "countTokens uses cl100k_base with the 35/32/27 counts on the zh/en/it samples; the encoder is created once"
    requirement: DATA-02
    verification:
      - kind: unit
        ref: "tests/rag/ingest/tokens.test.ts#gives the counts the sidecar reports on the shared zh/en/it samples"
        status: pass
    human_judgment: false
  - id: D3
    description: "lexicalText keeps identifier-shaped tokens verbatim, segments Chinese with Intl.Segmenter, folds Latin, carries LEXICAL_VERSION = 1; hostile 200 KB inputs finish under one second"
    requirement: CHK-01
    verification:
      - kind: unit
        ref: "tests/rag/lexical-tokenize.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "detectLanguage returns the dominant language zh, en or it, or null, on the fixture corpus and mixed-script samples"
    requirement: DATA-02
    verification:
      - kind: unit
        ref: "tests/rag/lang-detect.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "buildEmbeddingText and renderTemplateHeader build the embedding text from stored columns only, EMBEDDING_TEXT_VERSION = 1"
    requirement: CHK-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/embedding-text.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "Sidecar parity of the token counts on the same samples (the sidecar side lands in a later plan)"
    verification: []
    human_judgment: true
    rationale: "The sidecar tiktoken package is installed by plan 03-05, so the TypeScript counts cannot be compared with the sidecar's here"

duration: 10min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 06: Text rules Summary

**Pure, versioned text rules for ingest: NFKC content hash with frozen vectors, cl100k_base token counts, a linear identifier pattern, the Intl.Segmenter lexical tokenizer, zh/en/it language detection and the embedding-text builder.**

## Performance

- **Duration:** about 10 min
- **Started:** 2026-11-24T00:26:10Z
- **Completed:** 2026-11-24T00:35:54Z
- **Tasks:** 3
- **Files modified:** 12 (all new)

## Accomplishments
- `contentHash` is the persisted dedup rule (D-09), pinned by `tests/fixtures/ingest/hash-vectors.json`. The vectors, including their expected digests, come from a separate Python implementation, so a drift in the TypeScript rule shows up as a failing vector.
- `countTokens` and `truncateToTokens` use one lazily created cl100k_base encoder. `truncateToTokens` drops a broken multi-byte tail.
- `lexicalTokens` and `lexicalText` write lexical_text: identifiers are cut out first (`发票号码FP-2025-0042不得转让` gives `发票 号码 FP-2025-0042 不得 转让`), Han runs go through `Intl.Segmenter('zh')`, Latin runs are lowercased and folded.
- `detectLanguage` returns zh when Han is at least 20 percent of letters, otherwise en or it by stopword hits, or null without evidence. All 12 fixture corpus documents classify as their folder language.
- `buildEmbeddingText` and `renderTemplateHeader` rebuild the embedding text from stored columns only.

## Task Commits

1. **Task 1: content hash and token counts** - `ec31c2c` (test, RED), `b006491` (feat, GREEN)
2. **Task 2: identifier shapes and lexical tokenizer** - `4cb4240` (test, RED), `31341cd` (feat, GREEN)
3. **Task 3: language detection and embedding text** - `b00946e` (test, RED), `45f39e0` (feat, GREEN)

**Plan metadata:** the commit that adds this SUMMARY.

## TDD Gate Compliance

Every task has a `test(03-06)` commit followed by a `feat(03-06)` commit. The RED commits carry minimal stub modules, so each RED run fails on assertions (hash 8 of 12, tokens 5 of 7, lexical 12 of 18, language and embedding text 17 of 19), never on a missing module. Some edge-case tests pass against the stubs (for example "returns null for empty text"); the tests that pin behaviour fail. The "encoder created once" test was tightened before the RED commit so the stub fails it (fresh module import, exactly one `get_encoding('cl100k_base')` call).

## Files Created/Modified
- `src/lib/rag/ingest/hash.ts` - normalizeForHash, contentHash, fileSha256, HASH_NORMALIZATION_VERSION
- `src/lib/rag/ingest/text/tokens.ts` - countTokens, truncateToTokens
- `src/lib/rag/ids/shapes.ts` - IDENTIFIER_PATTERN, splitAtIdentifiers, extractIdentifiers
- `src/lib/rag/lexical/tokenize.ts` - lexicalTokens, lexicalText, LEXICAL_VERSION
- `src/lib/rag/lang/detect.ts` - detectLanguage, DetectedLanguage
- `src/lib/rag/ingest/text/embedding-text.ts` - buildEmbeddingText, renderTemplateHeader, EMBEDDING_TEXT_VERSION
- `tests/rag/ingest/hash.test.ts`, `tokens.test.ts`, `embedding-text.test.ts`, `tests/rag/lexical-tokenize.test.ts`, `tests/rag/lang-detect.test.ts` - 56 tests
- `tests/fixtures/ingest/hash-vectors.json` - six frozen vectors (zh, zh invoice, en, it, it with decomposed accents, mixed case)

## Decisions Made
- The identifier regex differs from the research sketch. `[A-Z0-9][A-Z0-9._/-]*\d[A-Z0-9._/-]*` backtracks quadratically on a long run without a digit (T-03-15). The shipped pattern starts only at a run start (lookbehind), checks for a digit with a lookahead, and ends on an alphanumeric, so trailing punctuation (`FT-1.`) is excluded and matching stays linear. A 200 KB test covers five hostile shapes.
- The tokenizer uses `splitAtIdentifiers` (spans) rather than `extractIdentifiers` (values only) because it needs positions. Both share one code path: `extractIdentifiers` filters `splitAtIdentifiers`. The plan's key_link names `extractIdentifiers`; the link exists through that shared path.
- Identifiers keep their case in lexical_text. A query side that lowercases identifiers would miss them, so Phase 4's query tokenizer must call the same `lexicalTokens`.
- A digit-only token such as `5` in `第5条` counts as an identifier (it contains a digit), so the Han runs around it are segmented separately (`第 5 条`). Index and query use the same function, so they stay consistent.
- `renderTemplateHeader` accepts only own keys of the row, so a profile template cannot read `constructor` or `__proto__`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Research identifier regex is quadratic on hostile text**
- **Found during:** Task 2 (design, against threat T-03-15)
- **Issue:** the Pattern 9 sketch backtracks over a long digit-free run once per start position.
- **Fix:** lookbehind/lookahead pattern described above, with a 200 KB hostile-input test.
- **Files modified:** src/lib/rag/ids/shapes.ts
- **Verification:** `tests/rag/lexical-tokenize.test.ts` hostile-input cases
- **Committed in:** 31341cd

**2. [Rule 2 - Missing critical] Placeholder names validated against prototype keys**
- **Found during:** Task 3
- **Issue:** a `{constructor}` placeholder would resolve through the prototype if checked with `in`.
- **Fix:** `Object.hasOwn` plus a name pattern; tests cover `constructor` and an invalid name.
- **Files modified:** src/lib/rag/ingest/text/embedding-text.ts
- **Verification:** `tests/rag/ingest/embedding-text.test.ts#throws on an unknown placeholder`
- **Committed in:** 45f39e0

### Other departures

- **Token samples.** The plan names "the research zh/en/it strings" (35/32/27), but the research file records only the counts, not the strings. I wrote synthetic zh/en/it sentences that reach exactly 35, 32 and 27 under the npm `tiktoken` package and pinned them in `tests/rag/ingest/tokens.test.ts`. The comparison against the sidecar's counts on the same strings is still open (see D6 in the coverage block). Plan 03-05 installs the sidecar package, so whoever adds the sidecar token test should take these three strings.
- **Commit trailer.** The shared brief names an Opus trailer; this session's own attribution instruction names Sonnet 5.5, and the plan says to use the executor's own session lines. All six commits carry the Sonnet 5.5 trailer. The first RED commit was amended once, before anything depended on it, to correct this.

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical), 2 other departures
**Impact on plan:** no scope change; both fixes sit inside the planned files.

## Issues Encountered
None blocking. `tests/rag/langfuse-pins.test.ts` ran and passed in this worktree.

## Gate Results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no errors
- `npx vitest run`: 113 files, 1389 tests passed
- `node --import tsx --test tests/*.test.mts`: 136 passed
- `node scripts/ci/check-rag-boundary.mjs`: ok, 631 files scanned
- `python3 scripts/ci/check-workflows.py`: OK
- `node scripts/check-config.mjs`: ok, 79 variables
- Sidecar pytest: not run (rag-sidecar untouched)

## Known Stubs
None.

## Threat Flags
None. No network, auth, file-access or schema surface was added.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The ingest runner, writer and chunkers (03-13 onward) can import `contentHash`, `countTokens`, `lexicalText`, `detectLanguage` and `buildEmbeddingText`.
- Plan 03-16's backfill can rehash from stored content with `normalizeForHash` if the rule is ever bumped.
- Phase 4 owns the lexical index and the query side; it must reuse `lexicalTokens`.

## Self-Check: PASSED

All 12 created files exist, all six task commits are ancestors of HEAD, and every acceptance criterion passed: `HASH_NORMALIZATION_VERSION = 1` count 1, `Intl.Segmenter` count 2, `EMBEDDING_TEXT_VERSION = 1` count 1, and the vitest counts (19, 18, 19 passed; minimums were 9, 6, 8).

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
