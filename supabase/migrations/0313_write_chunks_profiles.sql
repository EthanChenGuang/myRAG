-- 0313: the ingest writer stores vectors for every embedding profile and records the ones that could not be written (Phase 3, D-35, D-39, F-9).
-- rag_write_chunks keeps its signature. p_embeddings is an object keyed by profile id; each value is the list of vectors that lines up with
-- p_chunks (a null entry means no vector for that chunk), or an object {"vectors": [...], "host": "<serving host>"}. The legacy profile still
-- fills document_chunks.embedding; every other profile of the registry upserts one chunk_embeddings row per chunk with the profile's model and
-- dims, the document's tenant_key and the host from the payload. A vector whose length differs from the profile's dims raises
-- embedding_profile_mismatch; an id that is not in the registry raises embedding_profile_unsupported. A rewrite that changes a chunk's text
-- drops that chunk's old vectors of the profiles that are not sent again, and a vector written for a chunk clears its recorded gap.
-- rag_publish_document_version also deletes the superseded version's chunk_embeddings rows (F-9); the chunk rows stay for citations.
-- rag_record_backfill_gap records chunks whose vector for a backfilling profile could not be written, against the run that will fill them;
-- rag_latest_backfill_runs names that run per profile. Both check the tenant. Server role only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

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
  profile_key text;
  profile_row embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
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
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM embedding_profiles p WHERE p.id = profile_key;
      IF NOT FOUND OR (profile_row.storage = 'legacy_column' AND profile_row.id <> legacy_profile) THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_key;
      END IF;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        IF jsonb_typeof(payload -> 'host') NOT IN ('string', 'null') THEN
          RAISE EXCEPTION 'invalid_embeddings: host must be a string';
        END IF;
      ELSE
        vectors := payload;
      END IF;
      IF vectors IS NULL OR jsonb_typeof(vectors) <> 'array' OR jsonb_array_length(vectors) <> chunk_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', chunk_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE jsonb_typeof(v.value) = 'array' AND jsonb_array_length(v.value) <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  -- A chunk whose text changed must not keep a vector made from the old text.
  DELETE FROM chunk_embeddings ce
  USING document_chunks c, jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  WHERE ce.chunk_id = c.id
    AND c.document_id = p_document_id
    AND c.id = substr(encode(sha256(convert_to(
          p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid
    AND c.content IS DISTINCT FROM (e.value ->> 'content');

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

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::halfvec,
          profile_row.model,
          profile_row.dims,
          host_name
        FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
        JOIN jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord) ON v.ord = e.ord
        WHERE jsonb_typeof(v.value) = 'array'
        ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          dims = EXCLUDED.dims,
          embedding_host = EXCLUDED.embedding_host,
          embedded_at = now();
      END IF;

      DELETE FROM embedding_backfill_gaps g
      USING jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord),
            jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord)
      WHERE v.ord = e.ord
        AND jsonb_typeof(v.value) = 'array'
        AND g.profile_id = profile_row.id
        AND g.chunk_id = substr(encode(sha256(convert_to(
              p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid;
    END LOOP;
  END IF;

  IF p_final THEN
    DELETE FROM document_chunks c WHERE c.document_id = p_document_id AND c.chunk_index >= p_total;
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT written, deleted;
END
$$;

-- The version swap (D-11), one transaction, as in 0310; additionally the superseded version's rows in chunk_embeddings go (F-9) together with
-- the gaps recorded for its chunks, so superseded rows stop occupying the profile indexes. The old documents and chunks keep their text.
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
    DELETE FROM chunk_embeddings ce USING document_chunks c WHERE ce.chunk_id = c.id AND c.document_id = previous.id;
    DELETE FROM embedding_backfill_gaps g USING document_chunks c WHERE g.chunk_id = c.id AND c.document_id = previous.id;
  END IF;

  UPDATE documents d SET is_current = true, status = 'ready' WHERE d.id = doc.id;
  IF previous.id IS NOT NULL AND has_slug AND (moved_type IS NOT NULL OR moved_slug IS NOT NULL) THEN
    EXECUTE 'UPDATE documents SET content_type = $2, slug = $3 WHERE id = $1' USING doc.id, moved_type, moved_slug;
  END IF;
  UPDATE document_chunks c SET is_current = true, status = 'ready' WHERE c.document_id = doc.id;

  RETURN QUERY SELECT 'published'::text, doc.id, doc.version, previous.id;
END
$$;

-- Records chunks that have no vector for p_profile_id because its provider failed or answered with the wrong model or dimensions. Every chunk
-- must belong to p_tenant_key (an unknown id is indistinguishable from another tenant's), the run must be a run of the profile, and a run
-- limited to one tenant takes gaps of that tenant only. A repeated call updates the reason and the time.
CREATE OR REPLACE FUNCTION rag_record_backfill_gap(
  p_run_id uuid,
  p_chunk_ids uuid[],
  p_profile_id text,
  p_reason text,
  p_tenant_key text
)
RETURNS TABLE (gaps_recorded integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  run embedding_backfill_runs%ROWTYPE;
  wanted integer;
  matched integer;
  recorded integer;
BEGIN
  IF p_run_id IS NULL OR p_profile_id IS NULL OR p_tenant_key IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: p_run_id, p_profile_id and p_tenant_key are required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid_gap: a reason is required';
  END IF;
  IF p_chunk_ids IS NULL OR cardinality(p_chunk_ids) = 0 THEN
    RAISE EXCEPTION 'invalid_gap: chunk ids are required';
  END IF;

  SELECT * INTO run FROM embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found';
  END IF;
  IF run.profile_id <> p_profile_id THEN
    RAISE EXCEPTION 'run_profile_mismatch' USING DETAIL = 'the run belongs to another profile';
  END IF;
  IF run.tenant_key IS NOT NULL AND run.tenant_key <> p_tenant_key THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'the run is limited to another tenant';
  END IF;

  SELECT count(DISTINCT u.id) INTO wanted FROM unnest(p_chunk_ids) AS u(id);
  SELECT count(*) INTO matched FROM document_chunks c
  WHERE c.id IN (SELECT u.id FROM unnest(p_chunk_ids) AS u(id)) AND c.tenant_key = p_tenant_key;
  IF matched <> wanted THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'chunk not found in tenant';
  END IF;

  INSERT INTO embedding_backfill_gaps AS g (run_id, chunk_id, profile_id, reason)
  SELECT DISTINCT p_run_id, u.id, p_profile_id, left(btrim(p_reason), 200) FROM unnest(p_chunk_ids) AS u(id)
  ON CONFLICT (run_id, chunk_id, profile_id) DO UPDATE SET reason = EXCLUDED.reason, recorded_at = now();
  GET DIAGNOSTICS recorded = ROW_COUNT;

  RETURN QUERY SELECT recorded;
END
$$;

-- The run a gap of each profile is recorded against: per profile the newest run that applies to p_tenant_key (an unlimited run or one limited
-- to that tenant), a running one first.
CREATE OR REPLACE FUNCTION rag_latest_backfill_runs(p_tenant_key text)
RETURNS TABLE (profile_id text, run_id uuid, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT ON (r.profile_id) r.profile_id, r.id, r.status
  FROM embedding_backfill_runs r
  WHERE r.tenant_key IS NULL OR r.tenant_key = p_tenant_key
  ORDER BY r.profile_id, (r.status = 'running') DESC, r.started_at DESC, r.id
$$;

REVOKE ALL ON FUNCTION rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_publish_document_version(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_record_backfill_gap(uuid, uuid[], text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_latest_backfill_runs(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_publish_document_version(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_record_backfill_gap(uuid, uuid[], text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_latest_backfill_runs(text) TO service_role;

COMMIT;
