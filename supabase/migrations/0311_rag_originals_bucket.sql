-- 0311: the private rag-originals bucket (Phase 3, D-18 with F-2) and the origin of a document version for resume.
-- Bucket: holds each version's original and parse output at <tenant_key>/<lineage_id>/<version>/<fixed basename>. It is private, capped at
-- 20 MB like the upload limit, and gets no storage.objects policy: with row level security on and no policy, anon and authenticated reach
-- nothing, and only the service key (which bypasses it) reads or writes. Never add a policy for this bucket.
-- rag_get_ingest_origin: lineage_id, original_path, source and source_key of one document, so a resumed run finds its stored original
-- without the caller resending anything. It is a new function beside rag_get_ingest_document (whose result columns stay as 0310 made
-- them, so re-applying 0310 after this file keeps working). Same tenant check: another tenant's id, and an unknown id, return no row.
-- Idempotent: the bucket upsert resets a bucket that was made public or resized; CREATE OR REPLACE with a fixed signature, then REVOKE and GRANT.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('rag-originals', 'rag-originals', false, 20971520)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 20971520;

CREATE OR REPLACE FUNCTION rag_get_ingest_origin(
  p_document_id uuid,
  p_tenant_key text
)
RETURNS TABLE (
  lineage_id uuid,
  original_path text,
  source text,
  source_key text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.lineage_id, d.original_path, d.source, d.source_key
  FROM documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$$;

REVOKE ALL ON FUNCTION rag_get_ingest_origin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_get_ingest_origin(uuid, text) TO service_role;

COMMIT;
