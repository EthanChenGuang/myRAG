-- 0968: rag_drift_weekly, one row per tenant and week with the test-set drift numbers (Phase 5.3, D-43, D-55, EVAL-28).
-- Written by POST /api/rag/admin/monitor/drift after the app recomputes the state; read for the trend of the last 8 weeks.
-- week is the Monday that starts the ISO week; the upsert maps any date to that Monday.
-- report holds the numeric DriftReport fields only: cluster ids, shares, counts, gaps, rates, limits and states. Every key is
-- an identifier and every string value a short token without whitespace, so no query text or text label can be stored.
-- The upsert is SECURITY INVOKER with an empty search_path and checks the tenant key first (O-3). Service role only. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_drift_weekly (
  tenant_key text NOT NULL,
  week date NOT NULL,
  divergence real NOT NULL,
  null_p95 real,
  state text NOT NULL,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, week),
  CONSTRAINT rag_drift_weekly_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_drift_weekly_week_check CHECK (EXTRACT(ISODOW FROM week) = 1),
  CONSTRAINT rag_drift_weekly_divergence_check CHECK (divergence >= 0 AND divergence <= 1),
  CONSTRAINT rag_drift_weekly_null_p95_check CHECK (null_p95 IS NULL OR (null_p95 >= 0 AND null_p95 <= 1)),
  CONSTRAINT rag_drift_weekly_state_check CHECK (state IN ('ok', 'warn', 'alert')),
  CONSTRAINT rag_drift_weekly_report_check CHECK (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 131072)
);

ALTER TABLE public.rag_drift_weekly ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_drift_weekly FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_drift_weekly TO service_role;

-- Stores the report of one tenant and week, replacing an earlier one. Returns true when the row is new, false when replaced.
-- divergence and state are required, null_p95 is optional; invalid input raises 22023 and stores nothing.
CREATE OR REPLACE FUNCTION public.rag_drift_weekly_upsert(p_tenant_key text, p_week date, p_report jsonb)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_week date;
  v_divergence double precision;
  v_null_p95 double precision;
  v_state text;
  v_inserted boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_week IS NULL THEN
    RAISE EXCEPTION 'rag_drift_weekly_upsert: p_week is required' USING ERRCODE = '22023';
  END IF;
  IF p_report IS NULL OR pg_catalog.jsonb_typeof(p_report) IS DISTINCT FROM 'object'
     OR pg_catalog.octet_length(p_report::text) > 131072 THEN
    RAISE EXCEPTION 'rag_drift_weekly_upsert: p_report must be an object of at most 128 KiB' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_typeof(p_report -> 'divergence') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'rag_drift_weekly_upsert: divergence must be a number from 0 to 1' USING ERRCODE = '22023';
  END IF;
  v_divergence := (p_report ->> 'divergence')::double precision;
  IF v_divergence < 0 OR v_divergence > 1 THEN
    RAISE EXCEPTION 'rag_drift_weekly_upsert: divergence must be a number from 0 to 1' USING ERRCODE = '22023';
  END IF;

  IF p_report -> 'null_p95' IS NOT NULL AND pg_catalog.jsonb_typeof(p_report -> 'null_p95') IS DISTINCT FROM 'null' THEN
    IF pg_catalog.jsonb_typeof(p_report -> 'null_p95') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'rag_drift_weekly_upsert: null_p95 must be a number from 0 to 1' USING ERRCODE = '22023';
    END IF;
    v_null_p95 := (p_report ->> 'null_p95')::double precision;
    IF v_null_p95 < 0 OR v_null_p95 > 1 THEN
      RAISE EXCEPTION 'rag_drift_weekly_upsert: null_p95 must be a number from 0 to 1' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_state := CASE WHEN pg_catalog.jsonb_typeof(p_report -> 'state') = 'string' THEN p_report ->> 'state' END;
  IF v_state IS NULL OR v_state NOT IN ('ok', 'warn', 'alert') THEN
    RAISE EXCEPTION 'rag_drift_weekly_upsert: state must be ok, warn or alert' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    WITH RECURSIVE walk(value, key, depth) AS (
      SELECT p_report, NULL::text, 0
      UNION ALL
      SELECT child.value, child.key, w.depth + 1
      FROM walk w
      CROSS JOIN LATERAL (
        SELECT o.value, o.key
        FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(w.value) = 'object' THEN w.value ELSE '{}'::jsonb END) AS o
        UNION ALL
        SELECT a.value, NULL::text
        FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(w.value) = 'array' THEN w.value ELSE '[]'::jsonb END) AS a
      ) AS child
      WHERE w.depth < 8
    )
    SELECT 1
    FROM walk
    WHERE (walk.key IS NOT NULL AND NOT (walk.key ~ '^[A-Za-z0-9_]{1,64}$'))
       OR (pg_catalog.jsonb_typeof(walk.value) = 'string'
           AND NOT ((walk.value #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9._:=|/+-]{0,63}$'))
       OR (walk.depth = 8 AND pg_catalog.jsonb_typeof(walk.value) IN ('object', 'array'))
  ) THEN
    RAISE EXCEPTION 'rag_drift_weekly_upsert: report keys must be identifiers and string values short tokens' USING ERRCODE = '22023';
  END IF;

  v_week := p_week - (EXTRACT(ISODOW FROM p_week)::integer - 1);

  v_inserted := NOT EXISTS (
    SELECT 1 FROM public.rag_drift_weekly d WHERE d.tenant_key = p_tenant_key AND d.week = v_week
  );

  INSERT INTO public.rag_drift_weekly AS d (tenant_key, week, divergence, null_p95, state, report)
  VALUES (p_tenant_key, v_week, v_divergence::real, v_null_p95::real, v_state, p_report)
  ON CONFLICT (tenant_key, week) DO UPDATE
    SET divergence = EXCLUDED.divergence,
        null_p95 = EXCLUDED.null_p95,
        state = EXCLUDED.state,
        report = EXCLUDED.report,
        updated_at = pg_catalog.now();

  RETURN v_inserted;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_drift_weekly_upsert(text, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_drift_weekly_upsert(text, date, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
