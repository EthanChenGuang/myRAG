-- 0930 (multi-tenant): the legacy search RPC and the unused content functions of multi-tenant mode (Phase 4.3 plan 10; D-10, D-11, D-12,
-- D-13, A-04, A-09, RESEARCH section 1a). Run after 0930_access_retrieval_functions.sql.
-- match_documents_by_workspace: the 0425 multi-tenant body (newest; earlier 0306) plus p_access_keys text[] DEFAULT NULL and p_access_all
-- boolean DEFAULT false. Every earlier overload is dropped by catalog lookup, so exactly one exists. With no keys, or with p_access_all, the
-- query is the 0425 query, unless public.rag_access_enforced() is true and no keys were sent: then it raises access_scope_required (42501);
-- an empty key array raises access_keys_empty (22023). With keys and p_access_all not true the chunk's label and its document's label must
-- overlap the keys, in the same WHERE as the workspace predicate, before ORDER BY and LIMIT; the visible rows are counted up to 1001, at or
-- below 1000 the query is a materialized exact scan, above it the ANN scan runs with hnsw.iterative_scan = relaxed_order (pgvector 0.8 or
-- newer) and a raised hnsw.ef_search, and the hits are re-sorted by exact distance (D-13). SECURITY DEFINER, empty search_path, service_role
-- only (as 0409, 0410).
-- Unused content functions (no caller in src/): match_document_chunks_by_org, get_documents_by_type_slug, get_documents_by_type_slug_workspace
-- (0425 bodies, SECURITY DEFINER), match_documents_by_organization and the multi-tenant match_document_chunks (0306 bodies, SECURITY
-- INVOKER) keep their signature, body and security mode and gain one guard at the top: while enforcement is on they raise
-- access_scope_required, so none of them returns unfiltered content; while it is off a server caller gets what it got before. The two
-- SQL-language functions become plpgsql with the same query, so the guard can raise. The 0306 ones also get an empty search_path with
-- schema-qualified names; all five are executable by service_role only (the two INVOKER ones were client-callable; with no caller they are
-- not kept open as a path around the access filter).
-- Operator rule: after re-running any file below 0920 that defines one of these functions (0306, 0409, 0425 or the setup file), re-run the
-- whole ordered sequence through the 0930 block. Idempotent; not folded into the setup file.

BEGIN;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'match_documents_by_workspace'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.match_documents_by_workspace(
  p_query_embedding public.vector,
  p_match_count integer,
  p_min_similarity double precision,
  p_org_id uuid,
  p_user_id uuid,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_restrict boolean;
  v_visible integer;
  v_version text;
BEGIN
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);

  IF NOT v_restrict THEN
    RETURN QUERY
    SELECT
      dc.id,
      dc.document_id,
      dc.content,
      1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) as similarity,
      dc.metadata
    FROM public.document_chunks dc
    INNER JOIN public.documents d ON d.id = dc.document_id
    WHERE dc.embedding IS NOT NULL
      AND dc.is_current AND dc.status = 'ready'
      AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) > p_min_similarity
      AND (
        -- Personal workspace: user owns document and no organization
        (p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL)
        OR
        -- Team workspace: document belongs to organization
        (p_org_id IS NOT NULL AND d.organization_id = p_org_id)
      )
    ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
    LIMIT p_match_count;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_visible FROM (
    SELECT 1
    FROM public.document_chunks dc
    INNER JOIN public.documents d ON d.id = dc.document_id
    WHERE dc.embedding IS NOT NULL
      AND dc.is_current AND dc.status = 'ready'
      AND ((p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL) OR (p_org_id IS NOT NULL AND d.organization_id = p_org_id))
      AND dc.access_groups && p_access_keys AND d.access_groups && p_access_keys
    LIMIT 1001
  ) s;

  IF v_visible <= 1000 THEN
    RETURN QUERY
    WITH hits AS MATERIALIZED (
      SELECT dc.id AS hid, dc.embedding OPERATOR(public.<=>) p_query_embedding AS dist
      FROM public.document_chunks dc
      INNER JOIN public.documents d ON d.id = dc.document_id
      WHERE dc.embedding IS NOT NULL
        AND dc.is_current AND dc.status = 'ready'
        AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) > p_min_similarity
        AND ((p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL) OR (p_org_id IS NOT NULL AND d.organization_id = p_org_id))
        AND dc.access_groups && p_access_keys AND d.access_groups && p_access_keys
    )
    SELECT c.id, c.document_id, c.content, (1 - h.dist)::double precision, c.metadata
    FROM hits h
    JOIN public.document_chunks c ON c.id = h.hid
    ORDER BY h.dist + 0, h.hid
    LIMIT p_match_count;
    RETURN;
  END IF;

  SELECT extversion INTO v_version FROM pg_catalog.pg_extension WHERE extname = 'vector';
  IF v_version IS NOT NULL AND (string_to_array(v_version, '.'))[1:2]::int[] >= ARRAY[0, 8] THEN
    PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  END IF;
  PERFORM set_config('hnsw.ef_search', least(greatest(p_match_count * 2, 100), 1000)::text, true);

  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT dc.id AS hid, dc.embedding OPERATOR(public.<=>) p_query_embedding AS dist
    FROM public.document_chunks dc
    INNER JOIN public.documents d ON d.id = dc.document_id
    WHERE dc.embedding IS NOT NULL
      AND dc.is_current AND dc.status = 'ready'
      AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) > p_min_similarity
      AND ((p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL) OR (p_org_id IS NOT NULL AND d.organization_id = p_org_id))
      AND dc.access_groups && p_access_keys AND d.access_groups && p_access_keys
    ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
    LIMIT p_match_count
  )
  SELECT c.id, c.document_id, c.content, (1 - h.dist)::double precision, c.metadata
  FROM hits h
  JOIN public.document_chunks c ON c.id = h.hid
  ORDER BY h.dist + 0, h.hid;
END;
$function$;

REVOKE ALL ON FUNCTION public.match_documents_by_workspace(public.vector, integer, double precision, uuid, uuid, text[], boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(public.vector, integer, double precision, uuid, uuid, text[], boolean)
  TO service_role;

-- Unused multi-tenant content functions: newest bodies (0425, 0306) with the guard at the top; the 0306 ones also get an empty search_path
-- and schema-qualified names. All are executable by service_role only.

CREATE OR REPLACE FUNCTION public.match_document_chunks_by_org(p_org_id uuid, p_query_embedding public.vector, p_match_count integer DEFAULT 8, p_min_similarity double precision DEFAULT 0.2)
 RETURNS TABLE(document_id uuid, chunk_id uuid, content text, similarity double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    dc.document_id,
    dc.id as chunk_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) as similarity
  FROM public.document_chunks dc
  WHERE (dc.organization_id = p_org_id OR dc.organization_id IS NULL)
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) >= p_min_similarity
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
  LIMIT p_match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug(p_org_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    WITH tenant_docs AS (
      SELECT d.id, d.organization_id, d.content, d.slug, true as is_tenant
      FROM public.documents d
      WHERE d.organization_id = p_org_id
        AND d.content_type = p_content_type
        AND (p_slug IS NULL OR d.slug = p_slug)
      ORDER BY d.created_at DESC
    ),
    global_docs AS (
      SELECT d.id, d.organization_id, d.content, d.slug, false as is_tenant
      FROM public.documents d
      WHERE d.organization_id IS NULL
        AND d.content_type = p_content_type
        AND (p_slug IS NULL OR d.slug = p_slug)
        AND NOT EXISTS (SELECT 1 FROM tenant_docs)
      ORDER BY d.created_at DESC
    )
    SELECT * FROM tenant_docs
    UNION ALL
    SELECT * FROM global_docs
    LIMIT 10;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug_workspace(p_org_id uuid, p_user_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, user_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    (
      SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, true as is_tenant
      FROM public.documents d
      WHERE p_org_id IS NOT NULL
        AND d.organization_id = p_org_id
        AND d.content_type = p_content_type
        AND (p_slug IS NULL OR d.slug = p_slug)
    )
    UNION ALL
    (
      SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, false as is_tenant
      FROM public.documents d
      WHERE p_org_id IS NULL
        AND d.organization_id IS NULL
        AND d.user_id = p_user_id
        AND d.content_type = p_content_type
        AND (p_slug IS NULL OR d.slug = p_slug)
    )
    LIMIT 10;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_documents_by_organization(
  query_embedding public.vector(1536),
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
SET search_path = ''
AS $$
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.metadata,
    1 - (dc.embedding OPERATOR(public.<=>) query_embedding) as similarity
  FROM public.document_chunks dc
  WHERE dc.organization_id = org_id
    AND 1 - (dc.embedding OPERATOR(public.<=>) query_embedding) > match_threshold
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding OPERATOR(public.<=>) query_embedding
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding public.vector(1536),
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
SET search_path = ''
AS $$
DECLARE
  current_user_id UUID;
  current_org_id UUID;
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  -- Get current user ID
  current_user_id := auth.uid();
  
  -- Get user's current organization if in multi-tenant mode
  SELECT current_organization_id INTO current_org_id
  FROM public.user_preferences
  WHERE user_id = current_user_id;
  
  -- Return chunks based on organization context
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) query_embedding) as similarity,
    dc.metadata
  FROM public.document_chunks dc
  INNER JOIN public.documents d ON dc.document_id = d.id
  WHERE dc.embedding IS NOT NULL 
    AND 1 - (dc.embedding OPERATOR(public.<=>) query_embedding) > similarity_threshold
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

REVOKE ALL ON FUNCTION public.match_documents_by_organization(public.vector, float, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents_by_organization(public.vector, float, int, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.match_document_chunks(public.vector, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_document_chunks(public.vector, integer, double precision) TO service_role;
REVOKE ALL ON FUNCTION public.match_document_chunks_by_org(uuid, public.vector, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_document_chunks_by_org(uuid, public.vector, integer, double precision) TO service_role;
REVOKE ALL ON FUNCTION public.get_documents_by_type_slug(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_documents_by_type_slug(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.get_documents_by_type_slug_workspace(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_documents_by_type_slug_workspace(uuid, uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
