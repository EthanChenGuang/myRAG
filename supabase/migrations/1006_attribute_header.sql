-- 1006: Phase 3.3 attribute header template, stored header and chunk stamp (plan 03.3-15; TPL-05, TPL-08; D-02, D-26, D-27, F-14, F-15).
-- One header template per tenant (rag_attribute_header_templates, 1001), at most 200 characters, read and written only here:
--   rag_attribute_header_template_get (admin view), rag_attribute_header_template_for (the pipeline's read), rag_attribute_header_template_set.
-- Every placeholder of a saved template must name an in_header attribute definition of that tenant (unknown_placeholder); the check runs
-- under the per-tenant advisory lock of 1003, whose writers refuse to take a named key out of the header. A NULL template removes the row;
-- the next save takes a version above every version still found in a stamp of the tenant's documents or chunks, so an old stamp never
-- looks current. The application renders the header (renderTemplateHeader) and stores it with its stamp
-- t<template version>.<12 hex> on the document through rag_set_document_attribute_headers; rag_attribute_headers is the one batched read
-- (by document ids, or by chunk ids for chunks whose own stamp equals their document's). rag_attribute_header_pending lists the documents
-- whose stamp is not of the current template version; rag_attribute_header_stale lists current, ready documents that serve a chunk whose
-- stamp differs from the document's.
-- document_chunks.attribute_header_stamp is filled from the chunk metadata key attribute_header_stamp by its own row trigger, like
-- lexical_dict_version in 0851: a well-formed value sets the column, the value none clears it, a write without the key leaves it and a
-- malformed value is ignored. The trigger name sorts before rag_guard_phase33_columns (1001), which refuses the change for other roles.
-- The functions that build template_row, the chunk writers (rag_write_chunks and the relex and rechunk writers), rag_set_document_fields
-- and hybrid_search_chunks are not redefined here; embedding_text_version is untouched.
-- Every function is SECURITY INVOKER with an empty search_path, asserts the tenant key first and names the tenant in every predicate;
-- service_role only. Refusals put a code word first (not_admin, unknown_placeholder, invalid_argument); malformed arguments are 22023.
-- Purge: templates are tenant settings; the stored header and stamps are columns of the document and chunk rows and go with them.
-- Idempotent; not folded into the setup files.

BEGIN;

DO $attribute_header_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_attribute_header_templates') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_attribute_definition_upsert(uuid, text, text, text, boolean, boolean, boolean, boolean)') IS NULL THEN
    RAISE EXCEPTION '1006: apply 1001 and 1003 first' USING ERRCODE = '55000';
  END IF;
END
$attribute_header_precheck$;

CREATE OR REPLACE FUNCTION public.rag_attribute_header_template_get(p_actor uuid, p_tenant_key text)
RETURNS TABLE (template text, version integer, updated_at timestamptz)
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
  SELECT t.template, t.version, t.updated_at
  FROM public.rag_attribute_header_templates t
  WHERE t.tenant_key = p_tenant_key;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_attribute_header_template_for(p_tenant_key text)
RETURNS TABLE (template text, version integer)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT t.template, t.version
  FROM public.rag_attribute_header_templates t
  WHERE t.tenant_key = p_tenant_key;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_attribute_header_template_set(p_actor uuid, p_tenant_key text, p_template text)
RETURNS TABLE (template text, version integer, updated_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_existing record;
  v_floor integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_template IS NOT NULL AND pg_catalog.length(p_template) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_argument: template' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_attribute_definitions|' || p_tenant_key, 0));

  IF p_template IS NULL THEN
    DELETE FROM public.rag_attribute_header_templates t WHERE t.tenant_key = p_tenant_key;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.regexp_matches(p_template, '\{([^{}]*)\}', 'g') AS m(parts)
    WHERE m.parts[1] !~ '^[a-z][a-z0-9_]*$'
       OR NOT EXISTS (
         SELECT 1 FROM public.rag_attribute_definitions d
         WHERE d.tenant_key = p_tenant_key AND d.key = m.parts[1] AND d.in_header
       )
  ) THEN
    RAISE EXCEPTION 'unknown_placeholder' USING ERRCODE = '2BP01';
  END IF;

  SELECT t.template, t.version INTO v_existing
  FROM public.rag_attribute_header_templates t
  WHERE t.tenant_key = p_tenant_key
  FOR UPDATE;

  IF v_existing.version IS NOT NULL THEN
    IF v_existing.template = p_template THEN
      RETURN QUERY
      SELECT t.template, t.version, t.updated_at FROM public.rag_attribute_header_templates t WHERE t.tenant_key = p_tenant_key;
      RETURN;
    END IF;
    RETURN QUERY
    UPDATE public.rag_attribute_header_templates AS t
       SET template = p_template, version = t.version + 1, updated_by = p_actor, updated_at = v_now
     WHERE t.tenant_key = p_tenant_key
    RETURNING t.template, t.version, t.updated_at;
    RETURN;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT pg_catalog.max(pg_catalog.substring(d.attribute_header_stamp, '^t([0-9]{1,9})\.')::integer)
                FROM public.documents d
               WHERE d.tenant_key = p_tenant_key AND d.attribute_header_stamp ~ '^t[0-9]{1,9}\.'), 0),
    COALESCE((SELECT pg_catalog.max(pg_catalog.substring(c.attribute_header_stamp, '^t([0-9]{1,9})\.')::integer)
                FROM public.document_chunks c
               WHERE c.tenant_key = p_tenant_key AND c.attribute_header_stamp ~ '^t[0-9]{1,9}\.'), 0)
  ) INTO v_floor;

  RETURN QUERY
  INSERT INTO public.rag_attribute_header_templates AS t (tenant_key, template, version, updated_by, updated_at)
  VALUES (p_tenant_key, p_template, v_floor + 1, p_actor, v_now)
  RETURNING t.template, t.version, t.updated_at;
END
$fn$;

-- p_rows: [{ "document_id": uuid, "header": text | null, "stamp": text | null }, ...], at most 500. A NULL stamp clears both columns.
CREATE OR REPLACE FUNCTION public.rag_set_document_attribute_headers(p_tenant_key text, p_rows jsonb)
RETURNS TABLE (updated integer, unchanged integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  item record;
  v_id uuid;
  v_header text;
  v_stamp text;
  v_count integer;
  v_updated integer := 0;
  v_unchanged integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' OR pg_catalog.jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'invalid_argument: rows' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT r.value FROM pg_catalog.jsonb_array_elements(p_rows) WITH ORDINALITY AS r(value, position) ORDER BY r.position LOOP
    IF pg_catalog.jsonb_typeof(item.value) <> 'object'
       OR pg_catalog.jsonb_typeof(item.value -> 'document_id') IS DISTINCT FROM 'string'
       OR (item.value ->> 'document_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR COALESCE(pg_catalog.jsonb_typeof(item.value -> 'header'), 'null') NOT IN ('string', 'null')
       OR COALESCE(pg_catalog.jsonb_typeof(item.value -> 'stamp'), 'null') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'invalid_argument: row' USING ERRCODE = '22023';
    END IF;
    v_id := (item.value ->> 'document_id')::uuid;
    v_header := item.value ->> 'header';
    v_stamp := item.value ->> 'stamp';
    IF v_stamp IS NOT NULL AND v_stamp !~ '^t[0-9]{1,9}\.[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_argument: stamp' USING ERRCODE = '22023';
    END IF;
    IF (v_stamp IS NULL AND v_header IS NOT NULL) OR pg_catalog.length(v_header) > 1000 THEN
      RAISE EXCEPTION 'invalid_argument: header' USING ERRCODE = '22023';
    END IF;
    UPDATE public.documents d
       SET attribute_header = v_header, attribute_header_stamp = v_stamp
     WHERE d.id = v_id AND d.tenant_key = p_tenant_key AND d.status <> 'deleted'
       AND (d.attribute_header IS DISTINCT FROM v_header OR d.attribute_header_stamp IS DISTINCT FROM v_stamp);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      v_updated := v_updated + 1;
    ELSIF EXISTS (SELECT 1 FROM public.documents d WHERE d.id = v_id AND d.tenant_key = p_tenant_key AND d.status <> 'deleted') THEN
      v_unchanged := v_unchanged + 1;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_updated, v_unchanged;
END
$fn$;

-- Exactly one of p_document_ids and p_chunk_ids, at most 1,000 ids.
CREATE OR REPLACE FUNCTION public.rag_attribute_headers(p_tenant_key text, p_document_ids uuid[] DEFAULT NULL, p_chunk_ids uuid[] DEFAULT NULL)
RETURNS TABLE (document_id uuid, chunk_id uuid, header text, stamp text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF (p_document_ids IS NULL) = (p_chunk_ids IS NULL) THEN
    RAISE EXCEPTION 'invalid_argument: ids' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(COALESCE(p_document_ids, p_chunk_ids)) > 1000 THEN
    RAISE EXCEPTION 'invalid_argument: ids' USING ERRCODE = '22023';
  END IF;
  IF p_document_ids IS NOT NULL THEN
    RETURN QUERY
    SELECT d.id, NULL::uuid, d.attribute_header, d.attribute_header_stamp
    FROM public.documents d
    WHERE d.id = ANY (p_document_ids) AND d.tenant_key = p_tenant_key AND d.status <> 'deleted' AND d.attribute_header_stamp IS NOT NULL
    ORDER BY d.id;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT c.document_id, c.id, d.attribute_header, d.attribute_header_stamp
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
  WHERE c.id = ANY (p_chunk_ids) AND c.tenant_key = p_tenant_key AND d.status <> 'deleted'
    AND c.attribute_header_stamp IS NOT NULL AND c.attribute_header_stamp = d.attribute_header_stamp
  ORDER BY c.id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_attribute_header_pending(p_tenant_key text, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS TABLE (document_id uuid, attributes jsonb, stamp text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_version integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_argument: limit' USING ERRCODE = '22023';
  END IF;
  SELECT t.version INTO v_version FROM public.rag_attribute_header_templates t WHERE t.tenant_key = p_tenant_key;
  RETURN QUERY
  SELECT d.id, d.attributes, d.attribute_header_stamp
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.status <> 'deleted'
    AND (p_after IS NULL OR d.id > p_after)
    AND CASE
          WHEN v_version IS NULL THEN d.attribute_header_stamp IS NOT NULL
          ELSE d.attribute_header_stamp IS NULL OR d.attribute_header_stamp NOT LIKE ('t' || v_version::text || '.%')
        END
  ORDER BY d.id
  LIMIT p_limit;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_attribute_header_stale(
  p_tenant_key text,
  p_profile_id text DEFAULT NULL,
  p_after uuid DEFAULT NULL,
  p_limit integer DEFAULT 200
)
RETURNS TABLE (document_id uuid, doc_type text, stamp text, stale_chunks integer)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_argument: limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT d.id, d.doc_type, d.attribute_header_stamp, pg_catalog.count(*)::integer
  FROM public.documents d
  JOIN public.document_chunks c ON c.document_id = d.id AND c.tenant_key = p_tenant_key
  WHERE d.tenant_key = p_tenant_key
    AND d.is_current
    AND d.status = 'ready'
    AND (p_after IS NULL OR d.id > p_after)
    AND c.is_current
    AND c.attribute_header_stamp IS DISTINCT FROM d.attribute_header_stamp
    AND CASE
          WHEN p_profile_id IS NULL THEN EXISTS (
            SELECT 1 FROM public.rag_servable_chunks s WHERE s.chunk_id = c.id AND s.tenant_key = p_tenant_key
          )
          ELSE c.chunking_profile_id = p_profile_id AND c.status IN ('ready', 'variant')
        END
  GROUP BY d.id, d.doc_type, d.attribute_header_stamp
  ORDER BY d.id
  LIMIT p_limit;
END
$fn$;

-- Touches only NEW, so SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.rag_chunk_attribute_header_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_value text;
BEGIN
  IF NEW.metadata IS NULL OR pg_catalog.jsonb_typeof(NEW.metadata) <> 'object' THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.metadata -> 'attribute_header_stamp') IS DISTINCT FROM 'string' THEN
    RETURN NEW;
  END IF;
  v_value := NEW.metadata ->> 'attribute_header_stamp';
  IF v_value = 'none' THEN
    NEW.attribute_header_stamp := NULL;
  ELSIF v_value ~ '^t[0-9]{1,9}\.[0-9a-f]{12}$' THEN
    NEW.attribute_header_stamp := v_value;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS rag_chunk_attribute_header_stamp ON public.document_chunks;
CREATE TRIGGER rag_chunk_attribute_header_stamp
  BEFORE INSERT OR UPDATE OF metadata ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunk_attribute_header_stamp();

REVOKE ALL ON FUNCTION public.rag_attribute_header_template_get(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_header_template_get(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_header_template_for(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_header_template_for(text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_header_template_set(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_header_template_set(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_set_document_attribute_headers(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_document_attribute_headers(text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_headers(text, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_headers(text, uuid[], uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_header_pending(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_header_pending(text, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_header_stale(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_header_stale(text, text, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rag_chunk_attribute_header_stamp() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunk_attribute_header_stamp() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
