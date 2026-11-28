-- 1008: Attribute resolver (plan 03.3-18; TPL-06; D-02, D-28, D-29, D-30; research F-16, F-25).
--   rag_attribute_filter_values  the tenant's value lexicon: one row per distinct (key, value) of a filterable definition that a current, ready
--                                document of that tenant carries, a list unnested to one row per element, ordered by key then value
--                                (COLLATE "C"), at most p_limit rows. The caller asks for one row above its cap to tell "too broad".
--   rag_attribute_documents      ids of the tenant's current, ready documents whose attributes carry the asked values: any value of one key
--                                and every key. Stored values are compared exactly through jsonb containment, so idx_documents_attributes
--                                (GIN jsonb_path_ops on documents.attributes) serves each (key, value) probe. Ascending ids, at most p_limit.
-- Refusals: a key that is not a filterable definition of that tenant raises unknown_attribute (22023); a filter that is not an object, is empty,
-- holds a value list that is not a non-empty array of strings, more than 30 keys, more than 50 values or a value over 200 characters, and a
-- limit outside 1..100000, raise invalid_argument (22023). Messages carry code words only, never a value.
-- Both functions are SECURITY INVOKER and STABLE with an empty search_path, assert the tenant key first, name the tenant in every predicate and
-- are service_role only. No other function is created or replaced: not hybrid_search_chunks, not a chunk writer, not rag_set_document_fields.
-- Purge: no new store (the index goes with its rows).
-- Idempotent; not folded into the setup files.

BEGIN;

DO $precheck$
BEGIN
  IF to_regclass('public.rag_attribute_definitions') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'attributes'
     ) THEN
    RAISE EXCEPTION '1008 needs migration 1001 (rag_attribute_definitions, documents.attributes)' USING ERRCODE = '55000';
  END IF;
END
$precheck$;

CREATE INDEX IF NOT EXISTS idx_documents_attributes ON public.documents USING gin (attributes jsonb_path_ops);

CREATE OR REPLACE FUNCTION public.rag_attribute_filter_values(p_tenant_key text, p_limit integer)
 RETURNS TABLE(key text, value text, type text, soft boolean)
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT v.key, v.value, v.type, v.soft
  FROM (
    SELECT DISTINCT def.key, item.value #>> '{}' AS value, def.type, def.soft
    FROM public.rag_attribute_definitions def
    JOIN public.documents d
      ON d.tenant_key = p_tenant_key AND d.status = 'ready' AND d.is_current
     AND d.attributes IS NOT NULL AND d.attributes ? def.key
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      CASE WHEN pg_catalog.jsonb_typeof(d.attributes -> def.key) = 'array' THEN d.attributes -> def.key
           ELSE pg_catalog.jsonb_build_array(d.attributes -> def.key) END
    ) AS item(value)
    WHERE def.tenant_key = p_tenant_key AND def.filterable
      AND pg_catalog.jsonb_typeof(item.value) = 'string'
  ) v
  ORDER BY v.key COLLATE "C", v.value COLLATE "C"
  LIMIT p_limit;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_attribute_documents(p_tenant_key text, p_filters jsonb, p_limit integer)
 RETURNS TABLE(document_id uuid)
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  entry record;
  item record;
  v_type text;
  v_keys integer := 0;
  v_values integer;
  v_patterns jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_filters IS NULL OR pg_catalog.jsonb_typeof(p_filters) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  FOR entry IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_filters) AS e(key, value) ORDER BY e.key COLLATE "C" LOOP
    v_keys := v_keys + 1;
    IF v_keys > 30 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.jsonb_typeof(entry.value) <> 'array' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    v_values := pg_catalog.jsonb_array_length(entry.value);
    IF v_values = 0 OR v_values > 50 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    FOR item IN SELECT i.value FROM pg_catalog.jsonb_array_elements(entry.value) AS i(value) LOOP
      IF pg_catalog.jsonb_typeof(item.value) <> 'string'
         OR pg_catalog.char_length(item.value #>> '{}') NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;
  IF v_keys = 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  FOR entry IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_filters) AS e(key, value) ORDER BY e.key COLLATE "C" LOOP
    v_type := NULL;
    SELECT def.type INTO v_type
    FROM public.rag_attribute_definitions def
    WHERE def.tenant_key = p_tenant_key AND def.key = entry.key AND def.filterable;
    IF v_type IS NULL THEN
      RAISE EXCEPTION 'unknown_attribute' USING ERRCODE = '22023';
    END IF;
    FOR item IN SELECT DISTINCT i.value FROM pg_catalog.jsonb_array_elements(entry.value) AS i(value) LOOP
      v_patterns := v_patterns || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'key', entry.key,
        'pattern', pg_catalog.jsonb_build_object(
          entry.key,
          CASE WHEN v_type = 'text_list' THEN pg_catalog.jsonb_build_array(item.value) ELSE item.value END
        )
      ));
    END LOOP;
  END LOOP;

  RETURN QUERY
  SELECT hit.id
  FROM (
    SELECT DISTINCT probe.value ->> 'key' AS key, d.id
    FROM pg_catalog.jsonb_array_elements(v_patterns) AS probe(value)
    JOIN public.documents d
      ON d.tenant_key = p_tenant_key AND d.status = 'ready' AND d.is_current
     AND d.attributes @> (probe.value -> 'pattern')
  ) hit
  GROUP BY hit.id
  HAVING pg_catalog.count(*) = v_keys
  ORDER BY hit.id
  LIMIT p_limit;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_attribute_filter_values(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_filter_values(text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_documents(text, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_documents(text, jsonb, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
