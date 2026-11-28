-- 0358: Progressive mode (D-30, A-9, F-10). A progressive job publishes the whole document parsed with the fast preset as a normal
-- version flagged provisional, then publishes the routed result as the next version through the Phase 3 swap. Three functions, each
-- resolving the tenant from the job row (A-6), SECURITY DEFINER with an empty search_path, executable by service_role only:
--   rag_mark_provisional: after the fast version was published, flags it and its chunks provisional, sets provisional_published_at
--     and puts the job back at parse for the routed run. Only an incremental ingest job whose snapshot has progressive on qualifies.
--   rag_begin_progressive_final: points the job at the processing version the routed run writes (same lineage, newer, not current).
--   rag_clear_provisional: the routed text equals the provisional text (a duplicate of the same lineage counts as unchanged): clears
--     the flags of the lineage's current version and its chunks in place and points the job back at that version. No new version.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_mark_provisional(p_job_id uuid, p_worker text)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc public.documents%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);
  IF v_job.provisional_published_at IS NOT NULL THEN
    RETURN v_job;
  END IF;
  IF v_job.kind <> 'ingest' OR v_job.batch_id IS NOT NULL
     OR COALESCE((v_job.settings ->> 'progressive')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'ingest_refused: provisional_not_allowed' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_doc FROM public.documents d
   WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key
   FOR UPDATE;
  IF NOT FOUND OR NOT v_doc.is_current OR v_doc.status <> 'ready' THEN
    RAISE EXCEPTION 'ingest_refused: version_not_published' USING ERRCODE = '22023';
  END IF;

  UPDATE public.documents d SET provisional = true, processing_status = 'ready' WHERE d.id = v_doc.id;
  UPDATE public.document_chunks c SET provisional = true WHERE c.document_id = v_doc.id;

  UPDATE public.ingestion_jobs j
     SET provisional_published_at = now(),
         stage = 'parse',
         status = 'parsing',
         stage_state = '{}'::jsonb,
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_begin_progressive_final(p_job_id uuid, p_worker text, p_document_id uuid)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_current public.documents%ROWTYPE;
  v_next public.documents%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);
  IF v_job.provisional_published_at IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: not_provisional' USING ERRCODE = '22023';
  END IF;
  IF v_job.document_id = p_document_id THEN
    RETURN v_job;
  END IF;

  SELECT * INTO v_current FROM public.documents d WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_next FROM public.documents d
   WHERE d.id = p_document_id
     AND d.tenant_key = v_job.tenant_key
     AND d.lineage_id = v_current.lineage_id
     AND d.version > v_current.version
     AND d.status = 'processing'
     AND NOT d.is_current;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: version_not_allowed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ingestion_jobs j SET document_id = v_next.id, updated_at = now() WHERE j.id = v_job.id RETURNING j.* INTO v_job;
  UPDATE public.documents d SET processing_status = public.rag_ingest_mirror_processing_status(v_job.status) WHERE d.id = v_next.id;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_clear_provisional(p_job_id uuid)
RETURNS TABLE (document_id uuid, version integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_lineage uuid;
  v_current public.documents%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.provisional_published_at IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: not_provisional' USING ERRCODE = '22023';
  END IF;

  SELECT d.lineage_id INTO v_lineage FROM public.documents d WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
  IF v_lineage IS NULL THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_current FROM public.documents d
   WHERE d.tenant_key = v_job.tenant_key AND d.lineage_id = v_lineage AND d.is_current
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: no_current_version' USING ERRCODE = '22023';
  END IF;

  UPDATE public.documents d SET provisional = false WHERE d.id = v_current.id;
  UPDATE public.document_chunks c SET provisional = false WHERE c.document_id = v_current.id;
  UPDATE public.ingestion_jobs j SET document_id = v_current.id, updated_at = now() WHERE j.id = v_job.id;

  RETURN QUERY SELECT v_current.id, v_current.version;
END;
$$;

REVOKE ALL ON FUNCTION rag_mark_provisional(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_begin_progressive_final(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_clear_provisional(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_mark_provisional(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_begin_progressive_final(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_clear_provisional(uuid) TO service_role;

COMMIT;
