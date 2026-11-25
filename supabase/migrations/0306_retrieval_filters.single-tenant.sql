-- 0306 (single-tenant): retrieval hides non-current and non-ready chunks (Phase 3, D-08). There is no switch: quarantine is a security control.
-- Every function below is the definition from single-tenant-setup.sql with one added predicate:
--   AND dc.is_current AND dc.status = 'ready'
-- CREATE OR REPLACE keeps the owner, the grants and the comment of each function. Existing rows are current and ready, so results on
-- existing data do not change.

BEGIN;

CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding vector(1536),
  similarity_threshold double precision,
  match_count integer
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  content TEXT,
  similarity double precision
)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
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
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;


CREATE OR REPLACE FUNCTION match_documents(
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


CREATE OR REPLACE FUNCTION match_document_chunks_optimized(
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


CREATE OR REPLACE FUNCTION search_chunks_by_keywords(
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

COMMIT;
