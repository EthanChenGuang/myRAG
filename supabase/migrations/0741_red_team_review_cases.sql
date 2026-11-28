-- 0741: rag_red_team_open_cases, one open review item per red-team attack success (Phase 7 SEC-11, plan 07-42).
-- p_cases: [{ item_id, technique, language, trace_id, question }]. Every case is stored under p_tenant_key (a tenant named in a
-- case is ignored) with tags {red_team, rt_<technique>}, empty reasons, channel chat, outcome answered, the synthetic question as
-- query_masked (at most 2000 characters), mining_window p_run_started_at and the queue's 90-day open-item expiry
-- (config/rag/feedback-mining.json open_item_ttl_days). query_fingerprint is the sha256 hex of 'red_team:<run>:<item>:' plus the
-- normalised question, so one run inserts one item per corpus item; ON CONFLICT DO NOTHING on the Phase 5.1.1 key (tenant_key,
-- query_fingerprint, mining_window), so a repeat inserts nothing. Returns the number inserted. A malformed payload raises 22023
-- and writes nothing. The tenant key is checked first by rag_assert_tenant_key. SECURITY INVOKER, empty search_path,
-- service_role only. Idempotent, not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_red_team_open_cases(
  p_tenant_key text,
  p_run_id uuid,
  p_run_started_at timestamptz,
  p_cases jsonb
)
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
  IF p_run_id IS NULL OR p_run_started_at IS NULL THEN
    RAISE EXCEPTION 'run_required' USING ERRCODE = '22023';
  END IF;
  IF p_cases IS NULL OR pg_catalog.jsonb_typeof(p_cases) <> 'array' THEN
    RAISE EXCEPTION 'cases_not_array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(p_cases) > 500 THEN
    RAISE EXCEPTION 'too_many_cases' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_cases) AS e(value)
     WHERE pg_catalog.jsonb_typeof(e.value) <> 'object'
        OR COALESCE(e.value ->> 'item_id', '') = ''
        OR COALESCE(e.value ->> 'technique', '') !~ '^[a-z][a-z_]{0,28}$'
        OR COALESCE(e.value ->> 'language', '') !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'
        OR COALESCE(e.value ->> 'trace_id', '') = ''
        OR pg_catalog.btrim(COALESCE(e.value ->> 'question', '')) = ''
  ) THEN
    RAISE EXCEPTION 'invalid_case' USING ERRCODE = '22023';
  END IF;

  WITH written AS (
    INSERT INTO public.rag_review_items AS i (
      tenant_key, trace_id, query_masked, query_fingerprint, query_language, channel, outcome, reasons, tags, status,
      mining_window, mined_at, expires_at
    )
    SELECT p_tenant_key,
           e.value ->> 'trace_id',
           pg_catalog.left(e.value ->> 'question', 2000),
           pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(
               'red_team:' || p_run_id::text || ':' || (e.value ->> 'item_id') || ':'
                 || pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(e.value ->> 'question'), '\s+', ' ', 'g')),
               'UTF8'
             )),
             'hex'
           ),
           e.value ->> 'language',
           'chat',
           'answered',
           '{}'::text[],
           ARRAY['red_team', 'rt_' || (e.value ->> 'technique')]::text[],
           'open',
           p_run_started_at,
           pg_catalog.now(),
           pg_catalog.now() + pg_catalog.make_interval(days => 90)
      FROM pg_catalog.jsonb_array_elements(p_cases) AS e(value)
    ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO v_count FROM written;

  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_red_team_open_cases(text, uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_red_team_open_cases(text, uuid, timestamptz, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
