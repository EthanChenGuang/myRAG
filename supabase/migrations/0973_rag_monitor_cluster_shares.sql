-- 0973: rag_monitor_cluster_shares, per-cluster counts of one tenant's assigned log rows (Phase 5.3, D-43).
-- Stub that claims the number; the body follows in the same plan (05.3-27).

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
  RETURN;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_cluster_shares(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_cluster_shares(text, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
