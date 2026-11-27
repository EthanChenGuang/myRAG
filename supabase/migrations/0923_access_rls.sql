-- 0923: access-group helpers for the restrictive client read policies (Phase 4.3, SEC-12; D-09, D-15, A-01, A-02).
-- rag_caller_access_keys() returns the access keys of the calling client: 'all' for everyone, plus 'u:<auth.uid()>' and 'g:<group id>' for
-- each rag_access_group_members row of a signed-in user. It takes no argument and reads identity only from auth.uid(), so a caller cannot
-- name another user. STABLE SECURITY DEFINER (rag_access_group_members is not readable by anon) with an empty search_path. The mode files
-- call it, rag_access_enforced() (0922) and the mode's admin check from sub-selects in policy rag_access_groups_restrict, so each is
-- evaluated once per statement. Both are granted to anon and authenticated here (allow-listed in tests/helpers/security-definer-allow-list.ts);
-- everything else stays service_role only. Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_caller_access_keys()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN ARRAY['all']::text[]
    ELSE ARRAY['all', 'u:' || auth.uid()::text]::text[] || COALESCE(
      (SELECT pg_catalog.array_agg('g:' || m.group_id::text ORDER BY m.group_id)
         FROM public.rag_access_group_members m
        WHERE m.user_id = auth.uid()),
      ARRAY[]::text[]
    )
  END
$fn$;

REVOKE ALL ON FUNCTION public.rag_caller_access_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_caller_access_keys() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_caller_access_keys() TO anon, authenticated;

REVOKE ALL ON FUNCTION public.rag_access_enforced() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO anon, authenticated;

COMMIT;
