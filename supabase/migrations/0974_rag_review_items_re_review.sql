-- 0974: rag_review_items_enqueue_re_review, review items with reason re_review for the yearly re-review cycle (Phase 5.3, D-50).
-- p_rows: [{ query_masked, query_fingerprint, language?, channel?, mining_window }]. Every row is stored under p_tenant_key (a
-- tenant named in a row is ignored) with reasons {re_review}, status open and no strata row; ON CONFLICT DO NOTHING on the Phase
-- 5.1.1 key (tenant_key, query_fingerprint, mining_window), so a repeat inserts nothing. Returns the number inserted.
-- A malformed payload raises 22023 and writes nothing. The tenant key is checked first by rag_assert_tenant_key.
-- Without the Phase 5.1.1 review queue the function returns 0 (to_regclass guard). SECURITY INVOKER, empty search_path,
-- service_role only (O-3). Idempotent, not folded (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue_re_review(p_tenant_key text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows_not_array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
     WHERE pg_catalog.jsonb_typeof(e.value) <> 'object'
        OR COALESCE(e.value ->> 'query_masked', '') = ''
        OR COALESCE(e.value ->> 'query_fingerprint', '') = ''
        OR COALESCE(e.value ->> 'mining_window', '') = ''
  ) THEN
    RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023';
  END IF;

  EXECUTE $sql$
    WITH written AS (
      INSERT INTO public.rag_review_items AS i (
        tenant_key, query_masked, query_fingerprint, query_language, channel, reasons, status, mining_window, mined_at
      )
      SELECT $1, e.value ->> 'query_masked', e.value ->> 'query_fingerprint', NULLIF(e.value ->> 'language', ''),
             NULLIF(e.value ->> 'channel', ''), ARRAY['re_review']::text[], 'open', (e.value ->> 'mining_window')::timestamptz,
             pg_catalog.now()
        FROM pg_catalog.jsonb_array_elements($2) AS e(value)
      ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
      RETURNING 1
    )
    SELECT pg_catalog.count(*)::integer FROM written
  $sql$ INTO v_count USING p_tenant_key, p_rows;

  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
