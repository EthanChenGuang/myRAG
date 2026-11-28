-- 0533: rag_purge_retrieval_log deletes retrieval log rows older than the retention window in bounded batches (Phase 5.1.1, D-06).
-- Oldest first, at most p_batch_size rows per call; returns the number deleted. Callers repeat until it returns 0.
-- Called by the weekly mining job, `npm run rag:feedback-loop purge` and the optional pg_cron file. Service role only. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_purge_retrieval_log(p_retention_days integer, p_batch_size integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1 THEN
    RAISE EXCEPTION 'rag_purge_retrieval_log: p_retention_days must be at least 1' USING ERRCODE = '22023';
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'rag_purge_retrieval_log: p_batch_size must be between 1 and 10000' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.rag_retrieval_log l
  WHERE l.ctid IN (
    SELECT r.ctid
    FROM public.rag_retrieval_log r
    WHERE r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days)
    ORDER BY r.created_at
    LIMIT p_batch_size
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_retrieval_log(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_retrieval_log(integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
