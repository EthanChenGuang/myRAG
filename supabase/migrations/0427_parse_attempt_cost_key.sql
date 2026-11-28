-- 0427: rag_record_parse_attempt adds the attempt cost under the key the worker sends (03.1 verification warning).
-- The ParseAttempt contract and the sidecar send the cost as est_cost_usd, the key the job column and the admin trace use, but the
-- 0353 / 0425 body read est_cost, so every attempt added 0 to ingestion_jobs.est_cost_usd and the running total stayed 0 until the
-- worker wrote the job total at the end. The body now reads est_cost_usd and still accepts the older est_cost key.
-- Behaviour is otherwise that of 0425: the attempt is appended with its number, an escalation bumps the counter, the lease must hold.
-- SECURITY DEFINER with an empty search_path and schema-qualified names. Server role only (listed in the 0410 lockdown).
-- Idempotent: CREATE OR REPLACE with the 0353 signature, then guarded REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_record_parse_attempt(p_job_id uuid, p_worker text, p_attempt jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_attempts jsonb;
  v_no integer;
  v_reason text;
  v_cost numeric;
BEGIN
  IF p_attempt IS NULL OR jsonb_typeof(p_attempt) <> 'object' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_attempt' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM public.ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);

  v_attempts := COALESCE(v_job.attempts, '[]'::jsonb);
  v_no := jsonb_array_length(v_attempts) + 1;
  v_attempts := v_attempts || jsonb_build_array(p_attempt || jsonb_build_object('attempt_no', v_no));
  v_reason := p_attempt ->> 'reason';
  v_cost := COALESCE((p_attempt ->> 'est_cost_usd')::numeric, (p_attempt ->> 'est_cost')::numeric, 0);

  UPDATE public.ingestion_jobs j
     SET attempts = v_attempts,
         escalations = j.escalations + CASE WHEN v_reason = 'escalation' THEN 1 ELSE 0 END,
         est_cost_usd = COALESCE(j.est_cost_usd, 0) + v_cost,
         updated_at = now()
   WHERE j.id = p_job_id;

  RETURN v_no;
END;
$$;

DO $parse_attempt_cost_acl$
BEGIN
  IF to_regprocedure('public.rag_record_parse_attempt(uuid, text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_record_parse_attempt(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_record_parse_attempt(uuid, text, jsonb) TO service_role;
  END IF;
END
$parse_attempt_cost_acl$;

COMMIT;
