-- 0983: scope-gate functions and delete-on-change triggers (Phase 6.2, QRY-14, D-25, D-34, D-02, P-27).
-- rag_scope_centroids_rebuild replaces a tenant's centroids for one embedding profile with the mean of its current, ready chunk embeddings
-- per group: one row per <doc_type>/<language>, per <dimension>:<value>/<language> scope tag and per tenant/<language> (D-34). A chunk is a
-- member when it and its document are current and ready, neither is provisional, and it belongs to the chunking profile retrieval searches
-- for its doc type (the 0856 rule: the active chunking profile, else legacy; legacy chunks stay members while the document has no chunk in
-- the active profile, and legacy image and invoice-header chunks always do). Superseded, deleted, quarantined, pending and failed versions
-- never count. The legacy profile (storage legacy_column) reads document_chunks.embedding cast to halfvec; every other profile reads
-- chunk_embeddings. The chunk language is used, falling back to the document language for und; a chunk with neither is grouped as und.
-- Readers: rag_scope_centroids_list (at most 500 rows), rag_scope_status (group counts, chunks included, newest update, whether the tenant
-- has an active doc-type-scoped embedding binding, example count). Examples: rag_scope_example_add (500 characters, 100 per tenant and
-- profile, duplicates by case- and whitespace-folded text refused), rag_scope_examples_list, rag_scope_example_delete.
-- Every function asserts p_tenant_key first with rag_assert_tenant_key (Phase 4 D-04), is SECURITY INVOKER with an empty search_path and
-- schema-qualified names, and is service_role only.
-- Same-transaction invalidation (P-27): statement triggers on documents, document_chunks and chunk_embeddings delete the affected tenant's
-- centroid rows whenever membership or vectors can change (insert, delete, and updates of currency, status, version, tenant, doc type,
-- language, scope tags, provisional, supersession, chunking profile or embedding). Missing rows mean unsure, so a stale gate fails open.
-- The trigger functions take a shared transaction advisory lock per tenant and rebuild takes the exclusive one, so a rebuild that overlaps
-- a membership change either sees it or is cleared by it. The trigger functions are SECURITY DEFINER so invalidation works for any writer;
-- they delete only rows of tenant keys taken from the transition tables. Additive, idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_scope_lock_key(p_tenant_key text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.hashtextextended('rag_scope_centroids:' OPERATOR(pg_catalog.||) p_tenant_key, 0)
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_profile_dims(p_profile_id text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
BEGIN
  IF p_profile_id IS NULL OR pg_catalog.btrim(p_profile_id) = '' OR pg_catalog.length(p_profile_id) > 200 THEN
    RAISE EXCEPTION 'malformed embedding profile id' USING ERRCODE = '22023';
  END IF;
  SELECT p.dims INTO v_dims FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF v_dims IS NULL THEN
    RAISE EXCEPTION 'unknown embedding profile' USING ERRCODE = '22023';
  END IF;
  RETURN v_dims;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_rebuild(p_tenant_key text, p_profile_id text)
RETURNS TABLE (group_kind text, groups integer, chunks bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
  v_legacy boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  v_dims := public.rag_scope_profile_dims(p_profile_id);
  SELECT p.storage = 'legacy_column' INTO v_legacy FROM public.embedding_profiles p WHERE p.id = p_profile_id;

  PERFORM pg_catalog.pg_advisory_xact_lock(public.rag_scope_lock_key(p_tenant_key));

  DELETE FROM public.rag_scope_centroids c WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id;

  INSERT INTO public.rag_scope_centroids (tenant_key, embedding_profile_id, group_kind, group_key, centroid, dims, member_count, updated_at)
  WITH eff AS MATERIALIZED (
    SELECT dt.doc_type,
           COALESCE(
             (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
             'legacy'
           ) AS profile_id
    FROM (SELECT DISTINCT c.doc_type FROM public.document_chunks c WHERE c.tenant_key = p_tenant_key AND c.doc_type IS NOT NULL) dt
  ),
  members AS MATERIALIZED (
    SELECT c.id AS chunk_id,
           COALESCE(c.doc_type, d.doc_type) AS doc_type,
           d.scopes,
           CASE WHEN c.language IS NULL OR c.language = 'und' THEN COALESCE(NULLIF(d.language, 'und'), 'und') ELSE c.language END AS language,
           CASE WHEN v_legacy THEN c.embedding::public.halfvec ELSE e.embedding END AS embedding
    FROM public.document_chunks c
    JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
    JOIN eff ep ON ep.doc_type = c.doc_type
    LEFT JOIN public.chunk_embeddings e
      ON NOT v_legacy AND e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key AND e.dims = v_dims
    WHERE c.tenant_key = p_tenant_key
      AND c.is_current AND c.status = 'ready' AND NOT c.provisional
      AND d.is_current AND d.status = 'ready' AND NOT d.provisional
      AND (c.chunking_profile_id = ep.profile_id
        OR (ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy'
          AND (c.chunk_kind IN ('image', 'invoice_header')
            OR NOT EXISTS (
              SELECT 1 FROM public.document_chunks c2
              WHERE c2.document_id = c.document_id AND c2.tenant_key = p_tenant_key AND c2.is_current
                AND c2.chunking_profile_id = ep.profile_id))))
  ),
  usable AS MATERIALIZED (
    SELECT m.* FROM members m
    WHERE m.embedding IS NOT NULL AND public.vector_dims(m.embedding) = v_dims
  )
  SELECT p_tenant_key, p_profile_id, g.kind, g.key, g.centroid, v_dims, g.n, pg_catalog.now()
  FROM (
    SELECT 'doc_type'::text AS kind, u.doc_type OPERATOR(pg_catalog.||) '/' OPERATOR(pg_catalog.||) u.language AS key,
           public.avg(u.embedding) AS centroid, pg_catalog.count(*)::integer AS n
    FROM usable u
    GROUP BY u.doc_type, u.language
    UNION ALL
    SELECT 'scope_tag'::text, t.tag OPERATOR(pg_catalog.||) '/' OPERATOR(pg_catalog.||) u.language,
           public.avg(u.embedding), pg_catalog.count(*)::integer
    FROM usable u
    CROSS JOIN LATERAL pg_catalog.unnest(u.scopes) AS t(tag)
    WHERE t.tag IS NOT NULL AND pg_catalog.length(t.tag) BETWEEN 3 AND 190
    GROUP BY t.tag, u.language
    UNION ALL
    SELECT 'tenant'::text, 'tenant/' OPERATOR(pg_catalog.||) u.language,
           public.avg(u.embedding), pg_catalog.count(*)::integer
    FROM usable u
    GROUP BY u.language
  ) g;

  RETURN QUERY
  SELECT k.kind, COALESCE(s.groups, 0), COALESCE(s.chunks, 0)
  FROM (VALUES ('doc_type'::text), ('scope_tag'::text), ('tenant'::text)) AS k(kind)
  LEFT JOIN (
    SELECT c.group_kind, pg_catalog.count(*)::integer AS groups, pg_catalog.sum(c.member_count)::bigint AS chunks
    FROM public.rag_scope_centroids c
    WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id
    GROUP BY c.group_kind
  ) s ON s.group_kind = k.kind
  ORDER BY k.kind;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_list(p_tenant_key text, p_profile_id text)
RETURNS TABLE (group_kind text, group_key text, centroid public.halfvec, dims integer, member_count integer, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM public.rag_scope_profile_dims(p_profile_id);
  RETURN QUERY
  SELECT c.group_kind, c.group_key, c.centroid, c.dims, c.member_count, c.updated_at
  FROM public.rag_scope_centroids c
  WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id
  ORDER BY c.group_kind, c.group_key
  LIMIT 500;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_status(p_tenant_key text, p_profile_id text)
RETURNS TABLE (
  doc_type_groups integer,
  scope_tag_groups integer,
  tenant_groups integer,
  chunks_included bigint,
  newest_update timestamptz,
  has_scoped_binding boolean,
  examples integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM public.rag_scope_profile_dims(p_profile_id);
  RETURN QUERY
  SELECT
    (SELECT pg_catalog.count(*)::integer FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id AND c.group_kind = 'doc_type'),
    (SELECT pg_catalog.count(*)::integer FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id AND c.group_kind = 'scope_tag'),
    (SELECT pg_catalog.count(*)::integer FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id AND c.group_kind = 'tenant'),
    (SELECT COALESCE(pg_catalog.sum(c.member_count), 0)::bigint FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id AND c.group_kind = 'tenant'),
    (SELECT pg_catalog.max(c.updated_at) FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id),
    EXISTS (SELECT 1 FROM public.embedding_profile_bindings b
      WHERE b.status = 'active' AND (b.tenant_key = p_tenant_key OR b.tenant_key IS NULL)),
    (SELECT pg_catalog.count(*)::integer FROM public.rag_scope_negative_examples x
      WHERE x.tenant_key = p_tenant_key AND x.embedding_profile_id = p_profile_id);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_example_add(
  p_tenant_key text,
  p_profile_id text,
  p_text text,
  p_embedding public.halfvec,
  p_actor uuid
)
RETURNS TABLE (id uuid, created_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
  v_text text := pg_catalog.btrim(COALESCE(p_text, ''));
  v_key text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  v_dims := public.rag_scope_profile_dims(p_profile_id);
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023';
  END IF;
  IF v_text = '' THEN
    RAISE EXCEPTION 'example_empty' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.char_length(v_text) > 500 THEN
    RAISE EXCEPTION 'example_too_long' USING ERRCODE = '22001';
  END IF;
  IF p_embedding IS NULL OR public.vector_dims(p_embedding) <> v_dims THEN
    RAISE EXCEPTION 'embedding does not match the profile' USING ERRCODE = '22023';
  END IF;
  v_key := pg_catalog.lower(pg_catalog.regexp_replace(v_text, '\s+', ' ', 'g'));

  PERFORM pg_catalog.pg_advisory_xact_lock(public.rag_scope_lock_key(p_tenant_key));

  IF EXISTS (SELECT 1 FROM public.rag_scope_negative_examples x
             WHERE x.tenant_key = p_tenant_key AND x.embedding_profile_id = p_profile_id AND x.text_key = v_key) THEN
    RAISE EXCEPTION 'example_duplicate' USING ERRCODE = '23505';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.rag_scope_negative_examples x
      WHERE x.tenant_key = p_tenant_key AND x.embedding_profile_id = p_profile_id) >= 100 THEN
    RAISE EXCEPTION 'example_limit' USING ERRCODE = '54000';
  END IF;

  RETURN QUERY
  INSERT INTO public.rag_scope_negative_examples AS x (tenant_key, text, text_key, embedding_profile_id, embedding, dims, created_by)
  VALUES (p_tenant_key, v_text, v_key, p_profile_id, p_embedding, v_dims, p_actor)
  RETURNING x.id, x.created_at;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_examples_list(p_tenant_key text, p_profile_id text)
RETURNS TABLE (id uuid, text text, embedding public.halfvec, dims integer, created_by uuid, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM public.rag_scope_profile_dims(p_profile_id);
  RETURN QUERY
  SELECT x.id, x.text, x.embedding, x.dims, x.created_by, x.created_at
  FROM public.rag_scope_negative_examples x
  WHERE x.tenant_key = p_tenant_key AND x.embedding_profile_id = p_profile_id
  ORDER BY x.created_at, x.id
  LIMIT 100;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_example_delete(p_tenant_key text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'id is required' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.rag_scope_negative_examples x WHERE x.id = p_id AND x.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END
$fn$;

-- Shared invalidation body: delete the centroid rows of the given tenants (all profiles when p_profile_id is NULL), after taking each
-- tenant's shared advisory lock in key order.
CREATE OR REPLACE FUNCTION public.rag_scope_centroids_invalidate(p_tenant_keys text[], p_profile_id text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
BEGIN
  FOR v_key IN SELECT DISTINCT k FROM pg_catalog.unnest(p_tenant_keys) AS u(k) WHERE k IS NOT NULL ORDER BY k LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(public.rag_scope_lock_key(v_key));
    DELETE FROM public.rag_scope_centroids c
    WHERE c.tenant_key = v_key AND (p_profile_id IS NULL OR c.embedding_profile_id = p_profile_id);
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_documents_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(SELECT DISTINCT n.tenant_key FROM new_rows n WHERE n.tenant_key IS NOT NULL));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_documents_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(
    SELECT DISTINCT t.tenant_key
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.tenant_key), (n.tenant_key)) AS t(tenant_key)
    WHERE t.tenant_key IS NOT NULL
      AND (o.is_current IS DISTINCT FROM n.is_current
        OR o.status IS DISTINCT FROM n.status
        OR o.version IS DISTINCT FROM n.version
        OR o.tenant_key IS DISTINCT FROM n.tenant_key
        OR o.doc_type IS DISTINCT FROM n.doc_type
        OR o.language IS DISTINCT FROM n.language
        OR o.scopes IS DISTINCT FROM n.scopes
        OR o.provisional IS DISTINCT FROM n.provisional
        OR o.superseded_by IS DISTINCT FROM n.superseded_by)
  ));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_documents_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(SELECT DISTINCT o.tenant_key FROM old_rows o WHERE o.tenant_key IS NOT NULL));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_chunks_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(SELECT DISTINCT n.tenant_key FROM new_rows n WHERE n.tenant_key IS NOT NULL));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_chunks_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(
    SELECT DISTINCT t.tenant_key
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.tenant_key), (n.tenant_key)) AS t(tenant_key)
    WHERE t.tenant_key IS NOT NULL
      AND (o.is_current IS DISTINCT FROM n.is_current
        OR o.status IS DISTINCT FROM n.status
        OR o.tenant_key IS DISTINCT FROM n.tenant_key
        OR o.doc_type IS DISTINCT FROM n.doc_type
        OR o.language IS DISTINCT FROM n.language
        OR o.scopes IS DISTINCT FROM n.scopes
        OR o.provisional IS DISTINCT FROM n.provisional
        OR o.chunking_profile_id IS DISTINCT FROM n.chunking_profile_id
        OR (o.embedding IS NULL) IS DISTINCT FROM (n.embedding IS NULL)
        OR (o.embedding IS NOT NULL AND n.embedding IS NOT NULL AND o.embedding OPERATOR(public.<>) n.embedding))
  ));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_chunks_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(SELECT DISTINCT o.tenant_key FROM old_rows o WHERE o.tenant_key IS NOT NULL));
  RETURN NULL;
END
$fn$;

-- chunk_embeddings changes clear only the changed profile's rows of the tenant.
CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT DISTINCT n.tenant_key, n.profile_id FROM new_rows n ORDER BY 1, 2 LOOP
      PERFORM public.rag_scope_centroids_invalidate(ARRAY[r.tenant_key], r.profile_id);
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR r IN SELECT DISTINCT o.tenant_key, o.profile_id FROM old_rows o ORDER BY 1, 2 LOOP
      PERFORM public.rag_scope_centroids_invalidate(ARRAY[r.tenant_key], r.profile_id);
    END LOOP;
  ELSE
    FOR r IN
      SELECT DISTINCT t.tenant_key, t.profile_id
      FROM (SELECT o.tenant_key, o.profile_id FROM old_rows o UNION SELECT n.tenant_key, n.profile_id FROM new_rows n) AS t
      ORDER BY 1, 2
    LOOP
      PERFORM public.rag_scope_centroids_invalidate(ARRAY[r.tenant_key], r.profile_id);
    END LOOP;
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS rag_scope_centroids_documents_insert ON public.documents;
CREATE TRIGGER rag_scope_centroids_documents_insert
  AFTER INSERT ON public.documents
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_documents_insert();

DROP TRIGGER IF EXISTS rag_scope_centroids_documents_update ON public.documents;
CREATE TRIGGER rag_scope_centroids_documents_update
  AFTER UPDATE ON public.documents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_documents_update();

DROP TRIGGER IF EXISTS rag_scope_centroids_documents_delete ON public.documents;
CREATE TRIGGER rag_scope_centroids_documents_delete
  AFTER DELETE ON public.documents
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_documents_delete();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunks_insert ON public.document_chunks;
CREATE TRIGGER rag_scope_centroids_chunks_insert
  AFTER INSERT ON public.document_chunks
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunks_insert();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunks_update ON public.document_chunks;
CREATE TRIGGER rag_scope_centroids_chunks_update
  AFTER UPDATE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunks_update();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunks_delete ON public.document_chunks;
CREATE TRIGGER rag_scope_centroids_chunks_delete
  AFTER DELETE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunks_delete();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunk_embeddings_insert ON public.chunk_embeddings;
CREATE TRIGGER rag_scope_centroids_chunk_embeddings_insert
  AFTER INSERT ON public.chunk_embeddings
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunk_embeddings_update ON public.chunk_embeddings;
CREATE TRIGGER rag_scope_centroids_chunk_embeddings_update
  AFTER UPDATE ON public.chunk_embeddings
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunk_embeddings_delete ON public.chunk_embeddings;
CREATE TRIGGER rag_scope_centroids_chunk_embeddings_delete
  AFTER DELETE ON public.chunk_embeddings
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change();

REVOKE ALL ON FUNCTION public.rag_scope_lock_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_profile_dims(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_rebuild(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_list(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_status(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_example_add(text, text, text, public.halfvec, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_examples_list(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_example_delete(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_invalidate(text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_lock_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_profile_dims(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_rebuild(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_list(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_status(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_example_add(text, text, text, public.halfvec, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_examples_list(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_example_delete(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_invalidate(text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
