-- 0901: Phase 4.4 change capture for the lexical statistics (LEX-03, D-11, D-15, D-16, D-32).
-- One AFTER ... FOR EACH STATEMENT trigger per event on document_chunks, each reading its transition table (the 0702 pattern), so a
-- cascade or a bulk write stages once per statement. Each function stages one signed row per changed member chunk into
-- rag_lexical_stats_pending (tenant key, chunking profile, language or 'und', +1 or -1, the distinct lexemes, the length) and writes
-- nothing else: no counter is touched on the write path. Compaction (0902) folds the rows.
-- Membership (D-11): is_current AND status IN ('ready', 'variant') AND lexical_tsv IS NOT NULL AND lexical_tsv <> ''.
-- Inert by default (D-16): every function returns before reading a transition table while rag_lexical_stats_state is empty, and stages
-- rows only for tenants that have a state row. An update stages -1 for the old row and +1 for the new one only when membership,
-- lexical_tsv, tenant_key, chunking_profile_id or language changed. The AFTER triggers see the lexical_tsv the 0401 BEFORE trigger set.
-- SECURITY DEFINER with an empty search_path because the writing role (an owner editing a chunk, an ingest RPC) has no grant on the
-- pending table; the functions take no caller input. EXECUTE is revoked from PUBLIC, anon and authenticated (service_role keeps it, as
-- 0410 does for the 0702 trigger functions). Idempotent; not folded into the setup files.

BEGIN;

DO $lexical_stats_triggers_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.document_chunks') AND a.attname = 'lexical_tsv' AND NOT a.attisdropped
     )
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_pending') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_dl(tsvector)') IS NULL THEN
    RAISE EXCEPTION '0901: apply migrations 0401, 0403 and 0900 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_stats_triggers_precheck$;

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
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_delete() TO service_role;

DROP TRIGGER IF EXISTS rag_lexstats_chunks_insert ON public.document_chunks;
CREATE TRIGGER rag_lexstats_chunks_insert
  AFTER INSERT ON public.document_chunks
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_lexstats_chunks_insert();

DROP TRIGGER IF EXISTS rag_lexstats_chunks_update ON public.document_chunks;
CREATE TRIGGER rag_lexstats_chunks_update
  AFTER UPDATE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_lexstats_chunks_update();

DROP TRIGGER IF EXISTS rag_lexstats_chunks_delete ON public.document_chunks;
CREATE TRIGGER rag_lexstats_chunks_delete
  AFTER DELETE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_lexstats_chunks_delete();

COMMIT;
