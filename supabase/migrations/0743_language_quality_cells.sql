-- 0743: rag_language_quality_cells (Phase 7 plan 07-46, LANG-10, OBS-03). Per (tenant_key, query language) counts of
-- public.rag_retrieval_log rows created in [p_since, p_until), read from the columns Phase 5.1.1 froze (D-29) only:
-- outcome, feedback_vote, feedback_kind, query_language, query_language_confidence, created_at (and the generated tenant_key).
-- retrievals: rows; refused: outcome refused_no_context; kb_unavailable: outcome kb_unavailable; votes_up / votes_down:
-- feedback_vote 1 / -1 with feedback_kind answer or embed; low_confidence: query_language_confidence below p_min_confidence
-- (0.75 when null, so the mapped 0.5 is low and 1 is not). A row without a language, or with a confidence that is null or below
-- p_min_confidence when p_min_confidence is given, counts under und. p_tenant_keys null reads every tenant; every key given is
-- checked with rag_assert_tenant_key (22023 on a malformed key or a key of the other deployment mode). The window must be
-- non-empty and at most 400 days (22023). Counts only, never text. SECURITY INVOKER with an empty search path, service_role only.
-- Idempotent, not folded.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_language_quality_cells(
  p_since timestamptz,
  p_until timestamptz,
  p_tenant_keys text[] DEFAULT NULL,
  p_min_confidence real DEFAULT NULL
)
RETURNS TABLE (
  tenant_key text,
  language text,
  retrievals bigint,
  refused bigint,
  kb_unavailable bigint,
  votes_up bigint,
  votes_down bigint,
  low_confidence bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
  v_low real := COALESCE(p_min_confidence, 0.75::real);
BEGIN
  IF p_since IS NULL OR p_until IS NULL OR p_since >= p_until THEN
    RAISE EXCEPTION 'window must be a non-empty range' USING ERRCODE = '22023';
  END IF;
  IF p_until - p_since > interval '400 days' THEN
    RAISE EXCEPTION 'window must not exceed 400 days' USING ERRCODE = '22023';
  END IF;
  IF p_min_confidence IS NOT NULL AND (p_min_confidence < 0 OR p_min_confidence > 1) THEN
    RAISE EXCEPTION 'min confidence must be within 0 and 1' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_keys IS NOT NULL THEN
    FOREACH v_key IN ARRAY p_tenant_keys LOOP
      PERFORM public.rag_assert_tenant_key(v_key);
    END LOOP;
  END IF;

  RETURN;
  RETURN QUERY
  SELECT
    l.tenant_key,
    CASE
      WHEN l.query_language IS NULL THEN 'und'
      WHEN p_min_confidence IS NOT NULL
        AND (l.query_language_confidence IS NULL OR l.query_language_confidence < p_min_confidence) THEN 'und'
      ELSE l.query_language
    END AS language,
    count(*)::bigint AS retrievals,
    count(*) FILTER (WHERE l.outcome = 'refused_no_context')::bigint AS refused,
    count(*) FILTER (WHERE l.outcome = 'kb_unavailable')::bigint AS kb_unavailable,
    count(*) FILTER (WHERE l.feedback_vote = 1 AND l.feedback_kind IN ('answer', 'embed'))::bigint AS votes_up,
    count(*) FILTER (WHERE l.feedback_vote = -1 AND l.feedback_kind IN ('answer', 'embed'))::bigint AS votes_down,
    count(*) FILTER (WHERE l.query_language_confidence IS NOT NULL AND l.query_language_confidence < v_low)::bigint AS low_confidence
  FROM public.rag_retrieval_log l
  WHERE l.created_at >= p_since
    AND l.created_at < p_until
    AND (p_tenant_keys IS NULL OR l.tenant_key = ANY (p_tenant_keys))
  GROUP BY 1, 2
  ORDER BY 1, 2;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_language_quality_cells(timestamptz, timestamptz, text[], real) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_language_quality_cells(timestamptz, timestamptz, text[], real) TO service_role;

COMMENT ON FUNCTION public.rag_language_quality_cells(timestamptz, timestamptz, text[], real) IS
  'LANG-10: per (tenant, query language) counts of the frozen FBK-01 log columns over a window; counts only, service_role only.';

COMMIT;
