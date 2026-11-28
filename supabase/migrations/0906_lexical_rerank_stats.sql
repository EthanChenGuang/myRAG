-- Phase 4.4 plan 04.4-21 (D-55, D-56): rag_lexical_rerank_stats, the tenant statistics read of the local_bm25 reranker under
-- RAG_RERANK_LOCAL_STATS=tenant. For each asked (doc type, language) pair it returns the effective chunking profile of the doc type (the
-- rule of rag_bm25_search_chunks: the override, else the active profile, else legacy), the chunk count and total length of the tenant's
-- compacted statistics for that profile and language, and the df of each asked term (0 without a counter; the caller clamps). It reads
-- the compacted counters only, as rag_bm25_search_chunks does; staged deltas are not folded in. Counts for the asked terms only, never a
-- lexeme list. Raises lexical_stats_not_ready (55000) for a tenant without ready statistics; the caller falls back to pool statistics.
-- Both deployment modes, not folded, idempotent; no table, trigger or existing function changes. SECURITY INVOKER, empty search_path,
-- service_role only; the tenant key is checked by rag_assert_tenant_key.
BEGIN;

DO $guard$
BEGIN
  IF pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_df') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_corpus') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL THEN
    RAISE EXCEPTION '0906: apply 0900 to 0902 first' USING ERRCODE = '55000';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.rag_lexical_rerank_stats(
  p_tenant_key text,
  p_terms text[],
  p_doc_types text[],
  p_languages text[],
  p_chunking_override jsonb DEFAULT NULL
)
RETURNS TABLE (
  doc_type text,
  language text,
  chunking_profile_id text,
  chunk_count bigint,
  total_len bigint,
  terms text[],
  dfs bigint[]
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_terms text[];
  v_status text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF pg_catalog.cardinality(COALESCE(p_doc_types, '{}'::text[])) <> pg_catalog.cardinality(COALESCE(p_languages, '{}'::text[])) THEN
    RAISE EXCEPTION 'rag_lexical_rerank_stats: doc types and languages are pairs' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(COALESCE(p_terms, '{}'::text[])) > 64 THEN
    RAISE EXCEPTION 'rag_lexical_rerank_stats: at most 64 terms' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(COALESCE(p_doc_types, '{}'::text[])) > 64 THEN
    RAISE EXCEPTION 'rag_lexical_rerank_stats: at most 64 pairs' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL AND pg_catalog.jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'rag_lexical_rerank_stats: invalid chunking override' USING ERRCODE = '22023';
  END IF;

  -- The term forms rag_bm25_search_chunks accepts, distinct, in the asked order.
  SELECT pg_catalog.array_agg(t.tok ORDER BY t.first_ord) INTO v_terms
  FROM (
    SELECT u.tok, pg_catalog.min(u.ord) AS first_ord
    FROM pg_catalog.unnest(COALESCE(p_terms, '{}'::text[])) WITH ORDINALITY AS u(tok, ord)
    WHERE u.tok <> '' AND pg_catalog.octet_length(u.tok) <= 255 AND u.tok !~ '[''\\[:space:]]'
    GROUP BY u.tok
  ) AS t;
  IF v_terms IS NULL OR pg_catalog.cardinality(COALESCE(p_doc_types, '{}'::text[])) = 0 THEN
    RETURN;
  END IF;

  SELECT s.status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the tenant has no ready lexical statistics' USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  WITH pairs AS (
    SELECT DISTINCT pr.doc_type, pr.language
    FROM ROWS FROM (pg_catalog.unnest(p_doc_types), pg_catalog.unnest(p_languages)) AS pr(doc_type, language)
    WHERE pr.doc_type IS NOT NULL AND pr.language IS NOT NULL
  ), eff AS (
    SELECT p.doc_type, p.language,
           COALESCE(
             NULLIF(pg_catalog.btrim(p_chunking_override ->> p.doc_type), ''),
             (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = p.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
             'legacy'
           ) AS profile_id
    FROM pairs p
  )
  SELECT e.doc_type, e.language, e.profile_id,
         COALESCE(lc.chunk_count, 0)::bigint,
         COALESCE(lc.total_len, 0)::bigint,
         v_terms,
         (SELECT pg_catalog.array_agg(COALESCE(d.df, 0)::bigint ORDER BY t.ord)
            FROM pg_catalog.unnest(v_terms) WITH ORDINALITY AS t(tok, ord)
            LEFT JOIN public.rag_lexical_df d
              ON d.tenant_key = p_tenant_key AND d.corpus = 'chunks' AND d.lexeme = t.tok
             AND d.chunking_profile_id = e.profile_id AND d.language = e.language)
  FROM eff e
  LEFT JOIN public.rag_lexical_corpus lc
    ON lc.tenant_key = p_tenant_key AND lc.corpus = 'chunks' AND lc.chunking_profile_id = e.profile_id AND lc.language = e.language
  ORDER BY e.doc_type, e.language;
END
$fn$;

COMMENT ON FUNCTION public.rag_lexical_rerank_stats(text, text[], text[], text[], jsonb) IS
  '04.4-21 D-55: compacted chunk count, total length and per-term df of one tenant for the local reranker, per (doc type, language); service_role only.';

REVOKE ALL ON FUNCTION public.rag_lexical_rerank_stats(text, text[], text[], text[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_lexical_rerank_stats(text, text[], text[], text[], jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
