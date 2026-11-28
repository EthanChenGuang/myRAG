-- 0962: rag_monitor_daily, the monitor's daily aggregate per (tenant_key, day, language, rag_mode, channel, doc_type) (Phase 5.3, D-22, OBS-03).
-- Counts and fixed-bin histograms only, never query, answer, chunk, document or user text, so the 30-day baseline and every roll-up
-- stay exact after the retrieval log's retention window. Filled by rag_monitor_aggregate (0971); rows are kept 400 days.
-- top_score_hist is keyed by score kind (rerank, similarity); every histogram has 22 bins: underflow, 20 bins over 0 to 1, overflow.
-- tenant_key is copied from the log rows in the 0701 form. language is a language code (und when undetected).
-- Access: RLS on with no policy; no grant to PUBLIC, anon or authenticated; only service_role reads and writes.
-- rag_monitor_purge is SECURITY INVOKER with an empty search_path, service_role only (O-3). Idempotent, not folded (D-56).

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_monitor_daily (
  tenant_key text NOT NULL,
  day date NOT NULL,
  language text NOT NULL,
  rag_mode text NOT NULL,
  channel text NOT NULL,
  doc_type text NOT NULL,
  retrievals integer NOT NULL DEFAULT 0,
  refused integer NOT NULL DEFAULT 0,
  kb_unavailable integer NOT NULL DEFAULT 0,
  degraded integer NOT NULL DEFAULT 0,
  error integer NOT NULL DEFAULT 0,
  zero_result integer NOT NULL DEFAULT 0,
  below_threshold integer NOT NULL DEFAULT 0,
  helpful integer NOT NULL DEFAULT 0,
  not_helpful integer NOT NULL DEFAULT 0,
  judged integer NOT NULL DEFAULT 0,
  groundedness_flagged integer NOT NULL DEFAULT 0,
  judge_score_sums jsonb NOT NULL DEFAULT '{}'::jsonb,
  top_score_hist jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_hist jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, day, language, rag_mode, channel, doc_type),
  CONSTRAINT rag_monitor_daily_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_monitor_daily_language_check CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  CONSTRAINT rag_monitor_daily_rag_mode_check CHECK (rag_mode IN ('strict', 'balanced', 'flexible', 'bypass', 'unknown')),
  CONSTRAINT rag_monitor_daily_channel_check CHECK (channel IN ('chat', 'embed', 'voice', 'unknown')),
  CONSTRAINT rag_monitor_daily_doc_type_check CHECK (doc_type ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT rag_monitor_daily_counts_check CHECK (
    retrievals >= 0 AND refused >= 0 AND kb_unavailable >= 0 AND degraded >= 0 AND error >= 0 AND zero_result >= 0
    AND below_threshold >= 0 AND helpful >= 0 AND not_helpful >= 0 AND judged >= 0 AND groundedness_flagged >= 0
  ),
  CONSTRAINT rag_monitor_daily_judge_score_sums_check CHECK (
    jsonb_typeof(judge_score_sums) = 'object'
    AND NOT jsonb_path_exists(judge_score_sums, '$.keyvalue() ? (@.key != "faithfulness" && @.key != "answer_relevance")')
    AND NOT jsonb_path_exists(judge_score_sums, '$.* ? (@.type() != "number")')
  ),
  CONSTRAINT rag_monitor_daily_top_score_hist_check CHECK (
    jsonb_typeof(top_score_hist) = 'object'
    AND NOT jsonb_path_exists(top_score_hist, '$.keyvalue() ? (@.key != "rerank" && @.key != "similarity")')
    AND NOT jsonb_path_exists(top_score_hist, 'strict $.* ? (@.type() != "array" || @.size() != 22)')
    AND NOT jsonb_path_exists(top_score_hist, 'strict $.*[*] ? (@.type() != "number" || @ < 0)')
  ),
  CONSTRAINT rag_monitor_daily_latency_hist_check CHECK (
    jsonb_typeof(latency_hist) = 'array'
    AND jsonb_array_length(latency_hist) IN (0, 22)
    AND NOT jsonb_path_exists(latency_hist, 'strict $[*] ? (@.type() != "number" || @ < 0)')
  )
);

CREATE INDEX IF NOT EXISTS idx_rag_monitor_daily_day ON public.rag_monitor_daily (day);

ALTER TABLE public.rag_monitor_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_monitor_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_monitor_daily TO service_role;

CREATE OR REPLACE FUNCTION public.rag_monitor_purge(p_keep_days integer DEFAULT 400)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  IF p_keep_days IS NULL OR p_keep_days < 1 THEN
    RAISE EXCEPTION 'keep days must be at least 1' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.rag_monitor_daily d WHERE d.day < CURRENT_DATE - p_keep_days;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_purge(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_purge(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
