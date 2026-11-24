-- 0409: Close anon/authenticated EXECUTE on SECURITY DEFINER tenant search RPCs (03-48 follow-up, D-08).
-- CREATE OR REPLACE in 0306 left prior grants on live DBs; the application calls these on the service-role client only.
-- Idempotent: safe to run more than once. Matches patches/2026-11-search-rpc-revoke-multi-tenant.sql.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION match_document_chunks_by_org(uuid, vector, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_document_chunks_by_org(uuid, vector, integer, double precision) TO service_role;
REVOKE EXECUTE ON FUNCTION get_documents_by_type_slug(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_documents_by_type_slug(uuid, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION get_documents_by_type_slug_workspace(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_documents_by_type_slug_workspace(uuid, uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;