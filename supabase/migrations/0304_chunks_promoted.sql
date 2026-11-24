-- 0304: promoted and denormalised document_chunks columns (Phase 3, D-07).
-- tenant_key, version, is_current, status, doc_type, doc_date, language, source and parser_used mirror the parent document so that
-- retrieval can filter without a join. Existing chunks copy them from their document; chunks written later by a legacy writer get them
-- from the trigger in 0305. section_path, lexical_text and embedding_text_version are filled by the unified writer; embedding_text_version
-- 0 means "legacy text, no path prefix". No lexical_text index here: that belongs to hybrid search.

BEGIN;

ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS tenant_key text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS version integer;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS doc_type text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS doc_date date;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS page_start integer;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS page_end integer;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS section_path text[] NOT NULL DEFAULT '{}';
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS chunk_kind text NOT NULL DEFAULT 'text';
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS parser_used text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding_text_version integer NOT NULL DEFAULT 0;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS lexical_text text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS chunk_index integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.document_chunks') AND conname = 'document_chunks_status_check') THEN
    ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_status_check
      CHECK (status IN ('processing', 'ready', 'quarantined', 'failed', 'deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.document_chunks') AND conname = 'document_chunks_chunk_kind_check') THEN
    ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_chunk_kind_check
      CHECK (chunk_kind IN ('text', 'table', 'image', 'invoice_header'));
  END IF;
END $$;

-- Existing chunks copy the denormalised values of their document; a chunk with an image URL is an image chunk.
UPDATE document_chunks dc
SET tenant_key = d.tenant_key,
    version = d.version,
    is_current = d.is_current,
    status = d.status,
    doc_type = d.doc_type,
    doc_date = d.doc_date,
    language = d.language,
    source = d.source,
    parser_used = d.parser_used,
    chunk_kind = CASE WHEN dc.metadata->'image_url' IS NOT NULL THEN 'image' ELSE dc.chunk_kind END
FROM documents d
WHERE d.id = dc.document_id AND dc.tenant_key IS NULL;

-- Every vector row records its model: the legacy column always holds text-embedding-3-small at 1536 dimensions.
UPDATE document_chunks
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536)
WHERE embedding IS NOT NULL AND (metadata IS NULL OR metadata->'embedding_model' IS NULL);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document_chunk_index ON document_chunks (document_id, chunk_index);

COMMIT;
