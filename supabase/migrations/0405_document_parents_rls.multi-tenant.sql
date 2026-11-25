-- 0405 (multi-tenant): document_parents SELECT policy mirrors document_chunks.

BEGIN;

DROP POLICY IF EXISTS "Users can view document_parents" ON document_parents;
CREATE POLICY "Users can view document_parents" ON document_parents
  FOR SELECT USING (
    is_current
    AND EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_parents.document_id AND d.is_current AND d.status = 'ready'
    )
    AND (
      document_id IN (
        SELECT doc.id FROM documents doc
        WHERE doc.user_id = auth.uid() AND doc.organization_id IS NULL
      )
      OR (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

COMMIT;