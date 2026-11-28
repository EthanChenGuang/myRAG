-- 0729: Phase 6.3 daily cap on change-feed purges per connection (owner decision 2026-11-25, D-49).
-- RAG_SOURCE_PURGE_DAILY_CAP bounds how many files the change feed of one purge-mode connection may purge per UTC day.
-- rag_source_purge_daily_usage counts purged file ids per connection and UTC day; rows older than 30 days are deleted
-- by the reserve function. The allowance is reserved under a row lock before purging and failed purges give theirs
-- back, so concurrent webhook deliveries cannot purge more than the cap together. Files above the cap keep their sync
-- records and wait in one awaiting_confirmation run of origin change_feed with pause_reason purge_daily_cap, decided
-- through the existing confirm and dismiss flow of 0721. Existing runs keep pause_reason NULL (the share guard).
-- Counts and source file ids only, never names or text. Server role only: RLS on, no policies.
-- Additive and idempotent; not folded into the setup files.

BEGIN;

ALTER TABLE public.rag_source_reconcile_runs ADD COLUMN IF NOT EXISTS pause_reason text;
ALTER TABLE public.rag_source_reconcile_runs ADD COLUMN IF NOT EXISTS daily_cap integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.rag_source_reconcile_runs'::regclass
       AND conname = 'rag_source_reconcile_runs_pause_reason_check'
  ) THEN
    ALTER TABLE public.rag_source_reconcile_runs
      ADD CONSTRAINT rag_source_reconcile_runs_pause_reason_check
      CHECK (pause_reason IS NULL OR pause_reason IN ('share', 'purge_daily_cap'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.rag_source_reconcile_runs'::regclass
       AND conname = 'rag_source_reconcile_runs_daily_cap_check'
  ) THEN
    ALTER TABLE public.rag_source_reconcile_runs
      ADD CONSTRAINT rag_source_reconcile_runs_daily_cap_check
      CHECK (daily_cap IS NULL OR daily_cap > 0);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.rag_source_purge_daily_usage (
  connection_id uuid NOT NULL REFERENCES public.nango_connections(id) ON DELETE CASCADE,
  usage_day date NOT NULL,
  tenant_key text NOT NULL,
  purged_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_source_purge_daily_usage_pkey PRIMARY KEY (connection_id, usage_day),
  CONSTRAINT rag_source_purge_daily_usage_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_source_purge_daily_usage_count_check CHECK (purged_count >= 0)
);

ALTER TABLE public.rag_source_purge_daily_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rag_source_purge_daily_usage FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.rag_source_purge_daily_usage TO service_role;

-- Reserves up to p_requested purges of the connection's allowance for the current UTC day and returns the granted count.
CREATE OR REPLACE FUNCTION public.rag_source_purge_reserve(
  p_tenant_key text,
  p_connection_id uuid,
  p_requested integer,
  p_cap integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid;
  v_day date := (now() AT TIME ZONE 'utc')::date;
  v_used integer;
  v_granted integer;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_connection_id IS NULL OR p_requested IS NULL OR p_requested < 0 OR p_cap IS NULL OR p_cap < 1 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT c.user_id INTO v_owner FROM public.nango_connections c WHERE c.id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF public.rag_nango_owner_tenant_key(v_owner) IS DISTINCT FROM p_tenant_key THEN
    RAISE EXCEPTION 'tenant_mismatch';
  END IF;

  DELETE FROM public.rag_source_purge_daily_usage u
   WHERE u.connection_id = p_connection_id AND u.usage_day < v_day - 30;

  INSERT INTO public.rag_source_purge_daily_usage (connection_id, usage_day, tenant_key, purged_count)
  VALUES (p_connection_id, v_day, p_tenant_key, 0)
  ON CONFLICT (connection_id, usage_day) DO NOTHING;

  SELECT u.purged_count INTO v_used
    FROM public.rag_source_purge_daily_usage u
   WHERE u.connection_id = p_connection_id AND u.usage_day = v_day
   FOR UPDATE;

  v_granted := least(p_requested, greatest(p_cap - v_used, 0));
  IF v_granted > 0 THEN
    UPDATE public.rag_source_purge_daily_usage u
       SET purged_count = u.purged_count + v_granted, updated_at = now()
     WHERE u.connection_id = p_connection_id AND u.usage_day = v_day;
  END IF;
  RETURN v_granted;
END;
$$;

-- Gives back p_count reserved purges of the current UTC day (purges that failed); never below 0. Returns the new count.
CREATE OR REPLACE FUNCTION public.rag_source_purge_release(
  p_tenant_key text,
  p_connection_id uuid,
  p_count integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid;
  v_day date := (now() AT TIME ZONE 'utc')::date;
  v_used integer;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_connection_id IS NULL OR p_count IS NULL OR p_count < 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT c.user_id INTO v_owner FROM public.nango_connections c WHERE c.id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF public.rag_nango_owner_tenant_key(v_owner) IS DISTINCT FROM p_tenant_key THEN
    RAISE EXCEPTION 'tenant_mismatch';
  END IF;

  UPDATE public.rag_source_purge_daily_usage u
     SET purged_count = greatest(u.purged_count - p_count, 0), updated_at = now()
   WHERE u.connection_id = p_connection_id AND u.usage_day = v_day
  RETURNING u.purged_count INTO v_used;
  RETURN COALESCE(v_used, 0);
END;
$$;

-- Holds change-feed file ids above the cap for admin confirmation: appended without duplicates to the connection's open
-- purge_daily_cap run of the current UTC day, or a new awaiting_confirmation run of origin change_feed. Ids past the
-- 2,000-id column limit keep their sync records for the next full reconcile; candidate_count keeps the true total.
CREATE OR REPLACE FUNCTION public.rag_source_purge_hold(
  p_tenant_key text,
  p_connection_id uuid,
  p_file_ids text[],
  p_cap integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid;
  v_ids text[];
  v_day date := (now() AT TIME ZONE 'utc')::date;
  v_run public.rag_source_reconcile_runs%ROWTYPE;
  v_new text[];
  v_run_id uuid;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_connection_id IS NULL OR p_cap IS NULL OR p_cap < 1
     OR p_file_ids IS NULL OR cardinality(p_file_ids) = 0 OR EXISTS (
       SELECT 1 FROM unnest(p_file_ids) AS f(file_id) WHERE f.file_id IS NULL OR f.file_id = '' OR length(f.file_id) > 512
     ) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT c.user_id INTO v_owner FROM public.nango_connections c WHERE c.id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF public.rag_nango_owner_tenant_key(v_owner) IS DISTINCT FROM p_tenant_key THEN
    RAISE EXCEPTION 'tenant_mismatch';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_source_purge_hold:' || p_connection_id::text, 0));

  SELECT array_agg(f.file_id ORDER BY f.first_pos) INTO v_ids
    FROM (SELECT u.file_id, min(u.pos) AS first_pos
            FROM unnest(p_file_ids) WITH ORDINALITY AS u(file_id, pos)
           GROUP BY u.file_id) f;

  UPDATE public.rag_source_reconcile_runs r
     SET status = 'expired'
   WHERE r.connection_id = p_connection_id AND r.status = 'awaiting_confirmation' AND r.expires_at <= now();

  SELECT r.* INTO v_run
    FROM public.rag_source_reconcile_runs r
   WHERE r.connection_id = p_connection_id
     AND r.tenant_key = p_tenant_key
     AND r.origin = 'change_feed'
     AND r.status = 'awaiting_confirmation'
     AND r.pause_reason = 'purge_daily_cap'
     AND r.expires_at > now()
     AND (r.created_at AT TIME ZONE 'utc')::date = v_day
   ORDER BY r.created_at DESC, r.id DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    SELECT COALESCE(array_agg(n.file_id ORDER BY n.pos), '{}'::text[]) INTO v_new
      FROM unnest(v_ids) WITH ORDINALITY AS n(file_id, pos)
     WHERE NOT (n.file_id = ANY (v_run.candidate_file_ids));
    UPDATE public.rag_source_reconcile_runs r
       SET candidate_file_ids = (v_run.candidate_file_ids || v_new)[1:2000],
           candidate_count = v_run.candidate_count + cardinality(v_new),
           daily_cap = p_cap
     WHERE r.id = v_run.id;
    v_run_id := v_run.id;
  ELSE
    INSERT INTO public.rag_source_reconcile_runs (
      connection_id, tenant_key, origin, status, candidate_count, candidate_file_ids,
      created_at, expires_at, pause_reason, daily_cap
    ) VALUES (
      p_connection_id, p_tenant_key, 'change_feed', 'awaiting_confirmation', cardinality(v_ids), v_ids[1:2000],
      now(), now() + interval '24 hours', 'purge_daily_cap', p_cap
    )
    RETURNING id INTO v_run_id;
  END IF;

  UPDATE public.nango_connections c
     SET last_reconcile_status = 'paused'
   WHERE c.id = p_connection_id;

  RETURN v_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_source_purge_reserve(text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_source_purge_release(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_source_purge_hold(text, uuid, text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_source_purge_reserve(text, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_source_purge_release(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_source_purge_hold(text, uuid, text[], integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
