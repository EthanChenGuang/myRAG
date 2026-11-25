-- 0316 (multi-tenant): close the direct read of quarantined rows through the tables (Phase 3, D-08, SEC-01).
-- The owner of a personal document and the members of an organization can read their rows through PostgREST, quarantined text included,
-- and the search functions that run as the caller follow the same policy. The policies below keep the ownership and membership rules
-- exactly as they are and add one condition: the row is current and ready. A chunk also needs its document to be visible, so a chunk whose
-- copy of the status drifted never shows a quarantined document. Server code reads with the service role, which bypasses RLS, so
-- retrieval, the admin routes and the dashboard are unchanged; a stored citation still resolves through the by-id reads of the service role.
-- Idempotent: DROP POLICY IF EXISTS then CREATE POLICY.

BEGIN;

DROP POLICY IF EXISTS "Allow full access to authenticated users" ON documents;
DROP POLICY IF EXISTS "Allow full access to authenticated users" ON document_chunks;

DROP POLICY IF EXISTS "Users can view documents" ON documents;
CREATE POLICY "Users can view documents" ON documents
  FOR SELECT USING (
    is_current AND status = 'ready'
    AND (
      -- Personal documents (flat workspace)
      (user_id = auth.uid() AND organization_id IS NULL)
      OR
      -- Organizational documents (personal projects + teams)
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Users can view chunks" ON document_chunks;
CREATE POLICY "Users can view chunks" ON document_chunks
  FOR SELECT USING (
    is_current AND status = 'ready'
    AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_chunks.document_id)
    AND (
      -- Personal chunks (via document ownership)
      document_id IN (
        SELECT id FROM documents
        WHERE user_id = auth.uid() AND organization_id IS NULL
      )
      OR
      -- Organizational chunks
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

COMMIT;
