-- 0536: rag_mine_failed_queries_report, the run report around rag_mine_failed_queries (Phase 5.1.1, FBK-05, D-15).
-- rag_mine_failed_queries counts an item under each of its reasons, so its rows cannot give the number of items a tenant got.
-- This wrapper runs it, then counts per tenant the review items that the same transaction inserted (mined_at = now(), the
-- transaction start, in the mining window of p_until), and returns the reason rows with that per-tenant total. The count runs in a
-- second statement, so it sees the rows the first one inserted. SECURITY INVOKER: the caller needs EXECUTE on the mining function
-- and SELECT on rag_review_items, which only the service role has. Service role only. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_mine_failed_queries_report(p_since timestamptz, p_until timestamptz, p_config jsonb)
RETURNS TABLE (tenant_key text, reason text, inserted integer, tenant_inserted integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_rows jsonb;
BEGIN
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('tenant_key', m.tenant_key, 'reason', m.reason, 'inserted', m.inserted)), '[]'::jsonb)
  INTO v_rows
  FROM public.rag_mine_failed_queries(p_since, p_until, p_config) AS m;

  RETURN QUERY
  SELECT r.tenant_key, r.reason, r.inserted, coalesce(c.n, 0)::integer
  FROM pg_catalog.jsonb_to_recordset(v_rows) AS r(tenant_key text, reason text, inserted integer)
  LEFT JOIN (
    SELECT i.tenant_key, count(*) AS n
    FROM public.rag_review_items i
    WHERE i.mined_at = pg_catalog.now()
      AND i.mining_window = pg_catalog.date_trunc('week', p_until, 'UTC')
    GROUP BY i.tenant_key
  ) AS c ON c.tenant_key = r.tenant_key
  ORDER BY r.tenant_key, r.reason;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_mine_failed_queries_report(timestamptz, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_mine_failed_queries_report(timestamptz, timestamptz, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
