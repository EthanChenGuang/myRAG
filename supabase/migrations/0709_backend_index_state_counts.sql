-- 0709: Phase 7 index-state counts for the admin index-compatibility warning (D-16, RET-09).
-- rag_backend_index_state_counts returns one row per (target, profile, state) with the number of tenants in that state. It returns
-- counts only, never a tenant key, a count of chunks or an error text, so the admin route can show readiness without tenant data.
-- SECURITY INVOKER, search_path '', service role only. Idempotent: safe to run more than once.

BEGIN;

DROP FUNCTION IF EXISTS public.rag_backend_index_state_counts();

CREATE FUNCTION public.rag_backend_index_state_counts()
RETURNS TABLE (target text, profile_id text, state text, tenants bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT s.target, s.profile_id, s.state, pg_catalog.count(*)
    FROM public.rag_backend_index_state s
   GROUP BY s.target, s.profile_id, s.state
   ORDER BY s.target, s.profile_id, s.state;
$fn$;

REVOKE ALL ON FUNCTION public.rag_backend_index_state_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_backend_index_state_counts() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
