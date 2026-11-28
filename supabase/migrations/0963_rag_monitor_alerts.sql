-- 0963: rag_monitor_alerts, the monitor's deduplicated alerts (Phase 5.3, D-22, D-25, D-26, OBS-03).
-- An alert holds ids, counts, rates, rule names, key names and hashes only: no query, answer, chunk, document name or user text.
-- Every text column is a code under a CHECK, and every string and key inside the jsonb columns is a code without spaces.
-- One non-resolved alert per (tenant_key, dedup_key): rag_monitor_alert_upsert updates the open or acknowledged row on a later day,
-- and a resolved alert is not reopened by the same or an earlier day. The uniqueness is per tenant, so a dedup key can never
-- update another tenant's alert. tenant_key is in the 0701 form and the upsert checks it with rag_assert_tenant_key.
-- Access: RLS on with no policy; no grant to PUBLIC, anon or authenticated; only service_role reads and writes.
-- Functions are SECURITY INVOKER with an empty search_path, service_role only (O-3). Idempotent, not folded (D-56).

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_monitor_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  rule text NOT NULL,
  kind text NOT NULL,
  language text NOT NULL,
  day date NOT NULL,
  window_days integer NOT NULL DEFAULT 1,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  observed_count integer NOT NULL DEFAULT 0,
  observed_total integer NOT NULL DEFAULT 0,
  baseline_count integer NOT NULL DEFAULT 0,
  baseline_total integer NOT NULL DEFAULT 0,
  observed_rate double precision NULL,
  baseline_rate double precision NULL,
  band jsonb NOT NULL DEFAULT '{}'::jsonb,
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  companions jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_trace_ids text[] NOT NULL DEFAULT '{}'::text[],
  config_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggestion text NULL,
  delivered jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedup_key text NOT NULL,
  acknowledged_at timestamptz NULL,
  acknowledged_by uuid NULL,
  resolved_at timestamptz NULL,
  resolved_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_monitor_alerts_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_monitor_alerts_rule_check CHECK (rule IN (
    'refusal_rate', 'zero_result_rate', 'below_threshold_rate', 'not_helpful_rate', 'groundedness_flagged_rate',
    'kb_error_rate', 'kb_degraded_rate', 'kb_unavailable_rate', 'top_score_psi', 'latency_p95', 'online_judge_mean',
    'test_set_not_representative', 'offline_online_gap', 'language_drop'
  )),
  CONSTRAINT rag_monitor_alerts_kind_check CHECK (kind IN (
    'rate', 'distribution', 'latency', 'judge_mean', 'drift', 'offline_online_gap', 'language_drop'
  )),
  CONSTRAINT rag_monitor_alerts_language_check CHECK (language = 'all' OR language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  CONSTRAINT rag_monitor_alerts_window_days_check CHECK (window_days BETWEEN 1 AND 90),
  CONSTRAINT rag_monitor_alerts_severity_check CHECK (severity IN ('warning', 'alert')),
  CONSTRAINT rag_monitor_alerts_status_check CHECK (status IN ('open', 'acknowledged', 'resolved')),
  CONSTRAINT rag_monitor_alerts_counts_check CHECK (
    observed_count >= 0 AND observed_total >= 0 AND baseline_count >= 0 AND baseline_total >= 0
  ),
  CONSTRAINT rag_monitor_alerts_sample_trace_ids_check CHECK (
    cardinality(sample_trace_ids) <= 10
    AND (
      cardinality(sample_trace_ids) = 0
      OR (
        array_ndims(sample_trace_ids) = 1
        AND array_position(sample_trace_ids, NULL) IS NULL
        AND array_to_string(sample_trace_ids, ',') ~ '^[A-Za-z0-9_-]{1,128}(,[A-Za-z0-9_-]{1,128})*$'
      )
    )
  ),
  CONSTRAINT rag_monitor_alerts_suggestion_check CHECK (suggestion IS NULL OR suggestion ~ '^[a-z0-9_.:-]{1,64}$'),
  CONSTRAINT rag_monitor_alerts_dedup_key_check CHECK (dedup_key ~ '^[A-Za-z0-9_.:|/-]{1,200}$'),
  CONSTRAINT rag_monitor_alerts_jsonb_shape_check CHECK (
    jsonb_typeof(band) = 'object' AND jsonb_typeof(breakdown) = 'object' AND jsonb_typeof(companions) = 'object'
    AND jsonb_typeof(config_changes) = 'array' AND jsonb_array_length(config_changes) <= 50
    AND jsonb_typeof(delivered) = 'object'
  ),
  CONSTRAINT rag_monitor_alerts_jsonb_codes_check CHECK (
    NOT jsonb_path_exists(
      jsonb_build_array(band, breakdown, companions, config_changes, delivered),
      '$.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_.:+@/-]{1,128}$"))'
    )
    AND NOT jsonb_path_exists(
      jsonb_build_array(band, breakdown, companions, config_changes, delivered),
      '$.** ? (@.type() == "object").keyvalue() ? (!(@.key like_regex "^[A-Za-z0-9_.:+@/-]{1,64}$"))'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_monitor_alerts_open_dedup_key
  ON public.rag_monitor_alerts (tenant_key, dedup_key) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_rag_monitor_alerts_tenant_day ON public.rag_monitor_alerts (tenant_key, day DESC);
CREATE INDEX IF NOT EXISTS idx_rag_monitor_alerts_status_day ON public.rag_monitor_alerts (status, day DESC);

ALTER TABLE public.rag_monitor_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_monitor_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_monitor_alerts TO service_role;

-- Returns the id of the open or acknowledged alert of the payload's (tenant_key, dedup_key), inserting it when none exists.
-- Returns NULL and changes nothing when the latest alert of that key is resolved and its day is not before the payload's day.
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
    band, breakdown, companions, sample_trace_ids, config_changes, suggestion, delivered, dedup_key
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

-- open -> acknowledged, and open or acknowledged -> resolved; every other transition returns false and changes nothing.
CREATE OR REPLACE FUNCTION public.rag_monitor_alert_set_status(p_id uuid, p_status text, p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_updated integer := 0;
BEGIN
  IF p_status = 'acknowledged' THEN
    UPDATE public.rag_monitor_alerts a
       SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = p_actor, updated_at = now()
     WHERE a.id = p_id AND a.status = 'open';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF p_status = 'resolved' THEN
    UPDATE public.rag_monitor_alerts a
       SET status = 'resolved', resolved_at = now(), resolved_by = p_actor, updated_at = now()
     WHERE a.id = p_id AND a.status IN ('open', 'acknowledged');
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;
  RETURN v_updated = 1;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_alert_set_status(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_alert_set_status(uuid, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
