-- Train 32 combined live SQL (ci/merge-train-32). Apply after train 31 (0944, 0972-0975, 0977, 1009, 0410 r15) is live.
-- Production is multi-tenant. One new migration, no mode variant, not folded. 0978 needs 0963 (rag_monitor_alerts, live since train 29).
-- It replaces rag_monitor_alert_upsert (last defined in 0963) with the 0963 body plus cluster_ids. No 0410 delta (r15 unchanged):
-- rag_monitor_alert_upsert is SECURITY INVOKER and 0978 itself revokes it from PUBLIC, anon and authenticated and grants service_role.
-- 06-45 folds 0601-0603 into both setup files; that affects fresh projects only, nothing to apply live.
-- DROP sections: none (no DROP statement in 0978).

-- ==== 0978_rag_monitor_alert_cluster_ids.sql
-- 0978: rag_monitor_alerts.cluster_ids, the cluster ids an alert names (Phase 5.3, D-45, OBS-03; plan 05.3-33).
-- test_set_not_representative names the under-covered cluster ids of the weekly drift report; 0963 had no column for them, so
-- the upsert dropped them. Cluster ids are short id tokens (the ClusterId contract pattern), at most 64 per alert; no text.
-- rag_monitor_alert_upsert is replaced with the 0963 body plus cluster_ids (set on insert and on update).
-- SECURITY INVOKER with an empty search_path, service_role only (O-3). Idempotent, not folded (D-56).

BEGIN;

ALTER TABLE public.rag_monitor_alerts ADD COLUMN IF NOT EXISTS cluster_ids text[] NOT NULL DEFAULT '{}'::text[];

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'rag_monitor_alerts_cluster_ids_check' AND conrelid = 'public.rag_monitor_alerts'::regclass
  ) THEN
    ALTER TABLE public.rag_monitor_alerts ADD CONSTRAINT rag_monitor_alerts_cluster_ids_check CHECK (
      cardinality(cluster_ids) <= 64
      AND (
        cardinality(cluster_ids) = 0
        OR (
          array_ndims(cluster_ids) = 1
          AND array_position(cluster_ids, NULL) IS NULL
          AND array_to_string(cluster_ids, ',') ~ '^[a-z0-9][a-z0-9_-]{0,63}(,[a-z0-9][a-z0-9_-]{0,63})*$'
        )
      )
    );
  END IF;
END
$do$;

CREATE OR REPLACE FUNCTION public.rag_monitor_alert_upsert(p_alert jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_tenant text;
  v_dedup text;
  v_day date;
  v_traces text[];
  v_clusters text[];
  v_id uuid;
BEGIN
  IF p_alert IS NULL OR jsonb_typeof(p_alert) <> 'object' THEN
    RAISE EXCEPTION 'alert payload must be an object' USING ERRCODE = '22023';
  END IF;

  v_tenant := p_alert ->> 'tenant_key';
  PERFORM public.rag_assert_tenant_key(v_tenant);

  v_dedup := p_alert ->> 'dedup_key';
  IF v_dedup IS NULL OR (p_alert ->> 'day') IS NULL THEN
    RAISE EXCEPTION 'alert payload needs dedup_key and day' USING ERRCODE = '22023';
  END IF;
  v_day := (p_alert ->> 'day')::date;

  IF p_alert ? 'sample_trace_ids' AND jsonb_typeof(p_alert -> 'sample_trace_ids') <> 'array' THEN
    RAISE EXCEPTION 'sample_trace_ids must be an array' USING ERRCODE = '22023';
  END IF;
  v_traces := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(COALESCE(p_alert -> 'sample_trace_ids', '[]'::jsonb)));

  IF p_alert ? 'cluster_ids' AND jsonb_typeof(p_alert -> 'cluster_ids') <> 'array' THEN
    RAISE EXCEPTION 'cluster_ids must be an array' USING ERRCODE = '22023';
  END IF;
  v_clusters := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(COALESCE(p_alert -> 'cluster_ids', '[]'::jsonb)));

  IF NOT EXISTS (
    SELECT 1 FROM public.rag_monitor_alerts a
     WHERE a.tenant_key = v_tenant AND a.dedup_key = v_dedup AND a.status <> 'resolved'
  ) AND EXISTS (
    SELECT 1 FROM public.rag_monitor_alerts a
     WHERE a.tenant_key = v_tenant AND a.dedup_key = v_dedup AND a.status = 'resolved' AND a.day >= v_day
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.rag_monitor_alerts AS t (
    tenant_key, rule, kind, language, day, window_days, severity, status,
    observed_count, observed_total, baseline_count, baseline_total, observed_rate, baseline_rate,
    band, breakdown, companions, sample_trace_ids, cluster_ids, config_changes, suggestion, delivered, dedup_key
  ) VALUES (
    v_tenant,
    p_alert ->> 'rule',
    p_alert ->> 'kind',
    p_alert ->> 'language',
    v_day,
    COALESCE((p_alert ->> 'window_days')::integer, 1),
    p_alert ->> 'severity',
    'open',
    COALESCE((p_alert ->> 'observed_count')::integer, 0),
    COALESCE((p_alert ->> 'observed_total')::integer, 0),
    COALESCE((p_alert ->> 'baseline_count')::integer, 0),
    COALESCE((p_alert ->> 'baseline_total')::integer, 0),
    (p_alert ->> 'observed_rate')::double precision,
    (p_alert ->> 'baseline_rate')::double precision,
    COALESCE(p_alert -> 'band', '{}'::jsonb),
    COALESCE(p_alert -> 'breakdown', '{}'::jsonb),
    COALESCE(p_alert -> 'companions', '{}'::jsonb),
    v_traces,
    v_clusters,
    COALESCE(p_alert -> 'config_changes', '[]'::jsonb),
    p_alert ->> 'suggestion',
    COALESCE(p_alert -> 'delivered', '{}'::jsonb),
    v_dedup
  )
  ON CONFLICT (tenant_key, dedup_key) WHERE status <> 'resolved' DO UPDATE SET
    day = EXCLUDED.day,
    window_days = EXCLUDED.window_days,
    severity = EXCLUDED.severity,
    observed_count = EXCLUDED.observed_count,
    observed_total = EXCLUDED.observed_total,
    baseline_count = EXCLUDED.baseline_count,
    baseline_total = EXCLUDED.baseline_total,
    observed_rate = EXCLUDED.observed_rate,
    baseline_rate = EXCLUDED.baseline_rate,
    band = EXCLUDED.band,
    breakdown = EXCLUDED.breakdown,
    companions = EXCLUDED.companions,
    sample_trace_ids = EXCLUDED.sample_trace_ids,
    cluster_ids = EXCLUDED.cluster_ids,
    config_changes = EXCLUDED.config_changes,
    suggestion = EXCLUDED.suggestion,
    delivered = t.delivered || EXCLUDED.delivered,
    updated_at = now()
  WHERE EXCLUDED.day >= t.day
  RETURNING t.id INTO v_id;

  IF v_id IS NULL THEN
    SELECT a.id INTO v_id FROM public.rag_monitor_alerts a
     WHERE a.tenant_key = v_tenant AND a.dedup_key = v_dedup AND a.status <> 'resolved';
  END IF;

  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_alert_upsert(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_alert_upsert(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
