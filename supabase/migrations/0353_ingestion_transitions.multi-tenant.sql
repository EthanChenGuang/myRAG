-- 0353 (multi-tenant): Realtime topic allow-list for own user topic and member organization topics.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_ingest_realtime_topic_allowed(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_org uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_topic IS NULL OR btrim(p_topic) = '' THEN
    RETURN false;
  END IF;
  IF p_topic = 'rag-ingest:u:' || v_uid::text THEN
    RETURN true;
  END IF;
  IF p_topic ~ '^rag-ingest:o:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    BEGIN
      v_org := (regexp_match(p_topic, '^rag-ingest:o:([0-9a-f-]{36})$'))[1]::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN false;
    END;
    RETURN is_org_member(v_org, v_uid);
  END IF;
  RETURN false;
END;
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