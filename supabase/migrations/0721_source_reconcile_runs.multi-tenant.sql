-- 0721 (multi-tenant): rag_nango_owner_tenant_key, the tenant key of a Nango connection owner's documents (D-41, D-43).
-- Matches scopeKey(nangoOwnerScope) in src/lib/rag/tenant/ingest-scope.ts; multi-tenant: a connection's documents are personal documents of its owner, u:<owner>.
-- Service role only. Idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_nango_owner_tenant_key(p_user_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN p_user_id IS NULL THEN NULL ELSE 'u:' || lower(p_user_id::text) END;
$$;

REVOKE ALL ON FUNCTION public.rag_nango_owner_tenant_key(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_nango_owner_tenant_key(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
