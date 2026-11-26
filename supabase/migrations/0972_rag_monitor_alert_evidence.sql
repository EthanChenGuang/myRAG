-- 0972: rag_monitor_alert_evidence, the evidence of one monitor alert (Phase 5.3, D-26, D-27, OBS-03).
-- Returns { sample_trace_ids, config_hash_firsts } for one tenant:
--   sample_trace_ids: at most least(p_limit, 10) trace ids of the tenant's log rows created in [p_from, p_to) that match p_match,
--     ordered by md5(trace_id) so the sample is deterministic; p_language 'all' drops the language filter (und for a null language).
--     Only trace ids in the alert table's form are returned.
--   config_hash_firsts: [{ hash, first_at }] for every retrieval_config_hash (64 or fewer lowercase hex characters) whose first
--     appearance in the tenant's log falls in [p_from - 2 days, p_to).
-- p_match is an object; a row matches when any listed condition holds (an empty object matches every row): status, outcome,
-- refusal_decision, refusal_reason (text lists), feedback_vote (number list), zero_result and groundedness_flagged (true).
-- The tenant comes only from p_tenant_key, checked first by rag_assert_tenant_key. Ids and hashes only, never text.
-- Without the Phase 5.1.1 log the function returns empty lists (to_regclass guard). SECURITY INVOKER, empty search_path,
-- service_role only (O-3). Idempotent, not folded (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_monitor_alert_evidence(
  p_tenant_key text, p_language text, p_from timestamptz, p_to timestamptz, p_match jsonb, p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_match jsonb := COALESCE(p_match, '{}'::jsonb);
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 10), 0), 10);
  v_key text;
  v_flagged text := 'false';
  v_conditions text[] := ARRAY[]::text[];
  v_where text;
  v_traces jsonb;
  v_hashes jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_from IS NULL OR p_to IS NULL OR p_language IS NULL THEN
    RAISE EXCEPTION 'language, from and to are required' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(v_match) <> 'object' THEN
    RAISE EXCEPTION 'p_match must be an object' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('sample_trace_ids', '[]'::jsonb, 'config_hash_firsts', '[]'::jsonb);
  END IF;

  FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(v_match) AS k ORDER BY k LOOP
    IF v_key IN ('status', 'outcome', 'refusal_decision', 'refusal_reason') THEN
      IF pg_catalog.jsonb_typeof(v_match -> v_key) <> 'array' THEN
        RAISE EXCEPTION 'p_match.% must be a list', v_key USING ERRCODE = '22023';
      END IF;
      v_conditions := v_conditions || pg_catalog.format('l.%I = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($1 -> %L)))', v_key, v_key);
    ELSIF v_key = 'feedback_vote' THEN
      IF pg_catalog.jsonb_typeof(v_match -> v_key) <> 'array' THEN
        RAISE EXCEPTION 'p_match.feedback_vote must be a list' USING ERRCODE = '22023';
      END IF;
      v_conditions := v_conditions
        || 'l.feedback_vote::text = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($1 -> ''feedback_vote'')))';
    ELSIF v_key = 'zero_result' THEN
      IF (v_match -> v_key) = 'true'::jsonb THEN
        v_conditions := v_conditions || $c$(l.candidate_count = 0 AND l.status IN ('ok', 'empty') AND l.outcome <> 'kb_unavailable'
          AND l.refusal_decision IS DISTINCT FROM 'refuse')$c$;
      END IF;
    ELSIF v_key = 'groundedness_flagged' THEN
      IF (v_match -> v_key) = 'true'::jsonb AND pg_catalog.to_regclass('public.rag_answer_records') IS NOT NULL THEN
        v_flagged := $c$EXISTS (SELECT 1 FROM public.rag_answer_records a
          WHERE a.trace_id = l.trace_id AND a.tenant_key = l.tenant_key AND a.groundedness ->> 'label' = 'possibly_unreliable')$c$;
      END IF;
      IF (v_match -> v_key) = 'true'::jsonb THEN
        v_conditions := v_conditions || v_flagged;
      END IF;
    ELSE
      RAISE EXCEPTION 'unknown p_match key %', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_where := CASE
    WHEN pg_catalog.cardinality(v_conditions) = 0 AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_match)) = 0
      THEN 'true'
    WHEN pg_catalog.cardinality(v_conditions) = 0 THEN 'false'
    ELSE '(' || pg_catalog.array_to_string(v_conditions, ' OR ') || ')'
  END;

  EXECUTE pg_catalog.format($sql$
    SELECT COALESCE(pg_catalog.jsonb_agg(s.trace_id ORDER BY s.ord), '[]'::jsonb)
      FROM (
        SELECT l.trace_id, pg_catalog.md5(l.trace_id) AS ord
          FROM public.rag_retrieval_log l
         WHERE l.tenant_key = $2
           AND l.created_at >= $3 AND l.created_at < $4
           AND ($5 = 'all' OR COALESCE(l.query_language, 'und') = $5)
           AND l.trace_id ~ '^[A-Za-z0-9_-]{1,128}$'
           AND %s
         ORDER BY pg_catalog.md5(l.trace_id), l.trace_id
         LIMIT $6
      ) s
  $sql$, v_where)
  INTO v_traces
  USING v_match, p_tenant_key, p_from, p_to, p_language, v_limit;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('hash', f.hash, 'first_at', f.first_at) ORDER BY f.first_at, f.hash), '[]'::jsonb)
    INTO v_hashes
    FROM (
      SELECT l.retrieval_config_hash AS hash, pg_catalog.min(l.created_at) AS first_at
        FROM public.rag_retrieval_log l
       WHERE l.tenant_key = p_tenant_key
         AND l.retrieval_config_hash ~ '^[a-f0-9]{8,64}$'
         AND l.created_at < p_to
       GROUP BY l.retrieval_config_hash
    ) f
   WHERE f.first_at >= p_from - interval '2 days';

  RETURN pg_catalog.jsonb_build_object('sample_trace_ids', v_traces, 'config_hash_firsts', v_hashes);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_alert_evidence(text, text, timestamptz, timestamptz, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_alert_evidence(text, text, timestamptz, timestamptz, jsonb, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
