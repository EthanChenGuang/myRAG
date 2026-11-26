-- 0945: tenant resolution for the security-events admin routes (Phase 5.2, plan 05.2-18, SEC-10, D-47).
-- rag_security_admin_keys(p_actor, p_deployment_admin) returns the tenant keys whose security events, alerts and holds the actor may read
-- and act on. A deployment admin (the route verified the admin session; admin_users is checked again here) gets s:default in a
-- single-tenant database and every tenant key that has an event, alert or hold in a multi-tenant one. Anyone else gets, in a multi-tenant
-- database, the organizations they are owner or admin of plus the tenants they were granted as domain expert (the Phase 5.1.1 D-16 rule),
-- and in a single-tenant database s:default only through an explicit expert grant. A personal workspace (u:) is never an organization
-- admin's. rag_security_uploader_in_tenant tells whether a user is an uploader of the tenant (an event, alert, hold or document there), so
-- a hold or release on a user unrelated to the tenant answers not found. Both are SECURITY INVOKER with an empty search_path and
-- service_role only (locked again in 0410); they return keys and a boolean, never text. Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_security_admin_keys(p_actor uuid, p_deployment_admin boolean)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_multi_tenant boolean;
  v_keys text[] := '{}'::text[];
BEGIN
  IF p_actor IS NULL THEN
    RETURN v_keys;
  END IF;
  v_multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );

  IF COALESCE(p_deployment_admin, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
      RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
    END IF;
    IF NOT v_multi_tenant THEN
      RETURN ARRAY['s:default'];
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(k.tenant_key ORDER BY k.tenant_key COLLATE "C"), '{}'::text[]) INTO v_keys
    FROM (
      SELECT e.tenant_key FROM public.rag_security_events e
      UNION
      SELECT a.tenant_key FROM public.rag_security_alerts a
      UNION
      SELECT h.tenant_key FROM public.rag_uploader_holds h
    ) k
    WHERE k.tenant_key ~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    RETURN v_keys;
  END IF;

  IF NOT v_multi_tenant THEN
    IF EXISTS (SELECT 1 FROM public.rag_domain_experts x WHERE x.tenant_key = 's:default' AND x.user_id = p_actor) THEN
      RETURN ARRAY['s:default'];
    END IF;
    RETURN v_keys;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(k.tenant_key ORDER BY k.tenant_key COLLATE "C"), '{}'::text[]) INTO v_keys
  FROM (
    SELECT 'o:' || m.organization_id::text AS tenant_key
    FROM public.organization_members m
    WHERE m.user_id = p_actor AND m.role IN ('owner', 'admin')
    UNION
    SELECT x.tenant_key FROM public.rag_domain_experts x WHERE x.user_id = p_actor
  ) k
  WHERE k.tenant_key ~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  RETURN v_keys;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_security_uploader_in_tenant(p_tenant_key text, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.rag_security_events e WHERE e.tenant_key = p_tenant_key AND e.uploader_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.rag_security_alerts a WHERE a.tenant_key = p_tenant_key AND a.uploader_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.rag_uploader_holds h WHERE h.tenant_key = p_tenant_key AND h.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.documents d WHERE d.tenant_key = p_tenant_key AND d.user_id = p_user_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_security_admin_keys(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_security_uploader_in_tenant(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_security_admin_keys(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_security_uploader_in_tenant(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
