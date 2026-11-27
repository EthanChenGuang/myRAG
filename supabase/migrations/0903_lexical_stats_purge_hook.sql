-- 0903: Phase 4.4 reserved purge hook of the per-tenant lexical statistics for the Phase 6.3 purge (LEX-06, D-33).
-- rag_purge_hook_lexical_stats(p_tenant_key, p_lineage_id, p_document_ids) RETURNS bigint. The statistics (rag_lexical_df,
-- rag_lexical_corpus) hold no document id: when the purge deletes a version's chunks, the 0901 delete trigger stages one -1 row per
-- member chunk in rag_lexical_stats_pending, and this hook folds the tenant's staged rows through rag_lexstats_compact (0902) until none
-- is left (at most 200 batches of 5000), returning the number of pending rows folded. Counters that reach zero are deleted, so a tenant
-- with no member chunk left keeps no counter row. Phase 6.3 calls it by name (counts key lexical_stats); called before the chunk delete
-- it folds only what is already staged, so it must be called again after the chunk delete.
-- The hook checks the tenant key first (rag_assert_tenant_key) and refuses (22023) a listed id whose document belongs to another tenant
-- or, when p_lineage_id is given, to another lineage; ids of documents that no longer exist are accepted. A tenant without a state row
-- returns 0 and writes nothing. rag_purge_store_inventory() (Phase 6.3, 0728) is absent on trunk, so this file adds no inventory row
-- (hand-off: .planning/phases/04.4-true-bm25-lexical-scoring/handoffs/04.4-07-purge-inventory.md).
-- SECURITY INVOKER with an empty search_path; service_role only. Idempotent; not folded into the setup files.

BEGIN;

DO $lexical_stats_purge_hook_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_compact(text, integer)') IS NULL THEN
    RAISE EXCEPTION '0903: apply migrations 0401, 0900, 0901 and 0902 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_stats_purge_hook_precheck$;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_lexical_stats(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_folded bigint;
  v_total bigint := 0;
  v_round integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      AND (d.tenant_key IS DISTINCT FROM p_tenant_key OR (p_lineage_id IS NOT NULL AND d.lineage_id IS DISTINCT FROM p_lineage_id))
  ) THEN
    RAISE EXCEPTION 'rag_purge_hook_lexical_stats: a document id is outside the tenant or lineage' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RETURN 0;
  END IF;
  LOOP
    v_round := v_round + 1;
    v_folded := public.rag_lexstats_compact(p_tenant_key, 5000);
    v_total := v_total + v_folded;
    EXIT WHEN v_folded = 0 OR v_round >= 200;
  END LOOP;
  RETURN v_total;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_lexical_stats(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_lexical_stats(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
