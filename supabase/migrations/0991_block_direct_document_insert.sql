-- 0991: client roles cannot INSERT into documents or document_chunks (security audit UF-1).
-- The single-tenant INSERT policies ("Authenticated users insert own documents", "Authenticated users insert chunks of own documents") and the
-- multi-tenant ones ("Users can create documents", "Users can create chunks") let a signed-in user, or any organization member, insert rows over
-- PostgREST. status defaults to 'ready' and is_current to true (0301, 0304), and 0320 only guards UPDATE, so such a row skipped the upload approval
-- hold, the uploader hold and the injection, hidden-text and link scans and was retrievable at once.
-- Every app writer (storeDocument in src/lib/supabase.ts, process-document, ai-to-rag, the unified ingest RPCs, scripts) writes with the service role,
-- so no client INSERT path is needed: the policies are dropped, and a BEFORE INSERT trigger refuses with 42501 any role other than service_role,
-- postgres or supabase_admin (the 0320 rule), so a policy that comes back later (an old patch file re-run) still lets nothing in.
-- SECURITY DEFINER writers run as their owner and pass. The trigger function is SECURITY INVOKER and callable by no client role.
-- Idempotent: CREATE OR REPLACE, DROP ... IF EXISTS then CREATE, REVOKE then GRANT. One file for both deployment modes.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_guard_direct_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'rows of %.% cannot be inserted by role %', TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
    USING ERRCODE = '42501';
END
$$;

REVOKE ALL ON FUNCTION public.rag_guard_direct_insert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_guard_direct_insert() TO service_role;

DROP TRIGGER IF EXISTS rag_guard_direct_insert ON public.documents;
CREATE TRIGGER rag_guard_direct_insert
  BEFORE INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.rag_guard_direct_insert();

DROP TRIGGER IF EXISTS rag_guard_direct_insert ON public.document_chunks;
CREATE TRIGGER rag_guard_direct_insert
  BEFORE INSERT ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_guard_direct_insert();

DROP POLICY IF EXISTS "Authenticated users insert own documents" ON public.documents;
DROP POLICY IF EXISTS "Authenticated users insert chunks of own documents" ON public.document_chunks;
DROP POLICY IF EXISTS "Users can create documents" ON public.documents;
DROP POLICY IF EXISTS "Users can create chunks" ON public.document_chunks;

COMMIT;
