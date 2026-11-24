-- 0301: document identity, versions, status, type, hashes, parser and profile columns (Phase 3, D-06).
-- Additive and idempotent. Existing rows become version 1, current, ready, type general, their own lineage, parsed by the legacy parser.
-- Run after the setup file; the tenant_key column and its indexes are in 0301_documents_versions.<mode>.sql, which runs right after this file.

BEGIN;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS lineage_id uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS superseded_by uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_status text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_type text NOT NULL DEFAULT 'general';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_type_origin text NOT NULL DEFAULT 'fallback';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_date date;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_sha256 text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parser_used text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parser_version text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_profile_id text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_profile_version integer;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_path text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.documents') AND conname = 'documents_status_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_status_check
      CHECK (status IN ('processing', 'ready', 'quarantined', 'failed', 'deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.documents') AND conname = 'documents_doc_type_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_doc_type_check
      CHECK (doc_type IN ('financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.documents') AND conname = 'documents_doc_type_origin_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_doc_type_origin_check
      CHECK (doc_type_origin IN ('picked', 'source_default', 'tenant_default', 'auto', 'fallback'));
  END IF;
END $$;

-- Rows that have no lineage yet are pre-Phase-3 rows: each is its own lineage, parsed by the legacy parser.
-- parser_used and parser_version are only stamped here, so rows written later keep what their writer recorded.
UPDATE documents
SET lineage_id = id,
    parser_used = COALESCE(parser_used, 'llamaparse'),
    parser_version = COALESCE(parser_version, 'legacy')
WHERE lineage_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS documents_lineage_version_ux ON documents (lineage_id, version);

COMMIT;
