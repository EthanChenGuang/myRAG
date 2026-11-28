-- 0853: Phase 4.2 duplicate cluster schema (DATA-21, D-18, D-20).
-- document_chunks gains dup_cluster_id and simhash (both null until the grouping step of plan 04.2-13 writes them). rag_dup_clusters holds
-- one row per cluster of one tenant and embedding profile. A cluster never spans tenants: the chunk's (tenant_key, dup_cluster_id) is a
-- foreign key to the cluster's (tenant_key, id), so a chunk can only point to a cluster of its own tenant, and deleting a cluster clears only
-- dup_cluster_id on its chunks. A chunk with a cluster must carry a tenant_key (a check), so the key is never skipped by a null tenant.
-- Statement triggers mark a chunk's former cluster dirty when the chunk is deleted or its is_current or status changes; recompute
-- (rag_dup_clusters_recompute) and the LSH band layout belong to plan 04.2-13. RLS is on with no policies; only service_role reaches the
-- table, and a guard checks the tenant key format of the deployment mode (rag_assert_tenant_key).
-- Purge: rag_purge_hook_dup_clusters(p_tenant_key, p_lineage_id, p_document_ids) clears the cluster fields of the purged documents' chunks,
-- removes those documents from the tenant's clusters and marks the clusters dirty.
-- Existing rows keep null in both new columns. Idempotent; not folded into the setup files.

BEGIN;

DO $dup_clusters_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.document_chunks') AND a.attname = 'tenant_key' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0853: apply the earlier migrations first (0301, 0401)' USING ERRCODE = '55000';
  END IF;
END
$dup_clusters_precheck$;

ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS dup_cluster_id uuid;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS simhash bigint;

CREATE TABLE IF NOT EXISTS public.rag_dup_clusters (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  embedding_profile_id text NOT NULL,
  member_count integer NOT NULL DEFAULT 0,
  source_document_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  representative_chunk_id uuid REFERENCES public.document_chunks (id) ON DELETE SET NULL,
  dirty boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_dup_clusters_member_count_check CHECK (member_count >= 0),
  CONSTRAINT rag_dup_clusters_profile_check CHECK (pg_catalog.length(embedding_profile_id) BETWEEN 1 AND 200),
  CONSTRAINT rag_dup_clusters_tenant_id_ux UNIQUE (tenant_key, id)
);

CREATE INDEX IF NOT EXISTS rag_dup_clusters_tenant_profile_idx ON public.rag_dup_clusters (tenant_key, embedding_profile_id);
CREATE INDEX IF NOT EXISTS rag_dup_clusters_dirty_idx ON public.rag_dup_clusters (tenant_key) WHERE dirty;

ALTER TABLE public.rag_dup_clusters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_dup_clusters FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_dup_clusters TO service_role;

-- Tenant binding (D-18). ON DELETE SET NULL (dup_cluster_id) keeps the chunk's tenant_key.
DO $dup_clusters_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_chunks'::pg_catalog.regclass AND conname = 'document_chunks_dup_cluster_tenant_fk'
  ) THEN
    ALTER TABLE public.document_chunks
      ADD CONSTRAINT document_chunks_dup_cluster_tenant_fk
      FOREIGN KEY (tenant_key, dup_cluster_id) REFERENCES public.rag_dup_clusters (tenant_key, id) ON DELETE SET NULL (dup_cluster_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_chunks'::pg_catalog.regclass AND conname = 'document_chunks_dup_cluster_tenant_check'
  ) THEN
    ALTER TABLE public.document_chunks
      ADD CONSTRAINT document_chunks_dup_cluster_tenant_check CHECK (dup_cluster_id IS NULL OR tenant_key IS NOT NULL);
  END IF;
END
$dup_clusters_fk$;

CREATE INDEX IF NOT EXISTS idx_document_chunks_dup_cluster ON public.document_chunks (dup_cluster_id) WHERE dup_cluster_id IS NOT NULL;

-- Tenant key format guard, shared with 0854: rejects a malformed key or one of the other deployment mode. SECURITY INVOKER (D-56).
CREATE OR REPLACE FUNCTION public.rag_row_tenant_key_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(NEW.tenant_key);
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_row_tenant_key_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_row_tenant_key_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_dup_clusters_tenant_key_guard ON public.rag_dup_clusters;
CREATE TRIGGER rag_dup_clusters_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_dup_clusters
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

-- Dirty marking (D-20). SECURITY DEFINER because the role that deletes or updates a chunk cannot write the server-only table. The functions
-- take no caller input: they read only the transition rows, and every update names the tenant of the old row.

CREATE OR REPLACE FUNCTION public.rag_dup_clusters_mark_dirty_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM old_rows o WHERE o.dup_cluster_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  UPDATE public.rag_dup_clusters k
     SET dirty = true, updated_at = pg_catalog.now()
    FROM (SELECT DISTINCT o.tenant_key, o.dup_cluster_id FROM old_rows o WHERE o.dup_cluster_id IS NOT NULL AND o.tenant_key IS NOT NULL) g
   WHERE k.id = g.dup_cluster_id
     AND k.tenant_key = g.tenant_key;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_dup_clusters_mark_dirty_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM old_rows o WHERE o.dup_cluster_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  UPDATE public.rag_dup_clusters k
     SET dirty = true, updated_at = pg_catalog.now()
    FROM (
      SELECT DISTINCT o.tenant_key, o.dup_cluster_id
        FROM old_rows o
        JOIN new_rows n ON n.id = o.id
       WHERE o.dup_cluster_id IS NOT NULL
         AND o.tenant_key IS NOT NULL
         AND (o.is_current, o.status) IS DISTINCT FROM (n.is_current, n.status)
    ) g
   WHERE k.id = g.dup_cluster_id
     AND k.tenant_key = g.tenant_key;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_dup_clusters_mark_dirty_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_dup_clusters_mark_dirty_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_dup_clusters_mark_dirty_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_dup_clusters_mark_dirty_update() TO service_role;

DROP TRIGGER IF EXISTS rag_dup_clusters_mark_dirty_delete ON public.document_chunks;
CREATE TRIGGER rag_dup_clusters_mark_dirty_delete
  AFTER DELETE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_dup_clusters_mark_dirty_delete();

DROP TRIGGER IF EXISTS rag_dup_clusters_mark_dirty_update ON public.document_chunks;
CREATE TRIGGER rag_dup_clusters_mark_dirty_update
  AFTER UPDATE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_dup_clusters_mark_dirty_update();

-- Purge hook (phase rule: every new 4.2 store). Returns the number of chunk and cluster rows changed.
CREATE OR REPLACE FUNCTION public.rag_purge_hook_dup_clusters(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_docs uuid[];
  v_chunks bigint;
  v_clusters bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT COALESCE(pg_catalog.array_agg(d.id), '{}'::uuid[]) INTO v_docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND (d.lineage_id = p_lineage_id OR d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[])));
  UPDATE public.rag_dup_clusters k
     SET source_document_ids = COALESCE(
           (SELECT pg_catalog.array_agg(s.id ORDER BY s.ord) FROM pg_catalog.unnest(k.source_document_ids) WITH ORDINALITY AS s(id, ord)
             WHERE NOT (s.id = ANY (v_docs))),
           '{}'::uuid[]),
         dirty = true,
         updated_at = pg_catalog.now()
   WHERE k.tenant_key = p_tenant_key
     AND (k.source_document_ids OPERATOR(pg_catalog.&&) v_docs
       OR k.id IN (SELECT c.dup_cluster_id FROM public.document_chunks c WHERE c.tenant_key = p_tenant_key AND c.document_id = ANY (v_docs)));
  GET DIAGNOSTICS v_clusters = ROW_COUNT;
  UPDATE public.document_chunks c
     SET dup_cluster_id = NULL, simhash = NULL
   WHERE c.tenant_key = p_tenant_key
     AND c.document_id = ANY (v_docs)
     AND (c.dup_cluster_id IS NOT NULL OR c.simhash IS NOT NULL);
  GET DIAGNOSTICS v_chunks = ROW_COUNT;
  RETURN v_chunks + v_clusters;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_dup_clusters(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_dup_clusters(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
