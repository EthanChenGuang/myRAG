-- Phase 4.4 plan 04.4-21 (D-55, D-56): rag_lexical_rerank_stats, the tenant statistics read of the local_bm25 reranker under
-- RAG_RERANK_LOCAL_STATS=tenant. For each asked rerank candidate (a chunk id of the caller's tenant) it returns that chunk's own chunking
-- profile and language ('und' when none), the chunk count and total length of the tenant's compacted statistics for that profile and
-- language, and the df of each asked term (0 without a counter; the caller clamps). A chunk id of another tenant, or an unknown one, gives
-- no row. It reads the compacted counters only, as rag_bm25_search_chunks does; staged deltas are not folded in. Counts for the asked
-- terms only, never a lexeme list. Raises lexical_stats_not_ready (55000) for a tenant without ready statistics; the caller then uses pool
-- statistics. Both deployment modes, not folded, idempotent; no table, trigger or existing function changes. SECURITY INVOKER, empty
-- search_path, service_role only; the tenant key is checked by rag_assert_tenant_key.
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

-- An earlier body of this file took (doc type, language) pairs; drop every overload so exactly one signature remains.
DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rag_lexical_rerank_stats'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.rag_lexical_rerank_stats(
  p_tenant_key text,
  p_terms text[],
  p_chunk_ids uuid[]
)
RETURNS TABLE (
  chunk_id uuid,
  chunking_profile_id text,
  language text,
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

  IF pg_catalog.cardinality(COALESCE(p_terms, '{}'::text[])) > 64 THEN
    RAISE EXCEPTION 'rag_lexical_rerank_stats: at most 64 terms' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(COALESCE(p_chunk_ids, '{}'::uuid[])) > 500 THEN
    RAISE EXCEPTION 'rag_lexical_rerank_stats: at most 500 chunks' USING ERRCODE = '22023';
  END IF;

  -- The term forms rag_bm25_search_chunks accepts, distinct, in the asked order.
  SELECT pg_catalog.array_agg(t.tok ORDER BY t.first_ord) INTO v_terms
  FROM (
    SELECT u.tok, pg_catalog.min(u.ord) AS first_ord
    FROM pg_catalog.unnest(COALESCE(p_terms, '{}'::text[])) WITH ORDINALITY AS u(tok, ord)
    WHERE u.tok <> '' AND pg_catalog.octet_length(u.tok) <= 255 AND u.tok !~ '[''\\[:space:]]'
    GROUP BY u.tok
  ) AS t;
  IF v_terms IS NULL OR pg_catalog.cardinality(COALESCE(p_chunk_ids, '{}'::uuid[])) = 0 THEN
    RETURN;
  END IF;

  SELECT s.status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the tenant has no ready lexical statistics' USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  WITH cand AS MATERIALIZED (
    SELECT c.id, c.chunking_profile_id AS profile_id, COALESCE(c.language, 'und') AS lang
    FROM public.document_chunks c
    WHERE c.tenant_key = p_tenant_key AND c.id = ANY (p_chunk_ids)
  ), grp AS MATERIALIZED (
    SELECT g.profile_id, g.lang,
           COALESCE(lc.chunk_count, 0)::bigint AS n,
           COALESCE(lc.total_len, 0)::bigint AS len,
           (SELECT pg_catalog.array_agg(COALESCE(d.df, 0)::bigint ORDER BY t.ord)
              FROM pg_catalog.unnest(v_terms) WITH ORDINALITY AS t(tok, ord)
              LEFT JOIN public.rag_lexical_df d
                ON d.tenant_key = p_tenant_key AND d.corpus = 'chunks' AND d.lexeme = t.tok
               AND d.chunking_profile_id = g.profile_id AND d.language = g.lang) AS df
    FROM (SELECT DISTINCT cand.profile_id, cand.lang FROM cand) AS g
    LEFT JOIN public.rag_lexical_corpus lc
      ON lc.tenant_key = p_tenant_key AND lc.corpus = 'chunks' AND lc.chunking_profile_id = g.profile_id AND lc.language = g.lang
  )
  SELECT cand.id, cand.profile_id, cand.lang, grp.n, grp.len, v_terms, grp.df
  FROM cand JOIN grp ON grp.profile_id = cand.profile_id AND grp.lang = cand.lang
  ORDER BY cand.id;
END
$fn$;

COMMENT ON FUNCTION public.rag_lexical_rerank_stats(text, text[], uuid[]) IS
  '04.4-21 D-55: per rerank candidate of the caller tenant, its profile and language bucket: compacted chunk count, total length and df of the asked terms; service_role only.';

REVOKE ALL ON FUNCTION public.rag_lexical_rerank_stats(text, text[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_lexical_rerank_stats(text, text[], uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
