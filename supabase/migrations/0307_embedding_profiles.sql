-- 0307: embedding profile registry (Phase 3, D-34, D-36, F-7).
-- One row per embedding profile. The legacy profile stays in document_chunks.embedding (vector(1536)); every other profile stores
-- halfvec rows in chunk_embeddings (0308). Exactly one row is 'active', enforced by a partial unique index. Activation and rollback
-- go through rag_activate_embedding_profile and rag_rollback_embedding_profile (0309). score_calibration holds the similarity
-- thresholds tuned for the profile's model; the legacy row carries today's constants so nothing changes while the switch is off.
-- Everything here is for the server role only: RLS is on without policies and nothing is granted to anon or authenticated.

BEGIN;

CREATE TABLE IF NOT EXISTS embedding_profiles (
  id text PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  dims integer NOT NULL CONSTRAINT embedding_profiles_dims_check CHECK (dims > 0 AND dims <= 4000),
  storage text NOT NULL CONSTRAINT embedding_profiles_storage_check CHECK (storage IN ('legacy_column', 'halfvec')),
  status text NOT NULL DEFAULT 'available' CONSTRAINT embedding_profiles_status_check CHECK (status IN ('available', 'backfilling', 'active', 'retired')),
  query_instruction text,
  score_calibration jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_at timestamptz,
  activated_by text,
  previous_active_id text REFERENCES embedding_profiles (id),
  eval_evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embedding_profiles_legacy_dims CHECK (storage <> 'legacy_column' OR dims <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS embedding_profiles_single_active ON embedding_profiles ((status)) WHERE status = 'active';

INSERT INTO embedding_profiles (id, provider, model, dims, storage, status, query_instruction, score_calibration, activated_at, activated_by)
VALUES
  (
    'openai-3-small-1536', 'openai', 'text-embedding-3-small', 1536, 'legacy_column', 'active', NULL,
    '{"retrieval_threshold": 0.7, "context_threshold": 0.65, "fallback_threshold": 0.28, "context_image_threshold": 0.25}'::jsonb,
    now(), 'migration'
  ),
  ('voyage-4-large-2048', 'voyage', 'voyage-4-large', 2048, 'halfvec', 'available', NULL, '{}'::jsonb, NULL, NULL),
  ('voyage-4-large-1024', 'voyage', 'voyage-4-large', 1024, 'halfvec', 'available', NULL, '{}'::jsonb, NULL, NULL),
  (
    'qwen3-8b-2048', 'qwen3', 'Qwen/Qwen3-Embedding-8B', 2048, 'halfvec', 'available',
    'Given a web search query, retrieve relevant passages that answer the query', '{}'::jsonb, NULL, NULL
  ),
  (
    'qwen3-8b-1024', 'qwen3', 'Qwen/Qwen3-Embedding-8B', 1024, 'halfvec', 'available',
    'Given a web search query, retrieve relevant passages that answer the query', '{}'::jsonb, NULL, NULL
  )
ON CONFLICT (id) DO NOTHING;

ALTER TABLE embedding_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE embedding_profiles FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE embedding_profiles TO service_role;

CREATE OR REPLACE FUNCTION rag_list_embedding_profiles()
RETURNS TABLE (
  id text,
  provider text,
  model text,
  dims integer,
  storage text,
  status text,
  query_instruction text,
  score_calibration jsonb,
  activated_at timestamptz,
  activated_by text,
  previous_active_id text,
  has_evidence boolean,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.id, p.provider, p.model, p.dims, p.storage, p.status, p.query_instruction, p.score_calibration,
         p.activated_at, p.activated_by, p.previous_active_id, p.eval_evidence IS NOT NULL, p.created_at
  FROM embedding_profiles p
  ORDER BY p.id
$$;

CREATE OR REPLACE FUNCTION rag_set_embedding_profile_status(p_profile_id text, p_status text, p_actor text)
RETURNS TABLE (profile_id text, profile_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'profile_status_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'active' THEN
    RAISE EXCEPTION 'profile_status_refused: use_activation_gate' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('available', 'backfilling', 'retired') THEN
    RAISE EXCEPTION 'profile_status_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT p.status INTO v_current FROM embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_status_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_current = 'active' THEN
    RAISE EXCEPTION 'profile_status_refused: profile_is_active' USING ERRCODE = '22000';
  END IF;

  UPDATE embedding_profiles SET status = p_status WHERE id = p_profile_id;
  RETURN QUERY SELECT p_profile_id, p_status;
END
$$;

REVOKE ALL ON FUNCTION rag_list_embedding_profiles() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_set_embedding_profile_status(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_list_embedding_profiles() TO service_role;
GRANT EXECUTE ON FUNCTION rag_set_embedding_profile_status(text, text, text) TO service_role;

COMMIT;
