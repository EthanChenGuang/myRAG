-- 0721 (single-tenant): rag_nango_owner_tenant_key, the tenant key of a Nango connection owner's documents (D-41, D-43).
-- Matches scopeKey(nangoOwnerScope) in src/lib/rag/tenant/ingest-scope.ts; single-tenant: every connection belongs to s:default.
-- Service role only. Idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_nango_owner_tenant_key(p_user_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT 's:default'::text;
$$;

REVOKE ALL ON FUNCTION public.rag_nango_owner_tenant_key(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_nango_owner_tenant_key(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
