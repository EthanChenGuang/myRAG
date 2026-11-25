-- 0351: Phase 3.1 ingestion ledger, batches, parse cache, budget counters, tier overrides and embed batch tracking.
-- Additive and idempotent. Server role only on new tables (RLS enabled, no policies).
-- Document and chunk columns for needs_review and progressive publishing.

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rag_parse_tier_rank(p_tier text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_tier
    WHEN 'native' THEN 0
    WHEN 'fast' THEN 1
    WHEN 'structured' THEN 2
    WHEN 'premium' THEN 3
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION rag_ingest_assert_tenant_key(p_tenant_key text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  multi_tenant boolean;
BEGIN
  IF p_tenant_key IS NULL OR btrim(p_tenant_key) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key ~ '[A-Z]' OR position('=' IN p_tenant_key) > 0 OR position('''' IN p_tenant_key) > 0 THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    IF p_tenant_key !~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
    END IF;
  ELSIF p_tenant_key <> 's:default' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION rag_release_job_reservations(p_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  released integer := 0;
  rec record;
BEGIN
  FOR rec IN
    SELECT r.id, r.tenant_key, r.month, r.pages, r.kind
    FROM rag_parse_budget_reservations r
    WHERE r.job_id = p_job_id AND r.state = 'open'
    FOR UPDATE
  LOOP
    UPDATE rag_parse_budget_reservations SET state = 'released' WHERE id = rec.id;
  -- Per kind, decrement pages_reserved on the usage row (parse and vlm share the same counter).
    UPDATE rag_parse_budget_usage u
       SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages)
     WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;
    released := released + 1;
  END LOOP;
  RETURN released;
END;
$$;

REVOKE ALL ON FUNCTION rag_parse_tier_rank(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_ingest_assert_tenant_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_release_job_reservations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_parse_tier_rank(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_ingest_assert_tenant_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_release_job_reservations(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingestion_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_ref text NOT NULL,
  budget_usd numeric(12, 6),
  spent_usd numeric(12, 6) NOT NULL DEFAULT 0,
  concurrency integer NOT NULL DEFAULT 1,
  runner text NOT NULL DEFAULT 'worker',
  status text NOT NULL DEFAULT 'pending',
  dry_run_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_batches_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT ingestion_batches_source_kind_check CHECK (source_kind IN ('folder', 'bucket', 'manifest')),
  CONSTRAINT ingestion_batches_runner_check CHECK (runner IN ('worker', 'ray')),
  CONSTRAINT ingestion_batches_status_check CHECK (
    status IN ('pending', 'sampling', 'running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT ingestion_batches_concurrency_check CHECK (concurrency > 0)
);

CREATE TABLE IF NOT EXISTS rag_parse_budget_usage (
  tenant_key text NOT NULL,
  month date NOT NULL,
  pages_reserved integer NOT NULL DEFAULT 0,
  pages_used integer NOT NULL DEFAULT 0,
  vlm_pages_used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_key, month),
  CONSTRAINT rag_parse_budget_usage_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_parse_budget_usage_nonnegative CHECK (
    pages_reserved >= 0 AND pages_used >= 0 AND vlm_pages_used >= 0
  )
);

CREATE TABLE IF NOT EXISTS rag_parse_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  file_sha256 text NOT NULL,
  parser text NOT NULL,
  parser_version text NOT NULL,
  options_hash text NOT NULL,
  object_prefix text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  byte_size bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_parse_cache_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_parse_cache_options_hash_check CHECK (options_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_parse_cache_key_ux
  ON rag_parse_cache (tenant_key, file_sha256, parser, parser_version, options_hash);

CREATE INDEX IF NOT EXISTS rag_parse_cache_tenant_file_sha256_idx ON rag_parse_cache (tenant_key, file_sha256);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'ingest',
  status text NOT NULL DEFAULT 'queued',
  stage text,
  tenant_key text NOT NULL,
  document_id uuid REFERENCES documents (id) ON DELETE SET NULL,
  lineage_id uuid,
  version integer,
  batch_id uuid REFERENCES ingestion_batches (id) ON DELETE SET NULL,
  source text,
  source_key text NOT NULL,
  file_sha256 text,
  filename text,
  mime_type text,
  original_ref jsonb,
  priority integer NOT NULL DEFAULT 100,
  retries integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 3,
  run_after timestamptz,
  lease_until timestamptz,
  locked_by text,
  runner text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  stage_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  doc_class text,
  tier text,
  parser_used text,
  parser_version text,
  attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalations integer NOT NULL DEFAULT 0,
  pages integer,
  page_ranges jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier_page_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  detect_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  preflight_ref text,
  est_cost_usd numeric(12, 6),
  embedding_profile text,
  error_class text,
  error text,
  needs_review_reason text,
  routing_note text,
  provisional_published_at timestamptz,
  trace_id uuid,
  timings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT ingestion_jobs_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT ingestion_jobs_kind_check CHECK (kind IN ('ingest', 'dry_run', 'delete')),
  CONSTRAINT ingestion_jobs_status_check CHECK (
    status IN (
      'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
      'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
    )
  ),
  CONSTRAINT ingestion_jobs_runner_check CHECK (runner IS NULL OR runner IN ('worker', 'ray')),
  CONSTRAINT ingestion_jobs_source_check CHECK (
    source IS NULL OR source IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag')
  ),
  CONSTRAINT ingestion_jobs_tier_check CHECK (
    tier IS NULL OR tier IN ('native', 'fast', 'structured', 'premium')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_batch_kind_source_key_ux
  ON ingestion_jobs (batch_id, kind, source_key)
  WHERE batch_id IS NOT NULL;

-- Superseded by 0421_ingestion_queue_indexes.sql; drop on re-apply so the catalog stays idempotent.
DROP INDEX IF EXISTS public.ingestion_jobs_queued_claim_idx;
DROP INDEX IF EXISTS public.ingestion_jobs_active_lease_idx;

CREATE INDEX IF NOT EXISTS ingestion_jobs_document_id_idx ON ingestion_jobs (document_id);

CREATE TABLE IF NOT EXISTS rag_parse_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES ingestion_jobs (id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  tenant_key text NOT NULL,
  month date NOT NULL,
  pages integer NOT NULL,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_parse_budget_reservations_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_parse_budget_reservations_kind_check CHECK (kind IN ('parse', 'vlm')),
  CONSTRAINT rag_parse_budget_reservations_state_check CHECK (state IN ('open', 'settled', 'released')),
  CONSTRAINT rag_parse_budget_reservations_pages_check CHECK (pages > 0),
  UNIQUE (job_id, attempt_no, kind)
);

CREATE TABLE IF NOT EXISTS rag_parse_tier_overrides (
  doc_type text PRIMARY KEY,
  min_tier text NOT NULL,
  max_tier text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_parse_tier_overrides_min_tier_check CHECK (min_tier IN ('native', 'fast', 'structured', 'premium')),
  CONSTRAINT rag_parse_tier_overrides_max_tier_check CHECK (max_tier IN ('native', 'fast', 'structured', 'premium')),
  CONSTRAINT rag_parse_tier_overrides_order_check CHECK (rag_parse_tier_rank(min_tier) <= rag_parse_tier_rank(max_tier))
);

CREATE TABLE IF NOT EXISTS rag_embed_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES ingestion_batches (id) ON DELETE SET NULL,
  profile_id text NOT NULL REFERENCES embedding_profiles (id),
  provider text NOT NULL,
  provider_batch_id text,
  input_file_id text,
  output_file_id text,
  error_file_id text,
  input_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_embed_batches_status_check CHECK (
    status IN (
      'pending', 'validating', 'failed', 'in_progress', 'finalizing', 'completed',
      'expired', 'cancelling', 'cancelled'
    )
  )
);

-- ---------------------------------------------------------------------------
-- documents / document_chunks
-- ---------------------------------------------------------------------------

ALTER TABLE documents ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS needs_review_reason text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS provisional boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parse_cache_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_parse_cache_id_fkey'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_parse_cache_id_fkey
      FOREIGN KEY (parse_cache_id) REFERENCES rag_parse_cache (id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS provisional boolean NOT NULL DEFAULT false;

-- status 'deleted' is already in documents_status_check from 0301; ensure constraint exists for older trees.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_status_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_status_check
      CHECK (status IN ('processing', 'ready', 'quarantined', 'failed', 'deleted'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS and grants (seven new tables)
-- ---------------------------------------------------------------------------

ALTER TABLE ingestion_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_parse_budget_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_parse_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_parse_tier_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_parse_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_embed_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE ingestion_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE ingestion_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_parse_budget_usage FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_parse_budget_reservations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_parse_tier_overrides FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_parse_cache FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_embed_batches FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE ingestion_batches TO service_role;
GRANT ALL ON TABLE ingestion_jobs TO service_role;
GRANT ALL ON TABLE rag_parse_budget_usage TO service_role;
GRANT ALL ON TABLE rag_parse_budget_reservations TO service_role;
GRANT ALL ON TABLE rag_parse_tier_overrides TO service_role;
GRANT ALL ON TABLE rag_parse_cache TO service_role;
GRANT ALL ON TABLE rag_embed_batches TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';