# Phase 3.2 all-off parity (plan 03.2-66, D-46)

Result: PASS. With every Phase 3.2 variable absent, ingestion and retrieval equal the tree before the phase, apart from the additive fields listed below.

Recorded on 2026-11-26 on branch `exec/03.2-66` (base `ci/merge-train-24`).

## What is compared

`tests/rag-e2e/phase32-all-off.test.mts` runs one probe (`tests/rag-e2e/phase32-all-off-probe.mts`) and compares it with `tests/fixtures/ingest/phase32-all-off-reference.json`, which the same probe recorded on `0e740fc5`, the trunk commit just before the first Phase 3.2 commit (`48dcc7d6`). The probe:

- ingests the fixture corpus as it was on `0e740fc5` (14 corpus files pinned by sha256, 12 typed fixtures, 5 parse fixtures; the 6 corpus files added later are left out) through the unified pipeline, inline and through the queue (`fixed` routing, sidecar worker);
- reads every column of `documents` and `document_chunks` (ids replaced by source, source key and version; vectors hashed; wall-clock values masked);
- counts the rows of every public table;
- records every HTTP call outside Supabase (sidecar routes and model endpoints) during each build;
- runs one single-turn question per golden category (11 questions) through `runRetrieval` under the legacy pipeline and under v2.

The test asserts:

- every column that existed before the phase holds the recorded value, on both paths (30 documents, 116 chunks each);
- every column added since holds its default, apart from the additive fields;
- no table created since holds a row, no other table's row count changes, and the inline path writes no ledger row;
- the builds make the same external calls (17 parse jobs and their polls, artifact reads and deletes) and none to `/v1/hidden-text` or `/v1/embed`;
- legacy and v2 give the same status, reason, context hash, `source_images` count, candidates and `retrievalConfigHash` for every question.

## Additive fields (written with the switches off)

| Field | Plan | Why it is additive |
|---|---|---|
| `documents.ingest_fingerprint` | 03.2-17 | Fingerprint of each published unified-pipeline version (LANG-04). |
| `documents.metadata.ingest_fingerprint_parts` | 03.2-17 | The parts the fingerprint was built from. |
| `documents.processing_state.parserVersion` (inline path) | 03.2-17 | Parser version kept in the run state so that a resumed run can build the fingerprint. |
| `documents.effective_from`, `effective_to`, `effective_dates_origin`, `effective_dates_confidence`; `document_chunks.effective_from`, `effective_to` | 03.2-47 | Effective dates found by rule. No retrieval reads them while `RAG_EFFECTIVE_DATES` is false. No fixture document states a date, so they are empty here. |

No other difference was found, so no plan of this phase needed a fix.

## Differences that come from other phases

- v2 candidate list: since `e4126753` (plan 04.1-15), a request's `max_results` caps the final v2 list. Before that, a refused request returned the whole pre-refusal pool (75 candidates). I found this commit by bisecting first the merge trains and then train 20 (`52bbbb70`). The probe asks for 100 results, which is more than the pool holds, so the cap removes nothing in either tree.
- Candidates with equal scores come back in random order, because the chunk ids are random. The test compares candidates as sets above the pool's lowest similarity, and only their number at that lowest similarity. Status, context and hash are compared exactly.
- `embedding_profiles` has three more rows. Migration 0440 (Phase 3.1.1) seeds them; no write path adds them.

## Commands

| Command | Exit | Result |
|---|---|---|
| `node --import tsx --test tests/rag-e2e/phase32-all-off.test.mts` | 0 | 14/14 pass |
| `node --import tsx --test tests/rag-e2e/defaults-equal-phase3.test.mts` | 0 | 12/12 pass (now also clears the eighteen Phase 3.2 variables and checks their off values) |
| `node --import tsx --test tests/rag-legacy-differential.test.mts` | 0 | 5/5 pass |
| `npx vitest run tests/rag/characterize-chat.test.ts tests/rag/characterize-embed.test.ts tests/rag/characterize-voice.test.ts` | 0 | 14 pass, 4 skipped (the "defaulted v2" cases run only while v2 is the shipped default; Phase 4.1 did not flip it) |
| `npx vitest run tests/rag/legacy-llamaparse-language.test.ts tests/routes/process-document-language-aware.test.ts tests/rag/single-tenant-writes.test.ts tests/routes/languages-not-configured.test.ts` | 0 | 51/51 pass (legacy writers) |
| `npm run test-rag -- --out eval/out/smoke` | 0 | gate PASS, all paired differences zero |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/smoke-ingest` | 0 | gate PASS, all paired differences zero |

## Not covered by the probe

The legacy ingestion writers (`processDocument` behind the knowledge-base, chat and Nango routes with `RAG_INGEST_PIPELINE=legacy`) insert rows through PostgREST, and the fixture edge serves RPCs only. They are covered by the legacy-writer tests in the table above. Phase 3.2 changed them in only two places: the LlamaParse language codes (03.2-24) and the scope tags chosen at upload (03.2-43). Both behave as before when no language is set and no tag is chosen.
