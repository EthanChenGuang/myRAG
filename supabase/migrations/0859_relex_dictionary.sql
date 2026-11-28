-- 0859: Phase 4.2 plan 19 stamp-aware relex (LANG-07 D-09, D-42; RET-15 D-30).
-- rag:relex rebuilds lexical_text with the tenant's lexical options: the effective TERM dictionary (stamp lexical_dict_version, the column
-- from 0851 and the metadata key) and the tenant's identifier patterns (fingerprint in the metadata key lexical_patterns). The 0425
-- rag_relex_candidates and rag_relex_batch are not redefined; these functions have new names, so no second overload exists.
--   rag_relex_candidates_stamped: version mode lists chunks whose lexical_version differs, or, for one tenant, whose stored stamp differs
--     from a given non-null stamp; stale-dictionary mode (tenant and dictionary version required) lists the tenant's chunks whose stored
--     dictionary version differs.
--   rag_relex_batch_stamped: writes lexical_text, lexical_version and both stamps (set, or removed when null) for one tenant's chunks; the
--     0425 batch writer replaces only the lexical_version key, so it cannot carry the stamps.
--   rag_lexical_stale_count: the tenant's current, ready chunks whose dictionary stamp differs from the given version.
-- SECURITY INVOKER, empty search_path, schema-qualified names, service_role only (D-56); the tenant key is asserted first whenever one is
-- given. Idempotent: CREATE OR REPLACE with fixed signatures, then grants. Not folded into the setup files. No store, so no purge hook.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_relex_candidates_stamped(
  p_after uuid,
  p_version integer,
  p_limit integer,
  p_tenant_key text,
  p_dict_version text,
  p_patterns text,
  p_stale_dictionary boolean
)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  metadata jsonb,
  language text,
  document_filename text,
  lexical_dict_version text,
  lexical_patterns text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'relex_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  IF p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'relex_refused: invalid_version' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NULL AND (p_dict_version IS NOT NULL OR p_patterns IS NOT NULL OR coalesce(p_stale_dictionary, false)) THEN
    RAISE EXCEPTION 'relex_refused: stamps_need_tenant' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_stale_dictionary, false) AND p_dict_version IS NULL THEN
    RAISE EXCEPTION 'relex_refused: stale_dictionary_needs_version' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT c.id,
         c.tenant_key,
         c.content,
         c.section_path,
         c.chunk_kind,
         c.metadata,
         c.language,
         d.filename AS document_filename,
         c.lexical_dict_version,
         c.metadata ->> 'lexical_patterns' AS lexical_patterns
    FROM public.document_chunks c
    JOIN public.documents d ON d.id = c.document_id
   WHERE c.is_current
     AND c.status = 'ready'
     AND (p_after IS NULL OR c.id > p_after)
     AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
     AND CASE
           WHEN coalesce(p_stale_dictionary, false) THEN c.lexical_dict_version IS DISTINCT FROM p_dict_version
           ELSE c.lexical_version IS DISTINCT FROM p_version
             OR (p_dict_version IS NOT NULL AND c.lexical_dict_version IS DISTINCT FROM p_dict_version)
             OR (p_patterns IS NOT NULL AND (c.metadata ->> 'lexical_patterns') IS DISTINCT FROM p_patterns)
         END
   ORDER BY c.id
   LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_relex_candidates_stamped(uuid, integer, integer, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_relex_candidates_stamped(uuid, integer, integer, text, text, text, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_relex_batch_stamped(p_rows jsonb, p_version integer, p_tenant_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_row jsonb;
  v_dict text;
  v_patterns text;
  v_count integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'relex_refused: invalid_version' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR v_row IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_row) <> 'object'
       OR pg_catalog.jsonb_typeof(v_row -> 'id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_row -> 'lexical_text') IS DISTINCT FROM 'string' THEN
      CONTINUE;
    END IF;
    v_dict := CASE WHEN pg_catalog.jsonb_typeof(v_row -> 'lexical_dict_version') = 'string' THEN v_row ->> 'lexical_dict_version' END;
    v_patterns := CASE WHEN pg_catalog.jsonb_typeof(v_row -> 'lexical_patterns') = 'string' THEN v_row ->> 'lexical_patterns' END;
    IF v_dict IS NOT NULL AND v_dict !~ '^s[0-9]{1,9}(\.w[0-9]{1,9})?$' THEN
      RAISE EXCEPTION 'relex_refused: invalid_dict_version' USING ERRCODE = '22023';
    END IF;
    IF v_patterns IS NOT NULL AND v_patterns !~ '^p[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'relex_refused: invalid_patterns' USING ERRCODE = '22023';
    END IF;
    UPDATE public.document_chunks c
       SET lexical_text = v_row ->> 'lexical_text',
           lexical_version = p_version,
           lexical_dict_version = v_dict,
           metadata = (coalesce(c.metadata, '{}'::jsonb) - 'lexical_dict_version' - 'lexical_patterns')
             || pg_catalog.jsonb_build_object('lexical_version', p_version)
             || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('lexical_dict_version', v_dict, 'lexical_patterns', v_patterns)),
           language = CASE
             WHEN c.language IS NULL AND v_row ? 'language' THEN NULLIF(v_row ->> 'language', '')
             ELSE c.language
           END
     WHERE c.id = (v_row ->> 'id')::uuid
       AND c.tenant_key = p_tenant_key
       AND c.is_current
       AND c.status = 'ready';
    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_relex_batch_stamped(jsonb, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_relex_batch_stamped(jsonb, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_lexical_stale_count(p_tenant_key text, p_dict_version text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT pg_catalog.count(*) INTO v_count
    FROM public.document_chunks c
   WHERE c.tenant_key = p_tenant_key
     AND c.is_current
     AND c.status = 'ready'
     AND c.lexical_dict_version IS DISTINCT FROM p_dict_version;
  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_lexical_stale_count(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_lexical_stale_count(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
