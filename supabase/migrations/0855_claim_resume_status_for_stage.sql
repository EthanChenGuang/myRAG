-- 0855: a requeued job is claimable again. rag_fail_ingestion_job puts a retryable job back to status 'queued' and keeps its stage (for
-- example 'parse'); the claim functions then set status from the raw stage, and a stage name is not a status ('parse' is not 'parsing'),
-- so the update broke ingestion_jobs_status_check and the error aborted the whole claim: one requeued job stopped the worker for every
-- job. Both claim functions now resume through rag_ingest_job_status_for_stage (the map rag_advance_ingestion_job checks against); a
-- stage that maps to no in-progress status ('begin', a terminal stage, an unknown or empty stage) resumes at 'preflight' as before.
-- The bodies are those of 0810 with that one change.
-- Idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_job(p_job_id uuid, p_worker text, p_runner text DEFAULT 'worker'::text)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
BEGIN
  SELECT j.* INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.deleted_at IS NULL
     AND j.kind IN ('ingest', 'dry_run', 'translate')
     AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review')
     AND (
       (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
       OR (
         j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
         AND j.lease_until IS NOT NULL
         AND j.lease_until < now()
       )
     )
   FOR UPDATE OF j SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_job.batch_id IS NOT NULL AND NOT public.rag_batch_has_room(v_job.batch_id) THEN
    RETURN NULL;
  END IF;

  IF v_job.locked_by IS NOT NULL AND v_job.lease_until IS NOT NULL AND v_job.lease_until > now() THEN
    RETURN NULL;
  END IF;

  IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
    v_new_retries := v_job.retries + 1;
    IF v_new_retries > v_job.max_retries THEN
      PERFORM public.rag_release_job_reservations(v_job.id);
      UPDATE public.ingestion_jobs
         SET status = 'failed',
             error_class = 'lease_expired',
             error = 'lease expired',
             dead_letter_at = now(),
             retries = v_new_retries,
             locked_by = NULL,
             lease_until = NULL,
             runner = NULL,
             updated_at = now()
       WHERE id = v_job.id;
      RETURN NULL;
    END IF;
    PERFORM public.rag_release_job_reservations(v_job.id);
  END IF;

  UPDATE public.ingestion_jobs j
     SET status = CASE
           WHEN j.status = 'queued' AND j.kind = 'translate' THEN 'embedding'
           WHEN j.status = 'queued' THEN CASE
               WHEN public.rag_ingest_job_status_for_stage(j.stage) IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
                 THEN public.rag_ingest_job_status_for_stage(j.stage)
               ELSE 'preflight'
             END
           ELSE j.status
         END,
         retries = CASE
           WHEN j.status = 'queued' THEN j.retries
           ELSE j.retries + 1
         END,
         locked_by = p_worker,
         runner = p_runner,
         lease_until = now() + interval '120 seconds',
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_jobs(p_worker text, p_limit integer, p_allow_batch boolean, p_runner text DEFAULT 'worker'::text)
 RETURNS SETOF public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed integer := 0;
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_limit integer;
BEGIN
  v_limit := GREATEST(COALESCE(p_limit, 0), 0);
  IF v_limit < 1 THEN
    RETURN;
  END IF;

  WHILE v_claimed < v_limit LOOP
    SELECT j.* INTO v_job
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.kind IN ('ingest', 'dry_run', 'translate')
       AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review')
       AND (p_allow_batch OR j.batch_id IS NULL)
       AND (
         (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
         OR (
           j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
           AND j.lease_until IS NOT NULL
           AND j.lease_until < now()
         )
       )
       AND (j.batch_id IS NULL OR public.rag_batch_has_room(j.batch_id))
     ORDER BY j.priority DESC, j.created_at
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
      EXIT;
    END IF;

    IF v_job.batch_id IS NOT NULL AND NOT public.rag_batch_has_room(v_job.batch_id) THEN
      CONTINUE;
    END IF;

    IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
      v_new_retries := v_job.retries + 1;
      IF v_new_retries > v_job.max_retries THEN
        PERFORM public.rag_release_job_reservations(v_job.id);
        UPDATE public.ingestion_jobs
           SET status = 'failed',
               error_class = 'lease_expired',
               error = 'lease expired',
               dead_letter_at = now(),
               retries = v_new_retries,
               locked_by = NULL,
               lease_until = NULL,
               runner = NULL,
               updated_at = now()
         WHERE id = v_job.id;
        CONTINUE;
      END IF;
      PERFORM public.rag_release_job_reservations(v_job.id);
    END IF;

    UPDATE public.ingestion_jobs j
       SET status = CASE
             WHEN j.status = 'queued' AND j.kind = 'translate' THEN 'embedding'
             WHEN j.status = 'queued' THEN CASE
               WHEN public.rag_ingest_job_status_for_stage(j.stage) IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
                 THEN public.rag_ingest_job_status_for_stage(j.stage)
               ELSE 'preflight'
             END
             ELSE j.status
           END,
           retries = CASE
             WHEN j.status = 'queued' THEN j.retries
             ELSE j.retries + 1
           END,
           locked_by = p_worker,
           runner = p_runner,
           lease_until = now() + interval '120 seconds',
           updated_at = now()
     WHERE j.id = v_job.id
     RETURNING j.* INTO v_job;

    v_claimed := v_claimed + 1;
    RETURN NEXT v_job;
  END LOOP;

  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
