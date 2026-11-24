---
phase: 03-unified-ingestion-embedding-profiles
plan: 41a
type: execute
wave: 8
depends_on: ["03-10", "03-41"]
files_modified:
  - supabase/migrations/0319_document_content.sql
  - src/lib/rag/ingest/writer.ts
  - src/lib/rag/ingest/stages/embed-write.ts
  - tests/rag-db/ingest-writer.test.mts
  - tests/rag-db/schema-migrations.test.mts
  - eval/baselines/fixture-ingest-baseline.json
autonomous: true
requirements: [DATA-01, DATA-02]
---

<objective>
Fix the gap 03-41 measured: unified ingestion leaves `documents.content` empty (`rag_begin_document_version`
inserts `''`, and the `rag_set_document_fields` allow-list in 0310 has no `content`). Legacy retrieval reads
`documents.content` in `src/lib/rag/context/assemble.ts` (`isRelevantByName`, `content_preview`), so unified
documents are filtered harder (ingest-mode recall@5 0.273 vs 0.519) and show no source preview.
</objective>

<tasks>
<task type="tdd" n="1">
<name>Writer stores the parsed text in documents.content</name>
<action>
- New migration `0319_document_content.sql`: CREATE OR REPLACE `rag_set_document_fields` with `content` added to
  the allow-list (text only; non-string refused like other text fields). Keep SECURITY DEFINER, `search_path`,
  the tenant check and every existing field exactly as 0310/later migrations left them (read the latest definition
  first: grep all migrations for the function and copy the newest). Revoke/grant identical to the previous one.
- `writer.ts`: accept `content` in the typed setFields input.
- The write stage (where chunks are written, before publish) sets `content` to the full parsed text the chunker
  consumed (same text legacy stores: the parse result's text), once per document version. A quarantined document
  may carry it; readers already filter status (and 03-37 fixes table RLS).
- RED first: a PGlite test in `tests/rag-db/ingest-writer.test.mts` that ingests a text document and asserts
  `documents.content` equals the parsed text; a second asserts tenant B cannot set `content` on tenant A's document
  (same refusal as other fields). Add 0319 to `schema-migrations.test.mts` the way earlier migrations are listed.
</action>
<verify>RED commit fails on the content assertion; GREEN passes. All rag-db tests pass.</verify>
</task>
<task type="auto" n="2">
<name>Re-record the ingest-mode baseline</name>
<action>
Run `npm run test-rag -- --fixture-mode ingest --out eval/out/p3-content` and expect recall@5 close to prechunked
(about 0.519). Re-record `eval/baselines/fixture-ingest-baseline.json` with the same tool and run count 03-41 used
(`baseline.py record --fixture-mode ingest`, 3 runs). Prechunked baseline must be unchanged.
</action>
<verify>Both `npm run test-rag` modes gate PASS; report the before/after metrics.</verify>
</task>
</tasks>

<operator>Migration 0319 joins the list to apply after 0318.</operator>
