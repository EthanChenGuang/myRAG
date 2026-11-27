-- 0931: derived stores under document access groups (SEC-13, D-23, D-24, D-31, A-05, A-06). Part one (04.3-12): the semantic cache.
-- rag_cache_check: the 0603 body (the newest definition) gains p_access_keys text[] and p_access_all boolean, appended with defaults NULL
-- and false. With no keys it returns what 0603 returned, unless public.rag_access_enforced() (0922) is true: then it raises
-- access_scope_required (42501). An empty key array (or one holding NULL) raises access_keys_empty (22023). After the 0603 currency check
-- (a hit whose sources are no longer current and ready is still deleted), a hit is served only when every document_id in source_versions is a
-- document of the tenant whose access_groups overlap the keys (p_access_all skips the check). An entry that is current but not visible to
-- this caller is a miss with a NULL distance and is not deleted (RESEARCH Pitfall 10): it stays valid for callers who can see its sources.
-- No access-label column is added to rag_semantic_cache and rag_cache_store is unchanged: the live per-document recheck over source_versions
-- replaces the stored union of source labels for the cache (A-06, RESEARCH R-6). A refusal entry has no sources and is protected by the key
-- hash alone, which carries the caller's effective access set (A-05, src/lib/rag/cache/keys.ts).
-- rag_semantic_cache_on_access_update (SECURITY DEFINER, like the 0603 trigger functions, so invalidation works for any writer) and the
-- statement trigger rag_access_semantic_cache_update delete every cache row of each tenant whose documents changed access_groups (D-24). A
-- transition-table trigger cannot have a column list, so the body compares the column. The 0603 trigger function
-- rag_semantic_cache_on_documents_update is not replaced. The trigger is created only while rag_semantic_cache exists. The vector-sync outbox
-- is not touched here (Phase 7 plan 07-38, A-14).
-- Every rag_cache_check overload is dropped by catalog lookup first, so exactly one exists. SECURITY INVOKER, VOLATILE, empty search_path,
-- executable by service_role only. Re-running 0603 or a setup file requires re-running this file. Idempotent; not folded into the setup
-- files.

BEGIN;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rag_cache_check'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.rag_cache_check(
  p_tenant_key text,
  p_key_hash text,
  p_profile text,
  p_embedding public.halfvec,
  p_max_distance double precision,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
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

  -- D-09, D-10: no keys while enforcement is on is refused; an empty key array never means "no filter".
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;

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

  -- D-23: every source must be visible to this caller. Not visible is a miss without delete and without a distance (Pitfall 10).
  IF p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) AND EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_sources) AS s(document_id uuid, version integer)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = s.document_id
        AND d.tenant_key = p_tenant_key
        AND d.access_groups OPERATOR(pg_catalog.&&) p_access_keys
    )
  ) THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::double precision, NULL::jsonb, NULL::boolean;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_id, v_distance, v_answer, v_is_refusal;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_cache_check(text, text, text, public.halfvec, double precision, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_cache_check(text, text, text, public.halfvec, double precision, text[], boolean) TO service_role;

-- D-24: a relabel deletes every cache row of the tenants whose documents changed access_groups, in the same transaction.
CREATE OR REPLACE FUNCTION public.rag_semantic_cache_on_access_update()
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
      AND o.access_groups IS DISTINCT FROM n.access_groups
  );
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_access_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_access_update() TO service_role;

DO $access_trigger$
BEGIN
  DROP TRIGGER IF EXISTS rag_access_semantic_cache_update ON public.documents;
  IF to_regclass('public.rag_semantic_cache') IS NOT NULL THEN
    CREATE TRIGGER rag_access_semantic_cache_update
      AFTER UPDATE ON public.documents
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.rag_semantic_cache_on_access_update();
  ELSE
    RAISE NOTICE '[RAG Access] rag_semantic_cache is absent; the access invalidation trigger was not created';
  END IF;
END
$access_trigger$;

NOTIFY pgrst, 'reload schema';

COMMIT;
