-- 0855: rag_document_versions(p_tenant_key, p_document_ids) returns the version, currency and own effective dates of the listed
-- documents of one tenant (Phase 4.2, RET-11, D-44): the label lookup for context blocks under a non-current version scope. A document of
-- another tenant, or an unknown id, returns nothing. At most 500 ids per call (more raises 22023); an empty or null list returns nothing.
-- The effective-date columns (0801) are read through to_jsonb, so the function also works on a database without them (null dates).
-- SECURITY INVOKER with an empty search_path and schema-qualified names, tenant key asserted first, service_role only (D-56).
-- Idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_document_versions(p_tenant_key text, p_document_ids uuid[])
RETURNS TABLE (
  document_id uuid,
  lineage_id uuid,
  version integer,
  is_current boolean,
  effective_from date,
  effective_to date
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_ids IS NULL OR pg_catalog.cardinality(p_document_ids) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_document_ids) > 500 THEN
    RAISE EXCEPTION 'rag_document_versions: at most 500 document ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT d.id, d.lineage_id, d.version, d.is_current,
         (pg_catalog.to_jsonb(d) ->> 'effective_from')::date,
         (pg_catalog.to_jsonb(d) ->> 'effective_to')::date
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.id = ANY (p_document_ids)
  ORDER BY d.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_document_versions(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_document_versions(text, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
