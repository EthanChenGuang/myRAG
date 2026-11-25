-- 0408: profile chunk writer and re-chunk build-run tables (Phase 4, D-20, D-21, CHK-03, CHK-04).
-- rag_write_profile_chunks stores the parents and children of one chunking profile for one document version in one transaction. Parents go to
-- document_parents, children to document_chunks with parent_id and chunking_profile_id. Row ids are the first 16 bytes of
-- sha256(document id : profile id : parent|child : index), so a rewrite lands on the same rows and cannot collide with the legacy ids of
-- rag_write_chunks (document id : index). The document must belong to p_tenant_key (tenant_mismatch otherwise); the tenant key, organization,
-- version, currency, doc type, language and source of every row are copied from the document row, never from the payload. The 0404 trigger keeps
-- every child of a non-legacy profile at status variant once its document is ready, so legacy readers never see them.
-- p_embeddings has the shape of rag_write_chunks: an object keyed by embedding profile id whose value lines up with p_children (a null entry means
-- no vector), or {"vectors": [...], "host": "..."}; the legacy-storage profile fills document_chunks.embedding, a halfvec profile upserts one
-- chunk_embeddings row per child. Only children carry lexical text and vectors; parents carry neither. A child whose text changed drops its old
-- vectors. With p_final (the default) children from index p_total on (default: the number sent) and parents no child points to any more are removed,
-- so a smaller rewrite leaves nothing behind; a caller that splits a large profile across calls sends all parents in the first call and p_final on the last.
-- chunking_build_runs and chunking_build_gaps record re-chunk progress and documents that have no stored parse output (plan 04-32 writes them).
-- rag_write_chunks is replaced once more so its final cleanup removes legacy rows only (profile children share the document).
-- Server role only. Idempotent: CREATE ... IF NOT EXISTS, CREATE OR REPLACE with a fixed signature, then guarded REVOKE and GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS chunking_build_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL,
  doc_type text NOT NULL,
  tenant_key text,
  cursor_document_id uuid,
  docs_total integer NOT NULL DEFAULT 0 CONSTRAINT chunking_build_runs_docs_total_check CHECK (docs_total >= 0),
  docs_done integer NOT NULL DEFAULT 0 CONSTRAINT chunking_build_runs_docs_done_check CHECK (docs_done >= 0),
  status text NOT NULL DEFAULT 'running'
    CONSTRAINT chunking_build_runs_status_check CHECK (status IN ('running', 'completed', 'incomplete', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunking_build_runs_profile_fk FOREIGN KEY (profile_id, doc_type) REFERENCES chunking_profiles (id, doc_type)
);

CREATE INDEX IF NOT EXISTS chunking_build_runs_profile_idx ON chunking_build_runs (profile_id, doc_type, started_at DESC);

CREATE TABLE IF NOT EXISTS chunking_build_gaps (
  run_id uuid NOT NULL REFERENCES chunking_build_runs (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  reason text NOT NULL CONSTRAINT chunking_build_gaps_reason_check CHECK (reason IN ('no_parse_output', 'failed')),
  detail text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, document_id)
);

CREATE INDEX IF NOT EXISTS chunking_build_gaps_document_idx ON chunking_build_gaps (document_id);

ALTER TABLE chunking_build_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunking_build_gaps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE chunking_build_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE chunking_build_gaps FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE chunking_build_runs TO service_role;
GRANT ALL ON TABLE chunking_build_gaps TO service_role;

-- The legacy writer's final cleanup ("chunk_index >= p_total") must only remove legacy rows: the children of a chunking profile share the
-- document and have their own index range. Body as in 0313 except for that one predicate.
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
    DELETE FROM document_chunks c WHERE c.document_id = p_document_id AND c.chunking_profile_id = 'legacy' AND c.chunk_index >= p_total;
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT written, deleted;
END
$$;

CREATE OR REPLACE FUNCTION rag_write_profile_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_profile_id text,
  p_parents jsonb,
  p_children jsonb,
  p_embeddings jsonb,
  p_final boolean DEFAULT true,
  p_total integer DEFAULT NULL
)
RETURNS TABLE (parents_written integer, children_written integer, parents_deleted integer, children_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc documents%ROWTYPE;
  chunking chunking_profiles%ROWTYPE;
  parents jsonb := COALESCE(p_parents, '[]'::jsonb);
  profile_key text;
  profile_row embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
  parent_count integer;
  child_count integer;
  legacy_vectors jsonb;
  total integer;
  parents_in integer := 0;
  children_in integer := 0;
  parents_out integer := 0;
  children_out integer := 0;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_profile_id IS NULL OR p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'invalid_profile' USING DETAIL = 'legacy chunks are written by rag_write_chunks';
  END IF;
  SELECT * INTO chunking FROM chunking_profiles cp WHERE cp.id = p_profile_id AND cp.doc_type = doc.doc_type AND cp.status <> 'retired';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chunking_profile_unsupported' USING DETAIL = 'no live profile of this id for the document type';
  END IF;

  IF jsonb_typeof(parents) <> 'array' THEN
    RAISE EXCEPTION 'invalid_parents: p_parents must be a JSON array';
  END IF;
  IF p_children IS NULL OR jsonb_typeof(p_children) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_children must be a JSON array';
  END IF;
  parent_count := jsonb_array_length(parents);
  child_count := jsonb_array_length(p_children);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e.value -> 'parent_index') IS DISTINCT FROM 'number'
       OR jsonb_typeof(e.value -> 'token_count') IS DISTINCT FROM 'number'
       OR (e.value ? 'section_path' AND jsonb_typeof(e.value -> 'section_path') <> 'array')
  ) THEN
    RAISE EXCEPTION 'invalid_parents: every parent needs a string content, a numeric parent_index and a numeric token_count';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS e(value)
    WHERE (e.value ->> 'parent_index') !~ '^[0-9]{1,9}$' OR (e.value ->> 'token_count') !~ '^[0-9]{1,9}$'
  ) OR (SELECT count(DISTINCT (e.value ->> 'parent_index')::integer) FROM jsonb_array_elements(parents) AS e(value)) <> parent_count THEN
    RAISE EXCEPTION 'invalid_parents: parent_index values must be distinct non-negative integers and token_count a non-negative integer';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
       OR (e.value ? 'parent_index' AND jsonb_typeof(e.value -> 'parent_index') NOT IN ('number', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every child needs a string content, and a numeric chunk_index and parent_index when it has them';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
    WHERE COALESCE(e.value ->> 'chunk_index', (e.ord - 1)::text) !~ '^[0-9]{1,9}$'
       OR (jsonb_typeof(e.value -> 'parent_index') = 'number' AND (e.value ->> 'parent_index') !~ '^[0-9]{1,9}$')
  ) OR (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
        FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)) <> child_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct non-negative integers';
  END IF;
  IF p_final AND p_total IS NOT NULL AND p_total < 0 THEN
    RAISE EXCEPTION 'invalid_total: p_total must not be negative';
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
      IF vectors IS NULL OR jsonb_typeof(vectors) <> 'array' OR jsonb_array_length(vectors) <> child_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', child_count;
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

  INSERT INTO document_parents AS dp (
    id, document_id, tenant_key, organization_id, version, is_current, chunking_profile_id, section_path, content, token_count, parent_index
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    doc.tenant_key,
    doc.organization_id,
    doc.version,
    true,
    p_profile_id,
    CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END,
    e.value ->> 'content',
    (e.value ->> 'token_count')::integer,
    (e.value ->> 'parent_index')::integer
  FROM jsonb_array_elements(parents) AS e(value)
  ON CONFLICT (id) DO UPDATE SET
    tenant_key = EXCLUDED.tenant_key,
    organization_id = EXCLUDED.organization_id,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    chunking_profile_id = EXCLUDED.chunking_profile_id,
    section_path = EXCLUDED.section_path,
    content = EXCLUDED.content,
    token_count = EXCLUDED.token_count,
    parent_index = EXCLUDED.parent_index
  WHERE dp.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS parents_in = ROW_COUNT;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) AS e(value)
    WHERE jsonb_typeof(e.value -> 'parent_index') = 'number'
      AND NOT EXISTS (
        SELECT 1 FROM document_parents dp
        WHERE dp.id = substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid
          AND dp.document_id = p_document_id
          AND dp.chunking_profile_id = p_profile_id
      )
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: parent_index names a parent that was not written';
  END IF;

  -- A child whose text changed must not keep a vector made from the old text.
  DELETE FROM chunk_embeddings ce
  USING document_chunks c, jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
  WHERE ce.chunk_id = c.id
    AND c.document_id = p_document_id
    AND c.chunking_profile_id = p_profile_id
    AND c.id = substr(encode(sha256(convert_to(
          p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid
    AND c.content IS DISTINCT FROM (e.value ->> 'content');

  WITH prepared AS (
    SELECT
      e.value AS spec,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN jsonb_typeof(e.value -> 'parent_index') = 'number'
           THEN substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid
      END AS parent_id,
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
    FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text, parent_id, chunking_profile_id
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':child:' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
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
        'embedding_text_version', p.embedding_text_version,
        'chunking_profile_id', p_profile_id)
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
    p.lexical_text,
    p.parent_id,
    p_profile_id
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
    lexical_text = EXCLUDED.lexical_text,
    parent_id = EXCLUDED.parent_id,
    chunking_profile_id = EXCLUDED.chunking_profile_id
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS children_in = ROW_COUNT;

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
            p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::halfvec,
          profile_row.model,
          profile_row.dims,
          host_name
        FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
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
      USING jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord),
            jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord)
      WHERE v.ord = e.ord
        AND jsonb_typeof(v.value) = 'array'
        AND g.profile_id = profile_row.id
        AND g.chunk_id = substr(encode(sha256(convert_to(
              p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid;
    END LOOP;
  END IF;

  IF p_final THEN
    total := COALESCE(p_total, child_count);
    DELETE FROM document_chunks c
    WHERE c.document_id = p_document_id AND c.chunking_profile_id = p_profile_id AND c.chunk_index >= total;
    GET DIAGNOSTICS children_out = ROW_COUNT;
    DELETE FROM document_parents dp
    WHERE dp.document_id = p_document_id
      AND dp.chunking_profile_id = p_profile_id
      AND NOT EXISTS (SELECT 1 FROM document_chunks c WHERE c.parent_id = dp.id);
    GET DIAGNOSTICS parents_out = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT parents_in, children_in, parents_out, children_out;
END
$$;

DO $profile_writer_acl$
BEGIN
  IF to_regprocedure('public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
END
$profile_writer_acl$;

COMMIT;
