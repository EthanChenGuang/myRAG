-- 0926 (multi-tenant): restrictive client read policies for access groups (Phase 4.3, SEC-12; D-04, D-15, A-01, A-02).
-- rag_access_groups_restrict on documents, document_chunks and document_parents, TO anon, authenticated: a row stays readable when
-- enforcement is off, when its access_groups overlap the caller's keys, or when the caller is an owner or admin of the row's own
-- organization (public.is_org_admin(organization_id), which reads auth.uid() only and is already executable by anon). An admin of another
-- organization gets no bypass here; a personal document (organization_id NULL) has no admin bypass, its owner reads it through the
-- 'all' or 'u:' key. Each table carries organization_id itself. Restrictive policies are ANDed with the existing permissive ones, so they
-- only narrow access; no existing policy changes. Idempotent: DROP POLICY IF EXISTS then CREATE POLICY.

BEGIN;

DROP POLICY IF EXISTS rag_access_groups_restrict ON public.documents;
CREATE POLICY rag_access_groups_restrict ON public.documents
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (
    (SELECT public.rag_access_enforced()) IS NOT TRUE
    OR access_groups OPERATOR(pg_catalog.&&) (SELECT public.rag_caller_access_keys())
    OR (organization_id IS NOT NULL AND public.is_org_admin(organization_id))
  );

DROP POLICY IF EXISTS rag_access_groups_restrict ON public.document_chunks;
CREATE POLICY rag_access_groups_restrict ON public.document_chunks
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (
    (SELECT public.rag_access_enforced()) IS NOT TRUE
    OR access_groups OPERATOR(pg_catalog.&&) (SELECT public.rag_caller_access_keys())
    OR (organization_id IS NOT NULL AND public.is_org_admin(organization_id))
  );

DROP POLICY IF EXISTS rag_access_groups_restrict ON public.document_parents;
CREATE POLICY rag_access_groups_restrict ON public.document_parents
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (
    (SELECT public.rag_access_enforced()) IS NOT TRUE
    OR access_groups OPERATOR(pg_catalog.&&) (SELECT public.rag_caller_access_keys())
    OR (organization_id IS NOT NULL AND public.is_org_admin(organization_id))
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
