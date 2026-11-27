-- 0930 (single-tenant): the legacy search RPC and the unused content functions of single-tenant mode (Phase 4.3 plan 10; D-10, D-11, D-12,
-- A-04, RESEARCH section 1a). Run after 0930_access_retrieval_functions.sql.
-- match_document_chunks: the 0306 single-tenant body (newest) plus p_access_keys text[] DEFAULT NULL and p_access_all boolean DEFAULT false.
-- Every earlier overload is dropped by catalog lookup, so exactly one exists. With no keys the result is the 0306 result, unless
-- public.rag_access_enforced() is true: then it raises access_scope_required (42501); an empty key array raises access_keys_empty (22023).
-- With keys and p_access_all not true the chunk's label and its document's label must overlap the keys, in the WHERE, before ORDER BY and
-- LIMIT. It orders by the computed similarity, which no index serves, so the scan is already exact. SECURITY INVOKER as before, now with an
-- empty search_path and schema-qualified names, and executable by service_role only (the legacy pipeline calls it on the admin client; the
-- 0306 signature was client-callable).
-- Unused content functions (no caller in src/): match_documents, match_document_chunks_optimized, search_chunks_by_keywords (0306) and
-- get_document_chunks (0316) keep their signature, body, security mode, search_path and grants, and gain one guard at the top: while
-- enforcement is on they raise access_scope_required, so none of them returns unfiltered content. They are SECURITY INVOKER; the guard
-- reads rag_access_enforced() only when the calling role may execute it (service_role, and the client roles once 0923 grants it), so with
-- enforcement off every caller gets what it got before; a client role without that grant is limited by RLS on the tables (0923).
-- Operator rule: after re-running any file below 0920 that defines one of these functions (0306, 0316 or the setup file), re-run the whole
-- ordered sequence through the 0930 block. Idempotent; not folded into the setup file.

BEGIN;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'match_document_chunks'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding public.vector(1536),
  similarity_threshold double precision,
  match_count integer,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  content text,
  similarity double precision
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_restrict boolean;
BEGIN
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) query_embedding) as similarity
  FROM public.document_chunks dc
  WHERE dc.embedding IS NOT NULL
    AND 1 - (dc.embedding OPERATOR(public.<=>) query_embedding) > similarity_threshold
    AND dc.is_current AND dc.status = 'ready'
    AND (NOT v_restrict OR (dc.access_groups && p_access_keys
      AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = dc.document_id AND d.access_groups && p_access_keys)))
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

REVOKE ALL ON FUNCTION public.match_document_chunks(public.vector, double precision, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_document_chunks(public.vector, double precision, integer, text[], boolean) TO service_role;

-- Unused single-tenant content functions: newest bodies (0306, 0316) unchanged apart from the guard at the top.

CREATE OR REPLACE FUNCTION public.match_documents(
  query_embedding vector(1536),
  match_count integer
)
RETURNS TABLE(
  id uuid,
  content text,
  metadata jsonb,
  embedding vector,
  similarity double precision
)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
begin
  IF pg_catalog.has_function_privilege('public.rag_access_enforced()', 'EXECUTE') THEN
    IF public.rag_access_enforced() THEN
      RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  return query
  select
    dc.id,
    dc.content,
    dc.metadata,
    dc.embedding,
    1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where dc.embedding is not null
    and dc.is_current and dc.status = 'ready'
  order by dc.embedding <=> query_embedding
  limit match_count;
end;
$$;

CREATE OR REPLACE FUNCTION public.match_document_chunks_optimized(
  query_embedding vector(1536),
  similarity_threshold double precision,
  match_count integer,
  performance_mode text DEFAULT 'balanced'
)
RETURNS TABLE(
  chunk_id uuid,
  document_id uuid,
  content text,
  similarity double precision
)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_catalog.has_function_privilege('public.rag_access_enforced()', 'EXECUTE') THEN
    IF public.rag_access_enforced() THEN
      RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  -- Set ef_search based on performance mode
  CASE performance_mode
    WHEN 'fast' THEN
      PERFORM set_hnsw_search_params(64);
    WHEN 'accurate' THEN
      PERFORM set_hnsw_search_params(256);
    ELSE -- balanced
      PERFORM set_hnsw_search_params(128);
  END CASE;

  -- Execute the search with optimized parameters
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity
  FROM document_chunks dc
  WHERE dc.embedding IS NOT NULL 
    AND 1 - (dc.embedding <=> query_embedding) > similarity_threshold
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_chunks_by_keywords(
  search_query TEXT,
  match_limit INT DEFAULT 10
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  content TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_catalog.has_function_privilege('public.rag_access_enforced()', 'EXECUTE') THEN
    IF public.rag_access_enforced() THEN
      RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN QUERY
  WITH keyword_array AS (
    SELECT unnest(string_to_array(lower(search_query), ' ')) AS keyword
  ),
  ranked_chunks AS (
    SELECT 
      dc.id as chunk_id,
      dc.document_id,
      dc.content,
      -- Calculate similarity based on keyword matches
      (
        SELECT COUNT(DISTINCT k.keyword)::FLOAT / 
               GREATEST(array_length(string_to_array(lower(search_query), ' '), 1), 1)::FLOAT
        FROM keyword_array k
        WHERE lower(dc.content) LIKE '%' || k.keyword || '%'
      ) AS match_score
    FROM document_chunks dc
    WHERE EXISTS (
      SELECT 1 
      FROM keyword_array k 
      WHERE lower(dc.content) LIKE '%' || k.keyword || '%'
    )
    AND dc.is_current AND dc.status = 'ready'
  )
  SELECT 
    rc.chunk_id,
    rc.document_id,
    rc.content,
    rc.match_score AS similarity
  FROM ranked_chunks rc
  WHERE rc.match_score > 0
  ORDER BY rc.match_score DESC
  LIMIT match_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_document_chunks(
  doc_id UUID
)
RETURNS TABLE (
  chunk_id UUID,
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_catalog.has_function_privilege('public.rag_access_enforced()', 'EXECUTE') THEN
    IF public.rag_access_enforced() THEN
      RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.content,
    dc.metadata,
    dc.created_at
  FROM document_chunks dc
  WHERE dc.document_id = doc_id AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_document_chunks(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_document_chunks(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
