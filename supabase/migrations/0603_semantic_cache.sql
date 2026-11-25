-- 0603: pgvector semantic answer cache (Phase 6, CACHE-01, D-34, A-6).
-- rag_semantic_cache holds one cached answer per row, keyed by tenant_key, key_hash (64 lower-case hex over answer language, RAG mode,
-- generator model, retrieval-config hash and query framework) and embedding_profile_id. The embedding column is an untyped halfvec, so
-- profiles of different dimensions share the table; every lookup filters by tenant, key, profile and expiry in a materialized CTE before any
-- distance is computed (research P-5). RLS is on with no policies; only service_role reaches the table, through the functions below.
-- Every function takes the tenant only from p_tenant_key, checked first by rag_assert_tenant_key (Phase 4 D-04), is SECURITY INVOKER with an
-- empty search_path and is service_role only. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_semantic_cache (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  key_hash text NOT NULL,
  embedding_profile_id text NOT NULL,
  embedding public.halfvec NOT NULL,
  query_text_masked text NOT NULL,
  answer jsonb NOT NULL,
  source_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_refusal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT rag_semantic_cache_source_versions_array CHECK (pg_catalog.jsonb_typeof(source_versions) = 'array')
);

CREATE INDEX IF NOT EXISTS rag_semantic_cache_lookup_idx
  ON public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, expires_at);

ALTER TABLE public.rag_semantic_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_semantic_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.rag_semantic_cache TO service_role;

-- True when every {document_id, version} in p_source_versions is the current, ready version of a document of the tenant (vacuously true
-- for an empty list). Used by rag_cache_check on every hit, by rag_cache_store, and by the app to re-validate a RedisVL hit (D-35).
CREATE OR REPLACE FUNCTION public.rag_cache_sources_current(p_tenant_key text, p_source_versions jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_source_versions IS NULL OR pg_catalog.jsonb_typeof(p_source_versions) <> 'array' THEN
    RAISE EXCEPTION 'source_versions must be a json array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_source_versions) AS e(v)
    WHERE pg_catalog.jsonb_typeof(e.v) <> 'object'
       OR pg_catalog.jsonb_typeof(e.v -> 'document_id') IS DISTINCT FROM 'string'
       OR (e.v ->> 'document_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR pg_catalog.jsonb_typeof(e.v -> 'version') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'each source must be {document_id, version}' USING ERRCODE = '22023';
  END IF;

  RETURN NOT EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(p_source_versions) AS s(document_id uuid, version integer)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = s.document_id
        AND d.tenant_key = p_tenant_key
        AND d.version = s.version
        AND d.is_current
        AND d.status = 'ready'
    )
  );
END
$fn$;

-- Nearest entry for (tenant, key, profile) among unexpired rows. Returns exactly one row: the nearest distance is reported even on a miss
-- (NULL when no candidate exists); answer, entry_id and is_refusal are set only on a hit (distance <= p_max_distance). A hit whose sources are
-- no longer current and ready is a miss, and that row is deleted.
CREATE OR REPLACE FUNCTION public.rag_cache_check(
  p_tenant_key text,
  p_key_hash text,
  p_profile text,
  p_embedding public.halfvec,
  p_max_distance double precision
)
RETURNS TABLE (hit boolean, entry_id uuid, distance double precision, answer jsonb, is_refusal boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_id uuid;
  v_distance double precision;
  v_answer jsonb;
  v_is_refusal boolean;
  v_sources jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'malformed cache key hash' USING ERRCODE = '22023';
  END IF;
  IF p_profile IS NULL OR pg_catalog.btrim(p_profile) = '' OR pg_catalog.length(p_profile) > 200 THEN
    RAISE EXCEPTION 'malformed embedding profile id' USING ERRCODE = '22023';
  END IF;
  IF p_embedding IS NULL THEN
    RAISE EXCEPTION 'embedding is required' USING ERRCODE = '22023';
  END IF;
  IF p_max_distance IS NULL OR p_max_distance < 0 OR p_max_distance > 2 OR p_max_distance <> p_max_distance THEN
    RAISE EXCEPTION 'max distance must be within 0..2' USING ERRCODE = '22023';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT c.id, c.embedding, c.answer, c.is_refusal, c.source_versions
    FROM public.rag_semantic_cache c
    WHERE c.tenant_key = p_tenant_key
      AND c.key_hash = p_key_hash
      AND c.embedding_profile_id = p_profile
      AND c.expires_at > pg_catalog.now()
      AND public.vector_dims(c.embedding) = public.vector_dims(p_embedding)
  )
  SELECT k.id, (k.embedding OPERATOR(public.<=>) p_embedding)::double precision, k.answer, k.is_refusal, k.source_versions
  INTO v_id, v_distance, v_answer, v_is_refusal, v_sources
  FROM candidates k
  ORDER BY 2, k.id
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::double precision, NULL::jsonb, NULL::boolean;
    RETURN;
  END IF;
  IF v_distance > p_max_distance THEN
    RETURN QUERY SELECT false, NULL::uuid, v_distance, NULL::jsonb, NULL::boolean;
    RETURN;
  END IF;

  IF NOT public.rag_cache_sources_current(p_tenant_key, v_sources) THEN
    DELETE FROM public.rag_semantic_cache c WHERE c.id = v_id AND c.tenant_key = p_tenant_key;
    RETURN QUERY SELECT false, NULL::uuid, v_distance, NULL::jsonb, NULL::boolean;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_id, v_distance, v_answer, v_is_refusal;
END
$fn$;

-- Stores one entry and returns its id. The TTL must be 1..86400 s; every source must be a current, ready document version of the tenant.
-- Each call also deletes at most 100 expired rows of the same tenant.
CREATE OR REPLACE FUNCTION public.rag_cache_store(
  p_tenant_key text,
  p_key_hash text,
  p_profile text,
  p_embedding public.halfvec,
  p_query_text_masked text,
  p_answer jsonb,
  p_source_versions jsonb,
  p_is_refusal boolean,
  p_ttl_seconds integer
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_sources jsonb;
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'malformed cache key hash' USING ERRCODE = '22023';
  END IF;
  IF p_profile IS NULL OR pg_catalog.btrim(p_profile) = '' OR pg_catalog.length(p_profile) > 200 THEN
    RAISE EXCEPTION 'malformed embedding profile id' USING ERRCODE = '22023';
  END IF;
  IF p_embedding IS NULL THEN
    RAISE EXCEPTION 'embedding is required' USING ERRCODE = '22023';
  END IF;
  IF p_query_text_masked IS NULL THEN
    RAISE EXCEPTION 'masked query text is required' USING ERRCODE = '22023';
  END IF;
  IF p_answer IS NULL OR pg_catalog.jsonb_typeof(p_answer) <> 'object' THEN
    RAISE EXCEPTION 'answer must be a json object' USING ERRCODE = '22023';
  END IF;
  IF p_is_refusal IS NULL THEN
    RAISE EXCEPTION 'is_refusal is required' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 86400 THEN
    RAISE EXCEPTION 'ttl must be within 1..86400 seconds' USING ERRCODE = '22023';
  END IF;
  IF NOT public.rag_cache_sources_current(p_tenant_key, p_source_versions) THEN
    RAISE EXCEPTION 'cache_sources_not_current' USING DETAIL = 'every source must be a current, ready document of the tenant';
  END IF;

  SELECT coalesce(
           pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('document_id', s.document_id, 'version', s.version) ORDER BY s.document_id, s.version),
           '[]'::jsonb)
  INTO v_sources
  FROM (SELECT DISTINCT r.document_id, r.version
        FROM pg_catalog.jsonb_to_recordset(p_source_versions) AS r(document_id uuid, version integer)) s;

  DELETE FROM public.rag_semantic_cache c
  WHERE c.id IN (
    SELECT x.id FROM public.rag_semantic_cache x
    WHERE x.tenant_key = p_tenant_key AND x.expires_at <= pg_catalog.now()
    LIMIT 100
  );

  INSERT INTO public.rag_semantic_cache (
    tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, created_at, expires_at
  )
  VALUES (
    p_tenant_key, p_key_hash, p_profile, p_embedding, p_query_text_masked, p_answer, v_sources, p_is_refusal, pg_catalog.now(),
    pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_seconds)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$fn$;

-- Deletes the tenant's entries and returns how many: all of them when p_document_ids is NULL, otherwise only entries whose source_versions
-- reference one of the ids.
CREATE OR REPLACE FUNCTION public.rag_cache_invalidate(p_tenant_key text, p_document_ids uuid[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_document_ids IS NULL THEN
    DELETE FROM public.rag_semantic_cache c WHERE c.tenant_key = p_tenant_key;
  ELSE
    DELETE FROM public.rag_semantic_cache c
    WHERE c.tenant_key = p_tenant_key
      AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(c.source_versions) AS e(v)
        WHERE (e.v ->> 'document_id') IN (SELECT u.id::text FROM pg_catalog.unnest(p_document_ids) AS u(id))
      );
  END IF;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$fn$;

-- The current name and version of the tenant's current, ready documents among p_document_ids, so a cache hit can write its answer record
-- with citations re-resolved against the current sources (plan-check W6).
CREATE OR REPLACE FUNCTION public.rag_cache_resolve_sources(p_tenant_key text, p_document_ids uuid[])
RETURNS TABLE (document_id uuid, name text, version integer)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  RETURN QUERY
  SELECT d.id, d.filename, d.version
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.id = ANY (coalesce(p_document_ids, '{}'::uuid[]))
    AND d.is_current
    AND d.status = 'ready'
  ORDER BY d.id;
END
$fn$;

-- Same-transaction invalidation (D-34, A-6): three single-event statement triggers on documents delete every cache row of each tenant whose
-- documents were inserted, deleted, or updated in is_current, status, version or tenant_key. Processing-progress updates leave the cache
-- alone. This covers rag_publish_document_version, soft deletes, legacy routes, connector syncs and cascades in one place. The functions
-- are SECURITY DEFINER so invalidation works for any writer, including an authenticated owner who has no access to the cache table; they
-- only delete cache rows for tenant keys taken from the transition tables.
CREATE OR REPLACE FUNCTION public.rag_semantic_cache_on_documents_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM public.rag_semantic_cache c
  WHERE c.tenant_key IN (SELECT DISTINCT n.tenant_key FROM new_rows n WHERE n.tenant_key IS NOT NULL);
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_semantic_cache_on_documents_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM public.rag_semantic_cache c
  WHERE c.tenant_key IN (
    SELECT t.tenant_key
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.tenant_key), (n.tenant_key)) AS t(tenant_key)
    WHERE t.tenant_key IS NOT NULL
      AND (o.is_current IS DISTINCT FROM n.is_current
        OR o.status IS DISTINCT FROM n.status
        OR o.version IS DISTINCT FROM n.version
        OR o.tenant_key IS DISTINCT FROM n.tenant_key)
  );
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_semantic_cache_on_documents_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM public.rag_semantic_cache c
  WHERE c.tenant_key IN (SELECT DISTINCT o.tenant_key FROM old_rows o WHERE o.tenant_key IS NOT NULL);
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS rag_semantic_cache_documents_insert ON public.documents;
CREATE TRIGGER rag_semantic_cache_documents_insert
  AFTER INSERT ON public.documents
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_semantic_cache_on_documents_insert();

DROP TRIGGER IF EXISTS rag_semantic_cache_documents_update ON public.documents;
CREATE TRIGGER rag_semantic_cache_documents_update
  AFTER UPDATE ON public.documents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_semantic_cache_on_documents_update();

DROP TRIGGER IF EXISTS rag_semantic_cache_documents_delete ON public.documents;
CREATE TRIGGER rag_semantic_cache_documents_delete
  AFTER DELETE ON public.documents
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_semantic_cache_on_documents_delete();

REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_documents_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_documents_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_documents_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_documents_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_documents_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_documents_delete() TO service_role;

REVOKE ALL ON FUNCTION public.rag_cache_sources_current(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_cache_check(text, text, text, public.halfvec, double precision) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_cache_store(text, text, text, public.halfvec, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_cache_invalidate(text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_cache_resolve_sources(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_cache_sources_current(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_cache_check(text, text, text, public.halfvec, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_cache_store(text, text, text, public.halfvec, text, jsonb, jsonb, boolean, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_cache_invalidate(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_cache_resolve_sources(text, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
