-- 0707: Phase 7 vector sync reconcile RPCs (D-05, D-11, A-12).
-- Reconcile compares, per (target, profile, tenant), Supabase's servable rows that hold a vector in the profile (the same set
-- rag_vector_sync_document_rows reads, 0705) with the external store, and repairs drift through the outbox.
-- Hash definition, shared with src/lib/rag/sync/reconcile.ts: m = md5(chunk id as lowercase text);
--   bucket = first byte of m mod 64; id hash = first 16 hex digits of m read as a signed 64-bit integer;
--   content hash = the same over md5(id || ':' || coalesce(content_hash, '') || ':' || coalesce(lexical_version, '')).
-- Per bucket the summary returns the row count and the XOR of both hashes, as decimal text (JSON numbers lose 64-bit precision).
-- rag_vector_sync_bucket_rows pages the rows of one bucket so a mismatch narrows to ids.
-- rag_vector_sync_tenants lists, for an enabled target, the tenants with servable rows or an index-state row, least recently
-- reconciled first. rag_vector_sync_enqueue_repair adds one outbox row (the 0702 rag_vector_sync_enqueue name is taken by the
-- array writer the triggers call). rag_set_backend_index_state records one compare; a mismatch leaves a building tenant building,
-- so a newly enabled tenant becomes ready only on its first match. rag_vector_sync_prune deletes done rows only.
-- SECURITY INVOKER, search_path '', service role only. Idempotent: safe to run more than once.

BEGIN;

DROP FUNCTION IF EXISTS public.rag_vector_sync_reconcile_summary(text, text);
DROP FUNCTION IF EXISTS public.rag_vector_sync_bucket_rows(text, text, integer, uuid, integer);
DROP FUNCTION IF EXISTS public.rag_vector_sync_tenants(text, text);
DROP FUNCTION IF EXISTS public.rag_vector_sync_enqueue_repair(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.rag_set_backend_index_state(text, text, text, text, bigint, bigint, text);
DROP FUNCTION IF EXISTS public.rag_vector_sync_prune(integer);

CREATE FUNCTION public.rag_vector_sync_reconcile_summary(p_tenant_key text, p_profile_id text)
RETURNS TABLE (bucket integer, row_count bigint, id_xor text, content_xor text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_storage text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT c.id, c.content_hash, c.lexical_version
      FROM public.rag_servable_chunks s
      JOIN public.document_chunks c ON c.id = s.chunk_id
     WHERE s.tenant_key = p_tenant_key
       AND c.tenant_key = p_tenant_key
       AND CASE
             WHEN v_storage = 'legacy_column' THEN c.embedding IS NOT NULL
             ELSE EXISTS (
               SELECT 1 FROM public.chunk_embeddings e
                WHERE e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
             )
           END
  ),
  hashed AS (
    SELECT pg_catalog.md5(r.id::text) AS m,
           pg_catalog.md5(r.id::text || ':' || coalesce(r.content_hash, '') || ':' || coalesce(r.lexical_version::text, '')) AS cm
      FROM src r
  ),
  per_bucket AS (
    SELECT (pg_catalog.get_byte(pg_catalog.decode(pg_catalog.substr(h.m, 1, 2), 'hex'), 0) % 64) AS b,
           count(*)::bigint AS n,
           pg_catalog.bit_xor(('x' || pg_catalog.substr(h.m, 1, 16))::bit(64)::bigint) AS ix,
           pg_catalog.bit_xor(('x' || pg_catalog.substr(h.cm, 1, 16))::bit(64)::bigint) AS cx
      FROM hashed h
     GROUP BY 1
  )
  SELECT g.b, coalesce(p.n, 0)::bigint, coalesce(p.ix, 0)::text, coalesce(p.cx, 0)::text
    FROM pg_catalog.generate_series(0, 63) AS g(b)
    LEFT JOIN per_bucket p ON p.b = g.b
   ORDER BY g.b;
END
$fn$;

CREATE FUNCTION public.rag_vector_sync_bucket_rows(
  p_tenant_key text,
  p_profile_id text,
  p_bucket integer,
  p_after uuid,
  p_limit integer
)
RETURNS TABLE (chunk_id uuid, document_id uuid, content_hash text, lexical_version integer)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_storage text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_bucket IS NULL OR p_bucket < 0 OR p_bucket > 63 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_bucket' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT c.id, c.document_id, c.content_hash, c.lexical_version
    FROM public.rag_servable_chunks s
    JOIN public.document_chunks c ON c.id = s.chunk_id
   WHERE s.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key
     AND (p_after IS NULL OR c.id > p_after)
     AND (pg_catalog.get_byte(pg_catalog.decode(pg_catalog.substr(pg_catalog.md5(c.id::text), 1, 2), 'hex'), 0) % 64) = p_bucket
     AND CASE
           WHEN v_storage = 'legacy_column' THEN c.embedding IS NOT NULL
           ELSE EXISTS (
             SELECT 1 FROM public.chunk_embeddings e
              WHERE e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
           )
         END
   ORDER BY c.id
   LIMIT p_limit;
END
$fn$;

CREATE FUNCTION public.rag_vector_sync_tenants(p_target text, p_profile_id text)
RETURNS TABLE (tenant_key text, last_reconciled_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.embedding_profiles e WHERE e.id = p_profile_id) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.target = p_target AND t.enabled) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT k.tenant_key, s.last_reconciled_at
    FROM (
      SELECT DISTINCT v.tenant_key FROM public.rag_servable_chunks v WHERE v.tenant_key IS NOT NULL
      UNION
      SELECT i.tenant_key FROM public.rag_backend_index_state i WHERE i.target = p_target AND i.profile_id = p_profile_id
    ) k
    LEFT JOIN public.rag_backend_index_state s
      ON s.target = p_target AND s.profile_id = p_profile_id AND s.tenant_key = k.tenant_key
   ORDER BY s.last_reconciled_at ASC NULLS FIRST, k.tenant_key;
END
$fn$;

CREATE FUNCTION public.rag_vector_sync_enqueue_repair(
  p_target text,
  p_entity text,
  p_entity_id text,
  p_tenant_key text,
  p_profile_id text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  IF p_entity IS NULL OR p_entity NOT IN ('chunk', 'document', 'tenant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_entity' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_entity = 'tenant' THEN
    IF p_entity_id IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'vector_sync_refused: invalid_entity_id' USING ERRCODE = '22023';
    END IF;
  ELSIF p_entity_id IS NULL OR p_entity_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_entity_id' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.embedding_profiles e WHERE e.id = p_profile_id) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key, profile_id)
  SELECT p_target, p_entity, p_entity_id, p_tenant_key, p_profile_id
   WHERE EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.target = p_target AND t.enabled)
     AND NOT EXISTS (
       SELECT 1 FROM public.vector_sync_outbox o
        WHERE o.target = p_target
          AND o.entity = p_entity
          AND o.entity_id = p_entity_id
          AND o.status = 'pending'
          AND o.attempts = 0
          AND o.cursor IS NULL
          AND o.tenant_key IS NOT DISTINCT FROM p_tenant_key
          AND o.profile_id IS NOT DISTINCT FROM p_profile_id
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

CREATE FUNCTION public.rag_set_backend_index_state(
  p_target text,
  p_profile_id text,
  p_tenant_key text,
  p_state text,
  p_supabase_count bigint,
  p_backend_count bigint,
  p_error text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_error text;
  v_lag integer;
  v_state text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.embedding_profiles e WHERE e.id = p_profile_id) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('ready', 'stale', 'failed') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_state' USING ERRCODE = '22023';
  END IF;
  IF (p_supabase_count IS NOT NULL AND p_supabase_count < 0) OR (p_backend_count IS NOT NULL AND p_backend_count < 0) THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_count' USING ERRCODE = '22023';
  END IF;

  -- Codes only: anything that is not a short code is replaced, so no content can reach last_error.
  IF p_state = 'failed' THEN
    v_error := CASE WHEN p_error ~ '^[a-z0-9_.:-]{1,200}$' THEN p_error ELSE 'store_error' END;
  END IF;

  SELECT coalesce(pg_catalog.ceil(EXTRACT(EPOCH FROM (pg_catalog.now() - pg_catalog.min(o.enqueued_at))))::integer, 0)
    INTO v_lag
    FROM public.vector_sync_outbox o
   WHERE o.target = p_target
     AND o.tenant_key = p_tenant_key
     AND o.status IN ('pending', 'leased');

  INSERT INTO public.rag_backend_index_state AS s (
    target, profile_id, tenant_key, state, last_reconciled_at, lag_seconds, supabase_count, backend_count, last_error, updated_at
  )
  VALUES (
    p_target, p_profile_id, p_tenant_key, CASE WHEN p_state = 'stale' THEN 'building' ELSE p_state END, pg_catalog.now(), v_lag,
    p_supabase_count, p_backend_count, v_error, pg_catalog.now()
  )
  ON CONFLICT (target, profile_id, tenant_key) DO UPDATE
    SET state = CASE WHEN EXCLUDED.state = 'building' AND s.state <> 'building' THEN 'stale' ELSE EXCLUDED.state END,
        last_reconciled_at = EXCLUDED.last_reconciled_at,
        lag_seconds = EXCLUDED.lag_seconds,
        supabase_count = EXCLUDED.supabase_count,
        backend_count = EXCLUDED.backend_count,
        last_error = EXCLUDED.last_error,
        updated_at = EXCLUDED.updated_at
  RETURNING s.state INTO v_state;
  RETURN v_state;
END
$fn$;

CREATE FUNCTION public.rag_vector_sync_prune(p_days integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 3650 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_days' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.vector_sync_outbox o
   WHERE o.status = 'done'
     AND o.enqueued_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_reconcile_summary(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_bucket_rows(text, text, integer, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_tenants(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_enqueue_repair(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_set_backend_index_state(text, text, text, text, bigint, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_reconcile_summary(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_bucket_rows(text, text, integer, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_tenants(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_enqueue_repair(text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_set_backend_index_state(text, text, text, text, bigint, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_prune(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
