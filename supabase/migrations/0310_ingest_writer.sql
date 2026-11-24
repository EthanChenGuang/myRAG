-- 0310: the ingest writer as SQL functions (Phase 3, Pattern 2; D-06, D-09, D-10, D-11).
-- Every write to documents and document_chunks made by the unified pipeline goes through these functions: one transaction per call,
-- the same behaviour in the single-tenant and multi-tenant schemas, safe to retry. They are SECURITY DEFINER, check that the row they touch
-- belongs to p_tenant_key (raising tenant_mismatch otherwise, which is also what a missing id raises, so ids of other tenants are not
-- distinguishable from unknown ones), and are executable by service_role only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

-- Starts a version of an identity (tenant_key, source, source_key). Outcomes: created, resumed (a processing row of the same identity
-- and file hash already exists) and skipped_duplicate (a current document of this tenant already has the file hash; duplicate_of names it).
-- The new row is not current and is processing until rag_publish_document_version swaps it in. It carries the user-set external_url of the
-- previous version and no content_type or slug (documents_org_type_slug_ux is unique; the publish function moves them).
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
  p_profile_version integer
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

  IF p_file_sha256 IS NOT NULL THEN
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

-- The current, ready document of p_tenant_key with the same normalised content hash, other than p_document_id itself.
-- Nothing outside p_tenant_key is ever read.
CREATE OR REPLACE FUNCTION rag_find_content_duplicate(
  p_tenant_key text,
  p_content_hash text,
  p_document_id uuid
)
RETURNS TABLE (duplicate_of uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_document_id IS NOT NULL THEN
    PERFORM 1 FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
    END IF;
  END IF;
  IF p_content_hash IS NULL OR p_content_hash = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT d.id
  FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.content_hash = p_content_hash AND d.is_current AND d.status = 'ready'
    AND d.id IS DISTINCT FROM p_document_id
  ORDER BY d.created_at, d.id
  LIMIT 1;
END
$$;

-- Sets a whitelisted subset of document columns. A key that is present sets its column (an explicit null clears it); a key that is absent
-- leaves it alone; metadata is merged. Identity, version, currency and tenant columns are not settable; status may only move to
-- processing, quarantined, failed or deleted (ready is reached through rag_publish_document_version). The chunk columns that mirror a
-- changed field follow it.
CREATE OR REPLACE FUNCTION rag_set_document_fields(
  p_document_id uuid,
  p_tenant_key text,
  p_fields jsonb
)
RETURNS TABLE (document_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  field_name text;
  allowed text[] := ARRAY[
    'content_hash', 'language', 'doc_date', 'doc_type', 'doc_type_origin', 'parser_used', 'parser_version',
    'processing_profile_id', 'processing_profile_version', 'original_path', 'source_provider', 'source_file_id',
    'source_connection_id', 'status', 'metadata'
  ];
  doc documents%ROWTYPE;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'invalid_fields: p_fields must be a JSON object';
  END IF;
  FOR field_name IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (field_name = ANY (allowed)) THEN
      RAISE EXCEPTION 'invalid_field: %', field_name;
    END IF;
  END LOOP;
  IF p_fields ? 'status' AND (jsonb_typeof(p_fields -> 'status') <> 'string'
      OR (p_fields ->> 'status') NOT IN ('processing', 'quarantined', 'failed', 'deleted')) THEN
    RAISE EXCEPTION 'invalid_status: %', p_fields ->> 'status';
  END IF;
  IF p_fields ? 'metadata' AND jsonb_typeof(p_fields -> 'metadata') <> 'object' THEN
    RAISE EXCEPTION 'invalid_metadata: metadata must be a JSON object';
  END IF;

  UPDATE documents d SET
    content_hash = CASE WHEN p_fields ? 'content_hash' THEN p_fields ->> 'content_hash' ELSE d.content_hash END,
    language = CASE WHEN p_fields ? 'language' THEN p_fields ->> 'language' ELSE d.language END,
    doc_date = CASE WHEN p_fields ? 'doc_date' THEN (p_fields ->> 'doc_date')::date ELSE d.doc_date END,
    doc_type = CASE WHEN p_fields ? 'doc_type' THEN p_fields ->> 'doc_type' ELSE d.doc_type END,
    doc_type_origin = CASE WHEN p_fields ? 'doc_type_origin' THEN p_fields ->> 'doc_type_origin' ELSE d.doc_type_origin END,
    parser_used = CASE WHEN p_fields ? 'parser_used' THEN p_fields ->> 'parser_used' ELSE d.parser_used END,
    parser_version = CASE WHEN p_fields ? 'parser_version' THEN p_fields ->> 'parser_version' ELSE d.parser_version END,
    processing_profile_id = CASE WHEN p_fields ? 'processing_profile_id' THEN p_fields ->> 'processing_profile_id' ELSE d.processing_profile_id END,
    processing_profile_version = CASE WHEN p_fields ? 'processing_profile_version' THEN (p_fields ->> 'processing_profile_version')::integer ELSE d.processing_profile_version END,
    original_path = CASE WHEN p_fields ? 'original_path' THEN p_fields ->> 'original_path' ELSE d.original_path END,
    source_provider = CASE WHEN p_fields ? 'source_provider' THEN p_fields ->> 'source_provider' ELSE d.source_provider END,
    source_file_id = CASE WHEN p_fields ? 'source_file_id' THEN p_fields ->> 'source_file_id' ELSE d.source_file_id END,
    source_connection_id = CASE WHEN p_fields ? 'source_connection_id' THEN p_fields ->> 'source_connection_id' ELSE d.source_connection_id END,
    status = CASE WHEN p_fields ? 'status' THEN p_fields ->> 'status' ELSE d.status END,
    metadata = CASE WHEN p_fields ? 'metadata' THEN COALESCE(d.metadata, '{}'::jsonb) || (p_fields -> 'metadata') ELSE d.metadata END
  WHERE d.id = p_document_id;

  IF p_fields ?| ARRAY['doc_type', 'doc_date', 'language', 'parser_used', 'status'] THEN
    UPDATE document_chunks c SET
      doc_type = d.doc_type,
      doc_date = d.doc_date,
      language = d.language,
      parser_used = d.parser_used,
      status = d.status,
      metadata = COALESCE(c.metadata, '{}'::jsonb)
        || jsonb_build_object('doc_type', d.doc_type, 'language', d.language, 'parser_used', d.parser_used)
    FROM documents d
    WHERE d.id = p_document_id AND c.document_id = d.id;
  END IF;

  RETURN QUERY SELECT d.id, d.status FROM documents d WHERE d.id = p_document_id;
END
$$;

-- Replaces processing_status and processing_state (the resumable stage record) on the row.
CREATE OR REPLACE FUNCTION rag_save_ingest_state(
  p_document_id uuid,
  p_tenant_key text,
  p_processing_status text,
  p_state jsonb
)
RETURNS TABLE (document_id uuid, processing_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  PERFORM 1 FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_state IS NOT NULL AND jsonb_typeof(p_state) <> 'object' THEN
    RAISE EXCEPTION 'invalid_state: p_state must be a JSON object';
  END IF;
  UPDATE documents d
  SET processing_status = p_processing_status, processing_state = COALESCE(p_state, '{}'::jsonb)
  WHERE d.id = p_document_id;
  RETURN QUERY SELECT d.id, d.processing_status FROM documents d WHERE d.id = p_document_id;
END
$$;

-- The row a stage runner needs to resume a document. Another tenant's id, and an unknown id, return no row.
CREATE OR REPLACE FUNCTION rag_get_ingest_document(
  p_document_id uuid,
  p_tenant_key text
)
RETURNS TABLE (
  status text,
  version integer,
  processing_status text,
  processing_state jsonb,
  filename text,
  doc_type text,
  parser_used text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.status, d.version, d.processing_status, d.processing_state, d.filename, d.doc_type, d.parser_used, d.created_at
  FROM documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$$;

-- Marks a version that did not publish as failed. A current version is never taken down by a failure path.
CREATE OR REPLACE FUNCTION rag_mark_document_failed(
  p_document_id uuid,
  p_tenant_key text,
  p_reason text
)
RETURNS TABLE (document_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  doc documents%ROWTYPE;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.is_current THEN
    RAISE EXCEPTION 'document_is_current' USING DETAIL = 'a current version is not marked failed';
  END IF;
  UPDATE documents d
  SET status = 'failed',
      processing_status = 'failed',
      processing_state = COALESCE(d.processing_state, '{}'::jsonb) || jsonb_build_object('failure_reason', left(COALESCE(p_reason, ''), 1000))
  WHERE d.id = p_document_id;
  UPDATE document_chunks c SET status = 'failed' WHERE c.document_id = p_document_id;
  RETURN QUERY SELECT p_document_id, 'failed'::text;
END
$$;

-- Upserts chunks of a version. A chunk id is a UUID taken from the first 16 bytes of sha256(document_id || ':' || chunk_index), so a retried
-- call lands on the same rows. The denormalised columns come from the document and follow its status and currency; the promoted columns
-- are mirrored into metadata next to the caller's keys. p_embeddings is an object keyed by profile id whose arrays line up with p_chunks;
-- only the legacy profile (the embedding column, 1536 dimensions) is supported here, any other id raises embedding_profile_unsupported
-- (the profile tables arrive with the profile write path). A rewrite replaces the row, so a chunk resent without a vector has none. On
-- p_final the chunks of this document at chunk_index >= p_total are removed.
CREATE OR REPLACE FUNCTION rag_write_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_chunks jsonb,
  p_embeddings jsonb,
  p_final boolean,
  p_total integer
)
RETURNS TABLE (chunks_written integer, chunks_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc documents%ROWTYPE;
  profile_id text;
  chunk_count integer;
  legacy_vectors jsonb;
  written integer := 0;
  deleted integer := 0;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_chunks must be a JSON array';
  END IF;
  chunk_count := jsonb_array_length(p_chunks);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_chunks) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every chunk needs a string content and a numeric chunk_index when it has one';
  END IF;
  IF (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)) <> chunk_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct';
  END IF;
  IF p_final AND (p_total IS NULL OR p_total < 0) THEN
    RAISE EXCEPTION 'invalid_total: p_total is required with p_final';
  END IF;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_embeddings: p_embeddings must be a JSON object keyed by profile id';
  END IF;
  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_id IN SELECT jsonb_object_keys(p_embeddings) LOOP
      IF profile_id <> legacy_profile THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_id;
      END IF;
    END LOOP;
    legacy_vectors := p_embeddings -> legacy_profile;
    IF legacy_vectors IS NOT NULL AND (jsonb_typeof(legacy_vectors) <> 'array' OR jsonb_array_length(legacy_vectors) <> chunk_count) THEN
      RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', chunk_count;
    END IF;
  END IF;

  WITH prepared AS (
    SELECT
      e.value AS spec,
      (e.ord - 1)::integer AS position,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN legacy_vectors IS NOT NULL AND jsonb_typeof(legacy_vectors -> (e.ord - 1)::integer) = 'array'
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::vector END AS embedding,
      CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END AS section_path,
      COALESCE(e.value ->> 'chunk_kind', 'text') AS chunk_kind,
      COALESCE((e.value ->> 'embedding_text_version')::integer, 0) AS embedding_text_version,
      (e.value ->> 'page_start')::integer AS page_start,
      (e.value ->> 'page_end')::integer AS page_end,
      e.value ->> 'content_hash' AS content_hash,
      e.value ->> 'lexical_text' AS lexical_text
    FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    p.spec ->> 'content',
    p.embedding,
    p.chunk_index,
    (CASE WHEN jsonb_typeof(p.spec -> 'metadata') = 'object' THEN p.spec -> 'metadata' ELSE '{}'::jsonb END)
      || jsonb_build_object(
        'chunk_index', p.chunk_index,
        'section_path', to_jsonb(p.section_path),
        'doc_type', doc.doc_type,
        'language', doc.language,
        'content_hash', p.content_hash,
        'chunk_kind', p.chunk_kind,
        'parser_used', doc.parser_used,
        'embedding_text_version', p.embedding_text_version)
      || CASE WHEN p.embedding IS NOT NULL
              THEN jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536) ELSE '{}'::jsonb END
      || jsonb_strip_nulls(jsonb_build_object('doc_date', doc.doc_date, 'source', doc.source, 'page_start', p.page_start, 'page_end', p.page_end)),
    doc.organization_id,
    doc.tenant_key,
    doc.version,
    doc.is_current,
    doc.status,
    doc.doc_type,
    doc.doc_date,
    doc.language,
    doc.source,
    p.page_start,
    p.page_end,
    p.section_path,
    p.content_hash,
    p.chunk_kind,
    doc.parser_used,
    p.embedding_text_version,
    p.lexical_text
  FROM prepared p
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    chunk_index = EXCLUDED.chunk_index,
    metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id,
    tenant_key = EXCLUDED.tenant_key,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    status = EXCLUDED.status,
    doc_type = EXCLUDED.doc_type,
    doc_date = EXCLUDED.doc_date,
    language = EXCLUDED.language,
    source = EXCLUDED.source,
    page_start = EXCLUDED.page_start,
    page_end = EXCLUDED.page_end,
    section_path = EXCLUDED.section_path,
    content_hash = EXCLUDED.content_hash,
    chunk_kind = EXCLUDED.chunk_kind,
    parser_used = EXCLUDED.parser_used,
    embedding_text_version = EXCLUDED.embedding_text_version,
    lexical_text = EXCLUDED.lexical_text
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS written = ROW_COUNT;

  IF p_final THEN
    DELETE FROM document_chunks c WHERE c.document_id = p_document_id AND c.chunk_index >= p_total;
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT written, deleted;
END
$$;

-- The version swap (D-11), one transaction. A quarantined version is neither promoted nor allowed to demote the current one (a release
-- publishes it later); a version that is already current and ready is left as it is. Order matters: the previous current row is demoted
-- first because documents_lineage_identity_ux allows one current row per identity, its content_type and slug move to the new row because
-- documents_org_type_slug_ux is unique, and its legacy vectors are set to NULL so superseded rows stop occupying HNSW candidates. The old
-- documents and chunks keep their text, so a stored citation still resolves.
CREATE OR REPLACE FUNCTION rag_publish_document_version(
  p_document_id uuid,
  p_tenant_key text
)
RETURNS TABLE (outcome text, document_id uuid, version integer, superseded_document_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  doc documents%ROWTYPE;
  previous documents%ROWTYPE;
  has_slug boolean;
  moved_type text;
  moved_slug text;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status = 'quarantined' THEN
    RETURN QUERY SELECT 'quarantined'::text, doc.id, doc.version, NULL::uuid;
    RETURN;
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_publishable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF doc.is_current AND doc.status = 'ready' THEN
    RETURN QUERY SELECT 'already_current'::text, doc.id, doc.version, NULL::uuid;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(doc.tenant_key || '|' || doc.source || '|' || doc.source_key, 0));

  has_slug := (
    SELECT count(*) = 2 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname IN ('content_type', 'slug') AND NOT attisdropped
  );

  SELECT * INTO previous FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = doc.source AND d.source_key = doc.source_key AND d.is_current AND d.id <> doc.id
  FOR UPDATE;
  IF FOUND THEN
    IF has_slug THEN
      EXECUTE 'SELECT content_type, slug FROM documents WHERE id = $1' INTO moved_type, moved_slug USING previous.id;
    END IF;
    UPDATE documents d SET is_current = false, superseded_by = doc.id WHERE d.id = previous.id;
    IF has_slug THEN
      EXECUTE 'UPDATE documents SET content_type = NULL, slug = NULL WHERE id = $1' USING previous.id;
    END IF;
    UPDATE document_chunks c SET is_current = false, embedding = NULL WHERE c.document_id = previous.id;
  END IF;

  UPDATE documents d SET is_current = true, status = 'ready' WHERE d.id = doc.id;
  IF previous.id IS NOT NULL AND has_slug AND (moved_type IS NOT NULL OR moved_slug IS NOT NULL) THEN
    EXECUTE 'UPDATE documents SET content_type = $2, slug = $3 WHERE id = $1' USING doc.id, moved_type, moved_slug;
  END IF;
  UPDATE document_chunks c SET is_current = true, status = 'ready' WHERE c.document_id = doc.id;

  RETURN QUERY SELECT 'published'::text, doc.id, doc.version, previous.id;
END
$$;

REVOKE ALL ON FUNCTION rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_publish_document_version(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_publish_document_version(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_find_content_duplicate(text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_set_document_fields(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_save_ingest_state(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_get_ingest_document(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_mark_document_failed(uuid, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_find_content_duplicate(text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_set_document_fields(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_save_ingest_state(uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_get_ingest_document(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_mark_document_failed(uuid, text, text) TO service_role;

COMMIT;
