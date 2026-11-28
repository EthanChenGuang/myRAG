-- 1002: Phase 3.3 tenant rule functions over rag_section_rule_sets and rag_boilerplate_rules of 1001 (TPL-01, TPL-02, TPL-08; D-02, D-11,
-- D-12, D-16, D-18, D-34).
--   rag_section_rule_sets_list, rag_section_rule_set_upsert, rag_section_rule_set_delete,
--   rag_boilerplate_rules_list, rag_boilerplate_rule_upsert, rag_boilerplate_rule_delete: the admin surface. Each takes p_actor and admits
--   only an admin of the named tenant (rag_upload_approval_keys); the lists answer no rows to anyone else, the writers raise not_admin.
--   rag_tenant_rules_for: the pipeline's read for one binding (no actor): the one enabled rule set chosen by the D-18 precedence (document
--   type and source, then type, then source, then the tenant-wide row) and every enabled boilerplate rule whose binding matches, in the same
--   precedence order and then creation order.
-- Security: SECURITY INVOKER, empty search_path, schema-qualified names, the tenant assertion first and the tenant in every predicate; every
-- function is revoked from PUBLIC, anon and authenticated and granted to service_role on its exact signature.
-- Limits (D-12) are counted under one per-tenant advisory lock per table: 10 rule sets and 40 boilerplate rules per tenant, 60 heading
-- patterns per rule set, names of 80 characters, patterns of 200 characters, at most one enabled rule set per binding. Refusals put a fixed
-- code word first in the message (limit_reached with the limit's name in DETAIL, name_exists, not_found, not_admin); malformed arguments raise
-- ERRCODE 22023.
-- Tenant patterns are data here: SQL checks their length and stores and returns their text; no statement matches anything against a pattern.
-- Pattern safety (static checks and the time-boxed probe) lives in the app and runs before every write.
-- Tenant settings with no document reference: no purge hook. Idempotent; not folded into the setup files.

BEGIN;

DO $tenant_rule_functions_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_section_rule_sets') IS NULL
     OR pg_catalog.to_regclass('public.rag_boilerplate_rules') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_upload_approval_keys(uuid)') IS NULL THEN
    RAISE EXCEPTION '1002: apply 1001 first' USING ERRCODE = '55000';
  END IF;
END
$tenant_rule_functions_precheck$;

-- Section rule sets ------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_section_rule_sets_list(p_actor uuid, p_tenant_key text)
RETURNS TABLE (
  id uuid, name text, doc_type text, source text, enabled boolean, rules jsonb, version integer, created_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT s.id, s.name, s.doc_type, s.source, s.enabled, s.rules, s.version, s.created_at, s.updated_at
  FROM public.rag_section_rule_sets s
  WHERE s.tenant_key = p_tenant_key
  ORDER BY s.created_at, s.id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_section_rule_set_upsert(p_actor uuid, p_tenant_key text, p_rule_set jsonb, p_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, doc_type text, source text, enabled boolean, rules jsonb, version integer, created_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_binding constant text := '^[a-z][a-z0-9_-]{0,63}$';
  v_name text;
  v_doc_type text;
  v_source text;
  v_enabled boolean := true;
  v_increasing boolean := false;
  v_skip_toc boolean := true;
  v_toc_min_run integer := 3;
  v_heading jsonb;
  v_headings jsonb := '[]'::jsonb;
  v_patterns text[] := '{}'::text[];
  v_pattern text;
  v_flags text;
  v_heading_name text;
  v_level numeric;
  v_count integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
  END IF;

  IF p_rule_set IS NULL OR pg_catalog.jsonb_typeof(p_rule_set) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'rule_set';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_rule_set) AS k(key)
    WHERE k.key NOT IN ('name', 'doc_type', 'source', 'enabled', 'headings', 'require_increasing_numbers', 'skip_toc', 'toc_min_run')
  ) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'rule_set';
  END IF;

  IF pg_catalog.jsonb_typeof(p_rule_set -> 'name') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'name';
  END IF;
  v_name := p_rule_set ->> 'name';
  IF pg_catalog.length(pg_catalog.btrim(v_name)) < 1 OR pg_catalog.length(v_name) > 80 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'name';
  END IF;

  IF COALESCE(pg_catalog.jsonb_typeof(p_rule_set -> 'doc_type'), 'null') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'doc_type';
  END IF;
  v_doc_type := p_rule_set ->> 'doc_type';
  IF v_doc_type IS NOT NULL AND v_doc_type !~ v_binding THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'doc_type';
  END IF;
  IF COALESCE(pg_catalog.jsonb_typeof(p_rule_set -> 'source'), 'null') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'source';
  END IF;
  v_source := p_rule_set ->> 'source';
  IF v_source IS NOT NULL AND v_source !~ v_binding THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'source';
  END IF;

  IF p_rule_set ? 'enabled' THEN
    IF pg_catalog.jsonb_typeof(p_rule_set -> 'enabled') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'enabled';
    END IF;
    v_enabled := (p_rule_set ->> 'enabled')::boolean;
  END IF;
  IF p_rule_set ? 'require_increasing_numbers' THEN
    IF pg_catalog.jsonb_typeof(p_rule_set -> 'require_increasing_numbers') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'require_increasing_numbers';
    END IF;
    v_increasing := (p_rule_set ->> 'require_increasing_numbers')::boolean;
  END IF;
  IF p_rule_set ? 'skip_toc' THEN
    IF pg_catalog.jsonb_typeof(p_rule_set -> 'skip_toc') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'skip_toc';
    END IF;
    v_skip_toc := (p_rule_set ->> 'skip_toc')::boolean;
  END IF;
  IF p_rule_set ? 'toc_min_run' THEN
    IF pg_catalog.jsonb_typeof(p_rule_set -> 'toc_min_run') <> 'number'
       OR (p_rule_set ->> 'toc_min_run')::numeric <> pg_catalog.trunc((p_rule_set ->> 'toc_min_run')::numeric)
       OR (p_rule_set ->> 'toc_min_run')::numeric NOT BETWEEN 2 AND 20 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'toc_min_run';
    END IF;
    v_toc_min_run := (p_rule_set ->> 'toc_min_run')::integer;
  END IF;

  IF pg_catalog.jsonb_typeof(p_rule_set -> 'headings') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_rule_set -> 'headings') < 1 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'headings';
  END IF;
  IF pg_catalog.jsonb_array_length(p_rule_set -> 'headings') > 60 THEN
    RAISE EXCEPTION 'limit_reached' USING ERRCODE = '54000', DETAIL = 'heading_patterns';
  END IF;
  FOR v_heading IN SELECT h.value FROM pg_catalog.jsonb_array_elements(p_rule_set -> 'headings') WITH ORDINALITY AS h(value, ord) ORDER BY h.ord LOOP
    IF pg_catalog.jsonb_typeof(v_heading) <> 'object' OR EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_object_keys(v_heading) AS k(key) WHERE k.key NOT IN ('pattern', 'flags', 'name', 'level', 'required', 'restart')
    ) THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'headings';
    END IF;
    IF pg_catalog.jsonb_typeof(v_heading -> 'pattern') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'pattern';
    END IF;
    v_pattern := v_heading ->> 'pattern';
    IF pg_catalog.length(v_pattern) < 1 OR pg_catalog.length(v_pattern) > 200 OR v_pattern = ANY (v_patterns) THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'pattern';
    END IF;
    v_patterns := pg_catalog.array_append(v_patterns, v_pattern);
    v_flags := COALESCE(v_heading ->> 'flags', 'u');
    IF COALESCE(pg_catalog.jsonb_typeof(v_heading -> 'flags'), 'string') <> 'string' OR v_flags NOT IN ('u', 'iu') THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'flags';
    END IF;
    IF pg_catalog.jsonb_typeof(v_heading -> 'name') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'heading_name';
    END IF;
    v_heading_name := v_heading ->> 'name';
    IF pg_catalog.length(v_heading_name) < 1 OR pg_catalog.length(v_heading_name) > 80 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'heading_name';
    END IF;
    IF pg_catalog.jsonb_typeof(v_heading -> 'level') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'level';
    END IF;
    v_level := (v_heading ->> 'level')::numeric;
    IF v_level <> pg_catalog.trunc(v_level) OR v_level NOT BETWEEN 1 AND 6 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'level';
    END IF;
    IF COALESCE(pg_catalog.jsonb_typeof(v_heading -> 'required'), 'boolean') <> 'boolean'
       OR COALESCE(pg_catalog.jsonb_typeof(v_heading -> 'restart'), 'boolean') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'headings';
    END IF;
    v_headings := v_headings || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'pattern', v_pattern,
      'flags', v_flags,
      'name', v_heading_name,
      'level', v_level::integer,
      'required', COALESCE((v_heading ->> 'required')::boolean, false),
      'restart', COALESCE((v_heading ->> 'restart')::boolean, false)
    ));
  END LOOP;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_section_rule_sets|' || p_tenant_key, 0));

  IF p_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.rag_section_rule_sets s WHERE s.tenant_key = p_tenant_key AND s.id = p_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rag_section_rule_sets s
    WHERE s.tenant_key = p_tenant_key AND s.name = v_name AND (p_id IS NULL OR s.id <> p_id)
  ) THEN
    RAISE EXCEPTION 'name_exists' USING ERRCODE = '23505';
  END IF;
  IF p_id IS NULL THEN
    SELECT pg_catalog.count(*)::integer INTO v_count FROM public.rag_section_rule_sets s WHERE s.tenant_key = p_tenant_key;
    IF v_count >= 10 THEN
      RAISE EXCEPTION 'limit_reached' USING ERRCODE = '54000', DETAIL = 'rule_sets';
    END IF;
  END IF;
  IF v_enabled AND EXISTS (
    SELECT 1 FROM public.rag_section_rule_sets s
    WHERE s.tenant_key = p_tenant_key
      AND s.enabled
      AND COALESCE(s.doc_type, '') = COALESCE(v_doc_type, '')
      AND COALESCE(s.source, '') = COALESCE(v_source, '')
      AND (p_id IS NULL OR s.id <> p_id)
  ) THEN
    RAISE EXCEPTION 'limit_reached' USING ERRCODE = '54000', DETAIL = 'binding';
  END IF;

  IF p_id IS NULL THEN
    RETURN QUERY
    INSERT INTO public.rag_section_rule_sets AS s (
      tenant_key, name, doc_type, source, enabled, rules, version, created_by, created_at, updated_by, updated_at
    )
    VALUES (
      p_tenant_key, v_name, v_doc_type, v_source, v_enabled,
      pg_catalog.jsonb_build_object(
        'headings', v_headings, 'require_increasing_numbers', v_increasing, 'skip_toc', v_skip_toc, 'toc_min_run', v_toc_min_run
      ),
      1, p_actor, v_now, p_actor, v_now
    )
    RETURNING s.id, s.name, s.doc_type, s.source, s.enabled, s.rules, s.version, s.created_at, s.updated_at;
  ELSE
    RETURN QUERY
    UPDATE public.rag_section_rule_sets AS s
       SET name = v_name,
           doc_type = v_doc_type,
           source = v_source,
           enabled = v_enabled,
           rules = pg_catalog.jsonb_build_object(
             'headings', v_headings, 'require_increasing_numbers', v_increasing, 'skip_toc', v_skip_toc, 'toc_min_run', v_toc_min_run
           ),
           version = s.version + 1,
           updated_by = p_actor,
           updated_at = GREATEST(v_now, s.updated_at + interval '1 microsecond')
     WHERE s.tenant_key = p_tenant_key AND s.id = p_id
    RETURNING s.id, s.name, s.doc_type, s.source, s.enabled, s.rules, s.version, s.created_at, s.updated_at;
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_section_rule_set_delete(p_actor uuid, p_tenant_key text, p_id uuid)
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
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'id';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_section_rule_sets|' || p_tenant_key, 0));
  DELETE FROM public.rag_section_rule_sets s
   WHERE s.tenant_key = p_tenant_key AND s.id = p_id
  RETURNING s.id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_id;
END
$fn$;

-- Boilerplate rules ------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_boilerplate_rules_list(p_actor uuid, p_tenant_key text)
RETURNS TABLE (
  id uuid, name text, kind text, pattern text, flags text, max_length integer, min_page_share double precision, doc_type text, source text,
  enabled boolean, version integer, created_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT r.id, r.name, r.kind, r.pattern, r.flags, r.max_length, r.min_page_share, r.doc_type, r.source, r.enabled, r.version,
         r.created_at, r.updated_at
  FROM public.rag_boilerplate_rules r
  WHERE r.tenant_key = p_tenant_key
  ORDER BY r.created_at, r.id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_boilerplate_rule_upsert(p_actor uuid, p_tenant_key text, p_rule jsonb, p_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, kind text, pattern text, flags text, max_length integer, min_page_share double precision, doc_type text, source text,
  enabled boolean, version integer, created_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_binding constant text := '^[a-z][a-z0-9_-]{0,63}$';
  v_name text;
  v_kind text;
  v_pattern text;
  v_flags text;
  v_max_length integer;
  v_share double precision;
  v_doc_type text;
  v_source text;
  v_enabled boolean := true;
  v_count integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
  END IF;

  IF p_rule IS NULL OR pg_catalog.jsonb_typeof(p_rule) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'rule';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_rule) AS k(key)
    WHERE k.key NOT IN ('name', 'kind', 'pattern', 'flags', 'max_length', 'min_page_share', 'doc_type', 'source', 'enabled')
  ) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'rule';
  END IF;

  IF pg_catalog.jsonb_typeof(p_rule -> 'name') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'name';
  END IF;
  v_name := p_rule ->> 'name';
  IF pg_catalog.length(pg_catalog.btrim(v_name)) < 1 OR pg_catalog.length(v_name) > 80 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'name';
  END IF;

  IF COALESCE(pg_catalog.jsonb_typeof(p_rule -> 'doc_type'), 'null') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'doc_type';
  END IF;
  v_doc_type := p_rule ->> 'doc_type';
  IF v_doc_type IS NOT NULL AND v_doc_type !~ v_binding THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'doc_type';
  END IF;
  IF COALESCE(pg_catalog.jsonb_typeof(p_rule -> 'source'), 'null') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'source';
  END IF;
  v_source := p_rule ->> 'source';
  IF v_source IS NOT NULL AND v_source !~ v_binding THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'source';
  END IF;
  IF p_rule ? 'enabled' THEN
    IF pg_catalog.jsonb_typeof(p_rule -> 'enabled') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'enabled';
    END IF;
    v_enabled := (p_rule ->> 'enabled')::boolean;
  END IF;

  v_kind := p_rule ->> 'kind';
  IF pg_catalog.jsonb_typeof(p_rule -> 'kind') IS DISTINCT FROM 'string' OR v_kind NOT IN ('line', 'fragment') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'kind';
  END IF;
  IF v_kind = 'line' THEN
    IF pg_catalog.jsonb_typeof(p_rule -> 'pattern') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'pattern';
    END IF;
    v_pattern := p_rule ->> 'pattern';
    IF pg_catalog.length(v_pattern) < 1 OR pg_catalog.length(v_pattern) > 200 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'pattern';
    END IF;
    v_flags := p_rule ->> 'flags';
    IF pg_catalog.jsonb_typeof(p_rule -> 'flags') IS DISTINCT FROM 'string' OR v_flags NOT IN ('u', 'iu') THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'flags';
    END IF;
    IF COALESCE(pg_catalog.jsonb_typeof(p_rule -> 'max_length'), 'null') <> 'null'
       OR COALESCE(pg_catalog.jsonb_typeof(p_rule -> 'min_page_share'), 'null') <> 'null' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'kind';
    END IF;
  ELSE
    IF COALESCE(pg_catalog.jsonb_typeof(p_rule -> 'pattern'), 'null') <> 'null'
       OR COALESCE(pg_catalog.jsonb_typeof(p_rule -> 'flags'), 'null') <> 'null' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'kind';
    END IF;
    IF pg_catalog.jsonb_typeof(p_rule -> 'max_length') IS DISTINCT FROM 'number'
       OR (p_rule ->> 'max_length')::numeric <> pg_catalog.trunc((p_rule ->> 'max_length')::numeric)
       OR (p_rule ->> 'max_length')::numeric NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'max_length';
    END IF;
    v_max_length := (p_rule ->> 'max_length')::integer;
    IF pg_catalog.jsonb_typeof(p_rule -> 'min_page_share') IS DISTINCT FROM 'number'
       OR (p_rule ->> 'min_page_share')::double precision <= 0
       OR (p_rule ->> 'min_page_share')::double precision > 1 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'min_page_share';
    END IF;
    v_share := (p_rule ->> 'min_page_share')::double precision;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_boilerplate_rules|' || p_tenant_key, 0));

  IF p_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.rag_boilerplate_rules r WHERE r.tenant_key = p_tenant_key AND r.id = p_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rag_boilerplate_rules r
    WHERE r.tenant_key = p_tenant_key AND r.name = v_name AND (p_id IS NULL OR r.id <> p_id)
  ) THEN
    RAISE EXCEPTION 'name_exists' USING ERRCODE = '23505';
  END IF;
  IF p_id IS NULL THEN
    SELECT pg_catalog.count(*)::integer INTO v_count FROM public.rag_boilerplate_rules r WHERE r.tenant_key = p_tenant_key;
    IF v_count >= 40 THEN
      RAISE EXCEPTION 'limit_reached' USING ERRCODE = '54000', DETAIL = 'boilerplate_rules';
    END IF;
  END IF;

  IF p_id IS NULL THEN
    RETURN QUERY
    INSERT INTO public.rag_boilerplate_rules AS r (
      tenant_key, name, kind, pattern, flags, max_length, min_page_share, doc_type, source, enabled, version,
      created_by, created_at, updated_by, updated_at
    )
    VALUES (
      p_tenant_key, v_name, v_kind, v_pattern, v_flags, v_max_length, v_share, v_doc_type, v_source, v_enabled, 1,
      p_actor, v_now, p_actor, v_now
    )
    RETURNING r.id, r.name, r.kind, r.pattern, r.flags, r.max_length, r.min_page_share, r.doc_type, r.source, r.enabled, r.version,
              r.created_at, r.updated_at;
  ELSE
    RETURN QUERY
    UPDATE public.rag_boilerplate_rules AS r
       SET name = v_name,
           kind = v_kind,
           pattern = v_pattern,
           flags = v_flags,
           max_length = v_max_length,
           min_page_share = v_share,
           doc_type = v_doc_type,
           source = v_source,
           enabled = v_enabled,
           version = r.version + 1,
           updated_by = p_actor,
           updated_at = GREATEST(v_now, r.updated_at + interval '1 microsecond')
     WHERE r.tenant_key = p_tenant_key AND r.id = p_id
    RETURNING r.id, r.name, r.kind, r.pattern, r.flags, r.max_length, r.min_page_share, r.doc_type, r.source, r.enabled, r.version,
              r.created_at, r.updated_at;
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_boilerplate_rule_delete(p_actor uuid, p_tenant_key text, p_id uuid)
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
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'id';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_boilerplate_rules|' || p_tenant_key, 0));
  DELETE FROM public.rag_boilerplate_rules r
   WHERE r.tenant_key = p_tenant_key AND r.id = p_id
  RETURNING r.id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_id;
END
$fn$;

-- Pipeline read for one binding ------------------------------------------------------------------------------------------------------
-- Precedence (D-18): 1 = document type and source, 2 = document type, 3 = source, 4 = tenant-wide. A row whose bound value differs from the
-- document's never applies. entry 'rule_set' rows carry the rule set columns, entry 'boilerplate_rule' rows the boilerplate rule columns.

CREATE OR REPLACE FUNCTION public.rag_tenant_rules_for(p_tenant_key text, p_doc_type text, p_source text)
RETURNS TABLE (
  entry text, id uuid, name text, version integer, doc_type text, source text, precedence integer, rules jsonb, kind text, pattern text,
  flags text, max_length integer, min_page_share double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF (p_doc_type IS NOT NULL AND p_doc_type !~ '^[a-z][a-z0-9_-]{0,63}$')
     OR (p_source IS NOT NULL AND p_source !~ '^[a-z][a-z0-9_-]{0,63}$') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'binding';
  END IF;

  RETURN QUERY
  SELECT 'rule_set'::text, s.id, s.name, s.version, s.doc_type, s.source, b.precedence, s.rules,
         NULL::text, NULL::text, NULL::text, NULL::integer, NULL::double precision
  FROM public.rag_section_rule_sets s
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN s.doc_type IS NOT NULL AND s.source IS NOT NULL THEN 1
             WHEN s.doc_type IS NOT NULL THEN 2
             WHEN s.source IS NOT NULL THEN 3
             ELSE 4
           END AS precedence
  ) b
  WHERE s.tenant_key = p_tenant_key
    AND s.enabled
    AND (s.doc_type IS NULL OR s.doc_type = p_doc_type)
    AND (s.source IS NULL OR s.source = p_source)
  ORDER BY b.precedence, s.created_at, s.id
  LIMIT 1;

  RETURN QUERY
  SELECT 'boilerplate_rule'::text, r.id, r.name, r.version, r.doc_type, r.source, b.precedence, NULL::jsonb,
         r.kind, r.pattern, r.flags, r.max_length, r.min_page_share
  FROM public.rag_boilerplate_rules r
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN r.doc_type IS NOT NULL AND r.source IS NOT NULL THEN 1
             WHEN r.doc_type IS NOT NULL THEN 2
             WHEN r.source IS NOT NULL THEN 3
             ELSE 4
           END AS precedence
  ) b
  WHERE r.tenant_key = p_tenant_key
    AND r.enabled
    AND (r.doc_type IS NULL OR r.doc_type = p_doc_type)
    AND (r.source IS NULL OR r.source = p_source)
  ORDER BY b.precedence, r.created_at, r.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_section_rule_sets_list(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_section_rule_sets_list(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_section_rule_set_upsert(uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_section_rule_set_upsert(uuid, text, jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_section_rule_set_delete(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_section_rule_set_delete(uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_boilerplate_rules_list(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_boilerplate_rules_list(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_boilerplate_rule_upsert(uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_boilerplate_rule_upsert(uuid, text, jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_boilerplate_rule_delete(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_boilerplate_rule_delete(uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_tenant_rules_for(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_tenant_rules_for(text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
