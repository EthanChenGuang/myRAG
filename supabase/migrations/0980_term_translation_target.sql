-- 0980: Phase 6.2 translation glossary on the TERM dictionary (D-02, D-13, D-15, D-36).
-- Glossary pairs are rag_term_entries rows of kind translation: variants in language (the source language) map to the required translation
-- canonical in target_language. 0471 already stores target_language with a validated translation CHECK (required for translation, NULL for
-- every other kind, different from the source language, which equals language), and rag_term_effective, the 0472 writers and the entries
-- hash already carry it, so this file adds no column and no constraint: it stops with 55000 when that 0471 shape is missing.
-- Whether target_language is an enabled language is checked by the app validator on every write path, never here (D-36).
-- It re-creates rag_term_list_entries (body from 0472) with three optional Glossary filters: p_kind, p_source_language (matched against
-- language) and p_target_language. NULL means no filter, so a five-argument call lists the whole layer as before. Same hardening as 0472:
-- SECURITY DEFINER, empty search_path, schema-qualified names, rag_term__authorize first, executable by service_role only.
-- Not folded into the setup files. Re-running 0472 or a setup file brings the five-argument signature back next to this one; re-run 0980
-- afterwards (it drops that signature). Idempotent.

BEGIN;

DO $guard$
BEGIN
  IF pg_catalog.to_regclass('public.rag_term_entries') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = 'public.rag_term_entries'::pg_catalog.regclass AND attname = 'target_language' AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.rag_term_entries'::pg_catalog.regclass AND conname = 'rag_term_entries_translation_check'
     )
     OR pg_catalog.to_regprocedure('public.rag_term__authorize(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '0980 needs the 0471 and 0472 terminology schema; apply them first' USING ERRCODE = '55000';
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.rag_term_list_entries(uuid, text, integer, integer, text);

CREATE OR REPLACE FUNCTION public.rag_term_list_entries(
  p_actor uuid,
  p_layer_key text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL,
  p_kind text DEFAULT NULL,
  p_source_language text DEFAULT NULL,
  p_target_language text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  layer_key text,
  canonical text,
  variants text[],
  normalized_variants text[],
  language text,
  kind text,
  mode text,
  source_language text,
  target_language text,
  enabled boolean,
  note text,
  suppresses_entry_id uuid,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  layer_version bigint,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_page integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_skip integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := pg_catalog.lower(NULLIF(pg_catalog.btrim(p_search), ''));
  v_kind text := NULLIF(pg_catalog.btrim(p_kind), '');
  v_source text := NULLIF(pg_catalog.btrim(p_source_language), '');
  v_target text := NULLIF(pg_catalog.btrim(p_target_language), '');
  v_version bigint;
BEGIN
  PERFORM public.rag_term__authorize(p_actor, p_layer_key);
  SELECT l.version INTO v_version FROM public.rag_term_layers l WHERE l.layer_key = p_layer_key;
  RETURN QUERY
  SELECT e.id, e.layer_key, e.canonical, e.variants, e.normalized_variants, e.language, e.kind, e.mode, e.source_language,
         e.target_language, e.enabled, e.note, e.suppresses_entry_id, e.created_by, e.updated_by, e.created_at, e.updated_at,
         COALESCE(v_version, 0::bigint), pg_catalog.count(*) OVER ()
    FROM public.rag_term_entries e
   WHERE e.layer_key = p_layer_key
     AND (v_kind IS NULL OR e.kind = v_kind)
     AND (v_source IS NULL OR e.language = v_source)
     AND (v_target IS NULL OR e.target_language = v_target)
     AND (
       v_search IS NULL
       OR pg_catalog.strpos(pg_catalog.lower(e.canonical), v_search) > 0
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(e.variants) AS u(v) WHERE pg_catalog.strpos(pg_catalog.lower(u.v), v_search) > 0)
     )
   ORDER BY pg_catalog.lower(e.canonical), e.language, COALESCE(e.target_language, ''), e.id
   LIMIT v_page OFFSET v_skip;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
