-- 0986: rag_tenant_doc_types (0981) takes the access filter (quick task doc-types-access; SEC-12, D-10, D-11 of Phase 4.3).
-- 0981 returned the doc types of every current, ready document of the tenant, so the doc-type vocabulary of the sub-question filters
-- (the shared.subq-filters.v1 prompt addendum and narrowFilters) named doc types that only restricted documents carry. The function is
-- the 0981 body plus p_access_keys text[] and p_access_all boolean, appended with defaults NULL and false, with the guard of 0930/0933
-- (as 1010): no keys while public.rag_access_enforced() (0922) is true raises access_scope_required (42501), an empty key array or one
-- holding NULL raises access_keys_empty (22023). The guard runs right after the tenant assertion. With keys and p_access_all not true,
-- a document counts only when documents.access_groups overlaps the keys, so a doc type carried only by documents outside the keys is
-- not listed and the counts leave those documents out. With no keys the function runs the 0981 query and returns what 0981 returned.
-- DROP section: every overload of rag_tenant_doc_types is dropped by catalog lookup first (the 0981 signature (text)), so exactly one
-- exists. SECURITY INVOKER, STABLE, empty search_path, executable by service_role only (0410 carries the guarded grant row).
-- rag_access_readiness() is redefined from its 0933 body with rag_tenant_doc_types added to the optional functions it checks; this file
-- is now the last definition of both. Operator rule (as 0933 and 1010): after re-running 0981 or 0933, re-run this file; until then the
-- old doc-type signature comes back as a second overload (readiness reports function_overloaded) or readiness stops checking it.
-- Common to single-tenant and multi-tenant (rag_assert_tenant_key decides the mode). Purge: no new store. Idempotent; not folded.

BEGIN;

DO $doc_types_access_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_access_enforced()') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_access_readiness()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'access_groups' AND NOT a.attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'doc_type' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0986: apply the 0920 block (0921, 0922, 0933) and 0981 first' USING ERRCODE = '55000';
  END IF;
END
$doc_types_access_precheck$;

DO $drop_doc_types_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rag_tenant_doc_types'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_doc_types_overloads$;

CREATE OR REPLACE FUNCTION public.rag_tenant_doc_types(
  p_tenant_key text,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  doc_type text,
  docs bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
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

  RETURN QUERY
  SELECT d.doc_type AS doc_type, pg_catalog.count(*) AS docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.is_current
    AND d.status = 'ready'
    AND d.doc_type IS NOT NULL
    AND (NOT v_restrict OR d.access_groups OPERATOR(pg_catalog.&&) p_access_keys)
  GROUP BY d.doc_type
  ORDER BY pg_catalog.count(*) DESC, d.doc_type;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_tenant_doc_types(text, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_tenant_doc_types(text, text[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_readiness()
RETURNS TABLE (ready boolean, reasons text[], objects text[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_multi boolean;
  v_required text[];
  v_optional constant text[] := ARRAY[
    'hybrid_search_translations', 'rag_cache_check', 'rag_table_lookup', 'rag_identifier_resolve',
    'rag_identifier_candidates', 'rag_dup_cluster_sources', 'rag_bm25_search_chunks',
    'rag_attribute_filter_values', 'rag_attribute_documents', 'rag_tenant_doc_types'
  ];
  v_required_tables constant text[] := ARRAY['documents', 'document_chunks', 'document_parents'];
  v_optional_tables constant text[] := ARRAY['chunk_translations', 'rag_table_rows'];
  v_name text;
  v_overloads integer;
  v_missing_params integer;
  v_missing_guard integer;
  v_reasons text[] := ARRAY[]::text[];
  v_objects text[] := ARRAY[]::text[];
BEGIN
  BEGIN
    PERFORM public.rag_assert_tenant_key('s:default');
    v_multi := false;
  EXCEPTION WHEN others THEN
    v_multi := true;
  END;
  v_required := ARRAY['hybrid_search_chunks', 'rag_fetch_parents', 'rag_exact_id_documents', 'match_chunks_by_profile', 'rag_find_invoices',
    CASE WHEN v_multi THEN 'match_documents_by_workspace' ELSE 'match_document_chunks' END];

  FOREACH v_name IN ARRAY v_required || v_optional LOOP
    SELECT pg_catalog.count(*)::integer,
           pg_catalog.count(*) FILTER (
             WHERE p.proargnames IS NULL
                OR NOT ('p_access_keys' = ANY (p.proargnames) AND 'p_access_all' = ANY (p.proargnames))
           )::integer,
           pg_catalog.count(*) FILTER (WHERE pg_catalog.strpos(p.prosrc, 'access_scope_required') = 0)::integer
      INTO v_overloads, v_missing_params, v_missing_guard
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_overloads = 0 THEN
      IF v_name = ANY (v_required) THEN
        v_reasons := v_reasons || 'function_missing'::text;
        v_objects := v_objects || v_name;
      END IF;
      CONTINUE;
    END IF;
    IF v_overloads > 1 THEN
      v_reasons := v_reasons || 'function_overloaded'::text;
      v_objects := v_objects || v_name;
    END IF;
    IF v_missing_params > 0 THEN
      v_reasons := v_reasons || 'function_missing_access_parameters'::text;
      v_objects := v_objects || v_name;
    END IF;
    IF v_missing_guard > 0 THEN
      v_reasons := v_reasons || 'function_missing_guard'::text;
      v_objects := v_objects || v_name;
    END IF;
  END LOOP;

  FOREACH v_name IN ARRAY v_required_tables || v_optional_tables LOOP
    IF pg_catalog.to_regclass('public.' || v_name) IS NULL THEN
      IF v_name = ANY (v_required_tables) THEN
        v_reasons := v_reasons || 'table_missing'::text;
        v_objects := v_objects || v_name;
      END IF;
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_name) AND a.attname = 'access_groups' AND NOT a.attisdropped
    ) THEN
      v_reasons := v_reasons || 'table_missing_column'::text;
      v_objects := v_objects || v_name;
    END IF;
  END LOOP;

  RETURN QUERY SELECT pg_catalog.cardinality(v_reasons) = 0, v_reasons, v_objects;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_readiness() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_readiness() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
