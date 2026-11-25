---
phase: 05-verified-citations-groundedness
plan: 04
subsystem: rag
tags: [rag, context, citations, assembly, v2]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: buildContext groupOrder/keptByOverride (04-12), v2 context stage group with budget, merge, edge order, compression (04-19, 04-22) and parent expansion (04-27)
  - phase: 03-unified-ingestion-embedding-profiles
    provides: tenant-scoped refs resolver (03-20)
provides:
  - ContextBlock, CitationLabel, CitationLabeler, ReferencedSection types (exported from @/lib/rag)
  - RetrievalResult.blocks on the legacy and v2 paths, in render order
  - RunRetrievalInput.citationLabeler hook; absent = unchanged context
  - renderReferencedSection and ReferencedState.sections from the refs resolver
affects: [05-08 citation strategy wiring, 05-03 alias map, 05.1 doc ids]

actuals:
  tokens: 13400
  tasks: 3
  commits: 8

tech-stack:
  added: []
  patterns:
    - "Blocks built as data while rendering; the labeler is applied in the same pass, so blocks and context cannot drift"
    - "v2 labels by re-rendering the final selection once more after compress, outside any stage record"

key-files:
  created:
    - tests/rag/context/context-blocks.test.ts
    - tests/rag/v2/context-blocks-v2.test.ts
  modified:
    - src/lib/rag/types.ts
    - src/lib/rag/context/assemble.ts
    - src/lib/rag/refs/resolve.ts
    - src/lib/rag/pipeline.ts
    - src/lib/rag/v2/stages/context.ts
    - src/lib/rag/v2/result.ts
    - src/lib/rag/index.ts
    - tests/rag/refs.test.ts
    - tests/legacy-post-filter-sentinel.test.ts

key-decisions:
  - "With a labeler, the header replaces the GPT-form [Source: name] line (the header carries the title); without one the line is unchanged"
  - "A v2 block is a run of consecutive rendered chunks of one document with the same mergeAdjacent run key; render order inside a document is not changed, so a run that buildContext renders non-contiguously becomes several blocks"
  - "Block title = name + ', p.N' + ' / ' + section path joined with ' > '"
  - "A referenced document with no readable content stays a note in the context and is not a block"

patterns-established:
  - "Pattern: assembly returns blocks alongside the context string; consumers never re-parse the context"

requirements-completed: [GEN-02, GEN-03, GEN-07]

coverage:
  - id: D1
    description: "Legacy assembly returns blocks in render order and labels non-image blocks only when a labeler is given"
    requirement: GEN-02
    verification:
      - kind: unit
        ref: "tests/rag/context/context-blocks.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Referenced documents are blocks first; ordinals continue into retrieved chunks; runRetrieval passes the labeler and returns blocks"
    requirement: GEN-03
    verification:
      - kind: unit
        ref: "tests/rag/refs.test.ts"
        status: pass
      - kind: unit
        ref: "tests/rag/context/context-blocks.test.ts#referenced documents as blocks"
        status: pass
    human_judgment: false
  - id: D3
    description: "v2 blocks per merged run after edge order, parents and compression; labelling is the last step and stage records are unchanged"
    requirement: GEN-02
    verification:
      - kind: unit
        ref: "tests/rag/v2/context-blocks-v2.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Without a labeler the context and every other result field are byte-identical (GEN-07)"
    requirement: GEN-07
    verification:
      - kind: integration
        ref: "node --import tsx --test tests/rag-assemble-differential.test.mts tests/rag-legacy-differential.test.mts; npm run test-rag (paired.all_zero true)"
        status: pass
    human_judgment: false

duration: 75min
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 04: Context blocks and the citation labeler hook Summary

**Both retrieval pipelines and the refs path now hand back the final context blocks in render order, and label them with S-aliases only when a `citationLabeler` is passed; without it the context is byte-identical.**

## Accomplishments
- `ContextBlock` {documentId, documentName, documentVersion, chunkIds, page, sectionPath, title, text, isImage, alias} and `CitationLabeler` in `types.ts`; `RetrievalResult.blocks` and `RunRetrievalInput.citationLabeler` are optional.
- `buildContext` builds the block list in the same pass that renders the context. Image chunks (`metadata.image_url`) are blocks with `isImage: true`, never passed to the labeler and rendered unchanged; image documents (by extension) stay unrendered and get no block.
- Labelled rendering: `<header>\n<label text>` in place of each non-image block (in place of the GPT-form `[Source: …]` line too); the block's `text` becomes the labelled text, i.e. what the model saw.
- `resolveDocumentRefs` returns `sections` (chunk ids of the chunks used, empty for full text, `missing` for the no-content note); its context is now rendered from the sections through the exported `renderReferencedSection`, byte-identical to before. With a labeler, the referenced part is rebuilt from the sections with headers and ordinals continue into the retrieved chunks.
- v2: the assemble stage passes the `mergeAdjacent` run keys and, for a parent standing in for its children, the child chunk ids (chunk-index order). The compress stage re-renders with the same shape, so block text is the compressed text. The labeler runs after compress as a final re-render of the final selection; it adds no stage record and changes no counts.

## Task Commits
1. Task 1 — RED `59b2ed4`, GREEN `8e44906`
2. Task 2 — RED `eff0d98`, GREEN `2dfe46c`
3. Task 3 — RED `1b95de8`, GREEN `2faba15`
4. Sentinel re-pin — `2493c42`

All RED commits failed on assertions (blocks undefined / labeler ignored), not on module resolution.

## Deviations from Plan
1. **[Rule 3] `tests/legacy-post-filter-sentinel.test.ts` re-pinned** — it hashes the `buildContext` body, which this plan had to change. Per its own instruction, the differential, legacy post-filter and chat characterization suites were re-checked (all green) before updating the end marker and hash.
2. **[Rule 3] `src/lib/rag/v2/result.ts` and `src/lib/rag/index.ts` touched** — result.ts copies `blocks` onto the v2 result; index.ts exports the new types for 05-08. Not in `files_modified`.
3. **[Rule 3] Resolver tests in `tests/rag/refs.test.ts`** — they need that file's filtering admin fake. The refs chunk query now selects `id, content` (was `content`) to get chunk ids; same query count and ops.
4. **Interpretation (v2 runs):** inside one document `buildContext` still orders chunks by legacy chunk number, else similarity (04-22 deferred note). Changing it would alter the unlabelled context, so a run whose chunks are not rendered next to each other becomes one block per contiguous piece. Every chunk id still appears in exactly one block.

## Deferred Issues
- `documentVersion` is null in practice: the documents select is pinned by `tests/rag/assemble.test.ts` and the v2 `RankedHit` carries no version. Blocks read `version` from the document row when present. 05-08/05-09 need to source it (add `version` to the select and update the pin, or look it up when writing the record).
- `tests/rag-db/ingestion-ledger-pg.test.mts` ("optional" real-PostgreSQL suite) fails its hook with `pg_ctl: cannot be run as root`; same on trunk. Environmental; the rag-db run reports `# fail 0` for tests.
- `npm run typecheck:new` reports 45 diagnostics, identical on trunk (none in files this plan touched).
- ESLint error `params` unused at `src/lib/rag/v2/result.ts:82` is pre-existing.

## Threat Flags
None. T-05-10: blocks come from the same tenant-scoped rows as the context; no new query (query-count test green); nothing is added to trace payloads. T-05-11: labeler optional; differential, oracle, v2 stage tests and the eval paired gate (all_zero) unchanged.

## Gates
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 224 files, 3390 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: pass
- `node --import tsx --test tests/rag-db/*.test.mts`: 794 pass, 0 fail (optional pg suite hook fails as root, pre-existing)
- `check-rag-boundary` + node test: ok
- `node scripts/check-config.mjs`: ok
- `check-workflows.py`: ok
- `npm run test-rag -- --out eval/out/05-04` and `--fixture-mode ingest --out eval/out/05-04-ingest`: passed, `paired.all_zero` true
- No Python, contracts, env vars or migrations touched.

## Self-Check: PASSED
