-- 0535: rag_mine_failed_queries, the weekly mining of rag_retrieval_log into rag_review_items (Phase 5.1.1, FBK-05, D-13, D-15, D-03a, D-29).
-- Selects rows created in [p_since, p_until) with a masked query and a fingerprint, skips tenants that lowered their log level
-- (rag_tenant_feedback_settings.retrieval_log off or ids), and flags each row with the D-13 reasons:
--   feedback_negative     vote -1 on an answer or embed row, or a public.rag_answer_records feedback vote not_helpful on the same trace_id
--   refusal_disputed      refusal vote -1
--   groundedness_flagged  the answer record's groundedness label is possibly_unreliable
--   refused_high_score    outcome refused_no_context or refusal decision refuse, with top_score at or above the floor
--   zero_results          candidate_count 0 and outcome not kb_unavailable
--   low_score             answered with top_score below the ceiling
--   no_source_opened      answered, no source opened, p_config.source_open_signal true, and only together with another reason
-- Thresholds come from p_config (config/rag/feedback-mining.json), per scorer kind: rerank when any candidate carries rerank_score,
-- else similarity. Answer records join on trace_id and the same tenant_key. Rows are deduplicated by (tenant_key, query_fingerprint):
-- the newest row is the snapshot, occurrences counts the rows, and reasons is the union of the group's reasons in priority order.
-- At most per_tenant_limit items per tenant per run, best reason priority first. Each item copies tenant_key, user_id, chat_id, the
-- query, the language codes and the candidates from its own log row; tags stay empty. ON CONFLICT on (tenant_key, query_fingerprint,
-- mining_window) makes a re-run of the same window insert nothing. Returns per tenant and reason how many items were inserted.
-- Service role only (0410 section 1). Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_mine_failed_queries(p_since timestamptz, p_until timestamptz, p_config jsonb)
RETURNS TABLE (tenant_key text, reason text, inserted integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_limit integer;
  v_ttl_days integer;
  v_low_similarity double precision;
  v_low_rerank double precision;
  v_high_similarity double precision;
  v_high_rerank double precision;
  v_source_signal boolean;
  v_window timestamptz;
  v_path text[];
BEGIN
  IF p_since IS NULL OR p_until IS NULL OR p_since >= p_until THEN
    RAISE EXCEPTION 'invalid_window' USING ERRCODE = '22023', DETAIL = 'p_since and p_until are required and p_since must be before p_until';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'p_config must be a JSON object';
  END IF;

  FOREACH v_path SLICE 1 IN ARRAY ARRAY[
    ARRAY['per_tenant_limit', ''],
    ARRAY['open_item_ttl_days', ''],
    ARRAY['low_score_ceiling', 'similarity'],
    ARRAY['low_score_ceiling', 'rerank'],
    ARRAY['refused_high_score_floor', 'similarity'],
    ARRAY['refused_high_score_floor', 'rerank']
  ] LOOP
    IF jsonb_typeof(p_config #> array_remove(v_path, '')) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = array_to_string(array_remove(v_path, ''), '.') || ' must be a number';
    END IF;
  END LOOP;
  IF p_config ? 'source_open_signal' AND jsonb_typeof(p_config -> 'source_open_signal') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'source_open_signal must be a boolean';
  END IF;

  IF (p_config ->> 'per_tenant_limit')::numeric NOT BETWEEN 1 AND 1000
     OR (p_config ->> 'per_tenant_limit')::numeric <> trunc((p_config ->> 'per_tenant_limit')::numeric) THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'per_tenant_limit must be an integer from 1 to 1000';
  END IF;
  IF (p_config ->> 'open_item_ttl_days')::numeric NOT BETWEEN 1 AND 3650
     OR (p_config ->> 'open_item_ttl_days')::numeric <> trunc((p_config ->> 'open_item_ttl_days')::numeric) THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'open_item_ttl_days must be an integer from 1 to 3650';
  END IF;

  v_limit := (p_config ->> 'per_tenant_limit')::integer;
  v_ttl_days := (p_config ->> 'open_item_ttl_days')::integer;
  v_low_similarity := (p_config #>> '{low_score_ceiling,similarity}')::double precision;
  v_low_rerank := (p_config #>> '{low_score_ceiling,rerank}')::double precision;
  v_high_similarity := (p_config #>> '{refused_high_score_floor,similarity}')::double precision;
  v_high_rerank := (p_config #>> '{refused_high_score_floor,rerank}')::double precision;
  v_source_signal := coalesce((p_config ->> 'source_open_signal')::boolean, false);
  v_window := pg_catalog.date_trunc('week', p_until, 'UTC');

  RETURN QUERY
  WITH source_rows AS (
    SELECT l.id, l.tenant_key, l.trace_id, l.query_fingerprint, l.created_at, l.outcome, l.refusal_decision, l.top_score,
           l.candidate_count, l.feedback_vote, l.feedback_kind, l.source_opened_count,
           (l.candidates @? '$[*].rerank_score') AS reranked
    FROM public.rag_retrieval_log l
    WHERE l.created_at >= p_since
      AND l.created_at < p_until
      AND l.query_masked IS NOT NULL
      AND l.query_fingerprint IS NOT NULL
      AND l.tenant_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.rag_tenant_feedback_settings s
        WHERE s.tenant_key = l.tenant_key AND s.retrieval_log <> 'inherit'
      )
  ),
  flagged AS (
    SELECT r.id, r.tenant_key, r.query_fingerprint, r.created_at,
      coalesce(
        (r.feedback_vote = -1 AND r.feedback_kind IN ('answer', 'embed'))
        OR EXISTS (
          SELECT 1 FROM public.rag_answer_records a
          WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND a.feedback ->> 'vote' = 'not_helpful'
        ),
        false) AS f_negative,
      coalesce(r.feedback_vote = -1 AND r.feedback_kind = 'refusal', false) AS f_disputed,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND a.groundedness ->> 'label' = 'possibly_unreliable'
      ) AS f_groundedness,
      coalesce(
        (r.outcome = 'refused_no_context' OR r.refusal_decision = 'refuse')
        AND r.top_score >= CASE WHEN r.reranked THEN v_high_rerank ELSE v_high_similarity END,
        false) AS f_high,
      coalesce(r.candidate_count = 0 AND r.outcome <> 'kb_unavailable', false) AS f_zero,
      coalesce(r.outcome = 'answered' AND r.top_score < CASE WHEN r.reranked THEN v_low_rerank ELSE v_low_similarity END, false) AS f_low,
      coalesce(v_source_signal AND r.outcome = 'answered' AND r.source_opened_count = 0, false) AS f_no_source
    FROM source_rows r
  ),
  grouped AS (
    SELECT f.id, f.tenant_key, f.query_fingerprint, f.created_at,
      row_number() OVER (PARTITION BY f.tenant_key, f.query_fingerprint ORDER BY f.created_at DESC, f.id DESC) AS newest,
      count(*) OVER g AS occurrences,
      bool_or(f.f_negative) OVER g AS g_negative,
      bool_or(f.f_disputed) OVER g AS g_disputed,
      bool_or(f.f_groundedness) OVER g AS g_groundedness,
      bool_or(f.f_high) OVER g AS g_high,
      bool_or(f.f_zero) OVER g AS g_zero,
      bool_or(f.f_low) OVER g AS g_low,
      bool_or(f.f_no_source) OVER g AS g_no_source
    FROM flagged f
    WHERE f.f_negative OR f.f_disputed OR f.f_groundedness OR f.f_high OR f.f_zero OR f.f_low
    WINDOW g AS (PARTITION BY f.tenant_key, f.query_fingerprint)
  ),
  kept AS (
    SELECT g.id, g.tenant_key, g.query_fingerprint, g.created_at, g.occurrences,
      array_remove(ARRAY[
        CASE WHEN g.g_negative THEN 'feedback_negative' END,
        CASE WHEN g.g_disputed THEN 'refusal_disputed' END,
        CASE WHEN g.g_groundedness THEN 'groundedness_flagged' END,
        CASE WHEN g.g_high THEN 'refused_high_score' END,
        CASE WHEN g.g_zero THEN 'zero_results' END,
        CASE WHEN g.g_low THEN 'low_score' END,
        CASE WHEN g.g_no_source THEN 'no_source_opened' END
      ]::text[], NULL) AS reasons,
      CASE
        WHEN g.g_negative THEN 1
        WHEN g.g_disputed THEN 2
        WHEN g.g_groundedness THEN 3
        WHEN g.g_high THEN 4
        WHEN g.g_zero THEN 5
        ELSE 6
      END AS priority
    FROM grouped g
    WHERE g.newest = 1
  ),
  selected AS (
    SELECT k.*
    FROM (
      SELECT k0.*,
        row_number() OVER (PARTITION BY k0.tenant_key ORDER BY k0.priority, k0.occurrences DESC, k0.created_at DESC, k0.id) AS tenant_rank
      FROM kept k0
    ) k
    WHERE k.tenant_rank <= v_limit
  ),
  ins AS (
    INSERT INTO public.rag_review_items AS i (
      tenant_key, retrieval_log_id, trace_id, user_id, chat_id,
      query_masked, query_fingerprint, query_language, query_language_confidence, answer_language, chunk_languages,
      channel, outcome, candidates, retrieval_config_hash, reasons, occurrences,
      status, mining_window, mined_at, expires_at
    )
    SELECT l.tenant_key, l.id, l.trace_id, l.user_id, l.chat_id,
      l.query_masked, l.query_fingerprint, l.query_language, l.query_language_confidence, l.answer_language, l.chunk_languages,
      l.channel, l.outcome, l.candidates, l.retrieval_config_hash, s.reasons, s.occurrences::integer,
      'open', v_window, now(), now() + make_interval(days => v_ttl_days)
    FROM selected s
    JOIN public.rag_retrieval_log l ON l.id = s.id AND l.tenant_key = s.tenant_key
    ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
    RETURNING i.tenant_key, i.query_fingerprint
  )
  SELECT s.tenant_key, r.reason, count(n.query_fingerprint)::integer
  FROM selected s
  CROSS JOIN LATERAL unnest(s.reasons) AS r(reason)
  LEFT JOIN ins n ON n.tenant_key = s.tenant_key AND n.query_fingerprint = s.query_fingerprint
  GROUP BY s.tenant_key, r.reason
  ORDER BY s.tenant_key, r.reason;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
