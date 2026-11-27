-- Train 34 live SQL (ci/merge-train-34). Apply after train 33 is live. Multi-tenant production.
-- NOTE (post-apply 2026-11-27): 0740_vector_sync_purge also drops and re-adds the vector_sync_outbox_entity_check constraint.
-- Order: 0708, 0709, 0740, 0920 (common), 0920 (multi-tenant), then the 0410 r17 delta (grants only).
-- DROP sections (all IF EXISTS, followed by a re-create in the same file):
--   0708: DROP FUNCTION IF EXISTS public.rag_vector_sync_status()  (re-created)
--   0709: DROP FUNCTION IF EXISTS public.rag_backend_index_state_counts()  (re-created)
--   0920: DROP TRIGGER IF EXISTS rag_access_groups_immutable_key / rag_connector_group_map_same_tenant; DROP POLICY IF EXISTS rag_access_group_members_select_own (re-created)
--   0920 multi-tenant: DROP TRIGGER IF EXISTS rag_access_group_members_require_org_member / rag_access_groups_on_org_member_delete (re-created)
-- supabase/optional/vector-sync-schedule.sql is optional and not included.

-- ==== supabase/migrations/0708_vector_sync_status.sql
-- 0708: Phase 7 vector sync status read (D-04, D-24).
-- rag_vector_sync_status returns one row per target: the enabled flag, the pending, leased and dead outbox counts and the age in
-- seconds of the oldest pending row (null when none). It returns counts only, never a tenant key, entity id or error text.
-- The CLI status command and the post-response kick's cached "is any target enabled" read both call it.
-- SECURITY INVOKER, search_path '', service role only. Idempotent: safe to run more than once.

BEGIN;

DROP FUNCTION IF EXISTS public.rag_vector_sync_status();

CREATE FUNCTION public.rag_vector_sync_status()
RETURNS TABLE (target text, enabled boolean, pending bigint, leased bigint, dead bigint, oldest_pending_seconds integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT t.target,
         t.enabled,
         (SELECT pg_catalog.count(*) FROM public.vector_sync_outbox o WHERE o.target = t.target AND o.status = 'pending'),
         (SELECT pg_catalog.count(*) FROM public.vector_sync_outbox o WHERE o.target = t.target AND o.status = 'leased'),
         (SELECT pg_catalog.count(*) FROM public.vector_sync_outbox o WHERE o.target = t.target AND o.status = 'dead'),
         (SELECT pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now() - pg_catalog.min(o.enqueued_at)))::integer
            FROM public.vector_sync_outbox o
           WHERE o.target = t.target AND o.status = 'pending')
    FROM public.rag_vector_sync_targets t
   ORDER BY t.target;
$fn$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_status() TO service_role;

COMMIT;

-- ==== supabase/migrations/0709_backend_index_state_counts.sql
-- 0709: Phase 7 index-state counts for the admin index-compatibility warning (D-16, RET-09).
-- rag_backend_index_state_counts returns one row per (target, profile, state) with the number of tenants in that state. It returns
-- counts only, never a tenant key, a count of chunks or an error text, so the admin route can show readiness without tenant data.
-- SECURITY INVOKER, search_path '', service role only. Idempotent: safe to run more than once.

BEGIN;

DROP FUNCTION IF EXISTS public.rag_backend_index_state_counts();

CREATE FUNCTION public.rag_backend_index_state_counts()
RETURNS TABLE (target text, profile_id text, state text, tenants bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT s.target, s.profile_id, s.state, pg_catalog.count(*)
    FROM public.rag_backend_index_state s
   GROUP BY s.target, s.profile_id, s.state
   ORDER BY s.target, s.profile_id, s.state;
$fn$;

REVOKE ALL ON FUNCTION public.rag_backend_index_state_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_backend_index_state_counts() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0740_vector_sync_purge.sql
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

-- ==== supabase/migrations/0920_access_groups_tables.sql
-- 0920: document access group stores (Phase 4.3, SEC-12, SEC-13, DATA-22; D-01, D-04, D-20, D-26, A-03, A-07).
-- rag_access_groups and rag_access_group_members: a group belongs to exactly one tenant (the tenant columns come from the mode files);
-- the key matches ^[a-z0-9][a-z0-9-]{0,62}$, is never 'all' and cannot change after insert. rag_access_group_settings holds one row with
-- enforced false (A-03: the app writes it from RAG_DOC_ACCESS_GROUPS at startup). rag_connector_group_map, rag_connector_sharing_rules
-- (created off) and rag_connector_document_principals hold the connector permission mapping (D-20); principals are groups, teams,
-- workspaces, domains and link kinds, never a person. rag_access_security_events (D-26) and rag_access_audit (A-07) hold ids, arrays and
-- codes only, with no content column; audit rows carry no foreign keys, so they outlive deletes. rag_admin_audit is unchanged.
-- The D-26 store is named rag_access_security_events because Phase 5.2 (0942) already owns public.rag_security_events with another shape.
-- Access: RLS on everywhere; every privilege revoked from PUBLIC, anon and authenticated; service_role reads and writes; the one client
-- policy is rag_access_group_members_select_own (an authenticated user reads their own membership rows). Trigger functions are
-- SECURITY INVOKER with SET search_path = '' and service_role execute only. Not folded into the setup files. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_access_groups (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT rag_access_groups_key_check CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT rag_access_groups_key_reserved_check CHECK (key <> 'all'),
  CONSTRAINT rag_access_groups_name_check CHECK (pg_catalog.char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT rag_access_groups_source_check CHECK (source IN ('manual', 'connector'))
);

CREATE OR REPLACE FUNCTION public.rag_access_groups_immutable_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'access_group_key_immutable' USING ERRCODE = '22023';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) -> 'organization_id') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) -> 'organization_id') THEN
    RAISE EXCEPTION 'access_group_tenant_immutable' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_immutable_key() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_immutable_key() TO service_role;

DROP TRIGGER IF EXISTS rag_access_groups_immutable_key ON public.rag_access_groups;
CREATE TRIGGER rag_access_groups_immutable_key
  BEFORE UPDATE ON public.rag_access_groups
  FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_immutable_key();

CREATE TABLE IF NOT EXISTS public.rag_access_group_members (
  group_id uuid NOT NULL REFERENCES public.rag_access_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  source text NOT NULL DEFAULT 'manual',
  PRIMARY KEY (user_id, group_id),
  CONSTRAINT rag_access_group_members_source_check CHECK (source IN ('manual', 'connector'))
);

CREATE INDEX IF NOT EXISTS rag_access_group_members_group_idx ON public.rag_access_group_members (group_id);

CREATE TABLE IF NOT EXISTS public.rag_access_group_settings (
  id boolean PRIMARY KEY DEFAULT true,
  enforced boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid,
  CONSTRAINT rag_access_group_settings_single_row CHECK (id)
);

INSERT INTO public.rag_access_group_settings (id, enforced) VALUES (true, false) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.rag_connector_group_map (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  provider text NOT NULL,
  external_principal_id text NOT NULL,
  kind text NOT NULL,
  group_id uuid NOT NULL REFERENCES public.rag_access_groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid,
  CONSTRAINT rag_connector_group_map_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_connector_group_map_provider_check CHECK (provider IN ('google-drive', 'dropbox', 'notion')),
  CONSTRAINT rag_connector_group_map_kind_check CHECK (kind IN ('group', 'team', 'workspace')),
  CONSTRAINT rag_connector_group_map_principal_check CHECK (pg_catalog.char_length(external_principal_id) BETWEEN 1 AND 512),
  CONSTRAINT rag_connector_group_map_principal_key UNIQUE (tenant_key, provider, external_principal_id)
);

CREATE INDEX IF NOT EXISTS rag_connector_group_map_group_idx ON public.rag_connector_group_map (group_id);

CREATE OR REPLACE FUNCTION public.rag_connector_group_map_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_group_tenant text;
BEGIN
  SELECT g.tenant_key INTO v_group_tenant FROM public.rag_access_groups g WHERE g.id = NEW.group_id;
  IF v_group_tenant IS NULL OR v_group_tenant IS DISTINCT FROM NEW.tenant_key THEN
    RAISE EXCEPTION 'cross_tenant_group' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_group_map_same_tenant() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_group_map_same_tenant() TO service_role;

DROP TRIGGER IF EXISTS rag_connector_group_map_same_tenant ON public.rag_connector_group_map;
CREATE TRIGGER rag_connector_group_map_same_tenant
  BEFORE INSERT OR UPDATE OF tenant_key, group_id ON public.rag_connector_group_map
  FOR EACH ROW EXECUTE FUNCTION public.rag_connector_group_map_same_tenant();

CREATE TABLE IF NOT EXISTS public.rag_connector_sharing_rules (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL,
  domain text,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid,
  CONSTRAINT rag_connector_sharing_rules_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_connector_sharing_rules_provider_check CHECK (provider IN ('google-drive', 'dropbox', 'notion')),
  CONSTRAINT rag_connector_sharing_rules_kind_check CHECK (kind IN ('domain', 'anyone', 'public')),
  CONSTRAINT rag_connector_sharing_rules_domain_check CHECK (
    (kind = 'domain' AND domain IS NOT NULL AND pg_catalog.char_length(domain) <= 253
      AND domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
    OR (kind <> 'domain' AND domain IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_connector_sharing_rules_unique_idx
  ON public.rag_connector_sharing_rules (tenant_key, provider, kind, COALESCE(domain, ''));

CREATE TABLE IF NOT EXISTS public.rag_connector_document_principals (
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL,
  external_principal_id text NOT NULL DEFAULT '',
  mapped boolean NOT NULL DEFAULT false,
  seen_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (document_id, provider, kind, external_principal_id),
  CONSTRAINT rag_connector_document_principals_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_connector_document_principals_provider_check CHECK (provider IN ('google-drive', 'dropbox', 'notion')),
  CONSTRAINT rag_connector_document_principals_kind_check
    CHECK (kind IN ('group', 'team', 'workspace', 'domain', 'anyone', 'public')),
  CONSTRAINT rag_connector_document_principals_principal_check CHECK (pg_catalog.char_length(external_principal_id) <= 512)
);

CREATE INDEX IF NOT EXISTS rag_connector_document_principals_lookup_idx
  ON public.rag_connector_document_principals (tenant_key, provider, kind, external_principal_id);

CREATE TABLE IF NOT EXISTS public.rag_access_security_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event text NOT NULL,
  chunk_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  document_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  request_id text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_access_security_events_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_access_security_events_event_check CHECK (event IN ('citation_access_violation')),
  CONSTRAINT rag_access_security_events_ids_check
    CHECK (pg_catalog.cardinality(chunk_ids) <= 1000 AND pg_catalog.cardinality(document_ids) <= 1000),
  CONSTRAINT rag_access_security_events_request_id_check CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9_.:-]{1,200}$')
);

CREATE INDEX IF NOT EXISTS rag_access_security_events_tenant_created_idx
  ON public.rag_access_security_events (tenant_key, created_at);

CREATE TABLE IF NOT EXISTS public.rag_access_audit (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  action text NOT NULL,
  actor uuid,
  actor_kind text NOT NULL,
  group_id uuid,
  document_id uuid,
  lineage_id uuid,
  before_groups text[],
  after_groups text[],
  reason text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_access_audit_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_access_audit_action_check CHECK (action IN (
    'group_create', 'group_rename', 'group_delete', 'member_add', 'member_remove', 'document_set', 'document_fallback',
    'connector_map_set', 'connector_map_delete', 'sharing_rule_set', 'enforcement_set'
  )),
  CONSTRAINT rag_access_audit_actor_kind_check CHECK (actor_kind IN ('admin', 'connector', 'system')),
  CONSTRAINT rag_access_audit_reason_check CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$')
);

CREATE INDEX IF NOT EXISTS rag_access_audit_tenant_created_idx ON public.rag_access_audit (tenant_key, created_at);

ALTER TABLE public.rag_access_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_access_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_access_group_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_connector_group_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_connector_sharing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_connector_document_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_access_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_access_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_access_groups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_access_group_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_access_group_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_connector_group_map FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_connector_sharing_rules FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_connector_document_principals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_access_security_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_access_audit FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.rag_access_security_events FROM service_role;
REVOKE ALL ON TABLE public.rag_access_audit FROM service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_access_groups TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_access_group_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_access_group_settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_connector_group_map TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_connector_sharing_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_connector_document_principals TO service_role;
GRANT SELECT, INSERT ON TABLE public.rag_access_security_events TO service_role;
GRANT SELECT, INSERT ON TABLE public.rag_access_audit TO service_role;

GRANT SELECT ON TABLE public.rag_access_group_members TO authenticated;

DROP POLICY IF EXISTS rag_access_group_members_select_own ON public.rag_access_group_members;
CREATE POLICY rag_access_group_members_select_own ON public.rag_access_group_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0920_access_groups_tables.multi-tenant.sql
-- 0920 (multi-tenant): a group belongs to one organization. organization_id is NOT NULL with a cascading foreign key to organizations;
-- tenant_key is generated as o:<organization_id>, the same expression as documents.tenant_key and scopeKey(); (tenant_key, key) is unique
-- (D-01). A member insert is refused with not_a_workspace_member unless the user has an organization_members row of the group's
-- organization; deleting that organization_members row removes the user's memberships in that organization's groups (D-04, RESEARCH 4).
-- rag_access_group_members_require_org_member is SECURITY INVOKER (members are written by service_role only);
-- rag_access_groups_on_org_member_delete is SECURITY DEFINER because the role that deletes an organization_members row may not read the
-- group tables. Both have SET search_path = '' and service_role execute only. Idempotent.

BEGIN;

ALTER TABLE public.rag_access_groups ADD COLUMN IF NOT EXISTS organization_id uuid NOT NULL;
ALTER TABLE public.rag_access_groups ADD COLUMN IF NOT EXISTS tenant_key text GENERATED ALWAYS AS ('o:' || organization_id::text) STORED;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_access_groups'::regclass AND conname = 'rag_access_groups_organization_id_fkey'
  ) THEN
    ALTER TABLE public.rag_access_groups
      ADD CONSTRAINT rag_access_groups_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_access_groups'::regclass AND conname = 'rag_access_groups_tenant_key_key'
  ) THEN
    ALTER TABLE public.rag_access_groups
      ADD CONSTRAINT rag_access_groups_tenant_key_key UNIQUE (tenant_key, key);
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS rag_access_groups_organization_idx ON public.rag_access_groups (organization_id);

CREATE OR REPLACE FUNCTION public.rag_access_group_members_require_org_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.rag_access_groups g
    JOIN public.organization_members m ON m.organization_id = g.organization_id
    WHERE g.id = NEW.group_id AND m.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'not_a_workspace_member' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_members_require_org_member() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_members_require_org_member() TO service_role;

DROP TRIGGER IF EXISTS rag_access_group_members_require_org_member ON public.rag_access_group_members;
CREATE TRIGGER rag_access_group_members_require_org_member
  BEFORE INSERT OR UPDATE OF group_id, user_id ON public.rag_access_group_members
  FOR EACH ROW EXECUTE FUNCTION public.rag_access_group_members_require_org_member();

CREATE OR REPLACE FUNCTION public.rag_access_groups_on_org_member_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM public.rag_access_group_members gm
  USING public.rag_access_groups g
  WHERE gm.group_id = g.id
    AND g.organization_id = OLD.organization_id
    AND gm.user_id = OLD.user_id;
  RETURN OLD;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_on_org_member_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_on_org_member_delete() TO service_role;

DROP TRIGGER IF EXISTS rag_access_groups_on_org_member_delete ON public.organization_members;
CREATE TRIGGER rag_access_groups_on_org_member_delete
  AFTER DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_on_org_member_delete();

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0410 r17 delta (the lines train 34 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
DO $r17$
BEGIN
  IF to_regprocedure('public.rag_access_groups_on_org_member_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_on_org_member_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_on_org_member_delete() TO service_role;
  END IF;
END
$r17$;
