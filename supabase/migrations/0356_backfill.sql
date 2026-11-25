-- 0356: Backfill batch helpers — create batch, bulk enqueue, dedupe lookup, monitor and embed-batch tracking (Phase 3.1 plan 20).

BEGIN;

-- ---------------------------------------------------------------------------
-- Create a backfill batch row (validated tenant)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_create_ingestion_batch(
  p_tenant_key text,
  p_source_kind text,
  p_source_ref text,
  p_budget_usd numeric DEFAULT NULL,
  p_concurrency integer DEFAULT 1,
  p_runner text DEFAULT 'worker',
  p_created_by text DEFAULT NULL
)
RETURNS public.ingestion_batches
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.ingestion_batches%ROWTYPE;
BEGIN
  PERFORM rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_source_kind IS NULL OR p_source_kind NOT IN ('folder', 'bucket', 'manifest') THEN
    RAISE EXCEPTION 'backfill_refused: invalid_source_kind' USING ERRCODE = '22023';
  END IF;
  IF p_source_ref IS NULL OR btrim(p_source_ref) = '' THEN
    RAISE EXCEPTION 'backfill_refused: invalid_source_ref' USING ERRCODE = '22023';
  END IF;
  IF p_concurrency IS NULL OR p_concurrency < 1 THEN
    RAISE EXCEPTION 'backfill_refused: invalid_concurrency' USING ERRCODE = '22023';
  END IF;
  IF p_runner IS NULL OR p_runner NOT IN ('worker', 'ray') THEN
    RAISE EXCEPTION 'backfill_refused: invalid_runner' USING ERRCODE = '22023';
  END IF;
  IF p_budget_usd IS NOT NULL AND p_budget_usd < 0 THEN
    RAISE EXCEPTION 'backfill_refused: invalid_budget' USING ERRCODE = '22023';
  END IF;

  INSERT INTO ingestion_batches (
    tenant_key, source_kind, source_ref, budget_usd, concurrency, runner, created_by, status
  ) VALUES (
    p_tenant_key, p_source_kind, p_source_ref, p_budget_usd, p_concurrency, p_runner, p_created_by, 'pending'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_create_ingestion_batch(text, text, text, numeric, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_create_ingestion_batch(text, text, text, numeric, integer, text, text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Bulk enqueue backfill jobs (re-entrant; inherits batch tenant; priority 10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_enqueue_backfill_jobs(p_batch_id uuid, p_jobs jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant text;
  v_job jsonb;
  v_kind text;
  v_status text;
  v_inserted integer := 0;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  SELECT b.tenant_key INTO v_tenant FROM ingestion_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  IF p_jobs IS NULL OR jsonb_typeof(p_jobs) <> 'array' THEN
  RAISE EXCEPTION 'backfill_refused: jobs_must_be_array' USING ERRCODE = '22023';
  END IF;

  FOR v_job IN SELECT value FROM jsonb_array_elements(p_jobs) AS e(value) LOOP
    IF jsonb_typeof(v_job) <> 'object' THEN
      RAISE EXCEPTION 'backfill_refused: invalid_job_object' USING ERRCODE = '22023';
    END IF;

    v_kind := v_job ->> 'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('ingest', 'dry_run') THEN
      RAISE EXCEPTION 'backfill_refused: invalid_kind' USING ERRCODE = '22023';
    END IF;
    IF v_job ->> 'source_key' IS NULL OR btrim(v_job ->> 'source_key') = '' THEN
      RAISE EXCEPTION 'backfill_refused: invalid_source_key' USING ERRCODE = '22023';
    END IF;

    v_status := COALESCE(v_job ->> 'status', 'queued');
    IF v_status NOT IN (
      'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
      'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
    ) THEN
      RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
    END IF;

    INSERT INTO ingestion_jobs (
      tenant_key, kind, status, source, source_key, file_sha256, filename, mime_type,
      original_ref, settings, priority, batch_id, document_id
    ) VALUES (
      v_tenant,
      v_kind,
      v_status,
      NULLIF(v_job ->> 'source', ''),
      v_job ->> 'source_key',
      NULLIF(v_job ->> 'file_sha256', ''),
      NULLIF(v_job ->> 'filename', ''),
      NULLIF(v_job ->> 'mime_type', ''),
      CASE WHEN v_job ? 'original_ref' THEN v_job -> 'original_ref' ELSE NULL END,
      COALESCE(v_job -> 'settings', '{}'::jsonb),
      10,
      p_batch_id,
      NULL
    )
    ON CONFLICT (batch_id, kind, source_key) WHERE batch_id IS NOT NULL DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_enqueue_backfill_jobs(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_backfill_jobs(uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Tenant-scoped hash dedupe lookup (at most 1,000 hashes per call)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_existing_file_hashes(
  p_tenant_key text,
  p_hashes text[]
)
RETURNS TABLE (id uuid, file_sha256 text, tenant_key text, source_key text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_hashes IS NULL OR array_length(p_hashes, 1) IS NULL THEN
    RETURN;
  END IF;
  IF array_length(p_hashes, 1) > 1000 THEN
    RAISE EXCEPTION 'backfill_refused: too_many_hashes' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT d.id, d.file_sha256, d.tenant_key, d.source_key
    FROM documents d
   WHERE d.tenant_key = p_tenant_key
     AND d.is_current
     AND d.status = 'ready'
     AND d.file_sha256 IS NOT NULL
     AND d.file_sha256 = ANY (p_hashes)
   ORDER BY d.created_at, d.id;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_existing_file_hashes(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_existing_file_hashes(text, text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Batch progress (counts by kind and status, leased jobs, spent USD)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_batch_progress(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_spent numeric;
  v_leased integer;
  v_counts jsonb := '{}'::jsonb;
  rec record;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  SELECT b.spent_usd INTO v_spent FROM ingestion_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer INTO v_leased
    FROM ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now();

  FOR rec IN
    SELECT j.kind, j.status, count(*)::integer AS n
      FROM ingestion_jobs j
     WHERE j.batch_id = p_batch_id AND j.deleted_at IS NULL
     GROUP BY j.kind, j.status
     ORDER BY j.kind, j.status
  LOOP
    IF NOT v_counts ? rec.kind THEN
      v_counts := jsonb_set(v_counts, ARRAY[rec.kind], '{}'::jsonb, true);
    END IF;
    v_counts := jsonb_set(v_counts, ARRAY[rec.kind, rec.status], to_jsonb(rec.n), true);
  END LOOP;

  RETURN jsonb_build_object(
    'spent_usd', COALESCE(v_spent, 0),
    'leased', COALESCE(v_leased, 0),
    'counts', v_counts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rag_batch_progress(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_batch_progress(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Update batch status / dry-run report / totals
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_update_ingestion_batch(
  p_batch_id uuid,
  p_status text DEFAULT NULL,
  p_dry_run_report jsonb DEFAULT NULL,
  p_totals jsonb DEFAULT NULL
)
RETURNS public.ingestion_batches
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.ingestion_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  IF p_status IS NOT NULL AND p_status NOT IN (
    'pending', 'sampling', 'running', 'completed', 'failed', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  UPDATE ingestion_batches b
     SET status = COALESCE(p_status, b.status),
         dry_run_report = COALESCE(p_dry_run_report, b.dry_run_report),
         totals = COALESCE(p_totals, b.totals),
         updated_at = now()
   WHERE b.id = p_batch_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Page batch jobs for monitor / Ray runner (status filter, keyset on id)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_list_batch_jobs(
  p_batch_id uuid,
  p_status text DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS SETOF public.ingestion_jobs
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_after_created_at timestamptz;
  v_after_id uuid;
  v_limit integer;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  v_limit := GREATEST(LEAST(COALESCE(p_limit, 100), 1000), 1);

  IF p_status IS NOT NULL AND p_status NOT IN (
    'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
    'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_after_id IS NOT NULL THEN
    SELECT j.created_at, j.id INTO v_after_created_at, v_after_id
      FROM ingestion_jobs j
     WHERE j.id = p_after_id AND j.batch_id = p_batch_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backfill_refused: invalid_cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN QUERY
  SELECT j.*
    FROM ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND (p_status IS NULL OR j.status = p_status)
     AND (
       p_after_id IS NULL
       OR j.created_at > v_after_created_at
       OR (j.created_at = v_after_created_at AND j.id > v_after_id)
     )
   ORDER BY j.created_at, j.id
   LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_list_batch_jobs(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_list_batch_jobs(uuid, text, uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- OpenAI embed-batch tracking (D-35)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_record_embed_batch(
  p_batch_id uuid,
  p_profile_id text,
  p_provider text,
  p_provider_batch_id text DEFAULT NULL,
  p_input_file_id text DEFAULT NULL,
  p_input_count integer DEFAULT 0,
  p_status text DEFAULT 'pending'
)
RETURNS public.rag_embed_batches
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.rag_embed_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ingestion_batches b WHERE b.id = p_batch_id) THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM embedding_profiles ep WHERE ep.id = p_profile_id) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_profile' USING ERRCODE = '22023';
  END IF;
  IF p_provider IS NULL OR btrim(p_provider) = '' THEN
    RAISE EXCEPTION 'backfill_refused: invalid_provider' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'pending', 'validating', 'failed', 'in_progress', 'finalizing', 'completed',
    'expired', 'cancelling', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  IF p_input_count IS NULL OR p_input_count < 0 THEN
    RAISE EXCEPTION 'backfill_refused: invalid_input_count' USING ERRCODE = '22023';
  END IF;

  INSERT INTO rag_embed_batches (
    batch_id, profile_id, provider, provider_batch_id, input_file_id, input_count, status
  ) VALUES (
    p_batch_id, p_profile_id, p_provider, p_provider_batch_id, p_input_file_id, COALESCE(p_input_count, 0), p_status
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_record_embed_batch(uuid, text, text, text, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_record_embed_batch(uuid, text, text, text, text, integer, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.rag_update_embed_batch(
  p_embed_batch_id uuid,
  p_status text,
  p_provider_batch_id text DEFAULT NULL,
  p_output_file_id text DEFAULT NULL,
  p_error_file_id text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS public.rag_embed_batches
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.rag_embed_batches%ROWTYPE;
BEGIN
  IF p_embed_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_embed_batch' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'pending', 'validating', 'failed', 'in_progress', 'finalizing', 'completed',
    'expired', 'cancelling', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  UPDATE rag_embed_batches e
     SET status = p_status,
         provider_batch_id = COALESCE(p_provider_batch_id, e.provider_batch_id),
         output_file_id = COALESCE(p_output_file_id, e.output_file_id),
         error_file_id = COALESCE(p_error_file_id, e.error_file_id),
         error = COALESCE(p_error, e.error),
         updated_at = now()
   WHERE e.id = p_embed_batch_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: embed_batch_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_update_embed_batch(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_update_embed_batch(uuid, text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_open_embed_batches(p_batch_id uuid)
RETURNS SETOF public.rag_embed_batches
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
    FROM rag_embed_batches e
   WHERE e.batch_id = p_batch_id
     AND e.status NOT IN ('completed', 'cancelled')
   ORDER BY e.created_at, e.id;
$$;

REVOKE ALL ON FUNCTION public.rag_open_embed_batches(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_open_embed_batches(uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';