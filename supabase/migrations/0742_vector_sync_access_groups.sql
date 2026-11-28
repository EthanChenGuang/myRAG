-- 0742: Phase 7 vector sync carries document access groups (SEC-12, RET-06; D-01, D-02, D-03 extended, A-7).
-- rag_vector_sync_document_rows and rag_vector_sync_chunk_row (0705) also return access_groups, the chunk column Phase 4.3 keeps equal to
-- its document's (0921, 0923). Arguments, SECURITY INVOKER, search_path '', the tenant guard and the service-role grants stay as in 0705.
-- The column is added here with 0921's exact definition (text[] NOT NULL DEFAULT '{all}', seam 2) because migrations apply in name order,
-- so 0742 runs before 0921 on a fresh install; 0921 then adds its check, index and copy trigger to the same column.
-- Group changes reach the outbox: access_groups joins the compared columns of the 0702 UPDATE trigger functions on documents and
-- document_chunks (rag_vector_sync_documents_update, rag_vector_sync_chunks_update), which enqueue a `document` row per changed document
-- for every enabled target through rag_vector_sync_enqueue. Their triggers stay as in 0702 (one statement trigger per event, A-7) and so
-- do their rights and early exit; after re-running 0702, re-run this file.
-- rag_validate_chunks_for_groups is rag_validate_chunks (0704) restricted to chunks whose access_groups overlap p_access_groups; NULL or
-- empty groups raise 22023 (fail closed). Plan 07-39 re-validates external hits with it.
-- One-time re-sync: when this file changes the read functions (they did not return access_groups yet), it enqueues one `tenant` row per
-- enabled target and tenant with index state, so points written before 0742 gain the field through the normal drain. A default install
-- (no target enabled) enqueues nothing; a re-run finds the functions already current and enqueues nothing.
-- Not folded into the setup files. Idempotent.

BEGIN;

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';

DO $reads$
DECLARE
  v_current boolean;
  v_target text;
  v_tenants text[];
  v_count integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'rag_vector_sync_document_rows'
       AND 'access_groups' = ANY(coalesce(p.proargnames, '{}'::text[]))
  ) AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'rag_vector_sync_chunk_row'
       AND 'access_groups' = ANY(coalesce(p.proargnames, '{}'::text[]))
  ) INTO v_current;

  IF v_current THEN
    RETURN;
  END IF;

  DROP FUNCTION IF EXISTS public.rag_vector_sync_document_rows(text, uuid, text, uuid, integer);
  DROP FUNCTION IF EXISTS public.rag_vector_sync_chunk_row(text, uuid, text);

  CREATE FUNCTION public.rag_vector_sync_document_rows(
    p_tenant_key text,
    p_document_id uuid,
    p_profile_id text,
    p_after uuid,
    p_limit integer
  )
  RETURNS TABLE (
    chunk_id uuid,
    document_id uuid,
    tenant_key text,
    vector real[],
    lexical_text text,
    lexical_version integer,
    content_hash text,
    doc_type text,
    doc_date date,
    language text,
    source text,
    chunking_profile_id text,
    parent_id uuid,
    access_groups text[]
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY INVOKER
  SET search_path = ''
  AS $fn$
  DECLARE
    v_storage text;
  BEGIN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
    IF p_document_id IS NULL THEN
      RAISE EXCEPTION 'vector_sync_refused: document_required' USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
      RAISE EXCEPTION 'vector_sync_refused: invalid_limit' USING ERRCODE = '22023';
    END IF;
    SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
    IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
      RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
    END IF;

    IF v_storage = 'legacy_column' THEN
      RETURN QUERY
      SELECT c.id, c.document_id, c.tenant_key, c.embedding::real[], c.lexical_text, c.lexical_version, c.content_hash, c.doc_type,
             c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id, c.access_groups
        FROM public.rag_servable_chunks s
        JOIN public.document_chunks c ON c.id = s.chunk_id
       WHERE s.document_id = p_document_id
         AND s.tenant_key = p_tenant_key
         AND c.tenant_key = p_tenant_key
         AND (p_after IS NULL OR c.id > p_after)
         AND c.embedding IS NOT NULL
       ORDER BY c.id
       LIMIT p_limit;
    ELSE
      RETURN QUERY
      SELECT c.id, c.document_id, c.tenant_key, (e.embedding::public.vector)::real[], c.lexical_text, c.lexical_version, c.content_hash,
             c.doc_type, c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id, c.access_groups
        FROM public.rag_servable_chunks s
        JOIN public.document_chunks c ON c.id = s.chunk_id
        JOIN public.chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
       WHERE s.document_id = p_document_id
         AND s.tenant_key = p_tenant_key
         AND c.tenant_key = p_tenant_key
         AND (p_after IS NULL OR c.id > p_after)
       ORDER BY c.id
       LIMIT p_limit;
    END IF;
  END
  $fn$;

  CREATE FUNCTION public.rag_vector_sync_chunk_row(p_tenant_key text, p_chunk_id uuid, p_profile_id text)
  RETURNS TABLE (
    chunk_id uuid,
    document_id uuid,
    tenant_key text,
    vector real[],
    lexical_text text,
    lexical_version integer,
    content_hash text,
    doc_type text,
    doc_date date,
    language text,
    source text,
    chunking_profile_id text,
    parent_id uuid,
    access_groups text[]
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY INVOKER
  SET search_path = ''
  AS $fn$
  DECLARE
    v_storage text;
  BEGIN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
    IF p_chunk_id IS NULL THEN
      RAISE EXCEPTION 'vector_sync_refused: chunk_required' USING ERRCODE = '22023';
    END IF;
    SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
    IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
      RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
    END IF;

    IF v_storage = 'legacy_column' THEN
      RETURN QUERY
      SELECT c.id, c.document_id, c.tenant_key, c.embedding::real[], c.lexical_text, c.lexical_version, c.content_hash, c.doc_type,
             c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id, c.access_groups
        FROM public.rag_servable_chunks s
        JOIN public.document_chunks c ON c.id = s.chunk_id
       WHERE s.chunk_id = p_chunk_id
         AND s.tenant_key = p_tenant_key
         AND c.tenant_key = p_tenant_key
         AND c.embedding IS NOT NULL;
    ELSE
      RETURN QUERY
      SELECT c.id, c.document_id, c.tenant_key, (e.embedding::public.vector)::real[], c.lexical_text, c.lexical_version, c.content_hash,
             c.doc_type, c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id, c.access_groups
        FROM public.rag_servable_chunks s
        JOIN public.document_chunks c ON c.id = s.chunk_id
        JOIN public.chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
       WHERE s.chunk_id = p_chunk_id
         AND s.tenant_key = p_tenant_key
         AND c.tenant_key = p_tenant_key;
    END IF;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.rag_vector_sync_document_rows(text, uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.rag_vector_sync_chunk_row(text, uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.rag_vector_sync_document_rows(text, uuid, text, uuid, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunk_row(text, uuid, text) TO service_role;

  -- One-time re-sync of the points written before this file (D-01: nothing while no target is enabled).
  FOR v_target IN SELECT t.target FROM public.rag_vector_sync_targets t WHERE t.enabled ORDER BY t.target LOOP
    SELECT pg_catalog.array_agg(k.tenant_key ORDER BY k.tenant_key)
      INTO v_tenants
      FROM (SELECT DISTINCT s.tenant_key FROM public.rag_backend_index_state s WHERE s.target = v_target AND s.tenant_key IS NOT NULL) k;
    v_count := coalesce(pg_catalog.array_length(v_tenants, 1), 0);
    PERFORM public.rag_vector_sync_enqueue('tenant', v_tenants, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[v_count]), v_target);
  END LOOP;
END
$reads$;

-- Group changes (SEC-12, T-07-145). access_groups is now a D-03 filter field, so it joins the synced columns of the two 0702 UPDATE
-- trigger functions; their triggers, the early exit and every other compared column stay exactly as in 0702 (A-7: one statement trigger
-- per event). A relabel updates documents (rag_set_document_access_groups) and then every chunk (rag_access_groups_propagate), and both
-- statements enqueue the same document row, which the pending-row rule of rag_vector_sync_enqueue absorbs.

CREATE OR REPLACE FUNCTION public.rag_vector_sync_chunks_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_docs text[];
  v_tenants text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.enabled) THEN
    RETURN NULL;
  END IF;
  -- Synced columns: the D-03 payload and filter fields (access_groups since 0742) plus what decides servability (D-02).
  WITH changed AS (
    SELECT o.document_id AS old_doc, o.tenant_key AS old_tenant, n.document_id AS new_doc, n.tenant_key AS new_tenant
      FROM old_rows o
      FULL JOIN new_rows n ON n.id = o.id
     WHERE o.id IS NULL OR n.id IS NULL
        OR (o.document_id, o.tenant_key, o.organization_id, o.is_current, o.status, o.embedding::text, o.lexical_text, o.lexical_version,
            o.content_hash, o.doc_type, o.doc_date, o.language, o.source, o.chunking_profile_id, o.parent_id, o.access_groups)
           IS DISTINCT FROM
           (n.document_id, n.tenant_key, n.organization_id, n.is_current, n.status, n.embedding::text, n.lexical_text, n.lexical_version,
            n.content_hash, n.doc_type, n.doc_date, n.language, n.source, n.chunking_profile_id, n.parent_id, n.access_groups)
  ), keys AS (
    SELECT c.old_doc AS document_id, c.old_tenant AS tenant_key FROM changed c WHERE c.old_doc IS NOT NULL
    UNION
    SELECT c.new_doc, c.new_tenant FROM changed c WHERE c.new_doc IS NOT NULL
  )
  SELECT pg_catalog.array_agg(k.document_id::text), pg_catalog.array_agg(k.tenant_key)
    INTO v_docs, v_tenants
    FROM keys k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[coalesce(pg_catalog.array_length(v_docs, 1), 0)]));
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_documents_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_docs text[];
  v_tenants text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.enabled) THEN
    RETURN NULL;
  END IF;
  -- Tenant columns, is_current and status: soft delete, quarantine, release, version publish and tenant moves; access_groups: relabels.
  WITH changed AS (
    SELECT o.id AS old_id, o.tenant_key AS old_tenant, n.id AS new_id, n.tenant_key AS new_tenant
      FROM old_rows o
      FULL JOIN new_rows n ON n.id = o.id
     WHERE o.id IS NULL OR n.id IS NULL
        OR (o.user_id, o.organization_id, o.tenant_key, o.is_current, o.status, o.access_groups)
           IS DISTINCT FROM (n.user_id, n.organization_id, n.tenant_key, n.is_current, n.status, n.access_groups)
  ), keys AS (
    SELECT c.old_id AS document_id, c.old_tenant AS tenant_key FROM changed c WHERE c.old_id IS NOT NULL
    UNION
    SELECT c.new_id, c.new_tenant FROM changed c WHERE c.new_id IS NOT NULL
  )
  SELECT pg_catalog.array_agg(k.document_id::text), pg_catalog.array_agg(k.tenant_key)
    INTO v_docs, v_tenants
    FROM keys k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[coalesce(pg_catalog.array_length(v_docs, 1), 0)]));
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_documents_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_documents_update() TO service_role;

-- Group-aware re-validation for the query side (plan 07-39, T-07-146).

CREATE OR REPLACE FUNCTION public.rag_validate_chunks_for_groups(p_tenant_key text, p_ids uuid[], p_profile_id text, p_access_groups text[])
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_storage text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_access_groups IS NULL OR coalesce(pg_catalog.cardinality(p_access_groups), 0) = 0 THEN
    RAISE EXCEPTION 'rag_validate_chunks_for_groups: access groups required' USING ERRCODE = '22023';
  END IF;

  IF coalesce(pg_catalog.cardinality(p_ids), 0) > 500 THEN
    RAISE EXCEPTION 'rag_validate_chunks: too many ids' USING ERRCODE = '22023';
  END IF;

  SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;

  IF coalesce(pg_catalog.cardinality(p_ids), 0) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.document_id, c.content, c.metadata, c.chunk_index, c.doc_type, c.language, c.parent_id, c.section_path, c.chunk_kind,
         d.filename, d.created_at, d.metadata, pg_catalog.left(d.content, 200)
    FROM public.rag_servable_chunks s
    JOIN public.document_chunks c ON c.id = s.chunk_id
    JOIN public.documents d ON d.id = c.document_id
   WHERE s.chunk_id = ANY(p_ids)
     AND s.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key
     AND d.tenant_key = p_tenant_key
     AND c.access_groups && p_access_groups
     AND d.access_groups && p_access_groups
     AND CASE
           WHEN v_storage = 'legacy_column' THEN c.embedding IS NOT NULL
           ELSE EXISTS (
             SELECT 1 FROM public.chunk_embeddings e
              WHERE e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
           )
         END
   ORDER BY c.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_validate_chunks_for_groups(text, uuid[], text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_validate_chunks_for_groups(text, uuid[], text, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
