-- 0320: authenticated users cannot change ingest state through the tables (Phase 3 gap W1, SEC-01).
-- The table UPDATE policies (single-tenant "Owners and admins update documents/chunks", multi-tenant "Users can update documents") decide which rows a
-- user may write, not which columns. An unfiltered PostgREST PATCH skips the SELECT policy of 0316, so an uploader could set status = 'ready' and
-- is_current = true on their own quarantined document and its chunks (single-tenant), or an organization member could flip the document row
-- (multi-tenant), which releases the document without the admin release (rag_release_quarantine). Version, lineage and supersession columns have the same problem.
-- A column-level REVOKE is fragile next to the table-level grants Supabase gives the API roles, so the guard is a BEFORE UPDATE trigger: it raises 42501
-- when a role other than service_role, postgres or supabase_admin changes one of the listed columns. current_user is the role that runs the statement:
-- the SECURITY DEFINER functions (release, soft delete, writer, activation) run as their owner and pass; PostgREST requests run as authenticated and do not.
-- Columns are compared through to_jsonb, so a column that a later migration adds (needs_review, provisional, parse_cache_id) is guarded from the day it exists
-- and a column that does not exist yet is not an error. The service role returns before any comparison, so bulk writes of the pipeline pay nothing.
-- documents.tenant_key is a generated column (it follows user_id and organization_id) and is not in the list: a BEFORE trigger sees it unset.
-- Writing a guarded column to the value it already has is allowed; filename, metadata and the other content columns stay editable by the owner.
-- Idempotent: CREATE OR REPLACE the function, DROP TRIGGER IF EXISTS then CREATE TRIGGER, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION rag_guard_ingest_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  col text;
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  old_row := pg_catalog.to_jsonb(OLD);
  new_row := pg_catalog.to_jsonb(NEW);
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF old_row -> col IS DISTINCT FROM new_row -> col THEN
      RAISE EXCEPTION 'ingest state column % of %.% cannot be changed by role %', col, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- Trigger functions run without an EXECUTE check on the writing role; nothing but the triggers should be able to name this one.
REVOKE ALL ON FUNCTION rag_guard_ingest_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_guard_ingest_state() TO service_role;

DROP TRIGGER IF EXISTS rag_guard_ingest_state ON documents;
CREATE TRIGGER rag_guard_ingest_state
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION rag_guard_ingest_state(
    'status', 'is_current', 'version', 'lineage_id', 'superseded_by', 'source', 'source_key',
    'processing_status', 'processing_state', 'doc_type', 'doc_type_origin', 'content_hash', 'file_sha256', 'original_path',
    'parser_used', 'parser_version', 'processing_profile_id', 'processing_profile_version',
    'needs_review', 'needs_review_reason', 'provisional', 'parse_cache_id'
  );

DROP TRIGGER IF EXISTS rag_guard_ingest_state ON document_chunks;
CREATE TRIGGER rag_guard_ingest_state
  BEFORE UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION rag_guard_ingest_state(
    'status', 'is_current', 'version', 'tenant_key', 'document_id', 'provisional', 'doc_type', 'doc_date', 'language', 'source',
    'chunk_kind', 'content_hash', 'parser_used', 'embedding_text_version'
  );

COMMIT;
