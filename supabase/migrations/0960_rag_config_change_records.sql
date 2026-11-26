-- 0960: rag_config_change_records, one row per gated settings change (Phase 5.3 D-16, EVAL-23).
-- Deployment-wide (env settings belong to the deployment), so no tenant_key (O-3). Holds key names, hashes, result words,
-- a summary of counts and metric names and the capped operator override reason; never a setting value or prompt text.
-- Additive and idempotent. Not folded into the setup files (D-56). Server role only: RLS on, no policy, no client grants.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_config_change_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  source text NOT NULL,
  changed_keys text[] NOT NULL DEFAULT '{}'::text[],
  before_hash text NOT NULL,
  after_hash text NOT NULL,
  retrieval_config_hash text,
  gate_result text NOT NULL,
  gate_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  override_reason text,
  uncalibrated_cells text[] NOT NULL DEFAULT '{}'::text[],
  CONSTRAINT rag_config_change_records_actor_check CHECK (length(actor) BETWEEN 1 AND 100 AND actor ~ '^[A-Za-z0-9:._-]+$'),
  CONSTRAINT rag_config_change_records_source_check CHECK (
    source IN ('config_ui', 'cli', 'release_override', 'local_prerelease', 'profile_activation')
  ),
  CONSTRAINT rag_config_change_records_changed_keys_check CHECK (
    cardinality(changed_keys) <= 200
    AND array_position(changed_keys, NULL) IS NULL
    AND array_to_string(changed_keys, ',') ~ '^([A-Za-z][A-Za-z0-9_.]{0,127}(,[A-Za-z][A-Za-z0-9_.]{0,127})*)?$'
  ),
  CONSTRAINT rag_config_change_records_before_hash_check CHECK (before_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rag_config_change_records_after_hash_check CHECK (after_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rag_config_change_records_retrieval_config_hash_check CHECK (
    retrieval_config_hash IS NULL OR retrieval_config_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT rag_config_change_records_gate_result_check CHECK (
    gate_result IN ('pass', 'fail', 'error', 'skipped', 'not_required')
  ),
  CONSTRAINT rag_config_change_records_gate_summary_check CHECK (
    jsonb_typeof(gate_summary) = 'object' AND pg_column_size(gate_summary) <= 16384
  ),
  CONSTRAINT rag_config_change_records_override_reason_check CHECK (
    override_reason IS NULL OR length(override_reason) <= 500
  ),
  CONSTRAINT rag_config_change_records_uncalibrated_cells_check CHECK (
    cardinality(uncalibrated_cells) <= 500
    AND array_position(uncalibrated_cells, NULL) IS NULL
    AND array_to_string(uncalibrated_cells, ',') ~ '^([A-Za-z0-9_.:/|-]{1,200}(,[A-Za-z0-9_.:/|-]{1,200})*)?$'
  )
);

CREATE INDEX IF NOT EXISTS rag_config_change_records_created_at_idx ON public.rag_config_change_records (created_at DESC);

ALTER TABLE public.rag_config_change_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_config_change_records FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_config_change_records TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
