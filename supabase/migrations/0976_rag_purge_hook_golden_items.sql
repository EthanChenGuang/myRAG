-- 0976: rag_purge_hook_golden_items, the Phase 6.3 DATA-24 purge hook for this phase's per-document stores (Phase 5.3 plan 52).
-- Stub that claims the number; the body follows in the same plan.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_golden_items(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN 0;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_golden_items(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_golden_items(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
