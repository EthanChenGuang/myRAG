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

-- Realtime read policy (no-op when realtime.messages is absent). It calls the topic rule above, so it is created here, after it.
DO $policy$
BEGIN
  IF to_regclass('realtime.messages') IS NULL THEN
    RETURN;
  END IF;
  DROP POLICY IF EXISTS rag_ingest_broadcast_read ON realtime.messages;
  CREATE POLICY rag_ingest_broadcast_read ON realtime.messages
    FOR SELECT TO authenticated
    USING (
      extension = 'broadcast'
      AND public.rag_ingest_realtime_topic_allowed((SELECT realtime.topic()))
    );
END
$policy$;

COMMIT;