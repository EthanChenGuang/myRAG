-- 0305: BEFORE INSERT triggers that keep today's legacy writers valid (Phase 3, F-1).
-- RAG_INGEST_PIPELINE=legacy stays the default writer. It inserts documents with source 'upload' | 'nango' | 'scrape' | 'google-drive'
-- (or none) and no lineage_id or source_key, and chunks with no tenant_key. The triggers fill what is missing and never overwrite a
-- value the writer supplied (a chunk's tenant_key is the exception: it always follows its document), so the unified writer is not
-- affected. Parser stamps are applied only to rows without a lineage_id.

BEGIN;

CREATE OR REPLACE FUNCTION rag_documents_legacy_defaults() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  original_source text;
BEGIN
  IF NEW.lineage_id IS NULL THEN
    NEW.parser_used := COALESCE(NEW.parser_used, 'llamaparse');
    NEW.parser_version := COALESCE(NEW.parser_version, 'legacy');
  END IF;

  IF NEW.source IS NULL OR NEW.source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag') THEN
    original_source := NEW.source;
    IF original_source IN ('google-drive', 'notion', 'dropbox') AND COALESCE(NEW.source_provider, '') = '' THEN
      NEW.source_provider := original_source;
    END IF;
    NEW.source := CASE
      WHEN original_source IN ('google-drive', 'notion', 'dropbox') THEN 'nango'
      WHEN original_source = 'scrape' THEN 'scraper'
      ELSE 'config_upload'
    END;
    IF original_source IS NOT NULL AND (NEW.metadata IS NULL OR NEW.metadata->'legacy_source' IS NULL) THEN
      NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('legacy_source', original_source);
    END IF;
  END IF;

  NEW.lineage_id := COALESCE(NEW.lineage_id, NEW.id);
  NEW.source_key := COALESCE(NEW.source_key, 'legacy:' || NEW.id::text);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION rag_chunks_legacy_defaults() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent record;
  legacy_shape boolean := NEW.tenant_key IS NULL;
BEGIN
  -- SECURITY DEFINER so the lookup does not depend on what the inserting role may read: the chunk's tenant_key is always its document's,
  -- whatever the writer sent. Every other denormalised column only fills a NULL.
  SELECT d.tenant_key, d.version, d.doc_type, d.doc_date, d.language, d.source, d.parser_used
  INTO parent
  FROM documents d
  WHERE d.id = NEW.document_id;
  IF FOUND THEN
    NEW.tenant_key := parent.tenant_key;
    NEW.version := COALESCE(NEW.version, parent.version);
    NEW.doc_type := COALESCE(NEW.doc_type, parent.doc_type);
    NEW.doc_date := COALESCE(NEW.doc_date, parent.doc_date);
    NEW.language := COALESCE(NEW.language, parent.language);
    NEW.source := COALESCE(NEW.source, parent.source);
    NEW.parser_used := COALESCE(NEW.parser_used, parent.parser_used);
  END IF;

  IF legacy_shape AND NEW.chunk_kind = 'text' AND NEW.metadata->'image_url' IS NOT NULL THEN
    NEW.chunk_kind := 'image';
  END IF;
  RETURN NEW;
END
$$;

-- Trigger functions run without an EXECUTE check on the inserting role; nothing but the triggers should be able to name them.
REVOKE ALL ON FUNCTION rag_documents_legacy_defaults() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_chunks_legacy_defaults() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rag_documents_legacy_defaults ON documents;
CREATE TRIGGER rag_documents_legacy_defaults
  BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION rag_documents_legacy_defaults();

DROP TRIGGER IF EXISTS rag_chunks_legacy_defaults ON document_chunks;
CREATE TRIGGER rag_chunks_legacy_defaults
  BEFORE INSERT ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION rag_chunks_legacy_defaults();

-- Rows inserted between 0303 and this file have no identity yet; the NOT NULL below needs them backfilled.
UPDATE documents SET lineage_id = id WHERE lineage_id IS NULL;
UPDATE documents SET source_key = 'legacy:' || id::text WHERE source_key IS NULL;

ALTER TABLE documents ALTER COLUMN lineage_id SET NOT NULL;
ALTER TABLE documents ALTER COLUMN source_key SET NOT NULL;

COMMIT;
