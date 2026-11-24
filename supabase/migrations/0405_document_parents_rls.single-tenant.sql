-- 0405 (single-tenant): document_parents SELECT policy mirrors document_chunks.

BEGIN;

DROP POLICY IF EXISTS "Allow read access to anonymous users" ON document_parents;
CREATE POLICY "Allow read access to anonymous users" ON document_parents
  FOR SELECT USING (
    is_current
    AND EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_parents.document_id AND d.is_current AND d.status = 'ready'
    )
  );

COMMIT;