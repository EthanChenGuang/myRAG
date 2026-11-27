-- 0902: Phase 4.4 maintenance of the per-tenant lexical statistics (LEX-02, LEX-03, LEX-06, D-17, D-18, D-19, D-32, D-34).
-- rag_lexstats_enable(tenant): adds the state row (status building) so the 0901 triggers start staging; idempotent, a ready tenant stays ready.
-- rag_lexstats_compact(tenant, max_rows): folds up to max_rows (1..50000) staged deltas, in id order, into rag_lexical_df and
-- rag_lexical_corpus with one ordered INSERT ... ON CONFLICT DO UPDATE each, then deletes the touched counters that reached zero or below;
-- returns the number of pending rows folded (0, without taking the lock, for a tenant with no state row).
-- rag_lexstats_compact_all(max_rows): one such batch for every enabled tenant with pending rows; returns the sum.
-- rag_lexstats_rebuild(tenant): raises lexical_stats_not_enabled (55000) without a state row; in one statement (one snapshot) deletes the
-- tenant's pending rows and scans its member chunks (D-11) into a staging temp table, then replaces the tenant's counters and sets ready.
-- A change committed after that snapshot keeps its pending row and is folded by the next compaction, so it is counted exactly once.
-- rag_lexstats_status(tenant) and rag_lexstats_check(tenant) return counts, timestamps and the state only, never a lexeme.
-- rag_lexstats_disable(tenant): removes the tenant's state row, pending rows and counters; the triggers then stage nothing for it.
-- Compaction, rebuild and disable serialise per tenant on pg_advisory_xact_lock(hashtextextended('rag_lexstats:' || tenant_key, 0)).
-- Every function is SECURITY INVOKER with an empty search_path and service_role only; each one that takes a tenant key calls
-- rag_assert_tenant_key first, and every statement names the tenant. rag_lexstats_compact_tenant is the unguarded body shared by
-- compact and compact_all (whose keys come from the state table), service_role only. No dynamic SQL. Idempotent; not folded into setup files.

BEGIN;

DO $lexical_stats_functions_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_pending') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_df') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_corpus') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_dl(tsvector)') IS NULL THEN
    RAISE EXCEPTION '0902: apply migrations 0403, 0900 and 0901 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_stats_functions_precheck$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_enable(p_tenant_key text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_status text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  INSERT INTO public.rag_lexical_stats_state (tenant_key, status)
  VALUES (p_tenant_key, 'building')
  ON CONFLICT (tenant_key) DO NOTHING;
  SELECT s.status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  RETURN v_status;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact_tenant(p_tenant_key text, p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_max integer := LEAST(GREATEST(COALESCE(p_max_rows, 5000), 1), 50000);
  v_folded bigint;
  v_df_corpus text[];
  v_df_lexeme text[];
  v_df_profile text[];
  v_df_language text[];
  v_c_corpus text[];
  v_c_profile text[];
  v_c_language text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RETURN 0;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));

  WITH taken AS (
    DELETE FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key
       AND p.id IN (
         SELECT q.id FROM public.rag_lexical_stats_pending q
          WHERE q.tenant_key = p_tenant_key
          ORDER BY q.id
          LIMIT v_max
       )
    RETURNING p.corpus, p.chunking_profile_id, p.language, p.sign, p.lexemes, p.dl
  ), df_delta AS (
    SELECT t.corpus, u.lexeme, t.chunking_profile_id, t.language, pg_catalog.sum(t.sign)::bigint AS d
      FROM taken t
     CROSS JOIN LATERAL pg_catalog.unnest(t.lexemes) AS u(lexeme)
     GROUP BY t.corpus, u.lexeme, t.chunking_profile_id, t.language
    HAVING pg_catalog.sum(t.sign) <> 0
  ), df_up AS (
    INSERT INTO public.rag_lexical_df AS f (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
    SELECT p_tenant_key, x.corpus, x.lexeme, x.chunking_profile_id, x.language, x.d
      FROM df_delta x
     ORDER BY x.corpus, x.lexeme, x.chunking_profile_id, x.language
    ON CONFLICT (tenant_key, corpus, lexeme, chunking_profile_id, language) DO UPDATE SET df = f.df + EXCLUDED.df
    RETURNING f.corpus, f.lexeme, f.chunking_profile_id, f.language, f.df
  ), corpus_delta AS (
    SELECT t.corpus, t.chunking_profile_id, t.language,
           pg_catalog.sum(t.sign)::bigint AS n, pg_catalog.sum(t.sign::bigint * t.dl)::bigint AS len
      FROM taken t
     GROUP BY t.corpus, t.chunking_profile_id, t.language
    HAVING pg_catalog.sum(t.sign) <> 0 OR pg_catalog.sum(t.sign::bigint * t.dl) <> 0
  ), corpus_up AS (
    INSERT INTO public.rag_lexical_corpus AS c (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
    SELECT p_tenant_key, x.corpus, x.chunking_profile_id, x.language, x.n, x.len
      FROM corpus_delta x
     ORDER BY x.corpus, x.chunking_profile_id, x.language
    ON CONFLICT (tenant_key, corpus, chunking_profile_id, language)
      DO UPDATE SET chunk_count = c.chunk_count + EXCLUDED.chunk_count, total_len = c.total_len + EXCLUDED.total_len
    RETURNING c.corpus, c.chunking_profile_id, c.language, c.chunk_count
  )
  SELECT (SELECT pg_catalog.count(*) FROM taken),
         z.dc, z.dl, z.dp, z.dg, y.cc, y.cp, y.cg
    INTO v_folded, v_df_corpus, v_df_lexeme, v_df_profile, v_df_language, v_c_corpus, v_c_profile, v_c_language
    FROM (SELECT pg_catalog.array_agg(d.corpus) AS dc, pg_catalog.array_agg(d.lexeme) AS dl,
                 pg_catalog.array_agg(d.chunking_profile_id) AS dp, pg_catalog.array_agg(d.language) AS dg
            FROM df_up d WHERE d.df <= 0) z,
         (SELECT pg_catalog.array_agg(k.corpus) AS cc, pg_catalog.array_agg(k.chunking_profile_id) AS cp,
                 pg_catalog.array_agg(k.language) AS cg
            FROM corpus_up k WHERE k.chunk_count <= 0) y;

  DELETE FROM public.rag_lexical_df f
   USING ROWS FROM (pg_catalog.unnest(v_df_corpus), pg_catalog.unnest(v_df_lexeme), pg_catalog.unnest(v_df_profile), pg_catalog.unnest(v_df_language)) AS k(corpus, lexeme, chunking_profile_id, language)
   WHERE f.tenant_key = p_tenant_key
     AND f.corpus = k.corpus AND f.lexeme = k.lexeme
     AND f.chunking_profile_id = k.chunking_profile_id AND f.language = k.language
     AND f.df <= 0;

  DELETE FROM public.rag_lexical_corpus c
   USING ROWS FROM (pg_catalog.unnest(v_c_corpus), pg_catalog.unnest(v_c_profile), pg_catalog.unnest(v_c_language)) AS k(corpus, chunking_profile_id, language)
   WHERE c.tenant_key = p_tenant_key
     AND c.corpus = k.corpus AND c.chunking_profile_id = k.chunking_profile_id AND c.language = k.language
     AND c.chunk_count <= 0;

  IF v_folded > 0 THEN
    UPDATE public.rag_lexical_stats_state s SET compacted_at = pg_catalog.now() WHERE s.tenant_key = p_tenant_key;
  END IF;
  RETURN v_folded;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact(p_tenant_key text, p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN public.rag_lexstats_compact_tenant(p_tenant_key, p_max_rows);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact_all(p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
  v_total bigint := 0;
BEGIN
  FOR v_key IN
    SELECT s.tenant_key
      FROM public.rag_lexical_stats_state s
     WHERE EXISTS (SELECT 1 FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = s.tenant_key)
     ORDER BY s.tenant_key
  LOOP
    v_total := v_total + public.rag_lexstats_compact_tenant(v_key, p_max_rows);
  END LOOP;
  RETURN v_total;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_rebuild(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_chunks bigint;
  v_lexeme_rows bigint;
  v_corpus_rows bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'lexical_stats_not_enabled' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));

  CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_staging (
    kind smallint NOT NULL,
    lexeme text,
    chunking_profile_id text NOT NULL,
    language text NOT NULL,
    n bigint NOT NULL,
    len bigint
  ) ON COMMIT DROP;
  TRUNCATE pg_temp._rag_lexstats_staging;

  -- One statement, one snapshot: the pending rows it deletes are exactly those whose changes the scan sees.
  WITH gone AS (
    DELETE FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks'
    RETURNING p.id
  ), member AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
  )
  INSERT INTO pg_temp._rag_lexstats_staging (kind, lexeme, chunking_profile_id, language, n, len)
  SELECT 1::smallint, u.lexeme, m.chunking_profile_id, m.language, pg_catalog.count(*), NULL::bigint
    FROM member m
   CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.tsvector_to_array(m.lexical_tsv)) AS u(lexeme)
   GROUP BY u.lexeme, m.chunking_profile_id, m.language
  UNION ALL
  SELECT 2::smallint, NULL::text, m.chunking_profile_id, m.language, pg_catalog.count(*),
         pg_catalog.sum(public.rag_lexical_dl(m.lexical_tsv))::bigint
    FROM member m
   GROUP BY m.chunking_profile_id, m.language;

  DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks';
  INSERT INTO public.rag_lexical_df (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
  SELECT p_tenant_key, 'chunks', g.lexeme, g.chunking_profile_id, g.language, g.n
    FROM pg_temp._rag_lexstats_staging g
   WHERE g.kind = 1
   ORDER BY g.lexeme, g.chunking_profile_id, g.language;
  GET DIAGNOSTICS v_lexeme_rows = ROW_COUNT;

  DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks';
  INSERT INTO public.rag_lexical_corpus (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
  SELECT p_tenant_key, 'chunks', g.chunking_profile_id, g.language, g.n, g.len
    FROM pg_temp._rag_lexstats_staging g
   WHERE g.kind = 2
   ORDER BY g.chunking_profile_id, g.language;
  GET DIAGNOSTICS v_corpus_rows = ROW_COUNT;

  SELECT COALESCE(pg_catalog.sum(g.n), 0)::bigint INTO v_chunks FROM pg_temp._rag_lexstats_staging g WHERE g.kind = 2;
  TRUNCATE pg_temp._rag_lexstats_staging;

  UPDATE public.rag_lexical_stats_state s
     SET status = 'ready', rebuilt_at = pg_catalog.now()
   WHERE s.tenant_key = p_tenant_key;

  RETURN pg_catalog.jsonb_build_object('chunk_count', v_chunks, 'lexeme_rows', v_lexeme_rows, 'corpus_rows', v_corpus_rows);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_status(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_out jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT pg_catalog.jsonb_build_object(
           'state', s.status,
           'chunk_count', COALESCE((SELECT pg_catalog.sum(c.chunk_count) FROM public.rag_lexical_corpus c
                                     WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks'), 0)::bigint,
           'lexeme_count', (SELECT pg_catalog.count(DISTINCT f.lexeme) FROM public.rag_lexical_df f
                             WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks'),
           'pending', (SELECT pg_catalog.count(*) FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key),
           'oldest_pending_age_s', (SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.now() - pg_catalog.min(p.created_at)))::bigint
                                      FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key),
           'enabled_at', s.enabled_at,
           'rebuilt_at', s.rebuilt_at,
           'compacted_at', s.compacted_at)
    INTO v_out
    FROM (SELECT 1) AS one
    LEFT JOIN public.rag_lexical_stats_state s ON s.tenant_key = p_tenant_key;
  RETURN v_out;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_check(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_state text;
  v_pending bigint;
  v_df_mismatch bigint;
  v_df_mismatch_p bigint;
  v_count_diff bigint;
  v_count_diff_p bigint;
  v_len_diff bigint;
  v_len_diff_p bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT s.status INTO v_state FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  SELECT pg_catalog.count(*) INTO v_pending FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key;
  IF v_state IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'state', NULL::text, 'pending', v_pending,
      'df_mismatch', NULL::bigint, 'df_mismatch_with_pending', NULL::bigint,
      'chunk_count_diff', NULL::bigint, 'chunk_count_diff_with_pending', NULL::bigint,
      'total_len_diff', NULL::bigint, 'total_len_diff_with_pending', NULL::bigint,
      'clean', NULL::boolean);
  END IF;

  WITH member AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
  ), pend AS MATERIALIZED (
    SELECT p.chunking_profile_id, p.language, p.sign, p.lexemes, p.dl
      FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks'
  ), re_df AS (
    SELECT u.lexeme, m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS v
      FROM member m CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.tsvector_to_array(m.lexical_tsv)) AS u(lexeme)
     GROUP BY u.lexeme, m.chunking_profile_id, m.language
  ), ct_df AS (
    SELECT f.lexeme, f.chunking_profile_id, f.language, f.df AS v
      FROM public.rag_lexical_df f
     WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks'
  ), pd_df AS (
    SELECT u.lexeme, p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS v
      FROM pend p CROSS JOIN LATERAL pg_catalog.unnest(p.lexemes) AS u(lexeme)
     GROUP BY u.lexeme, p.chunking_profile_id, p.language
  ), df_cmp AS (
    SELECT COALESCE(r.v, 0) AS r, COALESCE(c.v, 0) AS c, COALESCE(d.v, 0) AS d
      FROM re_df r
      FULL JOIN ct_df c USING (lexeme, chunking_profile_id, language)
      FULL JOIN pd_df d USING (lexeme, chunking_profile_id, language)
  )
  SELECT pg_catalog.count(*) FILTER (WHERE x.r <> x.c), pg_catalog.count(*) FILTER (WHERE x.r <> x.c + x.d)
    INTO v_df_mismatch, v_df_mismatch_p
    FROM df_cmp x;

  WITH member AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, public.rag_lexical_dl(c.lexical_tsv) AS dl
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
  ), re_c AS (
    SELECT m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS n, pg_catalog.sum(m.dl)::bigint AS len
      FROM member m GROUP BY m.chunking_profile_id, m.language
  ), ct_c AS (
    SELECT c.chunking_profile_id, c.language, c.chunk_count AS n, c.total_len AS len
      FROM public.rag_lexical_corpus c
     WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks'
  ), pd_c AS (
    SELECT p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS n, pg_catalog.sum(p.sign::bigint * p.dl)::bigint AS len
      FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks'
     GROUP BY p.chunking_profile_id, p.language
  ), c_cmp AS (
    SELECT COALESCE(r.n, 0) AS rn, COALESCE(c.n, 0) AS cn, COALESCE(d.n, 0) AS dn,
           COALESCE(r.len, 0) AS rl, COALESCE(c.len, 0) AS cl, COALESCE(d.len, 0) AS dl
      FROM re_c r
      FULL JOIN ct_c c USING (chunking_profile_id, language)
      FULL JOIN pd_c d USING (chunking_profile_id, language)
  )
  SELECT COALESCE(pg_catalog.sum(pg_catalog.abs(x.rn - x.cn)), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(x.rn - x.cn - x.dn)), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(x.rl - x.cl)), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(x.rl - x.cl - x.dl)), 0)::bigint
    INTO v_count_diff, v_count_diff_p, v_len_diff, v_len_diff_p
    FROM c_cmp x;

  RETURN pg_catalog.jsonb_build_object(
    'state', v_state,
    'pending', v_pending,
    'df_mismatch', v_df_mismatch,
    'df_mismatch_with_pending', v_df_mismatch_p,
    'chunk_count_diff', v_count_diff,
    'chunk_count_diff_with_pending', v_count_diff_p,
    'total_len_diff', v_len_diff,
    'total_len_diff_with_pending', v_len_diff_p,
    'clean', v_df_mismatch_p = 0 AND v_count_diff_p = 0 AND v_len_diff_p = 0);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_disable(p_tenant_key text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_existed boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));
  DELETE FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  v_existed := FOUND;
  DELETE FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key;
  RETURN v_existed;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_lexstats_enable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_disable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_rebuild(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_all(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_status(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_check(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_lexstats_enable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_disable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_rebuild(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_all(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_status(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_check(text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
