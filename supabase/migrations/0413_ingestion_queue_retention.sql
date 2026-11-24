-- 0413: Archive and purge terminal ingestion jobs past a retention window (queue hardening).
-- Slim archive rows keep idempotency and citation seams; heavy jsonb is dropped. Service role only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ingestion_jobs_archive (
  id uuid PRIMARY KEY,
  tenant_key text NOT NULL,
  kind text NOT NULL,
  source text,
  source_key text NOT NULL,
  batch_id uuid,
  document_id uuid,
  lineage_id uuid,
  version integer,
  file_sha256 text,
  status text NOT NULL,
  error_class text,
  last_error text,
  trace_id uuid,
  retries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_jobs_archive_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  )
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_archive_archived_at_idx
  ON public.ingestion_jobs_archive (archived_at DESC);

ALTER TABLE public.ingestion_jobs_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ingestion_jobs_archive FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ingestion_jobs_archive TO service_role;

CREATE OR REPLACE FUNCTION public.rag_purge_stale_ingestion_jobs(
  p_retention_days integer DEFAULT 90,
  p_batch_size integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days integer;
  v_limit integer;
  v_cutoff timestamptz;
  v_archived integer := 0;
  v_purged integer := 0;
  rec record;
BEGIN
  v_days := GREATEST(COALESCE(p_retention_days, 90), 1);
  v_limit := GREATEST(LEAST(COALESCE(p_batch_size, 500), 5000), 1);
  v_cutoff := now() - (v_days || ' days')::interval;

  FOR rec IN
    SELECT j.id
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.updated_at < v_cutoff
       AND (
         j.status IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
         OR j.kind = 'delete'
       )
     ORDER BY j.updated_at
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.ingestion_jobs_archive (
      id, tenant_key, kind, source, source_key, batch_id, document_id, lineage_id, version,
      file_sha256, status, error_class, last_error, trace_id, retries,
      created_at, updated_at, archived_at
    )
    SELECT
      j.id, j.tenant_key, j.kind, j.source, j.source_key, j.batch_id, j.document_id, j.lineage_id, j.version,
      j.file_sha256, j.status, j.error_class, j.error, j.trace_id, j.retries,
      j.created_at, j.updated_at, now()
      FROM public.ingestion_jobs j
     WHERE j.id = rec.id
    ON CONFLICT (id) DO UPDATE SET
      archived_at = EXCLUDED.archived_at,
      status = EXCLUDED.status,
      error_class = EXCLUDED.error_class,
      last_error = EXCLUDED.last_error;

    DELETE FROM public.ingestion_jobs j WHERE j.id = rec.id;
    v_archived := v_archived + 1;
    v_purged := v_purged + 1;
  END LOOP;

  FOR rec IN
    SELECT j.id
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NOT NULL
       AND j.deleted_at < v_cutoff
     ORDER BY j.deleted_at
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.ingestion_jobs_archive (
      id, tenant_key, kind, source, source_key, batch_id, document_id, lineage_id, version,
      file_sha256, status, error_class, last_error, trace_id, retries,
      created_at, updated_at, archived_at
    )
    SELECT
      j.id, j.tenant_key, j.kind, j.source, j.source_key, j.batch_id, j.document_id, j.lineage_id, j.version,
      j.file_sha256, j.status, j.error_class, j.error, j.trace_id, j.retries,
      j.created_at, j.updated_at, now()
      FROM public.ingestion_jobs j
     WHERE j.id = rec.id
    ON CONFLICT (id) DO UPDATE SET archived_at = EXCLUDED.archived_at;

    DELETE FROM public.ingestion_jobs j WHERE j.id = rec.id;
    v_archived := v_archived + 1;
    v_purged := v_purged + 1;
  END LOOP;

  RETURN jsonb_build_object('archived', v_archived, 'purged', v_purged, 'retention_days', v_days);
END;
$$;

REVOKE ALL ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';