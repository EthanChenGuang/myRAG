-- 0970: rag_pilot_users, users whose answers the online sampler weights up (Phase 5.3 D-52).
-- One row per (tenant_key, user_id). rag_pilot_user_add and rag_pilot_user_remove are the writers: the tenant comes only from
-- p_tenant_key, checked first by rag_assert_tenant_key (a key of the other deployment mode raises 22023); a repeat returns false.
-- Membership of the user in the tenant is checked by the admin route. Deleting the auth user removes the row (cascade).
-- SECURITY INVOKER with an empty search_path; service_role only. Additive and idempotent. Not folded into the setup files (D-56).

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_pilot_users (
  tenant_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, user_id),
  CONSTRAINT rag_pilot_users_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  )
);

CREATE INDEX IF NOT EXISTS rag_pilot_users_user_id_idx ON public.rag_pilot_users (user_id);
CREATE INDEX IF NOT EXISTS rag_pilot_users_added_by_idx ON public.rag_pilot_users (added_by);

ALTER TABLE public.rag_pilot_users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_pilot_users FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_pilot_users TO service_role;

CREATE OR REPLACE FUNCTION public.rag_pilot_user_add(p_tenant_key text, p_user_id uuid, p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_inserted integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  INSERT INTO public.rag_pilot_users (tenant_key, user_id, added_by)
  VALUES (p_tenant_key, p_user_id, p_actor)
  ON CONFLICT (tenant_key, user_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_pilot_user_remove(p_tenant_key text, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  DELETE FROM public.rag_pilot_users
  WHERE tenant_key = p_tenant_key
    AND user_id = p_user_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_pilot_user_add(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_pilot_user_remove(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_pilot_user_add(text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_pilot_user_remove(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
