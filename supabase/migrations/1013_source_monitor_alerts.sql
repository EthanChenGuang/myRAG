-- 1013: Phase 6.3 gap closure G2 (quick 63-gaps; D-10, DATA-23, RET-14 on the Phase 5.3 OBS-03 store).
-- rag_monitor_alerts (0963) accepts the source-sync rules source_reconcile_paused, source_reconcile_overdue, source_reconcile_failed and
--   source_reconcile_incomplete (kind source_sync, raised by raiseSourceAlert while RAG_MONITOR is on) and the daily rule
--   stale_index_drop_rate (kind stale_index_drop). The vocabularies are the 0963 lists plus these; they mirror the MonitorAlert contract.
-- rag_retrieval_log (0531) gains source_rechecked and stale_index_drop: the source recheck's checked and dropped candidate counts,
--   written only when the recheck completed (both NULL otherwise, so a row written with the recheck off is unchanged). Counts only.
-- rag_monitor_stale_index_drop(p_day): per tenant, the logged retrievals of that UTC day with a completed recheck and their checked and
--   dropped sums, for the daily rule. SECURITY INVOKER, empty search_path, service_role only.
-- Numbered after 0963 so a fresh apply in number order finds rag_monitor_alerts. Precheck (55000): 0531 and 0963 are applied.
-- Operator rule: after re-running 0963, re-run this file. Idempotent; one common file for both modes; not folded.

BEGIN;

DO $precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_monitor_alerts') IS NULL OR pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL THEN
    RAISE EXCEPTION '1013: apply 0531 and 0963 first' USING ERRCODE = '55000';
  END IF;
END
$precheck$;

ALTER TABLE public.rag_monitor_alerts DROP CONSTRAINT IF EXISTS rag_monitor_alerts_rule_check;
ALTER TABLE public.rag_monitor_alerts ADD CONSTRAINT rag_monitor_alerts_rule_check CHECK (rule IN (
  'refusal_rate', 'zero_result_rate', 'below_threshold_rate', 'not_helpful_rate', 'groundedness_flagged_rate',
  'kb_error_rate', 'kb_degraded_rate', 'kb_unavailable_rate', 'top_score_psi', 'latency_p95', 'online_judge_mean',
  'test_set_not_representative', 'offline_online_gap', 'language_drop',
  'source_reconcile_paused', 'source_reconcile_overdue', 'source_reconcile_failed', 'source_reconcile_incomplete',
  'stale_index_drop_rate'
));
ALTER TABLE public.rag_monitor_alerts DROP CONSTRAINT IF EXISTS rag_monitor_alerts_kind_check;
ALTER TABLE public.rag_monitor_alerts ADD CONSTRAINT rag_monitor_alerts_kind_check CHECK (kind IN (
  'rate', 'distribution', 'latency', 'judge_mean', 'drift', 'offline_online_gap', 'language_drop',
  'source_sync', 'stale_index_drop'
));

ALTER TABLE public.rag_retrieval_log ADD COLUMN IF NOT EXISTS source_rechecked integer NULL;
ALTER TABLE public.rag_retrieval_log ADD COLUMN IF NOT EXISTS stale_index_drop integer NULL;
ALTER TABLE public.rag_retrieval_log DROP CONSTRAINT IF EXISTS rag_retrieval_log_source_recheck_check;
ALTER TABLE public.rag_retrieval_log ADD CONSTRAINT rag_retrieval_log_source_recheck_check CHECK (
  (source_rechecked IS NULL AND stale_index_drop IS NULL)
  OR (source_rechecked IS NOT NULL AND stale_index_drop IS NOT NULL
      AND source_rechecked >= 0 AND stale_index_drop >= 0 AND stale_index_drop <= source_rechecked)
);

CREATE OR REPLACE FUNCTION public.rag_monitor_stale_index_drop(p_day date)
RETURNS TABLE (tenant_key text, retrievals bigint, checked bigint, dropped bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT l.tenant_key,
         pg_catalog.count(*)::bigint,
         COALESCE(pg_catalog.sum(l.source_rechecked), 0)::bigint,
         COALESCE(pg_catalog.sum(l.stale_index_drop), 0)::bigint
    FROM public.rag_retrieval_log l
   WHERE p_day IS NOT NULL
     AND l.created_at >= (p_day::timestamp AT TIME ZONE 'UTC')
     AND l.created_at < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
     AND l.source_rechecked IS NOT NULL
     AND l.tenant_key IS NOT NULL
   GROUP BY l.tenant_key
   ORDER BY l.tenant_key
$$;

REVOKE ALL ON FUNCTION public.rag_monitor_stale_index_drop(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_stale_index_drop(date) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
