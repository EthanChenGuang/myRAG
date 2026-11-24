-- 0422: Dead-letter tracking for exhausted ingestion retries (status stays failed).

BEGIN;

DROP FUNCTION IF EXISTS public.rag_fail_ingestion_job(uuid, text, text, boolean);

ALTER TABLE public.ingestion_jobs
  ADD COLUMN IF NOT EXISTS dead_letter_at timestamptz;

ALTER TABLE public.ingestion_jobs_archive
  ADD COLUMN IF NOT EXISTS dead_letter_at timestamptz;

CREATE INDEX IF NOT EXISTS ingestion_jobs_dead_letter_idx
  ON public.ingestion_jobs (dead_letter_at DESC)
  WHERE deleted_at IS NULL AND dead_letter_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.rag_fail_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_error_class text,
  p_retryable boolean,
  p_last_error text DEFAULT NULL
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_terminal boolean;
  v_last text;
BEGIN
  IF p_error_class IS NULL OR btrim(p_error_class) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_error_class' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM public.ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);

  v_new_retries := v_job.retries + 1;
  v_terminal := (NOT p_retryable) OR v_new_retries > v_job.max_retries;
  v_last := COALESCE(NULLIF(btrim(p_last_error), ''), p_error_class);

  IF v_terminal THEN
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs j
       SET status = 'failed',
           error_class = p_error_class,
           error = v_last,
           dead_letter_at = CASE
             WHEN p_retryable AND v_new_retries > j.max_retries THEN now()
             ELSE NULL
           END,
           retries = v_new_retries,
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           run_after = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
    IF v_job.document_id IS NOT NULL THEN
      UPDATE public.documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    END IF;
  ELSE
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs j
       SET status = 'queued',
           error_class = p_error_class,
           error = v_last,
           retries = v_new_retries,
           run_after = now() + (30 * power(2::numeric, j.retries)) * interval '1 second',
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_count_ingestion_dead_letters(p_tenant_key text DEFAULT NULL)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::bigint
    FROM public.ingestion_jobs j
   WHERE j.deleted_at IS NULL
     AND j.status = 'failed'
     AND j.dead_letter_at IS NOT NULL
     AND (p_tenant_key IS NULL OR j.tenant_key = p_tenant_key);
$$;

REVOKE ALL ON FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean, text) TO service_role;

REVOKE ALL ON FUNCTION public.rag_count_ingestion_dead_letters(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_count_ingestion_dead_letters(text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_retry_ingestion_job(p_job_id uuid, p_actor uuid)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_keys text[];
  v_job public.ingestion_jobs%ROWTYPE;
BEGIN
  v_keys := public.rag_admin_tenant_keys(p_actor);
  SELECT * INTO v_job FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.tenant_key = ANY (v_keys)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.status NOT IN ('failed', 'needs_review') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status_for_retry' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ingestion_jobs j
     SET status = 'queued',
         retries = 0,
         run_after = NULL,
         error_class = NULL,
         error = NULL,
         dead_letter_at = NULL,
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES (
    'retry_ingestion_job',
    COALESCE(v_job.document_id, v_job.id),
    v_job.lineage_id,
    v_job.tenant_key,
    v_job.version,
    p_actor,
    ARRAY[]::text[]
  );

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';