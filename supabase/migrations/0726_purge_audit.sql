-- 0726: Purge audit records (DATA-24, D-12, D-16, D-35). One row per lineage purge, written by rag_purge_lineage (0727) in the
-- purge transaction. Ids and hashes only: version ids, file_sha256 values, the SHA-256 of the source key, the Nango connection id,
-- the actor id, a reason code and an optional note of at most 500 characters; never a title, file name or text of the content.
-- No foreign key, so a record outlives the documents it names. RLS on with no policy; service_role may only SELECT. Updates go
-- through rag_purge_audit_finish and touch only the finish columns; deletes and truncates are refused.
-- Additive and idempotent, not folded into the setup files.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_purge_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  lineage_id uuid NOT NULL,
  version_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  file_sha256_values text[] NOT NULL DEFAULT '{}'::text[],
  source text,
  source_key_sha256 text,
  source_connection_id text,
  actor_kind text NOT NULL,
  actor_id uuid NOT NULL,
  reason_code text NOT NULL,
  reason_note text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  object_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification jsonb,
  verification_checked_at timestamptz,
  pending_object_paths text[] NOT NULL DEFAULT '{}'::text[],
  result text,
  CONSTRAINT rag_purge_audit_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_purge_audit_actor_kind_check CHECK (actor_kind IN ('admin', 'source_sync')),
  CONSTRAINT rag_purge_audit_reason_code_check CHECK (
    reason_code IN ('owner_request', 'added_in_error', 'retention_ended', 'legal_or_policy', 'restricted_content', 'other', 'source_deleted')
  ),
  CONSTRAINT rag_purge_audit_reason_note_check CHECK (reason_note IS NULL OR char_length(reason_note) <= 500),
  CONSTRAINT rag_purge_audit_other_note_check CHECK (reason_code <> 'other' OR (reason_note IS NOT NULL AND btrim(reason_note) <> '')),
  CONSTRAINT rag_purge_audit_source_key_sha256_check CHECK (source_key_sha256 IS NULL OR source_key_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rag_purge_audit_file_sha256_check CHECK (array_position(file_sha256_values, NULL) IS NULL),
  CONSTRAINT rag_purge_audit_result_check CHECK (result IS NULL OR result IN ('verified', 'pending', 'failed')),
  CONSTRAINT rag_purge_audit_counts_check CHECK (jsonb_typeof(counts) = 'object' AND jsonb_typeof(object_counts) = 'object')
);

CREATE INDEX IF NOT EXISTS rag_purge_audit_lineage_idx ON public.rag_purge_audit (tenant_key, lineage_id, started_at DESC);
CREATE INDEX IF NOT EXISTS rag_purge_audit_started_idx ON public.rag_purge_audit (started_at DESC);
CREATE INDEX IF NOT EXISTS rag_purge_audit_tombstone_idx
  ON public.rag_purge_audit (tenant_key, source_connection_id, source_key_sha256)
  WHERE actor_kind = 'admin';

ALTER TABLE public.rag_purge_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_purge_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.rag_purge_audit TO service_role;

-- Refuses deletes, and updates unless rag_purge_audit_finish set its transaction-local flag; even then only the finish columns change.
CREATE OR REPLACE FUNCTION public.rag_purge_audit_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_finish_columns constant text[] := ARRAY[
    'finished_at', 'object_counts', 'verification', 'verification_checked_at', 'pending_object_paths', 'result'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rag_purge_audit is append-only' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('rag.purge_audit_finish', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'rag_purge_audit is append-only' USING ERRCODE = '42501';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - v_finish_columns) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_finish_columns) THEN
    RAISE EXCEPTION 'rag_purge_audit identity columns are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_purge_audit_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'rag_purge_audit is append-only' USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS rag_purge_audit_guard ON public.rag_purge_audit;
CREATE TRIGGER rag_purge_audit_guard
  BEFORE UPDATE OR DELETE ON public.rag_purge_audit
  FOR EACH ROW EXECUTE FUNCTION public.rag_purge_audit_guard();

DROP TRIGGER IF EXISTS rag_purge_audit_no_truncate ON public.rag_purge_audit;
CREATE TRIGGER rag_purge_audit_no_truncate
  BEFORE TRUNCATE ON public.rag_purge_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_purge_audit_no_truncate();

-- Stores the app's object step and the verification: merges object counts, replaces pending paths and the verification when given,
-- sets the result and the finish time (and the check time with a verification). Unknown id: not_found.
CREATE OR REPLACE FUNCTION public.rag_purge_audit_finish(
  p_audit_id uuid,
  p_object_counts jsonb,
  p_pending text[],
  p_verification jsonb,
  p_result text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_audit_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_object_counts IS NOT NULL AND pg_catalog.jsonb_typeof(p_object_counts) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_verification IS NOT NULL AND pg_catalog.jsonb_typeof(p_verification) NOT IN ('object', 'array') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_result IS NOT NULL AND p_result NOT IN ('verified', 'pending', 'failed') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_pending IS NOT NULL AND (pg_catalog.cardinality(p_pending) > 10000 OR pg_catalog.array_position(p_pending, NULL) IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('rag.purge_audit_finish', 'on', true);
  UPDATE public.rag_purge_audit a
     SET object_counts = a.object_counts || COALESCE(p_object_counts, '{}'::jsonb),
         pending_object_paths = COALESCE(p_pending, a.pending_object_paths),
         verification = COALESCE(p_verification, a.verification),
         verification_checked_at = CASE WHEN p_verification IS NULL THEN a.verification_checked_at ELSE pg_catalog.now() END,
         result = COALESCE(p_result, a.result),
         finished_at = pg_catalog.now()
   WHERE a.id = p_audit_id;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('rag.purge_audit_finish', 'off', true);
    RAISE EXCEPTION 'not_found';
  END IF;
  PERFORM pg_catalog.set_config('rag.purge_audit_finish', 'off', true);
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.rag_purge_audit_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_audit_no_truncate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
