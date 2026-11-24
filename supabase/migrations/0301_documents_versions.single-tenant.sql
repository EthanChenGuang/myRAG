-- 0301 (single-tenant): tenant_key is the constant s:default, the same key scopeKey() gives a single scope.
-- Adding a stored generated column rewrites the table once; run it in a quiet window on a large project.

BEGIN;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS tenant_key text GENERATED ALWAYS AS ('s:default'::text) STORED;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_file_sha256 ON documents (tenant_key, file_sha256);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_content_hash ON documents (tenant_key, content_hash);

COMMIT;
