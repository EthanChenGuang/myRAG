-- Train 31 combined live SQL (ci/merge-train-31). Apply after train 30 (0969, 1006, 0410 r14) is live. Production is multi-tenant.
-- No file has a mode variant. 0944 sorts before the live 0960-0971: it redefines rag_mine_failed_queries (last defined in 0537, no later
-- migration redefines it) and rebuilds rag_review_items_reasons_check as the union of the 0944 and 0967 reasons, so the live 0967
-- check (without claim_unsupported, output_guard, version_conflict) is replaced; 0967 itself need not be re-applied (05.2-16 only
-- widened its list to the same union for fresh databases). 0974 needs re_review in that check (0944 keeps it).
-- 0973 reads the 0966 cluster tables, 0977 the pilot-user table of 0970, 1009 the Phase 3.3 tables of 1001-1008 (all live).
-- supabase/optional/monitor-schedule.sql is opt-in and not a migration; it is not included.

-- ==== 0944_rag_review_reasons_phase52.sql
-- 0944: Phase 5.2 review reasons, claim_unsupported in the weekly mining, and the immediate enqueue (Phase 5.2, GEN-10, SEC-06, SEC-10, GEN-14,
-- D-55, D-90, RESEARCH Pitfalls 18 and 19).
-- Reason checks are replaced by DROP CONSTRAINT IF EXISTS then ADD CONSTRAINT:
--   rag_answer_records.review_reasons  feedback_negative, groundedness_flagged, claim_unsupported (the answer-quality route of D-55);
--   rag_review_items.reasons           the Phase 5.1.1 reasons plus claim_unsupported, output_guard and version_conflict.
-- The Phase 5.2.1 calculation reasons are not added here (D-90: one 5.2.1 migration in 0950-0959 widens both checks again).
-- rag_mine_failed_queries is rebuilt from its 0535 body: an answer record on the same trace_id and tenant_key whose review_reasons holds
-- claim_unsupported flags the row like groundedness_flagged, and the reason ranks right after it; everything else is unchanged.
-- rag_review_items.snapshot (new, nullable object) holds the ids of an item written by rag_enqueue_review_item; experts read it through the
-- existing RLS on tenant_key. rag_enqueue_review_item is the immediate route of D-55 for output_guard, version_conflict and, on channels
-- without an answer record, claim_unsupported: SECURITY INVOKER, empty search_path, tenant asserted first, service_role only (locked
-- again in 0410), ids only and never text.
-- Not folded into the setup files (D-02). Idempotent.

BEGIN;

ALTER TABLE public.rag_answer_records DROP CONSTRAINT IF EXISTS rag_answer_records_review_reasons_check;
ALTER TABLE public.rag_answer_records ADD CONSTRAINT rag_answer_records_review_reasons_check
  CHECK (review_reasons <@ ARRAY['feedback_negative', 'groundedness_flagged', 'claim_unsupported']::text[]);

ALTER TABLE public.rag_review_items DROP CONSTRAINT IF EXISTS rag_review_items_reasons_check;
ALTER TABLE public.rag_review_items ADD CONSTRAINT rag_review_items_reasons_check
  CHECK (reasons <@ ARRAY['feedback_negative', 'refusal_disputed', 'groundedness_flagged', 'refused_high_score', 'zero_results',
                          'low_score', 'no_source_opened', 'claim_unsupported', 'output_guard', 'version_conflict',
                          'representative', 're_review']::text[]);

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
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND 'claim_unsupported' = ANY (a.review_reasons)
      ) AS f_claim,
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
      bool_or(f.f_claim) OVER g AS g_claim,
      bool_or(f.f_high) OVER g AS g_high,
      bool_or(f.f_zero) OVER g AS g_zero,
      bool_or(f.f_low) OVER g AS g_low,
      bool_or(f.f_no_source) OVER g AS g_no_source
    FROM flagged f
    WHERE f.f_negative OR f.f_disputed OR f.f_groundedness OR f.f_claim OR f.f_high OR f.f_zero OR f.f_low
    WINDOW g AS (PARTITION BY f.tenant_key, f.query_fingerprint)
  ),
  kept AS (
    SELECT g.id, g.tenant_key, g.query_fingerprint, g.created_at, g.occurrences,
      array_remove(ARRAY[
        CASE WHEN g.g_negative THEN 'feedback_negative' END,
        CASE WHEN g.g_disputed THEN 'refusal_disputed' END,
        CASE WHEN g.g_groundedness THEN 'groundedness_flagged' END,
        CASE WHEN g.g_claim THEN 'claim_unsupported' END,
        CASE WHEN g.g_high THEN 'refused_high_score' END,
        CASE WHEN g.g_zero THEN 'zero_results' END,
        CASE WHEN g.g_low THEN 'low_score' END,
        CASE WHEN g.g_no_source THEN 'no_source_opened' END
      ]::text[], NULL) AS reasons,
      CASE
        WHEN g.g_negative THEN 1
        WHEN g.g_disputed THEN 2
        WHEN g.g_groundedness THEN 3
        WHEN g.g_claim THEN 4
        WHEN g.g_high THEN 5
        WHEN g.g_zero THEN 6
        ELSE 7
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

ALTER TABLE public.rag_review_items ADD COLUMN IF NOT EXISTS snapshot jsonb NULL;
ALTER TABLE public.rag_review_items DROP CONSTRAINT IF EXISTS rag_review_items_snapshot_check;
ALTER TABLE public.rag_review_items ADD CONSTRAINT rag_review_items_snapshot_check
  CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object');

-- One review item at once for a finding that must not wait for the weekly mining. p_source: {chunk_ids, document_ids}, UUID strings only,
-- at most 50 each, at least one id, every id a chunk or document of p_tenant_key. p_snapshot: optional detector and trace_id, no other key.
-- query_masked is empty (no question), query_fingerprint is sha256 hex of the reason and the sorted ids, mining_window the UTC week of
-- the call, so a repeated finding in the same week returns the existing item. A tenant whose retrieval_log setting is off gets no item.
CREATE OR REPLACE FUNCTION public.rag_enqueue_review_item(p_tenant_key text, p_reason text, p_source jsonb, p_snapshot jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_snapshot_in jsonb := coalesce(p_snapshot, '{}'::jsonb);
  v_key text;
  v_ids jsonb;
  v_chunks text[] := '{}'::text[];
  v_documents text[] := '{}'::text[];
  v_detector text;
  v_trace text;
  v_found integer;
  v_fingerprint text;
  v_window timestamptz;
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_reason IS NULL OR p_reason NOT IN ('claim_unsupported', 'output_guard', 'version_conflict') THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR pg_catalog.jsonb_typeof(p_source) <> 'object' THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'p_source must be a JSON object';
  END IF;
  IF pg_catalog.jsonb_typeof(v_snapshot_in) <> 'object' THEN
    RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'p_snapshot must be a JSON object';
  END IF;

  FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(p_source) AS k LOOP
    IF v_key NOT IN ('chunk_ids', 'document_ids') THEN
      RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'p_source takes chunk_ids and document_ids only';
    END IF;
    v_ids := p_source -> v_key;
    IF pg_catalog.jsonb_typeof(v_ids) <> 'array' OR pg_catalog.jsonb_array_length(v_ids) > 50
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_ids) AS e
         WHERE pg_catalog.jsonb_typeof(e) <> 'string' OR pg_catalog.lower(e #>> '{}') !~ v_uuid
       ) THEN
      RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'ids must be at most 50 UUID strings';
    END IF;
  END LOOP;

  SELECT coalesce(pg_catalog.array_agg(x.id ORDER BY x.id COLLATE "C"), '{}'::text[]) INTO v_chunks
  FROM (SELECT DISTINCT pg_catalog.lower(e #>> '{}') AS id FROM pg_catalog.jsonb_array_elements(coalesce(p_source -> 'chunk_ids', '[]'::jsonb)) AS e) AS x;
  SELECT coalesce(pg_catalog.array_agg(x.id ORDER BY x.id COLLATE "C"), '{}'::text[]) INTO v_documents
  FROM (SELECT DISTINCT pg_catalog.lower(e #>> '{}') AS id FROM pg_catalog.jsonb_array_elements(coalesce(p_source -> 'document_ids', '[]'::jsonb)) AS e) AS x;
  IF pg_catalog.cardinality(v_chunks) + pg_catalog.cardinality(v_documents) = 0 THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'at least one chunk or document id is required';
  END IF;

  FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(v_snapshot_in) AS k LOOP
    IF v_key NOT IN ('detector', 'trace_id') THEN
      RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'p_snapshot takes detector and trace_id only';
    END IF;
  END LOOP;
  IF v_snapshot_in ? 'detector' THEN
    IF pg_catalog.jsonb_typeof(v_snapshot_in -> 'detector') <> 'string' OR (v_snapshot_in ->> 'detector') !~ '^[a-z][a-z0-9_]{0,31}$' THEN
      RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'detector must be a short lower-case token';
    END IF;
    v_detector := v_snapshot_in ->> 'detector';
  END IF;
  IF v_snapshot_in ? 'trace_id' THEN
    IF pg_catalog.jsonb_typeof(v_snapshot_in -> 'trace_id') <> 'string' OR (v_snapshot_in ->> 'trace_id') !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
      RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'trace_id must be an id token';
    END IF;
    v_trace := v_snapshot_in ->> 'trace_id';
  END IF;

  SELECT count(*) INTO v_found
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.id = ANY (v_chunks::uuid[])
    AND d.tenant_key = p_tenant_key
    AND (c.tenant_key IS NULL OR c.tenant_key = p_tenant_key);
  IF v_found <> pg_catalog.cardinality(v_chunks) THEN
    RAISE EXCEPTION 'source_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every chunk id must be a chunk of the tenant';
  END IF;
  SELECT count(*) INTO v_found FROM public.documents d WHERE d.id = ANY (v_documents::uuid[]) AND d.tenant_key = p_tenant_key;
  IF v_found <> pg_catalog.cardinality(v_documents) THEN
    RAISE EXCEPTION 'source_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every document id must be a document of the tenant';
  END IF;

  IF EXISTS (SELECT 1 FROM public.rag_tenant_feedback_settings s WHERE s.tenant_key = p_tenant_key AND s.retrieval_log = 'off') THEN
    RETURN NULL;
  END IF;

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_reason || E'\n' || 'chunks:' || pg_catalog.array_to_string(v_chunks, ',') || E'\n' || 'documents:' || pg_catalog.array_to_string(v_documents, ','),
      'UTF8')),
    'hex');
  v_window := pg_catalog.date_trunc('week', pg_catalog.now(), 'UTC');

  INSERT INTO public.rag_review_items AS i (tenant_key, trace_id, query_masked, query_fingerprint, reasons, snapshot, status, mining_window, mined_at)
  VALUES (
    p_tenant_key, v_trace, '', v_fingerprint, ARRAY[p_reason]::text[],
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'reason', p_reason, 'detector', v_detector, 'trace_id', v_trace,
      'chunk_ids', pg_catalog.to_jsonb(v_chunks), 'document_ids', pg_catalog.to_jsonb(v_documents))),
    'open', v_window, pg_catalog.now()
  )
  ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
  RETURNING i.id INTO v_id;

  IF v_id IS NULL THEN
    SELECT i.id INTO v_id FROM public.rag_review_items i
    WHERE i.tenant_key = p_tenant_key AND i.query_fingerprint = v_fingerprint AND i.mining_window = v_window;
  END IF;
  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0972_rag_monitor_alert_evidence.sql
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

-- ==== 0973_rag_monitor_cluster_shares.sql
-- 0973: rag_monitor_cluster_shares, counts per cluster, language and channel of one tenant's assigned log rows (Phase 5.3, D-43).
-- Counts the tenant's rag_retrieval_log rows created at or after p_since that are assigned to a cluster of the tenant's current
-- cluster set (rows assigned in a superseded set are not counted). Language is the query language, und when null.
-- The tenant comes only from p_tenant_key, checked first by rag_assert_tenant_key; every join also filters on it. Counts only.
-- Without the Phase 5.1.1 log or the 0966 cluster tables the function returns no rows (to_regclass guard).
-- SECURITY INVOKER, empty search_path, service_role only (O-3). Idempotent, not folded (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_monitor_cluster_shares(p_tenant_key text, p_since timestamptz)
RETURNS TABLE (cluster_id text, language text, channel text, n bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_since IS NULL THEN
    RAISE EXCEPTION 'since is required' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL
     OR pg_catalog.to_regclass('public.rag_query_cluster_assignments') IS NULL
     OR pg_catalog.to_regclass('public.rag_query_cluster_sets') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE $sql$
    SELECT a.cluster_id, COALESCE(l.query_language, 'und') AS language, l.channel, pg_catalog.count(*)::bigint AS n
      FROM public.rag_query_cluster_assignments a
      JOIN public.rag_query_cluster_sets s
        ON s.id = a.set_id AND s.tenant_key = $1 AND s.status = 'current'
      JOIN public.rag_retrieval_log l
        ON l.id = a.log_id AND l.tenant_key = $1
     WHERE a.tenant_key = $1
       AND l.created_at >= $2
     GROUP BY a.cluster_id, COALESCE(l.query_language, 'und'), l.channel
     ORDER BY 1, 2, 3
  $sql$ USING p_tenant_key, p_since;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_cluster_shares(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_cluster_shares(text, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0974_rag_review_items_re_review.sql
-- 0974: rag_review_items_enqueue_re_review, review items with reason re_review for the yearly re-review cycle (Phase 5.3, D-50).
-- p_rows: [{ query_masked, query_fingerprint, language?, channel?, mining_window }]. Every row is stored under p_tenant_key (a
-- tenant named in a row is ignored) with reasons {re_review}, status open and no strata row; ON CONFLICT DO NOTHING on the Phase
-- 5.1.1 key (tenant_key, query_fingerprint, mining_window), so a repeat inserts nothing. Returns the number inserted.
-- A malformed payload raises 22023 and writes nothing. The tenant key is checked first by rag_assert_tenant_key.
-- Without the Phase 5.1.1 review queue the function returns 0 (to_regclass guard). SECURITY INVOKER, empty search_path,
-- service_role only (O-3). Idempotent, not folded (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue_re_review(p_tenant_key text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows_not_array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
     WHERE pg_catalog.jsonb_typeof(e.value) <> 'object'
        OR COALESCE(e.value ->> 'query_masked', '') = ''
        OR COALESCE(e.value ->> 'query_fingerprint', '') = ''
        OR COALESCE(e.value ->> 'mining_window', '') = ''
  ) THEN
    RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023';
  END IF;

  EXECUTE $sql$
    WITH written AS (
      INSERT INTO public.rag_review_items AS i (
        tenant_key, query_masked, query_fingerprint, query_language, channel, reasons, status, mining_window, mined_at
      )
      SELECT $1, e.value ->> 'query_masked', e.value ->> 'query_fingerprint', NULLIF(e.value ->> 'language', ''),
             NULLIF(e.value ->> 'channel', ''), ARRAY['re_review']::text[], 'open', (e.value ->> 'mining_window')::timestamptz,
             pg_catalog.now()
        FROM pg_catalog.jsonb_array_elements($2) AS e(value)
      ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
      RETURNING 1
    )
    SELECT pg_catalog.count(*)::integer FROM written
  $sql$ INTO v_count USING p_tenant_key, p_rows;

  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0975_rag_monitor_runs.sql
-- 0975: rag_monitor_runs, one row per monitor run with counts only (Phase 5.3, D-20, UI-SPEC 6.7 and 8.1).
-- Deployment-wide (a run covers every tenant), so no tenant_key (D-55 as ratified). The Config UI reads the last run and the
-- number of groups with too little data. No text column beyond the source code. runDaily deletes rows older than 400 days.
-- Access: RLS on with no policy; no grant to PUBLIC, anon or authenticated; only service_role reads and writes.
-- Idempotent, not folded (D-56).

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_monitor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  day date NOT NULL,
  source text NOT NULL,
  days_aggregated integer NOT NULL DEFAULT 0,
  groups_checked integer NOT NULL DEFAULT 0,
  groups_insufficient integer NOT NULL DEFAULT 0,
  alerts_opened integer NOT NULL DEFAULT 0,
  alerts_updated integer NOT NULL DEFAULT 0,
  deliveries integer NOT NULL DEFAULT 0,
  CONSTRAINT rag_monitor_runs_source_check CHECK (source IN ('cli', 'route', 'schedule')),
  CONSTRAINT rag_monitor_runs_counts_check CHECK (
    days_aggregated >= 0 AND groups_checked >= 0 AND groups_insufficient >= 0
    AND alerts_opened >= 0 AND alerts_updated >= 0 AND deliveries >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_rag_monitor_runs_ran_at ON public.rag_monitor_runs (ran_at DESC);

ALTER TABLE public.rag_monitor_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_monitor_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_monitor_runs TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0977_rag_pilot_user_resolve.sql
-- 0977: the readers behind the pilot-user admin route (Phase 5.3 D-52, D-55, plan 05.3-32).
-- rag_pilot_user_resolve(p_tenant_key, p_user) turns an e-mail address (case-insensitive) or a user id into the id of a user who
-- belongs to that tenant, or NULL: s:default accepts any user of the deployment, u:<id> only that user, o:<id> only a member of the
-- organization. An unknown user and a user of another tenant both give NULL, so the route answers one 404 for both.
-- rag_pilot_users_list(p_tenant_key, p_limit, p_before_added_at, p_before_user_id) returns the tenant's pilot users newest first
-- as a jsonb array of { user_id, email, added_at }, keyset-paginated on (added_at, user_id); the route masks the e-mail.
-- Both read auth.users, which only the owner may read on Supabase, so they are SECURITY DEFINER with an empty search_path and
-- schema-qualified names; the tenant comes only from p_tenant_key, checked first by rag_assert_tenant_key. Service role only.
-- Additive and idempotent. Not folded into the setup files (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_pilot_user_resolve(p_tenant_key text, p_user text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_value text := pg_catalog.btrim(coalesce(p_user, ''));
  v_user uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF v_value = '' OR pg_catalog.length(v_value) > 320 THEN
    RETURN NULL;
  END IF;

  IF v_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT u.id INTO v_user FROM auth.users u WHERE u.id = v_value::uuid;
  ELSIF pg_catalog.strpos(v_value, '@') > 1 THEN
    SELECT u.id INTO v_user
    FROM auth.users u
    WHERE pg_catalog.lower(u.email) = pg_catalog.lower(v_value)
    ORDER BY u.id
    LIMIT 1;
  END IF;

  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_tenant_key = 's:default' THEN
    RETURN v_user;
  END IF;

  IF pg_catalog.left(p_tenant_key, 2) = 'u:' THEN
    RETURN CASE WHEN v_user = pg_catalog.substr(p_tenant_key, 3)::uuid THEN v_user END;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = pg_catalog.substr(p_tenant_key, 3)::uuid
      AND m.user_id = v_user
  ) THEN
    RETURN v_user;
  END IF;

  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_pilot_users_list(
  p_tenant_key text,
  p_limit integer,
  p_before_added_at timestamptz,
  p_before_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 101);
  v_out jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF (p_before_added_at IS NULL) <> (p_before_user_id IS NULL) THEN
    RAISE EXCEPTION 'rag_pilot_users_list: the cursor needs both added_at and user_id' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('user_id', page.user_id, 'email', u.email, 'added_at', page.added_at)
             ORDER BY page.added_at DESC, page.user_id DESC
           ),
           '[]'::jsonb
         )
  INTO v_out
  FROM (
    SELECT p.user_id, p.added_at
    FROM public.rag_pilot_users p
    WHERE p.tenant_key = p_tenant_key
      AND (p_before_added_at IS NULL OR (p.added_at, p.user_id) < (p_before_added_at, p_before_user_id))
    ORDER BY p.added_at DESC, p.user_id DESC
    LIMIT v_limit
  ) AS page
  LEFT JOIN auth.users u ON u.id = page.user_id;

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_pilot_user_resolve(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_pilot_users_list(text, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_pilot_user_resolve(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_pilot_users_list(text, integer, timestamptz, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 1009_phase33_purge.sql
-- 1009: Phase 3.3 purge hook and tenant rule-data delete (TPL-03, TPL-08, D-02, D-35, F-24).
-- rag_purge_hook_doc_attributes(p_tenant_key, p_lineage_id, p_document_ids): for the tenant's documents of the lineage or the listed ids,
--   sets attributes, attribute_header and attribute_header_stamp to null on the documents and attributes and attribute_header_stamp on their
--   chunks, and deletes the tenant's rag_staged_attributes rows whose (source, source_key) is one of those documents'. Returns the number of
--   rows changed (documents + chunks + staged rows deleted). Phase 6.3 calls it from its purge (hand-off 03.3-24-phase63-purge).
-- rag_tenant_rule_data_delete(p_tenant_key): deletes the tenant's rows from the five Phase 3.3 tables, one result row per table in a fixed
--   order; documents and chunks are not touched. Nothing calls it yet (hand-off 03.3-24-tenant-delete).
-- Security: both functions are SECURITY INVOKER with an empty search_path, assert the tenant key first (a key of the other deployment mode
--   is rejected), name the tenant in every predicate, are revoked from PUBLIC, anon and authenticated and granted to service_role only.
-- rag_purge_store_inventory does not exist on trunk (branch b), so this file adds no inventory row.
-- Idempotent; not folded into the setup files.

BEGIN;

DO $phase33_purge_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_staged_attributes') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL THEN
    RAISE EXCEPTION '1009: apply 1001 first' USING ERRCODE = '55000';
  END IF;
END
$phase33_purge_precheck$;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_doc_attributes(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_docs uuid[];
  v_documents bigint;
  v_chunks bigint;
  v_staged bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT COALESCE(pg_catalog.array_agg(d.id), '{}'::uuid[]) INTO v_docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND (d.lineage_id = p_lineage_id OR d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[])));
  DELETE FROM public.rag_staged_attributes s
   USING public.documents d
   WHERE s.tenant_key = p_tenant_key
     AND d.tenant_key = p_tenant_key
     AND d.id = ANY (v_docs)
     AND s.source = d.source
     AND s.source_key = d.source_key;
  GET DIAGNOSTICS v_staged = ROW_COUNT;
  UPDATE public.documents d
     SET attributes = NULL, attribute_header = NULL, attribute_header_stamp = NULL
   WHERE d.tenant_key = p_tenant_key
     AND d.id = ANY (v_docs)
     AND (d.attributes IS NOT NULL OR d.attribute_header IS NOT NULL OR d.attribute_header_stamp IS NOT NULL);
  GET DIAGNOSTICS v_documents = ROW_COUNT;
  UPDATE public.document_chunks c
     SET attributes = NULL, attribute_header_stamp = NULL
   WHERE c.tenant_key = p_tenant_key
     AND c.document_id = ANY (v_docs)
     AND (c.attributes IS NOT NULL OR c.attribute_header_stamp IS NOT NULL);
  GET DIAGNOSTICS v_chunks = ROW_COUNT;
  RETURN v_documents + v_chunks + v_staged;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_doc_attributes(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_doc_attributes(text, uuid, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_tenant_rule_data_delete(p_tenant_key text)
RETURNS TABLE (relation text, deleted bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  DELETE FROM public.rag_section_rule_sets t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_section_rule_sets'; deleted := v_count; RETURN NEXT;

  DELETE FROM public.rag_boilerplate_rules t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_boilerplate_rules'; deleted := v_count; RETURN NEXT;

  DELETE FROM public.rag_attribute_definitions t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_attribute_definitions'; deleted := v_count; RETURN NEXT;

  DELETE FROM public.rag_attribute_header_templates t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_attribute_header_templates'; deleted := v_count; RETURN NEXT;

  DELETE FROM public.rag_staged_attributes t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_staged_attributes'; deleted := v_count; RETURN NEXT;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_tenant_rule_data_delete(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_tenant_rule_data_delete(text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0410_security_definer_rpc_grants.sql (r15 delta: only the 12 lines added since r14; grants only, run last)
DO $r15$
BEGIN
  IF to_regprocedure('public.rag_pilot_user_resolve(text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_pilot_user_resolve(text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_pilot_user_resolve(text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_pilot_users_list(text, integer, timestamptz, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_pilot_users_list(text, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_pilot_users_list(text, integer, timestamptz, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_enqueue_review_item(text, text, jsonb, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb) TO service_role;
  END IF;
END
$r15$;

-- ==== Sections containing DROP statements (owner must be present)
-- 0944_rag_review_reasons_phase52.sql: ALTER TABLE public.rag_answer_records DROP CONSTRAINT IF EXISTS rag_answer_records_review_reasons_check;
--                                     ALTER TABLE public.rag_review_items DROP CONSTRAINT IF EXISTS rag_review_items_reasons_check;
--                                     ALTER TABLE public.rag_review_items DROP CONSTRAINT IF EXISTS rag_review_items_snapshot_check;
--                                     (each re-added at once in the same transaction; the reasons checks validate existing rows)
-- 1009_phase33_purge.sql: DELETE statements only inside the bodies of rag_purge_hook_doc_attributes and rag_tenant_rule_data_delete;
--                         nothing is deleted on apply.
-- No other DROP. The 0410 delta contains none.
