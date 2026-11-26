-- 0974: rag_review_items_enqueue_re_review, review items with reason re_review (Phase 5.3, D-50).
-- Stub that claims the number; the body follows in the same plan (05.3-27).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue_re_review(p_tenant_key text, p_rows jsonb)
RETURNS integer
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

REVOKE ALL ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
