-- 0424: rag_write_chunks and rag_write_profile_chunks accept a null vector entry again (reported by 03.1-49).
-- p_embeddings maps a profile id to a list that lines up with the chunks, and a null entry means "no vector for this chunk". The 0408 dims check
-- read "jsonb_typeof(v.value) = 'array' AND jsonb_array_length(v.value) <> dims", but PostgreSQL does not promise to evaluate AND left to
-- right, so a null entry reached jsonb_array_length and the whole write failed with "cannot get array length of a scalar". The length is now
-- taken inside CASE WHEN jsonb_typeof(...) = 'array', which is evaluated in order; the vector-count check uses the same guard.
-- Behaviour is otherwise that of 0408: a null entry writes the chunk without a vector, any other non-array entry raises invalid_embeddings,
-- a vector of the wrong length raises embedding_profile_mismatch, and every refusal rolls the whole call back.
-- Both functions stay SECURITY DEFINER and now run with an empty search_path and schema-qualified names. Server role only.
-- Idempotent: CREATE OR REPLACE with the 0408 signatures, then guarded REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_write_chunks(
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
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc public.documents%ROWTYPE;
  profile_key text;
  profile_row public.embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
  chunk_count integer;
  legacy_vectors jsonb;
  written integer := 0;
  deleted integer := 0;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
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
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
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
      IF COALESCE(CASE WHEN jsonb_typeof(vectors) = 'array' THEN jsonb_array_length(vectors) END, -1) <> chunk_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', chunk_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE CASE WHEN jsonb_typeof(v.value) = 'array' THEN jsonb_array_length(v.value) END <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  -- A chunk whose text changed must not keep a vector made from the old text.
  DELETE FROM public.chunk_embeddings ce
  USING public.document_chunks c, jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
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
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::public.vector END AS embedding,
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
  INSERT INTO public.document_chunks AS dc (
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
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::public.halfvec,
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

      DELETE FROM public.embedding_backfill_gaps g
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
    DELETE FROM public.document_chunks c WHERE c.document_id = p_document_id AND c.chunking_profile_id = 'legacy' AND c.chunk_index >= p_total;
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT written, deleted;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_write_profile_chunks(
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
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc public.documents%ROWTYPE;
  chunking public.chunking_profiles%ROWTYPE;
  parents jsonb := COALESCE(p_parents, '[]'::jsonb);
  profile_key text;
  profile_row public.embedding_profiles%ROWTYPE;
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
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_profile_id IS NULL OR p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'invalid_profile' USING DETAIL = 'legacy chunks are written by rag_write_chunks';
  END IF;
  SELECT * INTO chunking FROM public.chunking_profiles cp WHERE cp.id = p_profile_id AND cp.doc_type = doc.doc_type AND cp.status <> 'retired';
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
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
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
      IF COALESCE(CASE WHEN jsonb_typeof(vectors) = 'array' THEN jsonb_array_length(vectors) END, -1) <> child_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', child_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE CASE WHEN jsonb_typeof(v.value) = 'array' THEN jsonb_array_length(v.value) END <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.document_parents AS dp (
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
        SELECT 1 FROM public.document_parents dp
        WHERE dp.id = substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid
          AND dp.document_id = p_document_id
          AND dp.chunking_profile_id = p_profile_id
      )
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: parent_index names a parent that was not written';
  END IF;

  -- A child whose text changed must not keep a vector made from the old text.
  DELETE FROM public.chunk_embeddings ce
  USING public.document_chunks c, jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
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
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::public.vector END AS embedding,
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
  INSERT INTO public.document_chunks AS dc (
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
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::public.halfvec,
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

      DELETE FROM public.embedding_backfill_gaps g
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
    DELETE FROM public.document_chunks c
    WHERE c.document_id = p_document_id AND c.chunking_profile_id = p_profile_id AND c.chunk_index >= total;
    GET DIAGNOSTICS children_out = ROW_COUNT;
    DELETE FROM public.document_parents dp
    WHERE dp.document_id = p_document_id
      AND dp.chunking_profile_id = p_profile_id
      AND NOT EXISTS (SELECT 1 FROM public.document_chunks c WHERE c.parent_id = dp.id);
    GET DIAGNOSTICS parents_out = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT parents_in, children_in, parents_out, children_out;
END
$$;

DO $write_chunks_null_acl$
BEGIN
  IF to_regprocedure('public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
END
$write_chunks_null_acl$;

COMMIT;
