-- 0317: change the document type of an existing document as a new version (Phase 3, D-18, DATA-10).
-- An admin type change re-runs the ingest pipeline on the same identity (tenant_key, source, source_key) with the new type. The file bytes did not
-- change, so the file-hash skip of rag_begin_document_version (D-10) would turn that run into skipped_duplicate. This file adds a flag,
-- p_force_new_version (default false), that the type-change path alone sets: it skips the file-hash duplicate check, and it resumes a processing
-- row only when that row already carries the requested type. Every other caller omits the flag and keeps D-10 as before.
-- Adding a parameter makes a new signature, so the 11-argument function of 0310 is dropped first: with both present, a call that names 11
-- arguments would match both and fail as ambiguous. Re-applying 0310 after this file brings the old overload back until this file runs again.
-- Two read functions for the type-change path, both SECURITY DEFINER and executable by service_role only:
--   rag_get_document_for_type_change: what the operation needs from the current version of one document (identity, type, parser, stored
--     original, origin fields, caller metadata, saved state). Another tenant's id and an unknown id return no row.
--   rag_admin_document_scope: the tenant of a document, for the tenants p_actor administers only (rag_admin_tenant_keys of 0316: the single
--     tenant; or the actor's personal tenant and the organizations where the actor is owner or admin). Any other document, and an unknown
--     id, return no row, so ids of other tenants are not probed. A p_actor outside admin_users raises not_admin.
-- Idempotent: DROP FUNCTION IF EXISTS, CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

DROP FUNCTION IF EXISTS rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer);

CREATE OR REPLACE FUNCTION rag_begin_document_version(
  p_tenant_key text,
  p_user_id uuid,
  p_org_id uuid,
  p_source text,
  p_source_key text,
  p_filename text,
  p_file_sha256 text,
  p_doc_type text,
  p_doc_type_origin text,
  p_profile_id text,
  p_profile_version integer,
  p_force_new_version boolean DEFAULT false
)
RETURNS TABLE (outcome text, document_id uuid, version integer, lineage_id uuid, duplicate_of uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  multi_tenant boolean;
  expected_key text;
  duplicate_id uuid;
  existing record;
  previous record;
  new_id uuid := gen_random_uuid();
  new_version integer;
  new_lineage uuid;
  carried jsonb := '{}'::jsonb;
  forced boolean := COALESCE(p_force_new_version, false);
BEGIN
  IF p_tenant_key IS NULL OR p_source_key IS NULL OR p_source_key = '' THEN
    RAISE EXCEPTION 'invalid_argument: p_tenant_key and p_source_key are required';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag') THEN
    RAISE EXCEPTION 'invalid_source: %', COALESCE(p_source, '(null)');
  END IF;

  -- user_id is NOT NULL in the multi-tenant schema and nullable in the single-tenant one.
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    expected_key := CASE WHEN p_org_id IS NOT NULL THEN 'o:' || p_org_id::text ELSE 'u:' || p_user_id::text END;
  ELSE
    expected_key := 's:default';
  END IF;
  IF p_tenant_key IS DISTINCT FROM expected_key THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'p_tenant_key is not the tenant key of the given user and organization';
  END IF;
  IF multi_tenant AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: p_user_id is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_key || '|' || p_source || '|' || p_source_key, 0));

  IF p_file_sha256 IS NOT NULL AND NOT forced THEN
    SELECT d.id INTO duplicate_id
    FROM documents d
    WHERE d.tenant_key = p_tenant_key AND d.file_sha256 = p_file_sha256 AND d.is_current AND d.status = 'ready'
    ORDER BY d.created_at, d.id
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT 'skipped_duplicate'::text, NULL::uuid, NULL::integer, NULL::uuid, duplicate_id;
      RETURN;
    END IF;
  END IF;

  SELECT d.id, d.version, d.lineage_id INTO existing
  FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
    AND d.status = 'processing' AND NOT d.is_current AND d.file_sha256 IS NOT DISTINCT FROM p_file_sha256
    AND (NOT forced OR d.doc_type = COALESCE(p_doc_type, 'general'))
  ORDER BY d.version DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'resumed'::text, existing.id, existing.version, existing.lineage_id, NULL::uuid;
    RETURN;
  END IF;

  SELECT d.lineage_id, d.metadata INTO previous
  FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
  ORDER BY d.is_current DESC, d.version DESC, d.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    new_lineage := previous.lineage_id;
    SELECT COALESCE(max(d.version), 0) + 1 INTO new_version FROM documents d WHERE d.lineage_id = new_lineage;
    IF previous.metadata ? 'external_url' THEN
      carried := jsonb_build_object('external_url', previous.metadata -> 'external_url');
    END IF;
  ELSE
    new_lineage := new_id;
    new_version := 1;
  END IF;

  INSERT INTO documents (
    id, lineage_id, version, is_current, status, source, source_key, filename, content, metadata,
    user_id, organization_id, file_sha256, doc_type, doc_type_origin, processing_profile_id, processing_profile_version
  ) VALUES (
    new_id, new_lineage, new_version, false, 'processing', p_source, p_source_key, COALESCE(NULLIF(p_filename, ''), p_source_key), '', carried,
    CASE WHEN multi_tenant THEN p_user_id END, CASE WHEN multi_tenant THEN p_org_id END, p_file_sha256,
    COALESCE(p_doc_type, 'general'), COALESCE(p_doc_type_origin, 'fallback'), p_profile_id, p_profile_version
  );

  RETURN QUERY SELECT 'created'::text, new_id, new_version, new_lineage, NULL::uuid;
END
$$;

-- The current version of one document of p_tenant_key as the type change needs it. The caller checks is_current and status itself.
CREATE OR REPLACE FUNCTION rag_get_document_for_type_change(
  p_document_id uuid,
  p_tenant_key text
)
RETURNS TABLE (
  lineage_id uuid,
  version integer,
  is_current boolean,
  status text,
  source text,
  source_key text,
  filename text,
  doc_type text,
  processing_profile_id text,
  parser_used text,
  parser_version text,
  original_path text,
  source_provider text,
  source_file_id text,
  source_connection_id text,
  metadata jsonb,
  processing_state jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.lineage_id, d.version, d.is_current, d.status, d.source, d.source_key, d.filename, d.doc_type, d.processing_profile_id,
         d.parser_used, d.parser_version, d.original_path, d.source_provider, d.source_file_id, d.source_connection_id,
         COALESCE(d.metadata, '{}'::jsonb), COALESCE(d.processing_state, '{}'::jsonb)
  FROM documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$$;

-- The tenant a document belongs to, for an admin who administers that tenant. user_id and organization_id are the row's own, so the
-- new version keeps its owner. No row for an unknown id or a tenant the actor does not administer.
CREATE OR REPLACE FUNCTION rag_admin_document_scope(
  p_document_id uuid,
  p_actor uuid
)
RETURNS TABLE (
  tenant_key text,
  user_id uuid,
  organization_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
BEGIN
  keys := rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  SELECT d.tenant_key, d.user_id, d.organization_id
  FROM documents d
  WHERE d.id = p_document_id AND d.tenant_key = ANY (keys);
END
$$;

REVOKE ALL ON FUNCTION rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_get_document_for_type_change(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_admin_document_scope(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION rag_get_document_for_type_change(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_admin_document_scope(uuid, uuid) TO service_role;

COMMIT;
