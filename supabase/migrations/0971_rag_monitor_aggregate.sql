-- 0971: rag_monitor_aggregate and rag_monitor_days_to_aggregate (Phase 5.3, D-20, D-22, D-55, OBS-03). Stub: bodies follow.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_monitor_aggregate(p_day date)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  RETURN 0;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_aggregate(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_aggregate(date) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_monitor_days_to_aggregate(p_trailing integer DEFAULT 7)
RETURNS SETOF date
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  RETURN;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_monitor_days_to_aggregate(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_days_to_aggregate(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
