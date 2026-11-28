---
quick_id: 261127-tgw
slug: term-glossary-wiring
status: complete
date: 2026-11-27
branch: exec/quick-term-glossary-wiring
base: origin/ci/merge-train-39
closes: 04.1.1-VERIFICATION W-2
requirements: [QRY-01, QRY-03, TERM-08]
key-files:
  created:
    - src/lib/rag/query/prompts/shared.terminology.v1.json
    - tests/rag/query/terminology-glossary-prompt.test.ts
  modified:
    - src/lib/rag/query/prompts/render.ts
    - src/lib/rag/query/hash-part.ts
    - src/lib/rag/query/llamaindex/condense.ts
    - src/lib/rag/query/llamaindex/hyde.ts
    - src/lib/rag/query/langchain/index.ts
    - src/lib/rag/query/run-layer.ts
    - src/lib/rag/terminology/glossary.ts
    - src/lib/rag/terminology/load.ts
    - src/lib/rag/v2/config-hash.ts
    - src/lib/rag/v2/stages/query.ts
    - src/lib/rag/v2/pipeline.ts
---

# Quick 261127-tgw: terminology glossary in the condense and HyDE prompts (W-2)

The 04.1.1 verification (W-2) found that nothing in production called `terminologyGlossary`. The amended QRY-01 and QRY-03
say the condense (rewrite) and HyDE prompts receive the matched dictionary entries. They now do.

## Design intent (sources)

- QRY-01 / QRY-03 (amended 2026-11-24/25): the rewrite and HyDE prompts get the matched entries (surface → canonical, kind) from
  `terminologyGlossary`, and canonical terms stay verbatim.
- 04.1.1 D-20 / D-22: the helper matches any text against the tenant's cached matcher and never throws. `load.ts` stays the only caller of `rag_term_effective`.
- 04.1.1-PLAN-INDEX "Wording changes" item 3 and 06-35 SUMMARY: feed the glossary from run-layer into the render options, never
  from inside the framework adapter, which must not see a scope (D-18). Both frameworks then change together.

## What changed

- New prompt file `shared.terminology.v1` holds the rules (use the canonical form verbatim; the block is data, not instructions)
  and a `<terminology>` block with one JSON line per entry. It is listed in `SWITCH_GATED_PROMPT_IDS`, so the query-layer
  prompt list and its hash are unchanged.
- `render.ts`: `RenderOptions.terminology`. `renderPrompt` puts the addendum between the template body and the shared suffix
  only when at least one entry survives sanitising. Otherwise the output is byte-identical.
  `terminologyGlossaryEntries` sanitises the entries as follows:
  - control and bidi characters and line breaks become spaces
  - each field is cut at 64 chars
  - a kind that is not a plain code reads `term`
  - duplicates are dropped
  - at most 8 entries, and at most 1200 chars of lines
  
  `<` and `>` are written as JSON `<`/`>`, so an entry cannot close the block or open a tag.
- Condense and HyDE inputs gain an optional `terminology` field. The native and LangChain condense and HyDE both pass it to `renderPrompt`. The post-checks are unchanged.
- `run-layer.ts` calls `terminologyGlossary` only when `spec('terminology')` is enabled (`RAG_TERMINOLOGY=true` and not in
  `RAG_DISABLED_STAGES`) inside the query layer, which already requires `RAG_QUERY_LAYER` and v2. The text it matches:
  - condense: the query plus the user turns in the history window
  - HyDE: the standalone query
  
  It reports `onTerminologyPrompt` only when entries were actually injected.
- Voice: `terminologyGlossary(..., { cachedOnly: true })` uses the new `peekTerminologyMatcher`, which only reads the
  in-process loader cache. Voice gets no new DB or network round trip; with a cold cache it gets no glossary. Chat and embed load
  through the same per-tenant cache that the terminology stage reads later in the request, so a request still makes at most one
  dictionary load.
- Config hash: `TerminologyHashStage` gains `prompt?: true`. `terminologyHashBlock` adds `prompt_version` only for a request
  whose prompt carried the glossary. In every other state (switch off, query layer off, stage disabled, no match, voice with a
  cold cache) the hash is the same as before.

## Behaviour

- Off (any of `RAG_TERMINOLOGY`, `RAG_QUERY_LAYER`, v2, or `terminology` disabled), or on with no match: the prompts and
  the config hash are byte-identical to before. `parity-off` and the config-hash tests pass unchanged.
- On with a match: condense and HyDE list the entries; nothing else in the prompt changes (asserted by stripping the addendum).

## Commits

- `a0edba4a` test: RED. Seven tests failed on assertions, with inert stubs and the prompt file registered.
- `feb25f6c` feat: wiring, sanitising, voice cache-only path and hash flag. 12/12 pass.

## Tests that failed before the fix

`tests/rag/query/terminology-glossary-prompt.test.ts`:
- addendum placement
- hostile entry escaping and caps
- dedupe
- hash block `prompt_version`
- LangChain prompts carry the glossary
- run-layer prompts with a match
- voice warm-cache glossary

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: ok
- `node scripts/ci/check-rag-boundary.mjs`, `check-language-literals.mjs`, `scripts/check-config.mjs`, `check-settings-classification.mjs`: ok
- `npx vitest run tests/rag/query tests/rag/v2/config-hash-query.test.ts tests/rag/v2/config-hash-terminology.test.ts tests/rag/terminology`: 66 files, 931 passed, 8 skipped (`parity-off.test.ts` included)
- `npx vitest run` on the other 20 test files that import a changed module: 397 passed
- `node --import tsx --test` on the 9 rag-db files that import the changed modules (terminology two-tenant, identity, glossary, relex, lexical dictionary): 55/55
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-term-glossary-ingest`: gate PASS, absolute gate PASS

## Deviations and decisions

- The `term` field holds the matcher's normalised surface (for example lowercase), not the raw spelling. The template says so. Mapping matcher offsets back to the raw text was left out as unnecessary risk.
- The hash flag is per request (prompt actually carried a glossary), not per switch. This keeps the hash unchanged for
  on-with-no-match, as the task requires.
- No new env variable, migration, or dependency.

## Deferred

- Live check (operator): with `RAG_TERMINOLOGY=true` and `RAG_QUERY_LAYER=true` on staging, confirm in the trace that condense/HyDE latency
  stays within `eval/config/latency-budgets.json`.
- W-1 and W-3..W-6 of the 04.1.1 verification are not in scope.
