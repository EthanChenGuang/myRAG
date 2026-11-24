---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 24
subsystem: rag
tags: [v2, query-variants, translation, lexical, xlg-03, lat-01]

requires:
  - phase: 04-20
    provides: v2 query group and rank group
  - phase: 04-21
    provides: harness run configs and the RAG_LEXICAL_TRANSLATION allow-list entry
provides:
  - buildQueryVariants (original, caller variants, translate output, deduped, capped at three)
  - translator slot (none by default) with a fixture translator and the committed translation table
  - translate stage in the v2 query group
  - per-variant embedding (provider batch call or parallel) and per-variant parallel search
  - harness installs the fixture translator for v2 runs that enable RAG_LEXICAL_TRANSLATION
affects: [04-23, 04-25, 06-xlg-01]

actuals:
  tokens: 12000
  tasks: 2
  commits: 7
plan_head_before: 96ec63378737fb89a435888b7ab2c257a6ae57ae
plan_head_after: 1cdc02e

tech-stack:
  added: []
  patterns:
    - "Translator slot: module-level get/set/reset (object-store pattern); production code never imports the fixture table, the harness loads it"
    - "One variant takes the existing embedQuery path unchanged; only several variants use embedQueries"

key-files:
  created:
    - src/lib/rag/query/variants.ts
    - src/lib/rag/query/translate.ts
    - eval/fixtures/translation-table.json
    - tests/rag/v2/translation-seam.test.ts
    - tests/rag-db/translation-seam-fixture.test.mts
  modified:
    - src/lib/rag/v2/stages/query.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/embeddings/query-embedding.ts
    - src/lib/rag/embeddings/types.ts
    - src/lib/rag/embeddings/voyage.ts
    - src/lib/rag/embeddings/qwen.ts
    - src/lib/rag/embeddings/openai-provider.ts
    - src/lib/rag/deps.ts
    - eval/harness/run-eval.mts

key-decisions:
  - "Dedupe of variants is by NFKC, lowercased, trimmed text; a caller-supplied variant of kind original never replaces the real original"
  - "The translate stage records ok with detail translator_none while no translator is registered (not degraded), so switching the flag on early does not mark every result degraded; a throwing or timed-out translator is skipped (degraded)"
  - "Only translated variants restrict the lexical leg (lexicalLanguages [language]); the original is unrestricted. This replaces the earlier rule that restricted every variant with a known language, including the original"
  - "Batch query embedding is an optional provider method embedQueries plus an optional dep profileBatchEmbedder; absent or null means parallel embedQuery calls under the stage signal"

requirements-completed: [XLG-03, LAT-01]

coverage:
  - id: D1
    description: "buildQueryVariants: original first, caller variants, translate output, deduped by text, capped at three"
    requirement: XLG-03
    verification:
      - kind: unit
        ref: "tests/rag/v2/translation-seam.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Translator slot is none by default; fixture translator and a table that covers all 24 approved cross_lingual golden questions with protected tokens verbatim"
    requirement: XLG-03
    verification:
      - kind: unit
        ref: "tests/rag/v2/translation-seam.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Translate stage in the query group; switch off leaves one variant and one backend call; failure or timeout skips the stage"
    requirement: XLG-03
    verification:
      - kind: unit
        ref: "tests/rag/v2/translation-seam.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Variants embedded by one batch call or in parallel and searched with Promise.all under one signal; translated lexical leg restricted to its language; RRF lists dense:i and lexical:i"
    requirement: LAT-01
    verification:
      - kind: unit
        ref: "tests/rag/v2/translation-seam.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "English question about an Italian-only document finds the Italian gold chunk on lexical:1 on the fixture database"
    requirement: XLG-03
    verification:
      - kind: integration
        ref: "tests/rag-db/translation-seam-fixture.test.mts"
        status: pass
    human_judgment: false

duration: 75min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 24: Translation seam (D-22 query variants) Summary

**v2 builds up to three query variants (original, caller-supplied, translated), embeds them in one batch call or in parallel, searches them concurrently, and restricts a translated variant's lexical leg to its language; the translator slot is empty in production until Phase 6 and fixture-backed in tests and eval.**

## Accomplishments

- `buildQueryVariants` (pure): original first, then `input.queryVariants` (Phase 6 seam), then translate output; deduped by normalised text; cut to `MAX_QUERY_VARIANTS = 3`.
- `translate.ts`: `getTranslator` returns the `none` translator until another is set; `setTranslatorForTests` and `resetTranslatorForTests`; `createFixtureTranslator(table)` validates the table and serves it by normalised question (NFKC, lowercase, trim).
- `eval/fixtures/translation-table.json`: hand-written translations of all 24 approved `cross_lingual` golden questions into the evidence language; a test checks codes, emails, percentages, decimals, capitalised terms, multi-word proper names and (for non-zh questions) CJK names verbatim in every entry. Production code never references the file.
- Query group: `translate` stage after `analyze` (disabled unless `RAG_LEXICAL_TRANSLATION`; timeouts 1000 ms standard and eval, 300 ms voice from the existing config; skipped on error or timeout; `translator_none` detail while no translator is registered).
- Embed stage embeds every variant. Several variants use the provider's batch call when it offers one (`embedQueries`, added to the voyage, qwen and openai providers and exposed through the optional `profileBatchEmbedder` dep) and parallel `embedQuery` calls otherwise. One variant still calls `embedQuery` / `embedQueryForEvalProfile` exactly as before.
- Search: one `hybrid_search_chunks` call per variant in `Promise.all` under the shared stage signal, each with its own dense vector; `lexicalLanguages` is `[language]` for translated variants and `null` for the original; RRF lists are `dense:i` and `lexical:i`.
- Harness: `prepareInProcessEval` installs `createFixtureTranslator` built from the committed table when the overlay is a v2 run with `RAG_LEXICAL_TRANSLATION=true` (`shouldInstallFixtureTranslator`), and removes it on close. Legacy runs and runs without the switch never get it.

## Task Commits

| Step | Commit | Subject |
| ---- | ------ | ------- |
| 1 RED | cc99881 | test(04-24): RED for query variants, translator slot and the fixture translation table |
| 1 GREEN | 607f0fa | feat(04-24): query variants builder, translator slot and fixture translation table |
| 2 RED | a53dd95 | test(04-24): RED for the translate stage, parallel per-variant search and variant embedding |
| 2 GREEN | 21e2a4e | feat(04-24): translate stage, parallel variant embedding and language-restricted translated lexical leg |
| 2 harness RED | fb48682 | test(04-24): RED for the harness fixture translator on a translation-enabled run config |
| 2 harness GREEN | 91c2674 | feat(04-24): harness installs the fixture translator for v2 runs that enable RAG_LEXICAL_TRANSLATION |
| 2 follow-up | 1cdc02e | fix(04-24): a single-variant request keeps the embedQuery path |

Each RED commit failed on assertions (stubs were committed with the RED tests where a module or export did not exist yet).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The embed stage lives in `src/lib/rag/v2/pipeline.ts`, which the plan does not list**
- **Issue:** "embed both variant texts in one stage" cannot be done in the listed files; `runSearchStages` receives a finished embedding and the embed stage is in `runV2Pipeline`.
- **Fix:** small, local edit of the embed stage and the `runSearchStages` call (a new optional `variantEmbeddings` input). Kept minimal because 04-23 also edits the v2 stages; expect a trivial merge at the `runSearchStages(...)` call if 04-23 adds arguments there.
- **Commits:** 21e2a4e, 1cdc02e

**2. [Rule 3 - Blocking] No provider offered a batch query call**
- **Issue:** the plan says "one batch call when the active profile's provider offers one", but `embedDocuments` is not a valid substitute (Voyage input type, Qwen instruction prefix) and no `embedQueries` existed.
- **Fix:** optional `EmbeddingProvider.embedQueries` (voyage with input_type query, qwen with the same instruction prefix as `embedQuery`, openai), optional `RagDeps.profileBatchEmbedder` (default routes to the provider's `embedQueries`, null when absent), `embedQueries` and `embedQueriesForEvalProfile` in `query-embedding.ts` (vector length, model and count asserted per request, same as the single path). No provider behaviour changes for single queries.
- **Commits:** a53dd95, 21e2a4e

**3. [Rule 1 - Bug] Original variant's lexical leg was restricted to the query language**
- **Issue:** the existing rule `variant.language ? [variant.language] : null` restricted the original English query to English chunks, which defeats cross-language lexical retrieval. Changed to the plan's rule: translated variants only.
- **Effect with switches off:** the lexical leg (only active with `RAG_LEXICAL_SEARCH=true` under v2) of a query with a detected language is now unrestricted. With `RAG_LEXICAL_SEARCH` off the lexical tokens are empty and nothing changes. No existing test depended on the old behaviour.
- **Commit:** 21e2a4e

**4. [Rule 1 - Bug] First embed-stage version bypassed an existing test seam**
- **Issue:** calling `embedQueries` for one text broke `tests/rag/v2/refusal-routing.test.ts`, which spies on `embedQuery`.
- **Fix:** single-variant requests call `embedQuery` / `embedQueryForEvalProfile` directly (also guarantees byte-identical switch-off behaviour). No existing test was edited.
- **Commit:** 1cdc02e

### Choices where the plan was silent

- **local_bm25 against the translated variant (truth 5 of the plan):** the rerank stage is in `rank.ts`, which 04-23 owns, and the plan's task files do not include it. This plan puts the variants in `query.variants` (original first, translated after, each with its language); 04-23 consumes them for `queryByDoc`. Nothing else is needed here.
- The fixture check uses `xl-en-it-03` ("dropped or submerged"). The English original also matches Italian warranty chunks lexically on the fixture, because the contextual header in `lexical_text` carries the English file name `warranty-terms.it.md`; the test therefore asserts that the gold chunk is on `lexical:1`, that every `lexical:1` candidate is Italian, and does not assert that `lexical:0` is empty.
- The translate stage is recorded as `disabled` in the trace when the switch is off (like `rerank` and `compress`), so a v2 trace gains one `translate: disabled` stage row.

## Verification

- `npx vitest run tests/rag/v2`: 8 files, 106 tests pass (includes `translation-seam.test.ts`, 28 tests, and `search-stages.test.ts`).
- `npx vitest run tests/rag/v2/translation-seam.test.ts tests/rag/v2/search-stages.test.ts`: 36 pass.
- `node --import tsx --test tests/rag-db/translation-seam-fixture.test.mts`: 3 pass (translator install rule; fixture translator installed; Italian gold chunk on `lexical:1`, all `lexical:1` candidates Italian; translator removed on close).
- `node --import tsx --test tests/rag-db/eval-v2-overlay.test.mts`: 19 pass.
- `npx vitest run tests/eval-harness.test.ts tests/eval-route-v2.test.ts tests/rag/embed-route.test.ts`: 36 pass.
- `node scripts/ci/check-rag-boundary.mjs`: ok, no violations. `npx tsc --noEmit -p tsconfig.json`: 0 errors. `node scripts/check-config.mjs`: ok (no new env variable).
- Full `npx vitest run tests/rag`: 2379 pass, 28 fail, none new: 27 in `tests/rag/documents-versions.test.ts` (the same failures that 04-21 recorded on base) and 1 timing assertion in `tests/rag/lexical-tokenize.test.ts` (1133 ms against 1000 ms under load; passes alone).
- `tests/rag-db/v2-tracer.test.mts` fails on the base commit 96ec633 as well ("expected at least one kept chunk": the 0.65 similarity floor refuses on the fixture embedder, see 04-21 deferred notes); unchanged by this plan.

## Known Stubs

None. The `none` translator is the intended production default until the Phase 6 translator registers (XLG-01).

## Deferred Issues / Observations

- Phase 6 must register its translator through the same slot; the exported setter is `setTranslatorForTests` (no production registration function was added because the plan's export list names none). Phase 6 should add one.
- `v2-tracer.test.mts` base failure and `documents-versions.test.ts` base failures are outside this plan.
- No run config enables translation yet; one can be added when 04-30 / 04-39 compare cross-language runs (`{"RAG_PIPELINE":"v2","RAG_LEXICAL_SEARCH":"true","RAG_LEXICAL_TRANSLATION":"true"}` already installs the fixture translator).

## Threat Flags

None. T-04-47 is mitigated: at most three variants, translate stage has its own timeout and is skipped on failure. Translated text only becomes lexical tokens (parameterised, sanitised by `rag_lexical_tsquery`) and embedding input; the tenant scope and filters are unchanged for every variant.

## Self-Check: PASSED

Created files and all seven commits were checked present on `exec/04-24`.
