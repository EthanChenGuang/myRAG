-- 0862: rag_dup_cluster_sources(p_tenant_key, p_cluster_ids, p_limit) lists the source documents of duplicate clusters (RET-13, D-21, D-56).
-- One row per cluster and member document: the document id, its filename and the member chunk with the lowest chunk index (then id).
-- Only current, ready, non-provisional chunks of current, ready, non-provisional documents of the caller's tenant are listed, and the
-- cluster itself must belong to that tenant, so a cluster id of another tenant returns nothing. At most p_limit documents per cluster, in
-- filename then document id order. The tenant comes only from p_tenant_key, checked first by rag_assert_tenant_key (Phase 4 D-04).
-- More than 50 cluster ids or a limit outside 1..30 raises 22023. SECURITY INVOKER with an empty search_path; service_role only.
-- Reads existing tables only (no new store, so no purge hook). Idempotent; not folded into the setup files.

BEGIN;

DO $dup_cluster_sources_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_dup_clusters') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL THEN
    RAISE EXCEPTION '0862: apply migrations 0401 and 0853 first' USING ERRCODE = '55000';
  END IF;
END
$dup_cluster_sources_precheck$;

CREATE OR REPLACE FUNCTION public.rag_dup_cluster_sources(p_tenant_key text, p_cluster_ids uuid[], p_limit integer)
RETURNS TABLE (
  cluster_id uuid,
  document_id uuid,
  filename text,
  chunk_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 30 THEN
    RAISE EXCEPTION 'rag_dup_cluster_sources: limit must be within 1..30' USING ERRCODE = '22023';
  END IF;
  IF p_cluster_ids IS NULL OR pg_catalog.cardinality(p_cluster_ids) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_cluster_ids) > 50 THEN
    RAISE EXCEPTION 'rag_dup_cluster_sources: at most 50 cluster ids' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT r.cluster_id, r.document_id, r.filename, r.chunk_id
  FROM (
    SELECT m.cluster_id, m.document_id, m.filename, m.chunk_id,
           pg_catalog.row_number() OVER (PARTITION BY m.cluster_id ORDER BY m.filename, m.document_id) AS n
    FROM (
      SELECT DISTINCT ON (c.dup_cluster_id, c.document_id)
             c.dup_cluster_id AS cluster_id, c.document_id, d.filename, c.id AS chunk_id
      FROM public.document_chunks c
      JOIN public.rag_dup_clusters k ON k.id = c.dup_cluster_id AND k.tenant_key = p_tenant_key
      JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
      WHERE c.tenant_key = p_tenant_key
        AND c.dup_cluster_id = ANY (p_cluster_ids)
        AND c.is_current
        AND c.status IN ('ready', 'variant')
        AND NOT c.provisional
        AND d.is_current
        AND d.status = 'ready'
        AND NOT d.provisional
      ORDER BY c.dup_cluster_id, c.document_id, c.chunk_index, c.id
    ) m
  ) r
  WHERE r.n <= p_limit
  ORDER BY r.cluster_id, r.n;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_dup_cluster_sources(text, uuid[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_dup_cluster_sources(text, uuid[], integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
