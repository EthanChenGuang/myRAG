-- UF-1 production apply (do NOT run from CI). Run in the Supabase SQL editor of the production project as postgres.
-- Same content as supabase/migrations/0991_block_direct_document_insert.sql; idempotent, safe to re-run, works in both deployment modes.
-- Before: confirm the app writes documents/document_chunks only with SUPABASE_SERVICE_ROLE_KEY (verified in code on fix/uf1-direct-insert).

-- 0) Pre-check (optional): which INSERT policies exist today.
SELECT tablename, policyname, cmd, roles FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('documents', 'document_chunks') AND cmd IN ('INSERT', 'ALL')
 ORDER BY 1, 2;

-- 1) Apply.
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

-- 2) Checks after apply.
-- 2a) Both triggers exist and are enabled (expect 2 rows, tgenabled = 'O').
SELECT c.relname AS table_name, t.tgname, t.tgenabled
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE c.relnamespace = 'public'::regnamespace AND t.tgname = 'rag_guard_direct_insert' AND NOT t.tgisinternal
 ORDER BY 1;

-- 2b) The trigger function: invoker, search_path '', not executable by anon/authenticated (expect secdef false, anon false, authenticated false).
SELECT p.oid::regprocedure AS fn, p.prosecdef AS secdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rag_guard_direct_insert';

-- 2c) No INSERT or ALL policy left on the two tables (expect 0 rows).
SELECT tablename, policyname, cmd, roles FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('documents', 'document_chunks') AND cmd IN ('INSERT', 'ALL');

-- 2d) RLS still enabled on both tables (expect relrowsecurity = true twice).
SELECT relname, relrowsecurity FROM pg_class
 WHERE relnamespace = 'public'::regnamespace AND relname IN ('documents', 'document_chunks');

-- 2e) Behaviour probe, rolled back: an authenticated insert must fail with 42501 (expect ERROR ... cannot be inserted by role authenticated).
BEGIN;
SET LOCAL ROLE authenticated;
INSERT INTO public.documents (id, filename, content) VALUES (gen_random_uuid(), 'uf1-probe.md', 'probe');
ROLLBACK;
