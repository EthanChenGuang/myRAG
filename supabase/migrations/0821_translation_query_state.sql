-- Phase 3.2 plan 51 (XLG-04, D-28, D-30): the one lookup a v2 request makes before it runs translation legs.
-- For each requested language, in the order given: whether the tenant's translation setting is enabled and targets that language,
-- whether the tenant has a translation into it, and whether one of those translations has a vector under the active profile
-- (none means the profile flipped and the translations wait for a re-embed: the request skips the legs, translation_stale).
-- Existence checks only, so the cost does not grow with the tenant's translation count. Reads one tenant; service_role only. Idempotent.

CREATE OR REPLACE FUNCTION public.rag_translation_query_state(p_tenant_key text, p_profile_id text, p_languages text[])
RETURNS TABLE (language text, enabled boolean, targeted boolean, has_translations boolean, has_profile_vectors boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_code text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_profile_id IS NULL OR p_profile_id !~ '^[a-z0-9][a-z0-9._-]{0,63}$' THEN
    RAISE EXCEPTION 'rag_translation_query_state: invalid profile' USING ERRCODE = '22023';
  END IF;
  IF p_languages IS NULL OR cardinality(p_languages) > 16 THEN
    RAISE EXCEPTION 'rag_translation_query_state: invalid languages' USING ERRCODE = '22023';
  END IF;
  FOREACH v_code IN ARRAY p_languages LOOP
    IF v_code IS NULL OR v_code !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' THEN
      RAISE EXCEPTION 'rag_translation_query_state: invalid language' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT
    l.code,
    COALESCE(s.enabled, false),
    COALESCE(l.code = ANY (s.target_languages), false),
    EXISTS (
      SELECT 1 FROM public.chunk_translations t
      WHERE t.tenant_key = p_tenant_key AND t.language = l.code
    ),
    EXISTS (
      SELECT 1 FROM public.chunk_translation_embeddings e
      JOIN public.chunk_translations t ON t.id = e.translation_id
      WHERE e.tenant_key = p_tenant_key AND e.profile_id = p_profile_id AND t.tenant_key = p_tenant_key AND t.language = l.code
    )
  FROM unnest(p_languages) WITH ORDINALITY AS l(code, ord)
  LEFT JOIN public.rag_translation_settings s ON s.tenant_key = p_tenant_key
  ORDER BY l.ord;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_translation_query_state(text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_translation_query_state(text, text, text[]) TO service_role;
