-- 0937: client roles cannot change the Phase 3.2 columns through the tables (Phase 3.2 verification UF-2, SEC-09).
-- 0801 added language, fingerprint, hidden-text, scope, effective-date and approval columns to documents and document_chunks, but the 0320
-- guard lists only the Phase 3 ingest-state columns. With the table UPDATE policies a signed-in owner (single-tenant) or organization member
-- (multi-tenant) could PATCH scopes past the vocabulary check, set admin-only effective dates, forge the approval audit, or hide a document from
-- a rescan or rebuild by rewriting hidden_text_check or ingest_fingerprint. This file attaches the 0320 guard function to those columns under
-- its own trigger name, as 1001 does for the Phase 3.3 columns: a role other than service_role, postgres or supabase_admin that changes one of
-- them gets 42501. The writers, approval and admin paths run as service_role or as the owner of a SECURITY DEFINER function and pass.
-- No new function, so 0410 is unchanged. Idempotent (DROP TRIGGER IF EXISTS, then CREATE TRIGGER); both deployment modes; not folded into the
-- setup files.

BEGIN;

DO $phase32_guard_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_guard_ingest_state()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'ingest_fingerprint' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0937: apply 0320 and 0801 first' USING ERRCODE = '55000';
  END IF;
END
$phase32_guard_precheck$;

DROP TRIGGER IF EXISTS rag_guard_phase32_columns ON public.documents;
CREATE TRIGGER rag_guard_phase32_columns
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.rag_guard_ingest_state(
    'languages', 'ingest_fingerprint', 'hidden_text_check', 'scopes', 'effective_from', 'effective_to',
    'effective_dates_origin', 'effective_dates_confidence', 'approved_by', 'approved_at'
  );

DROP TRIGGER IF EXISTS rag_guard_phase32_columns ON public.document_chunks;
CREATE TRIGGER rag_guard_phase32_columns
  BEFORE UPDATE ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_guard_ingest_state(
    'language_confidence', 'scopes', 'effective_from', 'effective_to', 'approved_by'
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
