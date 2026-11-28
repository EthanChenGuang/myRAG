-- Phase 3.2 plan 29 (D-21, research Pitfall 12): rag:relex reads current table chunks with their stored lexical_text.
-- RAG_TABLE_ROW_SERIALIZATION adds column=value row lines to the lexical_text of table chunks without bumping LEXICAL_VERSION, so a table
-- chunk's text can differ under one lexical_version. rag_relex_candidates selects by version only; this function lists the current, ready
-- table chunks with their stored text so the runner can rewrite those that do not match the switch state through rag_relex_batch.
-- Read-only, SECURITY INVOKER, service_role only, empty search_path. Idempotent: CREATE OR REPLACE with a fixed signature, then grants.

CREATE OR REPLACE FUNCTION public.rag_relex_table_candidates(p_after uuid, p_limit integer, p_tenant_key text DEFAULT NULL::text)
 RETURNS TABLE(
   id uuid,
   tenant_key text,
   content text,
   section_path text[],
   chunk_kind text,
   metadata jsonb,
   language text,
   document_filename text,
   document_language text,
   lexical_text text
 )
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'relex_refused: invalid_limit' USING ERRCODE = '22023';
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
         d.language AS document_language,
         c.lexical_text
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.is_current
    AND c.status = 'ready'
    AND c.chunk_kind = 'table'
    AND (p_after IS NULL OR c.id > p_after)
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
  ORDER BY c.id
  LIMIT p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.rag_relex_table_candidates(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_relex_table_candidates(uuid, integer, text) TO service_role;
