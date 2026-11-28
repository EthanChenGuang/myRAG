-- 0981: rag_tenant_doc_types — the distinct doc types of a tenant's current, ready documents, the doc-type vocabulary of the
-- sub-question filters (Phase 6.2 D-02, D-06, D-07, QRY-10). status = 'ready' already leaves quarantined, pending_review,
-- processing and failed versions out. The tenant comes only from p_tenant_key, checked first by rag_assert_tenant_key
-- (Phase 4 D-04): a malformed or wrong-mode key raises 22023. SECURITY INVOKER with an empty search_path and schema-qualified
-- names, after the 0601 pattern; service_role only. Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_tenant_doc_types(p_tenant_key text)
RETURNS TABLE (
  doc_type text,
  docs bigint
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  RETURN QUERY
  SELECT d.doc_type AS doc_type, pg_catalog.count(*) AS docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.is_current
    AND d.status = 'ready'
    AND d.doc_type IS NOT NULL
  GROUP BY d.doc_type
  ORDER BY pg_catalog.count(*) DESC, d.doc_type;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_tenant_doc_types(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_tenant_doc_types(text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
