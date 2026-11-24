-- 0409: Close anon/authenticated EXECUTE on SECURITY DEFINER tenant search RPCs (03-48 follow-up, D-08).
-- CREATE OR REPLACE in 0306 left prior grants on live DBs; the application calls these on the service-role client only.
-- Idempotent: safe to run more than once. Matches patches/2026-11-search-rpc-revoke-multi-tenant.sql.
-- Each function is guarded with to_regprocedure: the multi-tenant-only workspace and organisation search functions do not exist on single-tenant databases.

BEGIN;

DO $search_rpc_revoke$
BEGIN
  IF to_regprocedure('public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.match_document_chunks_by_org(uuid, vector, integer, double precision)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.match_document_chunks_by_org(uuid, vector, integer, double precision) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.match_document_chunks_by_org(uuid, vector, integer, double precision) TO service_role;
  END IF;
  IF to_regprocedure('public.get_documents_by_type_slug(uuid, text, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.get_documents_by_type_slug(uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_documents_by_type_slug(uuid, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.get_documents_by_type_slug_workspace(uuid, uuid, text, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.get_documents_by_type_slug_workspace(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_documents_by_type_slug_workspace(uuid, uuid, text, text) TO service_role;
  END IF;
END
$search_rpc_revoke$;

NOTIFY pgrst, 'reload schema';

COMMIT;
