-- 0812: caption languages and the recaption run (plan 03.2-33; D-23, D-24; XLG-06). Phase 3.2 gap-closure number: 0801-0811 are assigned.
-- rag_set_image_chunk_languages: under RAG_CAPTION_LANGUAGE=document the write stage stores, per picture caption of a version, the language
-- detected on the caption as written. The chunk writers copy the document language onto every chunk; this function then sets language and
-- metadata.language of the version's image chunks named by image URL. Nothing calls it with the switch at en. A later rag_set_document_fields
-- call that names language, doc_type, doc_date, parser_used or status copies the document language back (0801), as for every chunk.
-- Every function here is service_role only: REVOKE ALL FROM PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role per signature.
-- SECURITY INVOKER with an empty search_path unless stated; the tenant is checked with rag_assert_tenant_key and every row is matched on it.
-- Not folded into the setup files. Idempotent: CREATE OR REPLACE and IF NOT EXISTS.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_set_image_chunk_languages(p_document_id uuid, p_tenant_key text, p_items jsonb)
RETURNS TABLE (chunks_updated integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_items: p_items must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_items) AS e(value)
    WHERE pg_catalog.jsonb_typeof(e.value) <> 'object'
       OR pg_catalog.jsonb_typeof(e.value -> 'image_url') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(e.value -> 'language') IS DISTINCT FROM 'string'
       OR (e.value ->> 'language') !~ '^[a-z]{2,3}$'
  ) THEN
    RAISE EXCEPTION 'invalid_items: every item needs a string image_url and a language code' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.status NOT IN ('failed', 'deleted');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;

  UPDATE public.document_chunks c SET
    language = i.language,
    metadata = COALESCE(c.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('language', i.language)
  FROM (
    SELECT DISTINCT ON (e.value ->> 'image_url') e.value ->> 'image_url' AS image_url, e.value ->> 'language' AS language
    FROM pg_catalog.jsonb_array_elements(p_items) AS e(value)
    ORDER BY e.value ->> 'image_url'
  ) i
  WHERE c.document_id = p_document_id
    AND c.tenant_key = p_tenant_key
    AND c.chunk_kind = 'image'
    AND c.metadata ->> 'image_url' = i.image_url;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_set_image_chunk_languages(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_image_chunk_languages(uuid, text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
