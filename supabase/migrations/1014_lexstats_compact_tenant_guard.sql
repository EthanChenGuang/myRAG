-- 1014: tenant guard on rag_lexstats_compact_tenant (quick-44-t09, T-04.4-09; LEX-06, D-32).
-- rag_lexstats_compact_tenant now calls rag_assert_tenant_key (0425) before any other statement, like every other Phase 4.4 function
-- taking p_tenant_key: a malformed key, NULL or a key of the other deployment mode raises 22023 and touches no row. The body is otherwise
-- the 0905 body (pending fold of both corpora, then cluster marker reconciliation under the same advisory lock).
-- rag_lexstats_compact_all is redefined from its 0905 body so that one stray rag_lexical_stats_state key still never stops it (plan
-- 04.4-04): a key the guard refuses is skipped inside its own subtransaction, the other tenants are compacted, and one WARNING carries
-- the skipped count only, never a key.
-- Security: both functions stay SECURITY INVOKER with an empty search_path, revoked from PUBLIC, anon and authenticated and granted to
-- service_role. No dynamic SQL.
-- Numbered 1014 so that it sorts after 0905, which defines the bodies it replaces (07xx would run first on a fresh apply and be
-- overwritten). Re-run rule: after re-running 0902 or 0905, re-run this file. Idempotent; not folded into the setup files.

BEGIN;

DO $lexstats_compact_guard_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_compact_tenant(text, integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_compact_all(integer)') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_cluster_dirty') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_cluster_units') IS NULL THEN
    RAISE EXCEPTION '1014: apply migrations 0425 and 0900 to 0905 first' USING ERRCODE = '55000';
  END IF;
END
$lexstats_compact_guard_precheck$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact_tenant(p_tenant_key text, p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_max integer := LEAST(GREATEST(COALESCE(p_max_rows, 5000), 1), 50000);
  v_cluster_status text;
  v_folded bigint;
  v_marks bigint := 0;
  v_mark_ids bigint[];
  v_clusters uuid[];
  v_df_corpus text[];
  v_df_lexeme text[];
  v_df_profile text[];
  v_df_language text[];
  v_c_corpus text[];
  v_c_profile text[];
  v_c_language text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
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

  SELECT s.cluster_status INTO v_cluster_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_cluster_status IS NOT NULL THEN
    SELECT COALESCE(pg_catalog.array_agg(m.id ORDER BY m.id), '{}'::bigint[]),
           COALESCE(pg_catalog.array_agg(DISTINCT m.dup_cluster_id), '{}'::uuid[])
      INTO v_mark_ids, v_clusters
      FROM (
        SELECT d.id, d.dup_cluster_id FROM public.rag_lexical_cluster_dirty d
         WHERE d.tenant_key = p_tenant_key
         ORDER BY d.id
         LIMIT v_max
      ) m;
    v_marks := pg_catalog.cardinality(v_mark_ids);
  END IF;

  IF v_marks > 0 THEN
    CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_cluster_delta (
      sign smallint NOT NULL,
      chunking_profile_id text NOT NULL,
      language text NOT NULL,
      lexemes text[] NOT NULL,
      dl integer NOT NULL
    ) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_cluster_new_units (
      dup_cluster_id uuid NOT NULL,
      chunking_profile_id text NOT NULL,
      language text NOT NULL,
      chunk_id uuid NOT NULL,
      lexemes text[] NOT NULL,
      dl integer NOT NULL
    ) ON COMMIT DROP;
    TRUNCATE pg_temp._rag_lexstats_cluster_delta;
    TRUNCATE pg_temp._rag_lexstats_cluster_new_units;

    INSERT INTO pg_temp._rag_lexstats_cluster_new_units (dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
    SELECT DISTINCT ON (c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'))
           c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'), c.id,
           pg_catalog.tsvector_to_array(c.lexical_tsv), public.rag_lexical_dl(c.lexical_tsv)
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.dup_cluster_id = ANY (v_clusters)
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
     ORDER BY c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'), c.id;

    INSERT INTO pg_temp._rag_lexstats_cluster_delta (sign, chunking_profile_id, language, lexemes, dl)
    SELECT (-1)::smallint, u.chunking_profile_id, u.language, u.lexemes, u.dl
      FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key AND u.dup_cluster_id = ANY (v_clusters)
    UNION ALL
    SELECT 1::smallint, n.chunking_profile_id, n.language, n.lexemes, n.dl
      FROM pg_temp._rag_lexstats_cluster_new_units n;

    WITH df_delta AS (
      SELECT u.lexeme, t.chunking_profile_id, t.language, pg_catalog.sum(t.sign)::bigint AS d
        FROM pg_temp._rag_lexstats_cluster_delta t
       CROSS JOIN LATERAL pg_catalog.unnest(t.lexemes) AS u(lexeme)
       GROUP BY u.lexeme, t.chunking_profile_id, t.language
      HAVING pg_catalog.sum(t.sign) <> 0
    ), df_up AS (
      INSERT INTO public.rag_lexical_df AS f (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
      SELECT p_tenant_key, 'chunks_cluster', x.lexeme, x.chunking_profile_id, x.language, x.d
        FROM df_delta x
       ORDER BY x.lexeme, x.chunking_profile_id, x.language
      ON CONFLICT (tenant_key, corpus, lexeme, chunking_profile_id, language) DO UPDATE SET df = f.df + EXCLUDED.df
      RETURNING f.corpus, f.lexeme, f.chunking_profile_id, f.language, f.df
    ), corpus_delta AS (
      SELECT t.chunking_profile_id, t.language,
             pg_catalog.sum(t.sign)::bigint AS n, pg_catalog.sum(t.sign::bigint * t.dl)::bigint AS len
        FROM pg_temp._rag_lexstats_cluster_delta t
       GROUP BY t.chunking_profile_id, t.language
      HAVING pg_catalog.sum(t.sign) <> 0 OR pg_catalog.sum(t.sign::bigint * t.dl) <> 0
    ), corpus_up AS (
      INSERT INTO public.rag_lexical_corpus AS c (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
      SELECT p_tenant_key, 'chunks_cluster', x.chunking_profile_id, x.language, x.n, x.len
        FROM corpus_delta x
       ORDER BY x.chunking_profile_id, x.language
      ON CONFLICT (tenant_key, corpus, chunking_profile_id, language)
        DO UPDATE SET chunk_count = c.chunk_count + EXCLUDED.chunk_count, total_len = c.total_len + EXCLUDED.total_len
      RETURNING c.corpus, c.chunking_profile_id, c.language, c.chunk_count
    )
    SELECT z.dc, z.dl, z.dp, z.dg, y.cc, y.cp, y.cg
      INTO v_df_corpus, v_df_lexeme, v_df_profile, v_df_language, v_c_corpus, v_c_profile, v_c_language
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

    DELETE FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key AND u.dup_cluster_id = ANY (v_clusters);
    INSERT INTO public.rag_lexical_cluster_units (tenant_key, dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
    SELECT p_tenant_key, n.dup_cluster_id, n.chunking_profile_id, n.language, n.chunk_id, n.lexemes, n.dl
      FROM pg_temp._rag_lexstats_cluster_new_units n
     ORDER BY n.dup_cluster_id, n.chunking_profile_id, n.language;

    DELETE FROM public.rag_lexical_cluster_dirty d
     WHERE d.tenant_key = p_tenant_key AND d.id = ANY (v_mark_ids);

    TRUNCATE pg_temp._rag_lexstats_cluster_delta;
    TRUNCATE pg_temp._rag_lexstats_cluster_new_units;
  END IF;

  IF v_folded + v_marks > 0 THEN
    UPDATE public.rag_lexical_stats_state s SET compacted_at = pg_catalog.now() WHERE s.tenant_key = p_tenant_key;
  END IF;
  RETURN v_folded + v_marks;
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
  v_skipped integer := 0;
BEGIN
  FOR v_key IN
    SELECT s.tenant_key
      FROM public.rag_lexical_stats_state s
     WHERE EXISTS (SELECT 1 FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = s.tenant_key)
        OR (s.cluster_status IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = s.tenant_key))
     ORDER BY s.tenant_key
  LOOP
    BEGIN
      v_total := v_total + public.rag_lexstats_compact_tenant(v_key, p_max_rows);
    EXCEPTION WHEN invalid_parameter_value THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;
  IF v_skipped > 0 THEN
    RAISE WARNING '[Lexical Stats] compact_all skipped % state row(s) with a tenant key not valid for this deployment mode', v_skipped;
  END IF;
  RETURN v_total;
END
$fn$;

-- Enable, rebuild, disable ----------------------------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_all(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_all(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
