-- Phase 3.2 plan 39 (D-35, SEC-08): the link check skips targets an admin reviewed on an earlier version of the same document.
-- rag_release_quarantine_reasons (0804) stores the distinct targets of a released untrusted_link reason as
-- metadata.quarantine.released_targets. This function returns, for one version, the union of those targets over the earlier released
-- versions of its lineage in its own tenant. It reads nothing of any other lineage or tenant, so a release never widens what another
-- document may link to, and it never touches RAG_OUTPUT_LINK_ALLOWLIST.
-- SECURITY INVOKER (service_role reads documents directly); service_role only; idempotent.

CREATE OR REPLACE FUNCTION public.rag_released_link_targets(p_document_id uuid, p_tenant_key text)
RETURNS TABLE (target text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT DISTINCT t.value
  FROM public.documents d
  JOIN public.documents p
    ON p.lineage_id = d.lineage_id
   AND p.tenant_key = d.tenant_key
   AND p.version < d.version
   AND p.id <> d.id
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
    CASE WHEN pg_catalog.jsonb_typeof(p.metadata #> '{quarantine,released_targets}') = 'array'
         THEN p.metadata #> '{quarantine,released_targets}' ELSE '[]'::jsonb END
  ) AS t(value)
  WHERE d.id = p_document_id
    AND d.tenant_key = p_tenant_key
    AND d.lineage_id IS NOT NULL
    AND (p.metadata #>> '{quarantine,released_at}') IS NOT NULL
  ORDER BY t.value;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_released_link_targets(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_released_link_targets(uuid, text) TO service_role;
