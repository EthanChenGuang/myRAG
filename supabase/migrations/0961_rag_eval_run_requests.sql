-- 0961: rag_eval_run_requests, tenant nightly evaluation runs requested by backfill or re-embed completion (Phase 5.3 D-19, EVAL-30).
-- One row per (tenant_key, reason, ref_id). rag_eval_run_request_enqueue is the writer: the tenant comes only from p_tenant_key,
-- checked first by rag_assert_tenant_key (a key of the other deployment mode raises 22023), and a repeat is a no-op returning false.
-- skip_reason holds a code, result_summary counts only. SECURITY INVOKER with an empty search_path; service_role only.
-- Additive and idempotent. Not folded into the setup files (D-56). RLS on, no policy, no client grants.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_eval_run_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  reason text NOT NULL,
  ref_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  skip_reason text,
  result_summary jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_eval_run_requests_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_eval_run_requests_reason_check CHECK (reason IN ('backfill_completed', 'reembed_completed', 'manual')),
  CONSTRAINT rag_eval_run_requests_ref_id_check CHECK (length(ref_id) BETWEEN 1 AND 200 AND ref_id ~ '^[A-Za-z0-9:._-]+$'),
  CONSTRAINT rag_eval_run_requests_status_check CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed')),
  CONSTRAINT rag_eval_run_requests_skip_reason_check CHECK (skip_reason IS NULL OR skip_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT rag_eval_run_requests_result_summary_check CHECK (
    result_summary IS NULL OR (jsonb_typeof(result_summary) = 'object' AND pg_column_size(result_summary) <= 16384)
  ),
  CONSTRAINT rag_eval_run_requests_request_key UNIQUE (tenant_key, reason, ref_id)
);

CREATE INDEX IF NOT EXISTS rag_eval_run_requests_status_idx ON public.rag_eval_run_requests (status, requested_at);

ALTER TABLE public.rag_eval_run_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_eval_run_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_eval_run_requests TO service_role;

CREATE OR REPLACE FUNCTION public.rag_eval_run_request_enqueue(p_tenant_key text, p_reason text, p_ref_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_inserted integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  INSERT INTO public.rag_eval_run_requests (tenant_key, reason, ref_id)
  VALUES (p_tenant_key, p_reason, p_ref_id)
  ON CONFLICT ON CONSTRAINT rag_eval_run_requests_request_key DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_eval_run_request_enqueue(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_eval_run_request_enqueue(text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
