-- 0723: Phase 6.3 source recheck (RET-14, D-19, D-43).
-- rag_source_recheck returns the ids among p_chunk_ids whose chunk and document belong to the caller's tenant, whose document is
-- current and ready, and whose chunk is current and ready or variant: a quarantined, failed, deleted or superseded row is not
-- returned, nor is a soft-deleted document. It checks currency only; chunking-profile servability stays with the search RPCs, so an
-- eval chunking override or a legacy-fallback chunk the search returned is kept. The tenant comes only from p_tenant_key, checked by
-- rag_assert_tenant_key; at most 500 ids per call. SECURITY DEFINER (D-02), service role only.
-- Idempotent: safe to run more than once.

BEGIN;

DROP FUNCTION IF EXISTS public.rag_source_recheck(text, uuid[]);

CREATE FUNCTION public.rag_source_recheck(p_tenant_key text, p_chunk_ids uuid[])
RETURNS TABLE (chunk_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF COALESCE(pg_catalog.cardinality(p_chunk_ids), 0) > 500 THEN
    RAISE EXCEPTION 'invalid_argument: rag_source_recheck takes at most 500 ids' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(pg_catalog.cardinality(p_chunk_ids), 0) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id
    FROM public.document_chunks c
    JOIN public.documents d ON d.id = c.document_id
   WHERE c.id = ANY(p_chunk_ids)
     AND c.tenant_key = p_tenant_key
     AND d.tenant_key = p_tenant_key
     AND c.is_current
     AND c.status IN ('ready', 'variant')
     AND d.is_current
     AND d.status = 'ready'
   ORDER BY c.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_source_recheck(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_source_recheck(text, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
