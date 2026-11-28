-- 0720: Phase 6.3 source sync columns (D-02, D-07, D-08, D-44).
-- nango_connections gains the per-connection deletion mode and the reconcile state; documents gains what the last
-- sync saw of the source file. All columns are nullable with no default and no backfill: NULL keeps today's behaviour.
-- The nango_connections block is identical in both setup files, so this is one common file (D-44).
-- No file names or text are stored here. Additive and idempotent; not folded into the setup files.

BEGIN;

ALTER TABLE public.nango_connections ADD COLUMN IF NOT EXISTS deletion_mode text;
ALTER TABLE public.nango_connections ADD COLUMN IF NOT EXISTS last_full_reconcile_at timestamptz;
ALTER TABLE public.nango_connections ADD COLUMN IF NOT EXISTS last_reconcile_status text;

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS source_last_seen_at timestamptz;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS source_modified_at timestamptz;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS source_etag text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'nango_connections_deletion_mode_check' AND conrelid = 'public.nango_connections'::regclass
  ) THEN
    ALTER TABLE public.nango_connections
      ADD CONSTRAINT nango_connections_deletion_mode_check
      CHECK (deletion_mode IS NULL OR deletion_mode IN ('soft', 'purge'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'nango_connections_last_reconcile_status_check' AND conrelid = 'public.nango_connections'::regclass
  ) THEN
    ALTER TABLE public.nango_connections
      ADD CONSTRAINT nango_connections_last_reconcile_status_check
      CHECK (last_reconcile_status IS NULL OR last_reconcile_status IN ('ok', 'incomplete', 'failed', 'paused', 'overdue'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'documents_source_etag_length' AND conrelid = 'public.documents'::regclass
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_source_etag_length
      CHECK (source_etag IS NULL OR length(source_etag) <= 512);
  END IF;
END $$;

-- Reconcile and the admin connection list count the current documents of one connection.
CREATE INDEX IF NOT EXISTS documents_source_connection_current_idx
  ON public.documents (tenant_key, source, source_connection_id)
  WHERE is_current;

COMMIT;
