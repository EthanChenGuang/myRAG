-- 0423: Dead-letter exhausted jobs when claim reclaims an expired lease.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_jobs(
  p_worker text,
  p_limit integer,
  p_allow_batch boolean,
  p_runner text DEFAULT 'worker'
)
RETURNS SETOF public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
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
      FROM ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.kind IN ('ingest', 'dry_run')
       AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
       AND (p_allow_batch OR j.batch_id IS NULL)
       AND (
         (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
         OR (
           j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
           AND j.lease_until IS NOT NULL
           AND j.lease_until < now()
         )
       )
       AND (j.batch_id IS NULL OR rag_batch_has_room(j.batch_id))
     ORDER BY j.priority DESC, j.created_at
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
      EXIT;
    END IF;

    IF v_job.batch_id IS NOT NULL AND NOT rag_batch_has_room(v_job.batch_id) THEN
      CONTINUE;
    END IF;

    IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
      v_new_retries := v_job.retries + 1;
      IF v_new_retries > v_job.max_retries THEN
        PERFORM rag_release_job_reservations(v_job.id);
        UPDATE ingestion_jobs
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
      PERFORM rag_release_job_reservations(v_job.id);
    END IF;

    UPDATE ingestion_jobs j
       SET status = CASE
             WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
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
$$;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_runner text DEFAULT 'worker'
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
BEGIN
  SELECT j.* INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.deleted_at IS NULL
     AND j.kind IN ('ingest', 'dry_run')
     AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
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

  IF v_job.batch_id IS NOT NULL AND NOT rag_batch_has_room(v_job.batch_id) THEN
    RETURN NULL;
  END IF;

  IF v_job.locked_by IS NOT NULL AND v_job.lease_until IS NOT NULL AND v_job.lease_until > now() THEN
    RETURN NULL;
  END IF;

  IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
    v_new_retries := v_job.retries + 1;
    IF v_new_retries > v_job.max_retries THEN
      PERFORM rag_release_job_reservations(v_job.id);
      UPDATE ingestion_jobs
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
    PERFORM rag_release_job_reservations(v_job.id);
  END IF;

  UPDATE ingestion_jobs j
     SET status = CASE
           WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
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
$$;

COMMIT;