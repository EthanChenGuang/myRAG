-- 0923 (single-tenant): restrictive client read policies for access groups (Phase 4.3, SEC-12; D-15, A-01, A-02).
-- The single-tenant read policies on documents, document_chunks and document_parents have no TO clause, so anon reads them; the restrictive
-- policy rag_access_groups_restrict is therefore TO anon, authenticated. A row stays readable when enforcement is off, when its access_groups
-- overlap the caller's keys, or when the caller is an admin (admin_users) of the one tenant. Restrictive policies are ANDed with the existing
-- permissive ones, so they only narrow access; no existing policy changes. rag_caller_is_access_admin() is STABLE SECURITY DEFINER (anon
-- cannot read admin_users), takes no argument, reads auth.uid() only and is false for anon; granted to anon and authenticated (allow-listed).
-- Idempotent: CREATE OR REPLACE, DROP POLICY IF EXISTS then CREATE POLICY.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_caller_is_access_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = auth.uid())
$fn$;

REVOKE ALL ON FUNCTION public.rag_caller_is_access_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_caller_is_access_admin() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_caller_is_access_admin() TO anon, authenticated;

DROP POLICY IF EXISTS rag_access_groups_restrict ON public.documents;
CREATE POLICY rag_access_groups_restrict ON public.documents
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (
    (SELECT public.rag_access_enforced()) IS NOT TRUE
    OR access_groups OPERATOR(pg_catalog.&&) (SELECT public.rag_caller_access_keys())
    OR (SELECT public.rag_caller_is_access_admin())
  );

DROP POLICY IF EXISTS rag_access_groups_restrict ON public.document_chunks;
CREATE POLICY rag_access_groups_restrict ON public.document_chunks
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (
    (SELECT public.rag_access_enforced()) IS NOT TRUE
    OR access_groups OPERATOR(pg_catalog.&&) (SELECT public.rag_caller_access_keys())
    OR (SELECT public.rag_caller_is_access_admin())
  );

DROP POLICY IF EXISTS rag_access_groups_restrict ON public.document_parents;
CREATE POLICY rag_access_groups_restrict ON public.document_parents
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (
    (SELECT public.rag_access_enforced()) IS NOT TRUE
    OR access_groups OPERATOR(pg_catalog.&&) (SELECT public.rag_caller_access_keys())
    OR (SELECT public.rag_caller_is_access_admin())
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
