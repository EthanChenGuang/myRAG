-- 0972: rag_monitor_alert_evidence, sample trace ids and new retrieval config hashes for one monitor alert (Phase 5.3, D-26, D-27).
-- Stub that claims the number; the body follows in the same plan (05.3-27).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_monitor_alert_evidence(
  p_tenant_key text, p_language text, p_from timestamptz, p_to timestamptz, p_match jsonb, p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN pg_catalog.jsonb_build_object('sample_trace_ids', '[]'::jsonb, 'config_hash_firsts', '[]'::jsonb);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_alert_evidence(text, text, timestamptz, timestamptz, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_alert_evidence(text, text, timestamptz, timestamptz, jsonb, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
