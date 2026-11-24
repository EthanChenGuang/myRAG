-- 0353 (single-tenant): Realtime topic allow-list for the shared tenant channel only.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_ingest_realtime_topic_allowed(p_topic text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND p_topic IS NOT NULL
    AND p_topic = 'rag-ingest:s:default';
$$;

REVOKE ALL ON FUNCTION public.rag_ingest_realtime_topic_allowed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_ingest_realtime_topic_allowed(text) TO authenticated, service_role;

COMMIT;