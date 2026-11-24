-- 0357: Soft-delete a document lineage at the source (D-27). Rows are kept for citations; retrieval drops them via is_current/status.
-- The RET-05 outbox and semantic-cache invalidation read this function later; neither is wired here.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_soft_delete_document(
  p_tenant_key text,
  p_lineage_id uuid,
  p_source text
)
RETURNS TABLE (outcome text, lineage_id uuid, job_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_count integer;
  v_has_current boolean;
  v_source_key text;
  v_doc_id uuid;
  v_job_id uuid;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR p_source NOT IN (
    'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag'
  ) THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.documents d
   WHERE d.lineage_id = p_lineage_id
     AND d.tenant_key = p_tenant_key
     AND d.source = p_source;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.documents d
     WHERE d.lineage_id = p_lineage_id
       AND d.tenant_key = p_tenant_key
       AND d.source = p_source
       AND (d.is_current OR d.status <> 'deleted')
  ) INTO v_has_current;

  IF NOT v_has_current THEN
    RETURN QUERY SELECT 'already_deleted'::text, p_lineage_id, NULL::uuid;
    RETURN;
  END IF;

  SELECT d.id, d.source_key INTO v_doc_id, v_source_key
    FROM public.documents d
   WHERE d.lineage_id = p_lineage_id
     AND d.tenant_key = p_tenant_key
     AND d.source = p_source
   ORDER BY d.is_current DESC, d.version DESC NULLS LAST
   LIMIT 1;

  UPDATE public.documents d
     SET is_current = false,
         status = 'deleted'
   WHERE d.lineage_id = p_lineage_id
     AND d.tenant_key = p_tenant_key
     AND d.source = p_source;

  UPDATE public.document_chunks c
     SET is_current = false,
         status = 'deleted',
         embedding = NULL
    FROM public.documents d
   WHERE c.document_id = d.id
     AND d.lineage_id = p_lineage_id
     AND d.tenant_key = p_tenant_key
     AND d.source = p_source;

  INSERT INTO public.ingestion_jobs (
    tenant_key, kind, status, source, source_key, lineage_id, document_id
  ) VALUES (
    p_tenant_key, 'delete', 'ready', p_source, COALESCE(v_source_key, p_lineage_id::text), p_lineage_id, v_doc_id
  )
  RETURNING id INTO v_job_id;

  RETURN QUERY SELECT 'deleted'::text, p_lineage_id, v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_soft_delete_document(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_soft_delete_document(text, uuid, text) TO service_role;

COMMIT;