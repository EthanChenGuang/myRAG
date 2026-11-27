-- 0721: Phase 6.3 source reconcile runs and admin connection functions (D-07, D-09, D-31, D-33, D-41, D-43).
-- rag_source_reconcile_runs is the ledger of full-listing reconciles, change-feed batches and paused mass removals.
-- It stores counts, fixed status and error words and candidate source file ids, never file names, titles or text.
-- A paused run (awaiting_confirmation) can be confirmed by an admin of its tenant for 24 hours; after that it is refused
-- with confirmation_expired and recorded as expired. Only a completed run of origin sync or scheduled advances
-- nango_connections.last_full_reconcile_at. rag_nango_owner_tenant_key(uuid) is defined per mode in the two 0721 mode files.
-- Server role only: RLS on, no policies, service_role reads the table and writes only through these functions.
-- Additive and idempotent; not folded into the setup files.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_source_reconcile_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.nango_connections(id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  origin text NOT NULL,
  status text NOT NULL,
  listed_count integer,
  total_count integer,
  candidate_count integer NOT NULL DEFAULT 0,
  candidate_file_ids text[] NOT NULL DEFAULT '{}'::text[],
  removed_count integer,
  failed_count integer,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  CONSTRAINT rag_source_reconcile_runs_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_source_reconcile_runs_origin_check CHECK (origin IN ('sync', 'scheduled', 'change_feed', 'admin')),
  CONSTRAINT rag_source_reconcile_runs_status_check CHECK (
    status IN ('completed', 'incomplete', 'failed', 'awaiting_confirmation', 'confirmed', 'dismissed', 'expired')
  ),
  CONSTRAINT rag_source_reconcile_runs_counts_check CHECK (
    (listed_count IS NULL OR listed_count >= 0)
    AND (total_count IS NULL OR total_count >= 0)
    AND candidate_count >= 0
    AND (removed_count IS NULL OR removed_count >= 0)
    AND (failed_count IS NULL OR failed_count >= 0)
  ),
  CONSTRAINT rag_source_reconcile_runs_candidates_cap CHECK (cardinality(candidate_file_ids) <= 2000),
  CONSTRAINT rag_source_reconcile_runs_error_code_length CHECK (error_code IS NULL OR length(error_code) <= 64),
  CONSTRAINT rag_source_reconcile_runs_expiry_check CHECK (status <> 'awaiting_confirmation' OR expires_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS rag_source_reconcile_runs_connection_idx
  ON public.rag_source_reconcile_runs (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rag_source_reconcile_runs_awaiting_idx
  ON public.rag_source_reconcile_runs (tenant_key, expires_at)
  WHERE status = 'awaiting_confirmation';

ALTER TABLE public.rag_source_reconcile_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rag_source_reconcile_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.rag_source_reconcile_runs TO service_role;

-- Records one run for a connection. The tenant key is checked by the ingest guard and must be the connection owner's key.
CREATE OR REPLACE FUNCTION public.rag_source_reconcile_run_record(
  p_tenant_key text,
  p_connection_id uuid,
  p_origin text,
  p_status text,
  p_counts jsonb,
  p_candidate_file_ids text[]
)
RETURNS TABLE (run_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_counts jsonb := COALESCE(p_counts, '{}'::jsonb);
  v_ids text[] := COALESCE(p_candidate_file_ids, '{}'::text[]);
  v_owner uuid;
  v_listed integer;
  v_total integer;
  v_candidates integer;
  v_error text;
  v_key text;
  v_run uuid;
  v_created timestamptz := now();
  v_expires timestamptz;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_connection_id IS NULL
     OR p_origin IS NULL OR p_origin NOT IN ('sync', 'scheduled', 'change_feed', 'admin')
     OR p_status IS NULL OR p_status NOT IN ('completed', 'incomplete', 'failed', 'awaiting_confirmation')
     OR jsonb_typeof(v_counts) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['listed', 'total', 'candidates'] LOOP
    IF v_counts ? v_key AND (
      jsonb_typeof(v_counts -> v_key) <> 'number'
      OR (v_counts ->> v_key) !~ '^[0-9]{1,9}$'
    ) THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF v_counts ? 'error_code' AND (
    jsonb_typeof(v_counts -> 'error_code') <> 'string'
    OR (v_counts ->> 'error_code') !~ '^[a-z0-9_]{1,64}$'
  ) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 2000 OR EXISTS (
    SELECT 1 FROM unnest(v_ids) AS f(file_id) WHERE f.file_id IS NULL OR f.file_id = '' OR length(f.file_id) > 512
  ) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT c.user_id INTO v_owner FROM public.nango_connections c WHERE c.id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF public.rag_nango_owner_tenant_key(v_owner) IS DISTINCT FROM p_tenant_key THEN
    RAISE EXCEPTION 'tenant_mismatch';
  END IF;

  v_listed := (v_counts ->> 'listed')::integer;
  v_total := (v_counts ->> 'total')::integer;
  v_candidates := COALESCE((v_counts ->> 'candidates')::integer, cardinality(v_ids));
  v_error := v_counts ->> 'error_code';
  IF p_status = 'awaiting_confirmation' THEN
    v_expires := v_created + interval '24 hours';
  END IF;

  UPDATE public.rag_source_reconcile_runs r
     SET status = 'expired'
   WHERE r.connection_id = p_connection_id AND r.status = 'awaiting_confirmation' AND r.expires_at <= now();

  INSERT INTO public.rag_source_reconcile_runs (
    connection_id, tenant_key, origin, status, listed_count, total_count, candidate_count,
    candidate_file_ids, error_code, created_at, expires_at
  ) VALUES (
    p_connection_id, p_tenant_key, p_origin, p_status, v_listed, v_total, v_candidates,
    v_ids, v_error, v_created, v_expires
  )
  RETURNING id INTO v_run;

  IF p_status = 'completed' AND p_origin IN ('sync', 'scheduled') THEN
    UPDATE public.nango_connections c
       SET last_full_reconcile_at = now(), last_reconcile_status = 'ok'
     WHERE c.id = p_connection_id;
  ELSIF p_status IN ('incomplete', 'failed') THEN
    UPDATE public.nango_connections c
       SET last_reconcile_status = p_status
     WHERE c.id = p_connection_id;
  ELSIF p_status = 'awaiting_confirmation' THEN
    UPDATE public.nango_connections c
       SET last_reconcile_status = 'paused'
     WHERE c.id = p_connection_id;
  END IF;

  RETURN QUERY SELECT v_run, v_expires;
END;
$$;

-- Confirms or dismisses a paused run for an admin of its tenant. Unknown and foreign runs answer the same not_found.
-- A confirmation after expires_at raises confirmation_expired; that refusal rolls back its own statement, so the run is
-- recorded as expired by the next run_record of the connection, the next admin connection read, or a dismiss.
CREATE OR REPLACE FUNCTION public.rag_source_reconcile_run_decide(
  p_actor uuid,
  p_run_id uuid,
  p_decision text
)
RETURNS TABLE (
  run_id uuid,
  connection_id uuid,
  owner_user_id uuid,
  tenant_key text,
  status text,
  candidate_file_ids text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
  v_run public.rag_source_reconcile_runs%ROWTYPE;
  v_owner uuid;
BEGIN
  IF p_run_id IS NULL OR p_decision IS NULL OR p_decision NOT IN ('confirm', 'dismiss') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  keys := public.rag_admin_tenant_keys(p_actor);

  SELECT r.* INTO v_run
    FROM public.rag_source_reconcile_runs r
    JOIN public.nango_connections c ON c.id = r.connection_id
   WHERE r.id = p_run_id
     AND r.tenant_key = ANY (keys)
     AND public.rag_nango_owner_tenant_key(c.user_id) = r.tenant_key
   FOR UPDATE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_run.status <> 'awaiting_confirmation' THEN
    RAISE EXCEPTION 'run_not_pending';
  END IF;
  SELECT c.user_id INTO v_owner FROM public.nango_connections c WHERE c.id = v_run.connection_id;

  IF v_run.expires_at <= now() THEN
    IF p_decision = 'confirm' THEN
      RAISE EXCEPTION 'confirmation_expired';
    END IF;
    UPDATE public.rag_source_reconcile_runs r SET status = 'expired' WHERE r.id = v_run.id;
    RETURN QUERY SELECT v_run.id, v_run.connection_id, v_owner, v_run.tenant_key, 'expired'::text, '{}'::text[];
    RETURN;
  END IF;

  IF p_decision = 'confirm' THEN
    UPDATE public.rag_source_reconcile_runs r
       SET status = 'confirmed', decided_by = p_actor, decided_at = now()
     WHERE r.id = v_run.id;
    RETURN QUERY SELECT v_run.id, v_run.connection_id, v_owner, v_run.tenant_key, 'confirmed'::text, v_run.candidate_file_ids;
  ELSE
    UPDATE public.rag_source_reconcile_runs r
       SET status = 'dismissed', decided_by = p_actor, decided_at = now()
     WHERE r.id = v_run.id;
    RETURN QUERY SELECT v_run.id, v_run.connection_id, v_owner, v_run.tenant_key, 'dismissed'::text, '{}'::text[];
  END IF;
END;
$$;

-- Stores the outcome of a confirmed run once; the connection returns to ok when nothing failed.
CREATE OR REPLACE FUNCTION public.rag_source_reconcile_run_finish(
  p_run_id uuid,
  p_removed integer,
  p_failed integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_run public.rag_source_reconcile_runs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_removed IS NULL OR p_failed IS NULL OR p_removed < 0 OR p_failed < 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT r.* INTO v_run FROM public.rag_source_reconcile_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  PERFORM public.rag_ingest_assert_tenant_key(v_run.tenant_key);
  IF v_run.status <> 'confirmed' OR v_run.removed_count IS NOT NULL THEN
    RAISE EXCEPTION 'run_not_pending';
  END IF;

  UPDATE public.rag_source_reconcile_runs r
     SET removed_count = p_removed, failed_count = p_failed
   WHERE r.id = v_run.id;
  IF p_failed = 0 THEN
    UPDATE public.nango_connections c SET last_reconcile_status = 'ok' WHERE c.id = v_run.connection_id;
  END IF;
END;
$$;

-- The connections of the admin's tenants with their reconcile state and the newest unexpired paused run.
CREATE OR REPLACE FUNCTION public.rag_source_sync_admin_connections(
  p_actor uuid,
  p_limit integer,
  p_offset integer
)
RETURNS TABLE (
  connection_id uuid,
  provider text,
  owner_user_id uuid,
  tenant_key text,
  status text,
  connected_at timestamptz,
  last_full_reconcile_at timestamptz,
  last_reconcile_status text,
  deletion_mode text,
  document_count bigint,
  awaiting_run_id uuid,
  awaiting_created_at timestamptz,
  awaiting_expires_at timestamptz,
  awaiting_candidate_count integer,
  awaiting_total_count integer,
  total_rows bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  keys := public.rag_admin_tenant_keys(p_actor);

  UPDATE public.rag_source_reconcile_runs r
     SET status = 'expired'
   WHERE r.status = 'awaiting_confirmation' AND r.expires_at <= now() AND r.tenant_key = ANY (keys);

  RETURN QUERY
  WITH owned AS (
    SELECT c.*, public.rag_nango_owner_tenant_key(c.user_id) AS owner_key
      FROM public.nango_connections c
  )
  SELECT
    o.id,
    o.provider,
    o.user_id,
    o.owner_key,
    o.status,
    o.connected_at,
    o.last_full_reconcile_at,
    o.last_reconcile_status,
    o.deletion_mode,
    (SELECT count(*) FROM public.documents d
      WHERE d.tenant_key = o.owner_key AND d.source = 'nango'
        AND d.source_connection_id = o.connection_id AND d.is_current),
    w.id,
    w.created_at,
    w.expires_at,
    w.candidate_count,
    w.total_count,
    count(*) OVER ()
  FROM owned o
  LEFT JOIN LATERAL (
    SELECT r.id, r.created_at, r.expires_at, r.candidate_count, r.total_count
      FROM public.rag_source_reconcile_runs r
     WHERE r.connection_id = o.id AND r.tenant_key = o.owner_key AND r.status = 'awaiting_confirmation'
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 1
  ) w ON true
  WHERE o.owner_key = ANY (keys)
  ORDER BY o.connected_at DESC NULLS LAST, o.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

-- Sets the deletion mode (NULL, soft or purge) of one connection of the admin's tenants; future deletions only.
CREATE OR REPLACE FUNCTION public.rag_source_sync_set_deletion_mode(
  p_actor uuid,
  p_connection_id uuid,
  p_mode text
)
RETURNS TABLE (connection_id uuid, deletion_mode text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
  v_id uuid;
BEGIN
  IF p_connection_id IS NULL OR (p_mode IS NOT NULL AND p_mode NOT IN ('soft', 'purge')) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  keys := public.rag_admin_tenant_keys(p_actor);

  UPDATE public.nango_connections c
     SET deletion_mode = p_mode
   WHERE c.id = p_connection_id
     AND public.rag_nango_owner_tenant_key(c.user_id) = ANY (keys)
  RETURNING c.id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  RETURN QUERY SELECT v_id, p_mode;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_source_reconcile_run_record(text, uuid, text, text, jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_source_reconcile_run_decide(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_source_reconcile_run_finish(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_source_sync_admin_connections(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_source_sync_set_deletion_mode(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_source_reconcile_run_record(text, uuid, text, text, jsonb, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_source_reconcile_run_decide(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_source_reconcile_run_finish(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_source_sync_admin_connections(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_source_sync_set_deletion_mode(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
