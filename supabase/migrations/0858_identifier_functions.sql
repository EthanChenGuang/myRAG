-- 0858: Phase 4.2 identifier pattern functions and identifier lookups (RET-15, RET-16, D-28, D-29, D-31, D-51, D-56).
-- Pattern CRUD over rag_identifier_patterns (0854) and two read functions over the identifier columns of current, ready chunks:
--   rag_identifier_patterns_list, rag_identifier_pattern_create, rag_identifier_pattern_update, rag_identifier_pattern_delete,
--   rag_identifier_resolve (which normalized identifiers exist in the tenant) and rag_identifier_candidates (suggestion candidates).
-- Every function is SECURITY INVOKER with an empty search_path, asserts the tenant key first and names the tenant in every predicate;
-- service_role only. Refusals put a fixed code word first in the message (limit_reached, name_exists, pattern_not_found) and use
-- ERRCODE 22023 for malformed arguments. The limit of 20 patterns per tenant is counted under a per-tenant advisory lock.
-- Regular-expression safety (static checks and the worker probe) lives in the app; SQL enforces lengths, flags, the limit and names.
-- Idempotent; not folded into the setup files.

BEGIN;

DO $identifier_functions_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_identifier_patterns') IS NULL THEN
    RAISE EXCEPTION '0858: apply 0854 first' USING ERRCODE = '55000';
  END IF;
END
$identifier_functions_precheck$;

CREATE OR REPLACE FUNCTION public.rag_identifier_patterns_list(p_tenant_key text)
RETURNS TABLE (id uuid, name text, pattern text, flags text, enabled boolean, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT p.id, p.name, p.pattern, p.flags, p.enabled, p.created_at, p.updated_at
  FROM public.rag_identifier_patterns p
  WHERE p.tenant_key = p_tenant_key
  ORDER BY p.created_at, p.id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_identifier_pattern_create(
  p_tenant_key text,
  p_name text,
  p_pattern text,
  p_flags text,
  p_enabled boolean,
  p_created_by uuid
)
RETURNS TABLE (id uuid, name text, pattern text, flags text, enabled boolean, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_name text := pg_catalog.btrim(p_name);
  v_count integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF v_name IS NULL OR pg_catalog.length(v_name) < 1 OR pg_catalog.length(v_name) > 80 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
  END IF;
  IF p_pattern IS NULL OR pg_catalog.length(p_pattern) < 1 OR pg_catalog.length(p_pattern) > 200 THEN
    RAISE EXCEPTION 'invalid_pattern' USING ERRCODE = '22023';
  END IF;
  IF p_flags IS NULL OR p_flags NOT IN ('u', 'iu') THEN
    RAISE EXCEPTION 'invalid_flags' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_identifier_patterns|' || p_tenant_key, 0));

  SELECT pg_catalog.count(*)::integer INTO v_count FROM public.rag_identifier_patterns p WHERE p.tenant_key = p_tenant_key;
  IF v_count >= 20 THEN
    RAISE EXCEPTION 'limit_reached' USING ERRCODE = '54000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rag_identifier_patterns p WHERE p.tenant_key = p_tenant_key AND p.name = v_name) THEN
    RAISE EXCEPTION 'name_exists' USING ERRCODE = '23505';
  END IF;

  RETURN QUERY
  INSERT INTO public.rag_identifier_patterns AS p (tenant_key, name, pattern, flags, enabled, created_by, created_at, updated_at)
  VALUES (p_tenant_key, v_name, p_pattern, p_flags, COALESCE(p_enabled, true), p_created_by, v_now, v_now)
  RETURNING p.id, p.name, p.pattern, p.flags, p.enabled, p.created_at, p.updated_at;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_identifier_pattern_update(
  p_tenant_key text,
  p_id uuid,
  p_name text,
  p_pattern text,
  p_flags text,
  p_enabled boolean
)
RETURNS TABLE (id uuid, name text, pattern text, flags text, enabled boolean, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_name text := pg_catalog.btrim(p_name);
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_id' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NOT NULL AND (pg_catalog.length(v_name) < 1 OR pg_catalog.length(v_name) > 80) THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
  END IF;
  IF p_pattern IS NOT NULL AND (pg_catalog.length(p_pattern) < 1 OR pg_catalog.length(p_pattern) > 200) THEN
    RAISE EXCEPTION 'invalid_pattern' USING ERRCODE = '22023';
  END IF;
  IF p_flags IS NOT NULL AND p_flags NOT IN ('u', 'iu') THEN
    RAISE EXCEPTION 'invalid_flags' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_identifier_patterns|' || p_tenant_key, 0));

  IF NOT EXISTS (SELECT 1 FROM public.rag_identifier_patterns p WHERE p.tenant_key = p_tenant_key AND p.id = p_id) THEN
    RAISE EXCEPTION 'pattern_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_name IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.rag_identifier_patterns p WHERE p.tenant_key = p_tenant_key AND p.name = v_name AND p.id <> p_id
  ) THEN
    RAISE EXCEPTION 'name_exists' USING ERRCODE = '23505';
  END IF;

  RETURN QUERY
  UPDATE public.rag_identifier_patterns AS p
     SET name = COALESCE(v_name, p.name),
         pattern = COALESCE(p_pattern, p.pattern),
         flags = COALESCE(p_flags, p.flags),
         enabled = COALESCE(p_enabled, p.enabled),
         updated_at = GREATEST(pg_catalog.clock_timestamp(), p.updated_at + interval '1 microsecond')
   WHERE p.tenant_key = p_tenant_key AND p.id = p_id
  RETURNING p.id, p.name, p.pattern, p.flags, p.enabled, p.created_at, p.updated_at;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_identifier_pattern_delete(p_tenant_key text, p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_id' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.rag_identifier_patterns p
   WHERE p.tenant_key = p_tenant_key AND p.id = p_id
  RETURNING p.id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'pattern_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_id;
END
$fn$;

-- Which of up to 16 normalized identifiers occur on a current, ready chunk of a current, ready document of the tenant,
-- each with one stored original spelling (identifiers_raw is kept in the same order as identifiers_norm).
CREATE OR REPLACE FUNCTION public.rag_identifier_resolve(p_tenant_key text, p_norm text[])
RETURNS TABLE (norm text, raw text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_norms text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF COALESCE(pg_catalog.cardinality(p_norm), 0) > 16 THEN
    RAISE EXCEPTION 'too_many_identifiers' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT n.v), '{}'::text[]) INTO v_norms
  FROM pg_catalog.unnest(COALESCE(p_norm, '{}'::text[])) AS n(v)
  WHERE n.v IS NOT NULL AND pg_catalog.length(n.v) BETWEEN 1 AND 200;
  IF pg_catalog.cardinality(v_norms) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (x.norm) x.norm, COALESCE(x.raw, x.norm)
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
  CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(c.identifiers_norm), pg_catalog.unnest(c.identifiers_raw)) WITH ORDINALITY AS x(norm, raw, ord)
  WHERE c.tenant_key = p_tenant_key
    AND c.is_current
    AND c.status = 'ready'
    AND c.identifiers_norm OPERATOR(pg_catalog.&&) v_norms
    AND x.norm = ANY (v_norms)
  ORDER BY x.norm, c.created_at, c.id, x.ord;
END
$fn$;

-- Suggestion candidates for a normalized identifier (D-31, D-51): distinct identifiers of the tenant's current, ready chunks whose
-- normalized length is within 2 of the input and that share a prefix or a suffix of at least 2 characters; never the input itself.
-- The caller ranks them by distance. The limit defaults to 10 and is capped at 50.
CREATE OR REPLACE FUNCTION public.rag_identifier_candidates(p_tenant_key text, p_norm text, p_limit integer)
RETURNS TABLE (raw text, norm text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_cap integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_len integer := pg_catalog.length(p_norm);
  v_prefix text;
  v_suffix text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF v_len > 200 THEN
    RAISE EXCEPTION 'invalid_identifier' USING ERRCODE = '22023';
  END IF;
  IF p_norm IS NULL OR v_len < 2 THEN
    RETURN;
  END IF;
  v_prefix := pg_catalog.left(p_norm, 2);
  v_suffix := pg_catalog.right(p_norm, 2);

  RETURN QUERY
  SELECT g.raw, g.norm
  FROM (
    SELECT DISTINCT ON (x.norm) x.norm AS norm, COALESCE(x.raw, x.norm) AS raw
    FROM public.document_chunks c
    JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
    CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(c.identifiers_norm), pg_catalog.unnest(c.identifiers_raw)) WITH ORDINALITY AS x(norm, raw, ord)
    WHERE c.tenant_key = p_tenant_key
      AND c.is_current
      AND c.status = 'ready'
      AND c.identifiers_norm IS NOT NULL
      AND x.norm IS NOT NULL
      AND x.norm <> p_norm
      AND pg_catalog.abs(pg_catalog.length(x.norm) - v_len) <= 2
      AND (pg_catalog.left(x.norm, 2) = v_prefix OR pg_catalog.right(x.norm, 2) = v_suffix)
    ORDER BY x.norm, c.created_at, c.id, x.ord
  ) g
  ORDER BY pg_catalog.abs(pg_catalog.length(g.norm) - v_len), g.norm
  LIMIT v_cap;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_identifier_patterns_list(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_identifier_patterns_list(text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_identifier_pattern_create(text, text, text, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_identifier_pattern_create(text, text, text, text, boolean, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_identifier_pattern_update(text, uuid, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_identifier_pattern_update(text, uuid, text, text, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.rag_identifier_pattern_delete(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_identifier_pattern_delete(text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_identifier_resolve(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_identifier_resolve(text, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_identifier_candidates(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_identifier_candidates(text, text, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
