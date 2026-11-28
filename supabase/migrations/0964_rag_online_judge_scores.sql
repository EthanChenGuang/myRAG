-- 0964: rag_online_judge_scores, online judge scores mirrored for the monitor (Phase 5.3, D-23, D-55, OBS-03).
-- One number per (trace_id, metric, judge_id): no query, answer, chunk or document text. rag_monitor_aggregate (0971) joins the
-- scores to the retrieval log by trace_id to fill judged and the score sums of rag_monitor_daily.
-- rag_online_judge_scores_record takes the tenant from the retrieval log row of the trace, never from its input: a payload
-- tenant_key is ignored, and a score whose trace is in no log row is dropped and counted. The lookup is guarded with to_regclass,
-- so the file applies on a database without the Phase 5.1.1 tables and the function then stores nothing.
-- Scores do not cascade from the log: they stay so the daily aggregate can be recomputed, and rag_monitor_purge (replaced here)
-- removes scores older than the same window as the daily cells.
-- Access: RLS on with no policy; no grant to PUBLIC, anon or authenticated; only service_role reads and writes.
-- Functions are SECURITY INVOKER with an empty search_path, service_role only (O-3). Idempotent, not folded (D-56).

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_online_judge_scores (
  tenant_key text NOT NULL,
  trace_id text NOT NULL,
  metric text NOT NULL,
  score real NOT NULL,
  judge_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trace_id, metric, judge_id),
  CONSTRAINT rag_online_judge_scores_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_online_judge_scores_trace_id_check CHECK (trace_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT rag_online_judge_scores_metric_check CHECK (metric IN ('faithfulness', 'answer_relevance')),
  CONSTRAINT rag_online_judge_scores_score_check CHECK (score >= 0 AND score <= 1),
  CONSTRAINT rag_online_judge_scores_judge_id_check CHECK (judge_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$')
);

CREATE INDEX IF NOT EXISTS idx_rag_online_judge_scores_tenant_created ON public.rag_online_judge_scores (tenant_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_online_judge_scores_created ON public.rag_online_judge_scores (created_at);

ALTER TABLE public.rag_online_judge_scores ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_online_judge_scores FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_online_judge_scores TO service_role;

-- p_scores is an array of at most 1000 objects { trace_id, metric, score, judge_id }; any malformed element rejects the call
-- (22023) before anything is written. Later elements win over earlier ones of the same (trace_id, metric, judge_id).
CREATE OR REPLACE FUNCTION public.rag_online_judge_scores_record(p_scores jsonb)
RETURNS TABLE (stored integer, dropped integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_item jsonb;
  v_trace text;
  v_tenant text;
  v_has_log boolean;
  v_stored integer := 0;
  v_dropped integer := 0;
BEGIN
  IF p_scores IS NULL OR jsonb_typeof(p_scores) <> 'array' THEN
    RAISE EXCEPTION 'scores must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_scores) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 scores per call' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT e FROM pg_catalog.jsonb_array_elements(p_scores) AS e LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR jsonb_typeof(v_item -> 'trace_id') IS DISTINCT FROM 'string'
       OR (v_item ->> 'trace_id') !~ '^[A-Za-z0-9_-]{1,128}$'
       OR jsonb_typeof(v_item -> 'metric') IS DISTINCT FROM 'string'
       OR (v_item ->> 'metric') NOT IN ('faithfulness', 'answer_relevance')
       OR jsonb_typeof(v_item -> 'score') IS DISTINCT FROM 'number'
       OR (v_item ->> 'score')::double precision < 0
       OR (v_item ->> 'score')::double precision > 1
       OR jsonb_typeof(v_item -> 'judge_id') IS DISTINCT FROM 'string'
       OR (v_item ->> 'judge_id') !~ '^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$' THEN
      RAISE EXCEPTION 'malformed judge score' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_has_log := pg_catalog.to_regclass('public.rag_retrieval_log') IS NOT NULL;

  FOR v_item IN SELECT e FROM pg_catalog.jsonb_array_elements(p_scores) AS e LOOP
    v_trace := v_item ->> 'trace_id';
    v_tenant := NULL;
    IF v_has_log THEN
      SELECT l.tenant_key INTO v_tenant FROM public.rag_retrieval_log l WHERE l.trace_id = v_trace;
    END IF;

    IF v_tenant IS NULL THEN
      v_dropped := v_dropped + 1;
      CONTINUE;
    END IF;

    PERFORM public.rag_assert_tenant_key(v_tenant);

    INSERT INTO public.rag_online_judge_scores AS s (tenant_key, trace_id, metric, score, judge_id)
    VALUES (v_tenant, v_trace, v_item ->> 'metric', (v_item ->> 'score')::real, v_item ->> 'judge_id')
    ON CONFLICT (trace_id, metric, judge_id) DO UPDATE SET
      tenant_key = EXCLUDED.tenant_key,
      score = EXCLUDED.score,
      updated_at = now();
    v_stored := v_stored + 1;
  END LOOP;

  stored := v_stored;
  dropped := v_dropped;
  RETURN NEXT;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_online_judge_scores_record(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_online_judge_scores_record(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_monitor_purge(p_keep_days integer DEFAULT 400)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_cells integer;
  v_scores integer;
BEGIN
  IF p_keep_days IS NULL OR p_keep_days < 1 THEN
    RAISE EXCEPTION 'keep days must be at least 1' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.rag_monitor_daily d WHERE d.day < CURRENT_DATE - p_keep_days;
  GET DIAGNOSTICS v_cells = ROW_COUNT;

  DELETE FROM public.rag_online_judge_scores s WHERE s.created_at < now() - pg_catalog.make_interval(days => p_keep_days);
  GET DIAGNOSTICS v_scores = ROW_COUNT;

  RETURN v_cells + v_scores;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_purge(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_purge(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
