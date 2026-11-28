-- 0864: Phase 4.2 reserved purge hooks for the Phase 6.3 purge (RET-12, DATA-21, RET-15, D-20, D-56).
-- rag_purge_hook_table_rows(p_tenant_key, p_lineage_id, p_document_ids) deletes the rag_table_rows of the listed document versions of that
-- tenant (redefines the 0852 body: SECURITY INVOKER, listed versions only). rag_purge_hook_duplicate_clusters(...) takes the listed versions
-- out of every duplicate cluster of that tenant: their chunks' dup_cluster_id and simhash, their chunks' rag_dup_chunk_bands rows and their
-- ids in rag_dup_clusters.source_document_ids; the touched clusters are recomputed (rag_dup_clusters_recompute, 0857), so a cluster left with
-- one member dissolves. It returns the number of chunk memberships removed. Phase 6.3 calls both by name (counts keys table_rows and
-- duplicate_groups). The identifier index (RET-15) lives on document_chunks and documents columns and goes with those rows; the
-- rag_identifier_patterns tenant settings have no document reference, so they need no hook.
-- Both hooks check the tenant key first (rag_assert_tenant_key) and refuse (22023) a listed id whose document belongs to another tenant or,
-- when p_lineage_id is given, to another lineage; ids of documents that no longer exist are skipped. Every statement names the tenant.
-- SECURITY INVOKER with an empty search_path; service_role only. The 0853 and 0857 hooks (rag_purge_hook_dup_clusters,
-- rag_purge_hook_dup_chunk_bands) stay as they are. Idempotent; not folded into the setup files.

BEGIN;

DO $purge_hooks_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regclass('public.rag_table_rows') IS NULL
     OR pg_catalog.to_regclass('public.rag_dup_chunk_bands') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_dup_clusters_recompute(text, uuid[])') IS NULL THEN
    RAISE EXCEPTION '0864: apply migrations 0401, 0852, 0853 and 0857 first' USING ERRCODE = '55000';
  END IF;
END
$purge_hooks_precheck$;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_table_rows(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_docs uuid[];
  v_removed bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      AND (d.tenant_key IS DISTINCT FROM p_tenant_key OR (p_lineage_id IS NOT NULL AND d.lineage_id IS DISTINCT FROM p_lineage_id))
  ) THEN
    RAISE EXCEPTION 'rag_purge_hook_table_rows: a document id is outside the tenant or lineage' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(d.id), '{}'::uuid[]) INTO v_docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[]));
  IF pg_catalog.cardinality(v_docs) = 0 THEN
    RETURN 0;
  END IF;
  DELETE FROM public.rag_table_rows r
   WHERE r.tenant_key = p_tenant_key
     AND r.document_id = ANY (v_docs);
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_duplicate_clusters(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_docs uuid[];
  v_clusters uuid[];
  v_removed bigint;
  v_offset integer := 1;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      AND (d.tenant_key IS DISTINCT FROM p_tenant_key OR (p_lineage_id IS NOT NULL AND d.lineage_id IS DISTINCT FROM p_lineage_id))
  ) THEN
    RAISE EXCEPTION 'rag_purge_hook_duplicate_clusters: a document id is outside the tenant or lineage' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(d.id), '{}'::uuid[]) INTO v_docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[]));
  IF pg_catalog.cardinality(v_docs) = 0 THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT t.id ORDER BY t.id), '{}'::uuid[]) INTO v_clusters
  FROM (
    SELECT c.dup_cluster_id AS id FROM public.document_chunks c
    WHERE c.tenant_key = p_tenant_key AND c.document_id = ANY (v_docs) AND c.dup_cluster_id IS NOT NULL
    UNION
    SELECT k.id FROM public.rag_dup_clusters k
    WHERE k.tenant_key = p_tenant_key AND k.source_document_ids OPERATOR(pg_catalog.&&) v_docs
  ) t;

  SELECT pg_catalog.count(*) INTO v_removed
  FROM public.document_chunks c
  WHERE c.tenant_key = p_tenant_key AND c.document_id = ANY (v_docs) AND c.dup_cluster_id IS NOT NULL;

  UPDATE public.document_chunks c
     SET dup_cluster_id = NULL, simhash = NULL
   WHERE c.tenant_key = p_tenant_key
     AND c.document_id = ANY (v_docs)
     AND (c.dup_cluster_id IS NOT NULL OR c.simhash IS NOT NULL);

  DELETE FROM public.rag_dup_chunk_bands b
   USING public.document_chunks c
   WHERE b.chunk_id = c.id
     AND b.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key
     AND c.document_id = ANY (v_docs);

  IF pg_catalog.cardinality(v_clusters) > 0 THEN
    UPDATE public.rag_dup_clusters k
       SET source_document_ids = COALESCE(
             (SELECT pg_catalog.array_agg(s.id ORDER BY s.ord) FROM pg_catalog.unnest(k.source_document_ids) WITH ORDINALITY AS s(id, ord)
               WHERE NOT (s.id = ANY (v_docs))),
             '{}'::uuid[]),
           dirty = true,
           updated_at = pg_catalog.now()
     WHERE k.tenant_key = p_tenant_key
       AND k.id = ANY (v_clusters);
    WHILE v_offset <= pg_catalog.cardinality(v_clusters) LOOP
      PERFORM 1 FROM public.rag_dup_clusters_recompute(p_tenant_key, v_clusters[v_offset:v_offset + 999]);
      v_offset := v_offset + 1000;
    END LOOP;
  END IF;

  RETURN v_removed;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_table_rows(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_hook_duplicate_clusters(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_table_rows(text, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_duplicate_clusters(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
