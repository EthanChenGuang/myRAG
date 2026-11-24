-- 0306 (multi-tenant): retrieval hides non-current and non-ready chunks (Phase 3, D-08). There is no switch: quarantine is a security control.
-- Every function below is the definition from multi-tenant-setup.sql with one added predicate:
--   AND dc.is_current AND dc.status = 'ready'
-- CREATE OR REPLACE keeps the owner, the grants and the comment of each function. Existing rows are current and ready, so results on
-- existing data do not change.

BEGIN;

CREATE OR REPLACE FUNCTION match_documents_by_organization(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  org_id uuid
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_index int,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.metadata,
    1 - (dc.embedding <=> query_embedding) as similarity
  FROM document_chunks dc
  WHERE dc.organization_id = org_id
    AND 1 - (dc.embedding <=> query_embedding) > match_threshold
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


CREATE OR REPLACE FUNCTION public.match_documents_by_workspace(
  p_query_embedding vector(1536),
  p_match_count integer,
  p_min_similarity double precision,
  p_org_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  content text,
  similarity double precision,
  metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> p_query_embedding) as similarity,
    dc.metadata
  FROM document_chunks dc
  INNER JOIN documents d ON d.id = dc.document_id
  WHERE dc.embedding IS NOT NULL
    AND dc.is_current AND dc.status = 'ready'
    AND 1 - (dc.embedding <=> p_query_embedding) > p_min_similarity
    AND (
      -- Personal workspace: user owns document and no organization
      (p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL)
      OR
      -- Team workspace: document belongs to organization
      (p_org_id IS NOT NULL AND d.organization_id = p_org_id)
    )
  ORDER BY dc.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;


CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding vector(1536),
  match_count integer,
  similarity_threshold double precision
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  content text,
  similarity double precision,
  metadata jsonb
)
LANGUAGE plpgsql
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  current_user_id UUID;
  current_org_id UUID;
BEGIN
  -- Get current user ID
  current_user_id := auth.uid();
  
  -- Get user's current organization if in multi-tenant mode
  SELECT current_organization_id INTO current_org_id
  FROM user_preferences
  WHERE user_id = current_user_id;
  
  -- Return chunks based on organization context
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity,
    dc.metadata
  FROM document_chunks dc
  INNER JOIN documents d ON dc.document_id = d.id
  WHERE dc.embedding IS NOT NULL 
    AND 1 - (dc.embedding <=> query_embedding) > similarity_threshold
    AND dc.is_current AND dc.status = 'ready'
    AND (
      -- Personal workspace: match null org_id docs
      (current_org_id IS NULL AND dc.organization_id IS NULL)
      OR
      -- Organization workspace: match org docs OR personal docs owned by user
      (current_org_id IS NOT NULL AND (
        dc.organization_id = current_org_id
        OR (dc.organization_id IS NULL AND d.user_id = current_user_id)
      ))
    )
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;


CREATE OR REPLACE FUNCTION match_document_chunks_by_org(
  p_org_id uuid,
  p_query_embedding vector(1536),
  p_match_count integer DEFAULT 8,
  p_min_similarity double precision DEFAULT 0.2
)
RETURNS TABLE (
  document_id uuid,
  chunk_id uuid,
  content text,
  similarity double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.document_id,
    dc.id as chunk_id,
    dc.content,
    1 - (dc.embedding <=> p_query_embedding) as similarity
  FROM document_chunks dc
  WHERE (dc.organization_id = p_org_id OR dc.organization_id IS NULL)
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding <=> p_query_embedding) >= p_min_similarity
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

COMMIT;
