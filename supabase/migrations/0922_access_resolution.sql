-- 0922: access resolution helpers (Phase 4.3, D-09, D-10, A-02, A-03).
-- rag_access_enforced() returns the enforced flag of the single rag_access_group_settings row (0920), false when the row is missing. It is
-- STABLE SECURITY DEFINER (the settings table is service_role only) with an empty search_path. hybrid_search_chunks (0930) raises
-- access_scope_required when it is true and no access keys were sent. Executable by service_role only here; the RLS plan (04.3-06) grants it
-- to the client roles. Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_access_enforced()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT COALESCE((SELECT s.enforced FROM public.rag_access_group_settings s WHERE s.id), false)
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_enforced() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO service_role;

COMMIT;
