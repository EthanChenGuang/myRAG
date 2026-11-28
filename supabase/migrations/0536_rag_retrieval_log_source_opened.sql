-- 0536: rag_record_source_opened adds one to source_opened_count on the caller's own rag_retrieval_log row (Phase 5.1.1, D-12).
-- One statement: the row must match the trace id and the user id, and the count stops at 20. Returns the count after the call,
-- the unchanged count at the cap, or NULL when that user has no row with that trace id (the route answers 404).
-- SECURITY INVOKER: only service_role has privileges on the table. Service role only. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_record_source_opened(p_trace_id text, p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF p_trace_id IS NULL OR p_user_id IS NULL OR p_trace_id !~ '^[0-9a-f]{32}$' THEN
    RETURN NULL;
  END IF;

  UPDATE public.rag_retrieval_log l
  SET source_opened_count = l.source_opened_count + 1
  WHERE l.trace_id = p_trace_id AND l.user_id = p_user_id AND l.source_opened_count < 20
  RETURNING l.source_opened_count INTO v_count;
  IF FOUND THEN
    RETURN v_count;
  END IF;

  SELECT l.source_opened_count INTO v_count
  FROM public.rag_retrieval_log l
  WHERE l.trace_id = p_trace_id AND l.user_id = p_user_id;
  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_record_source_opened(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_record_source_opened(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
