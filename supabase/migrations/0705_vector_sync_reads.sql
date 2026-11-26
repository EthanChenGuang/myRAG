-- 0705: Phase 7 vector sync reads for the drain worker (D-02, D-03, D-11).
-- rag_vector_sync_document_rows pages the servable chunks of one document (rag_servable_chunks, 0704) that hold a vector in the
-- profile, ordered by chunk id after p_after, with the profile vector as real[] and only the D-03 payload fields: lexical_text,
-- lexical_version, content_hash and the filter fields. No chunk content and no document name leave through these functions.
-- rag_vector_sync_chunk_row is the same read for one chunk. A chunk or document missing from the answer is not servable for that
-- profile, and the worker deletes its point.
-- rag_vector_sync_profiles lists the synced embedding profiles (active and backfilling) with dims and storage.
-- rag_backend_readiness returns the index state row of (target, profile, tenant), or a row with a null state when there is none,
-- plus the live outbox lag in seconds: the age of the oldest pending or leased outbox row of that target and tenant.
-- Every function taking a tenant key checks it with rag_assert_tenant_key first. SECURITY INVOKER, service role only.
-- Idempotent: safe to run more than once.

BEGIN;

DROP FUNCTION IF EXISTS public.rag_vector_sync_document_rows(text, uuid, text, uuid, integer);
DROP FUNCTION IF EXISTS public.rag_vector_sync_chunk_row(text, uuid, text);
DROP FUNCTION IF EXISTS public.rag_vector_sync_profiles();
DROP FUNCTION IF EXISTS public.rag_backend_readiness(text, text, text);

CREATE FUNCTION public.rag_vector_sync_document_rows(
  p_tenant_key text,
  p_document_id uuid,
  p_profile_id text,
  p_after uuid,
  p_limit integer
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  tenant_key text,
  vector real[],
  lexical_text text,
  lexical_version integer,
  content_hash text,
  doc_type text,
  doc_date date,
  language text,
  source text,
  chunking_profile_id text,
  parent_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_storage text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'vector_sync_refused: document_required' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;

  IF v_storage = 'legacy_column' THEN
    RETURN QUERY
    SELECT c.id, c.document_id, c.tenant_key, c.embedding::real[], c.lexical_text, c.lexical_version, c.content_hash, c.doc_type,
           c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id
      FROM public.rag_servable_chunks s
      JOIN public.document_chunks c ON c.id = s.chunk_id
     WHERE s.document_id = p_document_id
       AND s.tenant_key = p_tenant_key
       AND c.tenant_key = p_tenant_key
       AND (p_after IS NULL OR c.id > p_after)
       AND c.embedding IS NOT NULL
     ORDER BY c.id
     LIMIT p_limit;
  ELSE
    RETURN QUERY
    SELECT c.id, c.document_id, c.tenant_key, (e.embedding::public.vector)::real[], c.lexical_text, c.lexical_version, c.content_hash,
           c.doc_type, c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id
      FROM public.rag_servable_chunks s
      JOIN public.document_chunks c ON c.id = s.chunk_id
      JOIN public.chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
     WHERE s.document_id = p_document_id
       AND s.tenant_key = p_tenant_key
       AND c.tenant_key = p_tenant_key
       AND (p_after IS NULL OR c.id > p_after)
     ORDER BY c.id
     LIMIT p_limit;
  END IF;
END
$fn$;

CREATE FUNCTION public.rag_vector_sync_chunk_row(p_tenant_key text, p_chunk_id uuid, p_profile_id text)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  tenant_key text,
  vector real[],
  lexical_text text,
  lexical_version integer,
  content_hash text,
  doc_type text,
  doc_date date,
  language text,
  source text,
  chunking_profile_id text,
  parent_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_storage text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_chunk_id IS NULL THEN
    RAISE EXCEPTION 'vector_sync_refused: chunk_required' USING ERRCODE = '22023';
  END IF;
  SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;

  IF v_storage = 'legacy_column' THEN
    RETURN QUERY
    SELECT c.id, c.document_id, c.tenant_key, c.embedding::real[], c.lexical_text, c.lexical_version, c.content_hash, c.doc_type,
           c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id
      FROM public.rag_servable_chunks s
      JOIN public.document_chunks c ON c.id = s.chunk_id
     WHERE s.chunk_id = p_chunk_id
       AND s.tenant_key = p_tenant_key
       AND c.tenant_key = p_tenant_key
       AND c.embedding IS NOT NULL;
  ELSE
    RETURN QUERY
    SELECT c.id, c.document_id, c.tenant_key, (e.embedding::public.vector)::real[], c.lexical_text, c.lexical_version, c.content_hash,
           c.doc_type, c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id
      FROM public.rag_servable_chunks s
      JOIN public.document_chunks c ON c.id = s.chunk_id
      JOIN public.chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
     WHERE s.chunk_id = p_chunk_id
       AND s.tenant_key = p_tenant_key
       AND c.tenant_key = p_tenant_key;
  END IF;
END
$fn$;

CREATE FUNCTION public.rag_vector_sync_profiles()
RETURNS TABLE (profile_id text, dims integer, storage text, status text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT p.id, p.dims, p.storage, p.status
    FROM public.embedding_profiles p
   WHERE p.status IN ('active', 'backfilling')
   ORDER BY p.id;
$fn$;

CREATE FUNCTION public.rag_backend_readiness(p_target text, p_profile_id text, p_tenant_key text)
RETURNS TABLE (
  target text,
  profile_id text,
  tenant_key text,
  state text,
  last_reconciled_at timestamptz,
  lag_seconds integer,
  supabase_count bigint,
  backend_count bigint,
  outbox_lag_seconds integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.embedding_profiles e WHERE e.id = p_profile_id) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT p_target, p_profile_id, p_tenant_key, s.state, s.last_reconciled_at, s.lag_seconds, s.supabase_count, s.backend_count,
         COALESCE((
           SELECT pg_catalog.ceil(EXTRACT(EPOCH FROM (pg_catalog.now() - pg_catalog.min(o.enqueued_at))))::integer
             FROM public.vector_sync_outbox o
            WHERE o.target = p_target
              AND o.tenant_key = p_tenant_key
              AND o.status IN ('pending', 'leased')
         ), 0)
    FROM (SELECT 1) one
    LEFT JOIN public.rag_backend_index_state s
      ON s.target = p_target AND s.profile_id = p_profile_id AND s.tenant_key = p_tenant_key;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_document_rows(text, uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_chunk_row(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_profiles() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_backend_readiness(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_document_rows(text, uuid, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunk_row(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_profiles() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_backend_readiness(text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
