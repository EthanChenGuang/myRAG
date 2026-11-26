-- 0973: rag_monitor_cluster_shares, counts per cluster, language and channel of one tenant's assigned log rows (Phase 5.3, D-43).
-- Counts the tenant's rag_retrieval_log rows created at or after p_since that are assigned to a cluster of the tenant's current
-- cluster set (rows assigned in a superseded set are not counted). Language is the query language, und when null.
-- The tenant comes only from p_tenant_key, checked first by rag_assert_tenant_key; every join also filters on it. Counts only.
-- Without the Phase 5.1.1 log or the 0966 cluster tables the function returns no rows (to_regclass guard).
-- SECURITY INVOKER, empty search_path, service_role only (O-3). Idempotent, not folded (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_monitor_cluster_shares(p_tenant_key text, p_since timestamptz)
RETURNS TABLE (cluster_id text, language text, channel text, n bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_since IS NULL THEN
    RAISE EXCEPTION 'since is required' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL
     OR pg_catalog.to_regclass('public.rag_query_cluster_assignments') IS NULL
     OR pg_catalog.to_regclass('public.rag_query_cluster_sets') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE $sql$
    SELECT a.cluster_id, COALESCE(l.query_language, 'und') AS language, l.channel, pg_catalog.count(*)::bigint AS n
      FROM public.rag_query_cluster_assignments a
      JOIN public.rag_query_cluster_sets s
        ON s.id = a.set_id AND s.tenant_key = $1 AND s.status = 'current'
      JOIN public.rag_retrieval_log l
        ON l.id = a.log_id AND l.tenant_key = $1
     WHERE a.tenant_key = $1
       AND l.created_at >= $2
     GROUP BY a.cluster_id, COALESCE(l.query_language, 'und'), l.channel
     ORDER BY 1, 2, 3
  $sql$ USING p_tenant_key, p_since;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_cluster_shares(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_cluster_shares(text, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
