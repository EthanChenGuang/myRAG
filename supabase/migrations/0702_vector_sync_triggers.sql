-- 0702: Phase 7 vector sync change capture, enqueue triggers (D-01, A-7).
-- One AFTER ... FOR EACH STATEMENT trigger per event, each reading its transition table, so a cascade that removes thousands of
-- chunks enqueues once per document. Postgres refuses transition tables on triggers with a column list, so UPDATE triggers compare
-- the synced columns of the OLD and NEW rows themselves and enqueue only rows that really changed.
-- Every function returns before touching any row while no target is enabled in rag_vector_sync_targets (the default).
-- Trigger events enqueue the document entity: under chunking profiles a chunk's servability depends on its whole document, so the
-- worker re-syncs the whole document. Profile flips enqueue a profile row (embedding:<id>, chunking:<doc_type>).
-- A pending row for the same target, entity, tenant and profile that no worker has tried yet absorbs a new change.

BEGIN;

-- Internal: one set-based insert per call, for every enabled target, skipping entities that already wait untried.
CREATE OR REPLACE FUNCTION public.rag_vector_sync_enqueue(
  p_entity text,
  p_entity_ids text[],
  p_tenant_keys text[],
  p_profile_ids text[]
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF coalesce(pg_catalog.array_length(p_entity_ids, 1), 0) = 0 THEN
    RETURN 0;
  END IF;
  INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key, profile_id)
  SELECT t.target, p_entity, s.entity_id, s.tenant_key, s.profile_id
    FROM (
      SELECT DISTINCT u.entity_id, u.tenant_key, u.profile_id
        FROM unnest(p_entity_ids, p_tenant_keys, p_profile_ids) AS u(entity_id, tenant_key, profile_id)
       WHERE u.entity_id IS NOT NULL AND (u.tenant_key IS NOT NULL OR p_entity = 'profile')
    ) s
    CROSS JOIN public.rag_vector_sync_targets t
   WHERE t.enabled
     AND NOT EXISTS (
       SELECT 1 FROM public.vector_sync_outbox o
        WHERE o.target = t.target
          AND o.entity = p_entity
          AND o.entity_id = s.entity_id
          AND o.status = 'pending'
          AND o.attempts = 0
          AND o.cursor IS NULL
          AND o.tenant_key IS NOT DISTINCT FROM s.tenant_key
          AND o.profile_id IS NOT DISTINCT FROM s.profile_id
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_enqueue(text, text[], text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_enqueue(text, text[], text[], text[]) TO service_role;

-- The trigger functions below are SECURITY DEFINER because the inserting role (an owner editing a chunk, an ingest RPC) cannot
-- write the server-only outbox. They take no caller input: they read only transition rows and insert into the outbox.

-- ---------------------------------------------------------------------------
-- document_chunks
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_vector_sync_chunks_insert()
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
  SELECT pg_catalog.array_agg(k.document_id::text), pg_catalog.array_agg(k.tenant_key)
    INTO v_docs, v_tenants
    FROM (SELECT DISTINCT n.document_id, n.tenant_key FROM new_rows n) k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[coalesce(pg_catalog.array_length(v_docs, 1), 0)]));
  RETURN NULL;
END
$$;

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
  -- Synced columns: the D-03 payload and filter fields plus what decides servability (D-02).
  WITH changed AS (
    SELECT o.document_id AS old_doc, o.tenant_key AS old_tenant, n.document_id AS new_doc, n.tenant_key AS new_tenant
      FROM old_rows o
      FULL JOIN new_rows n ON n.id = o.id
     WHERE o.id IS NULL OR n.id IS NULL
        OR (o.document_id, o.tenant_key, o.organization_id, o.is_current, o.status, o.embedding::text, o.lexical_text, o.lexical_version,
            o.content_hash, o.doc_type, o.doc_date, o.language, o.source, o.chunking_profile_id, o.parent_id)
           IS DISTINCT FROM
           (n.document_id, n.tenant_key, n.organization_id, n.is_current, n.status, n.embedding::text, n.lexical_text, n.lexical_version,
            n.content_hash, n.doc_type, n.doc_date, n.language, n.source, n.chunking_profile_id, n.parent_id)
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

CREATE OR REPLACE FUNCTION public.rag_vector_sync_chunks_delete()
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
  SELECT pg_catalog.array_agg(k.document_id::text), pg_catalog.array_agg(k.tenant_key)
    INTO v_docs, v_tenants
    FROM (SELECT DISTINCT o.document_id, o.tenant_key FROM old_rows o) k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[coalesce(pg_catalog.array_length(v_docs, 1), 0)]));
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- documents (a new document has no chunks yet, so no INSERT trigger)
-- ---------------------------------------------------------------------------

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
  -- Tenant columns, is_current and status: soft delete, quarantine, release, version publish and tenant moves.
  WITH changed AS (
    SELECT o.id AS old_id, o.tenant_key AS old_tenant, n.id AS new_id, n.tenant_key AS new_tenant
      FROM old_rows o
      FULL JOIN new_rows n ON n.id = o.id
     WHERE o.id IS NULL OR n.id IS NULL
        OR (o.user_id, o.organization_id, o.tenant_key, o.is_current, o.status)
           IS DISTINCT FROM (n.user_id, n.organization_id, n.tenant_key, n.is_current, n.status)
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

CREATE OR REPLACE FUNCTION public.rag_vector_sync_documents_delete()
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
  SELECT pg_catalog.array_agg(k.id::text), pg_catalog.array_agg(k.tenant_key)
    INTO v_docs, v_tenants
    FROM (SELECT DISTINCT o.id, o.tenant_key FROM old_rows o) k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[coalesce(pg_catalog.array_length(v_docs, 1), 0)]));
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- chunk_embeddings (per-profile vectors). A row removed by a chunk cascade has no chunk left to name its document; the chunk's
-- own DELETE trigger has already enqueued that document for every profile.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_vector_sync_embeddings_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_docs text[];
  v_tenants text[];
  v_profiles text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.enabled) THEN
    RETURN NULL;
  END IF;
  SELECT pg_catalog.array_agg(k.document_id::text), pg_catalog.array_agg(k.tenant_key), pg_catalog.array_agg(k.profile_id)
    INTO v_docs, v_tenants, v_profiles
    FROM (
      SELECT DISTINCT c.document_id, n.tenant_key, n.profile_id
        FROM new_rows n JOIN public.document_chunks c ON c.id = n.chunk_id
    ) k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, v_profiles);
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_embeddings_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_docs text[];
  v_tenants text[];
  v_profiles text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.enabled) THEN
    RETURN NULL;
  END IF;
  WITH changed AS (
    SELECT o.chunk_id AS old_chunk, o.tenant_key AS old_tenant, o.profile_id AS old_profile,
           n.chunk_id AS new_chunk, n.tenant_key AS new_tenant, n.profile_id AS new_profile
      FROM old_rows o
      FULL JOIN new_rows n ON n.chunk_id = o.chunk_id AND n.profile_id = o.profile_id
     WHERE o.chunk_id IS NULL OR n.chunk_id IS NULL
        OR (o.tenant_key, o.embedding::text) IS DISTINCT FROM (n.tenant_key, n.embedding::text)
  ), keys AS (
    SELECT c.old_chunk AS chunk_id, c.old_tenant AS tenant_key, c.old_profile AS profile_id FROM changed c WHERE c.old_chunk IS NOT NULL
    UNION
    SELECT c.new_chunk, c.new_tenant, c.new_profile FROM changed c WHERE c.new_chunk IS NOT NULL
  )
  SELECT pg_catalog.array_agg(k.document_id::text), pg_catalog.array_agg(k.tenant_key), pg_catalog.array_agg(k.profile_id)
    INTO v_docs, v_tenants, v_profiles
    FROM (
      SELECT DISTINCT c.document_id, keys.tenant_key, keys.profile_id
        FROM keys JOIN public.document_chunks c ON c.id = keys.chunk_id
    ) k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, v_profiles);
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_embeddings_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_docs text[];
  v_tenants text[];
  v_profiles text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.enabled) THEN
    RETURN NULL;
  END IF;
  SELECT pg_catalog.array_agg(k.document_id::text), pg_catalog.array_agg(k.tenant_key), pg_catalog.array_agg(k.profile_id)
    INTO v_docs, v_tenants, v_profiles
    FROM (
      SELECT DISTINCT c.document_id, o.tenant_key, o.profile_id
        FROM old_rows o JOIN public.document_chunks c ON c.id = o.chunk_id
    ) k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, v_profiles);
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- Profile flips: every embedding profile status change (activation, rollback, backfill start, retire) and every chunking
-- pointer move to or from active.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_vector_sync_embedding_profiles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids text[];
  v_profiles text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.enabled) THEN
    RETURN NULL;
  END IF;
  SELECT pg_catalog.array_agg('embedding:' || k.id), pg_catalog.array_agg(k.id)
    INTO v_ids, v_profiles
    FROM (
      SELECT DISTINCT n.id
        FROM old_rows o JOIN new_rows n ON n.id = o.id
       WHERE o.status IS DISTINCT FROM n.status
    ) k;
  PERFORM public.rag_vector_sync_enqueue('profile', v_ids, pg_catalog.array_fill(NULL::text, ARRAY[coalesce(pg_catalog.array_length(v_ids, 1), 0)]), v_profiles);
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_chunking_profiles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids text[];
  v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.enabled) THEN
    RETURN NULL;
  END IF;
  SELECT pg_catalog.array_agg('chunking:' || k.doc_type)
    INTO v_ids
    FROM (
      SELECT DISTINCT n.doc_type
        FROM old_rows o JOIN new_rows n ON n.id = o.id AND n.doc_type = o.doc_type
       WHERE o.status IS DISTINCT FROM n.status AND (o.status = 'active' OR n.status = 'active')
    ) k;
  v_count := coalesce(pg_catalog.array_length(v_ids, 1), 0);
  PERFORM public.rag_vector_sync_enqueue('profile', v_ids, pg_catalog.array_fill(NULL::text, ARRAY[v_count]), pg_catalog.array_fill(NULL::text, ARRAY[v_count]));
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_chunks_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_chunks_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_documents_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_documents_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_embeddings_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_embeddings_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_embeddings_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_embedding_profiles() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_chunking_profiles() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunks_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunks_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_documents_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_documents_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_embeddings_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_embeddings_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_embeddings_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_embedding_profiles() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunking_profiles() TO service_role;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS rag_vector_sync_chunks_insert ON public.document_chunks;
CREATE TRIGGER rag_vector_sync_chunks_insert
  AFTER INSERT ON public.document_chunks
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_chunks_insert();

DROP TRIGGER IF EXISTS rag_vector_sync_chunks_update ON public.document_chunks;
CREATE TRIGGER rag_vector_sync_chunks_update
  AFTER UPDATE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_chunks_update();

DROP TRIGGER IF EXISTS rag_vector_sync_chunks_delete ON public.document_chunks;
CREATE TRIGGER rag_vector_sync_chunks_delete
  AFTER DELETE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_chunks_delete();

DROP TRIGGER IF EXISTS rag_vector_sync_documents_update ON public.documents;
CREATE TRIGGER rag_vector_sync_documents_update
  AFTER UPDATE ON public.documents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_documents_update();

DROP TRIGGER IF EXISTS rag_vector_sync_documents_delete ON public.documents;
CREATE TRIGGER rag_vector_sync_documents_delete
  AFTER DELETE ON public.documents
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_documents_delete();

DROP TRIGGER IF EXISTS rag_vector_sync_embeddings_insert ON public.chunk_embeddings;
CREATE TRIGGER rag_vector_sync_embeddings_insert
  AFTER INSERT ON public.chunk_embeddings
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_embeddings_insert();

DROP TRIGGER IF EXISTS rag_vector_sync_embeddings_update ON public.chunk_embeddings;
CREATE TRIGGER rag_vector_sync_embeddings_update
  AFTER UPDATE ON public.chunk_embeddings
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_embeddings_update();

DROP TRIGGER IF EXISTS rag_vector_sync_embeddings_delete ON public.chunk_embeddings;
CREATE TRIGGER rag_vector_sync_embeddings_delete
  AFTER DELETE ON public.chunk_embeddings
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_embeddings_delete();

DROP TRIGGER IF EXISTS rag_vector_sync_embedding_profiles ON public.embedding_profiles;
CREATE TRIGGER rag_vector_sync_embedding_profiles
  AFTER UPDATE ON public.embedding_profiles
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_embedding_profiles();

DROP TRIGGER IF EXISTS rag_vector_sync_chunking_profiles ON public.chunking_profiles;
CREATE TRIGGER rag_vector_sync_chunking_profiles
  AFTER UPDATE ON public.chunking_profiles
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_vector_sync_chunking_profiles();

COMMIT;
