-- Phase 3.2 plan 40 (D-47, SEC-07, SEC-08): `npm run rag:rebuild -- rescan` re-runs the hidden-text or the link check on documents that
-- are already published. This function pages over the current, ready documents (optionally of one tenant) in id order and returns
-- what the rescan needs: the stored original's path, the recorded hidden_text_check, the recorded rescan state, whether an admin
-- released the version's own quarantine and for which reason kinds, and the link targets that release reviewed. It writes nothing.
-- Quarantined, pending and deleted versions are never returned, so a rescan never touches them.
-- A read-only store-free function: no purge hook is needed. SECURITY INVOKER (service_role reads documents directly); service_role
-- only; idempotent.

CREATE OR REPLACE FUNCTION public.rag_rescan_candidates(p_tenant_key text DEFAULT NULL, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  lineage_id uuid,
  version integer,
  filename text,
  original_path text,
  content text,
  hidden_text_check text,
  rescan jsonb,
  released boolean,
  released_kinds text[],
  released_targets text[]
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must be between 1 and 200' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;
  RETURN QUERY
  SELECT d.id, d.tenant_key, d.lineage_id, d.version, d.filename, d.original_path, d.content, d.hidden_text_check,
         CASE WHEN pg_catalog.jsonb_typeof(d.metadata -> 'security_rescan') = 'object' THEN d.metadata -> 'security_rescan' ELSE '{}'::jsonb END,
         (d.metadata #>> '{quarantine,released_at}') IS NOT NULL,
         CASE WHEN (d.metadata #>> '{quarantine,released_at}') IS NOT NULL
                   AND pg_catalog.jsonb_typeof(d.metadata #> '{quarantine,reasons}') = 'array'
              THEN ARRAY(
                SELECT DISTINCT r.value ->> 'kind'
                FROM pg_catalog.jsonb_array_elements(d.metadata #> '{quarantine,reasons}') AS r(value)
                WHERE pg_catalog.jsonb_typeof(r.value) = 'object' AND (r.value ->> 'kind') IS NOT NULL
                ORDER BY 1)
              ELSE '{}'::text[] END,
         CASE WHEN (d.metadata #>> '{quarantine,released_at}') IS NOT NULL
                   AND pg_catalog.jsonb_typeof(d.metadata #> '{quarantine,released_targets}') = 'array'
              THEN ARRAY(SELECT pg_catalog.jsonb_array_elements_text(d.metadata #> '{quarantine,released_targets}'))
              ELSE '{}'::text[] END
    FROM public.documents d
   WHERE d.is_current
     AND d.status = 'ready'
     AND d.tenant_key IS NOT NULL
     AND d.lineage_id IS NOT NULL
     AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
     AND (p_after IS NULL OR d.id > p_after)
   ORDER BY d.id
   LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_rescan_candidates(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_rescan_candidates(text, uuid, integer) TO service_role;
