-- 0403 (multi-tenant): central tenant-key guard for Phase 4 service-role functions (D-04, F-12).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_assert_tenant_key(p_tenant_key text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_tenant_key IS NULL OR p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'malformed tenant key' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key = 's:default' THEN
    RAISE EXCEPTION 'tenant key not valid for this deployment mode' USING ERRCODE = '22023';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.rag_assert_tenant_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_assert_tenant_key(text) TO service_role;

COMMIT;