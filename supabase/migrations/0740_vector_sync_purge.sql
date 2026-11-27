-- 0740: Phase 7 vector sync purges and stale-id repair (RET-05 delta: the outbox also carries DATA-24 purges).
-- A purge names a lineage and the document ids of every version, resolved by the caller before it deletes them, because the
-- outbox is notification-only and the rows are gone when the worker runs. Ids are identifiers, never content; the actor is an id and
-- the reason a code. A purge reaches every applicable target: enabled, or holding rag_backend_index_state rows for the tenant, so a
-- backend switched off before the purge still has its points removed. With no applicable target nothing is written (off = today).
-- A `purge` outbox row is claimed, completed and failed by the unchanged 0703 functions; its entity_id is the purge id.
-- Additive and idempotent, not folded into the setup files. Server role only: RLS on, no policies, no client grants;
-- every function is SECURITY INVOKER with an empty search_path and checks the tenant key with rag_assert_tenant_key.

BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.vector_sync_outbox'::regclass AND c.conname = 'vector_sync_outbox_entity_check';
  IF v_def IS NULL OR v_def NOT LIKE '%''purge''%' THEN
    ALTER TABLE public.vector_sync_outbox DROP CONSTRAINT IF EXISTS vector_sync_outbox_entity_check;
    ALTER TABLE public.vector_sync_outbox
      ADD CONSTRAINT vector_sync_outbox_entity_check CHECK (entity IN ('chunk', 'document', 'profile', 'tenant', 'purge'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.vector_sync_purges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  lineage_id uuid NOT NULL,
  document_ids uuid[] NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by text NOT NULL,
  reason_code text NOT NULL,
  CONSTRAINT vector_sync_purges_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT vector_sync_purges_document_ids_check CHECK (
    cardinality(document_ids) BETWEEN 1 AND 1000 AND array_position(document_ids, NULL) IS NULL
  ),
  CONSTRAINT vector_sync_purges_requested_by_check CHECK (requested_by ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  CONSTRAINT vector_sync_purges_reason_code_check CHECK (reason_code ~ '^[a-z0-9_.:-]{1,200}$'),
  CONSTRAINT vector_sync_purges_lineage_key UNIQUE (tenant_key, lineage_id)
);

CREATE TABLE IF NOT EXISTS public.vector_sync_purge_targets (
  purge_id uuid NOT NULL REFERENCES public.vector_sync_purges (id) ON DELETE CASCADE,
  target text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  collections_checked integer,
  points_deleted bigint,
  completed_at timestamptz,
  PRIMARY KEY (purge_id, target),
  CONSTRAINT vector_sync_purge_targets_target_check CHECK (target IN ('weaviate', 'qdrant')),
  CONSTRAINT vector_sync_purge_targets_status_check CHECK (status IN ('pending', 'done')),
  CONSTRAINT vector_sync_purge_targets_counts_check CHECK (
    (collections_checked IS NULL OR collections_checked >= 0) AND (points_deleted IS NULL OR points_deleted >= 0)
  )
);

CREATE INDEX IF NOT EXISTS vector_sync_purge_targets_target_idx ON public.vector_sync_purge_targets (target, purge_id);

ALTER TABLE public.vector_sync_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vector_sync_purge_targets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vector_sync_purges FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.vector_sync_purge_targets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vector_sync_purges TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vector_sync_purge_targets TO service_role;

-- The seam Phase 6.3's purge flow calls. Merges into the ledger row of the same tenant and lineage, re-opens its target rows and
-- writes one `purge` outbox row per applicable target unless one already waits untried. Returns the purge id, or NULL when no
-- target is applicable (then nothing is written).
CREATE OR REPLACE FUNCTION public.rag_vector_sync_enqueue_purge(
  p_tenant_key text,
  p_lineage_id uuid,
  p_document_ids uuid[],
  p_actor text,
  p_reason_code text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
  v_existing uuid[];
  v_targets text[];
  v_purge_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'vector_sync_refused: lineage_required' USING ERRCODE = '22023';
  END IF;
  IF p_document_ids IS NULL OR pg_catalog.cardinality(p_document_ids) NOT BETWEEN 1 AND 1000
     OR pg_catalog.array_position(p_document_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_document_ids' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:-]{1,200}$' THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_actor' USING ERRCODE = '22023';
  END IF;
  IF p_reason_code IS NULL OR p_reason_code !~ '^[a-z0-9_.:-]{1,200}$' THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_reason_code' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT u.id ORDER BY u.id) INTO v_ids FROM unnest(p_document_ids) AS u(id);

  -- An id that still has a row must belong to this tenant and lineage, and the lineage must not belong to another tenant.
  IF EXISTS (
       SELECT 1 FROM public.documents d
        WHERE d.id = ANY (v_ids)
          AND (d.tenant_key IS DISTINCT FROM p_tenant_key OR d.lineage_id IS DISTINCT FROM p_lineage_id)
     ) OR EXISTS (
       SELECT 1 FROM public.documents d
        WHERE d.lineage_id = p_lineage_id AND d.tenant_key IS DISTINCT FROM p_tenant_key
     ) THEN
    RAISE EXCEPTION 'vector_sync_refused: lineage_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(t.target ORDER BY t.target) INTO v_targets
    FROM public.rag_vector_sync_targets t
   WHERE t.enabled
      OR EXISTS (SELECT 1 FROM public.rag_backend_index_state s WHERE s.target = t.target AND s.tenant_key = p_tenant_key);
  IF v_targets IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.vector_sync_purges (tenant_key, lineage_id, document_ids, requested_by, reason_code)
  VALUES (p_tenant_key, p_lineage_id, v_ids, p_actor, p_reason_code)
  ON CONFLICT (tenant_key, lineage_id) DO NOTHING
  RETURNING id INTO v_purge_id;

  IF v_purge_id IS NULL THEN
    SELECT p.id, p.document_ids INTO v_purge_id, v_existing
      FROM public.vector_sync_purges p
     WHERE p.tenant_key = p_tenant_key AND p.lineage_id = p_lineage_id
       FOR UPDATE;
    SELECT pg_catalog.array_agg(DISTINCT u.id ORDER BY u.id) INTO v_ids FROM unnest(v_existing || v_ids) AS u(id);
    IF pg_catalog.cardinality(v_ids) > 1000 THEN
      RAISE EXCEPTION 'vector_sync_refused: invalid_document_ids' USING ERRCODE = '22023';
    END IF;
    UPDATE public.vector_sync_purges p
       SET document_ids = v_ids, requested_at = pg_catalog.now(), requested_by = p_actor, reason_code = p_reason_code
     WHERE p.id = v_purge_id;
  END IF;

  INSERT INTO public.vector_sync_purge_targets AS pt (purge_id, target, status)
  SELECT v_purge_id, u.target, 'pending' FROM unnest(v_targets) AS u(target)
  ON CONFLICT (purge_id, target) DO UPDATE
    SET status = 'pending', collections_checked = NULL, points_deleted = NULL, completed_at = NULL;

  INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key, profile_id)
  SELECT u.target, 'purge', v_purge_id::text, p_tenant_key, NULL
    FROM unnest(v_targets) AS u(target)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.vector_sync_outbox o
      WHERE o.target = u.target AND o.entity = 'purge' AND o.entity_id = v_purge_id::text
        AND o.status = 'pending' AND o.attempts = 0 AND o.cursor IS NULL
   );

  RETURN v_purge_id;
END
$$;

-- The worker's read of a claimed `purge` row: the tenant key and document ids to delete. Empty for an unknown purge id.
CREATE OR REPLACE FUNCTION public.rag_vector_sync_purge_row(p_purge_id uuid)
RETURNS TABLE (purge_id uuid, tenant_key text, lineage_id uuid, document_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.vector_sync_purges%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.vector_sync_purges p WHERE p.id = p_purge_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM public.rag_assert_tenant_key(v_row.tenant_key);
  purge_id := v_row.id;
  tenant_key := v_row.tenant_key;
  lineage_id := v_row.lineage_id;
  document_ids := v_row.document_ids;
  RETURN NEXT;
END
$$;

-- Records one target's finished purge. Returns false when the purge has no row for that target.
CREATE OR REPLACE FUNCTION public.rag_vector_sync_purge_complete(p_purge_id uuid, p_target text, p_collections integer, p_points bigint)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_key text;
BEGIN
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  IF p_collections IS NULL OR p_collections < 0 OR p_points IS NULL OR p_points < 0 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_counts' USING ERRCODE = '22023';
  END IF;
  SELECT p.tenant_key INTO v_key FROM public.vector_sync_purges p WHERE p.id = p_purge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vector_sync_refused: unknown_purge' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_assert_tenant_key(v_key);
  UPDATE public.vector_sync_purge_targets pt
     SET status = 'done', collections_checked = p_collections, points_deleted = p_points, completed_at = pg_catalog.now()
   WHERE pt.purge_id = p_purge_id AND pt.target = p_target;
  RETURN FOUND;
END
$$;

-- The external-store part of the purge verification query: one row per target. dead when the target's latest purge outbox row is
-- dead; pending while its target row or any of its outbox rows is still open; not_applicable without a target row.
CREATE OR REPLACE FUNCTION public.rag_vector_sync_purge_status(p_tenant_key text, p_lineage_id uuid)
RETURNS TABLE (
  target text,
  state text,
  collections_checked integer,
  points_deleted bigint,
  completed_at timestamptz,
  purge_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'vector_sync_refused: lineage_required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT t.target,
         CASE
           WHEN pt.purge_id IS NULL THEN 'not_applicable'
           WHEN lo.status = 'dead' THEN 'dead'
           WHEN pt.status = 'pending' OR lo.status IN ('pending', 'leased') THEN 'pending'
           ELSE 'done'
         END,
         pt.collections_checked,
         pt.points_deleted,
         pt.completed_at,
         p.id
    FROM public.rag_vector_sync_targets t
    LEFT JOIN public.vector_sync_purges p ON p.tenant_key = p_tenant_key AND p.lineage_id = p_lineage_id
    LEFT JOIN public.vector_sync_purge_targets pt ON pt.purge_id = p.id AND pt.target = t.target
    LEFT JOIN LATERAL (
      SELECT o.status FROM public.vector_sync_outbox o
       WHERE p.id IS NOT NULL AND o.target = t.target AND o.entity = 'purge' AND o.entity_id = p.id::text
       ORDER BY o.id DESC
       LIMIT 1
    ) lo ON true
   ORDER BY t.target;
END
$$;

-- The must-be-absent documents of a tenant for one target, for reconcile (plan 07-36), paged in document id order.
CREATE OR REPLACE FUNCTION public.rag_vector_sync_purged_documents(p_target text, p_tenant_key text, p_after uuid, p_limit integer)
RETURNS TABLE (document_id uuid, purge_id uuid, lineage_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT DISTINCT ON (d.id) d.id, p.id, p.lineage_id
    FROM public.vector_sync_purges p
    JOIN public.vector_sync_purge_targets pt ON pt.purge_id = p.id AND pt.target = p_target
    CROSS JOIN LATERAL unnest(p.document_ids) AS d(id)
   WHERE p.tenant_key = p_tenant_key
     AND (p_after IS NULL OR d.id > p_after)
   ORDER BY d.id, p.requested_at DESC
   LIMIT p_limit;
END
$$;

-- Sets a done target row back to pending and writes one `purge` outbox row, so reconcile can re-run a purge whose points
-- reappeared. The target may be disabled while it still holds points, so the row is written here, not by rag_vector_sync_enqueue.
CREATE OR REPLACE FUNCTION public.rag_vector_sync_purge_reopen(p_purge_id uuid, p_target text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_key text;
  v_status text;
BEGIN
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  SELECT p.tenant_key INTO v_key FROM public.vector_sync_purges p WHERE p.id = p_purge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vector_sync_refused: unknown_purge' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_assert_tenant_key(v_key);
  SELECT pt.status INTO v_status
    FROM public.vector_sync_purge_targets pt
   WHERE pt.purge_id = p_purge_id AND pt.target = p_target
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vector_sync_refused: unknown_purge_target' USING ERRCODE = '22023';
  END IF;
  IF v_status = 'pending' THEN
    RETURN false;
  END IF;
  UPDATE public.vector_sync_purge_targets pt
     SET status = 'pending', collections_checked = NULL, points_deleted = NULL, completed_at = NULL
   WHERE pt.purge_id = p_purge_id AND pt.target = p_target;
  INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key, profile_id)
  SELECT p_target, 'purge', p_purge_id::text, v_key, NULL
   WHERE NOT EXISTS (
     SELECT 1 FROM public.vector_sync_outbox o
      WHERE o.target = p_target AND o.entity = 'purge' AND o.entity_id = p_purge_id::text
        AND o.status = 'pending' AND o.attempts = 0 AND o.cursor IS NULL
   );
  RETURN true;
END
$$;

-- Bounded `chunk` repair rows for one target and tenant (the forced source-of-truth recheck of plan 07-37). Goes through
-- rag_vector_sync_enqueue, so a disabled target writes nothing and ids that already wait untried are skipped. Never marks index
-- state stale: an outbox that has not drained yet drops the same ids in normal operation.
CREATE OR REPLACE FUNCTION public.rag_vector_sync_enqueue_stale(p_target text, p_tenant_key text, p_chunk_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_ids text[];
  v_count integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_target IS NULL OR p_target NOT IN ('weaviate', 'qdrant') THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_target' USING ERRCODE = '22023';
  END IF;
  IF p_chunk_ids IS NULL OR pg_catalog.cardinality(p_chunk_ids) NOT BETWEEN 1 AND 200
     OR pg_catalog.array_position(p_chunk_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'vector_sync_refused: invalid_chunk_ids' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.document_chunks c WHERE c.id = ANY (p_chunk_ids) AND c.tenant_key IS DISTINCT FROM p_tenant_key
  ) THEN
    RAISE EXCEPTION 'vector_sync_refused: tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT u.id::text ORDER BY u.id::text) INTO v_ids FROM unnest(p_chunk_ids) AS u(id);
  v_count := pg_catalog.cardinality(v_ids);
  RETURN public.rag_vector_sync_enqueue(
    'chunk',
    v_ids,
    pg_catalog.array_fill(p_tenant_key, ARRAY[v_count]),
    pg_catalog.array_fill(NULL::text, ARRAY[v_count]),
    p_target
  );
END
$$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_enqueue_purge(text, uuid, uuid[], text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_purge_row(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_purge_complete(uuid, text, integer, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_purge_status(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_purged_documents(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_purge_reopen(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_enqueue_stale(text, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_enqueue_purge(text, uuid, uuid[], text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_purge_row(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_purge_complete(uuid, text, integer, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_purge_status(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_purged_documents(text, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_purge_reopen(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_enqueue_stale(text, text, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
