-- 0303: backfill documents.source_key and create the lineage identity index (Phase 3, D-06, D-10).
-- Nango and scraper rows take their source_file_id as source_key on the newest row per (tenant_key, source, source_file_id);
-- older duplicates and every other row get legacy:<id>. The unique index therefore cannot fail on existing duplicates, and the next
-- sync of a file becomes version 2 of its newest legacy row. Hashes are not backfilled here: content_hash comes from one TypeScript
-- normaliser, and file_sha256 stays NULL because the original bytes were never stored.

BEGIN;

WITH ranked AS (
  SELECT id,
         source_file_id,
         row_number() OVER (PARTITION BY tenant_key, source, source_file_id ORDER BY created_at DESC NULLS LAST, id DESC) AS position
  FROM documents
  WHERE source_key IS NULL
    AND source IN ('nango', 'scraper')
    AND source_file_id IS NOT NULL
    AND source_file_id <> ''
)
UPDATE documents d
SET source_key = ranked.source_file_id
FROM ranked
WHERE d.id = ranked.id AND ranked.position = 1;

UPDATE documents SET source_key = 'legacy:' || id::text WHERE source_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS documents_lineage_identity_ux ON documents (tenant_key, source, source_key) WHERE is_current;

COMMIT;
