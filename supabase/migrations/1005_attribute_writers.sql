-- 1005: Attribute value writers (plan 03.3-11; TPL-03; D-02, D-22, D-23; research F-11, F-12, pitfalls 8 and 9).
-- Values of a document's attributes reach documents.attributes and document_chunks.attributes (columns of 1001) on every write path:
--   rag_attribute_values_check     the SQL half of validateAttributes: the same four code words (unknown_attribute, invalid_attribute_type,
--                                  too_many_values, value_too_long), 200 characters per value, 50 distinct values per list; returns the
--                                  canonical object (values trimmed, list order kept).
--   rag_apply_document_attributes  the ingest pipeline's call for a version it has just begun (processing, not current), before any chunk
--                                  is written. Precedence (D-23): explicit values, else the row staged for (tenant, source, source_key),
--                                  which is consumed, else, only while the version's value is still NULL, the lineage's current value.
--   rag_set_document_attributes    changes an existing document and every chunk of it and removes the tenant's cached answers naming it
--                                  in the same transaction (the semantic cache triggers do not see the column); equal values write nothing.
--   rag_stage_document_attributes, rag_staged_attributes_read, rag_import_document_attributes, rag_document_attributes_read: staging by
--                                  source key before a document exists, the import by source key (one cache invalidation per batch) and
--                                  batched reads. At most 500 rows, keys or ids per call (ERRCODE 22023).
-- Chunks: the BEFORE INSERT row trigger rag_chunks_x_document_attributes sets every new chunk's attributes to its document's value (NULL
-- while the document has none), whatever the writer sent, after one primary-key read of the document of the chunk's own tenant. Its name
-- sorts after rag_chunks_legacy_defaults, which fills NEW.tenant_key first (row triggers of one event fire in name order). It is INVOKER:
-- the roles that insert chunks can read their own document rows, and a document they cannot read gives NULL. No chunk writer
-- (rag_write_chunks, rag_write_profile_chunks), no rag_set_document_fields, no hybrid_search_chunks, no template_row builder and no
-- rag_guard_ingest_state is redefined.
-- Direct writes: updates of the new columns by a signed-in client are refused by rag_guard_phase33_columns (1001); the insert guard
-- rag_documents_x_attribute_insert_guard here keeps attributes, attribute_header and attribute_header_stamp NULL on a document row inserted
-- by any role other than service_role, postgres or supabase_admin.
-- Every function is SECURITY INVOKER with an empty search_path, asserts the tenant key first, names the tenant in every predicate, and is
-- service_role only (REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role per signature). Errors carry code words,
-- never a value.
-- Purge: no new store; the column values go with their document and chunk rows, and staged rows are cleared by the hook of 1009.
-- Idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_attribute_trim(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT pg_catalog.regexp_replace(p_value, '^[[:space:]]+|[[:space:]]+$', '', 'g')
$function$;

CREATE OR REPLACE FUNCTION public.rag_attribute_values_check(p_tenant_key text, p_attributes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
DECLARE
  entry record;
  item record;
  v_type text;
  v_value text;
  v_list text[];
  v_out jsonb := '{}'::jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_attributes IS NULL OR pg_catalog.jsonb_typeof(p_attributes) <> 'object' THEN
    RAISE EXCEPTION 'invalid_attribute_type' USING ERRCODE = '22023';
  END IF;
  FOR entry IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_attributes) AS e(key, value) ORDER BY e.key COLLATE "C" LOOP
    SELECT d.type INTO v_type FROM public.rag_attribute_definitions d WHERE d.tenant_key = p_tenant_key AND d.key = entry.key;
    IF v_type IS NULL THEN
      RAISE EXCEPTION 'unknown_attribute' USING ERRCODE = '22023';
    END IF;
    IF v_type = 'text_list' THEN
      IF pg_catalog.jsonb_typeof(entry.value) <> 'array' OR pg_catalog.jsonb_array_length(entry.value) = 0 THEN
        RAISE EXCEPTION 'invalid_attribute_type' USING ERRCODE = '22023';
      END IF;
      IF pg_catalog.jsonb_array_length(entry.value) > 50 THEN
        RAISE EXCEPTION 'too_many_values' USING ERRCODE = '22023';
      END IF;
      v_list := '{}'::text[];
      FOR item IN SELECT a.value FROM pg_catalog.jsonb_array_elements(entry.value) WITH ORDINALITY AS a(value, position) ORDER BY a.position LOOP
        IF pg_catalog.jsonb_typeof(item.value) <> 'string' THEN
          RAISE EXCEPTION 'invalid_attribute_type' USING ERRCODE = '22023';
        END IF;
        v_value := public.rag_attribute_trim(item.value #>> '{}');
        IF v_value = '' THEN
          RAISE EXCEPTION 'invalid_attribute_type' USING ERRCODE = '22023';
        END IF;
        IF pg_catalog.length(v_value) > 200 THEN
          RAISE EXCEPTION 'value_too_long' USING ERRCODE = '22023';
        END IF;
        IF v_value = ANY (v_list) THEN
          RAISE EXCEPTION 'invalid_attribute_type' USING ERRCODE = '22023';
        END IF;
        v_list := v_list || v_value;
      END LOOP;
      v_out := v_out || pg_catalog.jsonb_build_object(entry.key, pg_catalog.to_jsonb(v_list));
    ELSE
      IF pg_catalog.jsonb_typeof(entry.value) <> 'string' THEN
        RAISE EXCEPTION 'invalid_attribute_type' USING ERRCODE = '22023';
      END IF;
      v_value := public.rag_attribute_trim(entry.value #>> '{}');
      IF v_value = '' THEN
        RAISE EXCEPTION 'invalid_attribute_type' USING ERRCODE = '22023';
      END IF;
      IF pg_catalog.length(v_value) > 200 THEN
        RAISE EXCEPTION 'value_too_long' USING ERRCODE = '22023';
      END IF;
      v_out := v_out || pg_catalog.jsonb_build_object(entry.key, v_value);
    END IF;
  END LOOP;
  RETURN v_out;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_apply_document_attributes(p_tenant_key text, p_document_id uuid, p_explicit jsonb DEFAULT NULL)
 RETURNS TABLE(document_id uuid, origin text, key_count integer, chunks_updated integer)
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc record;
  v_staged jsonb;
  v_values jsonb;
  v_origin text := 'none';
  v_chunks integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT d.id, d.source, d.source_key, d.lineage_id, d.attributes INTO doc
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.status = 'processing' AND NOT d.is_current
  FOR UPDATE;
  IF doc.id IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.attributes INTO v_staged
  FROM public.rag_staged_attributes s
  WHERE s.tenant_key = p_tenant_key AND s.source = doc.source AND s.source_key = doc.source_key
  FOR UPDATE;

  IF p_explicit IS NOT NULL THEN
    v_values := public.rag_attribute_values_check(p_tenant_key, p_explicit);
    v_origin := 'explicit';
  ELSIF v_staged IS NOT NULL THEN
    v_values := public.rag_attribute_values_check(p_tenant_key, v_staged);
    v_origin := 'staged';
  ELSIF doc.attributes IS NULL THEN
    SELECT c.attributes INTO v_values
    FROM public.documents c
    WHERE c.tenant_key = p_tenant_key AND c.lineage_id = doc.lineage_id AND c.is_current AND c.id <> doc.id AND c.attributes IS NOT NULL
    LIMIT 1;
    IF v_values IS NOT NULL THEN
      v_origin := 'inherited';
    END IF;
  END IF;

  -- A staged row belongs to the first version of its source key that is begun; explicit values of that version take its place.
  IF v_staged IS NOT NULL THEN
    DELETE FROM public.rag_staged_attributes s
    WHERE s.tenant_key = p_tenant_key AND s.source = doc.source AND s.source_key = doc.source_key;
  END IF;

  IF v_origin <> 'none' AND v_values IS DISTINCT FROM doc.attributes THEN
    UPDATE public.documents d SET attributes = v_values WHERE d.id = doc.id AND d.tenant_key = p_tenant_key;
    UPDATE public.document_chunks c SET attributes = v_values
    WHERE c.document_id = doc.id AND c.tenant_key = p_tenant_key AND c.attributes IS DISTINCT FROM v_values;
    GET DIAGNOSTICS v_chunks = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT doc.id, v_origin,
    COALESCE((SELECT pg_catalog.count(*)::integer FROM pg_catalog.jsonb_object_keys(COALESCE(v_values, '{}'::jsonb))), 0), v_chunks;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_document_attributes(p_tenant_key text, p_document_id uuid, p_attributes jsonb)
 RETURNS TABLE(document_id uuid, changed boolean, chunks_updated integer)
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc record;
  v_values jsonb;
  v_chunks integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_id IS NULL OR p_attributes IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT d.id, d.attributes INTO doc
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.status <> 'deleted'
  FOR UPDATE;
  IF doc.id IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  v_values := public.rag_attribute_values_check(p_tenant_key, p_attributes);
  IF v_values IS NOT DISTINCT FROM doc.attributes THEN
    RETURN QUERY SELECT doc.id, false, 0;
    RETURN;
  END IF;

  UPDATE public.documents d SET attributes = v_values WHERE d.id = doc.id AND d.tenant_key = p_tenant_key;
  UPDATE public.document_chunks c SET attributes = v_values
  WHERE c.document_id = doc.id AND c.tenant_key = p_tenant_key AND c.attributes IS DISTINCT FROM v_values;
  GET DIAGNOSTICS v_chunks = ROW_COUNT;
  PERFORM public.rag_cache_invalidate(p_tenant_key, ARRAY[doc.id]);

  RETURN QUERY SELECT doc.id, true, v_chunks;
END
$function$;

-- p_rows: [{ "source": text, "source_key": text, "attributes": object }, ...], at most 500.
CREATE OR REPLACE FUNCTION public.rag_stage_document_attributes(p_tenant_key text, p_rows jsonb)
 RETURNS TABLE(staged integer, unchanged integer)
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  item record;
  v_values jsonb;
  v_existing jsonb;
  v_staged integer := 0;
  v_unchanged integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' OR pg_catalog.jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT r.value FROM pg_catalog.jsonb_array_elements(p_rows) WITH ORDINALITY AS r(value, position) ORDER BY r.position LOOP
    IF pg_catalog.jsonb_typeof(item.value) <> 'object'
       OR pg_catalog.jsonb_typeof(item.value -> 'source') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(item.value -> 'source_key') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    v_values := public.rag_attribute_values_check(p_tenant_key, item.value -> 'attributes');
    v_existing := NULL;
    SELECT s.attributes INTO v_existing
    FROM public.rag_staged_attributes s
    WHERE s.tenant_key = p_tenant_key AND s.source = item.value ->> 'source' AND s.source_key = item.value ->> 'source_key'
    FOR UPDATE;
    IF v_existing IS NOT NULL AND v_existing = v_values THEN
      v_unchanged := v_unchanged + 1;
      CONTINUE;
    END IF;
    INSERT INTO public.rag_staged_attributes AS s (tenant_key, source, source_key, attributes)
    VALUES (p_tenant_key, item.value ->> 'source', item.value ->> 'source_key', v_values)
    ON CONFLICT (tenant_key, source, source_key) DO UPDATE SET attributes = EXCLUDED.attributes, staged_at = pg_catalog.now();
    v_staged := v_staged + 1;
  END LOOP;
  RETURN QUERY SELECT v_staged, v_unchanged;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_staged_attributes_read(p_tenant_key text, p_source text, p_source_keys text[])
 RETURNS TABLE(source_key text, attributes jsonb, staged_at timestamptz)
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_source IS NULL OR p_source_keys IS NULL OR pg_catalog.cardinality(p_source_keys) > 500 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT s.source_key, s.attributes, s.staged_at
  FROM public.rag_staged_attributes s
  WHERE s.tenant_key = p_tenant_key AND s.source = p_source AND s.source_key = ANY (p_source_keys)
  ORDER BY s.source_key COLLATE "C";
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_document_attributes_read(p_tenant_key text, p_document_ids uuid[])
 RETURNS TABLE(document_id uuid, attributes jsonb)
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_ids IS NULL OR pg_catalog.cardinality(p_document_ids) > 500 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT d.id, d.attributes
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.id = ANY (p_document_ids) AND d.status <> 'deleted'
  ORDER BY d.id;
END
$function$;

-- Import by source key (plan 03.3-13's rag:attributes --import): per row, the tenant's current document of (source, source_key) and any
-- processing version of that key get the values; a key without a document is staged. outbox_rows counts the vector_sync_outbox rows of
-- the tenant the call added (0 while no sync target is enabled). A dry run returns the same counts and writes nothing.
CREATE OR REPLACE FUNCTION public.rag_import_document_attributes(p_tenant_key text, p_rows jsonb, p_dry_run boolean DEFAULT false)
 RETURNS TABLE(
   documents_changed integer, documents_unchanged integer, chunks_updated integer, staged integer, staged_unchanged integer,
   changed_document_ids uuid[], outbox_rows integer
 )
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  item record;
  doc record;
  v_dry boolean := COALESCE(p_dry_run, false);
  v_values jsonb;
  v_existing jsonb;
  v_source text;
  v_key text;
  v_found boolean;
  v_count integer;
  v_changed uuid[] := '{}'::uuid[];
  v_unchanged integer := 0;
  v_chunks integer := 0;
  v_staged integer := 0;
  v_staged_unchanged integer := 0;
  v_outbox_before bigint;
  v_outbox_after bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' OR pg_catalog.jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.count(*) INTO v_outbox_before FROM public.vector_sync_outbox o WHERE o.tenant_key = p_tenant_key;

  FOR item IN SELECT r.value FROM pg_catalog.jsonb_array_elements(p_rows) WITH ORDINALITY AS r(value, position) ORDER BY r.position LOOP
    IF pg_catalog.jsonb_typeof(item.value) <> 'object'
       OR pg_catalog.jsonb_typeof(item.value -> 'source') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(item.value -> 'source_key') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    v_source := item.value ->> 'source';
    v_key := item.value ->> 'source_key';
    v_values := public.rag_attribute_values_check(p_tenant_key, item.value -> 'attributes');
    v_found := false;

    FOR doc IN
      SELECT d.id, d.attributes
      FROM public.documents d
      WHERE d.tenant_key = p_tenant_key AND d.source = v_source AND d.source_key = v_key
        AND ((d.is_current AND d.status <> 'deleted') OR (d.status = 'processing' AND NOT d.is_current))
      ORDER BY d.id
      FOR UPDATE
    LOOP
      v_found := true;
      IF doc.attributes IS NOT DISTINCT FROM v_values THEN
        IF NOT (doc.id = ANY (v_changed)) THEN
          v_unchanged := v_unchanged + 1;
        END IF;
        CONTINUE;
      END IF;
      IF NOT (doc.id = ANY (v_changed)) THEN
        v_changed := v_changed || doc.id;
      END IF;
      IF v_dry THEN
        SELECT pg_catalog.count(*)::integer INTO v_count
        FROM public.document_chunks c
        WHERE c.document_id = doc.id AND c.tenant_key = p_tenant_key AND c.attributes IS DISTINCT FROM v_values;
      ELSE
        UPDATE public.documents d SET attributes = v_values WHERE d.id = doc.id AND d.tenant_key = p_tenant_key;
        UPDATE public.document_chunks c SET attributes = v_values
        WHERE c.document_id = doc.id AND c.tenant_key = p_tenant_key AND c.attributes IS DISTINCT FROM v_values;
        GET DIAGNOSTICS v_count = ROW_COUNT;
      END IF;
      v_chunks := v_chunks + v_count;
    END LOOP;

    IF NOT v_found THEN
      v_existing := NULL;
      SELECT s.attributes INTO v_existing
      FROM public.rag_staged_attributes s
      WHERE s.tenant_key = p_tenant_key AND s.source = v_source AND s.source_key = v_key;
      IF v_existing IS NOT NULL AND v_existing = v_values THEN
        v_staged_unchanged := v_staged_unchanged + 1;
      ELSE
        v_staged := v_staged + 1;
        IF NOT v_dry THEN
          INSERT INTO public.rag_staged_attributes AS s (tenant_key, source, source_key, attributes)
          VALUES (p_tenant_key, v_source, v_key, v_values)
          ON CONFLICT (tenant_key, source, source_key) DO UPDATE SET attributes = EXCLUDED.attributes, staged_at = pg_catalog.now();
        END IF;
      END IF;
    END IF;
  END LOOP;

  IF NOT v_dry AND pg_catalog.cardinality(v_changed) > 0 THEN
    PERFORM public.rag_cache_invalidate(p_tenant_key, v_changed);
  END IF;
  SELECT pg_catalog.count(*) INTO v_outbox_after FROM public.vector_sync_outbox o WHERE o.tenant_key = p_tenant_key;

  RETURN QUERY SELECT pg_catalog.cardinality(v_changed), v_unchanged, v_chunks, v_staged, v_staged_unchanged, v_changed,
    (v_outbox_after - v_outbox_before)::integer;
END
$function$;

-- Chunk copy trigger (D-22, F-12): every inserted chunk carries its document's value.
CREATE OR REPLACE FUNCTION public.rag_chunks_x_document_attributes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
BEGIN
  NEW.attributes := (SELECT d.attributes FROM public.documents d WHERE d.id = NEW.document_id AND d.tenant_key = NEW.tenant_key);
  RETURN NEW;
END
$function$;

-- Insert guard (T-03.3-13): a document row inserted by any other role keeps the three attribute columns NULL.
CREATE OR REPLACE FUNCTION public.rag_documents_x_attribute_insert_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
BEGIN
  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    NEW.attributes := NULL;
    NEW.attribute_header := NULL;
    NEW.attribute_header_stamp := NULL;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS rag_chunks_x_document_attributes ON public.document_chunks;
CREATE TRIGGER rag_chunks_x_document_attributes
  BEFORE INSERT ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunks_x_document_attributes();

DROP TRIGGER IF EXISTS rag_documents_x_attribute_insert_guard ON public.documents;
CREATE TRIGGER rag_documents_x_attribute_insert_guard
  BEFORE INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.rag_documents_x_attribute_insert_guard();

REVOKE ALL ON FUNCTION public.rag_attribute_trim(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_trim(text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_values_check(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_values_check(text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_apply_document_attributes(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_apply_document_attributes(text, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_set_document_attributes(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_document_attributes(text, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_stage_document_attributes(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_stage_document_attributes(text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_staged_attributes_read(text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_staged_attributes_read(text, text, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_document_attributes_read(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_document_attributes_read(text, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_import_document_attributes(text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_import_document_attributes(text, jsonb, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.rag_chunks_x_document_attributes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunks_x_document_attributes() TO service_role;
REVOKE ALL ON FUNCTION public.rag_documents_x_attribute_insert_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_documents_x_attribute_insert_guard() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
