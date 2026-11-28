-- 0992: rag_purge_hook_finetune, the Phase 6.3 purge hook for the Phase 6.1 fine-tune stores (FT-01, FT-10, D-29; 06.1 verification IW-1).
-- The tenant-keyed stores are rag_finetune_consent (one row per tenant) and embedding_model_versions.tenant_keys (the tenants a version
-- was trained on). Neither holds a document id, and the registry cannot tell which documents a version's training set held, so:
--   * a document purge (p_lineage_id or p_document_ids given) taints every version trained on the tenant that is not tainted yet: its
--     weights may hold the purged text. The consent row and the keys stay. Listed ids of another tenant's documents are refused (22023);
--     ids of documents that no longer exist are accepted.
--   * a tenant purge (no lineage and no document ids) deletes the tenant's consent row, taints every version trained on it and removes
--     its key from their tenant_keys.
-- Taint goes through the status column, so the 0654 taint trigger drops slot evidence and deactivates serving bindings as for a revoke;
-- a version that is ACTIVE keeps serving until rollback (D-25), as after a revoke. A tainted version may be left with no tenant key, so
-- the two tenant_keys constraints of 0651 now allow an empty list once tainted_at is set. Returns consent rows deleted plus versions
-- changed. The hook checks the tenant key first (rag_assert_tenant_key: a key of the other deployment mode raises 22023).
-- SECURITY INVOKER (inside the 6.3 purge it runs with that definer's rights); empty search_path; service_role only.
-- Additive and idempotent. Not folded into the setup files.

BEGIN;

DO $finetune_purge_hook_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regclass('public.rag_finetune_consent') IS NULL
     OR pg_catalog.to_regclass('public.embedding_model_versions') IS NULL THEN
    RAISE EXCEPTION '0992: apply 0403 and 0651 first' USING ERRCODE = '55000';
  END IF;
END
$finetune_purge_hook_precheck$;

ALTER TABLE public.embedding_model_versions DROP CONSTRAINT IF EXISTS embedding_model_versions_tenant_keys_shape;
ALTER TABLE public.embedding_model_versions ADD CONSTRAINT embedding_model_versions_tenant_keys_shape CHECK (
  (pg_catalog.cardinality(tenant_keys) = 0 AND tainted_at IS NOT NULL)
  OR (
    pg_catalog.cardinality(tenant_keys) >= 1
    AND pg_catalog.array_to_string(tenant_keys, ',', '?') ~
      '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(,(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))*$'
  )
);
ALTER TABLE public.embedding_model_versions DROP CONSTRAINT IF EXISTS embedding_model_versions_tenant_scope_single;
ALTER TABLE public.embedding_model_versions ADD CONSTRAINT embedding_model_versions_tenant_scope_single CHECK (
  scope <> 'tenant' OR pg_catalog.cardinality(tenant_keys) = 1 OR (pg_catalog.cardinality(tenant_keys) = 0 AND tainted_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION public.rag_purge_hook_finetune(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_tenant_purge boolean;
  v_consent bigint := 0;
  v_versions bigint := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  v_tenant_purge := p_lineage_id IS NULL AND coalesce(pg_catalog.cardinality(p_document_ids), 0) = 0;

  IF NOT v_tenant_purge AND EXISTS (
    SELECT 1
    FROM public.documents d
    WHERE (d.id = ANY (coalesce(p_document_ids, '{}'::uuid[])) OR (p_lineage_id IS NOT NULL AND d.lineage_id = p_lineage_id))
      AND d.tenant_key IS DISTINCT FROM p_tenant_key
  ) THEN
    RAISE EXCEPTION 'purge_refused: a listed document belongs to another tenant' USING ERRCODE = '22023';
  END IF;

  IF v_tenant_purge THEN
    DELETE FROM public.rag_finetune_consent c WHERE c.tenant_key = p_tenant_key;
    GET DIAGNOSTICS v_consent = ROW_COUNT;

    UPDATE public.embedding_model_versions v
    SET status = 'tainted',
        tainted_at = coalesce(v.tainted_at, pg_catalog.now()),
        tenant_keys = pg_catalog.array_remove(v.tenant_keys, p_tenant_key),
        updated_at = pg_catalog.now()
    WHERE p_tenant_key = ANY (v.tenant_keys);
    GET DIAGNOSTICS v_versions = ROW_COUNT;
  ELSE
    UPDATE public.embedding_model_versions v
    SET status = 'tainted', tainted_at = pg_catalog.now(), updated_at = pg_catalog.now()
    WHERE p_tenant_key = ANY (v.tenant_keys)
      AND v.status <> 'tainted';
    GET DIAGNOSTICS v_versions = ROW_COUNT;
  END IF;

  RETURN v_consent + v_versions;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_finetune(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_finetune(text, uuid, uuid[]) TO service_role;

-- Phase 6.3 store inventory. Guarded as in 0976: this file creates no Phase 6.3 object. rag_purge_store_inventory() is not on trunk,
-- so the block only reports; Phase 6.3 (06.3-19) lists rag_finetune_consent and embedding_model_versions (store finetune, handling
-- purge_step) itself.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_purge_store_inventory()') IS NULL THEN
    RAISE NOTICE '[0992] rag_purge_store_inventory() is missing; registration left to Phase 6.3';
    RETURN;
  END IF;
  RAISE NOTICE '[0992] rag_purge_store_inventory() exists; it lists the finetune stores itself';
END
$do$;

NOTIFY pgrst, 'reload schema';

COMMIT;
