-- 0987: scope centroids honour access groups (Phase 6.2 verification R-4, QRY-14, SEC-12). While access groups are enforced
-- (rag_access_enforced()), rag_scope_centroids_rebuild counts a chunk only when both it and its document carry access_groups = {all}. A
-- restricted document therefore never moves a centroid, never creates a doc-type or scope-tag group key and never changes a member count,
-- so the in/out score of a member outside its group cannot reveal that it exists or what it is about. With enforcement off every member
-- counts as before (0983). Negative examples are admin-entered texts, not derived from documents, and are unchanged. Invalidation (P-27) is
-- extended: the documents and document_chunks update triggers also fire on access_groups changes, and a statement trigger on
-- rag_access_group_settings clears every tenant's centroids when the enforced flag changes (an update that flips it, or an inserted or
-- deleted row with enforced true; a re-run of 0920's ON CONFLICT DO NOTHING insert clears nothing), taking each tenant's shared advisory
-- lock as 0983 does; the rebuild reads the flag after its exclusive lock, so a rebuild that overlaps a flip either sees it or is cleared by
-- it. Bodies rebased on 0983; SET search_path = '', schema-qualified names, revoked from PUBLIC, anon and authenticated, service_role only.
-- Common to both deployment modes. Idempotent; not folded into the setup files.

BEGIN;

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
  v_enforced boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  v_dims := public.rag_scope_profile_dims(p_profile_id);
  SELECT p.storage = 'legacy_column' INTO v_legacy FROM public.embedding_profiles p WHERE p.id = p_profile_id;

  PERFORM pg_catalog.pg_advisory_xact_lock(public.rag_scope_lock_key(p_tenant_key));
  v_enforced := COALESCE(public.rag_access_enforced(), true);

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
      AND (NOT v_enforced
        OR (d.access_groups OPERATOR(pg_catalog.=) ARRAY['all']::text[] AND c.access_groups OPERATOR(pg_catalog.=) ARRAY['all']::text[]))
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
        OR o.superseded_by IS DISTINCT FROM n.superseded_by
        OR o.access_groups IS DISTINCT FROM n.access_groups)
  ));
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
        OR o.access_groups IS DISTINCT FROM n.access_groups
        OR (o.embedding IS NULL) IS DISTINCT FROM (n.embedding IS NULL)
        OR (o.embedding IS NOT NULL AND n.embedding IS NOT NULL AND o.embedding OPERATOR(public.<>) n.embedding))
  ));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_access_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_changed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      SELECT 1 FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE o.enforced IS DISTINCT FROM n.enforced
    ) INTO v_changed;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM new_rows n WHERE n.enforced) INTO v_changed;
  ELSE
    SELECT EXISTS (SELECT 1 FROM old_rows o WHERE o.enforced) INTO v_changed;
  END IF;
  IF v_changed THEN
    PERFORM public.rag_scope_centroids_invalidate(ARRAY(
      SELECT c.tenant_key FROM public.rag_scope_centroids c WHERE c.tenant_key IS NOT NULL
      UNION
      SELECT d.tenant_key FROM public.documents d WHERE d.tenant_key IS NOT NULL
    ));
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS rag_scope_centroids_access_settings_update ON public.rag_access_group_settings;
CREATE TRIGGER rag_scope_centroids_access_settings_update
  AFTER UPDATE ON public.rag_access_group_settings
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_access_settings_change();

DROP TRIGGER IF EXISTS rag_scope_centroids_access_settings_insert ON public.rag_access_group_settings;
CREATE TRIGGER rag_scope_centroids_access_settings_insert
  AFTER INSERT ON public.rag_access_group_settings
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_access_settings_change();

DROP TRIGGER IF EXISTS rag_scope_centroids_access_settings_delete ON public.rag_access_group_settings;
CREATE TRIGGER rag_scope_centroids_access_settings_delete
  AFTER DELETE ON public.rag_access_group_settings
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_access_settings_change();

REVOKE ALL ON FUNCTION public.rag_scope_centroids_rebuild(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_access_settings_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_rebuild(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_access_settings_change() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
