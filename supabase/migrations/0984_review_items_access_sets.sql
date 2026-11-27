-- 0984: the review-queue writers carry access_sets (Phase 4.3 follow-up to 04.3-13 and 04.3-14; SEC-13, D-25, A-06).
-- Gap closed: rag_mine_failed_queries and rag_enqueue_review_item wrote rag_review_items.access_sets as NULL, so 0934's restrictive
-- policy rag_review_items_access_sets never hid a new item, and an expert outside a document's access group could read its evidence
-- through the review chunks route.
-- rag_review_access_sets(p_tenant_key, p_given, p_document_ids, p_strict): SECURITY INVOKER, empty search_path, service_role only. It
-- returns p_given (normalised: each set's keys sorted and deduplicated, the sets deduplicated and sorted) merged with one access_groups
-- set per document of p_document_ids in p_tenant_key, the documents' labels being added only while public.rag_access_enforced() is true.
-- With access off and p_given NULL the result is NULL (today's row). p_strict raises invalid_access_sets (22023) on a malformed p_given;
-- otherwise a malformed set is stored as a group key nobody holds (fail closed, readable by tenant admins only).
-- rag_mine_failed_queries is rebuilt from its 0950 body: the mined item gets the log row's access_sets merged with the label sets of
-- its candidates' documents. rag_enqueue_review_item is rebuilt from its 0950 body with a fifth argument p_access_sets jsonb DEFAULT
-- NULL (the caller's label sets, merged with the sets of the source documents read here). The four-argument signature is dropped first,
-- because CREATE OR REPLACE with a new argument list would add an overload. Security attributes are unchanged: the mining is SECURITY
-- DEFINER and the enqueue SECURITY INVOKER, both with an empty search_path and service_role only (and locked again in 0410).
-- While access is enforced at apply time, items still without access_sets get their sets from their candidates and snapshot ids.
-- One common file: nothing differs by deployment mode (tenant_key exists in both). Not folded into the setup files. Idempotent.
-- Re-running 0944 or 0950 later re-creates the four-argument enqueue and the old mining body; re-run this file after them.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_review_access_sets(p_tenant_key text, p_given jsonb, p_document_ids uuid[], p_strict boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key_re constant text := '^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$';
  v_unknown constant jsonb := '["g:00000000-0000-0000-0000-000000000000"]'::jsonb;
  v_sets jsonb[] := '{}'::jsonb[];
  v_set jsonb;
  v_valid boolean;
BEGIN
  IF p_given IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_given) <> 'array' OR pg_catalog.jsonb_array_length(p_given) > 200 THEN
      IF p_strict THEN
        RAISE EXCEPTION 'invalid_access_sets' USING ERRCODE = '22023', DETAIL = 'access sets must be an array of at most 200 key arrays';
      END IF;
      v_sets := v_sets || v_unknown;
    ELSE
      FOR v_set IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_given) AS e(value) LOOP
        v_valid := pg_catalog.jsonb_typeof(v_set) = 'array'
          AND pg_catalog.jsonb_array_length(v_set) BETWEEN 1 AND 64
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)
            WHERE pg_catalog.jsonb_typeof(k.value) <> 'string' OR (k.value #>> '{}') !~ v_key_re
          );
        IF NOT v_valid THEN
          IF p_strict THEN
            RAISE EXCEPTION 'invalid_access_sets' USING ERRCODE = '22023', DETAIL = 'each access set is 1 to 64 access keys';
          END IF;
          v_sets := v_sets || v_unknown;
        ELSE
          v_sets := v_sets || (
            SELECT pg_catalog.jsonb_agg(x.key ORDER BY x.key COLLATE "C")
            FROM (SELECT DISTINCT k.value #>> '{}' AS key FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)) AS x
          );
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF public.rag_access_enforced() AND p_tenant_key IS NOT NULL THEN
    v_sets := v_sets || ARRAY(
      SELECT CASE WHEN pg_catalog.cardinality(d.access_groups) = 0 THEN v_unknown ELSE (
        SELECT pg_catalog.jsonb_agg(x.key ORDER BY x.key COLLATE "C") FROM (SELECT DISTINCT k AS key FROM pg_catalog.unnest(d.access_groups) AS k) AS x
      ) END
      FROM public.documents d
      WHERE d.id = ANY (coalesce(p_document_ids, '{}'::uuid[])) AND d.tenant_key = p_tenant_key
    );
  END IF;

  IF p_given IS NULL AND pg_catalog.cardinality(v_sets) = 0 THEN
    RETURN NULL;
  END IF;
  RETURN coalesce(
    (SELECT pg_catalog.jsonb_agg(s.value ORDER BY s.value::text COLLATE "C") FROM (SELECT DISTINCT u AS value FROM pg_catalog.unnest(v_sets) AS u) AS s),
    '[]'::jsonb);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) TO service_role;

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
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND 'calc_mismatch' = ANY (a.review_reasons)
      ) AS f_calc_mismatch,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND 'calc_unverified' = ANY (a.review_reasons)
      ) AS f_calc_unverified,
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
      bool_or(f.f_calc_mismatch) OVER g AS g_calc_mismatch,
      bool_or(f.f_calc_unverified) OVER g AS g_calc_unverified,
      bool_or(f.f_high) OVER g AS g_high,
      bool_or(f.f_zero) OVER g AS g_zero,
      bool_or(f.f_low) OVER g AS g_low,
      bool_or(f.f_no_source) OVER g AS g_no_source
    FROM flagged f
    WHERE f.f_negative OR f.f_disputed OR f.f_groundedness OR f.f_claim OR f.f_calc_mismatch OR f.f_calc_unverified
       OR f.f_high OR f.f_zero OR f.f_low
    WINDOW g AS (PARTITION BY f.tenant_key, f.query_fingerprint)
  ),
  kept AS (
    SELECT g.id, g.tenant_key, g.query_fingerprint, g.created_at, g.occurrences,
      array_remove(ARRAY[
        CASE WHEN g.g_negative THEN 'feedback_negative' END,
        CASE WHEN g.g_disputed THEN 'refusal_disputed' END,
        CASE WHEN g.g_groundedness THEN 'groundedness_flagged' END,
        CASE WHEN g.g_claim THEN 'claim_unsupported' END,
        CASE WHEN g.g_calc_mismatch THEN 'calc_mismatch' END,
        CASE WHEN g.g_calc_unverified THEN 'calc_unverified' END,
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
        WHEN g.g_calc_mismatch THEN 5
        WHEN g.g_calc_unverified THEN 6
        WHEN g.g_high THEN 7
        WHEN g.g_zero THEN 8
        ELSE 9
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
      status, mining_window, mined_at, expires_at, access_sets
    )
    SELECT l.tenant_key, l.id, l.trace_id, l.user_id, l.chat_id,
      l.query_masked, l.query_fingerprint, l.query_language, l.query_language_confidence, l.answer_language, l.chunk_languages,
      l.channel, l.outcome, l.candidates, l.retrieval_config_hash, s.reasons, s.occurrences::integer,
      'open', v_window, now(), now() + make_interval(days => v_ttl_days),
      public.rag_review_access_sets(l.tenant_key, l.access_sets, ARRAY(
        SELECT DISTINCT (c ->> 'document_id')::uuid
        FROM pg_catalog.jsonb_array_elements(l.candidates) AS c
        WHERE pg_catalog.jsonb_typeof(c) = 'object' AND pg_catalog.lower(c ->> 'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ), false)
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

DROP FUNCTION IF EXISTS public.rag_enqueue_review_item(text, text, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.rag_enqueue_review_item(
  p_tenant_key text, p_reason text, p_source jsonb, p_snapshot jsonb, p_access_sets jsonb DEFAULT NULL
)
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
  v_access_sets jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_reason IS NULL OR p_reason NOT IN ('claim_unsupported', 'output_guard', 'version_conflict', 'calc_mismatch', 'calc_unverified') THEN
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

  v_access_sets := public.rag_review_access_sets(
    p_tenant_key, p_access_sets,
    ARRAY(
      SELECT DISTINCT c.document_id FROM public.document_chunks c WHERE c.id = ANY (v_chunks::uuid[])
      UNION
      SELECT d.id FROM public.documents d WHERE d.id = ANY (v_documents::uuid[])
    ),
    true);

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_reason || E'\n' || 'chunks:' || pg_catalog.array_to_string(v_chunks, ',') || E'\n' || 'documents:' || pg_catalog.array_to_string(v_documents, ','),
      'UTF8')),
    'hex');
  v_window := pg_catalog.date_trunc('week', pg_catalog.now(), 'UTC');

  INSERT INTO public.rag_review_items AS i (
    tenant_key, trace_id, query_masked, query_fingerprint, reasons, snapshot, status, mining_window, mined_at, access_sets
  )
  VALUES (
    p_tenant_key, v_trace, '', v_fingerprint, ARRAY[p_reason]::text[],
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'reason', p_reason, 'detector', v_detector, 'trace_id', v_trace,
      'chunk_ids', pg_catalog.to_jsonb(v_chunks), 'document_ids', pg_catalog.to_jsonb(v_documents))),
    'open', v_window, pg_catalog.now(), v_access_sets
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

REVOKE ALL ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb) TO service_role;

DO $backfill$
BEGIN
  IF NOT public.rag_access_enforced() THEN
    RETURN;
  END IF;
  UPDATE public.rag_review_items AS i
  SET access_sets = public.rag_review_access_sets(i.tenant_key, NULL, ARRAY(
    SELECT DISTINCT (c ->> 'document_id')::uuid
    FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(i.candidates) = 'array' THEN i.candidates ELSE '[]'::jsonb END) AS c
    WHERE pg_catalog.jsonb_typeof(c) = 'object' AND pg_catalog.lower(c ->> 'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    UNION
    SELECT (e #>> '{}')::uuid
    FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(i.snapshot -> 'document_ids') = 'array' THEN i.snapshot -> 'document_ids' ELSE '[]'::jsonb END) AS e
    WHERE pg_catalog.lower(e #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    UNION
    SELECT ch.document_id FROM public.document_chunks ch
    WHERE ch.id = ANY (ARRAY(
      SELECT (e #>> '{}')::uuid
      FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(i.snapshot -> 'chunk_ids') = 'array' THEN i.snapshot -> 'chunk_ids' ELSE '[]'::jsonb END) AS e
      WHERE pg_catalog.lower(e #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ))
  ), false)
  WHERE i.access_sets IS NULL;
END
$backfill$;

NOTIFY pgrst, 'reload schema';

COMMIT;
