## Deferred Items

- 03-41: documents.content stays empty under unified ingestion, which the legacy retrieval relevance filter reads.
  status: open
  - Found by the ingest-mode eval run: recall@5 0.273 against 0.519 for the same corpus as pre-cut rows. Setting `documents.content` to the parsed text after ingestion (experiment, not committed) gives 0.519 / MRR 0.526 / false refusal 0.377 and the same per-item results, so this column is the whole difference.
  - Cause: `rag_begin_document_version` inserts `content = ''` and the `rag_set_document_fields` allow-list (migration 0310) has no `content`. `src/lib/rag/context/assemble.ts` (`isRelevantByName`, `content_preview`) and `src/lib/rag/refs/resolve.ts` (`content_preview`) read `documents.content`; the legacy post-filter keeps a chunk when a query term appears anywhere in its document's text, so unified documents lose that path.
  - Where to fix: the writer (allow `content` in `rag_set_document_fields`, or set it in `rag_begin_document_version`) plus the extract or publish stage that has the parse text, then re-record `eval/baselines/fixture-ingest-baseline.json` (plan 03-44 re-records it anyway). Not fixed in 03-41: it changes a SECURITY DEFINER writer function and a migration, outside this plan's files.
