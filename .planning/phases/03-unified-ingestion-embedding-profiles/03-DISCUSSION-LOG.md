# Phase 3: Unified Ingestion & Embedding Profiles - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-23
**Phase:** 03-unified-ingestion-embedding-profiles
**Mode:** `--auto`. Every gray area was auto-selected and the recommended option chosen, following the user's standing instruction "all questions follow your recommendations". No AskUserQuestion was used.
**Areas discussed:** ingest() shape and rollout; schema and versions; dedup; document types and defaults; parsing and the sidecar job; chunking and section paths; invoices and exact IDs; PDF images; injection quarantine; lexical text; embedding providers and storage; re-embed and activation gate; evaluation; config and endpoints

**Startup checks:**
- No todos matched the phase.
- No SPEC.md was present.
- No USER-PROFILE.md was present, so advisor mode was off.
- The discuss:pre and discuss:post hook lists were empty.

---

## ingest() shape and rollout

| Option | Description | Selected |
|--------|-------------|----------|
| Resumable idempotent stage list on the document row, one `ingest()` | Phase 3.1 can move the state into its ledger and run the same stages from its worker | ✓ |
| Synchronous `ingest()` inside the upload route | Scanned PDFs exceed Vercel's 60 s cap | |
| Introduce a queue now | That is Phase 3.1's scope (DATA-15) | |

**Choice:** [auto] stages plus `resumeIngest`, behind `RAG_INGEST_PIPELINE=legacy|unified` (default `legacy`), with the single-writer rule added to the boundary check. The recommended default was taken.
**Notes:** `ai-to-rag` is also routed through `ingest()`, so `document_chunks` keeps a single writer.

## Schema, identity and versions

| Option | Description | Selected |
|--------|-------------|----------|
| One `documents` row per version, with `lineage_id`, `is_current` and `superseded_by`, plus a publish SQL function | Old citations keep their `document_id` and chunk ids | ✓ |
| A separate `document_versions` table | Every RPC and FK would need rework | |
| Overwrite in place | Breaks citations (DATA-07) | |

**Choice:** [auto] row per version, additive migrations in `supabase/migrations/` that are mirrored into the setup files, and the `is_current AND status='ready'` filter in every retrieval RPC with no switch. The recommended default was taken.

## Dedup

| Option | Description | Selected |
|--------|-------------|----------|
| File hash to skip parsing, plus a normalized content hash as the dedup authority, both tenant-scoped | Cheap, and needed by Phase 3.1's parse cache | ✓ |
| Content hash only | Every duplicate is parsed again | |
| File hash only | A re-export of the same document would not match | |

**Choice:** [auto] both hashes, compared within `tenant_key` only. The recommended default was taken.

## Document types and defaults

| Option | Description | Selected |
|--------|-------------|----------|
| Profiles in a committed JSON file validated by Pydantic, and defaults in a DB table | Profile edits stay v2 (OPS-03); defaults are editable now (DATA-10) | ✓ |
| Profiles in the DB | Editable profiles would be scope creep | |
| Profiles as TypeScript branches | Violates DATA-04, which requires profiles defined as data | |

| Auto-detect | Description | Selected |
|--------|-------------|----------|
| Rules first, with an optional LLM detector behind a switch (default off) | Deterministic and testable without keys | ✓ |
| LLM by default | Needs keys and eval evidence first | |

**Choice:** [auto] six type ids. Precedence: picked type, then Nango folder, then Nango connection, then source, then tenant, then `general`. A type change re-ingests as a new version from the stored original or the stored parse output.

## Parsing and the sidecar job

| Option | Description | Selected |
|--------|-------------|----------|
| Sidecar async job API, with the app polling inside a 45 s budget and otherwise resuming later | Respects the 60 s cap and keeps the sidecar stateless | ✓ |
| The sidecar writes results to Supabase itself | Gives the sidecar database credentials; deferred to the 3.1 worker | |
| Synchronous parse call | Scanned PDFs time out | |

**Choice:** [auto] `RAG_PARSER` defaults to `llamaparse`, falls back to Docling and then to plain text. Docling uses HybridChunker with repeated table headers and the `cl100k_base` tokenizer on both sides. OCR covers zh, en and it, and the researcher picks the engine. CI runs on recorded Docling outputs, with an optional nightly real-Docling job.

## Chunking and section paths

| Option | Description | Selected |
|--------|-------------|----------|
| Build the embedding text from stored columns with a versioned template, keeping the LLM content plain | EMB-04 can re-embed without re-parsing; follows CHK-01 | ✓ |
| Store the prefixed embedding text as its own column | Duplicates storage, and the template can drift | |

**Choice:** [auto] the legal clause patterns are stored as data in the profile. The exception lead-in and its list are kept in one chunk, and an over-long clause is split by item with its heading on every piece.

## Invoices and exact IDs

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic sidecar extractor (tax-ID checksums, zh/en/it labels) with an optional LLM fill-in | Testable offline; Pydantic-native | ✓ |
| LLM extraction by default | Needs keys; nondeterministic in CI | |

| Exact invoice-number retrieval | Description | Selected |
|--------|-------------|----------|
| Optional `exact_id_lookup` stage on promoted columns, within scope | Meets success criterion 9 before Phase 4's hybrid search exists | ✓ |
| Wait for Phase 4 lexical search | Success criterion 9 could not be met in Phase 3 | |

**Choice:** [auto] promoted invoice columns with tenant-leading indexes, plus `findInvoices(scope, filters)`.

## PDF images

| Option | Description | Selected |
|--------|-------------|----------|
| Image chunks on the same document and version, captioned by the existing image-RAG captioning | `source_images` stays unchanged | ✓ |
| A separate image document per picture | Breaks the page and document link (DATA-11) | |

**Choice:** [auto] behind `RAG_PDF_IMAGE_CHUNKS`, with size and count limits.

## Injection quarantine

| Option | Description | Selected |
|--------|-------------|----------|
| Write the chunks with status `quarantined`, excluded by the retrieval filter; release flips the status | Release needs no reprocessing | ✓ |
| Do not write the chunks until released | Release would need a full re-ingest | |

**Choice:** [auto] the scanner sits behind `RAG_INJECTION_SCAN=off|quarantine` (default `off`). The exclusion filter has no switch, because it is a security control. The admin routes require `admin_users`.

## Lexical text

| Option | Description | Selected |
|--------|-------------|----------|
| Shared application tokenizer (`Intl.Segmenter` for zh, folding for en and it) writing `lexical_text` with a version | Resolves the research conflict, follows ARCHITECTURE and PITFALLS, and works the same on all backends | ✓ |
| PGroonga plus language `tsvector` | Postgres only; Weaviate and Qdrant behave differently | |

**Choice:** [auto] Phase 3 writes the field. Phase 4 adds the index, the query side and the zh exact-term test.

## Embedding providers and storage

| Option | Description | Selected |
|--------|-------------|----------|
| Keep the legacy column for the OpenAI 1536 profile; put new profiles in one `chunk_embeddings` table with a partial expression HNSW index per profile | Legacy is untouched, and storage is side by side (EMB-02) | ✓ |
| One table per profile | More DDL per profile, and RPCs multiply | |
| Move the legacy vectors into `chunk_embeddings` | Risks legacy parity and needs a costly migration | |

| Active pointer | Description | Selected |
|--------|-------------|----------|
| DB `embedding_profiles` row with SQL activate and rollback functions, gated by `RAG_EMBEDDING_PROFILES=off|on` | The gate can check completeness atomically | ✓ |
| An env var naming the profile | No atomic completeness check; needs a redeploy to flip | |

**Choice:** [auto] Voyage and Qwen3 at 2048 dims in `halfvec`; the researcher may choose 1024. Mismatch checks run at startup (`src/instrumentation.ts`) and on every request. A mismatch fails retrieval loudly but does not crash the app.

## Re-embed and activation gate

| Option | Description | Selected |
|--------|-------------|----------|
| TS module with a cursor table, upsert batches and dry-run cost, with `reprocess-documents.js --reembed` delegating to it | Resumable, rollbackable and testable; extends the script as EMB-04 says | ✓ |
| Rewrite `reprocess-documents.js` in JS | It would duplicate the TS embedding providers | |

**Choice:** [auto] dual-write to every backfilling profile. Activation refuses unless all three hold: 100% coverage in the same transaction, passing eval evidence with a `pre_migration` slice, and matching model and dims on every row.

## Evaluation

| Option | Description | Selected |
|--------|-------------|----------|
| Keep the `prechunked` fixture mode for parity, and add an `ingest` mode that runs the real `ingest()` with fakes | Baseline continuity, plus a real test of ingestion | ✓ |
| Switch the fixture to `ingest` only | Breaks the Phase 1 and 2 baseline comparability | |

**Choice:** [auto] `cross_lingual` with at least 4 items per direction pair, `evidence_language`, `by_language_pair`, and gating per slice and per pair. Per-profile runs use fake Voyage and Qwen endpoints, and the real ranking decision is live verification.

## Config and endpoints

**Choice:** [auto] new env vars with off or legacy defaults in the five config locations, marked `managed` in env-manifest. Authenticated `/api/rag/*` and `/api/rag/admin/*` routes. Three Config UI panels: document types, quarantine and embedding profiles. One Langfuse ingestion trace per document.

---

## Claude's Discretion

- File layout inside `src/lib/rag/ingest/`.
- Keyword lists and the starter injection rules beyond the examples.
- Localized labels.
- Image size and count thresholds, and the poll backoff schedule.
- SQL function names.

## Deferred Ideas

- Editing profiles in the Config UI (OPS-03).
- Version-history UI (UX-06).
- Filter chips (UX-05).
- Removing the legacy writers after Phase 7.
- Replacing `exact_id_lookup` with lexical search.
- LLM detection and extraction as the default.
- Per-tenant embedding profiles (out of scope).
- Retention and GC of superseded versions.
