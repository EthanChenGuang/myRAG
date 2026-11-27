-- 0920 (single-tenant): every group belongs to the one tenant. tenant_key is generated as the constant s:default, the single-tenant
-- scopeKey(), so no row can name another tenant; (tenant_key, key) is unique (D-01). Any auth.users row can be a member. Idempotent.

BEGIN;

ALTER TABLE public.rag_access_groups ADD COLUMN IF NOT EXISTS tenant_key text GENERATED ALWAYS AS ('s:default'::text) STORED;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_access_groups'::regclass AND conname = 'rag_access_groups_tenant_key_key'
  ) THEN
    ALTER TABLE public.rag_access_groups
      ADD CONSTRAINT rag_access_groups_tenant_key_key UNIQUE (tenant_key, key);
  END IF;
END
$do$;

NOTIFY pgrst, 'reload schema';

COMMIT;
