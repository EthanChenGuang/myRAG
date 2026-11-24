-- 0412: server functions of the rechunk job (Phase 4, plan 04-32, D-21, CHK-04).
-- The job builds one chunking profile for the current ready documents of the profile's doc type from stored parse output. These functions are
-- its only door to the database besides rag_write_profile_chunks (0408), which writes the parents, children and vectors of one document under
-- that document's own tenant key. Here: the document selection, the build run (chunking_build_runs) with its cursor, and the documents that
-- cannot be built (chunking_build_gaps).
--   Selection: current, ready documents of the profile's doc type (optionally one tenant) that have no current chunk in the profile, in id order.
--              The same predicate serves a first build, a resume, and the repair of an active profile (nothing already complete is selected).
--   Status:    a run never moves an active or ready profile. A building profile becomes ready when the run finishes and no current ready document
--              of the type, in any tenant, is missing children. The pointer flip to active is the activation function's job, not this file's.
-- Refusals raise 'rechunk_refused: <reason>' and carry no row content. Server role only (SECURITY DEFINER, fixed search_path).
-- Idempotent: CREATE OR REPLACE with fixed signatures, then guarded REVOKE and GRANT.

BEGIN;

-- Current ready documents of the type that have no current chunk in the profile. Internal count used by the start and finish functions.
CREATE OR REPLACE FUNCTION rag_rechunk_missing(p_profile_id text, p_doc_type text, p_tenant_key text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM chunking_profiles p
  JOIN documents d ON d.doc_type = p.doc_type AND d.is_current AND d.status = 'ready'
  WHERE p.id = p_profile_id
    AND p.doc_type = p_doc_type
    AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
    AND NOT EXISTS (
      SELECT 1 FROM document_chunks c
      WHERE c.document_id = d.id AND c.chunking_profile_id = p.id AND c.is_current)
$$;

-- The documents a run still has to build, after the cursor, in id order. lineage_id and version locate the stored parse output.
CREATE OR REPLACE FUNCTION rag_rechunk_documents(p_profile_id text, p_doc_type text, p_tenant_key text, p_after uuid, p_limit integer)
RETURNS TABLE (
  document_id uuid,
  tenant_key text,
  lineage_id uuid,
  version integer,
  filename text,
  doc_type text,
  source text,
  template_row jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT d.id, d.tenant_key, d.lineage_id, d.version, d.filename, d.doc_type, d.source,
           jsonb_build_object(
             'invoice_number', d.invoice_number,
             'supplier_name', d.supplier_name,
             'supplier_tax_id', d.supplier_tax_id,
             'issue_date', d.issue_date::text,
             'gross_total', d.gross_total::text,
             'currency', d.currency)
    FROM chunking_profiles p
    JOIN documents d ON d.doc_type = p.doc_type AND d.is_current AND d.status = 'ready'
    WHERE p.id = p_profile_id
      AND p.doc_type = p_doc_type
      AND p.id <> 'legacy'
      AND p.status IN ('building', 'ready', 'active')
      AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
      AND (p_after IS NULL OR d.id > p_after)
      AND NOT EXISTS (
        SELECT 1 FROM document_chunks c
        WHERE c.document_id = d.id AND c.chunking_profile_id = p.id AND c.is_current)
    ORDER BY d.id
    LIMIT p_limit;
END
$$;

CREATE OR REPLACE FUNCTION rag_rechunk_get_run(p_run_id uuid)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  doc_type text,
  tenant_key text,
  cursor_document_id uuid,
  docs_total integer,
  docs_done integer,
  status text,
  profile_status text,
  child_tokens integer,
  parent_mode text,
  parent_tokens integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.profile_id, r.doc_type, r.tenant_key, r.cursor_document_id, r.docs_total, r.docs_done, r.status,
         p.status, p.child_tokens, p.parent_mode, p.parent_tokens
  FROM chunking_build_runs r
  JOIN chunking_profiles p ON p.id = r.profile_id AND p.doc_type = r.doc_type
  WHERE r.id = p_run_id
$$;

-- Opens a run. With p_resume_open the newest running run of the same profile and tenant scope is returned instead of a new one, so bounded
-- calls (an admin route inside its function limit) continue one run. The profile keeps its status: a run only reads and writes children.
CREATE OR REPLACE FUNCTION rag_rechunk_start_run(
  p_profile_id text,
  p_doc_type text DEFAULT NULL,
  p_tenant_key text DEFAULT NULL,
  p_resume_open boolean DEFAULT false
)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  doc_type text,
  tenant_key text,
  cursor_document_id uuid,
  docs_total integer,
  docs_done integer,
  status text,
  profile_status text,
  child_tokens integer,
  parent_mode text,
  parent_tokens integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  matches integer;
  chosen chunking_profiles%ROWTYPE;
  opened uuid;
BEGIN
  IF p_profile_id IS NULL OR btrim(p_profile_id) = '' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_required' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_is_legacy' USING ERRCODE = '55000';
  END IF;
  IF p_tenant_key IS NOT NULL
     AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO matches FROM chunking_profiles p WHERE p.id = p_profile_id AND (p_doc_type IS NULL OR p.doc_type = p_doc_type);
  IF matches = 0 THEN
    RAISE EXCEPTION 'rechunk_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF matches > 1 THEN
    RAISE EXCEPTION 'rechunk_refused: profile_ambiguous' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO chosen FROM chunking_profiles p WHERE p.id = p_profile_id AND (p_doc_type IS NULL OR p.doc_type = p_doc_type);
  IF chosen.status = 'retired' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_retired' USING ERRCODE = '55000';
  END IF;

  IF p_resume_open THEN
    SELECT r.id INTO opened
    FROM chunking_build_runs r
    WHERE r.profile_id = chosen.id AND r.doc_type = chosen.doc_type AND r.tenant_key IS NOT DISTINCT FROM p_tenant_key AND r.status = 'running'
    ORDER BY r.started_at DESC
    LIMIT 1;
  END IF;
  IF opened IS NULL THEN
    INSERT INTO chunking_build_runs (profile_id, doc_type, tenant_key, docs_total)
    VALUES (chosen.id, chosen.doc_type, p_tenant_key, rag_rechunk_missing(chosen.id, chosen.doc_type, p_tenant_key))
    RETURNING id INTO opened;
  END IF;
  RETURN QUERY SELECT * FROM rag_rechunk_get_run(opened);
END
$$;

-- Continues a run that was killed (running) or stopped by a failure (failed) from its cursor.
CREATE OR REPLACE FUNCTION rag_rechunk_resume_run(p_run_id uuid)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  doc_type text,
  tenant_key text,
  cursor_document_id uuid,
  docs_total integer,
  docs_done integer,
  status text,
  profile_status text,
  child_tokens integer,
  parent_mode text,
  parent_tokens integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  existing chunking_build_runs%ROWTYPE;
  profile_state text;
BEGIN
  SELECT * INTO existing FROM chunking_build_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status NOT IN ('running', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_resumable' USING ERRCODE = '55000';
  END IF;
  SELECT p.status INTO profile_state FROM chunking_profiles p WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type;
  IF profile_state = 'retired' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_retired' USING ERRCODE = '55000';
  END IF;
  UPDATE chunking_build_runs r SET status = 'running', updated_at = now() WHERE r.id = p_run_id;
  RETURN QUERY SELECT * FROM rag_rechunk_get_run(p_run_id);
END
$$;

-- Moves the cursor to the document just handled (built or recorded as a gap) and counts it.
CREATE OR REPLACE FUNCTION rag_rechunk_advance(p_run_id uuid, p_document_id uuid)
RETURNS TABLE (docs_done integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  handled integer;
BEGIN
  UPDATE chunking_build_runs r
  SET cursor_document_id = p_document_id, docs_done = r.docs_done + 1, updated_at = now()
  WHERE r.id = p_run_id AND r.status = 'running'
  RETURNING r.docs_done INTO handled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT handled;
END
$$;

-- Records a document the run could not build. The document must be of the run's doc type and tenant scope.
CREATE OR REPLACE FUNCTION rag_rechunk_record_gap(p_run_id uuid, p_document_id uuid, p_reason text, p_detail text DEFAULT NULL)
RETURNS TABLE (recorded integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  existing chunking_build_runs%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM chunking_build_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status <> 'running' THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('no_parse_output', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_gap' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM documents d
  WHERE d.id = p_document_id AND d.doc_type = existing.doc_type AND (existing.tenant_key IS NULL OR d.tenant_key = existing.tenant_key);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: document_out_of_scope' USING ERRCODE = '22023';
  END IF;
  INSERT INTO chunking_build_gaps (run_id, document_id, reason, detail)
  VALUES (p_run_id, p_document_id, p_reason, left(p_detail, 200))
  ON CONFLICT (run_id, document_id) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail, recorded_at = now();
  RETURN QUERY SELECT 1;
END
$$;

-- Ends a run. 'completed' becomes 'incomplete' while a document in the run's scope still lacks children; a building profile becomes ready only
-- when no current ready document of the type, in any tenant, lacks children. 'failed' only marks the run.
CREATE OR REPLACE FUNCTION rag_rechunk_finish_run(p_run_id uuid, p_status text DEFAULT 'completed')
RETURNS TABLE (
  status text,
  docs_missing integer,
  docs_missing_total integer,
  gaps integer,
  profile_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  existing chunking_build_runs%ROWTYPE;
  scope_missing integer;
  total_missing integer;
  final_status text;
  gap_count integer;
  profile_state text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO existing FROM chunking_build_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status <> 'running' THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;

  scope_missing := rag_rechunk_missing(existing.profile_id, existing.doc_type, existing.tenant_key);
  total_missing := rag_rechunk_missing(existing.profile_id, existing.doc_type, NULL);
  IF p_status = 'failed' THEN
    final_status := 'failed';
  ELSIF scope_missing = 0 THEN
    final_status := 'completed';
  ELSE
    final_status := 'incomplete';
  END IF;
  UPDATE chunking_build_runs r SET status = final_status, updated_at = now() WHERE r.id = p_run_id;

  IF final_status = 'completed' AND total_missing = 0 THEN
    UPDATE chunking_profiles p SET status = 'ready'
    WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type AND p.status = 'building';
  END IF;
  SELECT count(*)::integer INTO gap_count FROM chunking_build_gaps g WHERE g.run_id = p_run_id;
  SELECT p.status INTO profile_state FROM chunking_profiles p WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type;
  RETURN QUERY SELECT final_status, scope_missing, total_missing, gap_count, profile_state;
END
$$;

-- The documents a run recorded as gaps, with the tenant each belongs to.
CREATE OR REPLACE FUNCTION rag_rechunk_gaps(p_run_id uuid)
RETURNS TABLE (
  document_id uuid,
  tenant_key text,
  reason text,
  detail text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT g.document_id, d.tenant_key, g.reason, g.detail
  FROM chunking_build_gaps g
  JOIN documents d ON d.id = g.document_id
  WHERE g.run_id = p_run_id
  ORDER BY g.document_id
$$;

DO $rechunk_acl$
BEGIN
  IF to_regprocedure('public.rag_rechunk_missing(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_missing(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_missing(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_documents(text, text, text, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_documents(text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_documents(text, text, text, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_get_run(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_get_run(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_get_run(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_start_run(text, text, text, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_start_run(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_start_run(text, text, text, boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_resume_run(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_resume_run(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_resume_run(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_advance(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_advance(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_advance(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_record_gap(uuid, uuid, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_record_gap(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_record_gap(uuid, uuid, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_finish_run(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_finish_run(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_finish_run(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_gaps(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_gaps(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_gaps(uuid) TO service_role;
  END IF;
END
$rechunk_acl$;

COMMIT;
