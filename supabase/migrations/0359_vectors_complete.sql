-- 0359: Batch API embeddings for backfill jobs (D-35, D-36). With RAG_EMBED_BATCH_MODE=batch_api a backfill job on an OpenAI profile writes
-- its chunks without vectors and stops before publish (stage embed_deferred, lease released); the rag:backfill process embeds the chunks
-- through the OpenAI Batch API, writes the vectors and publishes the job. Publish refuses while a chunk lacks its active-profile vector.
--   rag_vectors_complete: true when every chunk of the version has a vector of the profile (tenant-checked).
--   rag_defer_ingestion_embed: the worker holding the lease parks a batch_api backfill job at embed_deferred and releases the lease.
--   rag_deferred_embed_chunks: the chunks of the batch's deferred jobs that lack a vector of a profile, keyset by chunk id.
--   rag_write_deferred_vectors: upserts vectors by chunk id, only for chunks of the batch's deferred jobs, only at the text version sent.
--   rag_publish_deferred_ingestion_job: vectors_incomplete unless complete, then the Phase 3 swap and the terminal ledger status.
--   rag_batch_progress: deferred jobs are counted under embed_deferred, so the monitor does not wait for them.
-- The tenant always comes from the job or batch row. SECURITY INVOKER (service_role bypasses RLS), empty search_path, service_role only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_vectors_complete(p_document_id uuid, p_profile_id text, p_tenant_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_profile public.embedding_profiles%ROWTYPE;
BEGIN
  IF p_document_id IS NULL OR p_tenant_key IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023', DETAIL = 'document not found in tenant';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR (v_profile.storage = 'legacy_column' AND v_profile.id <> 'openai-3-small-1536') THEN
    RAISE EXCEPTION 'embedding_profile_unsupported: %', p_profile_id USING ERRCODE = '22023';
  END IF;
  IF v_profile.storage = 'legacy_column' THEN
    RETURN NOT EXISTS (
      SELECT 1 FROM public.document_chunks c WHERE c.document_id = p_document_id AND c.embedding IS NULL
    );
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.document_chunks c
     WHERE c.document_id = p_document_id
       AND NOT EXISTS (
         SELECT 1 FROM public.chunk_embeddings e
          WHERE e.chunk_id = c.id AND e.profile_id = v_profile.id AND e.embedding_model = v_profile.model AND e.dims = v_profile.dims
       )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_defer_ingestion_embed(p_job_id uuid, p_worker text)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
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
  IF v_job.kind <> 'ingest' OR v_job.batch_id IS NULL OR v_job.document_id IS NULL
     OR (v_job.settings ->> 'embed_mode') IS DISTINCT FROM 'batch_api' THEN
    RAISE EXCEPTION 'ingest_refused: defer_not_allowed' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_doc FROM public.documents d WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_doc.is_current OR v_doc.status NOT IN ('processing', 'quarantined') THEN
    RAISE EXCEPTION 'ingest_refused: version_not_processing' USING ERRCODE = '22023';
  END IF;

  PERFORM public.rag_release_job_reservations(v_job.id);
  UPDATE public.ingestion_jobs j
     SET status = 'embedding',
         stage = 'embed_deferred',
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;
  UPDATE public.documents d SET processing_status = 'embedding' WHERE d.id = v_doc.id;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_deferred_embed_chunks(p_batch_id uuid, p_profile_id text, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  job_id uuid,
  tenant_key text,
  embedding_text_version integer,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_tenant text;
  v_profile public.embedding_profiles%ROWTYPE;
BEGIN
  SELECT b.tenant_key INTO v_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR (v_profile.storage = 'legacy_column' AND v_profile.id <> 'openai-3-small-1536') THEN
    RAISE EXCEPTION 'embedding_profile_unsupported: %', p_profile_id USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT c.id, c.document_id, j.id, c.tenant_key, c.embedding_text_version, c.content, c.section_path, c.chunk_kind,
         COALESCE(c.doc_type, d.doc_type),
         jsonb_build_object(
           'invoice_number', d.invoice_number,
           'supplier_name', d.supplier_name,
           'supplier_tax_id', d.supplier_tax_id,
           'issue_date', d.issue_date::text,
           'gross_total', d.gross_total::text,
           'currency', d.currency)
    FROM public.ingestion_jobs j
    JOIN public.documents d ON d.id = j.document_id AND d.tenant_key = j.tenant_key
    JOIN public.document_chunks c ON c.document_id = d.id AND c.tenant_key = d.tenant_key
   WHERE j.batch_id = p_batch_id
     AND j.tenant_key = v_tenant
     AND j.deleted_at IS NULL
     AND j.kind = 'ingest'
     AND j.status = 'embedding'
     AND j.stage = 'embed_deferred'
     AND (p_after IS NULL OR c.id > p_after)
     AND CASE
           WHEN v_profile.storage = 'legacy_column' THEN c.embedding IS NULL
           ELSE NOT EXISTS (
             SELECT 1 FROM public.chunk_embeddings e
              WHERE e.chunk_id = c.id AND e.profile_id = v_profile.id AND e.embedding_model = v_profile.model AND e.dims = v_profile.dims
           )
         END
   ORDER BY c.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_write_deferred_vectors(p_batch_id uuid, p_profile_id text, p_rows jsonb)
RETURNS TABLE (written integer, skipped integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_tenant text;
  v_profile public.embedding_profiles%ROWTYPE;
  v_total integer;
  v_written integer := 0;
  v_ids uuid[];
BEGIN
  SELECT b.tenant_key INTO v_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR (v_profile.storage = 'legacy_column' AND v_profile.id <> 'openai-3-small-1536') THEN
    RAISE EXCEPTION 'embedding_profile_unsupported: %', p_profile_id USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'invalid_rows: p_rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  v_total := jsonb_array_length(p_rows);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value)
     WHERE jsonb_typeof(r.value) <> 'object'
        OR jsonb_typeof(r.value -> 'chunk_id') IS DISTINCT FROM 'string'
        OR (r.value ->> 'chunk_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(r.value -> 'embedding_text_version') IS DISTINCT FROM 'number'
        OR jsonb_typeof(r.value -> 'embedding') IS DISTINCT FROM 'array'
        OR (r.value ? 'host' AND jsonb_typeof(r.value -> 'host') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_rows: every row needs chunk_id, embedding_text_version and embedding' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value) WHERE jsonb_array_length(r.value -> 'embedding') <> v_profile.dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  IF v_profile.storage = 'legacy_column' THEN
    WITH targets AS (
      SELECT DISTINCT ON (c.id) c.id AS chunk_id, r.value -> 'embedding' AS embedding
        FROM jsonb_array_elements(p_rows) AS r(value)
        JOIN public.document_chunks c ON c.id = (r.value ->> 'chunk_id')::uuid
        JOIN public.ingestion_jobs j ON j.document_id = c.document_id AND j.tenant_key = c.tenant_key
       WHERE j.batch_id = p_batch_id AND j.tenant_key = v_tenant AND j.deleted_at IS NULL AND j.kind = 'ingest'
         AND j.status = 'embedding' AND j.stage = 'embed_deferred'
         AND c.embedding_text_version = (r.value ->> 'embedding_text_version')::integer
       ORDER BY c.id
    ), updated AS (
      UPDATE public.document_chunks c
         SET embedding = (t.embedding::text)::public.vector,
             metadata = COALESCE(c.metadata, '{}'::jsonb)
               || jsonb_build_object('embedding_model', v_profile.model, 'embedding_dims', v_profile.dims)
        FROM targets t
       WHERE c.id = t.chunk_id
      RETURNING c.id
    )
    SELECT array_agg(u.id) INTO v_ids FROM updated u;
  ELSE
    WITH targets AS (
      SELECT DISTINCT ON (c.id) c.id AS chunk_id, r.value -> 'embedding' AS embedding, r.value ->> 'host' AS host
        FROM jsonb_array_elements(p_rows) AS r(value)
        JOIN public.document_chunks c ON c.id = (r.value ->> 'chunk_id')::uuid
        JOIN public.ingestion_jobs j ON j.document_id = c.document_id AND j.tenant_key = c.tenant_key
       WHERE j.batch_id = p_batch_id AND j.tenant_key = v_tenant AND j.deleted_at IS NULL AND j.kind = 'ingest'
         AND j.status = 'embedding' AND j.stage = 'embed_deferred'
         AND c.embedding_text_version = (r.value ->> 'embedding_text_version')::integer
       ORDER BY c.id
    ), inserted AS (
      INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
      SELECT t.chunk_id, v_profile.id, v_tenant, (t.embedding::text)::public.halfvec, v_profile.model, v_profile.dims, t.host
        FROM targets t
      ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
        embedding = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        dims = EXCLUDED.dims,
        embedding_host = EXCLUDED.embedding_host,
        embedded_at = now()
      RETURNING ce.chunk_id
    )
    SELECT array_agg(i.chunk_id) INTO v_ids FROM inserted i;
  END IF;
  v_written := COALESCE(array_length(v_ids, 1), 0);

  IF v_written > 0 THEN
    DELETE FROM public.embedding_backfill_gaps g WHERE g.profile_id = v_profile.id AND g.chunk_id = ANY (v_ids);
  END IF;

  RETURN QUERY SELECT v_written, v_total - v_written;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_publish_deferred_ingestion_job(p_job_id uuid, p_profile_id text)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc public.documents%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_outcome text;
  v_status text;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.status IN ('ready', 'quarantined', 'needs_review') AND v_job.kind = 'ingest' AND v_job.batch_id IS NOT NULL THEN
    RETURN v_job;
  END IF;
  IF v_job.kind <> 'ingest' OR v_job.batch_id IS NULL OR v_job.status <> 'embedding' OR v_job.stage IS DISTINCT FROM 'embed_deferred'
     OR v_job.document_id IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: not_deferred' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR NOT (v_profile.status = 'active' OR v_profile.id = 'openai-3-small-1536') THEN
    RAISE EXCEPTION 'ingest_refused: profile_not_active' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_doc FROM public.documents d WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_doc.status <> 'quarantined' AND NOT public.rag_vectors_complete(v_doc.id, v_profile.id, v_job.tenant_key) THEN
    RAISE EXCEPTION 'vectors_incomplete' USING ERRCODE = '22023', DETAIL = 'a chunk lacks its active-profile vector';
  END IF;

  SELECT r.outcome INTO v_outcome FROM public.rag_publish_document_version(v_doc.id, v_job.tenant_key) AS r;
  v_status := CASE
    WHEN v_outcome = 'quarantined' THEN 'quarantined'
    WHEN v_job.needs_review_reason IS NOT NULL THEN 'needs_review'
    ELSE 'ready'
  END;

  PERFORM public.rag_release_job_reservations(v_job.id);
  UPDATE public.ingestion_jobs j
     SET status = v_status,
         stage = v_status,
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  UPDATE public.documents d
     SET processing_status = public.rag_ingest_mirror_processing_status(v_status)
   WHERE d.id = v_doc.id;
  IF v_status = 'needs_review' THEN
    UPDATE public.documents d
       SET status = 'ready', needs_review = true, needs_review_reason = COALESCE(v_job.needs_review_reason, d.needs_review_reason)
     WHERE d.id = v_doc.id;
  ELSIF v_status = 'quarantined' THEN
    UPDATE public.documents d SET status = 'failed', processing_status = 'failed' WHERE d.id = v_doc.id AND NOT d.is_current;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

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
    SELECT j.kind,
           CASE WHEN j.status = 'embedding' AND j.stage = 'embed_deferred' THEN 'embed_deferred' ELSE j.status END AS status,
           count(*)::integer AS n
      FROM ingestion_jobs j
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
$$;

REVOKE ALL ON FUNCTION public.rag_vectors_complete(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_defer_ingestion_embed(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_deferred_embed_chunks(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_write_deferred_vectors(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_publish_deferred_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_batch_progress(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vectors_complete(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_defer_ingestion_embed(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_deferred_embed_chunks(uuid, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_write_deferred_vectors(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_publish_deferred_ingestion_job(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_batch_progress(uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
