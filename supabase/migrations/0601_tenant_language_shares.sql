-- 0601: rag_tenant_language_shares — knowledge-base language shares per tenant for query translation (Phase 6, D-23, XLG-01).
-- Counts the tenant's current, ready documents with a known language. The tenant comes only from p_tenant_key, checked first by
-- rag_assert_tenant_key (Phase 4 D-04). SECURITY INVOKER with an empty search_path; service_role only. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_tenant_language_shares(p_tenant_key text)
RETURNS TABLE (
  language text,
  share double precision,
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
  SELECT g.language,
         g.docs::double precision / pg_catalog.sum(g.docs) OVER ()::double precision AS share,
         g.docs
  FROM (
    SELECT d.language AS language, pg_catalog.count(*) AS docs
    FROM public.documents d
    WHERE d.tenant_key = p_tenant_key
      AND d.is_current
      AND d.status = 'ready'
      AND d.language IS NOT NULL
    GROUP BY d.language
  ) g
  ORDER BY g.docs DESC, g.language;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_tenant_language_shares(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_tenant_language_shares(text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
