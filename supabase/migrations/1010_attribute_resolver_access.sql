-- 1010: the 1008 attribute resolver takes the access filter (quick task attribute-access; SEC-12, D-10, D-11 of Phase 4.3).
-- 1008 runs after the 0920 block (0930, 0933), so its two functions had no access parameters and rag_access_readiness() named them; this
-- file is now the last definition of both. Each is the 1008 body plus p_access_keys text[] and p_access_all boolean, appended with
-- defaults NULL and false, every earlier parameter keeping its name, position and default, with the guard of 0930/0933: no keys while
-- public.rag_access_enforced() (0922) is true raises access_scope_required (42501), an empty key array or one holding NULL raises
-- access_keys_empty (22023). The guard runs right after the tenant assertion, before any other check.
-- With keys and p_access_all not true, a document contributes only when documents.access_groups overlaps the keys:
--   rag_attribute_filter_values  a value carried only by documents outside the keys is not listed;
--   rag_attribute_documents      a document outside the keys is never returned.
-- Attribute values live on documents, so the document label is the predicate. With no keys each function runs the 1008 query and returns
-- what 1008 returned. Definitions are not access-labelled, so unknown_attribute is unchanged for every caller.
-- DROP section: every overload of both names is dropped by catalog lookup first (the 1008 signatures (text, integer) and
-- (text, jsonb, integer)), so exactly one of each exists. Both stay SECURITY INVOKER and STABLE with an empty search_path, and are
-- executable by service_role only (0410 carries the guarded grant rows for the new signatures).
-- Operator rule (as 0933): after re-running 1008, re-run this file; until then the old signatures come back as second overloads and
-- rag_access_readiness() reports function_overloaded. Common to single-tenant and multi-tenant (rag_assert_tenant_key decides the mode).
-- Purge: no new store. Idempotent; not folded into the setup files.

BEGIN;

DO $attribute_access_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_access_enforced()') IS NULL
     OR pg_catalog.to_regclass('public.rag_attribute_definitions') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'access_groups' AND NOT a.attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'attributes' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '1010: apply the 0920 block (0921, 0922) and 1001 through 1008 first' USING ERRCODE = '55000';
  END IF;
END
$attribute_access_precheck$;

DO $drop_attribute_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('rag_attribute_filter_values', 'rag_attribute_documents')
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_attribute_overloads$;

CREATE OR REPLACE FUNCTION public.rag_attribute_filter_values(
  p_tenant_key text,
  p_limit integer,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
 RETURNS TABLE(key text, value text, type text, soft boolean)
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_restrict boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
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
     AND (NOT v_restrict OR d.access_groups OPERATOR(pg_catalog.&&) p_access_keys)
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

CREATE OR REPLACE FUNCTION public.rag_attribute_documents(
  p_tenant_key text,
  p_filters jsonb,
  p_limit integer,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
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
  v_restrict boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
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
     AND (NOT v_restrict OR d.access_groups OPERATOR(pg_catalog.&&) p_access_keys)
  ) hit
  GROUP BY hit.id
  HAVING pg_catalog.count(*) = v_keys
  ORDER BY hit.id
  LIMIT p_limit;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_attribute_filter_values(text, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_filter_values(text, integer, text[], boolean) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_documents(text, jsonb, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_documents(text, jsonb, integer, text[], boolean) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
