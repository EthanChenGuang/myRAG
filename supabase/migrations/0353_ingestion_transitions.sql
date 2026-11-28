-- 0353: Ingestion ledger transitions, parse attempts, fail/retry/delete, reads and guarded Realtime broadcast.

BEGIN;

ALTER TABLE rag_admin_audit DROP CONSTRAINT IF EXISTS rag_admin_audit_action_check;
ALTER TABLE rag_admin_audit ADD CONSTRAINT rag_admin_audit_action_check CHECK (
  action IN (
    'release_quarantine',
    'delete_quarantined',
    'retry_ingestion_job',
    'delete_ingestion_job'
  )
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rag_ingest_job_status_for_stage(p_stage text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_stage
    WHEN 'begin' THEN 'queued'
    WHEN 'preflight' THEN 'preflight'
    WHEN 'parse' THEN 'parsing'
    WHEN 'check' THEN 'checking'
    WHEN 'content_hash_dedup' THEN 'chunking'
    WHEN 'scan_injection' THEN 'chunking'
    WHEN 'chunk' THEN 'chunking'
    WHEN 'enrich' THEN 'chunking'
    WHEN 'extract' THEN 'chunking'
    WHEN 'images' THEN 'chunking'
    WHEN 'embed' THEN 'embedding'
    WHEN 'write' THEN 'embedding'
    WHEN 'publish' THEN 'embedding'
    WHEN 'ready' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'quarantined' THEN 'quarantined'
    WHEN 'needs_review' THEN 'needs_review'
    WHEN 'skipped_duplicate' THEN 'skipped_duplicate'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION rag_ingest_mirror_processing_status(p_ledger_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_ledger_status
    WHEN 'queued' THEN 'queued'
    WHEN 'preflight' THEN 'parsing'
    WHEN 'parsing' THEN 'parsing'
    WHEN 'checking' THEN 'parsing'
    WHEN 'chunking' THEN 'chunking'
    WHEN 'embedding' THEN 'embedding'
    WHEN 'ready' THEN 'ready'
    WHEN 'needs_review' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'quarantined' THEN 'failed'
    WHEN 'skipped_duplicate' THEN 'ready'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION rag_ingest_assert_job_lease(p_job public.ingestion_jobs, p_worker text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_job.locked_by IS DISTINCT FROM p_worker
     OR p_job.lease_until IS NULL
     OR p_job.lease_until <= now() THEN
    RAISE EXCEPTION 'lease_lost' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Pitfall 4: every mutating path raises lease_lost when the worker does not own a live lease.

CREATE OR REPLACE FUNCTION rag_ingest_broadcast_job(p_job public.ingestion_jobs)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  IF to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL THEN
    RETURN;
  END IF;
  v_payload := jsonb_build_object(
    'job_id', p_job.id,
    'document_id', p_job.document_id,
    'status', p_job.status,
    'stage', p_job.stage,
    'provisional', p_job.provisional_published_at IS NOT NULL
  );
  PERFORM realtime.send(v_payload, 'ingest_status', 'rag-ingest:' || p_job.tenant_key, true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Advance and parse attempts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_advance_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_stage text,
  p_status text,
  p_stage_state jsonb DEFAULT NULL,
  p_timing_ms integer DEFAULT NULL,
  p_fields jsonb DEFAULT '{}'::jsonb
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_expected text;
  v_timings jsonb;
  v_key text;
  v_value jsonb;
  v_whitelist text[] := ARRAY[
    'doc_class', 'tier', 'parser_used', 'parser_version', 'pages', 'page_ranges',
    'tier_page_counts', 'detect_counts', 'preflight_ref', 'est_cost_usd', 'embedding_profile',
    'document_id', 'needs_review_reason', 'routing_note', 'provisional_published_at', 'trace_id'
  ];
  v_terminal boolean;
  v_mirror text;
BEGIN
  IF p_stage IS NULL OR btrim(p_stage) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  v_expected := rag_ingest_job_status_for_stage(p_stage);
  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status <> v_expected THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status_for_stage' USING ERRCODE = '22023';
  END IF;
  IF p_fields IS NOT NULL AND jsonb_typeof(p_fields) = 'object' THEN
    FOR v_key IN SELECT jsonb_object_keys(p_fields)
    LOOP
      IF NOT (v_key = ANY (v_whitelist)) THEN
        RAISE EXCEPTION 'ingest_refused: field_not_allowed' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO v_job FROM ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM rag_ingest_assert_job_lease(v_job, p_worker);

  v_timings := COALESCE(v_job.timings, '{}'::jsonb);
  IF p_timing_ms IS NOT NULL AND p_stage IS NOT NULL THEN
    v_timings := v_timings || jsonb_build_object(
      p_stage,
      COALESCE((v_timings ->> p_stage)::bigint, 0) + p_timing_ms
    );
  END IF;

  UPDATE ingestion_jobs j
     SET status = p_status,
         stage = p_stage,
         timings = v_timings,
         stage_state = CASE WHEN p_stage_state IS NOT NULL THEN p_stage_state ELSE j.stage_state END,
         doc_class = COALESCE(p_fields ->> 'doc_class', j.doc_class),
         tier = COALESCE(p_fields ->> 'tier', j.tier),
         parser_used = COALESCE(p_fields ->> 'parser_used', j.parser_used),
         parser_version = COALESCE(p_fields ->> 'parser_version', j.parser_version),
         pages = COALESCE((p_fields ->> 'pages')::integer, j.pages),
         page_ranges = CASE WHEN p_fields ? 'page_ranges' THEN p_fields -> 'page_ranges' ELSE j.page_ranges END,
         tier_page_counts = CASE WHEN p_fields ? 'tier_page_counts' THEN p_fields -> 'tier_page_counts' ELSE j.tier_page_counts END,
         detect_counts = CASE WHEN p_fields ? 'detect_counts' THEN p_fields -> 'detect_counts' ELSE j.detect_counts END,
         preflight_ref = COALESCE(p_fields ->> 'preflight_ref', j.preflight_ref),
         est_cost_usd = COALESCE((p_fields ->> 'est_cost_usd')::numeric, j.est_cost_usd),
         embedding_profile = COALESCE(p_fields ->> 'embedding_profile', j.embedding_profile),
         document_id = CASE
           WHEN j.document_id IS NULL AND p_fields ? 'document_id'
           THEN (p_fields ->> 'document_id')::uuid
           ELSE j.document_id
         END,
         needs_review_reason = COALESCE(p_fields ->> 'needs_review_reason', j.needs_review_reason),
         routing_note = COALESCE(p_fields ->> 'routing_note', j.routing_note),
         provisional_published_at = CASE
           WHEN p_fields ? 'provisional_published_at'
           THEN (p_fields ->> 'provisional_published_at')::timestamptz
           ELSE j.provisional_published_at
         END,
         trace_id = CASE WHEN p_fields ? 'trace_id' THEN (p_fields ->> 'trace_id')::uuid ELSE j.trace_id END,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  v_terminal := p_status IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate');
  IF v_terminal THEN
    PERFORM rag_release_job_reservations(p_job_id);
    UPDATE ingestion_jobs
       SET locked_by = NULL, lease_until = NULL, runner = NULL
     WHERE id = p_job_id
     RETURNING * INTO v_job;
  END IF;

  IF v_job.document_id IS NOT NULL THEN
    v_mirror := rag_ingest_mirror_processing_status(v_job.status);
    IF v_mirror IS NOT NULL THEN
      UPDATE documents d
         SET processing_status = v_mirror
       WHERE d.id = v_job.document_id
         AND d.tenant_key = v_job.tenant_key;
    END IF;
    IF p_status = 'ready' THEN
      UPDATE documents d SET status = 'ready' WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    ELSIF p_status IN ('failed', 'quarantined') THEN
      UPDATE documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    ELSIF p_status = 'needs_review' THEN
      UPDATE documents d
         SET status = 'ready',
             needs_review = true,
             needs_review_reason = COALESCE(v_job.needs_review_reason, d.needs_review_reason)
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    END IF;
  END IF;

  PERFORM rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_record_parse_attempt(
  p_job_id uuid,
  p_worker text,
  p_attempt jsonb
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
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
  SELECT * INTO v_job FROM ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM rag_ingest_assert_job_lease(v_job, p_worker);

  v_attempts := COALESCE(v_job.attempts, '[]'::jsonb);
  v_no := jsonb_array_length(v_attempts) + 1;
  v_attempts := v_attempts || jsonb_build_array(p_attempt || jsonb_build_object('attempt_no', v_no));
  v_reason := p_attempt ->> 'reason';
  v_cost := COALESCE((p_attempt ->> 'est_cost')::numeric, 0);

  UPDATE ingestion_jobs j
     SET attempts = v_attempts,
         escalations = j.escalations + CASE WHEN v_reason = 'escalation' THEN 1 ELSE 0 END,
         est_cost_usd = COALESCE(j.est_cost_usd, 0) + v_cost,
         updated_at = now()
   WHERE j.id = p_job_id;

  RETURN v_no;
END;
$$;

-- ---------------------------------------------------------------------------
-- Fail, admin retry/delete, reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_fail_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_error_class text,
  p_retryable boolean
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
  v_terminal boolean;
BEGIN
  IF p_error_class IS NULL OR btrim(p_error_class) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_error_class' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM rag_ingest_assert_job_lease(v_job, p_worker);

  v_new_retries := v_job.retries + 1;
  v_terminal := (NOT p_retryable) OR v_new_retries > v_job.max_retries;

  IF v_terminal THEN
    PERFORM rag_release_job_reservations(p_job_id);
    UPDATE ingestion_jobs j
       SET status = 'failed',
           error_class = p_error_class,
           retries = v_new_retries,
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           run_after = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
    IF v_job.document_id IS NOT NULL THEN
      UPDATE documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    END IF;
  ELSE
    PERFORM rag_release_job_reservations(p_job_id);
    UPDATE ingestion_jobs j
       SET status = 'queued',
           error_class = p_error_class,
           retries = v_new_retries,
           run_after = now() + (30 * power(2::numeric, j.retries)) * interval '1 second',
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
  END IF;

  PERFORM rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_retry_ingestion_job(p_job_id uuid, p_actor uuid)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keys text[];
  v_job public.ingestion_jobs%ROWTYPE;
BEGIN
  v_keys := rag_admin_tenant_keys(p_actor);
  SELECT * INTO v_job FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.tenant_key = ANY (v_keys)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.status NOT IN ('failed', 'needs_review') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status_for_retry' USING ERRCODE = '22023';
  END IF;

  UPDATE ingestion_jobs j
     SET status = 'queued',
         retries = 0,
         run_after = NULL,
         error_class = NULL,
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
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

CREATE OR REPLACE FUNCTION public.rag_delete_ingestion_job(p_job_id uuid, p_actor uuid)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keys text[];
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc documents%ROWTYPE;
BEGIN
  v_keys := rag_admin_tenant_keys(p_actor);
  SELECT * INTO v_job FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.tenant_key = ANY (v_keys)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_job.document_id IS NOT NULL THEN
    SELECT * INTO v_doc FROM documents d WHERE d.id = v_job.document_id FOR UPDATE;
    IF FOUND AND v_doc.is_current THEN
      RAISE EXCEPTION 'ingest_refused: document_is_current' USING ERRCODE = '22023';
    END IF;
    IF FOUND AND NOT v_doc.is_current THEN
      UPDATE documents d SET superseded_by = NULL WHERE d.superseded_by = v_doc.id;
      DELETE FROM document_chunks c WHERE c.document_id = v_doc.id;
      DELETE FROM documents d WHERE d.id = v_doc.id;
    END IF;
  END IF;

  UPDATE ingestion_jobs j
     SET deleted_at = now(),
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES (
    'delete_ingestion_job',
    COALESCE(v_job.document_id, COALESCE(v_doc.id, v_job.id)),
    v_job.lineage_id,
    v_job.tenant_key,
    v_job.version,
    p_actor,
    ARRAY[]::text[]
  );

  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_get_ingestion_job(p_job_id uuid, p_tenant_key text)
RETURNS public.ingestion_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.*
    FROM ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.tenant_key = p_tenant_key
     AND j.deleted_at IS NULL
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.rag_get_job_for_document(p_document_id uuid, p_tenant_key text)
RETURNS public.ingestion_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.*
    FROM ingestion_jobs j
   WHERE j.document_id = p_document_id
     AND j.tenant_key = p_tenant_key
     AND j.deleted_at IS NULL
   ORDER BY j.created_at DESC
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.rag_get_ingestion_job_internal(p_job_id uuid)
RETURNS public.ingestion_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.* FROM ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.rag_list_ingestion_jobs(
  p_tenant_key text DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_kind text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS SETOF public.ingestion_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.*
    FROM ingestion_jobs j
   WHERE j.deleted_at IS NULL
     AND (p_tenant_key IS NULL OR j.tenant_key = p_tenant_key)
     AND (p_kind IS NULL OR j.kind = p_kind)
     AND (p_statuses IS NULL OR j.status = ANY (p_statuses))
   ORDER BY j.created_at DESC, j.id DESC
   LIMIT GREATEST(COALESCE(p_limit, 50), 0)
   OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

-- The Realtime read policy (rag_ingest_broadcast_read) is created by the mode file, right after the topic rule it calls.

REVOKE ALL ON FUNCTION rag_ingest_job_status_for_stage(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_ingest_mirror_processing_status(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_ingest_assert_job_lease(public.ingestion_jobs, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_ingest_broadcast_job(public.ingestion_jobs) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_ingest_job_status_for_stage(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_ingest_mirror_processing_status(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_ingest_assert_job_lease(public.ingestion_jobs, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_ingest_broadcast_job(public.ingestion_jobs) TO service_role;

REVOKE ALL ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_record_parse_attempt(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_fail_ingestion_job(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_delete_ingestion_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_get_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_get_job_for_document(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_get_ingestion_job_internal(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_list_ingestion_jobs(text, text[], text, integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_record_parse_attempt(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_fail_ingestion_job(uuid, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_delete_ingestion_job(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_get_ingestion_job(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_get_job_for_document(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_get_ingestion_job_internal(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_list_ingestion_jobs(text, text[], text, integer, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';