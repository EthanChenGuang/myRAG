-- CR-01: the tenant search functions are SECURITY DEFINER and trust the tenant ids they are given.
-- After this patch only the service role can call them; the application searches on the admin client.
-- For databases created from an earlier multi-tenant-setup.sql. Idempotent: safe to run more than once.
-- Run in the Supabase SQL editor as the postgres role AFTER the Phase 2 application is deployed and live:
-- the previous application version searched with the anon/user client and stops finding documents once these revokes apply.
-- To roll the application back, re-grant EXECUTE on these four functions to anon and authenticated first (this reopens the hole).

BEGIN;

REVOKE EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION match_document_chunks_by_org(uuid, vector, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_document_chunks_by_org(uuid, vector, integer, double precision) TO service_role;
REVOKE EXECUTE ON FUNCTION get_documents_by_type_slug(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_documents_by_type_slug(uuid, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION get_documents_by_type_slug_workspace(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_documents_by_type_slug_workspace(uuid, uuid, text, text) TO service_role;

COMMIT;
