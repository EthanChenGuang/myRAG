-- Train 41 live SQL (ci/merge-train-41). Apply after train 40 is live (its SQL, including 0723, 0724, 0726, 0727, 0740, 0741, 0986,
-- 0988 and 1010, plus its 0410 delta). Multi-tenant production: this file carries the multi-tenant variant of 0721; a single-tenant
-- deployment runs supabase/migrations/0721_source_reconcile_runs.single-tenant.sql in its place.
-- Order: 0720, 0721 (common), 0721 (multi-tenant), 0722, 0728, 0937, 0987, 0990, 1011, then the 0410 r23 delta (grants only).
-- Migration numbers (check-migration-numbers passes on the train): 07xx = Phase 6.3; 0986 doc-types, 0987 scope-access,
-- 0988 review-writers, 0990 rih, 1011 q33; 0937 is quick-32-batch (Phase 3.2 column guard; 0936 stays reserved for 04.2-40). 0989 (NF-1, fix/nf1-shared-chats-rls) and 0991 (UF-1, fix/uf1-direct-insert) are
-- reserved but not in this train.
-- Dependencies: 0720 alters nango_connections and documents (nullable columns, no default, no backfill). 0721 needs 0720
-- (deletion_mode, last_full_reconcile_at) and rag_assert_tenant_key; its common functions call rag_nango_owner_tenant_key, which
-- the mode file defines (plpgsql, bound at call time). 0722 needs nango_connections. 0728 lists the stores of every earlier
-- phase (the 06.3 purge of 0726/0727 calls it). 0937 attaches the 0320 guard function (rag_guard_ingest_state) to the
-- Phase 3.2 columns of 0801 on documents and document_chunks; no new function. 0987 rebases rag_scope_centroids_rebuild and the update triggers on 0983 and reads
-- rag_access_enforced (0922) and rag_access_group_settings (0920). 0990 needs 0534, 0934, 0984 and 0986 (train 40). 1011 needs
-- 1001, 1005 and 1006.
-- Re-run rules: after re-running 0934, 0984 or 0986, re-run 0990 and then 0410. After re-running 0983, re-run 0987.
-- 0410 is not re-run here: the delta below repeats only the guarded lines train 41 adds to it (r23).
-- Changes to older migration files in this train need no live run: 0425, 0440 and 0863 changed only in comments; 0944, 0950, 0967
-- and 0974 only add guards that matter when those files are re-run on top of 0984 (they drop the 4-argument
-- rag_enqueue_review_item again, which 0984 already replaced live).
-- DEPLOY CAUTION (06.3-09, app side, not SQL): the Nango webhook now requires the X-Nango-Hmac-Sha256 header and NANGO_WEBHOOK_SECRET;
-- a delivery that carries only the legacy signature header gets 401. A legacy sync.success event no longer starts a full sync. Set
-- NANGO_WEBHOOK_SECRET (and the matching secret in Nango) in the production env before deploying the train-41 app.
-- App compatibility: every change is additive for the app on main. New columns are nullable; the new functions are only called by
-- the train-41 app; 0987 and 0990 keep the signatures of the functions they redefine. Apply this SQL before deploying the train-41 app.
-- DROP sections (each followed by a re-create in the same transaction):
--   0987: DROP TRIGGER IF EXISTS rag_scope_centroids_access_settings_{update,insert,delete} ON public.rag_access_group_settings
--         (new triggers; each is re-created right after).
--   0990: DROP TRIGGER IF EXISTS rag_review_items_fill_owner ON public.rag_review_items (new trigger) and
--         DROP POLICY IF EXISTS rag_review_items_access_sets ON public.rag_review_items (the 0934 restrictive policy, re-created
--         right after with NULL access_sets failing closed while access is enforced).
--   1011: DROP TRIGGER IF EXISTS rag_chunk_attribute_header_stamp_x_insert_guard ON public.document_chunks (new trigger, re-created).
--   0937: DROP TRIGGER IF EXISTS rag_guard_phase32_columns ON public.documents and ON public.document_chunks (new triggers, re-created).
--   0720, 0721, 0722, 0728 drop nothing.
-- Operational notes:
--   0990 backfills user_id and chat_id of existing rag_review_items from their retrieval log rows (same tenant only).
--   0987: with access groups enforced, a rebuild counts only {all}-labelled chunks; flipping the enforced flag clears every
--   tenant's centroids (they start empty while the scope gate is off).
--   0937: after the apply, a client role (owner or member through the table UPDATE policies) that changes a Phase 3.2 column
--   (language, fingerprint, hidden-text, scope, effective-date or approval columns) gets 42501; service-role writers are unchanged.
--   Everything else writes no existing row.

-- ==== supabase/migrations/0720_source_sync_columns.sql
-- 0720: Phase 6.3 source sync columns (D-02, D-07, D-08, D-44).
-- nango_connections gains the per-connection deletion mode and the reconcile state; documents gains what the last
-- sync saw of the source file. All columns are nullable with no default and no backfill: NULL keeps today's behaviour.
-- The nango_connections block is identical in both setup files, so this is one common file (D-44).
-- No file names or text are stored here. Additive and idempotent; not folded into the setup files.

BEGIN;

ALTER TABLE public.nango_connections ADD COLUMN IF NOT EXISTS deletion_mode text;
ALTER TABLE public.nango_connections ADD COLUMN IF NOT EXISTS last_full_reconcile_at timestamptz;
ALTER TABLE public.nango_connections ADD COLUMN IF NOT EXISTS last_reconcile_status text;

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS source_last_seen_at timestamptz;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS source_modified_at timestamptz;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS source_etag text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'nango_connections_deletion_mode_check' AND conrelid = 'public.nango_connections'::regclass
  ) THEN
    ALTER TABLE public.nango_connections
      ADD CONSTRAINT nango_connections_deletion_mode_check
      CHECK (deletion_mode IS NULL OR deletion_mode IN ('soft', 'purge'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'nango_connections_last_reconcile_status_check' AND conrelid = 'public.nango_connections'::regclass
  ) THEN
    ALTER TABLE public.nango_connections
      ADD CONSTRAINT nango_connections_last_reconcile_status_check
      CHECK (last_reconcile_status IS NULL OR last_reconcile_status IN ('ok', 'incomplete', 'failed', 'paused', 'overdue'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'documents_source_etag_length' AND conrelid = 'public.documents'::regclass
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_source_etag_length
      CHECK (source_etag IS NULL OR length(source_etag) <= 512);
  END IF;
END $$;

-- Reconcile and the admin connection list count the current documents of one connection.
CREATE INDEX IF NOT EXISTS documents_source_connection_current_idx
  ON public.documents (tenant_key, source, source_connection_id)
  WHERE is_current;

COMMIT;

-- ==== supabase/migrations/0721_source_reconcile_runs.sql
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

-- ==== supabase/migrations/0721_source_reconcile_runs.multi-tenant.sql
-- 0721 (multi-tenant): rag_nango_owner_tenant_key, the tenant key of a Nango connection owner's documents (D-41, D-43).
-- Matches scopeKey(nangoOwnerScope) in src/lib/rag/tenant/ingest-scope.ts; multi-tenant: a connection's documents are personal documents of its owner, u:<owner>.
-- Service role only. Idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_nango_owner_tenant_key(p_user_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN p_user_id IS NULL THEN NULL ELSE 'u:' || lower(p_user_id::text) END;
$$;

REVOKE ALL ON FUNCTION public.rag_nango_owner_tenant_key(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_nango_owner_tenant_key(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0722_source_delta_tokens.sql
-- 0722: Phase 6.3 change-feed cursor store (D-21, DATA-25).
-- rag_source_delta_tokens keeps one cursor per (connection, feed, feed_key): the Microsoft Graph @odata.deltaLink /
-- nextLink per drive (feed 'graph_delta', feed_key = drive id) and the Nango records cursor per model
-- (feed 'nango_records', feed_key = model). It never holds access tokens, file names or file content, only cursor URLs.
-- Server role only: RLS on, no policies, no client grants. Additive and idempotent; not folded into the setup files.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_source_delta_tokens (
  connection_id uuid NOT NULL REFERENCES public.nango_connections(id) ON DELETE CASCADE,
  feed text NOT NULL,
  feed_key text NOT NULL,
  delta_link text,
  next_link text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, feed, feed_key),
  CONSTRAINT rag_source_delta_tokens_feed_check CHECK (feed IN ('graph_delta', 'nango_records')),
  CONSTRAINT rag_source_delta_tokens_feed_key_length CHECK (length(feed_key) BETWEEN 1 AND 256),
  CONSTRAINT rag_source_delta_tokens_delta_link_length CHECK (delta_link IS NULL OR length(delta_link) <= 4096),
  CONSTRAINT rag_source_delta_tokens_next_link_length CHECK (next_link IS NULL OR length(next_link) <= 4096)
);

ALTER TABLE public.rag_source_delta_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rag_source_delta_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rag_source_delta_tokens TO service_role;

COMMIT;

-- ==== supabase/migrations/0728_purge_foreign_stores.sql
-- 0728: The purge store inventory, and guarded purge and verify steps for stores owned by other phases (DATA-24, D-11, D-14, D-17,
-- D-37, D-41). rag_purge_store_inventory() lists every public table that references documents, document_chunks or document_parents
-- (by foreign key, or by a document_id / chunk_id / lineage_id column), each marked purge_step, cascade or exempt with a reason;
-- tests/rag-db/purge-store-coverage.test.mts fails when a table found in the catalog is missing here, so a phase that lands a new store
-- adds its row (and a rag_purge_hook_<name>) in the same change. Additive and idempotent, not folded into the setup files.

BEGIN;

-- A fixed list: no table is read, so the function needs no definer rights.
CREATE OR REPLACE FUNCTION public.rag_purge_store_inventory()
RETURNS TABLE (relation text, store_id text, handling text, reason text)
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT v.relation, v.store_id, v.handling, v.reason
    FROM (VALUES
      ('documents', 'documents', 'purge_step', 'every version of the lineage is deleted by rag_purge_lineage (0727)'),
      ('document_chunks', 'chunks', 'purge_step', 'deleted explicitly by rag_purge_lineage; the single-tenant schema has no cascade'),
      ('ingestion_jobs', 'ingestion_jobs', 'purge_step', 'deleted by tenant and lineage or version id (0727)'),
      ('ingestion_jobs_archive', 'ingestion_jobs', 'purge_step', 'deleted by tenant and lineage or version id (0727)'),
      ('rag_parse_cache', 'parse_cache', 'purge_step', 'rows whose file hash no other lineage of the tenant shares are deleted (0727)'),
      ('rag_semantic_cache', 'semantic_cache', 'purge_step', 'invalidated by version id through rag_cache_invalidate (0727)'),
      ('rag_answer_records', 'answer_citations', 'purge_step', 'citation snapshots scrubbed by rag_purge_scrub_answer_records (0724)'),
      ('chats', 'chat_messages', 'purge_step', 'saved citations scrubbed by rag_purge_scrub_chats (0724)'),
      ('nango_sync_records', 'sync_records', 'purge_step', 'deleted by version id or connection and file id (0727)'),
      ('chunk_translations', 'translations', 'purge_step', 'rag_purge_hook_chunk_translations (0810) through rag_purge_foreign_stores'),
      ('chunk_translation_gaps', 'translation_gaps', 'purge_step', 'rag_purge_hook_chunk_translation_gaps (0820) through rag_purge_foreign_stores'),
      ('rag_table_rows', 'table_rows', 'purge_step', 'rag_purge_hook_table_rows (0852) through rag_purge_foreign_stores'),
      ('rag_dup_clusters', 'duplicate_groups', 'purge_step', 'rag_purge_hook_dup_clusters (0853) removes the members and marks the cluster for recompute'),
      ('rag_supersession_candidates', 'supersession', 'purge_step', 'rag_purge_hook_supersession (0806) through rag_purge_foreign_stores'),
      ('rag_supersession_links', 'supersession', 'purge_step', 'rag_purge_hook_supersession (0806) through rag_purge_foreign_stores'),
      ('rag_rebuild_items', 'rebuild', 'purge_step', 'rag_purge_hook_rebuild (0809) through rag_purge_foreign_stores'),
      ('rag_rebuild_saved_vectors', 'rebuild', 'purge_step', 'rag_purge_hook_rebuild (0809) through rag_purge_foreign_stores'),
      ('rag_recaption_items', 'recaption', 'purge_step', 'rag_purge_hook_recaption (0813) through rag_purge_foreign_stores'),
      ('chunk_embeddings', 'vectors', 'cascade', 'ON DELETE CASCADE from document_chunks; counted before the chunk delete'),
      ('embedding_backfill_gaps', 'vectors', 'cascade', 'ON DELETE CASCADE from document_chunks'),
      ('document_parents', 'parents', 'cascade', 'ON DELETE CASCADE from documents; counted before the delete'),
      ('chunking_build_gaps', 'chunks', 'cascade', 'ON DELETE CASCADE from documents'),
      ('chunk_translation_embeddings', 'translations', 'cascade', 'ON DELETE CASCADE from chunk_translations'),
      ('rag_golden_evidence_index', 'golden_items', 'purge_step', 'rag_purge_hook_golden_items (0976) through rag_purge_foreign_stores'),
      ('rag_judge_labels', 'golden_items', 'purge_step', 'answer-check labels of the purged evidence, cleared by rag_purge_hook_golden_items (0976)'),
      ('rag_connector_document_access', 'access_labels', 'cascade', 'ON DELETE CASCADE from documents (0925)'),
      ('rag_connector_document_principals', 'access_labels', 'cascade', 'ON DELETE CASCADE from documents (0920)'),
      ('rag_dup_chunk_bands', 'duplicate_groups', 'cascade', 'ON DELETE CASCADE from document_chunks (0857); the clusters are purged by rag_purge_hook_dup_clusters'),
      ('rag_purge_audit', '', 'exempt', 'the purge''s own record; ids and hashes only, kept on purpose as the tombstone record (D-12, D-35)'),
      ('rag_admin_audit', '', 'exempt', 'admin action log; ids only, no document content (D-37)'),
      ('rag_access_audit', '', 'exempt', 'access label and group change log (0920); ids, groups and reasons only, no document content (D-37)'),
      ('rag_access_security_events', '', 'exempt', 'access violation events (0920); tenant, user, chunk and document ids only, no content (D-37)'),
      ('rag_security_events', '', 'exempt', 'security finding events (0942); ids, rule ids and counts only, no content (D-37)'),
      ('vector_sync_purges', '', 'exempt', 'the purge''s own outbox record for external backends (0740); tenant, lineage and version ids only (D-45)'),
      ('vector_sync_outbox', '', 'exempt', 'ids only; the purge enqueues its own delete rows here for the external backends (D-45)'),
      ('chunking_build_runs', '', 'exempt', 'run cursor: one position id, no content; a resumed run skips missing rows (D-37)'),
      ('embedding_backfill_runs', '', 'exempt', 'run cursor: one position id, no content; a resumed run skips missing rows (D-37)'),
      ('rag_recaption_runs', '', 'exempt', 'run cursor: one position id, no content; a resumed run skips missing rows (D-37)'),
      ('rag_rebuild_runs', '', 'exempt', 'run header: counts and settings, no document content; its items are purged (D-37)'),
      ('rag_retrieval_log', '', 'exempt', 'ids only, 30 and 90 day retention'),
      ('rag_review_items', '', 'exempt', 'ids only, 30 and 90 day retention'),
      ('rag_upload_approval_exemptions', '', 'exempt', 'tenant and user configuration, not per-document data'),
      ('ingestion_batches', '', 'exempt', 'batch header and hold_publish flag, not per-document data'),
      ('rag_identifier_patterns', '', 'exempt', 'tenant settings, not per-document data')
    ) AS v(relation, store_id, handling, reason)
   ORDER BY v.relation
$$;

-- One step per store: the reserved hook name first, then the owner phase's hook, then (for plain per-document tables) a guarded delete
-- by tenant and version id. Every hook is resolved by its fixed signature; relation names are literals of this file (%I) and values are
-- bound with USING. A store with neither hook nor relation adds no key to the counts.
CREATE OR REPLACE FUNCTION public.rag_purge_foreign_stores(p_tenant_key text, p_lineage_id uuid, p_version_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[] := COALESCE(p_version_ids, '{}'::uuid[]);
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.to_regprocedure('public.rag_purge_hook_translations(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_translations($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translations', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regprocedure('public.rag_purge_hook_chunk_translations(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_chunk_translations($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translations', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regclass('public.chunk_translations') IS NOT NULL THEN
    EXECUTE pg_catalog.format('DELETE FROM %I.%I t WHERE t.tenant_key = $1 AND t.document_id = ANY ($2)', 'public', 'chunk_translations')
      USING p_tenant_key, v_ids;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translations', v_n);
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_chunk_translation_gaps(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_chunk_translation_gaps($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translation_gaps', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regclass('public.chunk_translation_gaps') IS NOT NULL THEN
    EXECUTE pg_catalog.format('DELETE FROM %I.%I t WHERE t.tenant_key = $1 AND t.document_id = ANY ($2)', 'public', 'chunk_translation_gaps')
      USING p_tenant_key, v_ids;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translation_gaps', v_n);
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_table_rows(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_table_rows($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('table_rows', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regclass('public.rag_table_rows') IS NOT NULL THEN
    EXECUTE pg_catalog.format('DELETE FROM %I.%I t WHERE t.tenant_key = $1 AND t.document_id = ANY ($2)', 'public', 'rag_table_rows')
      USING p_tenant_key, v_ids;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || pg_catalog.jsonb_build_object('table_rows', v_n);
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_duplicate_clusters(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_duplicate_clusters($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('duplicate_groups', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regprocedure('public.rag_purge_hook_dup_clusters(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_dup_clusters($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('duplicate_groups', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_supersession(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_supersession($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('supersession', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_rebuild(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_rebuild($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('rebuild', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_recaption(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_recaption($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('recaption', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_scope_tags(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_scope_tags($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('scope_tags', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_identifiers(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_identifiers($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('identifiers', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_golden_items(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_golden_items($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('golden_items', COALESCE(v_n, 0));
  END IF;

  RETURN v_counts;
END
$$;

-- Rows still present per foreign store, for rag_purge_verify. A store is reported only when its relation exists.
CREATE OR REPLACE FUNCTION public.rag_purge_foreign_leftovers(p_tenant_key text, p_lineage_id uuid, p_version_ids uuid[])
RETURNS TABLE (store text, remaining bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[] := COALESCE(p_version_ids, '{}'::uuid[]);
  v_step record;
  v_n bigint;
  v_total bigint;
  v_seen boolean;
  v_last text := NULL;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  FOR v_step IN
    SELECT * FROM (VALUES
      (1, 'translations', 'chunk_translations', 't.document_id = ANY ($2)'),
      (2, 'translation_gaps', 'chunk_translation_gaps', 't.document_id = ANY ($2)'),
      (3, 'table_rows', 'rag_table_rows', 't.document_id = ANY ($2)'),
      (4, 'duplicate_groups', 'rag_dup_clusters', 't.source_document_ids OPERATOR(pg_catalog.&&) $2'),
      (5, 'supersession', 'rag_supersession_candidates',
          't.document_id = ANY ($2) OR t.candidate_document_id = ANY ($2) OR t.older_document_id = ANY ($2)'),
      (6, 'supersession', 'rag_supersession_links',
          't.older_document_id = ANY ($2) OR t.newer_document_id = ANY ($2) OR t.older_lineage_id = $3 OR t.newer_lineage_id = $3'),
      (7, 'rebuild', 'rag_rebuild_items', 't.document_id = ANY ($2) OR t.new_document_id = ANY ($2) OR t.lineage_id = $3'),
      (8, 'rebuild', 'rag_rebuild_saved_vectors', 't.document_id = ANY ($2)'),
      (9, 'recaption', 'rag_recaption_items', 't.document_id = ANY ($2)')
    ) AS s(ord, store, relation, predicate)
    ORDER BY s.ord
  LOOP
    IF v_last IS DISTINCT FROM v_step.store THEN
      IF v_last IS NOT NULL AND v_seen THEN
        store := v_last;
        remaining := v_total;
        RETURN NEXT;
      END IF;
      v_last := v_step.store;
      v_total := 0;
      v_seen := false;
    END IF;
    IF pg_catalog.to_regclass(pg_catalog.format('public.%I', v_step.relation)) IS NOT NULL THEN
      EXECUTE pg_catalog.format('SELECT pg_catalog.count(*) FROM %I.%I t WHERE t.tenant_key = $1 AND (%s)', 'public', v_step.relation, v_step.predicate)
        INTO v_n USING p_tenant_key, v_ids, p_lineage_id;
      v_total := v_total + v_n;
      v_seen := true;
    END IF;
  END LOOP;
  IF v_last IS NOT NULL AND v_seen THEN
    store := v_last;
    remaining := v_total;
    RETURN NEXT;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.rag_purge_store_inventory() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_store_inventory() TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0937_phase32_column_guard.sql
-- 0937: client roles cannot change the Phase 3.2 columns through the tables (Phase 3.2 verification UF-2, SEC-09).
-- 0801 added language, fingerprint, hidden-text, scope, effective-date and approval columns to documents and document_chunks, but the 0320
-- guard lists only the Phase 3 ingest-state columns. With the table UPDATE policies a signed-in owner (single-tenant) or organization member
-- (multi-tenant) could PATCH scopes past the vocabulary check, set admin-only effective dates, forge the approval audit, or hide a document from
-- a rescan or rebuild by rewriting hidden_text_check or ingest_fingerprint. This file attaches the 0320 guard function to those columns under
-- its own trigger name, as 1001 does for the Phase 3.3 columns: a role other than service_role, postgres or supabase_admin that changes one of
-- them gets 42501. The writers, approval and admin paths run as service_role or as the owner of a SECURITY DEFINER function and pass.
-- No new function, so 0410 is unchanged. Idempotent (DROP TRIGGER IF EXISTS, then CREATE TRIGGER); both deployment modes; not folded into the
-- setup files.

BEGIN;

DO $phase32_guard_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_guard_ingest_state()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'ingest_fingerprint' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0937: apply 0320 and 0801 first' USING ERRCODE = '55000';
  END IF;
END
$phase32_guard_precheck$;

DROP TRIGGER IF EXISTS rag_guard_phase32_columns ON public.documents;
CREATE TRIGGER rag_guard_phase32_columns
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.rag_guard_ingest_state(
    'languages', 'ingest_fingerprint', 'hidden_text_check', 'scopes', 'effective_from', 'effective_to',
    'effective_dates_origin', 'effective_dates_confidence', 'approved_by', 'approved_at'
  );

DROP TRIGGER IF EXISTS rag_guard_phase32_columns ON public.document_chunks;
CREATE TRIGGER rag_guard_phase32_columns
  BEFORE UPDATE ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_guard_ingest_state(
    'language_confidence', 'scopes', 'effective_from', 'effective_to', 'approved_by'
  );

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0987_scope_centroids_access.sql
-- 0987: scope centroids honour access groups (Phase 6.2 verification R-4, QRY-14, SEC-12). While access groups are enforced
-- (rag_access_enforced()), rag_scope_centroids_rebuild counts a chunk only when both it and its document carry access_groups = {all}. A
-- restricted document therefore never moves a centroid, never creates a doc-type or scope-tag group key and never changes a member count,
-- so the in/out score of a member outside its group cannot reveal that it exists or what it is about. With enforcement off every member
-- counts as before (0983). Negative examples are admin-entered texts, not derived from documents, and are unchanged. Invalidation (P-27) is
-- extended: the documents and document_chunks update triggers also fire on access_groups changes, and a statement trigger on
-- rag_access_group_settings clears every tenant's centroids when the enforced flag changes (an update that flips it, or an inserted or
-- deleted row with enforced true; a re-run of 0920's ON CONFLICT DO NOTHING insert clears nothing), taking each tenant's shared advisory
-- lock as 0983 does; the rebuild reads the flag after its exclusive lock, so a rebuild that overlaps a flip either sees it or is cleared by
-- it. Bodies rebased on 0983; SET search_path = '', schema-qualified names, revoked from PUBLIC, anon and authenticated, service_role only.
-- Common to both deployment modes. Idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_rebuild(p_tenant_key text, p_profile_id text)
RETURNS TABLE (group_kind text, groups integer, chunks bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
  v_legacy boolean;
  v_enforced boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  v_dims := public.rag_scope_profile_dims(p_profile_id);
  SELECT p.storage = 'legacy_column' INTO v_legacy FROM public.embedding_profiles p WHERE p.id = p_profile_id;

  PERFORM pg_catalog.pg_advisory_xact_lock(public.rag_scope_lock_key(p_tenant_key));
  v_enforced := COALESCE(public.rag_access_enforced(), true);

  DELETE FROM public.rag_scope_centroids c WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id;

  INSERT INTO public.rag_scope_centroids (tenant_key, embedding_profile_id, group_kind, group_key, centroid, dims, member_count, updated_at)
  WITH eff AS MATERIALIZED (
    SELECT dt.doc_type,
           COALESCE(
             (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
             'legacy'
           ) AS profile_id
    FROM (SELECT DISTINCT c.doc_type FROM public.document_chunks c WHERE c.tenant_key = p_tenant_key AND c.doc_type IS NOT NULL) dt
  ),
  members AS MATERIALIZED (
    SELECT c.id AS chunk_id,
           COALESCE(c.doc_type, d.doc_type) AS doc_type,
           d.scopes,
           CASE WHEN c.language IS NULL OR c.language = 'und' THEN COALESCE(NULLIF(d.language, 'und'), 'und') ELSE c.language END AS language,
           CASE WHEN v_legacy THEN c.embedding::public.halfvec ELSE e.embedding END AS embedding
    FROM public.document_chunks c
    JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
    JOIN eff ep ON ep.doc_type = c.doc_type
    LEFT JOIN public.chunk_embeddings e
      ON NOT v_legacy AND e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key AND e.dims = v_dims
    WHERE c.tenant_key = p_tenant_key
      AND c.is_current AND c.status = 'ready' AND NOT c.provisional
      AND d.is_current AND d.status = 'ready' AND NOT d.provisional
      AND (NOT v_enforced
        OR (d.access_groups OPERATOR(pg_catalog.=) ARRAY['all']::text[] AND c.access_groups OPERATOR(pg_catalog.=) ARRAY['all']::text[]))
      AND (c.chunking_profile_id = ep.profile_id
        OR (ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy'
          AND (c.chunk_kind IN ('image', 'invoice_header')
            OR NOT EXISTS (
              SELECT 1 FROM public.document_chunks c2
              WHERE c2.document_id = c.document_id AND c2.tenant_key = p_tenant_key AND c2.is_current
                AND c2.chunking_profile_id = ep.profile_id))))
  ),
  usable AS MATERIALIZED (
    SELECT m.* FROM members m
    WHERE m.embedding IS NOT NULL AND public.vector_dims(m.embedding) = v_dims
  )
  SELECT p_tenant_key, p_profile_id, g.kind, g.key, g.centroid, v_dims, g.n, pg_catalog.now()
  FROM (
    SELECT 'doc_type'::text AS kind, u.doc_type OPERATOR(pg_catalog.||) '/' OPERATOR(pg_catalog.||) u.language AS key,
           public.avg(u.embedding) AS centroid, pg_catalog.count(*)::integer AS n
    FROM usable u
    GROUP BY u.doc_type, u.language
    UNION ALL
    SELECT 'scope_tag'::text, t.tag OPERATOR(pg_catalog.||) '/' OPERATOR(pg_catalog.||) u.language,
           public.avg(u.embedding), pg_catalog.count(*)::integer
    FROM usable u
    CROSS JOIN LATERAL pg_catalog.unnest(u.scopes) AS t(tag)
    WHERE t.tag IS NOT NULL AND pg_catalog.length(t.tag) BETWEEN 3 AND 190
    GROUP BY t.tag, u.language
    UNION ALL
    SELECT 'tenant'::text, 'tenant/' OPERATOR(pg_catalog.||) u.language,
           public.avg(u.embedding), pg_catalog.count(*)::integer
    FROM usable u
    GROUP BY u.language
  ) g;

  RETURN QUERY
  SELECT k.kind, COALESCE(s.groups, 0), COALESCE(s.chunks, 0)
  FROM (VALUES ('doc_type'::text), ('scope_tag'::text), ('tenant'::text)) AS k(kind)
  LEFT JOIN (
    SELECT c.group_kind, pg_catalog.count(*)::integer AS groups, pg_catalog.sum(c.member_count)::bigint AS chunks
    FROM public.rag_scope_centroids c
    WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id
    GROUP BY c.group_kind
  ) s ON s.group_kind = k.kind
  ORDER BY k.kind;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_documents_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(
    SELECT DISTINCT t.tenant_key
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.tenant_key), (n.tenant_key)) AS t(tenant_key)
    WHERE t.tenant_key IS NOT NULL
      AND (o.is_current IS DISTINCT FROM n.is_current
        OR o.status IS DISTINCT FROM n.status
        OR o.version IS DISTINCT FROM n.version
        OR o.tenant_key IS DISTINCT FROM n.tenant_key
        OR o.doc_type IS DISTINCT FROM n.doc_type
        OR o.language IS DISTINCT FROM n.language
        OR o.scopes IS DISTINCT FROM n.scopes
        OR o.provisional IS DISTINCT FROM n.provisional
        OR o.superseded_by IS DISTINCT FROM n.superseded_by
        OR o.access_groups IS DISTINCT FROM n.access_groups)
  ));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_chunks_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(
    SELECT DISTINCT t.tenant_key
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.tenant_key), (n.tenant_key)) AS t(tenant_key)
    WHERE t.tenant_key IS NOT NULL
      AND (o.is_current IS DISTINCT FROM n.is_current
        OR o.status IS DISTINCT FROM n.status
        OR o.tenant_key IS DISTINCT FROM n.tenant_key
        OR o.doc_type IS DISTINCT FROM n.doc_type
        OR o.language IS DISTINCT FROM n.language
        OR o.scopes IS DISTINCT FROM n.scopes
        OR o.provisional IS DISTINCT FROM n.provisional
        OR o.chunking_profile_id IS DISTINCT FROM n.chunking_profile_id
        OR o.access_groups IS DISTINCT FROM n.access_groups
        OR (o.embedding IS NULL) IS DISTINCT FROM (n.embedding IS NULL)
        OR (o.embedding IS NOT NULL AND n.embedding IS NOT NULL AND o.embedding OPERATOR(public.<>) n.embedding))
  ));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_access_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_changed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      SELECT 1 FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE o.enforced IS DISTINCT FROM n.enforced
    ) INTO v_changed;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM new_rows n WHERE n.enforced) INTO v_changed;
  ELSE
    SELECT EXISTS (SELECT 1 FROM old_rows o WHERE o.enforced) INTO v_changed;
  END IF;
  IF v_changed THEN
    PERFORM public.rag_scope_centroids_invalidate(ARRAY(
      SELECT c.tenant_key FROM public.rag_scope_centroids c WHERE c.tenant_key IS NOT NULL
      UNION
      SELECT d.tenant_key FROM public.documents d WHERE d.tenant_key IS NOT NULL
    ));
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS rag_scope_centroids_access_settings_update ON public.rag_access_group_settings;
CREATE TRIGGER rag_scope_centroids_access_settings_update
  AFTER UPDATE ON public.rag_access_group_settings
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_access_settings_change();

DROP TRIGGER IF EXISTS rag_scope_centroids_access_settings_insert ON public.rag_access_group_settings;
CREATE TRIGGER rag_scope_centroids_access_settings_insert
  AFTER INSERT ON public.rag_access_group_settings
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_access_settings_change();

DROP TRIGGER IF EXISTS rag_scope_centroids_access_settings_delete ON public.rag_access_group_settings;
CREATE TRIGGER rag_scope_centroids_access_settings_delete
  AFTER DELETE ON public.rag_access_group_settings
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_access_settings_change();

-- Rows built before this file may include restricted documents: while access is enforced at apply time they are cleared (missing rows
-- mean unsure until the next rebuild).
DO $clear$
BEGIN
  IF public.rag_access_enforced() THEN
    PERFORM public.rag_scope_centroids_invalidate(ARRAY(SELECT DISTINCT c.tenant_key FROM public.rag_scope_centroids c));
  END IF;
END
$clear$;

REVOKE ALL ON FUNCTION public.rag_scope_centroids_rebuild(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_access_settings_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_rebuild(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_access_settings_change() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0990_review_items_hardening.sql
-- 0990: review-queue hardening after the Phase 5.1.1 verification (quick task review-items-hardening; G5, G6, G8, G9).
-- G5 (privacy): rag_review_items_fill_owner(), a BEFORE INSERT trigger on rag_review_items, copies user_id and chat_id from the item's
-- retrieval log row of the same tenant when the writer left them NULL. The sampled writer rag_review_items_enqueue (0967, 0986) wrote
-- retrieval_log_id only, and that key is ON DELETE SET NULL (0534), so a deleted user's or chat's sampled items kept their masked query
-- until expires_at. With the owner columns set, the user cascade (0534) and rag_feedback_loop_on_chat_delete (0534) remove them; the
-- log retention purge still leaves the item (its snapshot outlives the log). A trigger rather than a rebuilt writer body, so re-running
-- 0967 or 0986 cannot bring the gap back. Existing items are backfilled from their log rows. SECURITY INVOKER (writers run as
-- service_role or as a SECURITY DEFINER owner, both of which read the log), empty search_path, service_role only.
-- G8: rag_review_access_sets (0984) is rebuilt with one change: while public.rag_access_enforced() is true, a write with no given sets
-- and no source document returns '[]' (no restricted source: readable by every expert of the tenant) instead of NULL. The restrictive
-- policy rag_review_items_access_sets (0934) is replaced so that NULL fails closed while access is enforced: a NULL row is then readable
-- only by those who administer the tenant (rag_caller_reads_access_sets on a group key nobody holds). With access off a NULL row reads
-- as before. So items written while access was off, or by a writer restored by an out-of-order re-run, never leak once access is on;
-- the 0984 and 0986 backfills, re-run while enforced, recompute their sets.
-- G6 and G9 are covered elsewhere: 0944 and 0950 drop their four-argument rag_enqueue_review_item again when the five-argument one
-- (0984) exists, and tests/rag-db/review-items-hardening.test.mts checks that every rag_review_items writer sets access_sets.
-- One common file: nothing differs by deployment mode. Not folded into the setup files. Idempotent. Apply after 0934, 0984 and 0986;
-- re-running any of them later restores the older function or policy, so re-run this file and then 0410 after them.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_review_access_sets(p_tenant_key text, p_given jsonb, p_document_ids uuid[], p_strict boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key_re constant text := '^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$';
  v_unknown constant jsonb := '["g:00000000-0000-0000-0000-000000000000"]'::jsonb;
  v_sets jsonb[] := '{}'::jsonb[];
  v_set jsonb;
  v_valid boolean;
BEGIN
  IF p_given IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_given) <> 'array' OR pg_catalog.jsonb_array_length(p_given) > 200 THEN
      IF p_strict THEN
        RAISE EXCEPTION 'invalid_access_sets' USING ERRCODE = '22023', DETAIL = 'access sets must be an array of at most 200 key arrays';
      END IF;
      v_sets := v_sets || v_unknown;
    ELSE
      FOR v_set IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_given) AS e(value) LOOP
        v_valid := pg_catalog.jsonb_typeof(v_set) = 'array'
          AND pg_catalog.jsonb_array_length(v_set) BETWEEN 1 AND 64
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)
            WHERE pg_catalog.jsonb_typeof(k.value) <> 'string' OR (k.value #>> '{}') !~ v_key_re
          );
        IF NOT v_valid THEN
          IF p_strict THEN
            RAISE EXCEPTION 'invalid_access_sets' USING ERRCODE = '22023', DETAIL = 'each access set is 1 to 64 access keys';
          END IF;
          v_sets := v_sets || v_unknown;
        ELSE
          v_sets := v_sets || (
            SELECT pg_catalog.jsonb_agg(x.key ORDER BY x.key COLLATE "C")
            FROM (SELECT DISTINCT k.value #>> '{}' AS key FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)) AS x
          );
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF public.rag_access_enforced() AND p_tenant_key IS NOT NULL THEN
    v_sets := v_sets || ARRAY(
      SELECT CASE WHEN pg_catalog.cardinality(d.access_groups) = 0 THEN v_unknown ELSE (
        SELECT pg_catalog.jsonb_agg(x.key ORDER BY x.key COLLATE "C") FROM (SELECT DISTINCT k AS key FROM pg_catalog.unnest(d.access_groups) AS k) AS x
      ) END
      FROM public.documents d
      WHERE d.id = ANY (coalesce(p_document_ids, '{}'::uuid[])) AND d.tenant_key = p_tenant_key
    );
  END IF;

  IF p_given IS NULL AND pg_catalog.cardinality(v_sets) = 0 THEN
    IF public.rag_access_enforced() AND p_tenant_key IS NOT NULL THEN
      RETURN '[]'::jsonb;
    END IF;
    RETURN NULL;
  END IF;
  RETURN coalesce(
    (SELECT pg_catalog.jsonb_agg(s.value ORDER BY s.value::text COLLATE "C") FROM (SELECT DISTINCT u AS value FROM pg_catalog.unnest(v_sets) AS u) AS s),
    '[]'::jsonb);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_review_items_fill_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_user uuid;
  v_chat uuid;
BEGIN
  IF NEW.retrieval_log_id IS NULL OR (NEW.user_id IS NOT NULL AND NEW.chat_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  SELECT l.user_id, l.chat_id INTO v_user, v_chat
  FROM public.rag_retrieval_log l
  WHERE l.id = NEW.retrieval_log_id AND l.tenant_key = NEW.tenant_key;
  NEW.user_id := coalesce(NEW.user_id, v_user);
  NEW.chat_id := coalesce(NEW.chat_id, v_chat);
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_review_items_fill_owner() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_review_items_fill_owner() TO service_role;

DO $owner$
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL OR pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL THEN
    RAISE NOTICE '[0990] rag_review_items or rag_retrieval_log is missing; owner trigger skipped';
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS rag_review_items_fill_owner ON public.rag_review_items;
  CREATE TRIGGER rag_review_items_fill_owner
    BEFORE INSERT ON public.rag_review_items
    FOR EACH ROW EXECUTE FUNCTION public.rag_review_items_fill_owner();

  UPDATE public.rag_review_items AS i
  SET user_id = coalesce(i.user_id, l.user_id),
      chat_id = coalesce(i.chat_id, l.chat_id)
  FROM public.rag_retrieval_log l
  WHERE l.id = i.retrieval_log_id
    AND l.tenant_key = i.tenant_key
    AND ((i.user_id IS NULL AND l.user_id IS NOT NULL) OR (i.chat_id IS NULL AND l.chat_id IS NOT NULL));
END
$owner$;

DO $policy$
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.rag_review_items'::regclass AND a.attname = 'access_sets' AND NOT a.attisdropped
  ) THEN
    RAISE NOTICE '[0990] rag_review_items.access_sets is missing (apply 0934 first); policy skipped';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS rag_review_items_access_sets ON public.rag_review_items;
  CREATE POLICY rag_review_items_access_sets ON public.rag_review_items
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING (
      (access_sets IS NULL AND NOT public.rag_access_enforced())
      OR public.rag_caller_reads_access_sets(tenant_key, coalesce(access_sets, '["g:00000000-0000-0000-0000-000000000000"]'::jsonb))
    );
END
$policy$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/1011_attribute_header_stamp_insert_guard.sql
-- 1011: attribute header stamp insert guard on document_chunks (03.3 verification G8, security F-2, T-03.3-1504).
-- rag_chunk_attribute_header_stamp (1006) copies metadata.attribute_header_stamp into the column on INSERT, and the 1001 column guard
-- covers UPDATE only, so a non-service role inserting a chunk row could choose its stamp (in the metadata key or the column itself).
-- This trigger runs after the 1006 stamp trigger (trigger names fire in name order) and clears the column on INSERT unless the role
-- is service_role, postgres or supabase_admin, like the 1005 documents insert guard. The service-role writers keep their stamps.
-- Same body in both deployment modes; idempotent; SECURITY INVOKER (touches only NEW); service_role only.

CREATE OR REPLACE FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    NEW.attribute_header_stamp := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS rag_chunk_attribute_header_stamp_x_insert_guard ON public.document_chunks;
CREATE TRIGGER rag_chunk_attribute_header_stamp_x_insert_guard
  BEFORE INSERT ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard();

REVOKE ALL ON FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard() TO service_role;

-- ==== 0410 r23 delta (the guarded lines train 41 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
DO $r23_service_role_only$
BEGIN
  IF to_regprocedure('public.rag_purge_store_inventory()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_store_inventory() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_store_inventory() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_foreign_stores(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_foreign_leftovers(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_nango_owner_tenant_key(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_nango_owner_tenant_key(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_nango_owner_tenant_key(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_reconcile_run_record(text, uuid, text, text, jsonb, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_reconcile_run_record(text, uuid, text, text, jsonb, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_reconcile_run_record(text, uuid, text, text, jsonb, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_reconcile_run_decide(uuid, uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_reconcile_run_decide(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_reconcile_run_decide(uuid, uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_reconcile_run_finish(uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_reconcile_run_finish(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_reconcile_run_finish(uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_sync_admin_connections(uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_sync_admin_connections(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_sync_admin_connections(uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_sync_set_deletion_mode(uuid, uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_sync_set_deletion_mode(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_sync_set_deletion_mode(uuid, uuid, text) TO service_role;
  END IF;
  -- Migration 0987: scope centroids are cleared when the access enforcement flag changes (SECURITY DEFINER trigger, service_role only).
  IF to_regprocedure('public.rag_scope_centroids_on_access_settings_change()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_access_settings_change() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_access_settings_change() TO service_role;
  END IF;
  -- 0990 (quick task): review items owner trigger function (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_review_items_fill_owner()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_review_items_fill_owner() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_review_items_fill_owner() TO service_role;
  END IF;
  -- Migration 1011: the chunk attribute header stamp insert guard trigger function (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_chunk_attribute_header_stamp_insert_guard()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard() TO service_role;
  END IF;
END
$r23_service_role_only$;

NOTIFY pgrst, 'reload schema';

-- ==== Verify (read-only; run after the apply)
-- 1. New columns of 0720 (expect 3 nango_connections rows and 3 documents rows, all nullable, no default).
SELECT table_name, column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'nango_connections' AND column_name IN ('deletion_mode', 'last_full_reconcile_at', 'last_reconcile_status'))
    OR (table_name = 'documents' AND column_name IN ('source_last_seen_at', 'source_modified_at', 'source_etag')))
ORDER BY 1, 2;
-- Expect six rows, is_nullable YES and column_default NULL.

-- 2. New tables: RLS on, no policy.
SELECT c.relname, c.relrowsecurity,
       (SELECT count(*) FROM pg_catalog.pg_policy pol WHERE pol.polrelid = c.oid) AS policies
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('rag_source_reconcile_runs', 'rag_source_delta_tokens');
-- Expect relrowsecurity true and policies 0 for both.

-- 3. Grants and search_path: anon and authenticated cannot execute any function this train adds or redefines.
SELECT p.oid::regprocedure AS signature, p.prosecdef AS security_definer, p.proconfig AS config,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'rag\_source\_%' OR p.proname LIKE 'rag\_purge\_foreign\_%' OR p.proname LIKE 'rag\_scope\_centroids\_%'
       OR p.proname IN ('rag_purge_store_inventory', 'rag_nango_owner_tenant_key', 'rag_review_access_sets',
                        'rag_review_items_fill_owner', 'rag_chunk_attribute_header_stamp_insert_guard'))
ORDER BY 1;
-- Expect anon_exec and authenticated_exec false everywhere, service_role_exec true everywhere, config {search_path=""}.

-- 4. Multi-tenant owner key (expect u:<uuid>; a single-tenant deployment returns s:default).
SELECT public.rag_nango_owner_tenant_key('00000000-0000-0000-0000-000000000001'::uuid);

-- 5. The purge store inventory answers (0728). Completeness against the catalog is checked by
--    tests/rag-db/purge-store-coverage.test.mts on the train; here, expect rows for purge_step, cascade and exempt.
SELECT handling, count(*) AS stores FROM public.rag_purge_store_inventory() GROUP BY 1 ORDER BY 1;

-- 6. Triggers added by 0937, 0987, 0990 and 1011 (expect 7 rows, all enabled 'O').
SELECT tgrelid::regclass AS on_table, tgname, tgenabled
FROM pg_catalog.pg_trigger
WHERE tgname IN ('rag_scope_centroids_access_settings_update', 'rag_scope_centroids_access_settings_insert',
                 'rag_scope_centroids_access_settings_delete', 'rag_review_items_fill_owner',
                 'rag_chunk_attribute_header_stamp_x_insert_guard', 'rag_guard_phase32_columns')
ORDER BY 2;

-- 7. The rebuilt review-items policy (expect one RESTRICTIVE policy whose qual mentions rag_access_enforced).
SELECT polname, polpermissive, pg_catalog.pg_get_expr(polqual, polrelid) AS qual
FROM pg_catalog.pg_policy WHERE polrelid = 'public.rag_review_items'::regclass AND polname = 'rag_review_items_access_sets';

-- 8. Access readiness (expect ready) and no review item left without an owner where its log row still exists.
SELECT public.rag_access_readiness();
SELECT count(*) AS unowned_with_log
FROM public.rag_review_items i JOIN public.rag_retrieval_log l ON l.id = i.retrieval_log_id AND l.tenant_key = i.tenant_key
WHERE i.user_id IS NULL AND l.user_id IS NOT NULL;
-- Expect 0.
