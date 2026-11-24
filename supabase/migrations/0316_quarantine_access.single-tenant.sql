-- 0316 (single-tenant): close the direct read of quarantined rows through the tables (Phase 3, D-08, SEC-01).
-- Today documents and document_chunks have FOR SELECT USING (true): anyone holding the public anon key reads every row through PostgREST,
-- quarantined text included, and the search functions that run as the caller (match_document_chunks, search_chunks_by_keywords and the
-- others) follow the same policy. The policies below show a row only when it is current and ready; a chunk also needs its document to be
-- visible, so a chunk whose copy of the status drifted never shows a quarantined document. Server code reads with the service role, which
-- bypasses RLS, so retrieval, the admin routes and the dashboard are unchanged; a stored citation still resolves through the by-id
-- reads of the service role. get_document_chunks was executable by anon and has no caller: it is revoked and also filtered.
-- Idempotent: DROP POLICY IF EXISTS then CREATE POLICY, CREATE OR REPLACE with a fixed signature, then REVOKE and GRANT.

BEGIN;

-- An old install can still carry the permissive FOR ALL policy that the setup file drops; permissive policies are ORed, so it would
-- reopen the read.
DROP POLICY IF EXISTS "Allow full access to authenticated users" ON documents;
DROP POLICY IF EXISTS "Allow full access to authenticated users" ON document_chunks;

DROP POLICY IF EXISTS "Allow read access to anonymous users" ON documents;
CREATE POLICY "Allow read access to anonymous users" ON documents
  FOR SELECT USING (is_current AND status = 'ready');

DROP POLICY IF EXISTS "Allow read access to anonymous users" ON document_chunks;
CREATE POLICY "Allow read access to anonymous users" ON document_chunks
  FOR SELECT USING (
    is_current AND status = 'ready'
    AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_chunks.document_id)
  );

CREATE OR REPLACE FUNCTION get_document_chunks(
  doc_id UUID
)
RETURNS TABLE (
  chunk_id UUID,
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.content,
    dc.metadata,
    dc.created_at
  FROM document_chunks dc
  WHERE dc.document_id = doc_id AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION get_document_chunks(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_document_chunks(uuid) TO service_role;

COMMIT;
