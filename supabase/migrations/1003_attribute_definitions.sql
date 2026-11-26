-- 1003: Phase 3.3 attribute definition functions (plan 03.3-08; TPL-03, TPL-08; D-02, D-12, D-22).
-- List, service read, upsert and delete over rag_attribute_definitions (1001):
--   rag_attribute_definitions_list (admin view), rag_attribute_definitions_for (the pipeline's read), rag_attribute_definition_upsert,
--   rag_attribute_definition_delete.
-- Every function is SECURITY INVOKER with an empty search_path, asserts the tenant key first and names the tenant in every predicate;
-- service_role only. Writers take p_actor and admit only an admin of that tenant (rag_upload_approval_keys); the list gives no rows to
-- anyone else. Limits (D-12): at most 30 definitions per tenant, counted under a per-tenant advisory lock; key pattern
-- ^[a-z][a-z0-9_]{0,39}$; type text, text_list or code, immutable per key; in_identifier_index only on code. A key named between braces
-- by the tenant's header template (rag_attribute_header_templates) can be neither deleted nor taken out of the header.
-- Refusals put a fixed code word first in the message (not_admin, not_found, limit_reached, invalid_attribute_type, unknown_placeholder);
-- malformed arguments raise invalid_argument with ERRCODE 22023.
-- Tenant settings, no document reference, so no lineage purge. Stored values of a deleted key stay on documents until an import replaces
-- them; later plans read only keys that the loaded schema still has.
-- Idempotent; not folded into the setup files.

BEGIN;

DO $attribute_definitions_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_attribute_definitions') IS NULL
     OR pg_catalog.to_regclass('public.rag_attribute_header_templates') IS NULL THEN
    RAISE EXCEPTION '1003: apply 1001 first' USING ERRCODE = '55000';
  END IF;
END
$attribute_definitions_precheck$;

CREATE OR REPLACE FUNCTION public.rag_attribute_definitions_list(p_actor uuid, p_tenant_key text)
RETURNS TABLE (
  key text, type text, filterable boolean, in_header boolean, in_identifier_index boolean, soft boolean, updated_at timestamptz
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
  SELECT d.key, d.type, d.filterable, d.in_header, d.in_identifier_index, d.soft, d.updated_at
  FROM public.rag_attribute_definitions d
  WHERE d.tenant_key = p_tenant_key
  ORDER BY d.key COLLATE "C";
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_attribute_definitions_for(p_tenant_key text)
RETURNS TABLE (key text, type text, filterable boolean, in_header boolean, in_identifier_index boolean, soft boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT d.key, d.type, d.filterable, d.in_header, d.in_identifier_index, d.soft
  FROM public.rag_attribute_definitions d
  WHERE d.tenant_key = p_tenant_key
  ORDER BY d.key COLLATE "C";
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_attribute_definition_upsert(
  p_actor uuid,
  p_tenant_key text,
  p_key text,
  p_type text,
  p_filterable boolean,
  p_in_header boolean,
  p_in_identifier_index boolean,
  p_soft boolean
)
RETURNS TABLE (
  key text, type text, filterable boolean, in_header boolean, in_identifier_index boolean, soft boolean, updated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_existing_type text;
  v_count integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_key IS NULL OR p_key !~ '^[a-z][a-z0-9_]{0,39}$' THEN
    RAISE EXCEPTION 'invalid_argument: key' USING ERRCODE = '22023';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('text', 'text_list', 'code') THEN
    RAISE EXCEPTION 'invalid_argument: type' USING ERRCODE = '22023';
  END IF;
  IF p_filterable IS NULL OR p_in_header IS NULL OR p_in_identifier_index IS NULL OR p_soft IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: flags' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
  END IF;
  IF p_in_identifier_index AND p_type <> 'code' THEN
    RAISE EXCEPTION 'invalid_attribute_type' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_attribute_definitions|' || p_tenant_key, 0));

  SELECT d.type INTO v_existing_type
  FROM public.rag_attribute_definitions d
  WHERE d.tenant_key = p_tenant_key AND d.key = p_key;

  IF v_existing_type IS NOT NULL AND v_existing_type <> p_type THEN
    RAISE EXCEPTION 'invalid_attribute_type' USING ERRCODE = '22023';
  END IF;
  IF NOT p_in_header AND EXISTS (
    SELECT 1 FROM public.rag_attribute_header_templates t
    WHERE t.tenant_key = p_tenant_key AND pg_catalog.strpos(t.template, '{' || p_key || '}') > 0
  ) THEN
    RAISE EXCEPTION 'unknown_placeholder' USING ERRCODE = '2BP01';
  END IF;

  IF v_existing_type IS NULL THEN
    SELECT pg_catalog.count(*)::integer INTO v_count FROM public.rag_attribute_definitions d WHERE d.tenant_key = p_tenant_key;
    IF v_count >= 30 THEN
      RAISE EXCEPTION 'limit_reached' USING ERRCODE = '54000';
    END IF;
    RETURN QUERY
    INSERT INTO public.rag_attribute_definitions AS d (
      tenant_key, key, type, filterable, in_header, in_identifier_index, soft, created_by, created_at, updated_by, updated_at
    )
    VALUES (p_tenant_key, p_key, p_type, p_filterable, p_in_header, p_in_identifier_index, p_soft, p_actor, v_now, p_actor, v_now)
    RETURNING d.key, d.type, d.filterable, d.in_header, d.in_identifier_index, d.soft, d.updated_at;
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.rag_attribute_definitions AS d
     SET filterable = p_filterable,
         in_header = p_in_header,
         in_identifier_index = p_in_identifier_index,
         soft = p_soft,
         updated_by = p_actor,
         updated_at = GREATEST(v_now, d.updated_at + interval '1 microsecond')
   WHERE d.tenant_key = p_tenant_key AND d.key = p_key
  RETURNING d.key, d.type, d.filterable, d.in_header, d.in_identifier_index, d.soft, d.updated_at;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_attribute_definition_delete(p_actor uuid, p_tenant_key text, p_key text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_key IS NULL OR p_key !~ '^[a-z][a-z0-9_]{0,39}$' THEN
    RAISE EXCEPTION 'invalid_argument: key' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_attribute_definitions|' || p_tenant_key, 0));

  IF NOT EXISTS (SELECT 1 FROM public.rag_attribute_definitions d WHERE d.tenant_key = p_tenant_key AND d.key = p_key) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rag_attribute_header_templates t
    WHERE t.tenant_key = p_tenant_key AND pg_catalog.strpos(t.template, '{' || p_key || '}') > 0
  ) THEN
    RAISE EXCEPTION 'unknown_placeholder' USING ERRCODE = '2BP01';
  END IF;

  DELETE FROM public.rag_attribute_definitions d
  WHERE d.tenant_key = p_tenant_key AND d.key = p_key
  RETURNING d.key INTO v_key;
  RETURN v_key;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_attribute_definitions_list(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_definitions_list(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_definitions_for(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_definitions_for(text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_definition_upsert(uuid, text, text, text, boolean, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_definition_upsert(uuid, text, text, text, boolean, boolean, boolean, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_definition_delete(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_definition_delete(uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
