-- 0301 (multi-tenant): tenant_key is o:<organization_id> for an organization row and u:<user_id> for a personal row.
-- Same semantics as scopeKey() and as the predicate of match_documents_by_workspace.
-- Adding a stored generated column rewrites the table once; run it in a quiet window on a large project.

BEGIN;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS tenant_key text GENERATED ALWAYS AS (
  CASE WHEN organization_id IS NOT NULL THEN 'o:' || organization_id::text ELSE 'u:' || user_id::text END
) STORED;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_file_sha256 ON documents (tenant_key, file_sha256);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_content_hash ON documents (tenant_key, content_hash);

COMMIT;
