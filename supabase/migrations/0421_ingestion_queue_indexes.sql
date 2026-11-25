-- 0421: Partial indexes for ingestion job claim, lease reclaim, and operator listing.

BEGIN;

DROP INDEX IF EXISTS public.ingestion_jobs_queued_claim_idx;
DROP INDEX IF EXISTS public.ingestion_jobs_active_lease_idx;

CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_queued_idx
  ON public.ingestion_jobs (priority DESC, created_at ASC, id)
  WHERE deleted_at IS NULL
    AND kind IN ('ingest', 'dry_run')
    AND status = 'queued';

CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_active_lease_idx
  ON public.ingestion_jobs (lease_until ASC, priority DESC, created_at ASC)
  WHERE deleted_at IS NULL
    AND kind IN ('ingest', 'dry_run')
    AND status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding');

CREATE INDEX IF NOT EXISTS ingestion_jobs_list_created_idx
  ON public.ingestion_jobs (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';