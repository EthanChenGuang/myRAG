-- 0426: a queued job that ends quarantined leaves its document quarantined (deferred item of 03.1-47).
-- The 0353 terminal transition of rag_advance_ingestion_job (body last replaced by 0425) set a non-current version to status and
-- processing_status failed for both the failed and the quarantined job status. The injection scan (and the image and invoice checks) set the
-- document to quarantined before the job ends, so the queued path turned every quarantined document into a failed one, and
-- rag_list_quarantine, which lists status quarantined, never showed it: it could not be reviewed, released or deleted as quarantined.
-- A quarantined job now keeps a version that is already quarantined at status quarantined with processing_status quarantined, which is what
-- the inline path writes. A quarantined job whose version was never marked quarantined still fails it closed, and failed is unchanged.
-- Every other line of the 0425 body is kept: the tenant_key match on every documents update, the lease check, the stage and field whitelist.
-- SECURITY DEFINER, SET search_path = '' and schema-qualified names as in 0425; execute stays with service_role only.
-- Idempotent: CREATE OR REPLACE with the 0353 signature, then REVOKE and GRANT. Live databases need this file applied after 0425; re-running
-- 0353 or 0425 afterwards puts back the old transition, so re-run this file after either of them.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_advance_ingestion_job(p_job_id uuid, p_worker text, p_stage text, p_status text, p_stage_state jsonb DEFAULT NULL::jsonb, p_timing_ms integer DEFAULT NULL::integer, p_fields jsonb DEFAULT '{}'::jsonb)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_expected := public.rag_ingest_job_status_for_stage(p_stage);
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

  SELECT * INTO v_job FROM public.ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);

  v_timings := COALESCE(v_job.timings, '{}'::jsonb);
  IF p_timing_ms IS NOT NULL AND p_stage IS NOT NULL THEN
    v_timings := v_timings || jsonb_build_object(
      p_stage,
      COALESCE((v_timings ->> p_stage)::bigint, 0) + p_timing_ms
    );
  END IF;

  UPDATE public.ingestion_jobs j
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
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs
       SET locked_by = NULL, lease_until = NULL, runner = NULL
     WHERE id = p_job_id
     RETURNING * INTO v_job;
  END IF;

  IF v_job.document_id IS NOT NULL THEN
    v_mirror := public.rag_ingest_mirror_processing_status(v_job.status);
    IF v_mirror IS NOT NULL THEN
      UPDATE public.documents d
         SET processing_status = v_mirror
       WHERE d.id = v_job.document_id
         AND d.tenant_key = v_job.tenant_key;
    END IF;
    IF p_status = 'ready' THEN
      UPDATE public.documents d SET status = 'ready' WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    ELSIF p_status = 'failed' THEN
      UPDATE public.documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    ELSIF p_status = 'quarantined' THEN
      UPDATE public.documents d
         SET status = CASE WHEN d.status = 'quarantined' THEN 'quarantined' ELSE 'failed' END,
             processing_status = CASE WHEN d.status = 'quarantined' THEN 'quarantined' ELSE 'failed' END
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    ELSIF p_status = 'needs_review' THEN
      UPDATE public.documents d
         SET status = 'ready',
             needs_review = true,
             needs_review_reason = COALESCE(v_job.needs_review_reason, d.needs_review_reason)
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    END IF;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$function$;


REVOKE ALL ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) TO service_role;

COMMIT;
