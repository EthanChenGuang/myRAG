-- 0425: empty search_path for every public SECURITY DEFINER function, every trigger function and every
-- function created from 0301 on (Phase 4 gap closure, plan 04-47). 0411 and the Phase 3, 3.1 and 4 migrations fixed search_path to
-- pg_catalog, public or to public (a few legacy functions to public, pg_temp, three multi-tenant legacy triggers to nothing), and a trigger
-- runs with the search_path of the statement that fired it, so a trigger without its own path breaks under an empty-path writer.
-- search_path = '' does not take pg_temp out of the path: when pg_temp is not listed, PostgreSQL still searches it first for relations and
-- types, before pg_catalog. So '' alone does not stop a temporary table from shadowing a name; qualifying every relation does, and the bodies
-- therefore name catalog tables pg_catalog.pg_attribute and pg_catalog.pg_extension as well. Functions and operators are never looked up in
-- pg_temp. Each function below is replaced with SET search_path = '' and a body that differs from the one it replaces only by schema-qualified
-- names: public. tables, row types, functions and the vector and halfvec types, OPERATOR(public.<=>) for pgvector (both setup files install
-- vector in public), and pg_catalog. catalog tables. Signature, defaults, volatility, SECURITY mode, owner and grants are unchanged: CREATE OR
-- REPLACE keeps the ACL and this file issues no GRANT or REVOKE. The first block stops with 55000 unless pgvector is in schema public (the
-- bodies name public.vector and OPERATOR(public.<=>)) and every function already exists, so the file never creates one with default PUBLIC
-- execute. tests/rag-db/search-path-empty.test.mts. Idempotent: CREATE OR REPLACE only.

BEGIN;

DO $search_path_precheck$
DECLARE
  v_missing text[];
  v_vector_schema text;
BEGIN
  SELECT n.nspname INTO v_vector_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';
  IF v_vector_schema IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION '0425: pgvector must be in schema public, found %; check with: SELECT extname, extnamespace::regnamespace FROM pg_catalog.pg_extension WHERE extname = ''vector''',
      COALESCE(v_vector_schema, 'no vector extension') USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(s.sig ORDER BY s.sig) INTO v_missing
  FROM pg_catalog.unnest(ARRAY[
    'public.check_admin_status()',
    'public.get_nango_stats(uuid)',
    'public.is_admin(uuid)',
    'public.is_subscribed(uuid)',
    'public.match_chunks_by_profile(text,text,integer,public.halfvec,integer,double precision,boolean)',
    'public.rag_activate_embedding_profile(text,text)',
    'public.rag_admin_audit_immutable()',
    'public.rag_admin_document_scope(uuid,uuid)',
    'public.rag_advance_ingestion_job(uuid,text,text,text,jsonb,integer,jsonb)',
    'public.rag_batch_has_room(uuid)',
    'public.rag_batch_progress(uuid)',
    'public.rag_begin_document_version(text,uuid,uuid,text,text,text,text,text,text,text,integer,boolean)',
    'public.rag_chunk_embeddings_guard()',
    'public.rag_chunks_legacy_defaults()',
    'public.rag_chunks_lexical_tsv()',
    'public.rag_chunks_profile_status()',
    'public.rag_claim_ingestion_job(uuid,text,text)',
    'public.rag_claim_ingestion_jobs(text,integer,boolean,text)',
    'public.rag_create_ingestion_batch(text,text,text,numeric,integer,text,text)',
    'public.rag_delete_doc_type_default(text,text,text)',
    'public.rag_delete_ingestion_job(uuid,uuid)',
    'public.rag_delete_quarantined(uuid,uuid)',
    'public.rag_doc_type_tenant_key_ok(text)',
    'public.rag_documents_legacy_defaults()',
    'public.rag_enqueue_backfill_jobs(uuid,jsonb)',
    'public.rag_enqueue_ingestion_job(text,text,text,text,text,text,text,jsonb,jsonb,integer,uuid,uuid,text)',
    'public.rag_exact_id_documents(text,text[],integer)',
    'public.rag_existing_file_hashes(text,text[])',
    'public.rag_find_content_duplicate(text,text,uuid)',
    'public.rag_find_invoices(text,text,date,date,numeric,numeric,text,integer)',
    'public.rag_get_doc_type_defaults(text,text,text,text)',
    'public.rag_get_document_for_type_change(uuid,text)',
    'public.rag_get_ingest_document(uuid,text)',
    'public.rag_get_ingest_origin(uuid,text)',
    'public.rag_get_ingestion_job(uuid,text)',
    'public.rag_get_ingestion_job_internal(uuid)',
    'public.rag_get_job_for_document(uuid,text)',
    'public.rag_get_parse_tier_overrides()',
    'public.rag_heartbeat_ingestion_job(uuid,text)',
    'public.rag_ingest_assert_job_lease(public.ingestion_jobs,text)',
    'public.rag_ingest_assert_tenant_key(text)',
    'public.rag_ingest_broadcast_job(public.ingestion_jobs)',
    'public.rag_ingest_job_status_for_stage(text)',
    'public.rag_ingest_mirror_processing_status(text)',
    'public.rag_latest_backfill_runs(text)',
    'public.rag_lexical_tsquery(text[])',
    'public.rag_lexical_tsvector(text)',
    'public.rag_list_batch_jobs(uuid,text,uuid,integer)',
    'public.rag_list_chunking_profiles()',
    'public.rag_list_embedding_profiles()',
    'public.rag_list_ingestion_jobs(text,text[],text,integer,integer)',
    'public.rag_list_quarantine(uuid,integer,integer)',
    'public.rag_mark_document_failed(uuid,text,text)',
    'public.rag_open_embed_batches(uuid)',
    'public.rag_parse_budget_month(text)',
    'public.rag_parse_cache_assert_key_parts(text,text)',
    'public.rag_parse_cache_for_document(text,uuid)',
    'public.rag_parse_cache_lookup(uuid,text,text,text)',
    'public.rag_parse_cache_prefix(uuid,text,text,text)',
    'public.rag_parse_cache_put(uuid,text,text,text,text,jsonb,bigint)',
    'public.rag_parse_cache_version_segment(text)',
    'public.rag_parse_doc_type_ok(text)',
    'public.rag_parse_tier_rank(text)',
    'public.rag_publish_document_version(uuid,text)',
    'public.rag_rechunk_advance(uuid,uuid)',
    'public.rag_rechunk_documents(text,text,text,uuid,integer)',
    'public.rag_rechunk_finish_run(uuid,text)',
    'public.rag_rechunk_gaps(uuid)',
    'public.rag_rechunk_get_run(uuid)',
    'public.rag_rechunk_missing(text,text,text)',
    'public.rag_rechunk_record_gap(uuid,uuid,text,text)',
    'public.rag_rechunk_resume_run(uuid)',
    'public.rag_rechunk_start_run(text,text,text,boolean)',
    'public.rag_record_backfill_gap(uuid,uuid[],text,text,text)',
    'public.rag_record_embed_batch(uuid,text,text,text,text,integer,text)',
    'public.rag_record_eval_evidence(text,jsonb,text)',
    'public.rag_record_parse_attempt(uuid,text,jsonb)',
    'public.rag_reembed_count(text,text)',
    'public.rag_reembed_derive_batch(uuid,integer)',
    'public.rag_reembed_finish_run(uuid,text)',
    'public.rag_reembed_get_run(uuid)',
    'public.rag_reembed_legacy_guard()',
    'public.rag_reembed_missing_batch(uuid,uuid,integer)',
    'public.rag_reembed_next_batch(uuid,uuid,integer)',
    'public.rag_reembed_pick(text,text,uuid,integer)',
    'public.rag_reembed_preview_batch(text,text,uuid,integer)',
    'public.rag_reembed_remaining(uuid)',
    'public.rag_reembed_resume_run(uuid,text)',
    'public.rag_reembed_rollback_run(uuid,text)',
    'public.rag_reembed_start_run(text,text,text,text)',
    'public.rag_reembed_write_batch(uuid,jsonb,uuid,bigint)',
    'public.rag_release_ingestion_job(uuid,text)',
    'public.rag_release_job_reservations(uuid)',
    'public.rag_release_parse_budget(uuid,integer,text)',
    'public.rag_release_quarantine(uuid,uuid)',
    'public.rag_relex_batch(jsonb,integer)',
    'public.rag_relex_candidates(uuid,integer,integer,text)',
    'public.rag_reserve_batch_budget(uuid,numeric)',
    'public.rag_reserve_parse_budget(uuid,integer,integer,text,integer)',
    'public.rag_rollback_embedding_profile(text)',
    'public.rag_save_ingest_state(uuid,text,text,jsonb)',
    'public.rag_set_doc_type_default(text,text,text,text,text)',
    'public.rag_set_document_fields(uuid,text,jsonb)',
    'public.rag_set_document_parse_cache(uuid,uuid)',
    'public.rag_set_embedding_profile_status(text,text,text)',
    'public.rag_set_parse_tier_override(text,text,text,uuid)',
    'public.rag_settle_parse_budget(uuid,integer,text,integer)',
    'public.rag_update_embed_batch(uuid,text,text,text,text,text)',
    'public.rag_update_ingestion_batch(uuid,text,jsonb,jsonb)',
    'public.set_last_updated_timestamp()',
    'public.update_updated_at_column()'
  ]::text[]) AS s(sig)
  WHERE pg_catalog.to_regprocedure(s.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '0425: apply the earlier migrations first, these functions are missing: %', v_missing USING ERRCODE = '55000';
  END IF;
END
$search_path_precheck$;

CREATE OR REPLACE FUNCTION public.check_admin_status()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admin_users WHERE id = auth.uid()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_nango_stats(p_user_id uuid)
 RETURNS TABLE(provider text, status text, last_sync_at timestamp with time zone, synced_files_count bigint, failed_files_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    nc.provider,
    nc.status,
    nc.last_sync_at,
    COUNT(CASE WHEN nsr.status = 'completed' THEN 1 END) AS synced_files_count,
    COUNT(CASE WHEN nsr.status = 'failed' THEN 1 END) AS failed_files_count
  FROM public.nango_connections nc
  LEFT JOIN public.nango_sync_records nsr
    ON nc.connection_id = nsr.connection_id AND nsr.user_id = nc.user_id
  WHERE nc.user_id = p_user_id
    AND (p_user_id = auth.uid() OR auth.role() = 'service_role')
  GROUP BY nc.provider, nc.status, nc.last_sync_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin(user_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admin_users WHERE id = user_uuid
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_subscribed(user_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN COALESCE(
    (user_uuid = auth.uid() OR auth.role() = 'service_role')
    AND EXISTS (
      SELECT 1
      FROM public.subscriptions
      WHERE user_id = user_uuid
      AND status = 'active'
      AND plan_type IN ('pro', 'enterprise')
    ),
    false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_chunks_by_profile(p_tenant_key text, p_profile_id text, p_dims integer, p_query public.halfvec, p_match_count integer, p_min_similarity double precision, p_require_active boolean DEFAULT true)
 RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_dims integer;
  v_status text;
  v_version text;
BEGIN
  SELECT p.dims, p.status INTO v_dims, v_status FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF v_dims IS NULL THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF v_dims <> p_dims OR public.vector_dims(p_query) <> v_dims THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;
  IF p_require_active AND v_status <> 'active' THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: profile not active' USING ERRCODE = '22000';
  END IF;

  SELECT extversion INTO v_version FROM pg_catalog.pg_extension WHERE extname = 'vector';
  IF v_version IS NOT NULL AND (string_to_array(v_version, '.'))[1:2]::int[] >= ARRAY[0, 8] THEN
    PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT c.id, c.document_id, c.content,
           1 - ((e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)) AS similarity,
           c.metadata
    FROM public.chunk_embeddings e
    JOIN public.document_chunks c ON c.id = e.chunk_id
    WHERE e.profile_id = %2$L
      AND e.tenant_key = $2
      AND c.is_current AND c.status = 'ready'
      AND 1 - ((e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)) > $3
    ORDER BY (e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)
    LIMIT $4
  $q$, v_dims, p_profile_id)
  USING p_query, p_tenant_key, p_min_similarity, p_match_count;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_activate_embedding_profile(p_target text, p_actor text)
 RETURNS TABLE(activated_profile text, previous_profile text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_target public.embedding_profiles%ROWTYPE;
  v_active text;
  v_missing bigint;
  v_bad bigint;
  v_evidence jsonb;
  v_recorded timestamptz;
  v_last timestamptz;
  v_slice_ok boolean;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'activation_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_target FROM public.embedding_profiles WHERE id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activation_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_target.status = 'active' THEN
    RAISE EXCEPTION 'activation_refused: already_active' USING ERRCODE = '55000';
  END IF;
  SELECT p.id INTO v_active FROM public.embedding_profiles p WHERE p.status = 'active';

  IF v_target.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = p_target);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'activation_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, p_target
      USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    SELECT count(*) INTO v_bad FROM public.chunk_embeddings e
    WHERE e.profile_id = p_target AND (e.embedding_model <> v_target.model OR e.dims <> v_target.dims);
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'activation_refused: model_mismatch (% rows of profile % differ from model % at % dims)', v_bad, p_target, v_target.model, v_target.dims
        USING ERRCODE = '55000';
    END IF;
  END IF;

  v_evidence := v_target.eval_evidence;
  IF v_evidence IS NULL OR jsonb_typeof(v_evidence) <> 'object' THEN
    RAISE EXCEPTION 'activation_refused: eval_missing' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'target_profile' IS DISTINCT FROM p_target THEN
    RAISE EXCEPTION 'activation_refused: eval_target_mismatch' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'baseline_profile' IS DISTINCT FROM v_active THEN
    RAISE EXCEPTION 'activation_refused: eval_baseline_mismatch (evidence baseline %, active profile %)', v_evidence->>'baseline_profile', v_active
      USING ERRCODE = '55000';
  END IF;
  IF v_evidence->'gate_passed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'activation_refused: eval_failed' USING ERRCODE = '55000';
  END IF;
  v_slice_ok := coalesce(v_evidence#>'{pre_migration,passed}' = 'true'::jsonb, false)
    AND coalesce(CASE WHEN jsonb_typeof(v_evidence#>'{pre_migration,n}') = 'number' THEN (v_evidence#>>'{pre_migration,n}')::numeric >= 1 END, false);
  IF NOT v_slice_ok THEN
    RAISE EXCEPTION 'activation_refused: pre_migration_missing' USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.embedding_backfill_runs r
      WHERE r.id::text = v_evidence->>'backfill_run_id' AND r.profile_id = p_target AND r.status = 'completed'
    ) THEN
      RAISE EXCEPTION 'activation_refused: eval_run_mismatch' USING ERRCODE = '55000';
    END IF;
    SELECT max(e.embedded_at) INTO v_last FROM public.chunk_embeddings e WHERE e.profile_id = p_target;
  ELSE
    SELECT max(c.created_at) INTO v_last FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NOT NULL;
  END IF;

  BEGIN
    v_recorded := (v_evidence->>'recorded_at')::timestamptz;
  EXCEPTION WHEN others THEN
    v_recorded := NULL;
  END;
  IF v_recorded IS NULL OR (v_last IS NOT NULL AND v_recorded < v_last) THEN
    RAISE EXCEPTION 'activation_refused: eval_stale (evidence recorded %, data embedded %)', v_recorded, v_last USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profiles SET status = 'available' WHERE status = 'active';
  UPDATE public.embedding_profiles
  SET status = 'active', previous_active_id = v_active, activated_at = now(), activated_by = p_actor
  WHERE id = p_target;

  RETURN QUERY SELECT p_target, v_active;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_admin_audit_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'rag_admin_audit is append-only';
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_admin_document_scope(p_document_id uuid, p_actor uuid)
 RETURNS TABLE(tenant_key text, user_id uuid, organization_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
BEGIN
  keys := public.rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  SELECT d.tenant_key, d.user_id, d.organization_id
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = ANY (keys);
END
$function$;

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
    ELSIF p_status IN ('failed', 'quarantined') THEN
      UPDATE public.documents d
         SET status = 'failed', processing_status = 'failed'
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

CREATE OR REPLACE FUNCTION public.rag_batch_has_room(p_batch_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_concurrency integer;
  v_leased integer;
BEGIN
  IF p_batch_id IS NULL THEN
    RETURN true;
  END IF;
  SELECT b.concurrency INTO v_concurrency
    FROM public.ingestion_batches b
   WHERE b.id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT count(*)::integer INTO v_leased
    FROM public.ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now();
  RETURN v_leased < v_concurrency;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_batch_progress(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_spent numeric;
  v_leased integer;
  v_counts jsonb := '{}'::jsonb;
  rec record;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  SELECT b.spent_usd INTO v_spent FROM public.ingestion_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer INTO v_leased
    FROM public.ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now();

  FOR rec IN
    SELECT j.kind,
           CASE WHEN j.status = 'embedding' AND j.stage = 'embed_deferred' THEN 'embed_deferred' ELSE j.status END AS status,
           count(*)::integer AS n
      FROM public.ingestion_jobs j
     WHERE j.batch_id = p_batch_id AND j.deleted_at IS NULL
     GROUP BY 1, 2
     ORDER BY 1, 2
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
$function$;

CREATE OR REPLACE FUNCTION public.rag_begin_document_version(p_tenant_key text, p_user_id uuid, p_org_id uuid, p_source text, p_source_key text, p_filename text, p_file_sha256 text, p_doc_type text, p_doc_type_origin text, p_profile_id text, p_profile_version integer, p_force_new_version boolean DEFAULT false)
 RETURNS TABLE(outcome text, document_id uuid, version integer, lineage_id uuid, duplicate_of uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  multi_tenant boolean;
  expected_key text;
  duplicate_id uuid;
  existing record;
  previous record;
  new_id uuid := gen_random_uuid();
  new_version integer;
  new_lineage uuid;
  carried jsonb := '{}'::jsonb;
  forced boolean := COALESCE(p_force_new_version, false);
BEGIN
  IF p_tenant_key IS NULL OR p_source_key IS NULL OR p_source_key = '' THEN
    RAISE EXCEPTION 'invalid_argument: p_tenant_key and p_source_key are required';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag') THEN
    RAISE EXCEPTION 'invalid_source: %', COALESCE(p_source, '(null)');
  END IF;

  -- user_id is NOT NULL in the multi-tenant schema and nullable in the single-tenant one.
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    expected_key := CASE WHEN p_org_id IS NOT NULL THEN 'o:' || p_org_id::text ELSE 'u:' || p_user_id::text END;
  ELSE
    expected_key := 's:default';
  END IF;
  IF p_tenant_key IS DISTINCT FROM expected_key THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'p_tenant_key is not the tenant key of the given user and organization';
  END IF;
  IF multi_tenant AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: p_user_id is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_key || '|' || p_source || '|' || p_source_key, 0));

  IF p_file_sha256 IS NOT NULL AND NOT forced THEN
    SELECT d.id INTO duplicate_id
    FROM public.documents d
    WHERE d.tenant_key = p_tenant_key AND d.file_sha256 = p_file_sha256 AND d.is_current AND d.status = 'ready'
    ORDER BY d.created_at, d.id
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT 'skipped_duplicate'::text, NULL::uuid, NULL::integer, NULL::uuid, duplicate_id;
      RETURN;
    END IF;
  END IF;

  SELECT d.id, d.version, d.lineage_id INTO existing
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
    AND d.status = 'processing' AND NOT d.is_current AND d.file_sha256 IS NOT DISTINCT FROM p_file_sha256
    AND (NOT forced OR d.doc_type = COALESCE(p_doc_type, 'general'))
  ORDER BY d.version DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'resumed'::text, existing.id, existing.version, existing.lineage_id, NULL::uuid;
    RETURN;
  END IF;

  SELECT d.lineage_id, d.metadata INTO previous
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
  ORDER BY d.is_current DESC, d.version DESC, d.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    new_lineage := previous.lineage_id;
    SELECT COALESCE(max(d.version), 0) + 1 INTO new_version FROM public.documents d WHERE d.lineage_id = new_lineage;
    IF previous.metadata ? 'external_url' THEN
      carried := jsonb_build_object('external_url', previous.metadata -> 'external_url');
    END IF;
  ELSE
    new_lineage := new_id;
    new_version := 1;
  END IF;

  INSERT INTO public.documents (
    id, lineage_id, version, is_current, status, source, source_key, filename, content, metadata,
    user_id, organization_id, file_sha256, doc_type, doc_type_origin, processing_profile_id, processing_profile_version
  ) VALUES (
    new_id, new_lineage, new_version, false, 'processing', p_source, p_source_key, COALESCE(NULLIF(p_filename, ''), p_source_key), '', carried,
    CASE WHEN multi_tenant THEN p_user_id END, CASE WHEN multi_tenant THEN p_org_id END, p_file_sha256,
    COALESCE(p_doc_type, 'general'), COALESCE(p_doc_type_origin, 'fallback'), p_profile_id, p_profile_version
  );

  RETURN QUERY SELECT 'created'::text, new_id, new_version, new_lineage, NULL::uuid;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_chunk_embeddings_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_dims integer;
  v_tenant text;
BEGIN
  SELECT p.dims INTO v_dims FROM public.embedding_profiles p WHERE p.id = NEW.profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF public.vector_dims(NEW.embedding) <> v_dims THEN
    RAISE EXCEPTION 'expected % dimensions, not %', v_dims, public.vector_dims(NEW.embedding) USING ERRCODE = '22000';
  END IF;

  SELECT c.tenant_key INTO v_tenant FROM public.document_chunks c WHERE c.id = NEW.chunk_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'chunk_embeddings: chunk % has no tenant_key', NEW.chunk_id USING ERRCODE = '23502';
  END IF;
  NEW.tenant_key := v_tenant;
  NEW.dims := public.vector_dims(NEW.embedding);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_chunks_legacy_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  parent record;
  legacy_shape boolean := NEW.tenant_key IS NULL;
BEGIN
  -- SECURITY DEFINER so the lookup does not depend on what the inserting role may read: the chunk's tenant_key is always its document's,
  -- whatever the writer sent. Every other denormalised column only fills a NULL.
  SELECT d.tenant_key, d.version, d.doc_type, d.doc_date, d.language, d.source, d.parser_used
  INTO parent
  FROM public.documents d
  WHERE d.id = NEW.document_id;
  IF FOUND THEN
    NEW.tenant_key := parent.tenant_key;
    NEW.version := COALESCE(NEW.version, parent.version);
    NEW.doc_type := COALESCE(NEW.doc_type, parent.doc_type);
    NEW.doc_date := COALESCE(NEW.doc_date, parent.doc_date);
    NEW.language := COALESCE(NEW.language, parent.language);
    NEW.source := COALESCE(NEW.source, parent.source);
    NEW.parser_used := COALESCE(NEW.parser_used, parent.parser_used);
  END IF;

  IF legacy_shape AND NEW.chunk_kind = 'text' AND NEW.metadata->'image_url' IS NOT NULL THEN
    NEW.chunk_kind := 'image';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_chunks_lexical_tsv()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_meta_version text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.lexical_text IS DISTINCT FROM OLD.lexical_text THEN
    NEW.lexical_tsv := public.rag_lexical_tsvector(NEW.lexical_text);
    v_meta_version := NEW.metadata ->> 'lexical_version';
    IF v_meta_version ~ '^[1-9][0-9]*$' THEN
      NEW.lexical_version := v_meta_version::integer;
    ELSE
      NEW.lexical_version := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    v_meta_version := NEW.metadata ->> 'lexical_version';
    IF v_meta_version ~ '^[1-9][0-9]*$' THEN
      NEW.lexical_version := v_meta_version::integer;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_chunks_profile_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.chunking_profile_id IS DISTINCT FROM 'legacy' AND NEW.status = 'ready' THEN
    NEW.status := 'variant';
  END IF;
  RETURN NEW;
END;
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.rag_create_ingestion_batch(p_tenant_key text, p_source_kind text, p_source_ref text, p_budget_usd numeric DEFAULT NULL::numeric, p_concurrency integer DEFAULT 1, p_runner text DEFAULT 'worker'::text, p_created_by text DEFAULT NULL::text)
 RETURNS public.ingestion_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.ingestion_batches%ROWTYPE;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

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

  INSERT INTO public.ingestion_batches (
    tenant_key, source_kind, source_ref, budget_usd, concurrency, runner, created_by, status
  ) VALUES (
    p_tenant_key, p_source_kind, p_source_ref, p_budget_usd, p_concurrency, p_runner, p_created_by, 'pending'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_delete_doc_type_default(p_tenant_key text, p_source_kind text, p_source_ref text)
 RETURNS TABLE(deleted boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  removed integer;
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload') THEN
    RAISE EXCEPTION 'invalid_source_kind';
  END IF;
  DELETE FROM public.rag_doc_type_defaults d
  WHERE d.tenant_key = p_tenant_key AND d.source_kind = p_source_kind AND COALESCE(d.source_ref, '') = COALESCE(btrim(p_source_ref), '');
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN QUERY SELECT removed > 0;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_delete_ingestion_job(p_job_id uuid, p_actor uuid)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_keys text[];
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc public.documents%ROWTYPE;
BEGIN
  v_keys := public.rag_admin_tenant_keys(p_actor);
  SELECT * INTO v_job FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.tenant_key = ANY (v_keys)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_job.document_id IS NOT NULL THEN
    SELECT * INTO v_doc FROM public.documents d WHERE d.id = v_job.document_id FOR UPDATE;
    IF FOUND AND v_doc.is_current THEN
      RAISE EXCEPTION 'ingest_refused: document_is_current' USING ERRCODE = '22023';
    END IF;
    IF FOUND AND NOT v_doc.is_current THEN
      UPDATE public.documents d SET superseded_by = NULL WHERE d.superseded_by = v_doc.id;
      DELETE FROM public.document_chunks c WHERE c.document_id = v_doc.id;
      DELETE FROM public.documents d WHERE d.id = v_doc.id;
    END IF;
  END IF;

  UPDATE public.ingestion_jobs j
     SET deleted_at = now(),
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
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
$function$;

CREATE OR REPLACE FUNCTION public.rag_delete_quarantined(p_document_id uuid, p_actor uuid)
 RETURNS TABLE(document_id uuid, lineage_id uuid, tenant_key text, version integer, rule_ids text[], artifact_keys text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  doc public.documents%ROWTYPE;
  ids text[];
  stored text[];
BEGIN
  keys := public.rag_admin_tenant_keys(p_actor);
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status <> 'quarantined' THEN
    RAISE EXCEPTION 'not_quarantined';
  END IF;

  ids := CASE WHEN jsonb_typeof(doc.metadata #> '{quarantine,rule_ids}') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(doc.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END;
  stored := ARRAY(
    SELECT DISTINCT s.key FROM (
      SELECT e.value AS key
      FROM jsonb_each_text(CASE WHEN jsonb_typeof(doc.processing_state -> 'artifacts') = 'object' THEN doc.processing_state -> 'artifacts' ELSE '{}'::jsonb END) AS e
      UNION ALL
      SELECT doc.original_path
    ) AS s
    WHERE s.key IS NOT NULL AND s.key <> ''
  );

  UPDATE public.documents d SET superseded_by = NULL WHERE d.superseded_by = doc.id;
  -- The single-tenant schema has no cascade from documents to document_chunks; chunk_embeddings and gaps cascade from the chunks.
  DELETE FROM public.document_chunks c WHERE c.document_id = doc.id;
  DELETE FROM public.documents d WHERE d.id = doc.id;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('delete_quarantined', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, ids);

  RETURN QUERY SELECT doc.id, doc.lineage_id, doc.tenant_key, doc.version, ids, stored;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_doc_type_tenant_key_ok(p_tenant_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  multi_tenant boolean;
BEGIN
  IF p_tenant_key IS NULL THEN
    RETURN false;
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    RETURN p_tenant_key ~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  END IF;
  RETURN p_tenant_key = 's:default';
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_documents_legacy_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  original_source text;
BEGIN
  IF NEW.lineage_id IS NULL THEN
    NEW.parser_used := COALESCE(NEW.parser_used, 'llamaparse');
    NEW.parser_version := COALESCE(NEW.parser_version, 'legacy');
  END IF;

  IF NEW.source IS NULL OR NEW.source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag') THEN
    original_source := NEW.source;
    IF original_source IN ('google-drive', 'notion', 'dropbox') AND COALESCE(NEW.source_provider, '') = '' THEN
      NEW.source_provider := original_source;
    END IF;
    NEW.source := CASE
      WHEN original_source IN ('google-drive', 'notion', 'dropbox') THEN 'nango'
      WHEN original_source = 'scrape' THEN 'scraper'
      ELSE 'config_upload'
    END;
    IF original_source IS NOT NULL AND (NEW.metadata IS NULL OR NEW.metadata->'legacy_source' IS NULL) THEN
      NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('legacy_source', original_source);
    END IF;
  END IF;

  NEW.lineage_id := COALESCE(NEW.lineage_id, NEW.id);
  NEW.source_key := COALESCE(NEW.source_key, 'legacy:' || NEW.id::text);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_enqueue_backfill_jobs(p_batch_id uuid, p_jobs jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  SELECT b.tenant_key INTO v_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
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

    INSERT INTO public.ingestion_jobs (
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
$function$;

CREATE OR REPLACE FUNCTION public.rag_enqueue_ingestion_job(p_tenant_key text, p_kind text DEFAULT 'ingest'::text, p_source text DEFAULT NULL::text, p_source_key text DEFAULT NULL::text, p_file_sha256 text DEFAULT NULL::text, p_filename text DEFAULT NULL::text, p_mime_type text DEFAULT NULL::text, p_original_ref jsonb DEFAULT NULL::jsonb, p_settings jsonb DEFAULT '{}'::jsonb, p_priority integer DEFAULT 100, p_document_id uuid DEFAULT NULL::uuid, p_batch_id uuid DEFAULT NULL::uuid, p_status text DEFAULT 'queued'::text)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_doc_tenant text;
  v_batch_tenant text;
  v_row public.ingestion_jobs%ROWTYPE;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_kind IS NULL OR p_kind NOT IN ('ingest', 'dry_run', 'delete') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_source_key IS NULL OR btrim(p_source_key) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_source_key' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
    'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
  ) THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_document_id IS NOT NULL THEN
    SELECT d.tenant_key INTO v_doc_tenant FROM public.documents d WHERE d.id = p_document_id;
    IF NOT FOUND OR v_doc_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: document_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT b.tenant_key INTO v_batch_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
    IF NOT FOUND OR v_batch_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: batch_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.ingestion_jobs (
    tenant_key, kind, status, source, source_key, file_sha256, filename, mime_type,
    original_ref, settings, priority, document_id, batch_id
  ) VALUES (
    p_tenant_key, p_kind, p_status, p_source, p_source_key, p_file_sha256, p_filename, p_mime_type,
    p_original_ref, COALESCE(p_settings, '{}'::jsonb), COALESCE(p_priority, 100), p_document_id, p_batch_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_exact_id_documents(p_tenant_key text, p_tokens text[], p_limit integer)
 RETURNS TABLE(chunk_id uuid, document_id uuid, content text, metadata jsonb, matched_field text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  tokens text[];
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::text[]) INTO tokens
  FROM (
    SELECT lower(btrim(raw)) AS t FROM unnest(COALESCE(p_tokens, ARRAY[]::text[])) WITH ORDINALITY AS u(raw, n)
    WHERE n <= 20 AND length(btrim(raw)) BETWEEN 2 AND 100
  ) cleaned;
  IF cardinality(tokens) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT hit.id, hit.document_id, hit.content, hit.metadata, hit.matched_field
  FROM (
    SELECT DISTINCT ON (m.id) m.id, m.document_id, m.content, m.metadata, m.matched_field, m.created_at, m.chunk_index
    FROM (
      SELECT c.id, c.document_id, c.content, c.metadata,
             CASE WHEN lower(d.invoice_number) = ANY (tokens) THEN 'invoice_number' ELSE 'supplier_tax_id' END AS matched_field,
             1 AS priority, c.created_at, c.chunk_index
      FROM public.documents d
      JOIN public.document_chunks c ON c.document_id = d.id
      WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
        AND c.tenant_key = p_tenant_key AND c.is_current AND c.status = 'ready'
        AND c.chunk_kind IN ('invoice_header', 'table')
        AND (lower(d.invoice_number) = ANY (tokens) OR lower(d.supplier_tax_id) = ANY (tokens))
      UNION ALL
      SELECT c.id, c.document_id, c.content, c.metadata, 'lexical_text'::text, 2, c.created_at, c.chunk_index
      FROM public.document_chunks c
      WHERE c.tenant_key = p_tenant_key AND c.is_current AND c.status = 'ready'
        AND c.lexical_text IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest(tokens) AS k(token)
          WHERE lower(c.lexical_text) ~ ('(^|[^[:alnum:]_-])' || regexp_replace(k.token, '([][\\.^$|?*+(){}-])', '\\\1', 'g') || '($|[^[:alnum:]_-])')
        )
    ) m
    ORDER BY m.id, m.priority
  ) hit
  ORDER BY (hit.matched_field = 'lexical_text'), hit.created_at, hit.chunk_index, hit.id
  LIMIT cap;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_existing_file_hashes(p_tenant_key text, p_hashes text[])
 RETURNS TABLE(id uuid, file_sha256 text, tenant_key text, source_key text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_hashes IS NULL OR array_length(p_hashes, 1) IS NULL THEN
    RETURN;
  END IF;
  IF array_length(p_hashes, 1) > 1000 THEN
    RAISE EXCEPTION 'backfill_refused: too_many_hashes' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT d.id, d.file_sha256, d.tenant_key, d.source_key
    FROM public.documents d
   WHERE d.tenant_key = p_tenant_key
     AND d.is_current
     AND d.status = 'ready'
     AND d.file_sha256 IS NOT NULL
     AND d.file_sha256 = ANY (p_hashes)
   ORDER BY d.created_at, d.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_find_content_duplicate(p_tenant_key text, p_content_hash text, p_document_id uuid)
 RETURNS TABLE(duplicate_of uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF p_document_id IS NOT NULL THEN
    PERFORM 1 FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
    END IF;
  END IF;
  IF p_content_hash IS NULL OR p_content_hash = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT d.id
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.content_hash = p_content_hash AND d.is_current AND d.status = 'ready'
    AND d.id IS DISTINCT FROM p_document_id
  ORDER BY d.created_at, d.id
  LIMIT 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_find_invoices(p_tenant_key text, p_supplier text, p_date_from date, p_date_to date, p_amount_min numeric, p_amount_max numeric, p_currency text, p_limit integer)
 RETURNS TABLE(document_id uuid, filename text, invoice_number text, supplier_name text, supplier_tax_id text, issue_date date, gross_total text, currency text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  needle text := lower(btrim(COALESCE(p_supplier, '')));
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  RETURN QUERY
  SELECT d.id, d.filename, d.invoice_number, d.supplier_name, d.supplier_tax_id, d.issue_date, d.gross_total::text, d.currency
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.is_current
    AND d.status = 'ready'
    AND d.doc_type = 'invoice_receipt'
    AND (needle = '' OR position(needle IN lower(COALESCE(d.supplier_name, ''))) > 0 OR lower(COALESCE(d.supplier_tax_id, '')) = needle)
    AND (p_date_from IS NULL OR d.issue_date >= p_date_from)
    AND (p_date_to IS NULL OR d.issue_date <= p_date_to)
    AND (p_amount_min IS NULL OR d.gross_total >= p_amount_min)
    AND (p_amount_max IS NULL OR d.gross_total <= p_amount_max)
    AND (p_currency IS NULL OR d.currency = p_currency)
  ORDER BY d.issue_date DESC NULLS LAST, d.created_at DESC, d.id
  LIMIT cap;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_doc_type_defaults(p_tenant_key text, p_source text, p_connection_id text, p_folder_id text)
 RETURNS TABLE(tenant_key text, source_kind text, source_ref text, doc_type text, updated_by text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  RETURN QUERY
  SELECT d.tenant_key, d.source_kind, d.source_ref, d.doc_type, d.updated_by, d.updated_at
  FROM public.rag_doc_type_defaults d
  WHERE d.tenant_key = p_tenant_key
    AND (
      p_source IS NULL
      OR d.source_kind = 'tenant'
      OR (d.source_kind = p_source AND (
        d.source_ref IS NULL
        OR (p_source = 'nango' AND d.source_ref IS NOT NULL AND (d.source_ref = p_connection_id OR d.source_ref = p_folder_id))
      ))
    )
  ORDER BY d.source_kind, d.source_ref NULLS FIRST;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_document_for_type_change(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(lineage_id uuid, version integer, is_current boolean, status text, source text, source_key text, filename text, doc_type text, processing_profile_id text, parser_used text, parser_version text, original_path text, source_provider text, source_file_id text, source_connection_id text, metadata jsonb, processing_state jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.lineage_id, d.version, d.is_current, d.status, d.source, d.source_key, d.filename, d.doc_type, d.processing_profile_id,
         d.parser_used, d.parser_version, d.original_path, d.source_provider, d.source_file_id, d.source_connection_id,
         COALESCE(d.metadata, '{}'::jsonb), COALESCE(d.processing_state, '{}'::jsonb)
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_ingest_document(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(status text, version integer, processing_status text, processing_state jsonb, filename text, doc_type text, parser_used text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.status, d.version, d.processing_status, d.processing_state, d.filename, d.doc_type, d.parser_used, d.created_at
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_ingest_origin(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(lineage_id uuid, original_path text, source text, source_key text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.lineage_id, d.original_path, d.source, d.source_key
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_ingestion_job(p_job_id uuid, p_tenant_key text)
 RETURNS public.ingestion_jobs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT j.*
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.tenant_key = p_tenant_key
     AND j.deleted_at IS NULL
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_ingestion_job_internal(p_job_id uuid)
 RETURNS public.ingestion_jobs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT j.* FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_job_for_document(p_document_id uuid, p_tenant_key text)
 RETURNS public.ingestion_jobs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT j.*
    FROM public.ingestion_jobs j
   WHERE j.document_id = p_document_id
     AND j.tenant_key = p_tenant_key
     AND j.deleted_at IS NULL
   ORDER BY j.created_at DESC
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_parse_tier_overrides()
 RETURNS TABLE(doc_type text, min_tier text, max_tier text, updated_by text, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT o.doc_type, o.min_tier, o.max_tier, o.updated_by, o.updated_at
    FROM public.rag_parse_tier_overrides o
   ORDER BY o.doc_type;
$function$;

CREATE OR REPLACE FUNCTION public.rag_heartbeat_ingestion_job(p_job_id uuid, p_worker text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE public.ingestion_jobs j
     SET lease_until = now() + interval '120 seconds',
         updated_at = now()
   WHERE j.id = p_job_id
     AND j.locked_by = p_worker
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now()
   RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_assert_job_lease(p_job public.ingestion_jobs, p_worker text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_job.locked_by IS DISTINCT FROM p_worker
     OR p_job.lease_until IS NULL
     OR p_job.lease_until <= now() THEN
    RAISE EXCEPTION 'lease_lost' USING ERRCODE = '55000';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_assert_tenant_key(p_tenant_key text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  multi_tenant boolean;
BEGIN
  IF p_tenant_key IS NULL OR btrim(p_tenant_key) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key ~ '[A-Z]' OR position('=' IN p_tenant_key) > 0 OR position('''' IN p_tenant_key) > 0 THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    IF p_tenant_key !~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
    END IF;
  ELSIF p_tenant_key <> 's:default' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_broadcast_job(p_job public.ingestion_jobs)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_job_status_for_stage(p_stage text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_mirror_processing_status(p_ledger_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.rag_latest_backfill_runs(p_tenant_key text)
 RETURNS TABLE(profile_id text, run_id uuid, status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT DISTINCT ON (r.profile_id) r.profile_id, r.id, r.status
  FROM public.embedding_backfill_runs r
  WHERE r.tenant_key IS NULL OR r.tenant_key = p_tenant_key
  ORDER BY r.profile_id, (r.status = 'running') DESC, r.started_at DESC, r.id
$function$;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsquery(p_tokens text[])
 RETURNS tsquery
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  SELECT NULLIF(string_agg(quote_literal(t.tok), ' | '), '')::tsquery
  FROM (
    SELECT DISTINCT tok
    FROM unnest(coalesce(p_tokens, '{}'::text[])) AS u(tok)
    WHERE tok <> '' AND octet_length(tok) <= 255 AND tok !~ '[''\\[:space:]]'
    LIMIT 64
  ) AS t
$function$;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsvector(p_lexical_text text)
 RETURNS tsvector
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  SELECT coalesce(string_agg(quote_literal(t.tok) || ':' || least(t.ord, 16383)::text, ' ' ORDER BY t.ord), '')::tsvector
  FROM unnest(string_to_array(coalesce(p_lexical_text, ''), ' ')) WITH ORDINALITY AS t(tok, ord)
  WHERE t.tok <> '' AND octet_length(t.tok) <= 255 AND t.tok !~ '[''\\[:space:]]'
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_batch_jobs(p_batch_id uuid, p_status text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
 RETURNS SETOF public.ingestion_jobs
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      FROM public.ingestion_jobs j
     WHERE j.id = p_after_id AND j.batch_id = p_batch_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backfill_refused: invalid_cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN QUERY
  SELECT j.*
    FROM public.ingestion_jobs j
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
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_chunking_profiles()
 RETURNS TABLE(id text, doc_type text, child_tokens integer, parent_mode text, parent_tokens integer, status text, preset text, previous_active_id text, is_active boolean, created_at timestamp with time zone, activated_at timestamp with time zone, activated_by text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    p.id,
    p.doc_type,
    p.child_tokens,
    p.parent_mode,
    p.parent_tokens,
    p.status,
    p.preset,
    p.previous_active_id,
  (p.status = 'active') AS is_active,
    p.created_at,
    p.activated_at,
    p.activated_by
  FROM public.chunking_profiles p
  ORDER BY p.doc_type, p.id
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_embedding_profiles()
 RETURNS TABLE(id text, provider text, model text, dims integer, storage text, status text, query_instruction text, score_calibration jsonb, activated_at timestamp with time zone, activated_by text, previous_active_id text, has_evidence boolean, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT p.id, p.provider, p.model, p.dims, p.storage, p.status, p.query_instruction, p.score_calibration,
         p.activated_at, p.activated_by, p.previous_active_id, p.eval_evidence IS NOT NULL, p.created_at
  FROM public.embedding_profiles p
  ORDER BY p.id
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_ingestion_jobs(p_tenant_key text DEFAULT NULL::text, p_statuses text[] DEFAULT NULL::text[], p_kind text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS SETOF public.ingestion_jobs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT j.*
    FROM public.ingestion_jobs j
   WHERE j.deleted_at IS NULL
     AND (p_tenant_key IS NULL OR j.tenant_key = p_tenant_key)
     AND (p_kind IS NULL OR j.kind = p_kind)
     AND (p_statuses IS NULL OR j.status = ANY (p_statuses))
   ORDER BY j.created_at DESC, j.id DESC
   LIMIT GREATEST(COALESCE(p_limit, 50), 0)
   OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_quarantine(p_actor uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(document_id uuid, lineage_id uuid, tenant_key text, filename text, source text, version integer, rule_ids text[], snippets text[], quarantined_at timestamp with time zone, detected_by text, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  page_size integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  skip integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  keys := public.rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  WITH quarantined AS (
    SELECT
      d.id,
      d.lineage_id,
      d.tenant_key,
      d.filename,
      d.source,
      d.version,
      CASE WHEN jsonb_typeof(d.metadata #> '{quarantine,rule_ids}') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(d.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END AS rule_ids,
      CASE WHEN jsonb_typeof(d.metadata #> '{quarantine,snippets}') = 'array'
           THEN ARRAY(SELECT left(s.value, 80) FROM jsonb_array_elements_text(d.metadata #> '{quarantine,snippets}') AS s(value) LIMIT 3)
           ELSE '{}'::text[] END AS snippets,
      CASE WHEN (d.metadata #>> '{quarantine,quarantined_at}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
           THEN (d.metadata #>> '{quarantine,quarantined_at}')::timestamptz ELSE d.created_at END AS quarantined_at,
      CASE WHEN (d.metadata #>> '{invoice_extraction,status}') = 'quarantined' THEN 'invoice_extraction' ELSE 'injection_scan' END AS detected_by
    FROM public.documents d
    WHERE d.status = 'quarantined' AND d.tenant_key = ANY (keys)
  )
  SELECT q.id, q.lineage_id, q.tenant_key, q.filename, q.source, q.version, q.rule_ids, q.snippets, q.quarantined_at, q.detected_by,
         count(*) OVER () AS total_count
  FROM quarantined q
  ORDER BY q.quarantined_at DESC, q.id
  LIMIT page_size OFFSET skip;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_mark_document_failed(p_document_id uuid, p_tenant_key text, p_reason text)
 RETURNS TABLE(document_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc public.documents%ROWTYPE;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.is_current THEN
    RAISE EXCEPTION 'document_is_current' USING DETAIL = 'a current version is not marked failed';
  END IF;
  UPDATE public.documents d
  SET status = 'failed',
      processing_status = 'failed',
      processing_state = COALESCE(d.processing_state, '{}'::jsonb) || jsonb_build_object('failure_reason', left(COALESCE(p_reason, ''), 1000))
  WHERE d.id = p_document_id;
  UPDATE public.document_chunks c SET status = 'failed' WHERE c.document_id = p_document_id;
  RETURN QUERY SELECT p_document_id, 'failed'::text;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_open_embed_batches(p_batch_id uuid)
 RETURNS SETOF public.rag_embed_batches
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT e.*
    FROM public.rag_embed_batches e
   WHERE e.batch_id = p_batch_id
     AND e.status NOT IN ('completed', 'cancelled')
   ORDER BY e.created_at, e.id;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_budget_month(p_tenant_key text DEFAULT NULL::text)
 RETURNS TABLE(tenant_key text, month date, pages_reserved integer, pages_used integer, vlm_pages_used integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT u.tenant_key, u.month, u.pages_reserved, u.pages_used, u.vlm_pages_used
    FROM public.rag_parse_budget_usage u
   WHERE u.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
     AND (p_tenant_key IS NULL OR u.tenant_key = p_tenant_key)
   ORDER BY u.tenant_key;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_assert_key_parts(p_parser text, p_options_hash text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_parser IS NULL OR p_parser !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'parse_cache_refused: invalid_parser' USING ERRCODE = '22023';
  END IF;
  IF p_options_hash IS NULL OR p_options_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'parse_cache_refused: invalid_options_hash' USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_for_document(p_tenant_key text, p_document_id uuid)
 RETURNS SETOF public.rag_parse_cache
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT c.*
    FROM public.documents d
    JOIN public.rag_parse_cache c ON c.id = d.parse_cache_id
   WHERE d.id = p_document_id
     AND d.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_lookup(p_job_id uuid, p_parser text, p_parser_version text, p_options_hash text)
 RETURNS SETOF public.rag_parse_cache
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job record;
BEGIN
  PERFORM public.rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT c.*
    FROM public.rag_parse_cache c
   WHERE c.tenant_key = v_job.tenant_key
     AND c.file_sha256 = v_job.file_sha256
     AND c.parser = p_parser
     AND c.parser_version = p_parser_version
     AND c.options_hash = p_options_hash;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_prefix(p_job_id uuid, p_parser text, p_parser_version text, p_options_hash text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job record;
  v_segment text;
BEGIN
  PERFORM public.rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
  RETURN NULL;
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RAISE EXCEPTION 'parse_cache_refused: missing_file_sha256' USING ERRCODE = '22023';
  END IF;
  v_segment := public.rag_parse_cache_version_segment(p_parser_version);
  RETURN v_job.tenant_key
    || '/_parse-cache/'
    || v_job.file_sha256
    || '/'
    || p_parser
    || '-'
    || v_segment
    || '-'
    || p_options_hash
    || '/';
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_put(p_job_id uuid, p_parser text, p_parser_version text, p_options_hash text, p_object_prefix text, p_result jsonb DEFAULT '{}'::jsonb, p_byte_size bigint DEFAULT NULL::bigint)
 RETURNS public.rag_parse_cache
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job record;
  v_expected text;
  v_row public.rag_parse_cache%ROWTYPE;
BEGIN
  PERFORM public.rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RAISE EXCEPTION 'parse_cache_refused: missing_file_sha256' USING ERRCODE = '22023';
  END IF;
  v_expected := public.rag_parse_cache_prefix(p_job_id, p_parser, p_parser_version, p_options_hash);
  IF p_object_prefix IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'parse_cache_refused: prefix_mismatch' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.rag_parse_cache (
    tenant_key, file_sha256, parser, parser_version, options_hash, object_prefix, result, byte_size
  )
  VALUES (
    v_job.tenant_key, v_job.file_sha256, p_parser, p_parser_version, p_options_hash, p_object_prefix,
    COALESCE(p_result, '{}'::jsonb), p_byte_size
  )
  ON CONFLICT (tenant_key, file_sha256, parser, parser_version, options_hash) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN v_row;
  END IF;
  SELECT c.* INTO v_row
    FROM public.rag_parse_cache c
   WHERE c.tenant_key = v_job.tenant_key
     AND c.file_sha256 = v_job.file_sha256
     AND c.parser = p_parser
     AND c.parser_version = p_parser_version
     AND c.options_hash = p_options_hash;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_version_segment(p_parser_version text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT left(encode(sha256(convert_to(p_parser_version, 'UTF8')), 'hex'), 16);
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_doc_type_ok(p_doc_type text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT p_doc_type = ANY (ARRAY[
    'general',
    'financial_report',
    'contract_legal',
    'invoice_receipt',
    'product_technical',
    'scanned_image'
  ]::text[]);
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_tier_rank(p_tier text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_tier
    WHEN 'native' THEN 0
    WHEN 'fast' THEN 1
    WHEN 'structured' THEN 2
    WHEN 'premium' THEN 3
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_publish_document_version(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(outcome text, document_id uuid, version integer, superseded_document_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc public.documents%ROWTYPE;
  previous public.documents%ROWTYPE;
  has_slug boolean;
  moved_type text;
  moved_slug text;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status = 'quarantined' THEN
    RETURN QUERY SELECT 'quarantined'::text, doc.id, doc.version, NULL::uuid;
    RETURN;
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_publishable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF doc.is_current AND doc.status = 'ready' THEN
    RETURN QUERY SELECT 'already_current'::text, doc.id, doc.version, NULL::uuid;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(doc.tenant_key || '|' || doc.source || '|' || doc.source_key, 0));

  has_slug := (
    SELECT count(*) = 2 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname IN ('content_type', 'slug') AND NOT attisdropped
  );

  SELECT * INTO previous FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = doc.source AND d.source_key = doc.source_key AND d.is_current AND d.id <> doc.id
  FOR UPDATE;
  IF FOUND THEN
    IF has_slug THEN
      EXECUTE 'SELECT content_type, slug FROM public.documents WHERE id = $1' INTO moved_type, moved_slug USING previous.id;
    END IF;
    UPDATE public.documents d SET is_current = false, superseded_by = doc.id WHERE d.id = previous.id;
    IF has_slug THEN
      EXECUTE 'UPDATE public.documents SET content_type = NULL, slug = NULL WHERE id = $1' USING previous.id;
    END IF;
    UPDATE public.document_chunks c SET is_current = false, embedding = NULL WHERE c.document_id = previous.id;
    DELETE FROM public.chunk_embeddings ce USING public.document_chunks c WHERE ce.chunk_id = c.id AND c.document_id = previous.id;
    DELETE FROM public.embedding_backfill_gaps g USING public.document_chunks c WHERE g.chunk_id = c.id AND c.document_id = previous.id;
  END IF;

  UPDATE public.documents d SET is_current = true, status = 'ready' WHERE d.id = doc.id;
  IF previous.id IS NOT NULL AND has_slug AND (moved_type IS NOT NULL OR moved_slug IS NOT NULL) THEN
    EXECUTE 'UPDATE public.documents SET content_type = $2, slug = $3 WHERE id = $1' USING doc.id, moved_type, moved_slug;
  END IF;
  UPDATE public.document_chunks c SET is_current = true, status = 'ready' WHERE c.document_id = doc.id;

  RETURN QUERY SELECT 'published'::text, doc.id, doc.version, previous.id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_advance(p_run_id uuid, p_document_id uuid)
 RETURNS TABLE(docs_done integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  handled integer;
BEGIN
  UPDATE public.chunking_build_runs r
  SET cursor_document_id = p_document_id, docs_done = r.docs_done + 1, updated_at = now()
  WHERE r.id = p_run_id AND r.status = 'running'
  RETURNING r.docs_done INTO handled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT handled;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_documents(p_profile_id text, p_doc_type text, p_tenant_key text, p_after uuid, p_limit integer)
 RETURNS TABLE(document_id uuid, tenant_key text, lineage_id uuid, version integer, filename text, doc_type text, source text, template_row jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT d.id, d.tenant_key, d.lineage_id, d.version, d.filename, d.doc_type, d.source,
           jsonb_build_object(
             'invoice_number', d.invoice_number,
             'supplier_name', d.supplier_name,
             'supplier_tax_id', d.supplier_tax_id,
             'issue_date', d.issue_date::text,
             'gross_total', d.gross_total::text,
             'currency', d.currency)
    FROM public.chunking_profiles p
    JOIN public.documents d ON d.doc_type = p.doc_type AND d.is_current AND d.status = 'ready'
    WHERE p.id = p_profile_id
      AND p.doc_type = p_doc_type
      AND p.id <> 'legacy'
      AND p.status IN ('building', 'ready', 'active')
      AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
      AND (p_after IS NULL OR d.id > p_after)
      AND NOT EXISTS (
        SELECT 1 FROM public.document_chunks c
        WHERE c.document_id = d.id AND c.chunking_profile_id = p.id AND c.is_current)
    ORDER BY d.id
    LIMIT p_limit;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_finish_run(p_run_id uuid, p_status text DEFAULT 'completed'::text)
 RETURNS TABLE(status text, docs_missing integer, docs_missing_total integer, gaps integer, profile_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  existing public.chunking_build_runs%ROWTYPE;
  scope_missing integer;
  total_missing integer;
  final_status text;
  gap_count integer;
  profile_state text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO existing FROM public.chunking_build_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status <> 'running' THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;

  scope_missing := public.rag_rechunk_missing(existing.profile_id, existing.doc_type, existing.tenant_key);
  total_missing := public.rag_rechunk_missing(existing.profile_id, existing.doc_type, NULL);
  IF p_status = 'failed' THEN
    final_status := 'failed';
  ELSIF scope_missing = 0 THEN
    final_status := 'completed';
  ELSE
    final_status := 'incomplete';
  END IF;
  UPDATE public.chunking_build_runs r SET status = final_status, updated_at = now() WHERE r.id = p_run_id;

  IF final_status = 'completed' AND total_missing = 0 THEN
    UPDATE public.chunking_profiles p SET status = 'ready'
    WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type AND p.status = 'building';
  END IF;
  SELECT count(*)::integer INTO gap_count FROM public.chunking_build_gaps g WHERE g.run_id = p_run_id;
  SELECT p.status INTO profile_state FROM public.chunking_profiles p WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type;
  RETURN QUERY SELECT final_status, scope_missing, total_missing, gap_count, profile_state;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_gaps(p_run_id uuid)
 RETURNS TABLE(document_id uuid, tenant_key text, reason text, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT g.document_id, d.tenant_key, g.reason, g.detail
  FROM public.chunking_build_gaps g
  JOIN public.documents d ON d.id = g.document_id
  WHERE g.run_id = p_run_id
  ORDER BY g.document_id
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_get_run(p_run_id uuid)
 RETURNS TABLE(run_id uuid, profile_id text, doc_type text, tenant_key text, cursor_document_id uuid, docs_total integer, docs_done integer, status text, profile_status text, child_tokens integer, parent_mode text, parent_tokens integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT r.id, r.profile_id, r.doc_type, r.tenant_key, r.cursor_document_id, r.docs_total, r.docs_done, r.status,
         p.status, p.child_tokens, p.parent_mode, p.parent_tokens
  FROM public.chunking_build_runs r
  JOIN public.chunking_profiles p ON p.id = r.profile_id AND p.doc_type = r.doc_type
  WHERE r.id = p_run_id
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_missing(p_profile_id text, p_doc_type text, p_tenant_key text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT count(*)::integer
  FROM public.chunking_profiles p
  JOIN public.documents d ON d.doc_type = p.doc_type AND d.is_current AND d.status = 'ready'
  WHERE p.id = p_profile_id
    AND p.doc_type = p_doc_type
    AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
    AND NOT EXISTS (
      SELECT 1 FROM public.document_chunks c
      WHERE c.document_id = d.id AND c.chunking_profile_id = p.id AND c.is_current)
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_record_gap(p_run_id uuid, p_document_id uuid, p_reason text, p_detail text DEFAULT NULL::text)
 RETURNS TABLE(recorded integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  existing public.chunking_build_runs%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM public.chunking_build_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status <> 'running' THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('no_parse_output', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_gap' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.documents d
  WHERE d.id = p_document_id AND d.doc_type = existing.doc_type AND (existing.tenant_key IS NULL OR d.tenant_key = existing.tenant_key);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: document_out_of_scope' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.chunking_build_gaps (run_id, document_id, reason, detail)
  VALUES (p_run_id, p_document_id, p_reason, left(p_detail, 200))
  ON CONFLICT (run_id, document_id) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail, recorded_at = now();
  RETURN QUERY SELECT 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_resume_run(p_run_id uuid)
 RETURNS TABLE(run_id uuid, profile_id text, doc_type text, tenant_key text, cursor_document_id uuid, docs_total integer, docs_done integer, status text, profile_status text, child_tokens integer, parent_mode text, parent_tokens integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  existing public.chunking_build_runs%ROWTYPE;
  profile_state text;
BEGIN
  SELECT * INTO existing FROM public.chunking_build_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status NOT IN ('running', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_resumable' USING ERRCODE = '55000';
  END IF;
  SELECT p.status INTO profile_state FROM public.chunking_profiles p WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type;
  IF profile_state = 'retired' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_retired' USING ERRCODE = '55000';
  END IF;
  UPDATE public.chunking_build_runs r SET status = 'running', updated_at = now() WHERE r.id = p_run_id;
  RETURN QUERY SELECT * FROM public.rag_rechunk_get_run(p_run_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_start_run(p_profile_id text, p_doc_type text DEFAULT NULL::text, p_tenant_key text DEFAULT NULL::text, p_resume_open boolean DEFAULT false)
 RETURNS TABLE(run_id uuid, profile_id text, doc_type text, tenant_key text, cursor_document_id uuid, docs_total integer, docs_done integer, status text, profile_status text, child_tokens integer, parent_mode text, parent_tokens integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  matches integer;
  chosen public.chunking_profiles%ROWTYPE;
  opened uuid;
BEGIN
  IF p_profile_id IS NULL OR btrim(p_profile_id) = '' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_required' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_is_legacy' USING ERRCODE = '55000';
  END IF;
  IF p_tenant_key IS NOT NULL
     AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO matches FROM public.chunking_profiles p WHERE p.id = p_profile_id AND (p_doc_type IS NULL OR p.doc_type = p_doc_type);
  IF matches = 0 THEN
    RAISE EXCEPTION 'rechunk_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF matches > 1 THEN
    RAISE EXCEPTION 'rechunk_refused: profile_ambiguous' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO chosen FROM public.chunking_profiles p WHERE p.id = p_profile_id AND (p_doc_type IS NULL OR p.doc_type = p_doc_type);
  IF chosen.status = 'retired' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_retired' USING ERRCODE = '55000';
  END IF;

  IF p_resume_open THEN
    SELECT r.id INTO opened
    FROM public.chunking_build_runs r
    WHERE r.profile_id = chosen.id AND r.doc_type = chosen.doc_type AND r.tenant_key IS NOT DISTINCT FROM p_tenant_key AND r.status = 'running'
    ORDER BY r.started_at DESC
    LIMIT 1;
  END IF;
  IF opened IS NULL THEN
    INSERT INTO public.chunking_build_runs (profile_id, doc_type, tenant_key, docs_total)
    VALUES (chosen.id, chosen.doc_type, p_tenant_key, public.rag_rechunk_missing(chosen.id, chosen.doc_type, p_tenant_key))
    RETURNING id INTO opened;
  END IF;
  RETURN QUERY SELECT * FROM public.rag_rechunk_get_run(opened);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_record_backfill_gap(p_run_id uuid, p_chunk_ids uuid[], p_profile_id text, p_reason text, p_tenant_key text)
 RETURNS TABLE(gaps_recorded integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  run public.embedding_backfill_runs%ROWTYPE;
  wanted integer;
  matched integer;
  recorded integer;
BEGIN
  IF p_run_id IS NULL OR p_profile_id IS NULL OR p_tenant_key IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: p_run_id, p_profile_id and p_tenant_key are required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid_gap: a reason is required';
  END IF;
  IF p_chunk_ids IS NULL OR cardinality(p_chunk_ids) = 0 THEN
    RAISE EXCEPTION 'invalid_gap: chunk ids are required';
  END IF;

  SELECT * INTO run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found';
  END IF;
  IF run.profile_id <> p_profile_id THEN
    RAISE EXCEPTION 'run_profile_mismatch' USING DETAIL = 'the run belongs to another profile';
  END IF;
  IF run.tenant_key IS NOT NULL AND run.tenant_key <> p_tenant_key THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'the run is limited to another tenant';
  END IF;

  SELECT count(DISTINCT u.id) INTO wanted FROM unnest(p_chunk_ids) AS u(id);
  SELECT count(*) INTO matched FROM public.document_chunks c
  WHERE c.id IN (SELECT u.id FROM unnest(p_chunk_ids) AS u(id)) AND c.tenant_key = p_tenant_key;
  IF matched <> wanted THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'chunk not found in tenant';
  END IF;

  INSERT INTO public.embedding_backfill_gaps AS g (run_id, chunk_id, profile_id, reason)
  SELECT DISTINCT p_run_id, u.id, p_profile_id, left(btrim(p_reason), 200) FROM unnest(p_chunk_ids) AS u(id)
  ON CONFLICT (run_id, chunk_id, profile_id) DO UPDATE SET reason = EXCLUDED.reason, recorded_at = now();
  GET DIAGNOSTICS recorded = ROW_COUNT;

  RETURN QUERY SELECT recorded;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_record_embed_batch(p_batch_id uuid, p_profile_id text, p_provider text, p_provider_batch_id text DEFAULT NULL::text, p_input_file_id text DEFAULT NULL::text, p_input_count integer DEFAULT 0, p_status text DEFAULT 'pending'::text)
 RETURNS public.rag_embed_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.rag_embed_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ingestion_batches b WHERE b.id = p_batch_id) THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.embedding_profiles ep WHERE ep.id = p_profile_id) THEN
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

  INSERT INTO public.rag_embed_batches (
    batch_id, profile_id, provider, provider_batch_id, input_file_id, input_count, status
  ) VALUES (
    p_batch_id, p_profile_id, p_provider, p_provider_batch_id, p_input_file_id, COALESCE(p_input_count, 0), p_status
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_record_eval_evidence(p_profile_id text, p_evidence jsonb, p_actor text)
 RETURNS TABLE(profile_id text, recorded_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_profile public.embedding_profiles%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'evidence_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile FROM public.embedding_profiles WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'evidence_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'evidence_refused: invalid_evidence' USING ERRCODE = '22023';
  END IF;
  IF p_evidence->>'target_profile' IS DISTINCT FROM p_profile_id THEN
    RAISE EXCEPTION 'evidence_refused: target_mismatch' USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profiles SET eval_evidence = p_evidence WHERE id = p_profile_id;

  RETURN QUERY SELECT p_profile_id, now();
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_record_parse_attempt(p_job_id uuid, p_worker text, p_attempt jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_cost := COALESCE((p_attempt ->> 'est_cost')::numeric, 0);

  UPDATE public.ingestion_jobs j
     SET attempts = v_attempts,
         escalations = j.escalations + CASE WHEN v_reason = 'escalation' THEN 1 ELSE 0 END,
         est_cost_usd = COALESCE(j.est_cost_usd, 0) + v_cost,
         updated_at = now()
   WHERE j.id = p_job_id;

  RETURN v_no;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_count(p_profile_id text, p_tenant_key text)
 RETURNS TABLE(tenant_key text, chunks bigint, chunks_missing bigint, content_chars bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.embedding_profiles p WHERE p.id = p_profile_id) THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT c.tenant_key,
           count(*)::bigint,
           (count(*) FILTER (WHERE e.chunk_id IS NULL))::bigint,
           COALESCE(sum(length(c.content)) FILTER (WHERE e.chunk_id IS NULL), 0)::bigint
    FROM public.embedding_profiles p
    JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
    LEFT JOIN public.chunk_embeddings e
      ON e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims
    WHERE p.id = p_profile_id AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    GROUP BY c.tenant_key
    ORDER BY c.tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_derive_batch(p_run_id uuid, p_limit integer)
 RETURNS TABLE(chunks_derived integer, chunks_done bigint, cursor_chunk_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_target public.embedding_profiles%ROWTYPE;
  v_source public.embedding_profiles%ROWTYPE;
  v_ids uuid[];
  v_last uuid;
  derived integer;
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF v_run.derived_from IS NULL THEN
    RAISE EXCEPTION 'reembed_refused: not_a_derive_run' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_target FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  SELECT * INTO v_source FROM public.embedding_profiles p WHERE p.id = v_run.derived_from;

  WITH picked AS (
    SELECT c.id, c.tenant_key, s.embedding AS source_vector
    FROM public.document_chunks c
    JOIN public.chunk_embeddings s
      ON s.chunk_id = c.id AND s.profile_id = v_source.id AND s.embedding_model = v_source.model AND s.dims = v_source.dims
    WHERE c.is_current AND c.status = 'ready'
      AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
      AND NOT EXISTS (
        SELECT 1 FROM public.chunk_embeddings t
        WHERE t.chunk_id = c.id AND t.profile_id = v_target.id AND t.embedding_model = v_target.model AND t.dims = v_target.dims)
    ORDER BY c.id
    LIMIT p_limit
  ), written AS (
    INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
    SELECT p.id, v_target.id, p.tenant_key, public.l2_normalize(public.subvector(p.source_vector, 1, v_target.dims)), v_target.model, v_target.dims, 'derived'
    FROM picked p
    ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      dims = EXCLUDED.dims,
      embedding_host = EXCLUDED.embedding_host,
      embedded_at = now()
    RETURNING ce.chunk_id
  )
  SELECT count(*)::integer, array_agg(w.chunk_id) INTO derived, v_ids FROM written w;

  IF derived > 0 THEN
    DELETE FROM public.embedding_backfill_gaps g WHERE g.profile_id = v_target.id AND g.chunk_id = ANY (v_ids);
    SELECT u.id INTO v_last FROM unnest(v_ids) AS u(id) ORDER BY u.id DESC LIMIT 1;
  END IF;

  UPDATE public.embedding_backfill_runs AS r SET
    chunks_done = r.chunks_done + derived,
    cursor_chunk_id = CASE
      WHEN v_last IS NOT NULL AND (r.cursor_chunk_id IS NULL OR v_last > r.cursor_chunk_id) THEN v_last
      ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;

  RETURN QUERY SELECT derived, v_done, v_cursor;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_finish_run(p_run_id uuid, p_status text)
 RETURNS TABLE(run_id uuid, status text, chunks_missing bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_missing bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'reembed_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  SELECT m.chunks_missing INTO v_missing FROM public.rag_reembed_remaining(p_run_id) AS m;
  IF p_status = 'completed' AND v_missing > 0 THEN
    RAISE EXCEPTION 'reembed_refused: incomplete (% current ready chunks have no vector)', v_missing USING ERRCODE = '55000';
  END IF;
  UPDATE public.embedding_backfill_runs AS r SET status = p_status, updated_at = now() WHERE r.id = p_run_id;
  RETURN QUERY SELECT p_run_id, p_status, v_missing;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_get_run(p_run_id uuid)
 RETURNS TABLE(run_id uuid, profile_id text, tenant_key text, cursor_chunk_id uuid, chunks_total bigint, chunks_done bigint, tokens bigint, status text, derived_from text, provider text, model text, dims integer, storage text, profile_status text, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT r.id, r.profile_id, r.tenant_key, r.cursor_chunk_id, r.chunks_total, r.chunks_done, r.tokens, r.status, r.derived_from,
         p.provider, p.model, p.dims, p.storage, p.status, r.updated_at
  FROM public.embedding_backfill_runs r
  JOIN public.embedding_profiles p ON p.id = r.profile_id
  WHERE r.id = p_run_id
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_legacy_guard()
 RETURNS TABLE(versioned_documents bigint, profiles_in_use text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    (SELECT count(*) FROM public.documents d WHERE d.version > 1),
    COALESCE(
      (SELECT array_agg(p.id ORDER BY p.id) FROM public.embedding_profiles p
       WHERE p.id <> 'openai-3-small-1536'
         AND (p.status IN ('backfilling', 'active') OR EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.profile_id = p.id))),
      '{}'::text[])
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_missing_batch(p_run_id uuid, p_after uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 128)
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, content text, section_path text[], chunk_kind text, doc_type text, template_row jsonb, has_gap boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT * FROM public.rag_reembed_pick(v_run.profile_id, v_run.tenant_key, p_after, p_limit);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_next_batch(p_run_id uuid, p_after uuid, p_limit integer)
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, content text, section_path text[], chunk_kind text, doc_type text, template_row jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id, x.document_id, x.tenant_key, x.content, x.section_path, x.chunk_kind, x.doc_type, x.template_row
    FROM public.rag_reembed_pick(v_run.profile_id, v_run.tenant_key, p_after, p_limit) x;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_pick(p_profile_id text, p_tenant_key text, p_after uuid, p_limit integer)
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, content text, section_path text[], chunk_kind text, doc_type text, template_row jsonb, has_gap boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT c.id, c.document_id, c.tenant_key, c.content, c.section_path, c.chunk_kind,
         COALESCE(c.doc_type, d.doc_type),
         jsonb_build_object(
           'invoice_number', d.invoice_number,
           'supplier_name', d.supplier_name,
           'supplier_tax_id', d.supplier_tax_id,
           'issue_date', d.issue_date::text,
           'gross_total', d.gross_total::text,
           'currency', d.currency),
         EXISTS (SELECT 1 FROM public.embedding_backfill_gaps g WHERE g.chunk_id = c.id AND g.profile_id = p.id)
  FROM public.embedding_profiles p
  JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
  JOIN public.documents d ON d.id = c.document_id
  WHERE p.id = p_profile_id
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    AND (p_after IS NULL OR c.id > p_after)
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims)
  ORDER BY c.id
  LIMIT p_limit
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_preview_batch(p_profile_id text, p_tenant_key text, p_after uuid, p_limit integer)
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, content text, section_path text[], chunk_kind text, doc_type text, template_row jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_storage text;
BEGIN
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  SELECT p.storage INTO v_storage FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_storage = 'legacy_column' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id, x.document_id, x.tenant_key, x.content, x.section_path, x.chunk_kind, x.doc_type, x.template_row
    FROM public.rag_reembed_pick(p_profile_id, p_tenant_key, p_after, p_limit) x;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_remaining(p_run_id uuid)
 RETURNS TABLE(chunks_missing bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_count bigint;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.embedding_profiles p
  JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
  WHERE p.id = v_run.profile_id
    AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims);
  RETURN QUERY SELECT v_count;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_resume_run(p_run_id uuid, p_actor text)
 RETURNS TABLE(run_id uuid, profile_id text, tenant_key text, cursor_chunk_id uuid, chunks_total bigint, chunks_done bigint, tokens bigint, status text, derived_from text, provider text, model text, dims integer, storage text, profile_status text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_status text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'completed' THEN
    RAISE EXCEPTION 'reembed_refused: run_completed' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'reembed_refused: run_rolled_back' USING ERRCODE = '55000';
  END IF;
  SELECT p.status INTO v_status FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_status = 'active' THEN
    RAISE EXCEPTION 'reembed_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'reembed_refused: profile_retired' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs o
    WHERE o.id <> v_run.id AND o.profile_id = v_run.profile_id AND o.status = 'running'
      AND (o.tenant_key IS NULL OR v_run.tenant_key IS NULL OR o.tenant_key = v_run.tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = v_run.profile_id AND status = 'available';
  UPDATE public.embedding_backfill_runs SET status = 'running', updated_at = now() WHERE id = v_run.id;
  RETURN QUERY SELECT * FROM public.rag_reembed_get_run(p_run_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_rollback_run(p_run_id uuid, p_actor text)
 RETURNS TABLE(rows_deleted bigint, profile_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_deleted bigint;
  v_status text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'rollback_refused: already_rolled_back' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'running' AND v_run.updated_at > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'rollback_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.activated_at IS NOT NULL
     AND (SELECT max(p.activated_at) FROM public.embedding_profiles p) > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: recently_active' USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.chunk_embeddings e
  WHERE e.profile_id = v_run.profile_id
    AND e.embedded_at >= v_run.started_at
    AND e.embedded_at <= v_run.updated_at
    AND (v_run.tenant_key IS NULL OR e.tenant_key = v_run.tenant_key);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  DELETE FROM public.embedding_backfill_gaps g WHERE g.run_id = v_run.id;
  UPDATE public.embedding_backfill_runs AS r SET status = 'rolled_back', updated_at = now() WHERE r.id = v_run.id;

  IF v_profile.status = 'backfilling' AND NOT EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs o WHERE o.profile_id = v_run.profile_id AND o.status = 'running' AND o.id <> v_run.id
  ) THEN
    UPDATE public.embedding_profiles SET status = 'available' WHERE id = v_run.profile_id;
  END IF;
  SELECT p.status INTO v_status FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;

  RETURN QUERY SELECT v_deleted, v_status;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_start_run(p_profile_id text, p_tenant_key text, p_actor text, p_derived_from text DEFAULT NULL::text)
 RETURNS TABLE(run_id uuid, profile_id text, tenant_key text, chunks_total bigint, derived_from text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_profile public.embedding_profiles%ROWTYPE;
  v_source public.embedding_profiles%ROWTYPE;
  v_total bigint;
  v_run uuid;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'reembed_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.storage = 'legacy_column' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;
  IF v_profile.status = 'retired' THEN
    RAISE EXCEPTION 'reembed_refused: profile_retired' USING ERRCODE = '55000';
  END IF;

  IF p_derived_from IS NOT NULL THEN
    SELECT * INTO v_source FROM public.embedding_profiles p WHERE p.id = p_derived_from;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reembed_refused: unknown_derive_source' USING ERRCODE = '22023';
    END IF;
    IF v_source.id = v_profile.id OR v_source.storage <> 'halfvec' THEN
      RAISE EXCEPTION 'reembed_refused: derive_source_invalid' USING ERRCODE = '22023';
    END IF;
    IF v_source.provider <> v_profile.provider OR v_source.model <> v_profile.model THEN
      RAISE EXCEPTION 'reembed_refused: derive_model_mismatch' USING ERRCODE = '22023';
    END IF;
    IF v_source.dims <= v_profile.dims THEN
      RAISE EXCEPTION 'reembed_refused: derive_dims_not_smaller' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs r
    WHERE r.profile_id = p_profile_id AND r.status = 'running'
      AND (r.tenant_key IS NULL OR p_tenant_key IS NULL OR r.tenant_key = p_tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_total FROM public.document_chunks c
  WHERE c.is_current AND c.status = 'ready' AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key);

  UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = p_profile_id AND status = 'available';

  INSERT INTO public.embedding_backfill_runs AS r (profile_id, tenant_key, chunks_total, derived_from)
  VALUES (p_profile_id, p_tenant_key, v_total, p_derived_from)
  RETURNING r.id INTO v_run;

  RETURN QUERY SELECT v_run, p_profile_id, p_tenant_key, v_total, p_derived_from;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_write_batch(p_run_id uuid, p_rows jsonb, p_cursor uuid, p_tokens bigint DEFAULT 0)
 RETURNS TABLE(chunks_written integer, chunks_done bigint, cursor_chunk_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_ids uuid[];
  wanted integer;
  in_scope integer;
  current_count integer;
  written integer;
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_profile.storage <> 'halfvec' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'invalid_rows: p_rows must be a non-empty JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value)
    WHERE jsonb_typeof(r.value) <> 'object'
       OR jsonb_typeof(r.value -> 'chunk_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(r.value -> 'vector') IS DISTINCT FROM 'array'
       OR (r.value ? 'host' AND jsonb_typeof(r.value -> 'host') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_rows: every row needs a chunk_id string, a vector array and an optional host string' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg((r.value ->> 'chunk_id')::uuid) INTO v_ids FROM jsonb_array_elements(p_rows) AS r(value);
  wanted := cardinality(v_ids);
  IF (SELECT count(DISTINCT u.id) FROM unnest(v_ids) AS u(id)) <> wanted THEN
    RAISE EXCEPTION 'invalid_rows: a chunk may appear once per batch' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value) WHERE jsonb_array_length(r.value -> 'vector') <> v_profile.dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  SELECT count(*) INTO in_scope FROM public.document_chunks c
  WHERE c.id = ANY (v_ids) AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key);
  IF in_scope <> wanted THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'chunk not found in the run scope';
  END IF;
  SELECT count(*) INTO current_count FROM public.document_chunks c WHERE c.id = ANY (v_ids) AND c.is_current AND c.status = 'ready';
  IF current_count <> wanted THEN
    RAISE EXCEPTION 'reembed_refused: chunk_not_current' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
  SELECT (r.value ->> 'chunk_id')::uuid, v_profile.id, c.tenant_key, ((r.value -> 'vector')::text)::public.halfvec, v_profile.model, v_profile.dims,
         left(r.value ->> 'host', 120)
  FROM jsonb_array_elements(p_rows) AS r(value)
  JOIN public.document_chunks c ON c.id = (r.value ->> 'chunk_id')::uuid
  ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
    embedding = EXCLUDED.embedding,
    embedding_model = EXCLUDED.embedding_model,
    dims = EXCLUDED.dims,
    embedding_host = EXCLUDED.embedding_host,
    embedded_at = now();
  GET DIAGNOSTICS written = ROW_COUNT;

  DELETE FROM public.embedding_backfill_gaps g WHERE g.profile_id = v_profile.id AND g.chunk_id = ANY (v_ids);

  UPDATE public.embedding_backfill_runs AS r SET
    chunks_done = r.chunks_done + written,
    tokens = r.tokens + GREATEST(COALESCE(p_tokens, 0), 0),
    cursor_chunk_id = CASE WHEN p_cursor IS NOT NULL AND (r.cursor_chunk_id IS NULL OR p_cursor > r.cursor_chunk_id) THEN p_cursor ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;

  RETURN QUERY SELECT written, v_done, v_cursor;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_release_ingestion_job(p_job_id uuid, p_worker text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE public.ingestion_jobs j
     SET status = 'queued',
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
     AND j.locked_by = p_worker
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now()
   RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_release_job_reservations(p_job_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  released integer := 0;
  rec record;
BEGIN
  FOR rec IN
    SELECT r.id, r.tenant_key, r.month, r.pages, r.kind
    FROM public.rag_parse_budget_reservations r
    WHERE r.job_id = p_job_id AND r.state = 'open'
    FOR UPDATE
  LOOP
    UPDATE public.rag_parse_budget_reservations SET state = 'released' WHERE id = rec.id;
  -- Per kind, decrement pages_reserved on the usage row (parse and vlm share the same counter).
    UPDATE public.rag_parse_budget_usage u
       SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages)
     WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;
    released := released + 1;
  END LOOP;
  RETURN released;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_release_parse_budget(p_job_id uuid, p_attempt_no integer, p_kind text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  rec public.rag_parse_budget_reservations%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('parse', 'vlm') THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO rec
    FROM public.rag_parse_budget_reservations r
   WHERE r.job_id = p_job_id AND r.attempt_no = p_attempt_no AND r.kind = p_kind
   FOR UPDATE;

  IF NOT FOUND OR rec.state = 'released' THEN
    RETURN false;
  END IF;
  IF rec.state = 'settled' THEN
    RETURN true;
  END IF;

  UPDATE public.rag_parse_budget_reservations SET state = 'released' WHERE id = rec.id;

  UPDATE public.rag_parse_budget_usage u
     SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages)
   WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_release_quarantine(p_document_id uuid, p_actor uuid)
 RETURNS TABLE(outcome text, document_id uuid, version integer, superseded_document_id uuid, rule_ids text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  doc public.documents%ROWTYPE;
  ids text[];
  invoice_quarantined boolean;
  published record;
BEGIN
  keys := public.rag_admin_tenant_keys(p_actor);
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status <> 'quarantined' THEN
    RAISE EXCEPTION 'not_quarantined';
  END IF;

  ids := CASE WHEN jsonb_typeof(doc.metadata #> '{quarantine,rule_ids}') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(doc.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END;
  invoice_quarantined := (doc.metadata #>> '{invoice_extraction,status}') = 'quarantined';

  UPDATE public.documents d SET
    status = 'processing',
    metadata = COALESCE(d.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'quarantine',
        CASE WHEN jsonb_typeof(d.metadata -> 'quarantine') = 'object' THEN d.metadata -> 'quarantine' ELSE '{}'::jsonb END
          || jsonb_build_object(
            'released_by', p_actor::text,
            'released_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'released_rule_ids', to_jsonb(ids)))
      || CASE WHEN invoice_quarantined
              THEN jsonb_build_object('invoice_extraction', jsonb_build_object('status', 'released_unextracted'))
              ELSE '{}'::jsonb END,
    processing_state = CASE WHEN jsonb_typeof(d.processing_state -> 'quarantine') = 'object'
                            THEN jsonb_set(d.processing_state, '{quarantine,released}', 'true'::jsonb)
                            ELSE d.processing_state END
  WHERE d.id = doc.id;

  SELECT p.outcome, p.superseded_document_id INTO published FROM public.rag_publish_document_version(doc.id, doc.tenant_key) AS p;
  IF published.outcome IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'release_failed: %', COALESCE(published.outcome, 'unknown');
  END IF;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('release_quarantine', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, ids);

  RETURN QUERY SELECT published.outcome, doc.id, doc.version, published.superseded_document_id, ids;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_relex_batch(p_rows jsonb, p_version integer)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_row jsonb;
  v_count integer := 0;
BEGIN
  IF p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'relex_refused: invalid_version' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) AS e(value) LOOP
    IF jsonb_typeof(v_row) <> 'object' OR NOT (v_row ? 'id') OR jsonb_typeof(v_row -> 'id') IS DISTINCT FROM 'string' THEN
      CONTINUE;
    END IF;
    UPDATE public.document_chunks c
    SET lexical_text = v_row ->> 'lexical_text',
        lexical_version = p_version,
        metadata = jsonb_set(coalesce(c.metadata, '{}'::jsonb), '{lexical_version}', to_jsonb(p_version), true),
        language = CASE
          WHEN c.language IS NULL AND v_row ? 'language' THEN NULLIF(v_row ->> 'language', '')
          ELSE c.language
        END
    WHERE c.id = (v_row ->> 'id')::uuid
      AND c.is_current
      AND c.status = 'ready';
    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_relex_candidates(p_after uuid, p_version integer, p_limit integer, p_tenant_key text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, tenant_key text, content text, section_path text[], chunk_kind text, metadata jsonb, language text, document_filename text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'relex_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT c.id,
         c.tenant_key,
         c.content,
         c.section_path,
         c.chunk_kind,
         c.metadata,
         c.language,
         d.filename AS document_filename
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.is_current
    AND c.status = 'ready'
    AND c.lexical_version IS DISTINCT FROM p_version
    AND (p_after IS NULL OR c.id > p_after)
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
  ORDER BY c.id
  LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_reserve_batch_budget(p_job_id uuid, p_usd numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_batch uuid;
  v_updated uuid;
BEGIN
  IF p_usd IS NULL OR p_usd < 0 THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_usd' USING ERRCODE = '22023';
  END IF;

  SELECT j.batch_id INTO v_batch FROM public.ingestion_jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_budget_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_batch IS NULL THEN
    RETURN true;
  END IF;

  UPDATE public.ingestion_batches b
     SET spent_usd = b.spent_usd + p_usd,
         updated_at = now()
   WHERE b.id = v_batch
     AND b.budget_usd IS NOT NULL
     AND b.spent_usd + p_usd <= b.budget_usd
  RETURNING b.id INTO v_updated;

  RETURN v_updated IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_reserve_parse_budget(p_job_id uuid, p_attempt_no integer, p_pages integer, p_kind text, p_limit integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tenant text;
  v_month date;
  v_reserved integer;
  v_row public.rag_parse_budget_usage%ROWTYPE;
BEGIN
  IF p_pages IS NULL OR p_pages <= 0 THEN
    RETURN false;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('parse', 'vlm') THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 0 OR p_pages > p_limit THEN
    RETURN false;
  END IF;

  SELECT j.tenant_key INTO v_tenant FROM public.ingestion_jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_budget_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_tenant_key(v_tenant);

  v_month := date_trunc('month', now() AT TIME ZONE 'UTC')::date;

  IF EXISTS (
    SELECT 1 FROM public.rag_parse_budget_reservations r
    WHERE r.job_id = p_job_id AND r.attempt_no = p_attempt_no AND r.kind = p_kind AND r.state = 'open'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.rag_parse_budget_usage AS u (tenant_key, month, pages_reserved)
  VALUES (v_tenant, v_month, p_pages)
  ON CONFLICT (tenant_key, month) DO UPDATE
     SET pages_reserved = u.pages_reserved + EXCLUDED.pages_reserved
   WHERE u.pages_reserved + u.pages_used + u.vlm_pages_used + EXCLUDED.pages_reserved <= p_limit
  RETURNING u.* INTO v_row;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.rag_parse_budget_reservations (job_id, attempt_no, tenant_key, month, pages, kind, state)
  VALUES (p_job_id, p_attempt_no, v_tenant, v_month, p_pages, p_kind, 'open');

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_rollback_embedding_profile(p_actor text)
 RETURNS TABLE(restored_profile text, rolled_back_profile text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_active public.embedding_profiles%ROWTYPE;
  v_previous public.embedding_profiles%ROWTYPE;
  v_missing bigint;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_active FROM public.embedding_profiles WHERE status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: no_active' USING ERRCODE = '55000';
  END IF;
  IF v_active.previous_active_id IS NULL THEN
    RAISE EXCEPTION 'rollback_refused: no_previous' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_previous FROM public.embedding_profiles WHERE id = v_active.previous_active_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: no_previous' USING ERRCODE = '55000';
  END IF;

  IF v_previous.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = v_previous.id);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'rollback_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, v_previous.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profiles SET status = 'available' WHERE id = v_active.id;
  UPDATE public.embedding_profiles
  SET status = 'active', previous_active_id = NULL, activated_at = now(), activated_by = p_actor
  WHERE id = v_previous.id;

  RETURN QUERY SELECT v_previous.id, v_active.id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_save_ingest_state(p_document_id uuid, p_tenant_key text, p_processing_status text, p_state jsonb)
 RETURNS TABLE(document_id uuid, processing_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM 1 FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_state IS NOT NULL AND jsonb_typeof(p_state) <> 'object' THEN
    RAISE EXCEPTION 'invalid_state: p_state must be a JSON object';
  END IF;
  UPDATE public.documents d
  SET processing_status = p_processing_status, processing_state = COALESCE(p_state, '{}'::jsonb)
  WHERE d.id = p_document_id;
  RETURN QUERY SELECT d.id, d.processing_status FROM public.documents d WHERE d.id = p_document_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_doc_type_default(p_tenant_key text, p_source_kind text, p_source_ref text, p_doc_type text, p_updated_by text)
 RETURNS TABLE(tenant_key text, source_kind text, source_ref text, doc_type text, updated_by text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  ref text := p_source_ref;
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload') THEN
    RAISE EXCEPTION 'invalid_source_kind';
  END IF;
  IF p_doc_type IS NULL OR p_doc_type NOT IN ('auto', 'general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image') THEN
    RAISE EXCEPTION 'invalid_doc_type';
  END IF;
  IF p_updated_by IS NULL OR btrim(p_updated_by) = '' THEN
    RAISE EXCEPTION 'actor_required';
  END IF;
  IF ref IS NOT NULL THEN
    ref := btrim(ref);
    IF p_source_kind <> 'nango' OR ref = '' OR length(ref) > 200 THEN
      RAISE EXCEPTION 'invalid_argument: source_ref is only for nango connection or folder ids';
    END IF;
  END IF;

  RETURN QUERY
  INSERT INTO public.rag_doc_type_defaults AS d (tenant_key, source_kind, source_ref, doc_type, updated_by, updated_at)
  VALUES (p_tenant_key, p_source_kind, ref, p_doc_type, btrim(p_updated_by), now())
  ON CONFLICT (tenant_key, source_kind, (COALESCE(source_ref, '')))
  DO UPDATE SET doc_type = EXCLUDED.doc_type, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
  RETURNING d.tenant_key, d.source_kind, d.source_ref, d.doc_type, d.updated_by, d.updated_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_document_fields(p_document_id uuid, p_tenant_key text, p_fields jsonb)
 RETURNS TABLE(document_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  field_name text;
  allowed text[] := ARRAY[
    'content_hash', 'language', 'doc_date', 'doc_type', 'doc_type_origin', 'parser_used', 'parser_version',
    'processing_profile_id', 'processing_profile_version', 'original_path', 'source_provider', 'source_file_id',
    'source_connection_id', 'status', 'metadata',
    'invoice_number', 'supplier_name', 'supplier_tax_id', 'issue_date', 'gross_total', 'currency',
    'content'
  ];
  doc public.documents%ROWTYPE;
  issue date;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'invalid_fields: p_fields must be a JSON object';
  END IF;
  FOR field_name IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (field_name = ANY (allowed)) THEN
      RAISE EXCEPTION 'invalid_field: %', field_name;
    END IF;
  END LOOP;
  IF p_fields ? 'status' AND (jsonb_typeof(p_fields -> 'status') <> 'string'
      OR (p_fields ->> 'status') NOT IN ('processing', 'quarantined', 'failed', 'deleted')) THEN
    RAISE EXCEPTION 'invalid_status: %', p_fields ->> 'status';
  END IF;
  IF p_fields ? 'metadata' AND jsonb_typeof(p_fields -> 'metadata') <> 'object' THEN
    RAISE EXCEPTION 'invalid_metadata: metadata must be a JSON object';
  END IF;

  IF p_fields ? 'content' AND jsonb_typeof(p_fields -> 'content') <> 'string' THEN
    RAISE EXCEPTION 'invalid_field: content';
  END IF;
  IF p_fields ? 'invoice_number' AND jsonb_typeof(p_fields -> 'invoice_number') <> 'null'
      AND (jsonb_typeof(p_fields -> 'invoice_number') <> 'string' OR length(p_fields ->> 'invoice_number') > 64) THEN
    RAISE EXCEPTION 'invalid_field: invoice_number';
  END IF;
  IF p_fields ? 'supplier_name' AND jsonb_typeof(p_fields -> 'supplier_name') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_name') <> 'string' OR length(p_fields ->> 'supplier_name') > 300) THEN
    RAISE EXCEPTION 'invalid_field: supplier_name';
  END IF;
  IF p_fields ? 'supplier_tax_id' AND jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'string' OR length(p_fields ->> 'supplier_tax_id') > 64) THEN
    RAISE EXCEPTION 'invalid_field: supplier_tax_id';
  END IF;
  IF p_fields ? 'currency' AND jsonb_typeof(p_fields -> 'currency') <> 'null'
      AND (jsonb_typeof(p_fields -> 'currency') <> 'string' OR (p_fields ->> 'currency') !~ '^[A-Z]{3}$') THEN
    RAISE EXCEPTION 'invalid_field: currency';
  END IF;
  IF p_fields ? 'gross_total' AND jsonb_typeof(p_fields -> 'gross_total') <> 'null'
      AND (jsonb_typeof(p_fields -> 'gross_total') <> 'string' OR (p_fields ->> 'gross_total') !~ '^-?[0-9]{1,16}(\.[0-9]{1,4})?$') THEN
    RAISE EXCEPTION 'invalid_field: gross_total';
  END IF;
  IF p_fields ? 'issue_date' AND jsonb_typeof(p_fields -> 'issue_date') <> 'null' THEN
    IF jsonb_typeof(p_fields -> 'issue_date') <> 'string' OR (p_fields ->> 'issue_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END IF;
    BEGIN
      issue := (p_fields ->> 'issue_date')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END;
  END IF;

  UPDATE public.documents d SET
    content_hash = CASE WHEN p_fields ? 'content_hash' THEN p_fields ->> 'content_hash' ELSE d.content_hash END,
    language = CASE WHEN p_fields ? 'language' THEN p_fields ->> 'language' ELSE d.language END,
    doc_date = CASE WHEN p_fields ? 'doc_date' THEN (p_fields ->> 'doc_date')::date ELSE d.doc_date END,
    doc_type = CASE WHEN p_fields ? 'doc_type' THEN p_fields ->> 'doc_type' ELSE d.doc_type END,
    doc_type_origin = CASE WHEN p_fields ? 'doc_type_origin' THEN p_fields ->> 'doc_type_origin' ELSE d.doc_type_origin END,
    parser_used = CASE WHEN p_fields ? 'parser_used' THEN p_fields ->> 'parser_used' ELSE d.parser_used END,
    parser_version = CASE WHEN p_fields ? 'parser_version' THEN p_fields ->> 'parser_version' ELSE d.parser_version END,
    processing_profile_id = CASE WHEN p_fields ? 'processing_profile_id' THEN p_fields ->> 'processing_profile_id' ELSE d.processing_profile_id END,
    processing_profile_version = CASE WHEN p_fields ? 'processing_profile_version' THEN (p_fields ->> 'processing_profile_version')::integer ELSE d.processing_profile_version END,
    original_path = CASE WHEN p_fields ? 'original_path' THEN p_fields ->> 'original_path' ELSE d.original_path END,
    source_provider = CASE WHEN p_fields ? 'source_provider' THEN p_fields ->> 'source_provider' ELSE d.source_provider END,
    source_file_id = CASE WHEN p_fields ? 'source_file_id' THEN p_fields ->> 'source_file_id' ELSE d.source_file_id END,
    source_connection_id = CASE WHEN p_fields ? 'source_connection_id' THEN p_fields ->> 'source_connection_id' ELSE d.source_connection_id END,
    status = CASE WHEN p_fields ? 'status' THEN p_fields ->> 'status' ELSE d.status END,
    metadata = CASE WHEN p_fields ? 'metadata' THEN COALESCE(d.metadata, '{}'::jsonb) || (p_fields -> 'metadata') ELSE d.metadata END,
    invoice_number = CASE WHEN p_fields ? 'invoice_number' THEN p_fields ->> 'invoice_number' ELSE d.invoice_number END,
    supplier_name = CASE WHEN p_fields ? 'supplier_name' THEN p_fields ->> 'supplier_name' ELSE d.supplier_name END,
    supplier_tax_id = CASE WHEN p_fields ? 'supplier_tax_id' THEN p_fields ->> 'supplier_tax_id' ELSE d.supplier_tax_id END,
    issue_date = CASE WHEN p_fields ? 'issue_date' THEN (p_fields ->> 'issue_date')::date ELSE d.issue_date END,
    gross_total = CASE WHEN p_fields ? 'gross_total' THEN (p_fields ->> 'gross_total')::numeric(20, 4) ELSE d.gross_total END,
    currency = CASE WHEN p_fields ? 'currency' THEN p_fields ->> 'currency' ELSE d.currency END,
    content = CASE WHEN p_fields ? 'content' THEN p_fields ->> 'content' ELSE d.content END
  WHERE d.id = p_document_id;

  IF p_fields ?| ARRAY['doc_type', 'doc_date', 'language', 'parser_used', 'status'] THEN
    UPDATE public.document_chunks c SET
      doc_type = d.doc_type,
      doc_date = d.doc_date,
      language = d.language,
      parser_used = d.parser_used,
      status = d.status,
      metadata = COALESCE(c.metadata, '{}'::jsonb)
        || jsonb_build_object('doc_type', d.doc_type, 'language', d.language, 'parser_used', d.parser_used)
    FROM public.documents d
    WHERE d.id = p_document_id AND c.document_id = d.id;
  END IF;

  RETURN QUERY SELECT d.id, d.status FROM public.documents d WHERE d.id = p_document_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_document_parse_cache(p_job_id uuid, p_cache_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job record;
  v_cache record;
  v_doc_tenant text;
BEGIN
  SELECT j.tenant_key, j.document_id INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.document_id IS NULL THEN
    RAISE EXCEPTION 'parse_cache_refused: document_not_linked' USING ERRCODE = '22023';
  END IF;
  SELECT c.id, c.tenant_key INTO v_cache FROM public.rag_parse_cache c WHERE c.id = p_cache_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: cache_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_cache.tenant_key IS DISTINCT FROM v_job.tenant_key THEN
    RAISE EXCEPTION 'parse_cache_refused: cache_tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT d.tenant_key INTO v_doc_tenant FROM public.documents d WHERE d.id = v_job.document_id;
  IF v_doc_tenant IS DISTINCT FROM v_job.tenant_key THEN
    RAISE EXCEPTION 'parse_cache_refused: document_tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  UPDATE public.documents d SET parse_cache_id = p_cache_id
   WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_embedding_profile_status(p_profile_id text, p_status text, p_actor text)
 RETURNS TABLE(profile_id text, profile_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_current text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'profile_status_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'active' THEN
    RAISE EXCEPTION 'profile_status_refused: use_activation_gate' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('available', 'backfilling', 'retired') THEN
    RAISE EXCEPTION 'profile_status_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT p.status INTO v_current FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_status_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_current = 'active' THEN
    RAISE EXCEPTION 'profile_status_refused: profile_is_active' USING ERRCODE = '22000';
  END IF;

  UPDATE public.embedding_profiles SET status = p_status WHERE id = p_profile_id;
  RETURN QUERY SELECT p_profile_id, p_status;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_parse_tier_override(p_doc_type text, p_min_tier text, p_max_tier text, p_actor uuid)
 RETURNS public.rag_parse_tier_overrides
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.rag_parse_tier_overrides%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'parse_tier_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  IF NOT public.rag_parse_doc_type_ok(p_doc_type) THEN
    RAISE EXCEPTION 'parse_tier_refused: invalid_doc_type' USING ERRCODE = '22023';
  END IF;

  IF p_min_tier IS NULL AND p_max_tier IS NULL THEN
    DELETE FROM public.rag_parse_tier_overrides WHERE doc_type = p_doc_type;
    INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
    VALUES (
      'set_parse_tier_override',
      '00000000-0000-4000-8000-000000000000',
      NULL,
      's:default',
      NULL,
      p_actor,
      ARRAY[p_doc_type, 'deleted']
    );
    RETURN NULL;
  END IF;

  IF p_min_tier IS NULL OR p_max_tier IS NULL
     OR p_min_tier NOT IN ('native', 'fast', 'structured', 'premium')
     OR p_max_tier NOT IN ('native', 'fast', 'structured', 'premium')
     OR public.rag_parse_tier_rank(p_min_tier) > public.rag_parse_tier_rank(p_max_tier) THEN
    RAISE EXCEPTION 'parse_tier_refused: invalid_bounds' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rag_parse_tier_overrides AS o (doc_type, min_tier, max_tier, updated_by, updated_at)
  VALUES (p_doc_type, p_min_tier, p_max_tier, p_actor::text, now())
  ON CONFLICT (doc_type) DO UPDATE
     SET min_tier = EXCLUDED.min_tier,
         max_tier = EXCLUDED.max_tier,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at
  RETURNING o.* INTO v_row;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES (
    'set_parse_tier_override',
    '00000000-0000-4000-8000-000000000000',
    NULL,
    's:default',
    NULL,
    p_actor,
    ARRAY[p_doc_type, p_min_tier, p_max_tier]
  );

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_settle_parse_budget(p_job_id uuid, p_attempt_no integer, p_kind text, p_pages_used integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  rec public.rag_parse_budget_reservations%ROWTYPE;
  v_used integer;
BEGIN
  IF p_pages_used IS NULL OR p_pages_used < 0 THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_pages' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('parse', 'vlm') THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO rec
    FROM public.rag_parse_budget_reservations r
   WHERE r.job_id = p_job_id AND r.attempt_no = p_attempt_no AND r.kind = p_kind
   FOR UPDATE;

  IF NOT FOUND OR rec.state = 'released' THEN
    RETURN false;
  END IF;
  IF rec.state = 'settled' THEN
    RETURN true;
  END IF;

  v_used := GREATEST(0, LEAST(p_pages_used, rec.pages));

  UPDATE public.rag_parse_budget_reservations SET state = 'settled' WHERE id = rec.id;

  UPDATE public.rag_parse_budget_usage u
     SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages),
         pages_used = u.pages_used + CASE WHEN p_kind = 'parse' THEN v_used ELSE 0 END,
         vlm_pages_used = u.vlm_pages_used + CASE WHEN p_kind = 'vlm' THEN v_used ELSE 0 END
   WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_update_embed_batch(p_embed_batch_id uuid, p_status text, p_provider_batch_id text DEFAULT NULL::text, p_output_file_id text DEFAULT NULL::text, p_error_file_id text DEFAULT NULL::text, p_error text DEFAULT NULL::text)
 RETURNS public.rag_embed_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  UPDATE public.rag_embed_batches e
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
$function$;

CREATE OR REPLACE FUNCTION public.rag_update_ingestion_batch(p_batch_id uuid, p_status text DEFAULT NULL::text, p_dry_run_report jsonb DEFAULT NULL::jsonb, p_totals jsonb DEFAULT NULL::jsonb)
 RETURNS public.ingestion_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  UPDATE public.ingestion_batches b
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
$function$;

CREATE OR REPLACE FUNCTION public.set_last_updated_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
    NEW.updated_at = TIMEZONE('utc', NOW());
    RETURN NEW;
END;
$function$;

COMMIT;
