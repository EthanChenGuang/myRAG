-- 0971: rag_monitor_aggregate turns one UTC day of rag_retrieval_log into rag_monitor_daily cells (Phase 5.3, D-20, D-22, D-55, OBS-03).
-- Cell key per log row: tenant_key copied from the row, query_language (und when null), rag_mode and channel (unknown when null or
-- not a known value), and the doc_type of the document of the first kept candidate by rank, read from public.documents of the same
-- tenant at aggregation time (unknown when there is no kept candidate or the document is gone).
-- Counters per row: refused (outcome refused_no_context or refusal_decision refuse), kb_unavailable (outcome kb_unavailable),
-- degraded (status degraded), error (status error), zero_result (candidate_count 0 with status ok or empty, not kb_unavailable and
-- not a refusal by the gate), below_threshold (refusal_reason below_threshold), helpful and not_helpful (feedback_vote 1 and -1),
-- judged (the trace has a rag_online_judge_scores row of the same tenant), groundedness_flagged (a rag_answer_records row of the
-- same trace and tenant is labelled possibly_unreliable). judge_score_sums adds per metric the trace's mean over judge ids.
-- top_score_hist is keyed by score kind: rerank when the scored candidate (first kept by rank, else first by rank) has a
-- rerank_score, similarity otherwise; 22 bins: 0 below 0, 1 to 20 of width 0.05 over 0 to 1 (1 itself in bin 20), 21 above 1.
-- latency_hist from latency_ms, 22 bins: 0 below 0, then [0,50) [50,100) [100,150) [150,200) [200,300) [300,400) [400,500)
-- [500,750) [750,1000) [1000,1250) [1250,1500) [1500,1750) [1750,2000) [2000,2500) [2500,3000) [3000,4000) [4000,5000)
-- [5000,7500) [7500,10000) [10000,15000), and 21 at 15000 or more.
-- The upsert recomputes every cell that has rows for the day (idempotent; later votes and judge scores are picked up by a re-run)
-- and leaves cells without rows as they are, since the log may already be purged. Counts and histograms only, never text.
-- rag_monitor_days_to_aggregate(p_trailing) returns the p_trailing UTC days before today plus every older UTC day on which a
-- tenant has log rows but no cell, so a missed day is aggregated before the log's retention purge.
-- The log, answer-record and judge-score references are guarded with to_regclass: without the log the file applies, the aggregate
-- returns 0 and the day list is empty. Both functions are SECURITY INVOKER with an empty search path, service_role only (O-3).
-- Idempotent, not folded (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_monitor_aggregate(p_day date)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_flagged text := '0';
  v_judge text := 'SELECT NULL::numeric AS faithfulness, NULL::numeric AS answer_relevance, false AS judged';
  v_written integer;
BEGIN
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'day is required' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL THEN
    RETURN 0;
  END IF;

  IF pg_catalog.to_regclass('public.rag_answer_records') IS NOT NULL THEN
    v_flagged := $q$CASE WHEN EXISTS (
        SELECT 1 FROM public.rag_answer_records a
         WHERE a.trace_id = l.trace_id AND a.tenant_key = l.tenant_key AND a.groundedness ->> 'label' = 'possibly_unreliable'
      ) THEN 1 ELSE 0 END$q$;
  END IF;

  IF pg_catalog.to_regclass('public.rag_online_judge_scores') IS NOT NULL THEN
    v_judge := $q$SELECT
        pg_catalog.round(pg_catalog.avg(s.score::numeric) FILTER (WHERE s.metric = 'faithfulness'), 6) AS faithfulness,
        pg_catalog.round(pg_catalog.avg(s.score::numeric) FILTER (WHERE s.metric = 'answer_relevance'), 6) AS answer_relevance,
        pg_catalog.count(*) > 0 AS judged
      FROM public.rag_online_judge_scores s
      WHERE s.trace_id = l.trace_id AND s.tenant_key = l.tenant_key$q$;
  END IF;

  EXECUTE pg_catalog.format($sql$
    WITH per_row AS (
      SELECT
        l.tenant_key,
        COALESCE(l.query_language, 'und') AS language,
        CASE WHEN l.rag_mode IN ('strict', 'balanced', 'flexible', 'bypass') THEN l.rag_mode ELSE 'unknown' END AS rag_mode,
        CASE WHEN l.channel IN ('chat', 'embed', 'voice') THEN l.channel ELSE 'unknown' END AS channel,
        COALESCE(d.doc_type, 'unknown') AS doc_type,
        CASE WHEN l.outcome = 'refused_no_context' OR l.refusal_decision = 'refuse' THEN 1 ELSE 0 END AS refused,
        CASE WHEN l.outcome = 'kb_unavailable' THEN 1 ELSE 0 END AS kb_unavailable,
        CASE WHEN l.status = 'degraded' THEN 1 ELSE 0 END AS degraded,
        CASE WHEN l.status = 'error' THEN 1 ELSE 0 END AS error,
        CASE WHEN l.candidate_count = 0 AND l.status IN ('ok', 'empty') AND l.outcome <> 'kb_unavailable'
                  AND l.refusal_decision IS DISTINCT FROM 'refuse' THEN 1 ELSE 0 END AS zero_result,
        CASE WHEN l.refusal_reason = 'below_threshold' THEN 1 ELSE 0 END AS below_threshold,
        CASE WHEN l.feedback_vote = 1 THEN 1 ELSE 0 END AS helpful,
        CASE WHEN l.feedback_vote = -1 THEN 1 ELSE 0 END AS not_helpful,
        %s AS groundedness_flagged,
        CASE WHEN j.judged THEN 1 ELSE 0 END AS judged,
        j.faithfulness,
        j.answer_relevance,
        sc.kind AS score_kind,
        CASE
          WHEN sc.score IS NULL THEN NULL
          WHEN sc.score < 0 THEN 0
          WHEN sc.score > 1 THEN 21
          ELSE 1 + LEAST(pg_catalog.floor(sc.score * 20)::integer, 19)
        END AS score_bin,
        CASE WHEN l.latency_ms IS NULL THEN NULL ELSE pg_catalog.width_bucket(
          l.latency_ms,
          ARRAY[0, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000]
        ) END AS latency_bin
      FROM public.rag_retrieval_log l
      LEFT JOIN LATERAL (
        SELECT e.value AS c
          FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(l.candidates) = 'array' THEN l.candidates ELSE '[]'::jsonb END)
               WITH ORDINALITY AS e(value, ord)
         WHERE e.value -> 'kept' = 'true'::jsonb
         ORDER BY CASE WHEN pg_catalog.jsonb_typeof(e.value -> 'rank') = 'number' THEN (e.value ->> 'rank')::numeric END NULLS LAST, e.ord
         LIMIT 1
      ) kept ON true
      LEFT JOIN LATERAL (
        SELECT e.value AS c
          FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(l.candidates) = 'array' THEN l.candidates ELSE '[]'::jsonb END)
               WITH ORDINALITY AS e(value, ord)
         ORDER BY CASE WHEN pg_catalog.jsonb_typeof(e.value -> 'rank') = 'number' THEN (e.value ->> 'rank')::numeric END NULLS LAST, e.ord
         LIMIT 1
      ) first_c ON true
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN pg_catalog.jsonb_typeof(COALESCE(kept.c, first_c.c) -> 'rerank_score') = 'number' THEN 'rerank'
            WHEN pg_catalog.jsonb_typeof(COALESCE(kept.c, first_c.c) -> 'similarity') = 'number' THEN 'similarity'
          END AS kind,
          CASE
            WHEN pg_catalog.jsonb_typeof(COALESCE(kept.c, first_c.c) -> 'rerank_score') = 'number'
              THEN (COALESCE(kept.c, first_c.c) ->> 'rerank_score')::numeric
            WHEN pg_catalog.jsonb_typeof(COALESCE(kept.c, first_c.c) -> 'similarity') = 'number'
              THEN (COALESCE(kept.c, first_c.c) ->> 'similarity')::numeric
          END AS score
      ) sc ON true
      LEFT JOIN public.documents d
        ON d.id = CASE
                    WHEN (kept.c ->> 'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      THEN (kept.c ->> 'document_id')::uuid
                  END
       AND d.tenant_key = l.tenant_key
      LEFT JOIN LATERAL (%s) j ON true
      WHERE l.created_at >= ($1::timestamp AT TIME ZONE 'UTC')
        AND l.created_at < (($1 + 1)::timestamp AT TIME ZONE 'UTC')
    ),
    cells AS (
      SELECT
        r.tenant_key, r.language, r.rag_mode, r.channel, r.doc_type,
        pg_catalog.count(*)::integer AS retrievals,
        pg_catalog.sum(r.refused)::integer AS refused,
        pg_catalog.sum(r.kb_unavailable)::integer AS kb_unavailable,
        pg_catalog.sum(r.degraded)::integer AS degraded,
        pg_catalog.sum(r.error)::integer AS error,
        pg_catalog.sum(r.zero_result)::integer AS zero_result,
        pg_catalog.sum(r.below_threshold)::integer AS below_threshold,
        pg_catalog.sum(r.helpful)::integer AS helpful,
        pg_catalog.sum(r.not_helpful)::integer AS not_helpful,
        pg_catalog.sum(r.judged)::integer AS judged,
        pg_catalog.sum(r.groundedness_flagged)::integer AS groundedness_flagged,
        pg_catalog.jsonb_build_object(
          'faithfulness', COALESCE(pg_catalog.sum(r.faithfulness), 0),
          'answer_relevance', COALESCE(pg_catalog.sum(r.answer_relevance), 0)
        ) AS judge_score_sums
      FROM per_row r
      GROUP BY r.tenant_key, r.language, r.rag_mode, r.channel, r.doc_type
    ),
    score_bins AS (
      SELECT r.tenant_key, r.language, r.rag_mode, r.channel, r.doc_type, r.score_kind, r.score_bin, pg_catalog.count(*)::integer AS n
        FROM per_row r
       WHERE r.score_kind IS NOT NULL
       GROUP BY r.tenant_key, r.language, r.rag_mode, r.channel, r.doc_type, r.score_kind, r.score_bin
    ),
    latency_bins AS (
      SELECT r.tenant_key, r.language, r.rag_mode, r.channel, r.doc_type, r.latency_bin, pg_catalog.count(*)::integer AS n
        FROM per_row r
       WHERE r.latency_bin IS NOT NULL
       GROUP BY r.tenant_key, r.language, r.rag_mode, r.channel, r.doc_type, r.latency_bin
    ),
    final AS (
      SELECT
        c.*,
        (
          SELECT pg_catalog.jsonb_object_agg(k.kind, (
            SELECT pg_catalog.jsonb_agg(COALESCE(b.n, 0) ORDER BY g.i)
              FROM pg_catalog.generate_series(0, 21) AS g(i)
              LEFT JOIN score_bins b
                ON b.tenant_key = c.tenant_key AND b.language = c.language AND b.rag_mode = c.rag_mode
               AND b.channel = c.channel AND b.doc_type = c.doc_type AND b.score_kind = k.kind AND b.score_bin = g.i
          ))
          FROM (VALUES ('rerank'), ('similarity')) AS k(kind)
        ) AS top_score_hist,
        (
          SELECT pg_catalog.jsonb_agg(COALESCE(b.n, 0) ORDER BY g.i)
            FROM pg_catalog.generate_series(0, 21) AS g(i)
            LEFT JOIN latency_bins b
              ON b.tenant_key = c.tenant_key AND b.language = c.language AND b.rag_mode = c.rag_mode
             AND b.channel = c.channel AND b.doc_type = c.doc_type AND b.latency_bin = g.i
        ) AS latency_hist
      FROM cells c
    ),
    written AS (
      INSERT INTO public.rag_monitor_daily AS m (
        tenant_key, day, language, rag_mode, channel, doc_type,
        retrievals, refused, kb_unavailable, degraded, error, zero_result, below_threshold, helpful, not_helpful, judged,
        groundedness_flagged, judge_score_sums, top_score_hist, latency_hist, updated_at
      )
      SELECT
        f.tenant_key, $1, f.language, f.rag_mode, f.channel, f.doc_type,
        f.retrievals, f.refused, f.kb_unavailable, f.degraded, f.error, f.zero_result, f.below_threshold, f.helpful, f.not_helpful,
        f.judged, f.groundedness_flagged, f.judge_score_sums, f.top_score_hist, f.latency_hist, pg_catalog.now()
      FROM final f
      ON CONFLICT (tenant_key, day, language, rag_mode, channel, doc_type) DO UPDATE SET
        retrievals = EXCLUDED.retrievals,
        refused = EXCLUDED.refused,
        kb_unavailable = EXCLUDED.kb_unavailable,
        degraded = EXCLUDED.degraded,
        error = EXCLUDED.error,
        zero_result = EXCLUDED.zero_result,
        below_threshold = EXCLUDED.below_threshold,
        helpful = EXCLUDED.helpful,
        not_helpful = EXCLUDED.not_helpful,
        judged = EXCLUDED.judged,
        groundedness_flagged = EXCLUDED.groundedness_flagged,
        judge_score_sums = EXCLUDED.judge_score_sums,
        top_score_hist = EXCLUDED.top_score_hist,
        latency_hist = EXCLUDED.latency_hist,
        updated_at = EXCLUDED.updated_at
      RETURNING 1
    )
    SELECT pg_catalog.count(*)::integer FROM written
  $sql$, v_flagged, v_judge)
  INTO v_written
  USING p_day;

  RETURN COALESCE(v_written, 0);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_aggregate(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_aggregate(date) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_monitor_days_to_aggregate(p_trailing integer DEFAULT 7)
RETURNS SETOF date
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_today date := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_trailing IS NULL OR p_trailing < 0 OR p_trailing > 400 THEN
    RAISE EXCEPTION 'trailing days must be between 0 and 400' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE $sql$
    SELECT DISTINCT x.day
      FROM (
        SELECT ($1 - g.i)::date AS day FROM pg_catalog.generate_series(1, $2) AS g(i)
        UNION
        SELECT (l.created_at AT TIME ZONE 'UTC')::date AS day
          FROM public.rag_retrieval_log l
         WHERE l.created_at < (($1 - $2)::timestamp AT TIME ZONE 'UTC')
           AND NOT EXISTS (
             SELECT 1 FROM public.rag_monitor_daily m
              WHERE m.tenant_key = l.tenant_key AND m.day = (l.created_at AT TIME ZONE 'UTC')::date
           )
      ) AS x
     ORDER BY x.day
  $sql$ USING v_today, p_trailing;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_days_to_aggregate(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_days_to_aggregate(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
