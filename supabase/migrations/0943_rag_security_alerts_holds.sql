-- 0943: rag_security_alerts, rag_uploader_holds and their service-role functions (Phase 5.2, SEC-10, D-02, D-45, D-46, D-47).
-- An alert row is written the first time an uploader's events in a tenant exceed the caller's threshold within the window
-- [window_end - window hours, window_end), window_end being the hour boundary after the event. The unique key (tenant_key, uploader_id,
-- window_start) with ON CONFLICT DO NOTHING makes concurrent writers produce one alert, and no alert is written while an earlier alert of the
-- same uploader still overlaps the window. Threshold and window are parameters (RAG_UPLOADER_ALERT_THRESHOLD, RAG_UPLOADER_ALERT_WINDOW_HOURS),
-- never read from settings here; a threshold of 0 never alerts. Events without an uploader are never counted or held.
-- A hold row (at most one active per tenant and user) makes submitIngest() take the Phase 3.2 pending_review path for that uploader; releasing
-- it sets released_at and approves nothing. Every function takes the tenant only from its key argument, checked first by rag_assert_tenant_key,
-- is SECURITY INVOKER with an empty search_path and is service_role only (locked again in 0410). The list functions return ids, counts and
-- times only. Tables: RLS on with no policy, every grant revoked from PUBLIC, anon and authenticated. Not folded into the setup files. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_security_alerts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  uploader_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_count integer NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open',
  held boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT rag_security_alerts_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_security_alerts_event_count_check CHECK (event_count > 0),
  CONSTRAINT rag_security_alerts_window_check CHECK (window_end > window_start),
  CONSTRAINT rag_security_alerts_status_check CHECK (status IN ('open', 'acknowledged')),
  CONSTRAINT rag_security_alerts_acknowledged_check CHECK ((status = 'acknowledged') = (acknowledged_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_security_alerts_window_key
  ON public.rag_security_alerts (tenant_key, uploader_id, window_start);
CREATE INDEX IF NOT EXISTS rag_security_alerts_tenant_created_idx
  ON public.rag_security_alerts (tenant_key, created_at DESC);

CREATE TABLE IF NOT EXISTS public.rag_uploader_holds (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  released_at timestamptz,
  released_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT rag_uploader_holds_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_uploader_holds_reason_check
    CHECK (reason IS NULL OR (pg_catalog.char_length(reason) <= 200 AND reason !~ '[[:cntrl:]]')),
  CONSTRAINT rag_uploader_holds_released_check CHECK (released_by IS NULL OR released_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_uploader_holds_active_key
  ON public.rag_uploader_holds (tenant_key, user_id) WHERE released_at IS NULL;

ALTER TABLE public.rag_security_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_uploader_holds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_security_alerts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_uploader_holds FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.rag_security_alerts TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.rag_uploader_holds TO service_role;

-- Inserts the events of one tenant and writes any alert they trigger. p_events is a JSON array of
-- {source, action, detector, rule_ids?, document_id?, chunk_id?, uploader_id?, trace_id?}. When document_id names a document of the tenant, its
-- owner (documents.user_id) is the uploader; a document of another tenant is refused. Returns {event_ids: [...], alert_ids: [...]}.
CREATE OR REPLACE FUNCTION public.rag_record_security_events(
  p_tenant_key text,
  p_events jsonb,
  p_threshold integer,
  p_window_hours integer,
  p_auto_hold boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_event jsonb;
  v_key text;
  v_rule jsonb;
  v_rule_ids text[];
  v_document_id uuid;
  v_uploader uuid;
  v_doc_tenant text;
  v_doc_user uuid;
  v_id uuid;
  v_event_ids uuid[] := '{}'::uuid[];
  v_alert_ids uuid[] := '{}'::uuid[];
  v_uploaders uuid[] := '{}'::uuid[];
  v_user uuid;
  v_window_end timestamptz;
  v_window_start timestamptz;
  v_count integer;
  v_held boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_events IS NULL OR pg_catalog.jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'events must be a json array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(p_events) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 events per call' USING ERRCODE = '22023';
  END IF;
  IF p_threshold IS NULL OR p_threshold < 0 THEN
    RAISE EXCEPTION 'threshold must be 0 or more' USING ERRCODE = '22023';
  END IF;
  IF p_window_hours IS NULL OR p_window_hours < 1 OR p_window_hours > 8760 THEN
    RAISE EXCEPTION 'window must be within 1..8760 hours' USING ERRCODE = '22023';
  END IF;

  FOR v_event IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_events) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_event) <> 'object' THEN
      RAISE EXCEPTION 'each event must be a json object' USING ERRCODE = '22023';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['source', 'action', 'detector'] LOOP
      IF pg_catalog.jsonb_typeof(v_event -> v_key) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'event % must be a string', v_key USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF (v_event ->> 'detector') !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
      RAISE EXCEPTION 'malformed detector' USING ERRCODE = '22023';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['document_id', 'chunk_id', 'uploader_id'] LOOP
      IF pg_catalog.jsonb_typeof(v_event -> v_key) IS NOT NULL AND pg_catalog.jsonb_typeof(v_event -> v_key) <> 'null'
         AND (pg_catalog.jsonb_typeof(v_event -> v_key) <> 'string' OR (v_event ->> v_key) !~ v_uuid_pattern) THEN
        RAISE EXCEPTION 'event % must be a uuid', v_key USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF pg_catalog.jsonb_typeof(v_event -> 'trace_id') IS NOT NULL AND pg_catalog.jsonb_typeof(v_event -> 'trace_id') <> 'null'
       AND (pg_catalog.jsonb_typeof(v_event -> 'trace_id') <> 'string' OR (v_event ->> 'trace_id') !~ '^[A-Za-z0-9_.:-]{1,200}$') THEN
      RAISE EXCEPTION 'malformed trace id' USING ERRCODE = '22023';
    END IF;

    v_rule_ids := '{}'::text[];
    IF pg_catalog.jsonb_typeof(v_event -> 'rule_ids') IS NOT NULL AND pg_catalog.jsonb_typeof(v_event -> 'rule_ids') <> 'null' THEN
      IF pg_catalog.jsonb_typeof(v_event -> 'rule_ids') <> 'array' OR pg_catalog.jsonb_array_length(v_event -> 'rule_ids') > 32 THEN
        RAISE EXCEPTION 'rule ids must be an array of at most 32 ids' USING ERRCODE = '22023';
      END IF;
      FOR v_rule IN SELECT r.value FROM pg_catalog.jsonb_array_elements(v_event -> 'rule_ids') AS r(value) LOOP
        IF pg_catalog.jsonb_typeof(v_rule) <> 'string' OR (v_rule #>> '{}') !~ '^[A-Za-z0-9_.:-]{1,100}$' THEN
          RAISE EXCEPTION 'malformed rule id' USING ERRCODE = '22023';
        END IF;
        v_rule_ids := pg_catalog.array_append(v_rule_ids, v_rule #>> '{}');
      END LOOP;
    END IF;

    v_document_id := NULLIF(v_event ->> 'document_id', '')::uuid;
    v_uploader := NULLIF(v_event ->> 'uploader_id', '')::uuid;
    IF v_document_id IS NOT NULL THEN
      SELECT d.tenant_key, d.user_id INTO v_doc_tenant, v_doc_user FROM public.documents d WHERE d.id = v_document_id;
      IF FOUND THEN
        IF v_doc_tenant IS DISTINCT FROM p_tenant_key THEN
          RAISE EXCEPTION 'document does not belong to the tenant' USING ERRCODE = '22023';
        END IF;
        v_uploader := v_doc_user;
      END IF;
    END IF;

    INSERT INTO public.rag_security_events (tenant_key, source, action, detector, rule_ids, document_id, chunk_id, uploader_id, trace_id)
    VALUES (
      p_tenant_key,
      v_event ->> 'source',
      v_event ->> 'action',
      v_event ->> 'detector',
      v_rule_ids,
      v_document_id,
      NULLIF(v_event ->> 'chunk_id', '')::uuid,
      v_uploader,
      v_event ->> 'trace_id'
    )
    RETURNING id INTO v_id;
    v_event_ids := pg_catalog.array_append(v_event_ids, v_id);
    IF v_uploader IS NOT NULL AND NOT (v_uploader = ANY (v_uploaders)) THEN
      v_uploaders := pg_catalog.array_append(v_uploaders, v_uploader);
    END IF;
  END LOOP;

  IF p_threshold > 0 THEN
    v_window_end := pg_catalog.date_trunc('hour', pg_catalog.now()) + interval '1 hour';
    v_window_start := v_window_end - pg_catalog.make_interval(hours => p_window_hours);
    FOREACH v_user IN ARRAY v_uploaders LOOP
      SELECT pg_catalog.count(*)::integer INTO v_count
      FROM public.rag_security_events e
      WHERE e.tenant_key = p_tenant_key
        AND e.uploader_id = v_user
        AND e.created_at >= v_window_start
        AND e.created_at < v_window_end;
      CONTINUE WHEN v_count <= p_threshold;
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.rag_security_alerts a
        WHERE a.tenant_key = p_tenant_key AND a.uploader_id = v_user AND a.window_end > v_window_start
      );
      v_held := COALESCE(p_auto_hold, false) OR EXISTS (
        SELECT 1 FROM public.rag_uploader_holds h
        WHERE h.tenant_key = p_tenant_key AND h.user_id = v_user AND h.released_at IS NULL
      );
      v_id := NULL;
      INSERT INTO public.rag_security_alerts (tenant_key, uploader_id, event_count, window_start, window_end, held)
      VALUES (p_tenant_key, v_user, v_count, v_window_start, v_window_end, v_held)
      ON CONFLICT (tenant_key, uploader_id, window_start) DO NOTHING
      RETURNING id INTO v_id;
      CONTINUE WHEN v_id IS NULL;
      v_alert_ids := pg_catalog.array_append(v_alert_ids, v_id);
      IF COALESCE(p_auto_hold, false) THEN
        INSERT INTO public.rag_uploader_holds (tenant_key, user_id, reason)
        VALUES (p_tenant_key, v_user, 'security_alert')
        ON CONFLICT (tenant_key, user_id) WHERE released_at IS NULL DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  RETURN pg_catalog.jsonb_build_object('event_ids', pg_catalog.to_jsonb(v_event_ids), 'alert_ids', pg_catalog.to_jsonb(v_alert_ids));
END
$fn$;

-- Places a hold on an uploader of the tenant: ok, or already_held when an active hold exists.
CREATE OR REPLACE FUNCTION public.rag_hold_uploader(p_tenant_key text, p_user_id uuid, p_actor uuid, p_reason text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_reason text;
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;
  v_reason := NULLIF(pg_catalog.btrim(p_reason), '');
  IF v_reason IS NOT NULL AND (pg_catalog.char_length(v_reason) > 200 OR v_reason ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'reason must be at most 200 characters without control characters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rag_uploader_holds (tenant_key, user_id, created_by, reason)
  VALUES (p_tenant_key, p_user_id, p_actor, v_reason)
  ON CONFLICT (tenant_key, user_id) WHERE released_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN 'already_held';
  END IF;
  UPDATE public.rag_security_alerts a SET held = true
  WHERE a.tenant_key = p_tenant_key AND a.uploader_id = p_user_id AND a.status = 'open' AND NOT a.held;
  RETURN 'ok';
END
$fn$;

-- Releases the active hold of an uploader of the tenant: ok, or not_held. Held documents stay pending_review until an admin approves them.
CREATE OR REPLACE FUNCTION public.rag_release_uploader_hold(p_tenant_key text, p_user_id uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_released integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.rag_uploader_holds h
  SET released_at = pg_catalog.now(), released_by = p_actor
  WHERE h.tenant_key = p_tenant_key AND h.user_id = p_user_id AND h.released_at IS NULL;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  IF v_released = 0 THEN
    RETURN 'not_held';
  END IF;
  UPDATE public.rag_security_alerts a SET held = false
  WHERE a.tenant_key = p_tenant_key AND a.uploader_id = p_user_id AND a.status = 'open' AND a.held;
  RETURN 'ok';
END
$fn$;

-- Acknowledges an alert of the tenant: ok, already_acknowledged, or not_found (missing or another tenant's).
CREATE OR REPLACE FUNCTION public.rag_acknowledge_security_alert(p_tenant_key text, p_alert_id uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_status text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_alert_id IS NULL THEN
    RETURN 'not_found';
  END IF;

  SELECT a.status INTO v_status
  FROM public.rag_security_alerts a
  WHERE a.id = p_alert_id AND a.tenant_key = p_tenant_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_status = 'acknowledged' THEN
    RETURN 'already_acknowledged';
  END IF;
  UPDATE public.rag_security_alerts a
  SET status = 'acknowledged', acknowledged_at = pg_catalog.now(), acknowledged_by = p_actor
  WHERE a.id = p_alert_id AND a.tenant_key = p_tenant_key;
  RETURN 'ok';
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_uploader_hold_active(p_tenant_key text, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.rag_uploader_holds h
    WHERE h.tenant_key = p_tenant_key AND h.user_id = p_user_id AND h.released_at IS NULL
  );
END
$fn$;

-- The users among p_user_ids that have an active hold in the tenant (one call for an admin list).
CREATE OR REPLACE FUNCTION public.rag_active_uploader_holds(p_tenant_key text, p_user_ids uuid[])
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT DISTINCT h.user_id
  FROM public.rag_uploader_holds h
  WHERE h.tenant_key = p_tenant_key
    AND h.released_at IS NULL
    AND h.user_id = ANY (COALESCE(p_user_ids, '{}'::uuid[]));
END
$fn$;

-- Events of the given tenants, newest first, optionally filtered by source, uploader and start time. p_limit is clamped to 1..500.
CREATE OR REPLACE FUNCTION public.rag_list_security_events(
  p_tenant_keys text[],
  p_source text,
  p_uploader uuid,
  p_since timestamptz,
  p_limit integer,
  p_offset integer
)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  source text,
  action text,
  detector text,
  rule_ids text[],
  document_id uuid,
  chunk_id uuid,
  uploader_id uuid,
  trace_id text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_key text;
BEGIN
  FOREACH v_key IN ARRAY COALESCE(p_tenant_keys, ARRAY[NULL::text]) LOOP
    PERFORM public.rag_assert_tenant_key(v_key);
  END LOOP;
  IF p_source IS NOT NULL AND p_source NOT IN ('ingest_injection', 'retrieval_injection', 'output_guard', 'hidden_text', 'untrusted_link') THEN
    RAISE EXCEPTION 'unknown event source' USING ERRCODE = '22023';
  END IF;
  IF p_offset IS NOT NULL AND p_offset < 0 THEN
    RAISE EXCEPTION 'offset must be 0 or more' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT e.id, e.tenant_key, e.source, e.action, e.detector, e.rule_ids, e.document_id, e.chunk_id, e.uploader_id, e.trace_id, e.created_at
  FROM public.rag_security_events e
  WHERE e.tenant_key = ANY (p_tenant_keys)
    AND (p_source IS NULL OR e.source = p_source)
    AND (p_uploader IS NULL OR e.uploader_id = p_uploader)
    AND (p_since IS NULL OR e.created_at >= p_since)
  ORDER BY e.created_at DESC, e.id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500))
  OFFSET COALESCE(p_offset, 0);
END
$fn$;

-- Alerts of the given tenants, newest first (at most 1000).
CREATE OR REPLACE FUNCTION public.rag_list_security_alerts(p_tenant_keys text[])
RETURNS TABLE (
  id uuid,
  tenant_key text,
  uploader_id uuid,
  event_count integer,
  window_start timestamptz,
  window_end timestamptz,
  status text,
  held boolean,
  created_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_key text;
BEGIN
  FOREACH v_key IN ARRAY COALESCE(p_tenant_keys, ARRAY[NULL::text]) LOOP
    PERFORM public.rag_assert_tenant_key(v_key);
  END LOOP;

  RETURN QUERY
  SELECT a.id, a.tenant_key, a.uploader_id, a.event_count, a.window_start, a.window_end, a.status, a.held, a.created_at,
         a.acknowledged_at, a.acknowledged_by
  FROM public.rag_security_alerts a
  WHERE a.tenant_key = ANY (p_tenant_keys)
  ORDER BY a.created_at DESC, a.id
  LIMIT 1000;
END
$fn$;

-- Per uploader of the given tenants: event count and last event time within the window, and whether a hold is active. Events without an
-- uploader are not listed.
CREATE OR REPLACE FUNCTION public.rag_list_security_uploaders(p_tenant_keys text[], p_window_hours integer)
RETURNS TABLE (
  tenant_key text,
  uploader_id uuid,
  event_count bigint,
  last_event_at timestamptz,
  hold_active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_key text;
BEGIN
  FOREACH v_key IN ARRAY COALESCE(p_tenant_keys, ARRAY[NULL::text]) LOOP
    PERFORM public.rag_assert_tenant_key(v_key);
  END LOOP;
  IF p_window_hours IS NULL OR p_window_hours < 1 OR p_window_hours > 8760 THEN
    RAISE EXCEPTION 'window must be within 1..8760 hours' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT e.tenant_key, e.uploader_id, pg_catalog.count(*) AS event_count, pg_catalog.max(e.created_at) AS last_event_at,
         EXISTS (
           SELECT 1 FROM public.rag_uploader_holds h
           WHERE h.tenant_key = e.tenant_key AND h.user_id = e.uploader_id AND h.released_at IS NULL
         ) AS hold_active
  FROM public.rag_security_events e
  WHERE e.tenant_key = ANY (p_tenant_keys)
    AND e.uploader_id IS NOT NULL
    AND e.created_at >= pg_catalog.now() - pg_catalog.make_interval(hours => p_window_hours)
  GROUP BY e.tenant_key, e.uploader_id
  ORDER BY pg_catalog.count(*) DESC, e.uploader_id
  LIMIT 1000;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_record_security_events(text, jsonb, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_hold_uploader(text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_release_uploader_hold(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_acknowledge_security_alert(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_uploader_hold_active(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_active_uploader_holds(text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_list_security_events(text[], text, uuid, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_list_security_alerts(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_list_security_uploaders(text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_record_security_events(text, jsonb, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_hold_uploader(text, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_release_uploader_hold(text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_acknowledge_security_alert(text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_uploader_hold_active(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_active_uploader_holds(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_list_security_events(text[], text, uuid, timestamptz, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_list_security_alerts(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_list_security_uploaders(text[], integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
