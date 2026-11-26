-- 1009: Phase 3.3 purge hook and tenant rule-data delete (TPL-03, TPL-08, D-02, D-35, F-24).
-- rag_purge_hook_doc_attributes(p_tenant_key, p_lineage_id, p_document_ids): for the tenant's documents of the lineage or the listed ids,
--   sets attributes, attribute_header and attribute_header_stamp to null on the documents and attributes and attribute_header_stamp on their
--   chunks, and deletes the tenant's rag_staged_attributes rows whose (source, source_key) is one of those documents'. Returns the number of
--   rows changed (documents + chunks + staged rows deleted). Phase 6.3 calls it from its purge (hand-off 03.3-24-phase63-purge).
-- rag_tenant_rule_data_delete(p_tenant_key): deletes the tenant's rows from the five Phase 3.3 tables, one result row per table in a fixed
--   order; documents and chunks are not touched. Nothing calls it yet (hand-off 03.3-24-tenant-delete).
-- Security: both functions are SECURITY INVOKER with an empty search_path, assert the tenant key first (a key of the other deployment mode
--   is rejected), name the tenant in every predicate, are revoked from PUBLIC, anon and authenticated and granted to service_role only.
-- rag_purge_store_inventory does not exist on trunk (branch b), so this file adds no inventory row.
-- Idempotent; not folded into the setup files.

BEGIN;

DO $phase33_purge_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_staged_attributes') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL THEN
    RAISE EXCEPTION '1009: apply 1001 first' USING ERRCODE = '55000';
  END IF;
END
$phase33_purge_precheck$;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_doc_attributes(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_docs uuid[];
  v_documents bigint;
  v_chunks bigint;
  v_staged bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT COALESCE(pg_catalog.array_agg(d.id), '{}'::uuid[]) INTO v_docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND (d.lineage_id = p_lineage_id OR d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[])));
  DELETE FROM public.rag_staged_attributes s
   USING public.documents d
   WHERE s.tenant_key = p_tenant_key
     AND d.tenant_key = p_tenant_key
     AND d.id = ANY (v_docs)
     AND s.source = d.source
     AND s.source_key = d.source_key;
  GET DIAGNOSTICS v_staged = ROW_COUNT;
  UPDATE public.documents d
     SET attributes = NULL, attribute_header = NULL, attribute_header_stamp = NULL
   WHERE d.tenant_key = p_tenant_key
     AND d.id = ANY (v_docs)
     AND (d.attributes IS NOT NULL OR d.attribute_header IS NOT NULL OR d.attribute_header_stamp IS NOT NULL);
  GET DIAGNOSTICS v_documents = ROW_COUNT;
  UPDATE public.document_chunks c
     SET attributes = NULL, attribute_header_stamp = NULL
   WHERE c.tenant_key = p_tenant_key
     AND c.document_id = ANY (v_docs)
     AND (c.attributes IS NOT NULL OR c.attribute_header_stamp IS NOT NULL);
  GET DIAGNOSTICS v_chunks = ROW_COUNT;
  RETURN v_documents + v_chunks + v_staged;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_doc_attributes(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_doc_attributes(text, uuid, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_tenant_rule_data_delete(p_tenant_key text)
RETURNS TABLE (relation text, deleted bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  DELETE FROM public.rag_section_rule_sets t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_section_rule_sets'; deleted := v_count; RETURN NEXT;

  DELETE FROM public.rag_boilerplate_rules t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_boilerplate_rules'; deleted := v_count; RETURN NEXT;

  DELETE FROM public.rag_attribute_definitions t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_attribute_definitions'; deleted := v_count; RETURN NEXT;

  DELETE FROM public.rag_attribute_header_templates t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_attribute_header_templates'; deleted := v_count; RETURN NEXT;

  DELETE FROM public.rag_staged_attributes t WHERE t.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  relation := 'rag_staged_attributes'; deleted := v_count; RETURN NEXT;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_tenant_rule_data_delete(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_tenant_rule_data_delete(text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
