-- Train 42 live SQL (ci/merge-train-42 @ 900a22e75). Apply after train 41 is live (sql/train41-live.sql, including 0720-0722, 0728,
-- 0937, 0987, 0990, 1011 and its 0410 r23 delta). One file for both deployment modes: every train-42 migration is a common file.
-- Order: 0729, 0905, 0935 (empty placeholder), 0932 (re-run, see below), 0936, 0938, 0992, then the 0410 r24 delta (grants only).
-- 0932 is live since train 40 and is repeated here on purpose: 0936 stops with 55000 on a database that already has 0938, so a
-- second apply of this file would fail without it. 0932 redefines only rag_bm25_search_chunks (catalog drop, same body as live, service
-- role only), and 0936 replaces it in the next transaction. With it the whole file can be applied again (rehearsed twice per mode).
-- Migration numbers (check-migration-numbers passes on the train): 0729 = Phase 6.3 (06.3-29, purge daily cap); 0905 = Phase 4.4
-- (04.4-16, cluster DF statistics); 0935 = empty placeholder claimed by 04.4-16; 0936 = Phase 4.2 (04.2-40, document-level identifier
-- filter, in the 4.3 block because it redefines the 0930/0932/0933 bodies); 0938 = Phase 4.4 (04.4-17, p_df_mode on the 0936 body);
-- 0992 = quick-61 (fine-tune purge hook). 0991 (UF-1, fix/uf1-direct-insert) and 0989 (NF-1) stay reserved and are not in this train.
-- Dependencies: 0729 needs 0721 (rag_source_reconcile_runs and rag_nango_owner_tenant_key, train 41) and rag_ingest_assert_tenant_key. 0905 needs 0900-0904 (lexical stats)
-- and 0851-0864 (dup_cluster_id); it redefines the 0901 trigger functions and the 0902/0903 lexstats functions. 0936 needs 0930, 0932
-- and 0933 (newest bodies of hybrid_search_chunks, rag_exact_id_documents, rag_bm25_search_chunks, rag_table_lookup) and stops with
-- 55000 if they are missing. 0938 needs 0936 and 0905 (cluster_status, ledger) and stops with 55000 otherwise. 0992 needs 0651-0654
-- (embedding_model_versions, rag_finetune_consent, the taint trigger).
-- Ordering rules (04.4-17 SUMMARY): 0936 before 0938, always. Re-run rules: after re-running 0904, re-run 0932, 0936, then 0938; after
-- re-running 0932, re-run 0936, then 0938; after re-running 0936, re-run 0938. On a database that already has 0938, 0936 stops at its own
-- precheck (55000, p_df_mode is outside the 0932 signature): re-run 0932 first, then 0936, then 0938. After re-running 0856, 0861, 0904,
-- 0930, 0932 or 0933, re-run 0936 and then 0938. 0410 is not re-run here: the delta below repeats only the lines train 42 adds (r24).
-- App compatibility: additive for the app on main. 0729 adds nullable columns and a new table; 0905 adds two tables and two nullable columns
-- (cluster_status NULL = off, so raw-only tenants write nothing new); 0936 with p_identifiers_norm NULL builds the same SQL and returns
-- the same rows as 0930/0932/0933; 0938 with p_df_mode omitted or 'raw' returns what 0936 returns (p_df_mode is last, DEFAULT 'raw').
-- 0992 adds a function and only widens two CHECK constraints (an empty tenant_keys is allowed once tainted_at is set).
-- RAG_LEXICAL_DF_MODE and RAG_SOURCE_PURGE_DAILY_CAP stay at their defaults; nothing here flips a default.
-- DROP sections (each followed by a re-create in the same transaction):
--   0905: DROP TRIGGER IF EXISTS rag_lexical_cluster_dirty_tenant_key_guard and rag_lexical_cluster_units_tenant_key_guard (new tables,
--         re-created right after).
--   0936: every overload of hybrid_search_chunks, rag_bm25_search_chunks, rag_exact_id_documents and rag_table_lookup is dropped by
--         catalog lookup and re-created in the same transaction (grants re-applied: service_role only).
--   0938: every overload of rag_bm25_search_chunks is dropped by catalog lookup and re-created with p_df_mode (service_role only).
--   0992: DROP CONSTRAINT IF EXISTS embedding_model_versions_tenant_keys_shape and _tenant_scope_single, re-added (wider) right after.
--   0729 and 0935 drop nothing.
-- Operational notes:
--   Retrieval calls hybrid_search_chunks and rag_bm25_search_chunks; between the drop and the re-create inside 0936/0938 a concurrent
--   call waits on the transaction lock, it does not fail. Apply in a quiet window anyway.
--   0905 writes no existing row; cluster statistics are built only by `npm run rag:lexstats -- enable --cluster` (operator, later).
--   0729 sets no pause_reason on existing runs. 0992 changes no row.

-- ==== supabase/migrations/0729_source_purge_daily_cap.sql
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

-- ==== supabase/migrations/0905_lexical_cluster_df.sql
-- 0905: Phase 4.4 cluster-aware BM25 document frequency statistics (plan 04.4-16, LEX-02, LEX-03, LEX-06, D-46, D-47, D-48).
-- A second corpus value 'chunks_cluster' in rag_lexical_stats_pending, rag_lexical_df and rag_lexical_corpus counts units instead of
-- chunks: a member chunk (D-11) without a cluster is one unit; for each (tenant_key, dup_cluster_id, chunking_profile_id, language or
-- 'und') the member chunk with the smallest id is the unit, and the other copies add nothing (D-46). The unit is read from
-- document_chunks alone, never from rag_dup_clusters.representative_chunk_id. Corpus 'chunks' and its rows are unchanged.
-- Kept only for a tenant whose rag_lexical_stats_state.cluster_status is set (rag_lexstats_cluster_enable); the default deployment and a
-- raw-only tenant write nothing new. cluster_status: NULL (off) | building | ready; rag_lexstats_rebuild sets ready.
-- Staging (D-47): the three 0901 trigger functions keep their corpus 'chunks' statements as they are and, for cluster-enabled tenants,
-- stage signed 'chunks_cluster' pending rows for member chunks without a cluster and one append-only rag_lexical_cluster_dirty row for
-- each cluster a changed chunk left or joined (a dup_cluster_id-only update and the ON DELETE SET NULL update included). No counter is
-- touched on the write path.
-- Reconciliation (D-48): rag_lexstats_compact_tenant folds pending rows of both corpora, then, under the same advisory lock, reconciles
-- up to p_max_rows marker rows against the ledger rag_lexical_cluster_units (unit chunk id, lexemes, length per cluster, profile and
-- language): subtract the recorded unit, add the recomputed one, rewrite the ledger, delete exactly the marker rows read. It returns
-- pending rows folded plus marker rows removed, so "compact until 0" loops end.
-- rag_lexstats_check adds, for a cluster-enabled tenant, cluster_df_diff, cluster_chunk_count_diff, cluster_total_len_diff (counters plus
-- pending equal the recompute of cluster-less members plus the ledger sum) and cluster_ledger_diff (for every cluster without a marker
-- the ledger equals the recomputed units); rag_lexstats_status adds cluster_status, cluster_dirty and cluster_oldest_dirty_at. Counts,
-- timestamps and states only, never a lexeme (D-34).
-- rag_lexstats_cluster_disable removes the tenant's cluster rows (pending, counters, markers, ledger); rag_lexstats_disable removes all.
-- rag_purge_hook_lexical_stats first marks every ledger row whose unit chunk no longer exists, then compacts until nothing is left.
-- rag_purge_store_inventory() is absent on trunk, so this file adds no inventory row (hand-off handoffs/04.4-07-purge-inventory.md).
-- Security: the trigger functions stay SECURITY DEFINER with no caller input (allow-listed since 0901, guarded in 0410); every other
-- function is SECURITY INVOKER; all have an empty search_path, are revoked from PUBLIC, anon and authenticated and granted to service_role;
-- every function taking p_tenant_key calls rag_assert_tenant_key first and names the tenant in every statement. The two new tables have
-- RLS on, no policy, no client grant and the tenant-key guard trigger of 0853. No dynamic SQL.
-- Re-run rule: after re-running 0901, 0902 or 0903, re-run this file. Idempotent; not folded into the setup files.

BEGIN;

DO $lexical_cluster_df_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_pending') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_df') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_corpus') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_dl(tsvector)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_chunks_update()') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_compact_tenant(text, integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_purge_hook_lexical_stats(text, uuid, uuid[])') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_row_tenant_key_guard()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.document_chunks') AND a.attname = 'dup_cluster_id' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0905: apply migrations 0853 and 0900 to 0903 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_cluster_df_precheck$;

-- Schema -----------------------------------------------------------------------------------------------------------------------------

ALTER TABLE public.rag_lexical_stats_state ADD COLUMN IF NOT EXISTS cluster_status text;
ALTER TABLE public.rag_lexical_stats_state ADD COLUMN IF NOT EXISTS cluster_rebuilt_at timestamptz;
ALTER TABLE public.rag_lexical_stats_state DROP CONSTRAINT IF EXISTS rag_lexical_stats_state_cluster_status_check;
ALTER TABLE public.rag_lexical_stats_state
  ADD CONSTRAINT rag_lexical_stats_state_cluster_status_check CHECK (cluster_status IS NULL OR cluster_status IN ('building', 'ready'));

ALTER TABLE public.rag_lexical_stats_pending DROP CONSTRAINT IF EXISTS rag_lexical_stats_pending_corpus_check;
ALTER TABLE public.rag_lexical_stats_pending
  ADD CONSTRAINT rag_lexical_stats_pending_corpus_check CHECK (corpus IN ('chunks', 'translations', 'chunks_cluster'));
ALTER TABLE public.rag_lexical_df DROP CONSTRAINT IF EXISTS rag_lexical_df_corpus_check;
ALTER TABLE public.rag_lexical_df
  ADD CONSTRAINT rag_lexical_df_corpus_check CHECK (corpus IN ('chunks', 'translations', 'chunks_cluster'));
ALTER TABLE public.rag_lexical_corpus DROP CONSTRAINT IF EXISTS rag_lexical_corpus_corpus_check;
ALTER TABLE public.rag_lexical_corpus
  ADD CONSTRAINT rag_lexical_corpus_corpus_check CHECK (corpus IN ('chunks', 'translations', 'chunks_cluster'));

CREATE TABLE IF NOT EXISTS public.rag_lexical_cluster_dirty (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_key text NOT NULL,
  dup_cluster_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS rag_lexical_cluster_dirty_tenant_id_idx ON public.rag_lexical_cluster_dirty (tenant_key, id);

CREATE TABLE IF NOT EXISTS public.rag_lexical_cluster_units (
  tenant_key text NOT NULL,
  dup_cluster_id uuid NOT NULL,
  chunking_profile_id text NOT NULL,
  language text NOT NULL,
  chunk_id uuid NOT NULL,
  lexemes text[] NOT NULL,
  dl integer NOT NULL,
  CONSTRAINT rag_lexical_cluster_units_pkey PRIMARY KEY (tenant_key, dup_cluster_id, chunking_profile_id, language)
);

ALTER TABLE public.rag_lexical_cluster_dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_lexical_cluster_units ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_lexical_cluster_dirty FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_lexical_cluster_units FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.rag_lexical_cluster_dirty_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.rag_lexical_cluster_dirty TO service_role;
GRANT ALL ON TABLE public.rag_lexical_cluster_units TO service_role;
GRANT ALL ON SEQUENCE public.rag_lexical_cluster_dirty_id_seq TO service_role;

DROP TRIGGER IF EXISTS rag_lexical_cluster_dirty_tenant_key_guard ON public.rag_lexical_cluster_dirty;
CREATE TRIGGER rag_lexical_cluster_dirty_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_lexical_cluster_dirty
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

DROP TRIGGER IF EXISTS rag_lexical_cluster_units_tenant_key_guard ON public.rag_lexical_cluster_units;
CREATE TRIGGER rag_lexical_cluster_units_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_lexical_cluster_units
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

-- Staging (D-47): the 0901 bodies, unchanged for corpus 'chunks', plus the cluster branch -------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_lexstats_chunks_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl)
  SELECT n.tenant_key, n.chunking_profile_id, COALESCE(n.language, 'und'), 1::smallint,
         pg_catalog.tsvector_to_array(n.lexical_tsv), public.rag_lexical_dl(n.lexical_tsv)
    FROM new_rows n
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = n.tenant_key
   WHERE n.is_current AND n.status IN ('ready', 'variant')
     AND n.lexical_tsv IS NOT NULL AND n.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY n.id;

  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.cluster_status IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, corpus, chunking_profile_id, language, sign, lexemes, dl)
  SELECT n.tenant_key, 'chunks_cluster', n.chunking_profile_id, COALESCE(n.language, 'und'), 1::smallint,
         pg_catalog.tsvector_to_array(n.lexical_tsv), public.rag_lexical_dl(n.lexical_tsv)
    FROM new_rows n
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = n.tenant_key AND s.cluster_status IS NOT NULL
   WHERE n.dup_cluster_id IS NULL
     AND n.is_current AND n.status IN ('ready', 'variant')
     AND n.lexical_tsv IS NOT NULL AND n.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY n.id;
  INSERT INTO public.rag_lexical_cluster_dirty (tenant_key, dup_cluster_id)
  SELECT g.tenant_key, g.dup_cluster_id
    FROM (
      SELECT DISTINCT n.tenant_key, n.dup_cluster_id
        FROM new_rows n
        JOIN public.rag_lexical_stats_state s ON s.tenant_key = n.tenant_key AND s.cluster_status IS NOT NULL
       WHERE n.dup_cluster_id IS NOT NULL
         AND n.is_current AND n.status IN ('ready', 'variant')
         AND n.lexical_tsv IS NOT NULL AND n.lexical_tsv <> ''::pg_catalog.tsvector
    ) g
   ORDER BY g.tenant_key, g.dup_cluster_id;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_chunks_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state) THEN
    RETURN NULL;
  END IF;
  WITH pairs AS (
    SELECT o.id,
           o.tenant_key AS o_tenant, o.chunking_profile_id AS o_profile, o.language AS o_language, o.lexical_tsv AS o_tsv,
           COALESCE(o.is_current AND o.status IN ('ready', 'variant') AND o.lexical_tsv IS NOT NULL
                    AND o.lexical_tsv <> ''::pg_catalog.tsvector, false) AS o_member,
           n.tenant_key AS n_tenant, n.chunking_profile_id AS n_profile, n.language AS n_language, n.lexical_tsv AS n_tsv,
           COALESCE(n.is_current AND n.status IN ('ready', 'variant') AND n.lexical_tsv IS NOT NULL
                    AND n.lexical_tsv <> ''::pg_catalog.tsvector, false) AS n_member
      FROM old_rows o
      JOIN new_rows n ON n.id = o.id
  ), changed AS (
    SELECT p.* FROM pairs p
     WHERE (p.o_member OR p.n_member)
       AND (p.o_member IS DISTINCT FROM p.n_member
            OR p.o_tsv IS DISTINCT FROM p.n_tsv
            OR p.o_tenant IS DISTINCT FROM p.n_tenant
            OR p.o_profile IS DISTINCT FROM p.n_profile
            OR p.o_language IS DISTINCT FROM p.n_language)
  ), deltas AS (
    SELECT c.id, c.o_tenant AS tenant_key, c.o_profile AS chunking_profile_id, c.o_language AS language, (-1)::smallint AS sign, c.o_tsv AS tsv
      FROM changed c WHERE c.o_member
    UNION ALL
    SELECT c.id, c.n_tenant, c.n_profile, c.n_language, 1::smallint, c.n_tsv
      FROM changed c WHERE c.n_member
  )
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl)
  SELECT x.tenant_key, x.chunking_profile_id, COALESCE(x.language, 'und'), x.sign,
         pg_catalog.tsvector_to_array(x.tsv), public.rag_lexical_dl(x.tsv)
    FROM deltas x
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = x.tenant_key
   ORDER BY x.id, x.sign;

  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.cluster_status IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  -- One statement: both inserts read the same changed rows; the cluster change test adds dup_cluster_id to the 'chunks' test above.
  WITH pairs AS (
    SELECT o.id,
           o.tenant_key AS o_tenant, o.chunking_profile_id AS o_profile, o.language AS o_language, o.lexical_tsv AS o_tsv,
           o.dup_cluster_id AS o_cluster,
           COALESCE(o.is_current AND o.status IN ('ready', 'variant') AND o.lexical_tsv IS NOT NULL
                    AND o.lexical_tsv <> ''::pg_catalog.tsvector, false) AS o_member,
           n.tenant_key AS n_tenant, n.chunking_profile_id AS n_profile, n.language AS n_language, n.lexical_tsv AS n_tsv,
           n.dup_cluster_id AS n_cluster,
           COALESCE(n.is_current AND n.status IN ('ready', 'variant') AND n.lexical_tsv IS NOT NULL
                    AND n.lexical_tsv <> ''::pg_catalog.tsvector, false) AS n_member
      FROM old_rows o
      JOIN new_rows n ON n.id = o.id
  ), changed AS MATERIALIZED (
    SELECT p.* FROM pairs p
     WHERE (p.o_member OR p.n_member)
       AND (p.o_member IS DISTINCT FROM p.n_member
            OR p.o_tsv IS DISTINCT FROM p.n_tsv
            OR p.o_tenant IS DISTINCT FROM p.n_tenant
            OR p.o_profile IS DISTINCT FROM p.n_profile
            OR p.o_language IS DISTINCT FROM p.n_language
            OR p.o_cluster IS DISTINCT FROM p.n_cluster)
  ), staged AS (
    INSERT INTO public.rag_lexical_stats_pending (tenant_key, corpus, chunking_profile_id, language, sign, lexemes, dl)
    SELECT x.tenant_key, 'chunks_cluster', x.chunking_profile_id, COALESCE(x.language, 'und'), x.sign,
           pg_catalog.tsvector_to_array(x.tsv), public.rag_lexical_dl(x.tsv)
      FROM (
        SELECT c.id, c.o_tenant AS tenant_key, c.o_profile AS chunking_profile_id, c.o_language AS language, (-1)::smallint AS sign, c.o_tsv AS tsv
          FROM changed c WHERE c.o_member AND c.o_cluster IS NULL
        UNION ALL
        SELECT c.id, c.n_tenant, c.n_profile, c.n_language, 1::smallint, c.n_tsv
          FROM changed c WHERE c.n_member AND c.n_cluster IS NULL
      ) x
      JOIN public.rag_lexical_stats_state s ON s.tenant_key = x.tenant_key AND s.cluster_status IS NOT NULL
     ORDER BY x.id, x.sign
    RETURNING 1
  )
  INSERT INTO public.rag_lexical_cluster_dirty (tenant_key, dup_cluster_id)
  SELECT g.tenant_key, g.dup_cluster_id
    FROM (
      SELECT c.o_tenant AS tenant_key, c.o_cluster AS dup_cluster_id
        FROM changed c WHERE c.o_member AND c.o_cluster IS NOT NULL
      UNION
      SELECT c.n_tenant, c.n_cluster
        FROM changed c WHERE c.n_member AND c.n_cluster IS NOT NULL
    ) g
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = g.tenant_key AND s.cluster_status IS NOT NULL
   ORDER BY g.tenant_key, g.dup_cluster_id;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_chunks_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl)
  SELECT o.tenant_key, o.chunking_profile_id, COALESCE(o.language, 'und'), (-1)::smallint,
         pg_catalog.tsvector_to_array(o.lexical_tsv), public.rag_lexical_dl(o.lexical_tsv)
    FROM old_rows o
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = o.tenant_key
   WHERE o.is_current AND o.status IN ('ready', 'variant')
     AND o.lexical_tsv IS NOT NULL AND o.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY o.id;

  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.cluster_status IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, corpus, chunking_profile_id, language, sign, lexemes, dl)
  SELECT o.tenant_key, 'chunks_cluster', o.chunking_profile_id, COALESCE(o.language, 'und'), (-1)::smallint,
         pg_catalog.tsvector_to_array(o.lexical_tsv), public.rag_lexical_dl(o.lexical_tsv)
    FROM old_rows o
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = o.tenant_key AND s.cluster_status IS NOT NULL
   WHERE o.dup_cluster_id IS NULL
     AND o.is_current AND o.status IN ('ready', 'variant')
     AND o.lexical_tsv IS NOT NULL AND o.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY o.id;
  INSERT INTO public.rag_lexical_cluster_dirty (tenant_key, dup_cluster_id)
  SELECT g.tenant_key, g.dup_cluster_id
    FROM (
      SELECT DISTINCT o.tenant_key, o.dup_cluster_id
        FROM old_rows o
        JOIN public.rag_lexical_stats_state s ON s.tenant_key = o.tenant_key AND s.cluster_status IS NOT NULL
       WHERE o.dup_cluster_id IS NOT NULL
         AND o.is_current AND o.status IN ('ready', 'variant')
         AND o.lexical_tsv IS NOT NULL AND o.lexical_tsv <> ''::pg_catalog.tsvector
    ) g
   ORDER BY g.tenant_key, g.dup_cluster_id;
  RETURN NULL;
END
$fn$;

-- Compaction and reconciliation (D-48) ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact_tenant(p_tenant_key text, p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_max integer := LEAST(GREATEST(COALESCE(p_max_rows, 5000), 1), 50000);
  v_cluster_status text;
  v_folded bigint;
  v_marks bigint := 0;
  v_mark_ids bigint[];
  v_clusters uuid[];
  v_df_corpus text[];
  v_df_lexeme text[];
  v_df_profile text[];
  v_df_language text[];
  v_c_corpus text[];
  v_c_profile text[];
  v_c_language text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RETURN 0;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));

  WITH taken AS (
    DELETE FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key
       AND p.id IN (
         SELECT q.id FROM public.rag_lexical_stats_pending q
          WHERE q.tenant_key = p_tenant_key
          ORDER BY q.id
          LIMIT v_max
       )
    RETURNING p.corpus, p.chunking_profile_id, p.language, p.sign, p.lexemes, p.dl
  ), df_delta AS (
    SELECT t.corpus, u.lexeme, t.chunking_profile_id, t.language, pg_catalog.sum(t.sign)::bigint AS d
      FROM taken t
     CROSS JOIN LATERAL pg_catalog.unnest(t.lexemes) AS u(lexeme)
     GROUP BY t.corpus, u.lexeme, t.chunking_profile_id, t.language
    HAVING pg_catalog.sum(t.sign) <> 0
  ), df_up AS (
    INSERT INTO public.rag_lexical_df AS f (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
    SELECT p_tenant_key, x.corpus, x.lexeme, x.chunking_profile_id, x.language, x.d
      FROM df_delta x
     ORDER BY x.corpus, x.lexeme, x.chunking_profile_id, x.language
    ON CONFLICT (tenant_key, corpus, lexeme, chunking_profile_id, language) DO UPDATE SET df = f.df + EXCLUDED.df
    RETURNING f.corpus, f.lexeme, f.chunking_profile_id, f.language, f.df
  ), corpus_delta AS (
    SELECT t.corpus, t.chunking_profile_id, t.language,
           pg_catalog.sum(t.sign)::bigint AS n, pg_catalog.sum(t.sign::bigint * t.dl)::bigint AS len
      FROM taken t
     GROUP BY t.corpus, t.chunking_profile_id, t.language
    HAVING pg_catalog.sum(t.sign) <> 0 OR pg_catalog.sum(t.sign::bigint * t.dl) <> 0
  ), corpus_up AS (
    INSERT INTO public.rag_lexical_corpus AS c (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
    SELECT p_tenant_key, x.corpus, x.chunking_profile_id, x.language, x.n, x.len
      FROM corpus_delta x
     ORDER BY x.corpus, x.chunking_profile_id, x.language
    ON CONFLICT (tenant_key, corpus, chunking_profile_id, language)
      DO UPDATE SET chunk_count = c.chunk_count + EXCLUDED.chunk_count, total_len = c.total_len + EXCLUDED.total_len
    RETURNING c.corpus, c.chunking_profile_id, c.language, c.chunk_count
  )
  SELECT (SELECT pg_catalog.count(*) FROM taken),
         z.dc, z.dl, z.dp, z.dg, y.cc, y.cp, y.cg
    INTO v_folded, v_df_corpus, v_df_lexeme, v_df_profile, v_df_language, v_c_corpus, v_c_profile, v_c_language
    FROM (SELECT pg_catalog.array_agg(d.corpus) AS dc, pg_catalog.array_agg(d.lexeme) AS dl,
                 pg_catalog.array_agg(d.chunking_profile_id) AS dp, pg_catalog.array_agg(d.language) AS dg
            FROM df_up d WHERE d.df <= 0) z,
         (SELECT pg_catalog.array_agg(k.corpus) AS cc, pg_catalog.array_agg(k.chunking_profile_id) AS cp,
                 pg_catalog.array_agg(k.language) AS cg
            FROM corpus_up k WHERE k.chunk_count <= 0) y;

  DELETE FROM public.rag_lexical_df f
   USING ROWS FROM (pg_catalog.unnest(v_df_corpus), pg_catalog.unnest(v_df_lexeme), pg_catalog.unnest(v_df_profile), pg_catalog.unnest(v_df_language)) AS k(corpus, lexeme, chunking_profile_id, language)
   WHERE f.tenant_key = p_tenant_key
     AND f.corpus = k.corpus AND f.lexeme = k.lexeme
     AND f.chunking_profile_id = k.chunking_profile_id AND f.language = k.language
     AND f.df <= 0;

  DELETE FROM public.rag_lexical_corpus c
   USING ROWS FROM (pg_catalog.unnest(v_c_corpus), pg_catalog.unnest(v_c_profile), pg_catalog.unnest(v_c_language)) AS k(corpus, chunking_profile_id, language)
   WHERE c.tenant_key = p_tenant_key
     AND c.corpus = k.corpus AND c.chunking_profile_id = k.chunking_profile_id AND c.language = k.language
     AND c.chunk_count <= 0;

  SELECT s.cluster_status INTO v_cluster_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_cluster_status IS NOT NULL THEN
    SELECT COALESCE(pg_catalog.array_agg(m.id ORDER BY m.id), '{}'::bigint[]),
           COALESCE(pg_catalog.array_agg(DISTINCT m.dup_cluster_id), '{}'::uuid[])
      INTO v_mark_ids, v_clusters
      FROM (
        SELECT d.id, d.dup_cluster_id FROM public.rag_lexical_cluster_dirty d
         WHERE d.tenant_key = p_tenant_key
         ORDER BY d.id
         LIMIT v_max
      ) m;
    v_marks := pg_catalog.cardinality(v_mark_ids);
  END IF;

  IF v_marks > 0 THEN
    CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_cluster_delta (
      sign smallint NOT NULL,
      chunking_profile_id text NOT NULL,
      language text NOT NULL,
      lexemes text[] NOT NULL,
      dl integer NOT NULL
    ) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_cluster_new_units (
      dup_cluster_id uuid NOT NULL,
      chunking_profile_id text NOT NULL,
      language text NOT NULL,
      chunk_id uuid NOT NULL,
      lexemes text[] NOT NULL,
      dl integer NOT NULL
    ) ON COMMIT DROP;
    TRUNCATE pg_temp._rag_lexstats_cluster_delta;
    TRUNCATE pg_temp._rag_lexstats_cluster_new_units;

    INSERT INTO pg_temp._rag_lexstats_cluster_new_units (dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
    SELECT DISTINCT ON (c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'))
           c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'), c.id,
           pg_catalog.tsvector_to_array(c.lexical_tsv), public.rag_lexical_dl(c.lexical_tsv)
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.dup_cluster_id = ANY (v_clusters)
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
     ORDER BY c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'), c.id;

    INSERT INTO pg_temp._rag_lexstats_cluster_delta (sign, chunking_profile_id, language, lexemes, dl)
    SELECT (-1)::smallint, u.chunking_profile_id, u.language, u.lexemes, u.dl
      FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key AND u.dup_cluster_id = ANY (v_clusters)
    UNION ALL
    SELECT 1::smallint, n.chunking_profile_id, n.language, n.lexemes, n.dl
      FROM pg_temp._rag_lexstats_cluster_new_units n;

    WITH df_delta AS (
      SELECT u.lexeme, t.chunking_profile_id, t.language, pg_catalog.sum(t.sign)::bigint AS d
        FROM pg_temp._rag_lexstats_cluster_delta t
       CROSS JOIN LATERAL pg_catalog.unnest(t.lexemes) AS u(lexeme)
       GROUP BY u.lexeme, t.chunking_profile_id, t.language
      HAVING pg_catalog.sum(t.sign) <> 0
    ), df_up AS (
      INSERT INTO public.rag_lexical_df AS f (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
      SELECT p_tenant_key, 'chunks_cluster', x.lexeme, x.chunking_profile_id, x.language, x.d
        FROM df_delta x
       ORDER BY x.lexeme, x.chunking_profile_id, x.language
      ON CONFLICT (tenant_key, corpus, lexeme, chunking_profile_id, language) DO UPDATE SET df = f.df + EXCLUDED.df
      RETURNING f.corpus, f.lexeme, f.chunking_profile_id, f.language, f.df
    ), corpus_delta AS (
      SELECT t.chunking_profile_id, t.language,
             pg_catalog.sum(t.sign)::bigint AS n, pg_catalog.sum(t.sign::bigint * t.dl)::bigint AS len
        FROM pg_temp._rag_lexstats_cluster_delta t
       GROUP BY t.chunking_profile_id, t.language
      HAVING pg_catalog.sum(t.sign) <> 0 OR pg_catalog.sum(t.sign::bigint * t.dl) <> 0
    ), corpus_up AS (
      INSERT INTO public.rag_lexical_corpus AS c (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
      SELECT p_tenant_key, 'chunks_cluster', x.chunking_profile_id, x.language, x.n, x.len
        FROM corpus_delta x
       ORDER BY x.chunking_profile_id, x.language
      ON CONFLICT (tenant_key, corpus, chunking_profile_id, language)
        DO UPDATE SET chunk_count = c.chunk_count + EXCLUDED.chunk_count, total_len = c.total_len + EXCLUDED.total_len
      RETURNING c.corpus, c.chunking_profile_id, c.language, c.chunk_count
    )
    SELECT z.dc, z.dl, z.dp, z.dg, y.cc, y.cp, y.cg
      INTO v_df_corpus, v_df_lexeme, v_df_profile, v_df_language, v_c_corpus, v_c_profile, v_c_language
      FROM (SELECT pg_catalog.array_agg(d.corpus) AS dc, pg_catalog.array_agg(d.lexeme) AS dl,
                   pg_catalog.array_agg(d.chunking_profile_id) AS dp, pg_catalog.array_agg(d.language) AS dg
              FROM df_up d WHERE d.df <= 0) z,
           (SELECT pg_catalog.array_agg(k.corpus) AS cc, pg_catalog.array_agg(k.chunking_profile_id) AS cp,
                   pg_catalog.array_agg(k.language) AS cg
              FROM corpus_up k WHERE k.chunk_count <= 0) y;

    DELETE FROM public.rag_lexical_df f
     USING ROWS FROM (pg_catalog.unnest(v_df_corpus), pg_catalog.unnest(v_df_lexeme), pg_catalog.unnest(v_df_profile), pg_catalog.unnest(v_df_language)) AS k(corpus, lexeme, chunking_profile_id, language)
     WHERE f.tenant_key = p_tenant_key
       AND f.corpus = k.corpus AND f.lexeme = k.lexeme
       AND f.chunking_profile_id = k.chunking_profile_id AND f.language = k.language
       AND f.df <= 0;

    DELETE FROM public.rag_lexical_corpus c
     USING ROWS FROM (pg_catalog.unnest(v_c_corpus), pg_catalog.unnest(v_c_profile), pg_catalog.unnest(v_c_language)) AS k(corpus, chunking_profile_id, language)
     WHERE c.tenant_key = p_tenant_key
       AND c.corpus = k.corpus AND c.chunking_profile_id = k.chunking_profile_id AND c.language = k.language
       AND c.chunk_count <= 0;

    DELETE FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key AND u.dup_cluster_id = ANY (v_clusters);
    INSERT INTO public.rag_lexical_cluster_units (tenant_key, dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
    SELECT p_tenant_key, n.dup_cluster_id, n.chunking_profile_id, n.language, n.chunk_id, n.lexemes, n.dl
      FROM pg_temp._rag_lexstats_cluster_new_units n
     ORDER BY n.dup_cluster_id, n.chunking_profile_id, n.language;

    DELETE FROM public.rag_lexical_cluster_dirty d
     WHERE d.tenant_key = p_tenant_key AND d.id = ANY (v_mark_ids);

    TRUNCATE pg_temp._rag_lexstats_cluster_delta;
    TRUNCATE pg_temp._rag_lexstats_cluster_new_units;
  END IF;

  IF v_folded + v_marks > 0 THEN
    UPDATE public.rag_lexical_stats_state s SET compacted_at = pg_catalog.now() WHERE s.tenant_key = p_tenant_key;
  END IF;
  RETURN v_folded + v_marks;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact_all(p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
  v_total bigint := 0;
BEGIN
  FOR v_key IN
    SELECT s.tenant_key
      FROM public.rag_lexical_stats_state s
     WHERE EXISTS (SELECT 1 FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = s.tenant_key)
        OR (s.cluster_status IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = s.tenant_key))
     ORDER BY s.tenant_key
  LOOP
    v_total := v_total + public.rag_lexstats_compact_tenant(v_key, p_max_rows);
  END LOOP;
  RETURN v_total;
END
$fn$;

-- Enable, rebuild, disable ----------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_lexstats_cluster_enable(p_tenant_key text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_status text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'lexical_stats_not_enabled' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));
  UPDATE public.rag_lexical_stats_state s
     SET cluster_status = 'building'
   WHERE s.tenant_key = p_tenant_key AND s.cluster_status IS NULL;
  SELECT s.cluster_status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  RETURN v_status;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_cluster_disable(p_tenant_key text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_existed boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));
  UPDATE public.rag_lexical_stats_state s
     SET cluster_status = NULL, cluster_rebuilt_at = NULL
   WHERE s.tenant_key = p_tenant_key AND s.cluster_status IS NOT NULL;
  v_existed := FOUND;
  DELETE FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks_cluster';
  DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks_cluster';
  DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks_cluster';
  DELETE FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_cluster_units u WHERE u.tenant_key = p_tenant_key;
  RETURN v_existed;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_rebuild(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_chunks bigint;
  v_lexeme_rows bigint;
  v_corpus_rows bigint;
  v_cluster boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'lexical_stats_not_enabled' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));
  SELECT s.cluster_status IS NOT NULL INTO v_cluster FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;

  CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_staging (
    kind smallint NOT NULL,
    lexeme text,
    chunking_profile_id text NOT NULL,
    language text NOT NULL,
    n bigint NOT NULL,
    len bigint
  ) ON COMMIT DROP;
  TRUNCATE pg_temp._rag_lexstats_staging;

  IF NOT v_cluster THEN
    -- One statement, one snapshot: the pending rows it deletes are exactly those whose changes the scan sees.
    WITH gone AS (
      DELETE FROM public.rag_lexical_stats_pending p
       WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks'
      RETURNING p.id
    ), member AS MATERIALIZED (
      SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv
        FROM public.document_chunks c
       WHERE c.tenant_key = p_tenant_key
         AND c.is_current AND c.status IN ('ready', 'variant')
         AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
    )
    INSERT INTO pg_temp._rag_lexstats_staging (kind, lexeme, chunking_profile_id, language, n, len)
    SELECT 1::smallint, u.lexeme, m.chunking_profile_id, m.language, pg_catalog.count(*), NULL::bigint
      FROM member m
     CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.tsvector_to_array(m.lexical_tsv)) AS u(lexeme)
     GROUP BY u.lexeme, m.chunking_profile_id, m.language
    UNION ALL
    SELECT 2::smallint, NULL::text, m.chunking_profile_id, m.language, pg_catalog.count(*),
           pg_catalog.sum(public.rag_lexical_dl(m.lexical_tsv))::bigint
      FROM member m
     GROUP BY m.chunking_profile_id, m.language;
  ELSE
    CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_units_staging (
      dup_cluster_id uuid NOT NULL,
      chunking_profile_id text NOT NULL,
      language text NOT NULL,
      chunk_id uuid NOT NULL,
      lexemes text[] NOT NULL,
      dl integer NOT NULL
    ) ON COMMIT DROP;
    TRUNCATE pg_temp._rag_lexstats_units_staging;
    -- One statement, one snapshot for both corpora: pending rows of both corpora and the markers it deletes are exactly those whose
    -- changes the scan sees; a change committed later keeps its pending row or marker and is folded by the next compaction.
    WITH gone AS (
      DELETE FROM public.rag_lexical_stats_pending p
       WHERE p.tenant_key = p_tenant_key AND p.corpus IN ('chunks', 'chunks_cluster')
      RETURNING p.id
    ), gone_marks AS (
      DELETE FROM public.rag_lexical_cluster_dirty d
       WHERE d.tenant_key = p_tenant_key
      RETURNING d.id
    ), member AS MATERIALIZED (
      SELECT c.id, c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv
        FROM public.document_chunks c
       WHERE c.tenant_key = p_tenant_key
         AND c.is_current AND c.status IN ('ready', 'variant')
         AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
    ), units AS MATERIALIZED (
      SELECT m.chunking_profile_id, m.language, m.lexical_tsv
        FROM member m WHERE m.dup_cluster_id IS NULL
      UNION ALL
      SELECT q.chunking_profile_id, q.language, q.lexical_tsv
        FROM (
          SELECT DISTINCT ON (m.dup_cluster_id, m.chunking_profile_id, m.language) m.chunking_profile_id, m.language, m.lexical_tsv
            FROM member m WHERE m.dup_cluster_id IS NOT NULL
           ORDER BY m.dup_cluster_id, m.chunking_profile_id, m.language, m.id
        ) q
    ), ledger AS (
      INSERT INTO pg_temp._rag_lexstats_units_staging (dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
      SELECT DISTINCT ON (m.dup_cluster_id, m.chunking_profile_id, m.language)
             m.dup_cluster_id, m.chunking_profile_id, m.language, m.id,
             pg_catalog.tsvector_to_array(m.lexical_tsv), public.rag_lexical_dl(m.lexical_tsv)
        FROM member m WHERE m.dup_cluster_id IS NOT NULL
       ORDER BY m.dup_cluster_id, m.chunking_profile_id, m.language, m.id
      RETURNING 1
    )
    INSERT INTO pg_temp._rag_lexstats_staging (kind, lexeme, chunking_profile_id, language, n, len)
    SELECT 1::smallint, u.lexeme, m.chunking_profile_id, m.language, pg_catalog.count(*), NULL::bigint
      FROM member m
     CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.tsvector_to_array(m.lexical_tsv)) AS u(lexeme)
     GROUP BY u.lexeme, m.chunking_profile_id, m.language
    UNION ALL
    SELECT 2::smallint, NULL::text, m.chunking_profile_id, m.language, pg_catalog.count(*),
           pg_catalog.sum(public.rag_lexical_dl(m.lexical_tsv))::bigint
      FROM member m
     GROUP BY m.chunking_profile_id, m.language
    UNION ALL
    SELECT 3::smallint, u.lexeme, x.chunking_profile_id, x.language, pg_catalog.count(*), NULL::bigint
      FROM units x
     CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.tsvector_to_array(x.lexical_tsv)) AS u(lexeme)
     GROUP BY u.lexeme, x.chunking_profile_id, x.language
    UNION ALL
    SELECT 4::smallint, NULL::text, x.chunking_profile_id, x.language, pg_catalog.count(*),
           pg_catalog.sum(public.rag_lexical_dl(x.lexical_tsv))::bigint
      FROM units x
     GROUP BY x.chunking_profile_id, x.language;
  END IF;

  DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks';
  INSERT INTO public.rag_lexical_df (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
  SELECT p_tenant_key, 'chunks', g.lexeme, g.chunking_profile_id, g.language, g.n
    FROM pg_temp._rag_lexstats_staging g
   WHERE g.kind = 1
   ORDER BY g.lexeme, g.chunking_profile_id, g.language;
  GET DIAGNOSTICS v_lexeme_rows = ROW_COUNT;

  DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks';
  INSERT INTO public.rag_lexical_corpus (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
  SELECT p_tenant_key, 'chunks', g.chunking_profile_id, g.language, g.n, g.len
    FROM pg_temp._rag_lexstats_staging g
   WHERE g.kind = 2
   ORDER BY g.chunking_profile_id, g.language;
  GET DIAGNOSTICS v_corpus_rows = ROW_COUNT;

  SELECT COALESCE(pg_catalog.sum(g.n), 0)::bigint INTO v_chunks FROM pg_temp._rag_lexstats_staging g WHERE g.kind = 2;

  IF v_cluster THEN
    DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks_cluster';
    INSERT INTO public.rag_lexical_df (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
    SELECT p_tenant_key, 'chunks_cluster', g.lexeme, g.chunking_profile_id, g.language, g.n
      FROM pg_temp._rag_lexstats_staging g
     WHERE g.kind = 3
     ORDER BY g.lexeme, g.chunking_profile_id, g.language;

    DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks_cluster';
    INSERT INTO public.rag_lexical_corpus (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
    SELECT p_tenant_key, 'chunks_cluster', g.chunking_profile_id, g.language, g.n, g.len
      FROM pg_temp._rag_lexstats_staging g
     WHERE g.kind = 4
     ORDER BY g.chunking_profile_id, g.language;

    DELETE FROM public.rag_lexical_cluster_units u WHERE u.tenant_key = p_tenant_key;
    INSERT INTO public.rag_lexical_cluster_units (tenant_key, dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
    SELECT p_tenant_key, x.dup_cluster_id, x.chunking_profile_id, x.language, x.chunk_id, x.lexemes, x.dl
      FROM pg_temp._rag_lexstats_units_staging x
     ORDER BY x.dup_cluster_id, x.chunking_profile_id, x.language;
    TRUNCATE pg_temp._rag_lexstats_units_staging;
  END IF;
  TRUNCATE pg_temp._rag_lexstats_staging;

  IF v_cluster THEN
    UPDATE public.rag_lexical_stats_state s
       SET status = 'ready', rebuilt_at = pg_catalog.now(), cluster_status = 'ready', cluster_rebuilt_at = pg_catalog.now()
     WHERE s.tenant_key = p_tenant_key;
  ELSE
    UPDATE public.rag_lexical_stats_state s
       SET status = 'ready', rebuilt_at = pg_catalog.now()
     WHERE s.tenant_key = p_tenant_key;
  END IF;

  RETURN pg_catalog.jsonb_build_object('chunk_count', v_chunks, 'lexeme_rows', v_lexeme_rows, 'corpus_rows', v_corpus_rows);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_disable(p_tenant_key text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_existed boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));
  DELETE FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  v_existed := FOUND;
  DELETE FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_cluster_units u WHERE u.tenant_key = p_tenant_key;
  RETURN v_existed;
END
$fn$;

-- Status and check ------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_lexstats_status(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_out jsonb;
  v_cluster_status text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT pg_catalog.jsonb_build_object(
           'state', s.status,
           'chunk_count', COALESCE((SELECT pg_catalog.sum(c.chunk_count) FROM public.rag_lexical_corpus c
                                     WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks'), 0)::bigint,
           'lexeme_count', (SELECT pg_catalog.count(DISTINCT f.lexeme) FROM public.rag_lexical_df f
                             WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks'),
           'pending', (SELECT pg_catalog.count(*) FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key),
           'oldest_pending_age_s', (SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.now() - pg_catalog.min(p.created_at)))::bigint
                                      FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key),
           'enabled_at', s.enabled_at,
           'rebuilt_at', s.rebuilt_at,
           'compacted_at', s.compacted_at),
         s.cluster_status
    INTO v_out, v_cluster_status
    FROM (SELECT 1) AS one
    LEFT JOIN public.rag_lexical_stats_state s ON s.tenant_key = p_tenant_key;
  IF v_cluster_status IS NOT NULL THEN
    v_out := v_out || pg_catalog.jsonb_build_object(
      'cluster_status', v_cluster_status,
      'cluster_rebuilt_at', (SELECT s.cluster_rebuilt_at FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key),
      'cluster_dirty', (SELECT pg_catalog.count(*) FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key),
      'cluster_oldest_dirty_at', (SELECT pg_catalog.min(d.created_at) FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key),
      'cluster_oldest_dirty_age_s', (SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.now() - pg_catalog.min(d.created_at)))::bigint
                                       FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key));
  END IF;
  RETURN v_out;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_check(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_state text;
  v_cluster_status text;
  v_pending bigint;
  v_df_mismatch bigint;
  v_df_mismatch_p bigint;
  v_count_diff bigint;
  v_count_diff_p bigint;
  v_len_diff bigint;
  v_len_diff_p bigint;
  v_cl_df bigint;
  v_cl_count bigint;
  v_cl_len bigint;
  v_cl_ledger bigint;
  v_cl_dirty bigint;
  v_out jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT s.status, s.cluster_status INTO v_state, v_cluster_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  SELECT pg_catalog.count(*) INTO v_pending FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key;
  IF v_state IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'state', NULL::text, 'pending', v_pending,
      'df_mismatch', NULL::bigint, 'df_mismatch_with_pending', NULL::bigint,
      'chunk_count_diff', NULL::bigint, 'chunk_count_diff_with_pending', NULL::bigint,
      'total_len_diff', NULL::bigint, 'total_len_diff_with_pending', NULL::bigint,
      'clean', NULL::boolean);
  END IF;

  WITH member AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
  ), pend AS MATERIALIZED (
    SELECT p.chunking_profile_id, p.language, p.sign, p.lexemes, p.dl
      FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks'
  ), re_df AS (
    SELECT u.lexeme, m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS v
      FROM member m CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.tsvector_to_array(m.lexical_tsv)) AS u(lexeme)
     GROUP BY u.lexeme, m.chunking_profile_id, m.language
  ), ct_df AS (
    SELECT f.lexeme, f.chunking_profile_id, f.language, f.df AS v
      FROM public.rag_lexical_df f
     WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks'
  ), pd_df AS (
    SELECT u.lexeme, p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS v
      FROM pend p CROSS JOIN LATERAL pg_catalog.unnest(p.lexemes) AS u(lexeme)
     GROUP BY u.lexeme, p.chunking_profile_id, p.language
  ), df_cmp AS (
    SELECT COALESCE(r.v, 0) AS r, COALESCE(c.v, 0) AS c, COALESCE(d.v, 0) AS d
      FROM re_df r
      FULL JOIN ct_df c USING (lexeme, chunking_profile_id, language)
      FULL JOIN pd_df d USING (lexeme, chunking_profile_id, language)
  )
  SELECT pg_catalog.count(*) FILTER (WHERE x.r <> x.c), pg_catalog.count(*) FILTER (WHERE x.r <> x.c + x.d)
    INTO v_df_mismatch, v_df_mismatch_p
    FROM df_cmp x;

  WITH member AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, public.rag_lexical_dl(c.lexical_tsv) AS dl
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
  ), re_c AS (
    SELECT m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS n, pg_catalog.sum(m.dl)::bigint AS len
      FROM member m GROUP BY m.chunking_profile_id, m.language
  ), ct_c AS (
    SELECT c.chunking_profile_id, c.language, c.chunk_count AS n, c.total_len AS len
      FROM public.rag_lexical_corpus c
     WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks'
  ), pd_c AS (
    SELECT p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS n, pg_catalog.sum(p.sign::bigint * p.dl)::bigint AS len
      FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks'
     GROUP BY p.chunking_profile_id, p.language
  ), c_cmp AS (
    SELECT COALESCE(r.n, 0) AS rn, COALESCE(c.n, 0) AS cn, COALESCE(d.n, 0) AS dn,
           COALESCE(r.len, 0) AS rl, COALESCE(c.len, 0) AS cl, COALESCE(d.len, 0) AS dl
      FROM re_c r
      FULL JOIN ct_c c USING (chunking_profile_id, language)
      FULL JOIN pd_c d USING (chunking_profile_id, language)
  )
  SELECT COALESCE(pg_catalog.sum(pg_catalog.abs(x.rn - x.cn)), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(x.rn - x.cn - x.dn)), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(x.rl - x.cl)), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(x.rl - x.cl - x.dl)), 0)::bigint
    INTO v_count_diff, v_count_diff_p, v_len_diff, v_len_diff_p
    FROM c_cmp x;

  v_out := pg_catalog.jsonb_build_object(
    'state', v_state,
    'pending', v_pending,
    'df_mismatch', v_df_mismatch,
    'df_mismatch_with_pending', v_df_mismatch_p,
    'chunk_count_diff', v_count_diff,
    'chunk_count_diff_with_pending', v_count_diff_p,
    'total_len_diff', v_len_diff,
    'total_len_diff_with_pending', v_len_diff_p,
    'clean', v_df_mismatch_p = 0 AND v_count_diff_p = 0 AND v_len_diff_p = 0);

  IF v_cluster_status IS NULL THEN
    RETURN v_out;
  END IF;

  -- Invariant 1: chunks_cluster counters plus unfolded chunks_cluster pending deltas equal the recompute over member chunks without a
  -- cluster plus the sum of the ledger rows.
  WITH loose AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language,
           pg_catalog.tsvector_to_array(c.lexical_tsv) AS lexemes, public.rag_lexical_dl(c.lexical_tsv) AS dl
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key AND c.dup_cluster_id IS NULL
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
    UNION ALL
    SELECT u.chunking_profile_id, u.language, u.lexemes, u.dl
      FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key
  ), re_df AS (
    SELECT x.lexeme, m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS v
      FROM loose m CROSS JOIN LATERAL pg_catalog.unnest(m.lexemes) AS x(lexeme)
     GROUP BY x.lexeme, m.chunking_profile_id, m.language
  ), ct_df AS (
    SELECT f.lexeme, f.chunking_profile_id, f.language, f.df AS v
      FROM public.rag_lexical_df f
     WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks_cluster'
  ), pd_df AS (
    SELECT x.lexeme, p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS v
      FROM public.rag_lexical_stats_pending p CROSS JOIN LATERAL pg_catalog.unnest(p.lexemes) AS x(lexeme)
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks_cluster'
     GROUP BY x.lexeme, p.chunking_profile_id, p.language
  )
  SELECT pg_catalog.count(*) FILTER (WHERE COALESCE(r.v, 0) <> COALESCE(c.v, 0) + COALESCE(d.v, 0))
    INTO v_cl_df
    FROM re_df r
    FULL JOIN ct_df c USING (lexeme, chunking_profile_id, language)
    FULL JOIN pd_df d USING (lexeme, chunking_profile_id, language);

  WITH loose AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, public.rag_lexical_dl(c.lexical_tsv) AS dl
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key AND c.dup_cluster_id IS NULL
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
    UNION ALL
    SELECT u.chunking_profile_id, u.language, u.dl
      FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key
  ), re_c AS (
    SELECT m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS n, pg_catalog.sum(m.dl)::bigint AS len
      FROM loose m GROUP BY m.chunking_profile_id, m.language
  ), ct_c AS (
    SELECT c.chunking_profile_id, c.language, c.chunk_count AS n, c.total_len AS len
      FROM public.rag_lexical_corpus c
     WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks_cluster'
  ), pd_c AS (
    SELECT p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS n, pg_catalog.sum(p.sign::bigint * p.dl)::bigint AS len
      FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks_cluster'
     GROUP BY p.chunking_profile_id, p.language
  )
  SELECT COALESCE(pg_catalog.sum(pg_catalog.abs(COALESCE(r.n, 0) - COALESCE(c.n, 0) - COALESCE(d.n, 0))), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(COALESCE(r.len, 0) - COALESCE(c.len, 0) - COALESCE(d.len, 0))), 0)::bigint
    INTO v_cl_count, v_cl_len
    FROM re_c r
    FULL JOIN ct_c c USING (chunking_profile_id, language)
    FULL JOIN pd_c d USING (chunking_profile_id, language);

  -- Invariant 2: for every cluster without a marker row, the ledger equals the recomputed units.
  WITH dirty AS MATERIALIZED (
    SELECT DISTINCT d.dup_cluster_id FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key
  ), re_u AS (
    SELECT DISTINCT ON (c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'))
           c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.id AS chunk_id,
           pg_catalog.tsvector_to_array(c.lexical_tsv) AS lexemes, public.rag_lexical_dl(c.lexical_tsv) AS dl
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key AND c.dup_cluster_id IS NOT NULL
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
     ORDER BY c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'), c.id
  ), ld_u AS (
    SELECT u.dup_cluster_id, u.chunking_profile_id, u.language, u.chunk_id, u.lexemes, u.dl
      FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key
  )
  SELECT pg_catalog.count(*)
    INTO v_cl_ledger
    FROM re_u r
    FULL JOIN ld_u l USING (dup_cluster_id, chunking_profile_id, language)
   WHERE NOT EXISTS (SELECT 1 FROM dirty k WHERE k.dup_cluster_id = COALESCE(r.dup_cluster_id, l.dup_cluster_id))
     AND (r.chunk_id IS DISTINCT FROM l.chunk_id
          OR r.dl IS DISTINCT FROM l.dl
          OR ARRAY(SELECT pg_catalog.unnest(r.lexemes) ORDER BY 1) IS DISTINCT FROM ARRAY(SELECT pg_catalog.unnest(l.lexemes) ORDER BY 1));

  SELECT pg_catalog.count(*) INTO v_cl_dirty FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key;

  RETURN v_out || pg_catalog.jsonb_build_object(
    'cluster_status', v_cluster_status,
    'cluster_dirty', v_cl_dirty,
    'cluster_df_diff', v_cl_df,
    'cluster_chunk_count_diff', v_cl_count,
    'cluster_total_len_diff', v_cl_len,
    'cluster_ledger_diff', v_cl_ledger,
    'clean', v_df_mismatch_p = 0 AND v_count_diff_p = 0 AND v_len_diff_p = 0
             AND v_cl_df = 0 AND v_cl_count = 0 AND v_cl_len = 0 AND v_cl_ledger = 0);
END
$fn$;

-- Purge hook (0903 body plus the orphaned-ledger marking) ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_purge_hook_lexical_stats(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_folded bigint;
  v_total bigint := 0;
  v_round integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      AND (d.tenant_key IS DISTINCT FROM p_tenant_key OR (p_lineage_id IS NOT NULL AND d.lineage_id IS DISTINCT FROM p_lineage_id))
  ) THEN
    RAISE EXCEPTION 'rag_purge_hook_lexical_stats: a document id is outside the tenant or lineage' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RETURN 0;
  END IF;
  INSERT INTO public.rag_lexical_cluster_dirty (tenant_key, dup_cluster_id)
  SELECT p_tenant_key, g.dup_cluster_id
    FROM (
      SELECT DISTINCT u.dup_cluster_id
        FROM public.rag_lexical_cluster_units u
       WHERE u.tenant_key = p_tenant_key
         AND NOT EXISTS (SELECT 1 FROM public.document_chunks c WHERE c.id = u.chunk_id)
    ) g
   ORDER BY g.dup_cluster_id;
  LOOP
    v_round := v_round + 1;
    v_folded := public.rag_lexstats_compact(p_tenant_key, 5000);
    v_total := v_total + v_folded;
    EXIT WHEN v_folded = 0 OR v_round >= 200;
  END LOOP;
  RETURN v_total;
END
$fn$;

-- Grants ----------------------------------------------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_all(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_cluster_enable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_cluster_disable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_rebuild(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_disable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_status(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_check(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_hook_lexical_stats(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_all(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_cluster_enable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_cluster_disable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_rebuild(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_disable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_status(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_check(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_lexical_stats(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0935_bm25_search_cluster_df.sql
-- 0935: empty placeholder (claimed by plan 04.4-16). 04.2-40's 0936 redefines rag_bm25_search_chunks after this number, so plan 04.4-17
-- wrote p_df_mode in 0938_bm25_search_df_mode.sql instead. This file must stay empty.
-- Idempotent; not folded into the setup files.

BEGIN;
COMMIT;

-- ==== supabase/migrations/0932_access_bm25_search.sql
-- 0932: rag_bm25_search_chunks gains the Phase 4.3 access filter of 0930 (D-05, D-09 to D-12, SEC-12), so the BM25 lexical leg never
-- returns a chunk the caller's access groups do not cover. The 0904 body (Phase 4.4, its only definition) gains p_access_keys text[] and
-- p_access_all boolean, appended with defaults NULL and false and the names, types and defaults of hybrid_search_chunks in 0930
-- (tests/rag-db/bm25-filter-parity.test.mts). With no keys the function builds the same SQL text as 0904 and returns what 0904 returned,
-- unless public.rag_access_enforced() (0922) is true: then it raises access_scope_required (42501). An empty key array (or one holding
-- NULL) raises access_keys_empty (22023). With keys and p_access_all not true, c.access_groups && $31 AND d.access_groups && $31 is
-- appended to v_filter before the candidate ORDER BY and LIMIT; $31 is one above the highest position 0904 binds ($30, avgdl).
-- p_access_all (admin) is decided when the filter is built and is not bound. Every rag_bm25_search_chunks overload is dropped by catalog
-- lookup first, so exactly one exists. Re-running 0904 requires re-running this file. SECURITY INVOKER, VOLATILE, empty search_path,
-- service_role only. Idempotent; not folded into the setup files.

BEGIN;

DO $bm25_access_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_tsquery(text[])') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'hybrid_search_chunks' AND 'p_identifiers_norm' = ANY (p.proargnames)
     )
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_df') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_corpus') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_access_enforced()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.document_chunks'::pg_catalog.regclass AND attname = 'access_groups' AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION '0932: apply migrations 0401, 0403, 0856, 0900, 0904, 0921 and 0922 first' USING ERRCODE = '55000';
  END IF;
END
$bm25_access_precheck$;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.rag_bm25_search_chunks(
  p_tenant_key text,
  p_profile_id text,
  p_query_embedding public.vector,
  p_lexical_tokens text[],
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_lexical_languages text[] DEFAULT NULL,
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL,
  p_include_undated boolean DEFAULT false,
  p_scopes text[] DEFAULT NULL,
  p_scopes_include_untagged boolean DEFAULT false,
  p_effective_on date DEFAULT NULL,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_k1 double precision DEFAULT 1.2,
  p_b double precision DEFAULT 0.75,
  p_candidate_limit integer DEFAULT 500,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text,
  dense_mode text,
  dup_cluster_id uuid,
  is_current boolean,
  document_version integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
  v_storage text;
  v_tsq pg_catalog.tsquery;
  v_tokens text[];
  v_idfs double precision[];
  v_filter text;
  v_date_filter text;
  v_sel text;
  v_key text;
  v_val text;
  v_tag text;
  v_dim text;
  v_scope_region text[];
  v_scope_legal_entity text[];
  v_scope_department text[];
  v_scope_mode text := 'current';
  v_range_from date;
  v_range_to date;
  v_part text;
  v_has_eff boolean;
  v_start_d text;
  v_start_s text;
  v_eff jsonb;
  v_profiles text[];
  v_status text;
  v_n double precision;
  v_avgdl double precision;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  -- D-09, D-10: no keys while enforcement is on is refused; an empty key array never means "no filter" (as 0930).
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;

  IF p_lexical_limit IS NULL OR p_lexical_limit NOT BETWEEN 0 AND 200
     OR p_candidate_limit IS NULL OR p_candidate_limit NOT BETWEEN 0 AND 2000 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_k1 IS NULL OR p_k1 = 'NaN'::double precision OR p_k1 < 0.5 OR p_k1 > 3 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: k1 out of range' USING ERRCODE = '22023';
  END IF;
  IF p_b IS NULL OR p_b = 'NaN'::double precision OR p_b < 0 OR p_b > 1 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: b out of range' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND pg_catalog.jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT j.key, j.value FROM pg_catalog.jsonb_each_text(p_chunking_override) AS j(key, value) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_scopes IS NOT NULL THEN
    FOREACH v_tag IN ARRAY p_scopes LOOP
      v_dim := CASE WHEN v_tag IS NULL OR pg_catalog.strpos(v_tag, ':') = 0 THEN NULL ELSE pg_catalog.split_part(v_tag, ':', 1) END;
      IF v_dim IS NULL OR pg_catalog.length(v_tag) <= pg_catalog.length(v_dim) + 1 THEN
        RAISE EXCEPTION 'invalid_scope: a tag is dimension:value' USING ERRCODE = '22023';
      ELSIF v_dim = 'region' THEN
        v_scope_region := pg_catalog.array_append(v_scope_region, v_tag);
      ELSIF v_dim = 'legal_entity' THEN
        v_scope_legal_entity := pg_catalog.array_append(v_scope_legal_entity, v_tag);
      ELSIF v_dim = 'department' THEN
        v_scope_department := pg_catalog.array_append(v_scope_department, v_tag);
      ELSE
        RAISE EXCEPTION 'invalid_scope: unknown dimension' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_version_scope IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_version_scope) <> 'object'
       OR pg_catalog.jsonb_typeof(p_version_scope -> 'mode') IS DISTINCT FROM 'string'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_version_scope) AS k(name) WHERE k.name NOT IN ('mode', 'from', 'to')) THEN
      RAISE EXCEPTION 'invalid_version_scope: an object with mode current, all or range' USING ERRCODE = '22023';
    END IF;
    v_scope_mode := p_version_scope ->> 'mode';
    IF v_scope_mode NOT IN ('current', 'all', 'range') THEN
      RAISE EXCEPTION 'invalid_version_scope: unknown mode' USING ERRCODE = '22023';
    END IF;
    IF v_scope_mode <> 'range' AND (p_version_scope ? 'from' OR p_version_scope ? 'to') THEN
      RAISE EXCEPTION 'invalid_version_scope: from and to need mode range' USING ERRCODE = '22023';
    END IF;
    FOREACH v_part IN ARRAY ARRAY['from', 'to'] LOOP
      CONTINUE WHEN NOT p_version_scope ? v_part;
      IF pg_catalog.jsonb_typeof(p_version_scope -> v_part) <> 'string'
         OR (p_version_scope ->> v_part) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END IF;
      BEGIN
        IF v_part = 'from' THEN v_range_from := (p_version_scope ->> v_part)::date; ELSE v_range_to := (p_version_scope ->> v_part)::date; END IF;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END;
    END LOOP;
    IF v_range_from IS NOT NULL AND v_range_to IS NOT NULL AND v_range_from > v_range_to THEN
      RAISE EXCEPTION 'invalid_version_scope: from is later than to' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL AND public.vector_dims(p_query_embedding) <> v_dims THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  -- The effective chunking profile of each doc type, by the rule of hybrid_search_chunks: the override, else the active profile, else legacy.
  SELECT pg_catalog.jsonb_object_agg(dt.doc_type, COALESCE(
           NULLIF(pg_catalog.btrim(p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         ))
  INTO v_eff
  FROM pg_catalog.unnest(v_doc_types) AS dt(doc_type);

  SELECT pg_catalog.array_agg(t.tok) INTO v_tokens
  FROM (
    SELECT DISTINCT u.tok
    FROM pg_catalog.unnest(COALESCE(p_lexical_tokens, '{}'::text[])) AS u(tok)
    WHERE u.tok <> '' AND pg_catalog.octet_length(u.tok) <= 255 AND u.tok !~ '[''\\[:space:]]'
    LIMIT 64
  ) AS t;
  v_tsq := public.rag_lexical_tsquery(v_tokens);

  SELECT pg_catalog.array_agg(DISTINCT j.value) INTO v_profiles
  FROM pg_catalog.jsonb_each_text(v_eff) AS j(key, value)
  WHERE p_doc_types IS NULL OR j.key = ANY (p_doc_types);

  IF p_lexical_limit = 0 OR v_tsq IS NULL OR v_profiles IS NULL
     OR (p_lexical_languages IS NOT NULL AND pg_catalog.cardinality(p_lexical_languages) = 0) THEN
    RETURN;
  END IF;

  SELECT s.status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the tenant has no ready lexical statistics' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(pg_catalog.sum(lc.chunk_count), 0)::double precision,
         pg_catalog.sum(lc.total_len)::double precision / NULLIF(pg_catalog.sum(lc.chunk_count), 0)::double precision
  INTO v_n, v_avgdl
  FROM public.rag_lexical_corpus lc
  WHERE lc.tenant_key = p_tenant_key AND lc.corpus = 'chunks' AND lc.chunking_profile_id = ANY (v_profiles)
    AND (p_lexical_languages IS NULL OR lc.language = ANY (p_lexical_languages) OR lc.language = 'und');
  IF v_n IS NULL OR v_n <= 0 OR v_avgdl IS NULL OR v_avgdl <= 0 THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the request statistics hold no chunk' USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.array_agg(t.tok ORDER BY t.tok),
         pg_catalog.array_agg(pg_catalog.ln(1 + (v_n - x.df + 0.5) / (x.df + 0.5)) ORDER BY t.tok)
  INTO v_tokens, v_idfs
  FROM pg_catalog.unnest(v_tokens) AS t(tok)
  CROSS JOIN LATERAL (
    SELECT LEAST(GREATEST(COALESCE(pg_catalog.sum(d.df), 0)::double precision, 1), v_n) AS df
    FROM public.rag_lexical_df d
    WHERE d.tenant_key = p_tenant_key AND d.corpus = 'chunks' AND d.lexeme = t.tok AND d.chunking_profile_id = ANY (v_profiles)
      AND (p_lexical_languages IS NULL OR d.language = ANY (p_lexical_languages) OR d.language = 'und')
  ) AS x;

  IF COALESCE(p_include_undated, false) THEN
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3 OR c.doc_date IS NULL)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4 OR c.doc_date IS NULL)';
  ELSE
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4)';
  END IF;

  -- The lexical filter of hybrid_search_chunks (0856) with the effective-profile map bound as $24.
  v_filter :=
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text($24::jsonb) AS ep(doc_type, profile_id) WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'' AND c.chunk_kind IN (''image'', ''invoice_header''))'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM public.document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || v_date_filter
    || ' AND ($5::text[] IS NULL OR (pg_catalog.cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8) OR (c.language = ''und'' AND d.language = ANY($8)))'
    || ' AND ($9::text IS NULL OR pg_catalog.strpos(pg_catalog.lower(d.supplier_name), pg_catalog.lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  IF v_scope_region IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $16::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''region:'')))) ';
  END IF;
  IF v_scope_legal_entity IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $17::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''legal_entity:'')))) ';
  END IF;
  IF v_scope_department IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $18::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''department:'')))) ';
  END IF;
  IF p_effective_on IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.effective_from IS NULL OR c.effective_from <= $20::date)'
      || ' AND (c.effective_to IS NULL OR c.effective_to >= $20::date) ';
  END IF;

  IF p_identifiers_norm IS NOT NULL THEN
    v_filter := v_filter || ' AND c.identifiers_norm && $23::text[] ';
  END IF;

  -- D-11, D-12: the caller's keys overlap the chunk's and its document's labels, before the candidate ORDER BY and LIMIT, as 0930 does.
  -- p_access_all (admin) is decided here and never bound. Without keys (switch off) the text is exactly the 0904 text.
  IF p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN
    v_filter := v_filter || ' AND c.access_groups && $31::text[]'
      || ' AND d.access_groups && $31::text[] ';
  END IF;

  IF v_scope_mode = 'range' THEN
    v_has_eff := (
      SELECT pg_catalog.count(*) = 2 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname IN ('effective_from', 'effective_to') AND NOT attisdropped
    );
    IF v_has_eff THEN
      v_start_d := 'COALESCE(d.effective_from, (d.created_at AT TIME ZONE ''UTC'')::date)';
      v_start_s := 'COALESCE(s.effective_from, (s.created_at AT TIME ZONE ''UTC'')::date)';
    ELSE
      v_start_d := '(d.created_at AT TIME ZONE ''UTC'')::date';
      v_start_s := '(s.created_at AT TIME ZONE ''UTC'')::date';
    END IF;
    v_filter := v_filter
      || ' AND ($22::date IS NULL OR ' || v_start_d || ' <= $22::date)'
      || ' AND ($21::date IS NULL OR '
      || CASE WHEN v_has_eff THEN '(d.effective_to IS NOT NULL AND d.effective_to >= $21::date) OR (d.effective_to IS NULL AND ' ELSE '(' END
      || 'NOT EXISTS (SELECT 1 FROM public.documents s WHERE s.id = d.superseded_by AND s.tenant_key = $2 AND '
      || v_start_s || ' <= $21::date))) ';
  END IF;

  -- The version-scope widening of the 0856 lexical leg.
  IF v_scope_mode IN ('all', 'range') THEN
    v_filter := pg_catalog.replace(
      pg_catalog.replace(v_filter, ' c.tenant_key = $2 AND c.is_current AND ',
        ' c.tenant_key = $2 AND (c.is_current OR (NOT c.is_current AND NOT c.provisional AND d.tenant_key = $2 AND NOT d.is_current'
        || ' AND d.status = ''ready'' AND NOT d.provisional AND d.superseded_by IS NOT NULL'
        || ' AND EXISTS (SELECT 1 FROM public.documents sd WHERE sd.id = d.superseded_by AND sd.tenant_key = $2'
        || ' AND sd.content_hash IS DISTINCT FROM d.content_hash))) AND '),
      'c2.is_current AND c2.chunking_profile_id', 'c2.is_current = c.is_current AND c2.chunking_profile_id'
    );
  END IF;

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, pg_catalog.left(d.content, 200), %L::text, c.dup_cluster_id, c.is_current, d.version ';

  RETURN QUERY EXECUTE
    'WITH q AS MATERIALIZED (SELECT u.tok, u.idf, pg_catalog.quote_literal(u.tok)::pg_catalog.tsquery AS tsq'
    || ' FROM ROWS FROM (pg_catalog.unnest($28::text[]), pg_catalog.unnest($29::double precision[])) AS u(tok, idf)), '
    || 'cand AS MATERIALIZED (SELECT c.id AS hid,'
    || ' (SELECT pg_catalog.sum(q.idf * pg_catalog.ts_rank(c.lexical_tsv, q.tsq, 0)) FROM q) AS s1'
    || ' FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id WHERE ' || v_filter
    || ' AND ($14::text[] IS NULL OR (pg_catalog.cardinality($14) > 0 AND (c.language = ANY($14) OR (c.language = ''und'' AND d.language = ANY($14)))))'
    || ' AND c.lexical_tsv @@ $1 ORDER BY s1 DESC, c.id LIMIT NULLIF($27, 0)), '
    || 'scored AS (SELECT cand.hid, (SELECT pg_catalog.sum(q.idf * u.tf * ($25 + 1) / (u.tf + $25 * (1 - $26 + $26 * u.dl / $30)))'
    || ' FROM (SELECT x.lexeme, pg_catalog.cardinality(x.positions)::double precision AS tf,'
    || ' (pg_catalog.sum(pg_catalog.cardinality(x.positions)) OVER ())::double precision AS dl'
    || ' FROM pg_catalog.unnest(c.lexical_tsv) AS x(lexeme, positions, weights)) u JOIN q ON q.tok = u.lexeme) AS score'
    || ' FROM cand JOIN public.document_chunks c ON c.id = cand.hid), '
    || 'top AS (SELECT s.hid, s.score, (pg_catalog.row_number() OVER (ORDER BY s.score DESC, s.hid))::integer AS rnk'
    || ' FROM scored s ORDER BY s.score DESC, s.hid LIMIT $13) '
    || 'SELECT ''lexical''::text, t.rnk, '
    || pg_catalog.format(
      v_sel,
      CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
        THEN pg_catalog.format('(1 - (c.embedding OPERATOR(public.<=>) $15::public.vector(%s)))::double precision', v_dims)
        ELSE 'NULL::double precision' END,
      't.score::real',
      'n/a'
    )
    || ' FROM top t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.rnk'
    USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
      p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding,
      v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
      v_range_from, v_range_to, p_identifiers_norm, v_eff, p_k1, p_b, p_candidate_limit, v_tokens, v_idfs, v_avgdl, p_access_keys;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer, text[], boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer, text[], boolean
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0936_identifier_document_filter.sql
-- 0936: the document-level identifier filter (Phase 4.2 plan 04.2-40, D-59, the D-31 revision of 2026-11-28). With p_identifiers_norm set,
-- hybrid_search_chunks, rag_bm25_search_chunks, rag_exact_id_documents (both branches) and rag_table_lookup keep a chunk whose document
-- version has a ready chunk carrying an asked identifier, instead of only the chunks that carry it. The predicate is one text in all four
-- functions, between the marker comments identifier-document-filter:begin and :end (tests/rag-db/identifier-document-filter.test.mts):
--   c.document_id IN (SELECT ic.document_id FROM public.document_chunks ic WHERE ic.tenant_key = <verified tenant key>
--     AND ic.status IN ('ready', 'variant') AND ic.identifiers_norm && <identifiers> AND (<anchor keys> IS NULL OR ic.access_groups && <anchor keys>))
-- The anchor keys are p_access_keys on a restricted call (keys and p_access_all not true) and NULL otherwise. In the two dynamic functions
-- they are bound at the access slot that already exists ($24 in hybrid_search_chunks, $31 in rag_bm25_search_chunks); the 0930/0932 access
-- predicate reads that slot only on a restricted call, so its text and effect are unchanged and no bind position is added. The searched chunk
-- keeps its tenant clause and the 0930 access predicate on itself and its document; the near-miss guard stays per chunk (D-51, in the app).
-- With p_identifiers_norm NULL every function builds the same SQL text and returns the same rows as 0930, 0932 and 0933.
-- Bodies: hybrid_search_chunks and rag_exact_id_documents from 0930, rag_bm25_search_chunks from 0932, rag_table_lookup from 0933; every
-- overload of each is dropped by catalog lookup first, so exactly one exists. Security mode, volatility, empty search_path and grants
-- (service_role only) are those of the bodies they replace.
-- Precheck (55000): the four functions exist with p_identifiers_norm, p_access_keys and p_access_all; document_chunks has identifiers_norm and
-- access_groups; rag_bm25_search_chunks has no argument outside the 0932 signature (a later parameter such as Phase 4.4's p_df_mode must be
-- rebuilt on this body in a file numbered above 0936, never dropped here).
-- Operator rule: after re-running 0856, 0861, 0904, 0930, 0932 or 0933 (or any file their own rules name), re-run this file.
-- Idempotent; not folded into the setup files.

BEGIN;

DO $docfilter_precheck$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['hybrid_search_chunks', 'rag_bm25_search_chunks', 'rag_exact_id_documents', 'rag_table_lookup'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = v_fn
        AND p.proargnames @> ARRAY['p_identifiers_norm', 'p_access_keys', 'p_access_all']::text[]
    ) THEN
      RAISE EXCEPTION '0936: apply 0930, 0932 and 0933 first (% lacks the identifier and access parameters)', v_fn USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.document_chunks'::pg_catalog.regclass AND attname IN ('identifiers_norm', 'access_groups') AND NOT attisdropped) <> 2 THEN
    RAISE EXCEPTION '0936: document_chunks needs identifiers_norm (0854) and access_groups (0921)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.unnest(p.proargnames) AS a(name)
    WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks'
      AND a.name <> ALL (ARRAY[
        'p_tenant_key', 'p_profile_id', 'p_query_embedding', 'p_lexical_tokens', 'p_lexical_limit', 'p_date_from', 'p_date_to', 'p_sources',
        'p_document_ids', 'p_doc_types', 'p_languages', 'p_lexical_languages', 'p_supplier', 'p_amount_min', 'p_amount_max', 'p_currency',
        'p_chunking_override', 'p_include_undated', 'p_scopes', 'p_scopes_include_untagged', 'p_effective_on', 'p_version_scope',
        'p_identifiers_norm', 'p_k1', 'p_b', 'p_candidate_limit', 'p_access_keys', 'p_access_all',
        'leg', 'rank', 'chunk_id', 'document_id', 'content', 'metadata', 'chunk_index', 'similarity', 'lexical_score', 'doc_type', 'language',
        'parent_id', 'section_path', 'chunk_kind', 'document_filename', 'document_created_at', 'document_metadata', 'document_content_preview',
        'dense_mode', 'dup_cluster_id', 'is_current', 'document_version'
      ]::text[])
  ) THEN
    RAISE EXCEPTION '0936: rag_bm25_search_chunks has an argument outside the 0932 signature; rebuild it on this body in a later file' USING ERRCODE = '55000';
  END IF;
END
$docfilter_precheck$;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('hybrid_search_chunks', 'rag_bm25_search_chunks', 'rag_exact_id_documents', 'rag_table_lookup')
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

-- hybrid_search_chunks: the 0930 body; the identifier predicate is the document-level fragment.
CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(
  p_tenant_key text,
  p_profile_id text,
  p_query_embedding public.vector,
  p_lexical_tokens text[],
  p_dense_limit integer,
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_iterative_scan text DEFAULT 'off',
  p_exact_scan_cutoff integer DEFAULT 0,
  p_lexical_languages text[] DEFAULT NULL,
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL,
  p_include_undated boolean DEFAULT false,
  p_scopes text[] DEFAULT NULL,
  p_scopes_include_untagged boolean DEFAULT false,
  p_effective_on date DEFAULT NULL,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text,
  dense_mode text,
  dup_cluster_id uuid,
  is_current boolean,
  document_version integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
  v_storage text;
  v_tsq tsquery;
  v_n integer;
  v_mode text := 'ann';
  v_filter text;
  v_date_filter text;
  v_from text;
  v_vec text;
  v_sel text;
  v_pgvector text;
  v_key text;
  v_val text;
  v_tag text;
  v_dim text;
  v_scope_region text[];
  v_scope_legal_entity text[];
  v_scope_department text[];
  v_scope_mode text := 'current';
  v_range_from date;
  v_range_to date;
  v_part text;
  v_has_eff boolean;
  v_start_d text;
  v_start_s text;
  v_lex_filter text;
  v_anchor_keys text[];
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  -- D-09, D-10: no keys while enforcement is on is refused; an empty key array never means "no filter".
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  -- 04.2-40: the access slot carries the keys only on a restricted call; the 0930 predicate reads it only then, the identifier anchor always.
  v_anchor_keys := CASE WHEN p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN p_access_keys END;

  IF p_dense_limit NOT BETWEEN 0 AND 200 OR p_lexical_limit NOT BETWEEN 0 AND 200 OR p_exact_scan_cutoff NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_iterative_scan NOT IN ('off', 'relaxed_order', 'strict_order') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid iterative scan mode' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(p_chunking_override) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_scopes IS NOT NULL THEN
    FOREACH v_tag IN ARRAY p_scopes LOOP
      v_dim := CASE WHEN v_tag IS NULL OR strpos(v_tag, ':') = 0 THEN NULL ELSE split_part(v_tag, ':', 1) END;
      IF v_dim IS NULL OR length(v_tag) <= length(v_dim) + 1 THEN
        RAISE EXCEPTION 'invalid_scope: a tag is dimension:value' USING ERRCODE = '22023';
      ELSIF v_dim = 'region' THEN
        v_scope_region := array_append(v_scope_region, v_tag);
      ELSIF v_dim = 'legal_entity' THEN
        v_scope_legal_entity := array_append(v_scope_legal_entity, v_tag);
      ELSIF v_dim = 'department' THEN
        v_scope_department := array_append(v_scope_department, v_tag);
      ELSE
        RAISE EXCEPTION 'invalid_scope: unknown dimension' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_version_scope IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_version_scope) <> 'object'
       OR pg_catalog.jsonb_typeof(p_version_scope -> 'mode') IS DISTINCT FROM 'string'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_version_scope) AS k(name) WHERE k.name NOT IN ('mode', 'from', 'to')) THEN
      RAISE EXCEPTION 'invalid_version_scope: an object with mode current, all or range' USING ERRCODE = '22023';
    END IF;
    v_scope_mode := p_version_scope ->> 'mode';
    IF v_scope_mode NOT IN ('current', 'all', 'range') THEN
      RAISE EXCEPTION 'invalid_version_scope: unknown mode' USING ERRCODE = '22023';
    END IF;
    IF v_scope_mode <> 'range' AND (p_version_scope ? 'from' OR p_version_scope ? 'to') THEN
      RAISE EXCEPTION 'invalid_version_scope: from and to need mode range' USING ERRCODE = '22023';
    END IF;
    FOREACH v_part IN ARRAY ARRAY['from', 'to'] LOOP
      CONTINUE WHEN NOT p_version_scope ? v_part;
      IF pg_catalog.jsonb_typeof(p_version_scope -> v_part) <> 'string'
         OR (p_version_scope ->> v_part) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END IF;
      BEGIN
        IF v_part = 'from' THEN v_range_from := (p_version_scope ->> v_part)::date; ELSE v_range_to := (p_version_scope ->> v_part)::date; END IF;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END;
    END LOOP;
    IF v_range_from IS NOT NULL AND v_range_to IS NOT NULL AND v_range_from > v_range_to THEN
      RAISE EXCEPTION 'invalid_version_scope: from is later than to' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit > 0 AND (p_query_embedding IS NULL OR public.vector_dims(p_query_embedding) <> v_dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  CREATE TEMP TABLE pg_temp._hybrid_eff_profile (doc_type text PRIMARY KEY, profile_id text) ON COMMIT DROP;
  INSERT INTO pg_temp._hybrid_eff_profile (doc_type, profile_id)
  SELECT dt.doc_type,
         COALESCE(
           NULLIF(trim(both FROM p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         )
  FROM unnest(v_doc_types) AS dt(doc_type);

  IF COALESCE(p_include_undated, false) THEN
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3 OR c.doc_date IS NULL)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4 OR c.doc_date IS NULL)';
  ELSE
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4)';
  END IF;

  v_filter :=
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM pg_temp._hybrid_eff_profile ep WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'' AND c.chunk_kind IN (''image'', ''invoice_header''))'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM public.document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || v_date_filter
    || ' AND ($5::text[] IS NULL OR (cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8) OR (c.language = ''und'' AND d.language = ANY($8)))'
    || ' AND ($9::text IS NULL OR strpos(lower(d.supplier_name), lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  IF v_scope_region IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $16::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM unnest(c.scopes) AS s(tag) WHERE starts_with(s.tag, ''region:'')))) ';
  END IF;
  IF v_scope_legal_entity IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $17::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM unnest(c.scopes) AS s(tag) WHERE starts_with(s.tag, ''legal_entity:'')))) ';
  END IF;
  IF v_scope_department IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $18::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM unnest(c.scopes) AS s(tag) WHERE starts_with(s.tag, ''department:'')))) ';
  END IF;
  IF p_effective_on IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.effective_from IS NULL OR c.effective_from <= $20::date)'
      || ' AND (c.effective_to IS NULL OR c.effective_to >= $20::date) ';
  END IF;

  IF p_identifiers_norm IS NOT NULL THEN
    v_filter := v_filter || ' AND /* identifier-document-filter:begin */ c.document_id IN (SELECT ic.document_id FROM public.document_chunks ic WHERE ic.tenant_key = $2 AND ic.status IN (''ready'', ''variant'') AND ic.identifiers_norm OPERATOR(pg_catalog.&&) $23::text[] AND ($24::text[] IS NULL OR ic.access_groups OPERATOR(pg_catalog.&&) $24::text[])) /* identifier-document-filter:end */ ';
  END IF;

  -- D-11, D-12: the caller's keys overlap the chunk's and its document's labels, before every ORDER BY and LIMIT (probe, dense, lexical).
  -- v_filter is one string for the three queries, so $24 is one fixed slot bound to p_access_keys in all three USING lists. p_access_all
  -- (admin) is decided here and never bound. Without keys (switch off) the text is exactly the 0856 text.
  IF p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN
    v_filter := v_filter || ' AND c.access_groups && $24::text[]'
      || ' AND d.access_groups && $24::text[] ';
  END IF;

  -- D-12: a range keeps a version whose period overlaps it. Start: effective_from when the column exists and is set, else the creation date
  -- (UTC); end: effective_to, else the successor's start (exclusive), else open. The effective-date columns are probed, so the same body
  -- runs on a database without them.
  IF v_scope_mode = 'range' THEN
    v_has_eff := (
      SELECT pg_catalog.count(*) = 2 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname IN ('effective_from', 'effective_to') AND NOT attisdropped
    );
    IF v_has_eff THEN
      v_start_d := 'COALESCE(d.effective_from, (d.created_at AT TIME ZONE ''UTC'')::date)';
      v_start_s := 'COALESCE(s.effective_from, (s.created_at AT TIME ZONE ''UTC'')::date)';
    ELSE
      v_start_d := '(d.created_at AT TIME ZONE ''UTC'')::date';
      v_start_s := '(s.created_at AT TIME ZONE ''UTC'')::date';
    END IF;
    v_filter := v_filter
      || ' AND ($22::date IS NULL OR ' || v_start_d || ' <= $22::date)'
      || ' AND ($21::date IS NULL OR '
      || CASE WHEN v_has_eff THEN '(d.effective_to IS NOT NULL AND d.effective_to >= $21::date) OR (d.effective_to IS NULL AND ' ELSE '(' END
      || 'NOT EXISTS (SELECT 1 FROM public.documents s WHERE s.id = d.superseded_by AND s.tenant_key = $2 AND '
      || v_start_s || ' <= $21::date))) ';
  END IF;

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, left(d.content, 200), %L::text, c.dup_cluster_id, c.is_current, d.version ';

  IF p_dense_limit > 0 THEN
    IF v_storage = 'legacy_column' THEN
      v_from := ' public.document_chunks c JOIN public.documents d ON d.id = c.document_id ';
      v_vec := format('c.embedding OPERATOR(public.<=>) $1::public.vector(%s)', v_dims);
      v_filter := v_filter || ' AND c.embedding IS NOT NULL ';
    ELSE
      v_from := format(
        ' public.chunk_embeddings e JOIN public.document_chunks c ON c.id = e.chunk_id AND e.profile_id = %L'
        || ' JOIN public.documents d ON d.id = c.document_id ',
        p_profile_id
      );
      v_vec := format('(e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)', v_dims);
    END IF;

    IF p_exact_scan_cutoff > 0 THEN
      EXECUTE 'SELECT count(*)::int FROM (SELECT 1 FROM ' || v_from || ' WHERE ' || v_filter || ' LIMIT $13) s'
        INTO v_n
        USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
          p_supplier, p_amount_min, p_amount_max, p_currency, p_exact_scan_cutoff + 1, p_lexical_languages, p_query_embedding,
          v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        v_range_from, v_range_to, p_identifiers_norm, v_anchor_keys;
      IF v_n <= p_exact_scan_cutoff THEN v_mode := 'exact'; END IF;
    END IF;

    IF v_mode = 'ann' THEN
      PERFORM set_config('hnsw.ef_search', least(greatest(p_dense_limit * 2, 100), 1000)::text, true);
      IF p_iterative_scan <> 'off' THEN
        SELECT extversion INTO v_pgvector FROM pg_catalog.pg_extension WHERE extname = 'vector';
        IF v_pgvector IS NULL OR (string_to_array(v_pgvector, '.'))[1:2]::int[] < ARRAY[0, 8] THEN
          RAISE EXCEPTION 'iterative_scan_unsupported' USING ERRCODE = '22023';
        END IF;
        PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true);
      END IF;
    END IF;

    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ' || v_vec || ' AS dist FROM ' || v_from || ' WHERE ' || v_filter
      || CASE WHEN v_mode = 'exact' THEN ') ' ELSE ' ORDER BY ' || v_vec || ' LIMIT $13) ' END
      || ', top AS (SELECT hid, dist, (row_number() OVER (ORDER BY dist + 0, hid))::integer AS rnk FROM hits ORDER BY dist + 0, hid LIMIT $13) '
      || 'SELECT ''dense''::text, t.rnk, ' || format(v_sel, '(1 - t.dist)::double precision', 'NULL::real', v_mode)
      || ' FROM top t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.rnk'
      USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_dense_limit, p_lexical_languages, p_query_embedding,
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        v_range_from, v_range_to, p_identifiers_norm, v_anchor_keys;
  END IF;

  v_tsq := public.rag_lexical_tsquery(p_lexical_tokens);
  IF p_lexical_limit > 0 AND v_tsq IS NOT NULL THEN
    v_lex_filter := replace(v_filter, ' AND c.embedding IS NOT NULL ', '');
    -- D-40: superseded chunks have no vectors, so only this leg widens. A superseded row is ready, not provisional, of a ready document
    -- of this tenant that is not current, and its content differs from its successor's (a re-publish of the same text is left out).
    IF v_scope_mode IN ('all', 'range') THEN
      v_lex_filter := replace(
        replace(v_lex_filter, ' c.tenant_key = $2 AND c.is_current AND ',
          ' c.tenant_key = $2 AND (c.is_current OR (NOT c.is_current AND NOT c.provisional AND d.tenant_key = $2 AND NOT d.is_current'
          || ' AND d.status = ''ready'' AND NOT d.provisional AND d.superseded_by IS NOT NULL'
          || ' AND EXISTS (SELECT 1 FROM public.documents sd WHERE sd.id = d.superseded_by AND sd.tenant_key = $2'
          || ' AND sd.content_hash IS DISTINCT FROM d.content_hash))) AND '),
        'c2.is_current AND c2.chunking_profile_id', 'c2.is_current = c.is_current AND c2.chunking_profile_id'
      );
    END IF;
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ts_rank_cd(c.lexical_tsv, $1, 1) AS score'
      || ' FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id WHERE ' || v_lex_filter
      || ' AND ($14::text[] IS NULL OR (cardinality($14) > 0 AND (c.language = ANY($14) OR (c.language = ''und'' AND d.language = ANY($14)))))'
      || ' AND c.lexical_tsv @@ $1 ORDER BY score DESC, c.id LIMIT $13) '
      || 'SELECT ''lexical''::text, (row_number() OVER (ORDER BY t.score DESC, t.hid))::integer, '
      || format(
        v_sel,
        CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
          THEN format('(1 - (c.embedding OPERATOR(public.<=>) $15::public.vector(%s)))::double precision', v_dims)
          ELSE 'NULL::double precision' END,
        't.score::real',
        'n/a'
      )
      || ' FROM hits t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.score DESC, t.hid'
      USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding,
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        v_range_from, v_range_to, p_identifiers_norm, v_anchor_keys;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.hybrid_search_chunks(
  text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb, boolean, text[], boolean, date, jsonb, text[], text[], boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.hybrid_search_chunks(
  text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb, boolean, text[], boolean, date, jsonb, text[], text[], boolean
) TO service_role;


-- rag_bm25_search_chunks: the 0932 body; the identifier predicate is the document-level fragment, in the candidate filter before ORDER BY and LIMIT.
CREATE OR REPLACE FUNCTION public.rag_bm25_search_chunks(
  p_tenant_key text,
  p_profile_id text,
  p_query_embedding public.vector,
  p_lexical_tokens text[],
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_lexical_languages text[] DEFAULT NULL,
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL,
  p_include_undated boolean DEFAULT false,
  p_scopes text[] DEFAULT NULL,
  p_scopes_include_untagged boolean DEFAULT false,
  p_effective_on date DEFAULT NULL,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_k1 double precision DEFAULT 1.2,
  p_b double precision DEFAULT 0.75,
  p_candidate_limit integer DEFAULT 500,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text,
  dense_mode text,
  dup_cluster_id uuid,
  is_current boolean,
  document_version integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_anchor_keys text[];
  v_dims integer;
  v_storage text;
  v_tsq pg_catalog.tsquery;
  v_tokens text[];
  v_idfs double precision[];
  v_filter text;
  v_date_filter text;
  v_sel text;
  v_key text;
  v_val text;
  v_tag text;
  v_dim text;
  v_scope_region text[];
  v_scope_legal_entity text[];
  v_scope_department text[];
  v_scope_mode text := 'current';
  v_range_from date;
  v_range_to date;
  v_part text;
  v_has_eff boolean;
  v_start_d text;
  v_start_s text;
  v_eff jsonb;
  v_profiles text[];
  v_status text;
  v_n double precision;
  v_avgdl double precision;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  -- D-09, D-10: no keys while enforcement is on is refused; an empty key array never means "no filter" (as 0930).
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  -- 04.2-40: the access slot carries the keys only on a restricted call; the 0930 predicate reads it only then, the identifier anchor always.
  v_anchor_keys := CASE WHEN p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN p_access_keys END;

  IF p_lexical_limit IS NULL OR p_lexical_limit NOT BETWEEN 0 AND 200
     OR p_candidate_limit IS NULL OR p_candidate_limit NOT BETWEEN 0 AND 2000 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_k1 IS NULL OR p_k1 = 'NaN'::double precision OR p_k1 < 0.5 OR p_k1 > 3 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: k1 out of range' USING ERRCODE = '22023';
  END IF;
  IF p_b IS NULL OR p_b = 'NaN'::double precision OR p_b < 0 OR p_b > 1 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: b out of range' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND pg_catalog.jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT j.key, j.value FROM pg_catalog.jsonb_each_text(p_chunking_override) AS j(key, value) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_scopes IS NOT NULL THEN
    FOREACH v_tag IN ARRAY p_scopes LOOP
      v_dim := CASE WHEN v_tag IS NULL OR pg_catalog.strpos(v_tag, ':') = 0 THEN NULL ELSE pg_catalog.split_part(v_tag, ':', 1) END;
      IF v_dim IS NULL OR pg_catalog.length(v_tag) <= pg_catalog.length(v_dim) + 1 THEN
        RAISE EXCEPTION 'invalid_scope: a tag is dimension:value' USING ERRCODE = '22023';
      ELSIF v_dim = 'region' THEN
        v_scope_region := pg_catalog.array_append(v_scope_region, v_tag);
      ELSIF v_dim = 'legal_entity' THEN
        v_scope_legal_entity := pg_catalog.array_append(v_scope_legal_entity, v_tag);
      ELSIF v_dim = 'department' THEN
        v_scope_department := pg_catalog.array_append(v_scope_department, v_tag);
      ELSE
        RAISE EXCEPTION 'invalid_scope: unknown dimension' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_version_scope IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_version_scope) <> 'object'
       OR pg_catalog.jsonb_typeof(p_version_scope -> 'mode') IS DISTINCT FROM 'string'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_version_scope) AS k(name) WHERE k.name NOT IN ('mode', 'from', 'to')) THEN
      RAISE EXCEPTION 'invalid_version_scope: an object with mode current, all or range' USING ERRCODE = '22023';
    END IF;
    v_scope_mode := p_version_scope ->> 'mode';
    IF v_scope_mode NOT IN ('current', 'all', 'range') THEN
      RAISE EXCEPTION 'invalid_version_scope: unknown mode' USING ERRCODE = '22023';
    END IF;
    IF v_scope_mode <> 'range' AND (p_version_scope ? 'from' OR p_version_scope ? 'to') THEN
      RAISE EXCEPTION 'invalid_version_scope: from and to need mode range' USING ERRCODE = '22023';
    END IF;
    FOREACH v_part IN ARRAY ARRAY['from', 'to'] LOOP
      CONTINUE WHEN NOT p_version_scope ? v_part;
      IF pg_catalog.jsonb_typeof(p_version_scope -> v_part) <> 'string'
         OR (p_version_scope ->> v_part) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END IF;
      BEGIN
        IF v_part = 'from' THEN v_range_from := (p_version_scope ->> v_part)::date; ELSE v_range_to := (p_version_scope ->> v_part)::date; END IF;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END;
    END LOOP;
    IF v_range_from IS NOT NULL AND v_range_to IS NOT NULL AND v_range_from > v_range_to THEN
      RAISE EXCEPTION 'invalid_version_scope: from is later than to' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL AND public.vector_dims(p_query_embedding) <> v_dims THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  -- The effective chunking profile of each doc type, by the rule of hybrid_search_chunks: the override, else the active profile, else legacy.
  SELECT pg_catalog.jsonb_object_agg(dt.doc_type, COALESCE(
           NULLIF(pg_catalog.btrim(p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         ))
  INTO v_eff
  FROM pg_catalog.unnest(v_doc_types) AS dt(doc_type);

  SELECT pg_catalog.array_agg(t.tok) INTO v_tokens
  FROM (
    SELECT DISTINCT u.tok
    FROM pg_catalog.unnest(COALESCE(p_lexical_tokens, '{}'::text[])) AS u(tok)
    WHERE u.tok <> '' AND pg_catalog.octet_length(u.tok) <= 255 AND u.tok !~ '[''\\[:space:]]'
    LIMIT 64
  ) AS t;
  v_tsq := public.rag_lexical_tsquery(v_tokens);

  SELECT pg_catalog.array_agg(DISTINCT j.value) INTO v_profiles
  FROM pg_catalog.jsonb_each_text(v_eff) AS j(key, value)
  WHERE p_doc_types IS NULL OR j.key = ANY (p_doc_types);

  IF p_lexical_limit = 0 OR v_tsq IS NULL OR v_profiles IS NULL
     OR (p_lexical_languages IS NOT NULL AND pg_catalog.cardinality(p_lexical_languages) = 0) THEN
    RETURN;
  END IF;

  SELECT s.status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the tenant has no ready lexical statistics' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(pg_catalog.sum(lc.chunk_count), 0)::double precision,
         pg_catalog.sum(lc.total_len)::double precision / NULLIF(pg_catalog.sum(lc.chunk_count), 0)::double precision
  INTO v_n, v_avgdl
  FROM public.rag_lexical_corpus lc
  WHERE lc.tenant_key = p_tenant_key AND lc.corpus = 'chunks' AND lc.chunking_profile_id = ANY (v_profiles)
    AND (p_lexical_languages IS NULL OR lc.language = ANY (p_lexical_languages) OR lc.language = 'und');
  IF v_n IS NULL OR v_n <= 0 OR v_avgdl IS NULL OR v_avgdl <= 0 THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the request statistics hold no chunk' USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.array_agg(t.tok ORDER BY t.tok),
         pg_catalog.array_agg(pg_catalog.ln(1 + (v_n - x.df + 0.5) / (x.df + 0.5)) ORDER BY t.tok)
  INTO v_tokens, v_idfs
  FROM pg_catalog.unnest(v_tokens) AS t(tok)
  CROSS JOIN LATERAL (
    SELECT LEAST(GREATEST(COALESCE(pg_catalog.sum(d.df), 0)::double precision, 1), v_n) AS df
    FROM public.rag_lexical_df d
    WHERE d.tenant_key = p_tenant_key AND d.corpus = 'chunks' AND d.lexeme = t.tok AND d.chunking_profile_id = ANY (v_profiles)
      AND (p_lexical_languages IS NULL OR d.language = ANY (p_lexical_languages) OR d.language = 'und')
  ) AS x;

  IF COALESCE(p_include_undated, false) THEN
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3 OR c.doc_date IS NULL)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4 OR c.doc_date IS NULL)';
  ELSE
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4)';
  END IF;

  -- The lexical filter of hybrid_search_chunks (0856) with the effective-profile map bound as $24.
  v_filter :=
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text($24::jsonb) AS ep(doc_type, profile_id) WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'' AND c.chunk_kind IN (''image'', ''invoice_header''))'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM public.document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || v_date_filter
    || ' AND ($5::text[] IS NULL OR (pg_catalog.cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8) OR (c.language = ''und'' AND d.language = ANY($8)))'
    || ' AND ($9::text IS NULL OR pg_catalog.strpos(pg_catalog.lower(d.supplier_name), pg_catalog.lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  IF v_scope_region IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $16::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''region:'')))) ';
  END IF;
  IF v_scope_legal_entity IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $17::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''legal_entity:'')))) ';
  END IF;
  IF v_scope_department IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $18::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''department:'')))) ';
  END IF;
  IF p_effective_on IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.effective_from IS NULL OR c.effective_from <= $20::date)'
      || ' AND (c.effective_to IS NULL OR c.effective_to >= $20::date) ';
  END IF;

  IF p_identifiers_norm IS NOT NULL THEN
    v_filter := v_filter || ' AND /* identifier-document-filter:begin */ c.document_id IN (SELECT ic.document_id FROM public.document_chunks ic WHERE ic.tenant_key = $2 AND ic.status IN (''ready'', ''variant'') AND ic.identifiers_norm OPERATOR(pg_catalog.&&) $23::text[] AND ($31::text[] IS NULL OR ic.access_groups OPERATOR(pg_catalog.&&) $31::text[])) /* identifier-document-filter:end */ ';
  END IF;

  -- D-11, D-12: the caller's keys overlap the chunk's and its document's labels, before the candidate ORDER BY and LIMIT, as 0930 does.
  -- p_access_all (admin) is decided here and never bound. Without keys (switch off) the text is exactly the 0904 text.
  IF p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN
    v_filter := v_filter || ' AND c.access_groups && $31::text[]'
      || ' AND d.access_groups && $31::text[] ';
  END IF;

  IF v_scope_mode = 'range' THEN
    v_has_eff := (
      SELECT pg_catalog.count(*) = 2 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname IN ('effective_from', 'effective_to') AND NOT attisdropped
    );
    IF v_has_eff THEN
      v_start_d := 'COALESCE(d.effective_from, (d.created_at AT TIME ZONE ''UTC'')::date)';
      v_start_s := 'COALESCE(s.effective_from, (s.created_at AT TIME ZONE ''UTC'')::date)';
    ELSE
      v_start_d := '(d.created_at AT TIME ZONE ''UTC'')::date';
      v_start_s := '(s.created_at AT TIME ZONE ''UTC'')::date';
    END IF;
    v_filter := v_filter
      || ' AND ($22::date IS NULL OR ' || v_start_d || ' <= $22::date)'
      || ' AND ($21::date IS NULL OR '
      || CASE WHEN v_has_eff THEN '(d.effective_to IS NOT NULL AND d.effective_to >= $21::date) OR (d.effective_to IS NULL AND ' ELSE '(' END
      || 'NOT EXISTS (SELECT 1 FROM public.documents s WHERE s.id = d.superseded_by AND s.tenant_key = $2 AND '
      || v_start_s || ' <= $21::date))) ';
  END IF;

  -- The version-scope widening of the 0856 lexical leg.
  IF v_scope_mode IN ('all', 'range') THEN
    v_filter := pg_catalog.replace(
      pg_catalog.replace(v_filter, ' c.tenant_key = $2 AND c.is_current AND ',
        ' c.tenant_key = $2 AND (c.is_current OR (NOT c.is_current AND NOT c.provisional AND d.tenant_key = $2 AND NOT d.is_current'
        || ' AND d.status = ''ready'' AND NOT d.provisional AND d.superseded_by IS NOT NULL'
        || ' AND EXISTS (SELECT 1 FROM public.documents sd WHERE sd.id = d.superseded_by AND sd.tenant_key = $2'
        || ' AND sd.content_hash IS DISTINCT FROM d.content_hash))) AND '),
      'c2.is_current AND c2.chunking_profile_id', 'c2.is_current = c.is_current AND c2.chunking_profile_id'
    );
  END IF;

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, pg_catalog.left(d.content, 200), %L::text, c.dup_cluster_id, c.is_current, d.version ';

  RETURN QUERY EXECUTE
    'WITH q AS MATERIALIZED (SELECT u.tok, u.idf, pg_catalog.quote_literal(u.tok)::pg_catalog.tsquery AS tsq'
    || ' FROM ROWS FROM (pg_catalog.unnest($28::text[]), pg_catalog.unnest($29::double precision[])) AS u(tok, idf)), '
    || 'cand AS MATERIALIZED (SELECT c.id AS hid,'
    || ' (SELECT pg_catalog.sum(q.idf * pg_catalog.ts_rank(c.lexical_tsv, q.tsq, 0)) FROM q) AS s1'
    || ' FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id WHERE ' || v_filter
    || ' AND ($14::text[] IS NULL OR (pg_catalog.cardinality($14) > 0 AND (c.language = ANY($14) OR (c.language = ''und'' AND d.language = ANY($14)))))'
    || ' AND c.lexical_tsv @@ $1 ORDER BY s1 DESC, c.id LIMIT NULLIF($27, 0)), '
    || 'scored AS (SELECT cand.hid, (SELECT pg_catalog.sum(q.idf * u.tf * ($25 + 1) / (u.tf + $25 * (1 - $26 + $26 * u.dl / $30)))'
    || ' FROM (SELECT x.lexeme, pg_catalog.cardinality(x.positions)::double precision AS tf,'
    || ' (pg_catalog.sum(pg_catalog.cardinality(x.positions)) OVER ())::double precision AS dl'
    || ' FROM pg_catalog.unnest(c.lexical_tsv) AS x(lexeme, positions, weights)) u JOIN q ON q.tok = u.lexeme) AS score'
    || ' FROM cand JOIN public.document_chunks c ON c.id = cand.hid), '
    || 'top AS (SELECT s.hid, s.score, (pg_catalog.row_number() OVER (ORDER BY s.score DESC, s.hid))::integer AS rnk'
    || ' FROM scored s ORDER BY s.score DESC, s.hid LIMIT $13) '
    || 'SELECT ''lexical''::text, t.rnk, '
    || pg_catalog.format(
      v_sel,
      CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
        THEN pg_catalog.format('(1 - (c.embedding OPERATOR(public.<=>) $15::public.vector(%s)))::double precision', v_dims)
        ELSE 'NULL::double precision' END,
      't.score::real',
      'n/a'
    )
    || ' FROM top t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.rnk'
    USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
      p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding,
      v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
      v_range_from, v_range_to, p_identifiers_norm, v_eff, p_k1, p_b, p_candidate_limit, v_tokens, v_idfs, v_avgdl, v_anchor_keys;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer, text[], boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer, text[], boolean
) TO service_role;


-- rag_exact_id_documents: the 0930 body; both branches take the document-level fragment. SECURITY INVOKER (as 0930).
CREATE OR REPLACE FUNCTION public.rag_exact_id_documents(
  p_tenant_key text,
  p_tokens text[],
  p_limit integer,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (chunk_id uuid, document_id uuid, content text, metadata jsonb, matched_field text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  tokens text[];
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_scope_mode text := 'current';
  v_widen boolean;
  v_range boolean;
  v_range_from date;
  v_range_to date;
  v_part text;
  v_restrict boolean;
  v_anchor_keys text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
  v_anchor_keys := CASE WHEN v_restrict THEN p_access_keys END;

  IF p_version_scope IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_version_scope) <> 'object'
       OR pg_catalog.jsonb_typeof(p_version_scope -> 'mode') IS DISTINCT FROM 'string'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_version_scope) AS k(name) WHERE k.name NOT IN ('mode', 'from', 'to')) THEN
      RAISE EXCEPTION 'invalid_version_scope: an object with mode current, all or range' USING ERRCODE = '22023';
    END IF;
    v_scope_mode := p_version_scope ->> 'mode';
    IF v_scope_mode NOT IN ('current', 'all', 'range') THEN
      RAISE EXCEPTION 'invalid_version_scope: unknown mode' USING ERRCODE = '22023';
    END IF;
    IF v_scope_mode <> 'range' AND (p_version_scope ? 'from' OR p_version_scope ? 'to') THEN
      RAISE EXCEPTION 'invalid_version_scope: from and to need mode range' USING ERRCODE = '22023';
    END IF;
    FOREACH v_part IN ARRAY ARRAY['from', 'to'] LOOP
      CONTINUE WHEN NOT p_version_scope ? v_part;
      IF pg_catalog.jsonb_typeof(p_version_scope -> v_part) <> 'string'
         OR (p_version_scope ->> v_part) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END IF;
      BEGIN
        IF v_part = 'from' THEN v_range_from := (p_version_scope ->> v_part)::date; ELSE v_range_to := (p_version_scope ->> v_part)::date; END IF;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END;
    END LOOP;
    IF v_range_from IS NOT NULL AND v_range_to IS NOT NULL AND v_range_from > v_range_to THEN
      RAISE EXCEPTION 'invalid_version_scope: from is later than to' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'rag_exact_id_documents: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;
  v_widen := v_scope_mode IN ('all', 'range');
  v_range := v_scope_mode = 'range';

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
      WHERE d.tenant_key = p_tenant_key AND d.status = 'ready'
        AND c.tenant_key = p_tenant_key AND c.status = 'ready'
        AND ((d.is_current AND c.is_current) OR (v_widen AND NOT c.is_current AND public.rag_version_history_ok(c.document_id, p_tenant_key) AND NOT c.provisional))
        AND c.chunk_kind IN ('invoice_header', 'table')
        AND (lower(d.invoice_number) = ANY (tokens) OR lower(d.supplier_tax_id) = ANY (tokens))
        AND (p_identifiers_norm IS NULL OR /* identifier-document-filter:begin */ c.document_id IN (SELECT ic.document_id FROM public.document_chunks ic WHERE ic.tenant_key = p_tenant_key AND ic.status IN ('ready', 'variant') AND ic.identifiers_norm OPERATOR(pg_catalog.&&) p_identifiers_norm AND (v_anchor_keys IS NULL OR ic.access_groups OPERATOR(pg_catalog.&&) v_anchor_keys)) /* identifier-document-filter:end */)
        AND (NOT v_restrict OR (c.access_groups && p_access_keys AND d.access_groups && p_access_keys))
        AND (NOT v_range OR public.rag_version_period_ok(c.document_id, p_tenant_key, v_range_from, v_range_to))
      UNION ALL
      SELECT c.id, c.document_id, c.content, c.metadata, 'lexical_text'::text, 2, c.created_at, c.chunk_index
      FROM public.document_chunks c
      WHERE c.tenant_key = p_tenant_key AND c.status = 'ready'
        AND (c.is_current OR (v_widen AND NOT c.provisional AND public.rag_version_history_ok(c.document_id, p_tenant_key)))
        AND c.lexical_text IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest(tokens) AS k(token)
          WHERE lower(c.lexical_text) ~ ('(^|[^[:alnum:]_-])' || regexp_replace(k.token, '([][\\.^$|?*+(){}-])', '\\\1', 'g') || '($|[^[:alnum:]_-])')
        )
        AND (p_identifiers_norm IS NULL OR /* identifier-document-filter:begin */ c.document_id IN (SELECT ic.document_id FROM public.document_chunks ic WHERE ic.tenant_key = p_tenant_key AND ic.status IN ('ready', 'variant') AND ic.identifiers_norm OPERATOR(pg_catalog.&&) p_identifiers_norm AND (v_anchor_keys IS NULL OR ic.access_groups OPERATOR(pg_catalog.&&) v_anchor_keys)) /* identifier-document-filter:end */)
        AND (NOT v_range OR public.rag_version_period_ok(c.document_id, p_tenant_key, v_range_from, v_range_to))
        AND (NOT v_restrict OR (c.access_groups && p_access_keys
          AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = c.document_id AND d.tenant_key = p_tenant_key AND d.access_groups && p_access_keys)))
    ) m
    ORDER BY m.id, m.priority
  ) hit
  ORDER BY (hit.matched_field = 'lexical_text'), hit.created_at, hit.chunk_index, hit.id
  LIMIT cap;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_exact_id_documents(text, text[], integer, jsonb, text[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_exact_id_documents(text, text[], integer, jsonb, text[], text[], boolean) TO service_role;

-- rag_table_lookup: the 0933 body; each qualifying chunk takes the document-level fragment.
CREATE OR REPLACE FUNCTION public.rag_table_lookup(
  p_tenant_key text,
  p_tokens text[],
  p_min_cells integer,
  p_limit integer,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  row_id uuid,
  document_id uuid,
  table_key text,
  row_index integer,
  header text[],
  cells jsonb,
  matched_cells integer,
  chunk_ids uuid[],
  chunk_id uuid,
  content text,
  metadata jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_restrict boolean;
  v_anchor_keys text[];
  v_tokens text[];
  v_scope_mode text := 'current';
  v_widen boolean;
  v_range boolean;
  v_range_from date;
  v_range_to date;
  v_part text;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
  v_anchor_keys := CASE WHEN v_restrict THEN p_access_keys END;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'rag_table_lookup: limit must be within 1..50' USING ERRCODE = '22023';
  END IF;
  IF p_min_cells IS NULL OR p_min_cells < 1 OR p_min_cells > 10 THEN
    RAISE EXCEPTION 'rag_table_lookup: min_cells must be within 1..10' USING ERRCODE = '22023';
  END IF;
  IF p_tokens IS NOT NULL AND pg_catalog.cardinality(p_tokens) > 64 THEN
    RAISE EXCEPTION 'rag_table_lookup: at most 64 tokens' USING ERRCODE = '22023';
  END IF;
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'rag_table_lookup: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;

  IF p_version_scope IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_version_scope) <> 'object'
       OR pg_catalog.jsonb_typeof(p_version_scope -> 'mode') IS DISTINCT FROM 'string'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_version_scope) AS k(name) WHERE k.name NOT IN ('mode', 'from', 'to')) THEN
      RAISE EXCEPTION 'invalid_version_scope: an object with mode current, all or range' USING ERRCODE = '22023';
    END IF;
    v_scope_mode := p_version_scope ->> 'mode';
    IF v_scope_mode NOT IN ('current', 'all', 'range') THEN
      RAISE EXCEPTION 'invalid_version_scope: unknown mode' USING ERRCODE = '22023';
    END IF;
    IF v_scope_mode <> 'range' AND (p_version_scope ? 'from' OR p_version_scope ? 'to') THEN
      RAISE EXCEPTION 'invalid_version_scope: from and to need mode range' USING ERRCODE = '22023';
    END IF;
    FOREACH v_part IN ARRAY ARRAY['from', 'to'] LOOP
      CONTINUE WHEN NOT p_version_scope ? v_part;
      IF pg_catalog.jsonb_typeof(p_version_scope -> v_part) <> 'string'
         OR (p_version_scope ->> v_part) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END IF;
      BEGIN
        IF v_part = 'from' THEN v_range_from := (p_version_scope ->> v_part)::date; ELSE v_range_to := (p_version_scope ->> v_part)::date; END IF;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END;
    END LOOP;
    IF v_range_from IS NOT NULL AND v_range_to IS NOT NULL AND v_range_from > v_range_to THEN
      RAISE EXCEPTION 'invalid_version_scope: from is later than to' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_widen := v_scope_mode IN ('all', 'range');
  v_range := v_scope_mode = 'range';

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT t), ARRAY[]::text[]) INTO v_tokens
  FROM (
    SELECT pg_catalog.btrim(raw) AS t FROM pg_catalog.unnest(COALESCE(p_tokens, ARRAY[]::text[])) AS u(raw)
    WHERE raw IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(raw)) BETWEEN 1 AND 200
  ) cleaned;
  IF pg_catalog.cardinality(v_tokens) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH eff AS (
    SELECT dt.doc_type,
           COALESCE(
             (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
             'legacy'
           ) AS profile_id
    FROM pg_catalog.unnest(v_doc_types) AS dt(doc_type)
  ),
  candidates AS (
    SELECT r.id, r.document_id, r.table_key, r.row_index, r.header, r.cells, r.chunk_ids,
           (
             SELECT pg_catalog.count(DISTINCT t.cell)::integer
             FROM pg_catalog.jsonb_array_elements(r.cell_tokens) AS t(cell)
             WHERE pg_catalog.jsonb_typeof(t.cell) = 'array'
               AND pg_catalog.jsonb_array_length(t.cell) > 0
               AND NOT EXISTS (
                 SELECT 1 FROM pg_catalog.jsonb_array_elements_text(t.cell) AS x(token) WHERE NOT (x.token = ANY (v_tokens))
               )
           ) AS matched
    FROM public.rag_table_rows r
    WHERE r.tenant_key = p_tenant_key
      AND r.cell_norm OPERATOR(pg_catalog.&&) v_tokens
      AND (NOT v_restrict OR r.access_groups OPERATOR(pg_catalog.&&) p_access_keys)
  ),
  qualified AS (
    SELECT m.id, m.document_id, m.table_key, m.row_index, m.header, m.cells, m.matched,
           (
             SELECT pg_catalog.array_agg(c.id ORDER BY c.chunk_index, c.id)
             FROM public.document_chunks c
             JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
             WHERE c.id = ANY (m.chunk_ids)
               AND c.document_id = m.document_id
               AND c.tenant_key = p_tenant_key
               AND c.status IN ('ready', 'variant')
               AND d.status = 'ready'
               AND (NOT v_restrict OR (c.access_groups OPERATOR(pg_catalog.&&) p_access_keys AND d.access_groups OPERATOR(pg_catalog.&&) p_access_keys))
               AND (
                 (d.is_current AND c.is_current)
                 OR (v_widen AND NOT c.is_current AND NOT c.provisional AND public.rag_version_history_ok(c.document_id, p_tenant_key))
               )
               AND EXISTS (
                 SELECT 1 FROM eff ep WHERE ep.doc_type = c.doc_type AND (
                   c.chunking_profile_id = ep.profile_id
                   OR (ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy' AND c.chunk_kind IN ('image', 'invoice_header'))
                   OR (ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy'
                       AND NOT EXISTS (
                         SELECT 1 FROM public.document_chunks c2
                         WHERE c2.document_id = c.document_id AND c2.tenant_key = p_tenant_key
                           AND c2.is_current = c.is_current AND c2.chunking_profile_id = ep.profile_id
                       ))
                 )
               )
               AND (p_identifiers_norm IS NULL OR /* identifier-document-filter:begin */ c.document_id IN (SELECT ic.document_id FROM public.document_chunks ic WHERE ic.tenant_key = p_tenant_key AND ic.status IN ('ready', 'variant') AND ic.identifiers_norm OPERATOR(pg_catalog.&&) p_identifiers_norm AND (v_anchor_keys IS NULL OR ic.access_groups OPERATOR(pg_catalog.&&) v_anchor_keys)) /* identifier-document-filter:end */)
               AND (NOT v_range OR public.rag_version_period_ok(c.document_id, p_tenant_key, v_range_from, v_range_to))
           ) AS qualified_chunks
    FROM candidates m
    WHERE m.matched >= p_min_cells
  )
  SELECT q.id, q.document_id, q.table_key, q.row_index, q.header, q.cells, q.matched, q.qualified_chunks,
         fc.id, fc.content, fc.metadata
  FROM qualified q
  JOIN public.document_chunks fc ON fc.id = q.qualified_chunks[1] AND fc.tenant_key = p_tenant_key
  WHERE q.qualified_chunks IS NOT NULL
  ORDER BY q.matched DESC, q.row_index, q.document_id, q.table_key, q.id
  LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_table_lookup(text, text[], integer, integer, jsonb, text[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_table_lookup(text, text[], integer, integer, jsonb, text[], text[], boolean) TO service_role;

COMMIT;

-- ==== supabase/migrations/0938_bm25_search_df_mode.sql
-- 0938: rag_bm25_search_chunks gains p_df_mode text DEFAULT 'raw' (Phase 4.4 plan 04.4-17, D-46, D-49), appended after the last 0936
-- argument. raw (or omitted) reads the statistics of corpus 'chunks' exactly as 0936 does: the generated SQL text and its bind values are
-- the 0936 ones. cluster reads corpus 'chunks_cluster' (0905: a duplicate cluster counts once per chunking profile and language) for N,
-- avgdl and df; every chunk is still scored with its own term frequencies and length. cluster on a tenant whose cluster_status is not
-- 'ready' raises lexical_cluster_stats_not_ready (55000), after the raw readiness check; the app then serves raw BM25 (D-49). Any other
-- value raises 22023.
-- Body: the 0936 body (Phase 4.2 plan 04.2-40), with the text between identifier-document-filter:begin and :end, the 0930/0932 access
-- predicate and the access_scope_required / access_keys_empty guards unchanged; the only edits are the parameter, its validation, the
-- cluster readiness check and the corpus value of the two statistics reads. This number replaces the 0935 claim of 04.4-16, which sorts
-- before 0936 (0936's catalog drop would discard it); 0935 stays an empty placeholder.
-- Every rag_bm25_search_chunks overload is dropped by catalog lookup first, so exactly one exists. SECURITY INVOKER, VOLATILE, empty
-- search_path, revoked from PUBLIC, anon and authenticated, granted to service_role.
-- Precheck (55000): the 0936 body is in place (identifier fragment, access parameters), 0905's cluster_status column and ledger exist,
-- and the function has no argument outside the 0936 signature plus p_df_mode (a later parameter is rebuilt on this body in a later file).
-- Operator rule: after re-running 0904, re-run 0932, 0936 and then this file; after re-running 0932, re-run 0936 and then this file; after
-- re-running 0936, re-run this file. On a database that already has this file, 0936 stops at its own precheck (55000, p_df_mode is outside
-- the 0932 signature): re-run 0932 first, then 0936, then this file.
-- Idempotent; one common file for both deployment modes (as 0932 and 0936); not folded into the setup files.

BEGIN;

DO $dfmode_precheck$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks'
         AND p.proargnames @> ARRAY['p_identifiers_norm', 'p_access_keys', 'p_access_all']::text[]
         AND pg_catalog.strpos(p.prosrc, 'identifier-document-filter:begin') > 0
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.rag_lexical_stats_state'::pg_catalog.regclass AND attname = 'cluster_status' AND NOT attisdropped
     )
     OR pg_catalog.to_regclass('public.rag_lexical_cluster_units') IS NULL THEN
    RAISE EXCEPTION '0938: apply 0905 and 0936 first' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.unnest(p.proargnames) AS a(name)
    WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks'
      AND a.name <> ALL (ARRAY[
        'p_tenant_key', 'p_profile_id', 'p_query_embedding', 'p_lexical_tokens', 'p_lexical_limit', 'p_date_from', 'p_date_to', 'p_sources',
        'p_document_ids', 'p_doc_types', 'p_languages', 'p_lexical_languages', 'p_supplier', 'p_amount_min', 'p_amount_max', 'p_currency',
        'p_chunking_override', 'p_include_undated', 'p_scopes', 'p_scopes_include_untagged', 'p_effective_on', 'p_version_scope',
        'p_identifiers_norm', 'p_k1', 'p_b', 'p_candidate_limit', 'p_access_keys', 'p_access_all', 'p_df_mode',
        'leg', 'rank', 'chunk_id', 'document_id', 'content', 'metadata', 'chunk_index', 'similarity', 'lexical_score', 'doc_type', 'language',
        'parent_id', 'section_path', 'chunk_kind', 'document_filename', 'document_created_at', 'document_metadata', 'document_content_preview',
        'dense_mode', 'dup_cluster_id', 'is_current', 'document_version'
      ]::text[])
  ) THEN
    RAISE EXCEPTION '0938: rag_bm25_search_chunks has an argument outside the 0936 signature and p_df_mode; rebuild it on this body in a later file' USING ERRCODE = '55000';
  END IF;
END
$dfmode_precheck$;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

-- rag_bm25_search_chunks: the 0936 body with p_df_mode.
CREATE OR REPLACE FUNCTION public.rag_bm25_search_chunks(
  p_tenant_key text,
  p_profile_id text,
  p_query_embedding public.vector,
  p_lexical_tokens text[],
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_lexical_languages text[] DEFAULT NULL,
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL,
  p_include_undated boolean DEFAULT false,
  p_scopes text[] DEFAULT NULL,
  p_scopes_include_untagged boolean DEFAULT false,
  p_effective_on date DEFAULT NULL,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_k1 double precision DEFAULT 1.2,
  p_b double precision DEFAULT 0.75,
  p_candidate_limit integer DEFAULT 500,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false,
  p_df_mode text DEFAULT 'raw'
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text,
  dense_mode text,
  dup_cluster_id uuid,
  is_current boolean,
  document_version integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_anchor_keys text[];
  v_dims integer;
  v_storage text;
  v_tsq pg_catalog.tsquery;
  v_tokens text[];
  v_idfs double precision[];
  v_filter text;
  v_date_filter text;
  v_sel text;
  v_key text;
  v_val text;
  v_tag text;
  v_dim text;
  v_scope_region text[];
  v_scope_legal_entity text[];
  v_scope_department text[];
  v_scope_mode text := 'current';
  v_range_from date;
  v_range_to date;
  v_part text;
  v_has_eff boolean;
  v_start_d text;
  v_start_s text;
  v_eff jsonb;
  v_profiles text[];
  v_status text;
  v_cluster_status text;
  v_corpus text;
  v_n double precision;
  v_avgdl double precision;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  -- D-09, D-10: no keys while enforcement is on is refused; an empty key array never means "no filter" (as 0930).
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  -- 04.2-40: the access slot carries the keys only on a restricted call; the 0930 predicate reads it only then, the identifier anchor always.
  v_anchor_keys := CASE WHEN p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN p_access_keys END;

  IF p_lexical_limit IS NULL OR p_lexical_limit NOT BETWEEN 0 AND 200
     OR p_candidate_limit IS NULL OR p_candidate_limit NOT BETWEEN 0 AND 2000 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_k1 IS NULL OR p_k1 = 'NaN'::double precision OR p_k1 < 0.5 OR p_k1 > 3 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: k1 out of range' USING ERRCODE = '22023';
  END IF;
  IF p_b IS NULL OR p_b = 'NaN'::double precision OR p_b < 0 OR p_b > 1 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: b out of range' USING ERRCODE = '22023';
  END IF;
  -- 04.4-17 (D-49): the statistics corpus. raw reads corpus chunks (the 0936 reads); cluster reads chunks_cluster (0905, D-46).
  IF p_df_mode IS NULL OR p_df_mode NOT IN ('raw', 'cluster') THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: df mode is raw or cluster' USING ERRCODE = '22023';
  END IF;
  v_corpus := CASE WHEN p_df_mode = 'cluster' THEN 'chunks_cluster' ELSE 'chunks' END;

  IF p_chunking_override IS NOT NULL AND pg_catalog.jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT j.key, j.value FROM pg_catalog.jsonb_each_text(p_chunking_override) AS j(key, value) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_scopes IS NOT NULL THEN
    FOREACH v_tag IN ARRAY p_scopes LOOP
      v_dim := CASE WHEN v_tag IS NULL OR pg_catalog.strpos(v_tag, ':') = 0 THEN NULL ELSE pg_catalog.split_part(v_tag, ':', 1) END;
      IF v_dim IS NULL OR pg_catalog.length(v_tag) <= pg_catalog.length(v_dim) + 1 THEN
        RAISE EXCEPTION 'invalid_scope: a tag is dimension:value' USING ERRCODE = '22023';
      ELSIF v_dim = 'region' THEN
        v_scope_region := pg_catalog.array_append(v_scope_region, v_tag);
      ELSIF v_dim = 'legal_entity' THEN
        v_scope_legal_entity := pg_catalog.array_append(v_scope_legal_entity, v_tag);
      ELSIF v_dim = 'department' THEN
        v_scope_department := pg_catalog.array_append(v_scope_department, v_tag);
      ELSE
        RAISE EXCEPTION 'invalid_scope: unknown dimension' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_version_scope IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_version_scope) <> 'object'
       OR pg_catalog.jsonb_typeof(p_version_scope -> 'mode') IS DISTINCT FROM 'string'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_version_scope) AS k(name) WHERE k.name NOT IN ('mode', 'from', 'to')) THEN
      RAISE EXCEPTION 'invalid_version_scope: an object with mode current, all or range' USING ERRCODE = '22023';
    END IF;
    v_scope_mode := p_version_scope ->> 'mode';
    IF v_scope_mode NOT IN ('current', 'all', 'range') THEN
      RAISE EXCEPTION 'invalid_version_scope: unknown mode' USING ERRCODE = '22023';
    END IF;
    IF v_scope_mode <> 'range' AND (p_version_scope ? 'from' OR p_version_scope ? 'to') THEN
      RAISE EXCEPTION 'invalid_version_scope: from and to need mode range' USING ERRCODE = '22023';
    END IF;
    FOREACH v_part IN ARRAY ARRAY['from', 'to'] LOOP
      CONTINUE WHEN NOT p_version_scope ? v_part;
      IF pg_catalog.jsonb_typeof(p_version_scope -> v_part) <> 'string'
         OR (p_version_scope ->> v_part) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END IF;
      BEGIN
        IF v_part = 'from' THEN v_range_from := (p_version_scope ->> v_part)::date; ELSE v_range_to := (p_version_scope ->> v_part)::date; END IF;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END;
    END LOOP;
    IF v_range_from IS NOT NULL AND v_range_to IS NOT NULL AND v_range_from > v_range_to THEN
      RAISE EXCEPTION 'invalid_version_scope: from is later than to' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL AND public.vector_dims(p_query_embedding) <> v_dims THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  -- The effective chunking profile of each doc type, by the rule of hybrid_search_chunks: the override, else the active profile, else legacy.
  SELECT pg_catalog.jsonb_object_agg(dt.doc_type, COALESCE(
           NULLIF(pg_catalog.btrim(p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         ))
  INTO v_eff
  FROM pg_catalog.unnest(v_doc_types) AS dt(doc_type);

  SELECT pg_catalog.array_agg(t.tok) INTO v_tokens
  FROM (
    SELECT DISTINCT u.tok
    FROM pg_catalog.unnest(COALESCE(p_lexical_tokens, '{}'::text[])) AS u(tok)
    WHERE u.tok <> '' AND pg_catalog.octet_length(u.tok) <= 255 AND u.tok !~ '[''\\[:space:]]'
    LIMIT 64
  ) AS t;
  v_tsq := public.rag_lexical_tsquery(v_tokens);

  SELECT pg_catalog.array_agg(DISTINCT j.value) INTO v_profiles
  FROM pg_catalog.jsonb_each_text(v_eff) AS j(key, value)
  WHERE p_doc_types IS NULL OR j.key = ANY (p_doc_types);

  IF p_lexical_limit = 0 OR v_tsq IS NULL OR v_profiles IS NULL
     OR (p_lexical_languages IS NOT NULL AND pg_catalog.cardinality(p_lexical_languages) = 0) THEN
    RETURN;
  END IF;

  SELECT s.status, s.cluster_status INTO v_status, v_cluster_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the tenant has no ready lexical statistics' USING ERRCODE = '55000';
  END IF;
  -- D-49: the caller falls back to raw BM25 on this error; it is never a refusal.
  IF p_df_mode = 'cluster' AND v_cluster_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'lexical_cluster_stats_not_ready: the tenant has no ready cluster statistics' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(pg_catalog.sum(lc.chunk_count), 0)::double precision,
         pg_catalog.sum(lc.total_len)::double precision / NULLIF(pg_catalog.sum(lc.chunk_count), 0)::double precision
  INTO v_n, v_avgdl
  FROM public.rag_lexical_corpus lc
  WHERE lc.tenant_key = p_tenant_key AND lc.corpus = v_corpus AND lc.chunking_profile_id = ANY (v_profiles)
    AND (p_lexical_languages IS NULL OR lc.language = ANY (p_lexical_languages) OR lc.language = 'und');
  IF v_n IS NULL OR v_n <= 0 OR v_avgdl IS NULL OR v_avgdl <= 0 THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the request statistics hold no chunk' USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.array_agg(t.tok ORDER BY t.tok),
         pg_catalog.array_agg(pg_catalog.ln(1 + (v_n - x.df + 0.5) / (x.df + 0.5)) ORDER BY t.tok)
  INTO v_tokens, v_idfs
  FROM pg_catalog.unnest(v_tokens) AS t(tok)
  CROSS JOIN LATERAL (
    SELECT LEAST(GREATEST(COALESCE(pg_catalog.sum(d.df), 0)::double precision, 1), v_n) AS df
    FROM public.rag_lexical_df d
    WHERE d.tenant_key = p_tenant_key AND d.corpus = v_corpus AND d.lexeme = t.tok AND d.chunking_profile_id = ANY (v_profiles)
      AND (p_lexical_languages IS NULL OR d.language = ANY (p_lexical_languages) OR d.language = 'und')
  ) AS x;

  IF COALESCE(p_include_undated, false) THEN
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3 OR c.doc_date IS NULL)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4 OR c.doc_date IS NULL)';
  ELSE
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4)';
  END IF;

  -- The lexical filter of hybrid_search_chunks (0856) with the effective-profile map bound as $24.
  v_filter :=
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text($24::jsonb) AS ep(doc_type, profile_id) WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'' AND c.chunk_kind IN (''image'', ''invoice_header''))'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM public.document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || v_date_filter
    || ' AND ($5::text[] IS NULL OR (pg_catalog.cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8) OR (c.language = ''und'' AND d.language = ANY($8)))'
    || ' AND ($9::text IS NULL OR pg_catalog.strpos(pg_catalog.lower(d.supplier_name), pg_catalog.lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  IF v_scope_region IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $16::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''region:'')))) ';
  END IF;
  IF v_scope_legal_entity IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $17::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''legal_entity:'')))) ';
  END IF;
  IF v_scope_department IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $18::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''department:'')))) ';
  END IF;
  IF p_effective_on IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.effective_from IS NULL OR c.effective_from <= $20::date)'
      || ' AND (c.effective_to IS NULL OR c.effective_to >= $20::date) ';
  END IF;

  IF p_identifiers_norm IS NOT NULL THEN
    v_filter := v_filter || ' AND /* identifier-document-filter:begin */ c.document_id IN (SELECT ic.document_id FROM public.document_chunks ic WHERE ic.tenant_key = $2 AND ic.status IN (''ready'', ''variant'') AND ic.identifiers_norm OPERATOR(pg_catalog.&&) $23::text[] AND ($31::text[] IS NULL OR ic.access_groups OPERATOR(pg_catalog.&&) $31::text[])) /* identifier-document-filter:end */ ';
  END IF;

  -- D-11, D-12: the caller's keys overlap the chunk's and its document's labels, before the candidate ORDER BY and LIMIT, as 0930 does.
  -- p_access_all (admin) is decided here and never bound. Without keys (switch off) the text is exactly the 0904 text.
  IF p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN
    v_filter := v_filter || ' AND c.access_groups && $31::text[]'
      || ' AND d.access_groups && $31::text[] ';
  END IF;

  IF v_scope_mode = 'range' THEN
    v_has_eff := (
      SELECT pg_catalog.count(*) = 2 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname IN ('effective_from', 'effective_to') AND NOT attisdropped
    );
    IF v_has_eff THEN
      v_start_d := 'COALESCE(d.effective_from, (d.created_at AT TIME ZONE ''UTC'')::date)';
      v_start_s := 'COALESCE(s.effective_from, (s.created_at AT TIME ZONE ''UTC'')::date)';
    ELSE
      v_start_d := '(d.created_at AT TIME ZONE ''UTC'')::date';
      v_start_s := '(s.created_at AT TIME ZONE ''UTC'')::date';
    END IF;
    v_filter := v_filter
      || ' AND ($22::date IS NULL OR ' || v_start_d || ' <= $22::date)'
      || ' AND ($21::date IS NULL OR '
      || CASE WHEN v_has_eff THEN '(d.effective_to IS NOT NULL AND d.effective_to >= $21::date) OR (d.effective_to IS NULL AND ' ELSE '(' END
      || 'NOT EXISTS (SELECT 1 FROM public.documents s WHERE s.id = d.superseded_by AND s.tenant_key = $2 AND '
      || v_start_s || ' <= $21::date))) ';
  END IF;

  -- The version-scope widening of the 0856 lexical leg.
  IF v_scope_mode IN ('all', 'range') THEN
    v_filter := pg_catalog.replace(
      pg_catalog.replace(v_filter, ' c.tenant_key = $2 AND c.is_current AND ',
        ' c.tenant_key = $2 AND (c.is_current OR (NOT c.is_current AND NOT c.provisional AND d.tenant_key = $2 AND NOT d.is_current'
        || ' AND d.status = ''ready'' AND NOT d.provisional AND d.superseded_by IS NOT NULL'
        || ' AND EXISTS (SELECT 1 FROM public.documents sd WHERE sd.id = d.superseded_by AND sd.tenant_key = $2'
        || ' AND sd.content_hash IS DISTINCT FROM d.content_hash))) AND '),
      'c2.is_current AND c2.chunking_profile_id', 'c2.is_current = c.is_current AND c2.chunking_profile_id'
    );
  END IF;

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, pg_catalog.left(d.content, 200), %L::text, c.dup_cluster_id, c.is_current, d.version ';

  RETURN QUERY EXECUTE
    'WITH q AS MATERIALIZED (SELECT u.tok, u.idf, pg_catalog.quote_literal(u.tok)::pg_catalog.tsquery AS tsq'
    || ' FROM ROWS FROM (pg_catalog.unnest($28::text[]), pg_catalog.unnest($29::double precision[])) AS u(tok, idf)), '
    || 'cand AS MATERIALIZED (SELECT c.id AS hid,'
    || ' (SELECT pg_catalog.sum(q.idf * pg_catalog.ts_rank(c.lexical_tsv, q.tsq, 0)) FROM q) AS s1'
    || ' FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id WHERE ' || v_filter
    || ' AND ($14::text[] IS NULL OR (pg_catalog.cardinality($14) > 0 AND (c.language = ANY($14) OR (c.language = ''und'' AND d.language = ANY($14)))))'
    || ' AND c.lexical_tsv @@ $1 ORDER BY s1 DESC, c.id LIMIT NULLIF($27, 0)), '
    || 'scored AS (SELECT cand.hid, (SELECT pg_catalog.sum(q.idf * u.tf * ($25 + 1) / (u.tf + $25 * (1 - $26 + $26 * u.dl / $30)))'
    || ' FROM (SELECT x.lexeme, pg_catalog.cardinality(x.positions)::double precision AS tf,'
    || ' (pg_catalog.sum(pg_catalog.cardinality(x.positions)) OVER ())::double precision AS dl'
    || ' FROM pg_catalog.unnest(c.lexical_tsv) AS x(lexeme, positions, weights)) u JOIN q ON q.tok = u.lexeme) AS score'
    || ' FROM cand JOIN public.document_chunks c ON c.id = cand.hid), '
    || 'top AS (SELECT s.hid, s.score, (pg_catalog.row_number() OVER (ORDER BY s.score DESC, s.hid))::integer AS rnk'
    || ' FROM scored s ORDER BY s.score DESC, s.hid LIMIT $13) '
    || 'SELECT ''lexical''::text, t.rnk, '
    || pg_catalog.format(
      v_sel,
      CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
        THEN pg_catalog.format('(1 - (c.embedding OPERATOR(public.<=>) $15::public.vector(%s)))::double precision', v_dims)
        ELSE 'NULL::double precision' END,
      't.score::real',
      'n/a'
    )
    || ' FROM top t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.rnk'
    USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
      p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding,
      v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
      v_range_from, v_range_to, p_identifiers_norm, v_eff, p_k1, p_b, p_candidate_limit, v_tokens, v_idfs, v_avgdl, v_anchor_keys;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer, text[], boolean, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer, text[], boolean, text
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0992_rag_purge_hook_finetune.sql
-- 0992: rag_purge_hook_finetune, the Phase 6.3 purge hook for the Phase 6.1 fine-tune stores (FT-01, FT-10, D-29; 06.1 verification IW-1).
-- The tenant-keyed stores are rag_finetune_consent (one row per tenant) and embedding_model_versions.tenant_keys (the tenants a version
-- was trained on). Neither holds a document id, and the registry cannot tell which documents a version's training set held, so:
--   * a document purge (p_lineage_id or p_document_ids given) taints every version trained on the tenant that is not tainted yet: its
--     weights may hold the purged text. The consent row and the keys stay. Listed ids of another tenant's documents are refused (22023);
--     ids of documents that no longer exist are accepted.
--   * a tenant purge (no lineage and no document ids) deletes the tenant's consent row, taints every version trained on it and removes
--     its key from their tenant_keys.
-- Taint goes through the status column, so the 0654 taint trigger drops slot evidence and deactivates serving bindings as for a revoke;
-- a version that is ACTIVE keeps serving until rollback (D-25), as after a revoke. A tainted version may be left with no tenant key, so
-- the two tenant_keys constraints of 0651 now allow an empty list once tainted_at is set. Returns consent rows deleted plus versions
-- changed. The hook checks the tenant key first (rag_assert_tenant_key: a key of the other deployment mode raises 22023).
-- SECURITY INVOKER (inside the 6.3 purge it runs with that definer's rights); empty search_path; service_role only.
-- Additive and idempotent. Not folded into the setup files.

BEGIN;

DO $finetune_purge_hook_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regclass('public.rag_finetune_consent') IS NULL
     OR pg_catalog.to_regclass('public.embedding_model_versions') IS NULL THEN
    RAISE EXCEPTION '0992: apply 0403 and 0651 first' USING ERRCODE = '55000';
  END IF;
END
$finetune_purge_hook_precheck$;

ALTER TABLE public.embedding_model_versions DROP CONSTRAINT IF EXISTS embedding_model_versions_tenant_keys_shape;
ALTER TABLE public.embedding_model_versions ADD CONSTRAINT embedding_model_versions_tenant_keys_shape CHECK (
  (pg_catalog.cardinality(tenant_keys) = 0 AND tainted_at IS NOT NULL)
  OR (
    pg_catalog.cardinality(tenant_keys) >= 1
    AND pg_catalog.array_to_string(tenant_keys, ',', '?') ~
      '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(,(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))*$'
  )
);
ALTER TABLE public.embedding_model_versions DROP CONSTRAINT IF EXISTS embedding_model_versions_tenant_scope_single;
ALTER TABLE public.embedding_model_versions ADD CONSTRAINT embedding_model_versions_tenant_scope_single CHECK (
  scope <> 'tenant' OR pg_catalog.cardinality(tenant_keys) = 1 OR (pg_catalog.cardinality(tenant_keys) = 0 AND tainted_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION public.rag_purge_hook_finetune(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_tenant_purge boolean;
  v_consent bigint := 0;
  v_versions bigint := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  v_tenant_purge := p_lineage_id IS NULL AND coalesce(pg_catalog.cardinality(p_document_ids), 0) = 0;

  IF NOT v_tenant_purge AND EXISTS (
    SELECT 1
    FROM public.documents d
    WHERE (d.id = ANY (coalesce(p_document_ids, '{}'::uuid[])) OR (p_lineage_id IS NOT NULL AND d.lineage_id = p_lineage_id))
      AND d.tenant_key IS DISTINCT FROM p_tenant_key
  ) THEN
    RAISE EXCEPTION 'purge_refused: a listed document belongs to another tenant' USING ERRCODE = '22023';
  END IF;

  IF v_tenant_purge THEN
    DELETE FROM public.rag_finetune_consent c WHERE c.tenant_key = p_tenant_key;
    GET DIAGNOSTICS v_consent = ROW_COUNT;

    UPDATE public.embedding_model_versions v
    SET status = 'tainted',
        tainted_at = coalesce(v.tainted_at, pg_catalog.now()),
        tenant_keys = pg_catalog.array_remove(v.tenant_keys, p_tenant_key),
        updated_at = pg_catalog.now()
    WHERE p_tenant_key = ANY (v.tenant_keys);
    GET DIAGNOSTICS v_versions = ROW_COUNT;
  ELSE
    UPDATE public.embedding_model_versions v
    SET status = 'tainted', tainted_at = pg_catalog.now(), updated_at = pg_catalog.now()
    WHERE p_tenant_key = ANY (v.tenant_keys)
      AND v.status <> 'tainted';
    GET DIAGNOSTICS v_versions = ROW_COUNT;
  END IF;

  RETURN v_consent + v_versions;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_finetune(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_finetune(text, uuid, uuid[]) TO service_role;

-- Phase 6.3 store inventory. Guarded as in 0976: this file creates no Phase 6.3 object. rag_purge_store_inventory() is not on trunk,
-- so the block only reports; Phase 6.3 (06.3-19) lists rag_finetune_consent and embedding_model_versions (store finetune, handling
-- purge_step) itself.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_purge_store_inventory()') IS NULL THEN
    RAISE NOTICE '[0992] rag_purge_store_inventory() is missing; registration left to Phase 6.3';
    RETURN;
  END IF;
  RAISE NOTICE '[0992] rag_purge_store_inventory() exists; it lists the finetune stores itself';
END
$do$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0410 r24 delta (the guarded lines train 42 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
BEGIN;
DO $r24_service_role_only$
BEGIN
  IF to_regprocedure('public.rag_source_purge_reserve(text, uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_purge_reserve(text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_purge_reserve(text, uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_purge_release(text, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_purge_release(text, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_purge_release(text, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_purge_hold(text, uuid, text[], integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_purge_hold(text, uuid, text[], integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_purge_hold(text, uuid, text[], integer) TO service_role;
  END IF;
END
$r24_service_role_only$;
COMMIT;

NOTIFY pgrst, 'reload schema';

-- ==== Verify (read-only; run after the apply)
-- 1. Migration objects exist (expect every value true).
SELECT to_regclass('public.rag_source_purge_daily_usage') IS NOT NULL AS t0729_usage_table,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_source_reconcile_runs'
               AND column_name = 'pause_reason') AS t0729_pause_reason,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_lexical_stats_state'
               AND column_name = 'cluster_status') AS t0905_cluster_status,
       to_regclass('public.rag_lexical_cluster_dirty') IS NOT NULL AS t0905_dirty,
       to_regclass('public.rag_lexical_cluster_units') IS NOT NULL AS t0905_units,
       to_regprocedure('public.rag_purge_hook_finetune(text, uuid, uuid[])') IS NOT NULL AS t0992_hook;

-- 2. New tables: RLS on, no policy.
SELECT c.relname, c.relrowsecurity,
       (SELECT count(*) FROM pg_catalog.pg_policy pol WHERE pol.polrelid = c.oid) AS policies
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('rag_source_purge_daily_usage', 'rag_lexical_cluster_dirty', 'rag_lexical_cluster_units')
ORDER BY 1;
-- Expect three rows, relrowsecurity true, policies 0.

-- 3. Exactly one overload of each redefined search function; rag_bm25_search_chunks ends with p_df_mode text DEFAULT 'raw'.
SELECT p.proname, count(*) AS overloads
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('hybrid_search_chunks', 'rag_bm25_search_chunks', 'rag_exact_id_documents', 'rag_table_lookup')
GROUP BY 1 ORDER BY 1;
-- Expect four rows with overloads 1.
SELECT (pg_catalog.pg_get_function_arguments(p.oid) LIKE '%p_df_mode text DEFAULT ''raw''::text') AS df_mode_last
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks';
-- Expect true.

-- 4. Grants and search_path: anon and authenticated cannot execute any function this train adds or redefines.
SELECT p.oid::regprocedure AS signature, p.prosecdef AS security_definer, p.proconfig AS config,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'rag\_source\_purge\_%' OR p.proname LIKE 'rag\_lexstats\_%' OR p.proname LIKE 'rag\_lexical\_%'
       OR p.proname IN ('hybrid_search_chunks', 'rag_bm25_search_chunks', 'rag_exact_id_documents', 'rag_table_lookup',
                        'rag_purge_hook_lexical_stats', 'rag_purge_hook_finetune'))
ORDER BY 1;
-- Expect anon_exec and authenticated_exec false everywhere, service_role_exec true everywhere, config {search_path=""}.

-- 5. The identifier fragment is in all four redefined functions (0936; expect 4).
SELECT count(*) AS with_fragment
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('hybrid_search_chunks', 'rag_bm25_search_chunks', 'rag_exact_id_documents', 'rag_table_lookup')
  AND p.prosrc LIKE '%identifier-document-filter:begin%';

-- 6. Defaults unchanged: no tenant has cluster statistics on and no run is paused by the cap (expect 0 and 0).
SELECT (SELECT count(*) FROM public.rag_lexical_stats_state WHERE cluster_status IS NOT NULL) AS cluster_tenants,
       (SELECT count(*) FROM public.rag_source_reconcile_runs WHERE pause_reason IS NOT NULL) AS paused_runs;

-- 7. The widened fine-tune constraints (expect two rows).
SELECT conname FROM pg_catalog.pg_constraint
WHERE conrelid = 'public.embedding_model_versions'::regclass
  AND conname IN ('embedding_model_versions_tenant_keys_shape', 'embedding_model_versions_tenant_scope_single')
ORDER BY 1;

-- 8. Access readiness (expect ready: 0936 keeps the access predicate in every leg).
SELECT public.rag_access_readiness();
