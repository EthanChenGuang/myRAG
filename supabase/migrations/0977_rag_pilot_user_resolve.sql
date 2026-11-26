-- 0977: the readers behind the pilot-user admin route (Phase 5.3 D-52, D-55, plan 05.3-32).
-- rag_pilot_user_resolve(p_tenant_key, p_user) turns an e-mail address (case-insensitive) or a user id into the id of a user who
-- belongs to that tenant, or NULL: s:default accepts any user of the deployment, u:<id> only that user, o:<id> only a member of the
-- organization. An unknown user and a user of another tenant both give NULL, so the route answers one 404 for both.
-- rag_pilot_users_list(p_tenant_key, p_limit, p_before_added_at, p_before_user_id) returns the tenant's pilot users newest first
-- as a jsonb array of { user_id, email, added_at }, keyset-paginated on (added_at, user_id); the route masks the e-mail.
-- Both read auth.users, which only the owner may read on Supabase, so they are SECURITY DEFINER with an empty search_path and
-- schema-qualified names; the tenant comes only from p_tenant_key, checked first by rag_assert_tenant_key. Service role only.
-- Additive and idempotent. Not folded into the setup files (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_pilot_user_resolve(p_tenant_key text, p_user text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_value text := pg_catalog.btrim(coalesce(p_user, ''));
  v_user uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF v_value = '' OR pg_catalog.length(v_value) > 320 THEN
    RETURN NULL;
  END IF;

  IF v_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT u.id INTO v_user FROM auth.users u WHERE u.id = v_value::uuid;
  ELSIF pg_catalog.strpos(v_value, '@') > 1 THEN
    SELECT u.id INTO v_user
    FROM auth.users u
    WHERE pg_catalog.lower(u.email) = pg_catalog.lower(v_value)
    ORDER BY u.id
    LIMIT 1;
  END IF;

  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_tenant_key = 's:default' THEN
    RETURN v_user;
  END IF;

  IF pg_catalog.left(p_tenant_key, 2) = 'u:' THEN
    RETURN CASE WHEN v_user = pg_catalog.substr(p_tenant_key, 3)::uuid THEN v_user END;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = pg_catalog.substr(p_tenant_key, 3)::uuid
      AND m.user_id = v_user
  ) THEN
    RETURN v_user;
  END IF;

  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_pilot_users_list(
  p_tenant_key text,
  p_limit integer,
  p_before_added_at timestamptz,
  p_before_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 101);
  v_out jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF (p_before_added_at IS NULL) <> (p_before_user_id IS NULL) THEN
    RAISE EXCEPTION 'rag_pilot_users_list: the cursor needs both added_at and user_id' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('user_id', page.user_id, 'email', u.email, 'added_at', page.added_at)
             ORDER BY page.added_at DESC, page.user_id DESC
           ),
           '[]'::jsonb
         )
  INTO v_out
  FROM (
    SELECT p.user_id, p.added_at
    FROM public.rag_pilot_users p
    WHERE p.tenant_key = p_tenant_key
      AND (p_before_added_at IS NULL OR (p.added_at, p.user_id) < (p_before_added_at, p_before_user_id))
    ORDER BY p.added_at DESC, p.user_id DESC
    LIMIT v_limit
  ) AS page
  LEFT JOIN auth.users u ON u.id = page.user_id;

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_pilot_user_resolve(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_pilot_users_list(text, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_pilot_user_resolve(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_pilot_users_list(text, integer, timestamptz, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
