-- Phase 3.2 plan 52 (D-31, D-50): organization admins set the translation targets of their own organization.
-- 0810 checked the actor with rag_admin_tenant_keys, which requires admin_users, so an owner or admin of an organization who is not a
-- deployment admin could not save its targets. This rebuilds rag_translation_settings_set only, checking the actor with
-- rag_upload_approval_keys (0814): a deployment admin keeps rag_admin_tenant_keys unchanged; in multi-tenant mode an owner or admin of an
-- organization also gets that organization's key. A personal workspace (u:) stays with deployment admins. A refused actor now gets 42501
-- 'not_admin' in every case. Body otherwise from 0810 with the same signature, SECURITY INVOKER, search_path and grants. Idempotent.
-- Operator rule: re-running 0810 puts back its body; re-run this file after it.

CREATE OR REPLACE FUNCTION public.rag_translation_settings_set(p_actor uuid, p_tenant_key text, p_targets text[], p_enabled boolean)
RETURNS TABLE (tenant_key text, target_languages text[], enabled boolean, updated_by uuid, updated_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_targets text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL OR p_targets IS NULL OR cardinality(p_targets) > 16 OR EXISTS (
    SELECT 1 FROM unnest(p_targets) AS u(code) WHERE u.code IS NULL OR u.code !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ) THEN
    RAISE EXCEPTION 'translation_settings_refused: invalid_targets' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(x.code ORDER BY x.first), '{}'::text[]) INTO v_targets
  FROM (SELECT u.code, min(u.ord) AS first FROM unnest(p_targets) WITH ORDINALITY AS u(code, ord) GROUP BY u.code) AS x;

  INSERT INTO public.rag_translation_settings AS s (tenant_key, target_languages, enabled, updated_by, updated_at)
  VALUES (p_tenant_key, v_targets, p_enabled, p_actor, now())
  ON CONFLICT ON CONSTRAINT rag_translation_settings_pkey DO UPDATE
    SET target_languages = EXCLUDED.target_languages, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now();

  RETURN QUERY SELECT * FROM public.rag_translation_settings_get(p_tenant_key);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_translation_settings_set(uuid, text, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_translation_settings_set(uuid, text, text[], boolean) TO service_role;
