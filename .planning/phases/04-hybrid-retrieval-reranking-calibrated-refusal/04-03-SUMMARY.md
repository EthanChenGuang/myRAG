---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 03
subsystem: rag
tags: [lexical, tokenizer, icu, exact-id, ingest]
requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: lexical/tokenize v1, enrich stage, extractExactIds, rag_exact_id_documents
provides:
  - LEXICAL_VERSION 2 tokenizer with rules.json and queryLexicalTokens
  - chunkLexicalText for ingest and future rag:relex
  - ICU segmentation check and exact-id v1/v2 lexical compatibility
affects: [04-06, 04-16, 04-17, 04-31]
actuals:
  tokens: 62000
  tasks: 3
  commits: 3
  plan_head_before: f6fdb22aa8b8f4e7c2d3e0b0e5e5a6a6c1b2c3d4
  plan_head_after: 334c00b
tech-stack:
  added: []
  patterns:
    - "Pattern 4 tokenizer pipeline with rules as data"
    - "chunkLexicalText single builder for lexical_text"
key-files:
  created:
    - src/lib/rag/lexical/rules.json
    - src/lib/rag/lexical/icu-check.ts
    - src/lib/rag/lexical/chunk-text.ts
    - tests/rag/lexical/tokenize-v2.test.ts
    - tests/rag/lexical/chunk-text.test.ts
  modified:
    - src/lib/rag/lexical/tokenize.ts
    - src/lib/rag/ingest/stages/enrich.ts
    - src/lib/rag/retrieval/exact-id.ts
key-decisions:
  - "Identifiers and codes are lowercase in lexical_text (v2); exact-id RPC still receives raw invoice/tax values"
  - "Filenames and dotted names tokenize into parts (brand, png) rather than a single dotted lexeme"
  - "Exact-id lookup dedupes RPC values case-sensitively so XR-2000 and xr-2000 both reach SQL"
patterns-established:
  - "splitAtIdentifiers for linear code boundaries; segmentCodeParts only when separators present"
requirements-completed: [RET-03]
duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 03: Shared tokenizer v2 Summary

**One versioned tokenizer writes lexical_text and query tokens with Han bigrams, elision splits, and exact-id parity across v1 and v2 stored text.**

## Accomplishments

1. **Tokenizer v2 (D-07)** — `LEXICAL_VERSION = 2`, `rules.json` stopwords/elisions/code pattern, `queryLexicalTokens`, NFKC + Latin fold, whole/joined code forms, Han bigrams, P-5 length/alphabet guards.
2. **Ingest lexical builder** — `chunkLexicalText` strips legacy Document prefixes, adds image filename/name/image_context, enrich sets `metadata.lexical_version`.
3. **Exact-id compatibility** — `lookupValues` unions raw tokens with v2 whole/joined forms only (not code parts); legacy smoke prechunked and ingest fixtures paired `all_zero`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Catastrophic backtrack on CODE_LIKE for long digit runs**
- **Fix:** Skip `segmentCodeParts` unless the identifier contains separators and length ≤ 128.

**2. [Rule 1 - Bug] Vitest v1 expectations for uppercase identifier tokens**
- **Fix:** Updated `lexical-tokenize.test.ts` and invoice extract expectation to lowercase v2 output.

## Tests

| Suite | Result |
|-------|--------|
| `npx vitest run tests/rag/lexical tests/rag/lexical-tokenize.test.ts tests/rag/exact-id.test.ts tests/rag/ingest` | pass |
| `npm run test-rag -- --out eval/out/p4-03` + jq gate | pass, paired all_zero |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/p4-03-ingest` + jq gate | pass, paired all_zero |
| `npm run typecheck:new` | pass (pre-existing unrelated diagnostics only) |

## Self-Check: PASSED

- src/lib/rag/lexical/tokenize.ts
- src/lib/rag/lexical/chunk-text.ts
- src/lib/rag/lexical/icu-check.ts
- Commits ca6fd0e, d5e0980, 334c00b on exec/04-03