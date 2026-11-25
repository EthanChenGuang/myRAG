-- 0703: Phase 7 vector sync claim and lifecycle RPCs (D-04, D-24, A-7, A-12).
-- claim leases pending rows and expired leases oldest first, FOR UPDATE SKIP LOCKED, and never hands out an entity
-- (target, entity, entity_id) that another row holds under a live lease, so overlapping drains cannot write a stale state last.
-- Claims take a transaction advisory lock so two claimers cannot both pass the live-lease test for the same entity before either
-- commits. Retry backoff reuses lease_until on a pending row; the eighth failed attempt is dead. checkpoint stores a paging cursor
-- and gives back the attempt the claim counted. expand pages a tenant or profile row into document rows for its target.
-- set_target is the operator switch: enabling a backend enqueues a full build per tenant and marks its index state building.
-- SECURITY INVOKER, service role only; no function takes a tenant key from the caller.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_claim(p_limit integer, p_lease_seconds integer)
RETURNS SETOF public.vector_sync_outbox
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_lease' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.rag_vector_sync_claim'));

  RETURN QUERY
  WITH candidates AS (
    SELECT c.id
      FROM public.vector_sync_outbox c
     WHERE ((c.status = 'pending' AND (c.lease_until IS NULL OR c.lease_until < pg_catalog.now()))
            OR (c.status = 'leased' AND c.lease_until < pg_catalog.now()))
       AND NOT EXISTS (
         SELECT 1 FROM public.vector_sync_outbox l
          WHERE l.target = c.target
            AND l.entity = c.entity
            AND l.entity_id = c.entity_id
            AND l.id <> c.id
            AND l.status = 'leased'
            AND l.lease_until >= pg_catalog.now()
       )
     ORDER BY c.enqueued_at, c.id
     LIMIT p_limit
     FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE public.vector_sync_outbox o
     SET status = 'leased',
         lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1
    FROM candidates
   WHERE o.id = candidates.id
  RETURNING o.*;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_complete(p_ids bigint[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.vector_sync_outbox o
     SET status = 'done', lease_until = NULL, last_error = NULL
   WHERE o.id = ANY (coalesce(p_ids, '{}'::bigint[]))
     AND o.status = 'leased';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_fail(p_id bigint, p_error text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_code text := pg_catalog.left(coalesce(p_error, 'unknown'), 200);
  v_status text;
BEGIN
  -- Codes only (backend_error:503, timeout): anything else may carry content and is replaced.
  IF v_code !~ '^[a-z0-9_.:-]+$' THEN
    v_code := 'invalid_error_code';
  END IF;
  UPDATE public.vector_sync_outbox o
     SET status = CASE WHEN o.attempts >= 8 THEN 'dead' ELSE 'pending' END,
         lease_until = CASE
           WHEN o.attempts >= 8 THEN NULL
           ELSE pg_catalog.now() + pg_catalog.make_interval(secs => LEAST(pg_catalog.power(2, o.attempts), 3600))
         END,
         last_error = v_code
   WHERE o.id = p_id AND o.status = 'leased'
  RETURNING o.status INTO v_status;
  RETURN v_status;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_checkpoint(p_id bigint, p_cursor text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_found boolean;
BEGIN
  IF p_cursor IS NULL OR p_cursor = '' OR pg_catalog.length(p_cursor) > 200 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_cursor' USING ERRCODE = '22023';
  END IF;
  UPDATE public.vector_sync_outbox o
     SET status = 'pending', lease_until = NULL, cursor = p_cursor, attempts = GREATEST(o.attempts - 1, 0)
   WHERE o.id = p_id AND o.status = 'leased';
  v_found := FOUND;
  RETURN v_found;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_expand(p_id bigint, p_limit integer)
RETURNS TABLE (enqueued integer, next_cursor text, has_more boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.vector_sync_outbox%ROWTYPE;
  v_after uuid;
  v_doc_type text;
  v_docs text[];
  v_tenants text[];
  v_profiles text[];
  v_total integer;
  v_count integer;
  v_last text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.vector_sync_outbox o WHERE o.id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.status <> 'leased' OR v_row.entity NOT IN ('tenant', 'profile') THEN
    RAISE EXCEPTION 'vector_sync_refused: not_expandable' USING ERRCODE = '22023';
  END IF;
  IF v_row.cursor IS NOT NULL THEN
    IF v_row.cursor !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'vector_sync_refused: invalid_cursor' USING ERRCODE = '22023';
    END IF;
    v_after := v_row.cursor::uuid;
  END IF;
  IF v_row.entity = 'profile' THEN
    IF v_row.entity_id LIKE 'chunking:%' THEN
      v_doc_type := pg_catalog.substr(v_row.entity_id, pg_catalog.length('chunking:') + 1);
    ELSIF v_row.entity_id NOT LIKE 'embedding:%' THEN
      RAISE EXCEPTION 'vector_sync_refused: not_expandable' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Current documents of the row's tenant, or of every tenant for a profile row (one doc_type for a chunking pointer).
  SELECT pg_catalog.array_agg(p.id::text ORDER BY p.id), pg_catalog.array_agg(p.tenant_key ORDER BY p.id), count(*)::integer
    INTO v_docs, v_tenants, v_total
    FROM (
      SELECT d.id, d.tenant_key
        FROM public.documents d
       WHERE d.is_current
         AND (v_row.entity = 'profile' OR d.tenant_key = v_row.tenant_key)
         AND (v_doc_type IS NULL OR d.doc_type = v_doc_type)
         AND (v_after IS NULL OR d.id > v_after)
       ORDER BY d.id
       LIMIT p_limit + 1
    ) p;

  has_more := coalesce(v_total, 0) > p_limit;
  IF has_more THEN
    v_docs := v_docs[1:p_limit];
    v_tenants := v_tenants[1:p_limit];
  END IF;
  v_count := coalesce(pg_catalog.array_length(v_docs, 1), 0);
  v_profiles := pg_catalog.array_fill(v_row.profile_id, ARRAY[v_count]);
  enqueued := public.rag_vector_sync_enqueue('document', v_docs, v_tenants, v_profiles, v_row.target);
  v_last := CASE WHEN v_count > 0 THEN v_docs[v_count] ELSE v_row.cursor END;
  UPDATE public.vector_sync_outbox o SET cursor = v_last WHERE o.id = p_id;
  next_cursor := v_last;
  RETURN NEXT;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_requeue_dead(p_target text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  UPDATE public.vector_sync_outbox o
     SET status = 'pending', attempts = 0, lease_until = NULL
   WHERE o.target = p_target AND o.status = 'dead';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_set_target(p_target text, p_enabled boolean, p_actor text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_was boolean;
  v_tenants text[];
  v_count integer;
BEGIN
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_enabled' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'vector_sync_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  SELECT t.enabled INTO v_was FROM public.rag_vector_sync_targets t WHERE t.target = p_target FOR UPDATE;
  INSERT INTO public.rag_vector_sync_targets AS t (target, enabled, updated_at, updated_by)
  VALUES (p_target, p_enabled, pg_catalog.now(), pg_catalog.left(p_actor, 200))
  ON CONFLICT (target) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;

  IF NOT p_enabled OR coalesce(v_was, false) THEN
    RETURN 0;
  END IF;

  SELECT pg_catalog.array_agg(k.tenant_key ORDER BY k.tenant_key)
    INTO v_tenants
    FROM (SELECT DISTINCT d.tenant_key FROM public.documents d WHERE d.is_current AND d.tenant_key IS NOT NULL) k;
  v_count := coalesce(pg_catalog.array_length(v_tenants, 1), 0);

  -- The synced profiles are the active one and any being backfilled (Phase 3 D-34).
  INSERT INTO public.rag_backend_index_state AS s (target, profile_id, tenant_key, state, updated_at)
  SELECT p_target, p.id, k.tenant_key, 'building', pg_catalog.now()
    FROM public.embedding_profiles p
    CROSS JOIN unnest(coalesce(v_tenants, '{}'::text[])) AS k(tenant_key)
   WHERE p.status IN ('active', 'backfilling')
  ON CONFLICT (target, profile_id, tenant_key) DO UPDATE SET state = 'building', last_error = NULL, updated_at = EXCLUDED.updated_at;

  RETURN public.rag_vector_sync_enqueue('tenant', v_tenants, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[v_count]), p_target);
END
$$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_claim(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_complete(bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_fail(bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_checkpoint(bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_expand(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_requeue_dead(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_set_target(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_claim(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_complete(bigint[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_fail(bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_checkpoint(bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_expand(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_requeue_dead(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_set_target(text, boolean, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
