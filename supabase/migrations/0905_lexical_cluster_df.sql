-- 0905: Phase 4.4 cluster-aware BM25 document frequency statistics (plan 04.4-16, LEX-02, LEX-03, LEX-06, D-46, D-47, D-48).
-- A second corpus value 'chunks_cluster' in rag_lexical_stats_pending, rag_lexical_df and rag_lexical_corpus counts units instead of
-- chunks: a member chunk (D-11) without a cluster is one unit; for each (tenant_key, dup_cluster_id, chunking_profile_id, language or
-- 'und') the member chunk with the smallest id is the unit, and the other copies add nothing (D-46). The unit is read from
-- document_chunks alone, never from rag_dup_clusters.representative_chunk_id. Corpus 'chunks' and its rows are unchanged.
-- Kept only for a tenant whose rag_lexical_stats_state.cluster_status is set (rag_lexstats_cluster_enable); the default deployment and a
-- raw-only tenant write nothing new. cluster_status: NULL (off) | building | ready; rag_lexstats_rebuild sets ready.
-- Staging (D-47): the three 0901 trigger functions keep their corpus 'chunks' statements as they are and, for cluster-enabled tenants,
-- stage signed 'chunks_cluster' pending rows for member chunks without a cluster and one append-only rag_lexical_cluster_dirty row for
-- each cluster a changed chunk left or joined (a dup_cluster_id-only update and the ON DELETE SET NULL update included). No counter is
-- touched on the write path.
-- Reconciliation (D-48): rag_lexstats_compact_tenant folds pending rows of both corpora, then, under the same advisory lock, reconciles
-- up to p_max_rows marker rows against the ledger rag_lexical_cluster_units (unit chunk id, lexemes, length per cluster, profile and
-- language): subtract the recorded unit, add the recomputed one, rewrite the ledger, delete exactly the marker rows read. It returns
-- pending rows folded plus marker rows removed, so "compact until 0" loops end.
-- rag_lexstats_check adds, for a cluster-enabled tenant, cluster_df_diff, cluster_chunk_count_diff, cluster_total_len_diff (counters plus
-- pending equal the recompute of cluster-less members plus the ledger sum) and cluster_ledger_diff (for every cluster without a marker
-- the ledger equals the recomputed units); rag_lexstats_status adds cluster_status, cluster_dirty and cluster_oldest_dirty_at. Counts,
-- timestamps and states only, never a lexeme (D-34).
-- rag_lexstats_cluster_disable removes the tenant's cluster rows (pending, counters, markers, ledger); rag_lexstats_disable removes all.
-- rag_purge_hook_lexical_stats first marks every ledger row whose unit chunk no longer exists, then compacts until nothing is left.
-- rag_purge_store_inventory() is absent on trunk, so this file adds no inventory row (hand-off handoffs/04.4-07-purge-inventory.md).
-- Security: the trigger functions stay SECURITY DEFINER with no caller input (allow-listed since 0901, guarded in 0410); every other
-- function is SECURITY INVOKER; all have an empty search_path, are revoked from PUBLIC, anon and authenticated and granted to service_role;
-- every function taking p_tenant_key calls rag_assert_tenant_key first and names the tenant in every statement. The two new tables have
-- RLS on, no policy, no client grant and the tenant-key guard trigger of 0853. No dynamic SQL.
-- Re-run rule: after re-running 0901, 0902 or 0903, re-run this file. Idempotent; not folded into the setup files.

BEGIN;

DO $lexical_cluster_df_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_pending') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_df') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_corpus') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_dl(tsvector)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_chunks_update()') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_compact_tenant(text, integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_purge_hook_lexical_stats(text, uuid, uuid[])') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_row_tenant_key_guard()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.document_chunks') AND a.attname = 'dup_cluster_id' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0905: apply migrations 0853 and 0900 to 0903 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_cluster_df_precheck$;

-- Schema -----------------------------------------------------------------------------------------------------------------------------

ALTER TABLE public.rag_lexical_stats_state ADD COLUMN IF NOT EXISTS cluster_status text;
ALTER TABLE public.rag_lexical_stats_state ADD COLUMN IF NOT EXISTS cluster_rebuilt_at timestamptz;
ALTER TABLE public.rag_lexical_stats_state DROP CONSTRAINT IF EXISTS rag_lexical_stats_state_cluster_status_check;
ALTER TABLE public.rag_lexical_stats_state
  ADD CONSTRAINT rag_lexical_stats_state_cluster_status_check CHECK (cluster_status IS NULL OR cluster_status IN ('building', 'ready'));

ALTER TABLE public.rag_lexical_stats_pending DROP CONSTRAINT IF EXISTS rag_lexical_stats_pending_corpus_check;
ALTER TABLE public.rag_lexical_stats_pending
  ADD CONSTRAINT rag_lexical_stats_pending_corpus_check CHECK (corpus IN ('chunks', 'translations', 'chunks_cluster'));
ALTER TABLE public.rag_lexical_df DROP CONSTRAINT IF EXISTS rag_lexical_df_corpus_check;
ALTER TABLE public.rag_lexical_df
  ADD CONSTRAINT rag_lexical_df_corpus_check CHECK (corpus IN ('chunks', 'translations', 'chunks_cluster'));
ALTER TABLE public.rag_lexical_corpus DROP CONSTRAINT IF EXISTS rag_lexical_corpus_corpus_check;
ALTER TABLE public.rag_lexical_corpus
  ADD CONSTRAINT rag_lexical_corpus_corpus_check CHECK (corpus IN ('chunks', 'translations', 'chunks_cluster'));

CREATE TABLE IF NOT EXISTS public.rag_lexical_cluster_dirty (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_key text NOT NULL,
  dup_cluster_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS rag_lexical_cluster_dirty_tenant_id_idx ON public.rag_lexical_cluster_dirty (tenant_key, id);

CREATE TABLE IF NOT EXISTS public.rag_lexical_cluster_units (
  tenant_key text NOT NULL,
  dup_cluster_id uuid NOT NULL,
  chunking_profile_id text NOT NULL,
  language text NOT NULL,
  chunk_id uuid NOT NULL,
  lexemes text[] NOT NULL,
  dl integer NOT NULL,
  CONSTRAINT rag_lexical_cluster_units_pkey PRIMARY KEY (tenant_key, dup_cluster_id, chunking_profile_id, language)
);

ALTER TABLE public.rag_lexical_cluster_dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_lexical_cluster_units ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_lexical_cluster_dirty FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_lexical_cluster_units FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.rag_lexical_cluster_dirty_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.rag_lexical_cluster_dirty TO service_role;
GRANT ALL ON TABLE public.rag_lexical_cluster_units TO service_role;
GRANT ALL ON SEQUENCE public.rag_lexical_cluster_dirty_id_seq TO service_role;

DROP TRIGGER IF EXISTS rag_lexical_cluster_dirty_tenant_key_guard ON public.rag_lexical_cluster_dirty;
CREATE TRIGGER rag_lexical_cluster_dirty_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_lexical_cluster_dirty
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

DROP TRIGGER IF EXISTS rag_lexical_cluster_units_tenant_key_guard ON public.rag_lexical_cluster_units;
CREATE TRIGGER rag_lexical_cluster_units_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_lexical_cluster_units
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

-- Staging (D-47): the 0901 bodies, unchanged for corpus 'chunks', plus the cluster branch -------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_lexstats_chunks_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl)
  SELECT n.tenant_key, n.chunking_profile_id, COALESCE(n.language, 'und'), 1::smallint,
         pg_catalog.tsvector_to_array(n.lexical_tsv), public.rag_lexical_dl(n.lexical_tsv)
    FROM new_rows n
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = n.tenant_key
   WHERE n.is_current AND n.status IN ('ready', 'variant')
     AND n.lexical_tsv IS NOT NULL AND n.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY n.id;

  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.cluster_status IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, corpus, chunking_profile_id, language, sign, lexemes, dl)
  SELECT n.tenant_key, 'chunks_cluster', n.chunking_profile_id, COALESCE(n.language, 'und'), 1::smallint,
         pg_catalog.tsvector_to_array(n.lexical_tsv), public.rag_lexical_dl(n.lexical_tsv)
    FROM new_rows n
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = n.tenant_key AND s.cluster_status IS NOT NULL
   WHERE n.dup_cluster_id IS NULL
     AND n.is_current AND n.status IN ('ready', 'variant')
     AND n.lexical_tsv IS NOT NULL AND n.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY n.id;
  INSERT INTO public.rag_lexical_cluster_dirty (tenant_key, dup_cluster_id)
  SELECT g.tenant_key, g.dup_cluster_id
    FROM (
      SELECT DISTINCT n.tenant_key, n.dup_cluster_id
        FROM new_rows n
        JOIN public.rag_lexical_stats_state s ON s.tenant_key = n.tenant_key AND s.cluster_status IS NOT NULL
       WHERE n.dup_cluster_id IS NOT NULL
         AND n.is_current AND n.status IN ('ready', 'variant')
         AND n.lexical_tsv IS NOT NULL AND n.lexical_tsv <> ''::pg_catalog.tsvector
    ) g
   ORDER BY g.tenant_key, g.dup_cluster_id;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_chunks_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state) THEN
    RETURN NULL;
  END IF;
  WITH pairs AS (
    SELECT o.id,
           o.tenant_key AS o_tenant, o.chunking_profile_id AS o_profile, o.language AS o_language, o.lexical_tsv AS o_tsv,
           COALESCE(o.is_current AND o.status IN ('ready', 'variant') AND o.lexical_tsv IS NOT NULL
                    AND o.lexical_tsv <> ''::pg_catalog.tsvector, false) AS o_member,
           n.tenant_key AS n_tenant, n.chunking_profile_id AS n_profile, n.language AS n_language, n.lexical_tsv AS n_tsv,
           COALESCE(n.is_current AND n.status IN ('ready', 'variant') AND n.lexical_tsv IS NOT NULL
                    AND n.lexical_tsv <> ''::pg_catalog.tsvector, false) AS n_member
      FROM old_rows o
      JOIN new_rows n ON n.id = o.id
  ), changed AS (
    SELECT p.* FROM pairs p
     WHERE (p.o_member OR p.n_member)
       AND (p.o_member IS DISTINCT FROM p.n_member
            OR p.o_tsv IS DISTINCT FROM p.n_tsv
            OR p.o_tenant IS DISTINCT FROM p.n_tenant
            OR p.o_profile IS DISTINCT FROM p.n_profile
            OR p.o_language IS DISTINCT FROM p.n_language)
  ), deltas AS (
    SELECT c.id, c.o_tenant AS tenant_key, c.o_profile AS chunking_profile_id, c.o_language AS language, (-1)::smallint AS sign, c.o_tsv AS tsv
      FROM changed c WHERE c.o_member
    UNION ALL
    SELECT c.id, c.n_tenant, c.n_profile, c.n_language, 1::smallint, c.n_tsv
      FROM changed c WHERE c.n_member
  )
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl)
  SELECT x.tenant_key, x.chunking_profile_id, COALESCE(x.language, 'und'), x.sign,
         pg_catalog.tsvector_to_array(x.tsv), public.rag_lexical_dl(x.tsv)
    FROM deltas x
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = x.tenant_key
   ORDER BY x.id, x.sign;

  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.cluster_status IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  -- One statement: both inserts read the same changed rows; the cluster change test adds dup_cluster_id to the 'chunks' test above.
  WITH pairs AS (
    SELECT o.id,
           o.tenant_key AS o_tenant, o.chunking_profile_id AS o_profile, o.language AS o_language, o.lexical_tsv AS o_tsv,
           o.dup_cluster_id AS o_cluster,
           COALESCE(o.is_current AND o.status IN ('ready', 'variant') AND o.lexical_tsv IS NOT NULL
                    AND o.lexical_tsv <> ''::pg_catalog.tsvector, false) AS o_member,
           n.tenant_key AS n_tenant, n.chunking_profile_id AS n_profile, n.language AS n_language, n.lexical_tsv AS n_tsv,
           n.dup_cluster_id AS n_cluster,
           COALESCE(n.is_current AND n.status IN ('ready', 'variant') AND n.lexical_tsv IS NOT NULL
                    AND n.lexical_tsv <> ''::pg_catalog.tsvector, false) AS n_member
      FROM old_rows o
      JOIN new_rows n ON n.id = o.id
  ), changed AS MATERIALIZED (
    SELECT p.* FROM pairs p
     WHERE (p.o_member OR p.n_member)
       AND (p.o_member IS DISTINCT FROM p.n_member
            OR p.o_tsv IS DISTINCT FROM p.n_tsv
            OR p.o_tenant IS DISTINCT FROM p.n_tenant
            OR p.o_profile IS DISTINCT FROM p.n_profile
            OR p.o_language IS DISTINCT FROM p.n_language
            OR p.o_cluster IS DISTINCT FROM p.n_cluster)
  ), staged AS (
    INSERT INTO public.rag_lexical_stats_pending (tenant_key, corpus, chunking_profile_id, language, sign, lexemes, dl)
    SELECT x.tenant_key, 'chunks_cluster', x.chunking_profile_id, COALESCE(x.language, 'und'), x.sign,
           pg_catalog.tsvector_to_array(x.tsv), public.rag_lexical_dl(x.tsv)
      FROM (
        SELECT c.id, c.o_tenant AS tenant_key, c.o_profile AS chunking_profile_id, c.o_language AS language, (-1)::smallint AS sign, c.o_tsv AS tsv
          FROM changed c WHERE c.o_member AND c.o_cluster IS NULL
        UNION ALL
        SELECT c.id, c.n_tenant, c.n_profile, c.n_language, 1::smallint, c.n_tsv
          FROM changed c WHERE c.n_member AND c.n_cluster IS NULL
      ) x
      JOIN public.rag_lexical_stats_state s ON s.tenant_key = x.tenant_key AND s.cluster_status IS NOT NULL
     ORDER BY x.id, x.sign
    RETURNING 1
  )
  INSERT INTO public.rag_lexical_cluster_dirty (tenant_key, dup_cluster_id)
  SELECT g.tenant_key, g.dup_cluster_id
    FROM (
      SELECT c.o_tenant AS tenant_key, c.o_cluster AS dup_cluster_id
        FROM changed c WHERE c.o_member AND c.o_cluster IS NOT NULL
      UNION
      SELECT c.n_tenant, c.n_cluster
        FROM changed c WHERE c.n_member AND c.n_cluster IS NOT NULL
    ) g
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = g.tenant_key AND s.cluster_status IS NOT NULL
   ORDER BY g.tenant_key, g.dup_cluster_id;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_chunks_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl)
  SELECT o.tenant_key, o.chunking_profile_id, COALESCE(o.language, 'und'), (-1)::smallint,
         pg_catalog.tsvector_to_array(o.lexical_tsv), public.rag_lexical_dl(o.lexical_tsv)
    FROM old_rows o
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = o.tenant_key
   WHERE o.is_current AND o.status IN ('ready', 'variant')
     AND o.lexical_tsv IS NOT NULL AND o.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY o.id;

  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.cluster_status IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, corpus, chunking_profile_id, language, sign, lexemes, dl)
  SELECT o.tenant_key, 'chunks_cluster', o.chunking_profile_id, COALESCE(o.language, 'und'), (-1)::smallint,
         pg_catalog.tsvector_to_array(o.lexical_tsv), public.rag_lexical_dl(o.lexical_tsv)
    FROM old_rows o
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = o.tenant_key AND s.cluster_status IS NOT NULL
   WHERE o.dup_cluster_id IS NULL
     AND o.is_current AND o.status IN ('ready', 'variant')
     AND o.lexical_tsv IS NOT NULL AND o.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY o.id;
  INSERT INTO public.rag_lexical_cluster_dirty (tenant_key, dup_cluster_id)
  SELECT g.tenant_key, g.dup_cluster_id
    FROM (
      SELECT DISTINCT o.tenant_key, o.dup_cluster_id
        FROM old_rows o
        JOIN public.rag_lexical_stats_state s ON s.tenant_key = o.tenant_key AND s.cluster_status IS NOT NULL
       WHERE o.dup_cluster_id IS NOT NULL
         AND o.is_current AND o.status IN ('ready', 'variant')
         AND o.lexical_tsv IS NOT NULL AND o.lexical_tsv <> ''::pg_catalog.tsvector
    ) g
   ORDER BY g.tenant_key, g.dup_cluster_id;
  RETURN NULL;
END
$fn$;

-- Compaction and reconciliation (D-48) ---------------------------------------------------------------------------------------------

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
BEGIN
  FOR v_key IN
    SELECT s.tenant_key
      FROM public.rag_lexical_stats_state s
     WHERE EXISTS (SELECT 1 FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = s.tenant_key)
        OR (s.cluster_status IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = s.tenant_key))
     ORDER BY s.tenant_key
  LOOP
    v_total := v_total + public.rag_lexstats_compact_tenant(v_key, p_max_rows);
  END LOOP;
  RETURN v_total;
END
$fn$;

-- Enable, rebuild, disable ----------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_lexstats_cluster_enable(p_tenant_key text)
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
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'lexical_stats_not_enabled' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));
  UPDATE public.rag_lexical_stats_state s
     SET cluster_status = 'building'
   WHERE s.tenant_key = p_tenant_key AND s.cluster_status IS NULL;
  SELECT s.cluster_status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  RETURN v_status;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_cluster_disable(p_tenant_key text)
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
  UPDATE public.rag_lexical_stats_state s
     SET cluster_status = NULL, cluster_rebuilt_at = NULL
   WHERE s.tenant_key = p_tenant_key AND s.cluster_status IS NOT NULL;
  v_existed := FOUND;
  DELETE FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks_cluster';
  DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks_cluster';
  DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks_cluster';
  DELETE FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_cluster_units u WHERE u.tenant_key = p_tenant_key;
  RETURN v_existed;
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
  v_cluster boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'lexical_stats_not_enabled' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));
  SELECT s.cluster_status IS NOT NULL INTO v_cluster FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;

  CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_staging (
    kind smallint NOT NULL,
    lexeme text,
    chunking_profile_id text NOT NULL,
    language text NOT NULL,
    n bigint NOT NULL,
    len bigint
  ) ON COMMIT DROP;
  TRUNCATE pg_temp._rag_lexstats_staging;

  IF NOT v_cluster THEN
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
  ELSE
    CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_units_staging (
      dup_cluster_id uuid NOT NULL,
      chunking_profile_id text NOT NULL,
      language text NOT NULL,
      chunk_id uuid NOT NULL,
      lexemes text[] NOT NULL,
      dl integer NOT NULL
    ) ON COMMIT DROP;
    TRUNCATE pg_temp._rag_lexstats_units_staging;
    -- One statement, one snapshot for both corpora: pending rows of both corpora and the markers it deletes are exactly those whose
    -- changes the scan sees; a change committed later keeps its pending row or marker and is folded by the next compaction.
    WITH gone AS (
      DELETE FROM public.rag_lexical_stats_pending p
       WHERE p.tenant_key = p_tenant_key AND p.corpus IN ('chunks', 'chunks_cluster')
      RETURNING p.id
    ), gone_marks AS (
      DELETE FROM public.rag_lexical_cluster_dirty d
       WHERE d.tenant_key = p_tenant_key
      RETURNING d.id
    ), member AS MATERIALIZED (
      SELECT c.id, c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv
        FROM public.document_chunks c
       WHERE c.tenant_key = p_tenant_key
         AND c.is_current AND c.status IN ('ready', 'variant')
         AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
    ), units AS MATERIALIZED (
      SELECT m.chunking_profile_id, m.language, m.lexical_tsv
        FROM member m WHERE m.dup_cluster_id IS NULL
      UNION ALL
      SELECT q.chunking_profile_id, q.language, q.lexical_tsv
        FROM (
          SELECT DISTINCT ON (m.dup_cluster_id, m.chunking_profile_id, m.language) m.chunking_profile_id, m.language, m.lexical_tsv
            FROM member m WHERE m.dup_cluster_id IS NOT NULL
           ORDER BY m.dup_cluster_id, m.chunking_profile_id, m.language, m.id
        ) q
    ), ledger AS (
      INSERT INTO pg_temp._rag_lexstats_units_staging (dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
      SELECT DISTINCT ON (m.dup_cluster_id, m.chunking_profile_id, m.language)
             m.dup_cluster_id, m.chunking_profile_id, m.language, m.id,
             pg_catalog.tsvector_to_array(m.lexical_tsv), public.rag_lexical_dl(m.lexical_tsv)
        FROM member m WHERE m.dup_cluster_id IS NOT NULL
       ORDER BY m.dup_cluster_id, m.chunking_profile_id, m.language, m.id
      RETURNING 1
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
     GROUP BY m.chunking_profile_id, m.language
    UNION ALL
    SELECT 3::smallint, u.lexeme, x.chunking_profile_id, x.language, pg_catalog.count(*), NULL::bigint
      FROM units x
     CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.tsvector_to_array(x.lexical_tsv)) AS u(lexeme)
     GROUP BY u.lexeme, x.chunking_profile_id, x.language
    UNION ALL
    SELECT 4::smallint, NULL::text, x.chunking_profile_id, x.language, pg_catalog.count(*),
           pg_catalog.sum(public.rag_lexical_dl(x.lexical_tsv))::bigint
      FROM units x
     GROUP BY x.chunking_profile_id, x.language;
  END IF;

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

  IF v_cluster THEN
    DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks_cluster';
    INSERT INTO public.rag_lexical_df (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
    SELECT p_tenant_key, 'chunks_cluster', g.lexeme, g.chunking_profile_id, g.language, g.n
      FROM pg_temp._rag_lexstats_staging g
     WHERE g.kind = 3
     ORDER BY g.lexeme, g.chunking_profile_id, g.language;

    DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks_cluster';
    INSERT INTO public.rag_lexical_corpus (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
    SELECT p_tenant_key, 'chunks_cluster', g.chunking_profile_id, g.language, g.n, g.len
      FROM pg_temp._rag_lexstats_staging g
     WHERE g.kind = 4
     ORDER BY g.chunking_profile_id, g.language;

    DELETE FROM public.rag_lexical_cluster_units u WHERE u.tenant_key = p_tenant_key;
    INSERT INTO public.rag_lexical_cluster_units (tenant_key, dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
    SELECT p_tenant_key, x.dup_cluster_id, x.chunking_profile_id, x.language, x.chunk_id, x.lexemes, x.dl
      FROM pg_temp._rag_lexstats_units_staging x
     ORDER BY x.dup_cluster_id, x.chunking_profile_id, x.language;
    TRUNCATE pg_temp._rag_lexstats_units_staging;
  END IF;
  TRUNCATE pg_temp._rag_lexstats_staging;

  IF v_cluster THEN
    UPDATE public.rag_lexical_stats_state s
       SET status = 'ready', rebuilt_at = pg_catalog.now(), cluster_status = 'ready', cluster_rebuilt_at = pg_catalog.now()
     WHERE s.tenant_key = p_tenant_key;
  ELSE
    UPDATE public.rag_lexical_stats_state s
       SET status = 'ready', rebuilt_at = pg_catalog.now()
     WHERE s.tenant_key = p_tenant_key;
  END IF;

  RETURN pg_catalog.jsonb_build_object('chunk_count', v_chunks, 'lexeme_rows', v_lexeme_rows, 'corpus_rows', v_corpus_rows);
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
  DELETE FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_cluster_units u WHERE u.tenant_key = p_tenant_key;
  RETURN v_existed;
END
$fn$;

-- Status and check ------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_lexstats_status(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_out jsonb;
  v_cluster_status text;
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
           'compacted_at', s.compacted_at),
         s.cluster_status
    INTO v_out, v_cluster_status
    FROM (SELECT 1) AS one
    LEFT JOIN public.rag_lexical_stats_state s ON s.tenant_key = p_tenant_key;
  IF v_cluster_status IS NOT NULL THEN
    v_out := v_out || pg_catalog.jsonb_build_object(
      'cluster_status', v_cluster_status,
      'cluster_rebuilt_at', (SELECT s.cluster_rebuilt_at FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key),
      'cluster_dirty', (SELECT pg_catalog.count(*) FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key),
      'cluster_oldest_dirty_at', (SELECT pg_catalog.min(d.created_at) FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key),
      'cluster_oldest_dirty_age_s', (SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.now() - pg_catalog.min(d.created_at)))::bigint
                                       FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key));
  END IF;
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
  v_cluster_status text;
  v_pending bigint;
  v_df_mismatch bigint;
  v_df_mismatch_p bigint;
  v_count_diff bigint;
  v_count_diff_p bigint;
  v_len_diff bigint;
  v_len_diff_p bigint;
  v_cl_df bigint;
  v_cl_count bigint;
  v_cl_len bigint;
  v_cl_ledger bigint;
  v_cl_dirty bigint;
  v_out jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT s.status, s.cluster_status INTO v_state, v_cluster_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
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

  v_out := pg_catalog.jsonb_build_object(
    'state', v_state,
    'pending', v_pending,
    'df_mismatch', v_df_mismatch,
    'df_mismatch_with_pending', v_df_mismatch_p,
    'chunk_count_diff', v_count_diff,
    'chunk_count_diff_with_pending', v_count_diff_p,
    'total_len_diff', v_len_diff,
    'total_len_diff_with_pending', v_len_diff_p,
    'clean', v_df_mismatch_p = 0 AND v_count_diff_p = 0 AND v_len_diff_p = 0);

  IF v_cluster_status IS NULL THEN
    RETURN v_out;
  END IF;

  -- Invariant 1: chunks_cluster counters plus unfolded chunks_cluster pending deltas equal the recompute over member chunks without a
  -- cluster plus the sum of the ledger rows.
  WITH loose AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language,
           pg_catalog.tsvector_to_array(c.lexical_tsv) AS lexemes, public.rag_lexical_dl(c.lexical_tsv) AS dl
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key AND c.dup_cluster_id IS NULL
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
    UNION ALL
    SELECT u.chunking_profile_id, u.language, u.lexemes, u.dl
      FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key
  ), re_df AS (
    SELECT x.lexeme, m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS v
      FROM loose m CROSS JOIN LATERAL pg_catalog.unnest(m.lexemes) AS x(lexeme)
     GROUP BY x.lexeme, m.chunking_profile_id, m.language
  ), ct_df AS (
    SELECT f.lexeme, f.chunking_profile_id, f.language, f.df AS v
      FROM public.rag_lexical_df f
     WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks_cluster'
  ), pd_df AS (
    SELECT x.lexeme, p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS v
      FROM public.rag_lexical_stats_pending p CROSS JOIN LATERAL pg_catalog.unnest(p.lexemes) AS x(lexeme)
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks_cluster'
     GROUP BY x.lexeme, p.chunking_profile_id, p.language
  )
  SELECT pg_catalog.count(*) FILTER (WHERE COALESCE(r.v, 0) <> COALESCE(c.v, 0) + COALESCE(d.v, 0))
    INTO v_cl_df
    FROM re_df r
    FULL JOIN ct_df c USING (lexeme, chunking_profile_id, language)
    FULL JOIN pd_df d USING (lexeme, chunking_profile_id, language);

  WITH loose AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, public.rag_lexical_dl(c.lexical_tsv) AS dl
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key AND c.dup_cluster_id IS NULL
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
    UNION ALL
    SELECT u.chunking_profile_id, u.language, u.dl
      FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key
  ), re_c AS (
    SELECT m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS n, pg_catalog.sum(m.dl)::bigint AS len
      FROM loose m GROUP BY m.chunking_profile_id, m.language
  ), ct_c AS (
    SELECT c.chunking_profile_id, c.language, c.chunk_count AS n, c.total_len AS len
      FROM public.rag_lexical_corpus c
     WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks_cluster'
  ), pd_c AS (
    SELECT p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS n, pg_catalog.sum(p.sign::bigint * p.dl)::bigint AS len
      FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks_cluster'
     GROUP BY p.chunking_profile_id, p.language
  )
  SELECT COALESCE(pg_catalog.sum(pg_catalog.abs(COALESCE(r.n, 0) - COALESCE(c.n, 0) - COALESCE(d.n, 0))), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(COALESCE(r.len, 0) - COALESCE(c.len, 0) - COALESCE(d.len, 0))), 0)::bigint
    INTO v_cl_count, v_cl_len
    FROM re_c r
    FULL JOIN ct_c c USING (chunking_profile_id, language)
    FULL JOIN pd_c d USING (chunking_profile_id, language);

  -- Invariant 2: for every cluster without a marker row, the ledger equals the recomputed units.
  WITH dirty AS MATERIALIZED (
    SELECT DISTINCT d.dup_cluster_id FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key
  ), re_u AS (
    SELECT DISTINCT ON (c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'))
           c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.id AS chunk_id,
           pg_catalog.tsvector_to_array(c.lexical_tsv) AS lexemes, public.rag_lexical_dl(c.lexical_tsv) AS dl
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key AND c.dup_cluster_id IS NOT NULL
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
     ORDER BY c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'), c.id
  ), ld_u AS (
    SELECT u.dup_cluster_id, u.chunking_profile_id, u.language, u.chunk_id, u.lexemes, u.dl
      FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key
  )
  SELECT pg_catalog.count(*)
    INTO v_cl_ledger
    FROM re_u r
    FULL JOIN ld_u l USING (dup_cluster_id, chunking_profile_id, language)
   WHERE NOT EXISTS (SELECT 1 FROM dirty k WHERE k.dup_cluster_id = COALESCE(r.dup_cluster_id, l.dup_cluster_id))
     AND (r.chunk_id IS DISTINCT FROM l.chunk_id
          OR r.dl IS DISTINCT FROM l.dl
          OR ARRAY(SELECT pg_catalog.unnest(r.lexemes) ORDER BY 1) IS DISTINCT FROM ARRAY(SELECT pg_catalog.unnest(l.lexemes) ORDER BY 1));

  SELECT pg_catalog.count(*) INTO v_cl_dirty FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = p_tenant_key;

  RETURN v_out || pg_catalog.jsonb_build_object(
    'cluster_status', v_cluster_status,
    'cluster_dirty', v_cl_dirty,
    'cluster_df_diff', v_cl_df,
    'cluster_chunk_count_diff', v_cl_count,
    'cluster_total_len_diff', v_cl_len,
    'cluster_ledger_diff', v_cl_ledger,
    'clean', v_df_mismatch_p = 0 AND v_count_diff_p = 0 AND v_len_diff_p = 0
             AND v_cl_df = 0 AND v_cl_count = 0 AND v_cl_len = 0 AND v_cl_ledger = 0);
END
$fn$;

-- Purge hook (0903 body plus the orphaned-ledger marking) ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_purge_hook_lexical_stats(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_folded bigint;
  v_total bigint := 0;
  v_round integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      AND (d.tenant_key IS DISTINCT FROM p_tenant_key OR (p_lineage_id IS NOT NULL AND d.lineage_id IS DISTINCT FROM p_lineage_id))
  ) THEN
    RAISE EXCEPTION 'rag_purge_hook_lexical_stats: a document id is outside the tenant or lineage' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RETURN 0;
  END IF;
  INSERT INTO public.rag_lexical_cluster_dirty (tenant_key, dup_cluster_id)
  SELECT p_tenant_key, g.dup_cluster_id
    FROM (
      SELECT DISTINCT u.dup_cluster_id
        FROM public.rag_lexical_cluster_units u
       WHERE u.tenant_key = p_tenant_key
         AND NOT EXISTS (SELECT 1 FROM public.document_chunks c WHERE c.id = u.chunk_id)
    ) g
   ORDER BY g.dup_cluster_id;
  LOOP
    v_round := v_round + 1;
    v_folded := public.rag_lexstats_compact(p_tenant_key, 5000);
    v_total := v_total + v_folded;
    EXIT WHEN v_folded = 0 OR v_round >= 200;
  END LOOP;
  RETURN v_total;
END
$fn$;

-- Grants ----------------------------------------------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_all(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_cluster_enable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_cluster_disable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_rebuild(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_disable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_status(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_check(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_hook_lexical_stats(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_all(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_cluster_enable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_cluster_disable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_rebuild(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_disable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_status(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_check(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_lexical_stats(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
