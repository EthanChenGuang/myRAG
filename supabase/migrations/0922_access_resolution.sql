-- 0922: access resolution helpers (Phase 4.3, D-09, D-10, A-02, A-03).
-- rag_access_enforced() returns the enforced flag of the single rag_access_group_settings row (0920), false when the row is missing. It is
-- STABLE SECURITY DEFINER (the settings table is service_role only) with an empty search_path. hybrid_search_chunks (0930) raises
-- access_scope_required when it is true and no access keys were sent. Executable by service_role only here; the RLS plan (04.3-06) grants it
-- to the client roles. Not folded into the setup files. Idempotent.
-- Plan 04.3-05 completes the file with the service-role functions the phase calls. Each takes the tenant key first and opens with
-- rag_assert_tenant_key; the tenant mode is read from the key prefix (o:, s:, u:), so the file has no mode variant. All are SECURITY INVOKER
-- except rag_access_user_in_tenant (DEFINER: it reads auth.users) and every one is executable by service_role only.
-- rag_resolve_access_scope(tenant, user): is_admin (o: owner or admin of the organization, s: admin_users, u: the owner), the caller's group
-- ids in this tenant (an o: tenant also requires the organization membership) and the effective keys: all plus each of u:<user> and
-- g:<group> that labels at least one current document of the tenant (A-05). rag_access_group_by_key(tenant, key) serves the embed scope.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_access_enforced()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT COALESCE((SELECT s.enforced FROM public.rag_access_group_settings s WHERE s.id), false)
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_enforced() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO service_role;


CREATE OR REPLACE FUNCTION public.rag_resolve_access_scope(p_tenant_key text, p_user_id uuid)
RETURNS TABLE (is_admin boolean, group_ids uuid[], effective_keys text[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_prefix text;
  v_tenant_id uuid;
  v_admin boolean := false;
  v_member boolean := false;
  v_groups uuid[] := '{}'::uuid[];
  v_keys text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, '{}'::uuid[], ARRAY['all']::text[];
    RETURN;
  END IF;
  v_prefix := pg_catalog.left(p_tenant_key, 2);
  IF v_prefix = 'o:' THEN
    v_tenant_id := pg_catalog.substr(p_tenant_key, 3)::uuid;
    SELECT pg_catalog.count(*) > 0, COALESCE(pg_catalog.bool_or(m.role IN ('owner', 'admin')), false)
      INTO v_member, v_admin
    FROM public.organization_members m
    WHERE m.organization_id = v_tenant_id AND m.user_id = p_user_id;
    IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_tenant_id AND o.owner_id = p_user_id) THEN
      v_member := true;
      v_admin := true;
    END IF;
  ELSIF v_prefix = 's:' THEN
    v_member := true;
    v_admin := EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_user_id);
  ELSE
    v_tenant_id := pg_catalog.substr(p_tenant_key, 3)::uuid;
    v_member := v_tenant_id = p_user_id;
    v_admin := v_member;
  END IF;

  IF v_member THEN
    SELECT COALESCE(pg_catalog.array_agg(gm.group_id ORDER BY gm.group_id), '{}'::uuid[])
      INTO v_groups
    FROM public.rag_access_group_members gm
    JOIN public.rag_access_groups g ON g.id = gm.group_id
    WHERE gm.user_id = p_user_id AND g.tenant_key = p_tenant_key;
  END IF;

  SELECT ARRAY['all']::text[] || COALESCE(pg_catalog.array_agg(k.key ORDER BY k.key COLLATE "C"), '{}'::text[])
    INTO v_keys
  FROM (
    SELECT 'u:' || p_user_id::text AS key
    UNION
    SELECT 'g:' || gid::text FROM pg_catalog.unnest(v_groups) AS u(gid)
  ) k
  WHERE EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.access_groups @> ARRAY[k.key]
  );

  RETURN QUERY SELECT v_admin, v_groups, v_keys;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_resolve_access_scope(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_resolve_access_scope(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_group_by_key(p_tenant_key text, p_key text)
RETURNS TABLE (id uuid, name text, labels_current boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT g.id, g.name, EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.access_groups @> ARRAY['g:' || g.id::text]
  )
  FROM public.rag_access_groups g
  WHERE g.tenant_key = p_tenant_key AND g.key = p_key;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_by_key(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_by_key(text, text) TO service_role;

COMMIT;
