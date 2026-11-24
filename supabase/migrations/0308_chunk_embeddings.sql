-- 0308: side-by-side halfvec storage for the non-legacy embedding profiles (Phase 3, D-35, D-39).
-- chunk_embeddings holds one row per (chunk, profile). The embedding column has no fixed dimension: a partial expression HNSW index per
-- seeded profile pins the length, and rag_chunk_embeddings_guard enforces the registry length for every profile, so a vector of the
-- wrong length is rejected whether or not the profile has an index yet. The guard also copies tenant_key from the chunk, so a writer
-- cannot place a vector in another tenant's search space. embedding_backfill_runs and embedding_backfill_gaps record the re-embed job.
-- Server role only: RLS on without policies, nothing granted to anon or authenticated.

BEGIN;

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES document_chunks (id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES embedding_profiles (id),
  tenant_key text NOT NULL,
  embedding halfvec NOT NULL,
  embedding_model text NOT NULL,
  dims integer NOT NULL,
  embedding_host text,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, profile_id)
);

CREATE INDEX IF NOT EXISTS chunk_embeddings_profile_tenant_idx ON chunk_embeddings (profile_id, tenant_key);

CREATE INDEX IF NOT EXISTS chunk_embeddings_voyage_4_large_2048_hnsw ON chunk_embeddings
  USING hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-4-large-2048';
CREATE INDEX IF NOT EXISTS chunk_embeddings_voyage_4_large_1024_hnsw ON chunk_embeddings
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-4-large-1024';
CREATE INDEX IF NOT EXISTS chunk_embeddings_qwen3_8b_2048_hnsw ON chunk_embeddings
  USING hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'qwen3-8b-2048';
CREATE INDEX IF NOT EXISTS chunk_embeddings_qwen3_8b_1024_hnsw ON chunk_embeddings
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'qwen3-8b-1024';

CREATE OR REPLACE FUNCTION rag_chunk_embeddings_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_dims integer;
  v_tenant text;
BEGIN
  SELECT p.dims INTO v_dims FROM embedding_profiles p WHERE p.id = NEW.profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF vector_dims(NEW.embedding) <> v_dims THEN
    RAISE EXCEPTION 'expected % dimensions, not %', v_dims, vector_dims(NEW.embedding) USING ERRCODE = '22000';
  END IF;

  SELECT c.tenant_key INTO v_tenant FROM document_chunks c WHERE c.id = NEW.chunk_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'chunk_embeddings: chunk % has no tenant_key', NEW.chunk_id USING ERRCODE = '23502';
  END IF;
  NEW.tenant_key := v_tenant;
  NEW.dims := vector_dims(NEW.embedding);
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION rag_chunk_embeddings_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rag_chunk_embeddings_guard ON chunk_embeddings;
CREATE TRIGGER rag_chunk_embeddings_guard
  BEFORE INSERT OR UPDATE OF chunk_id, profile_id, embedding, tenant_key, dims ON chunk_embeddings
  FOR EACH ROW EXECUTE FUNCTION rag_chunk_embeddings_guard();

CREATE TABLE IF NOT EXISTS embedding_backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL REFERENCES embedding_profiles (id),
  tenant_key text,
  cursor_chunk_id uuid,
  chunks_total bigint NOT NULL DEFAULT 0,
  chunks_done bigint NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running'
    CONSTRAINT embedding_backfill_runs_status_check CHECK (status IN ('running', 'completed', 'failed', 'rolled_back')),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  derived_from text REFERENCES embedding_profiles (id)
);

CREATE INDEX IF NOT EXISTS embedding_backfill_runs_profile_idx ON embedding_backfill_runs (profile_id, started_at DESC);

CREATE TABLE IF NOT EXISTS embedding_backfill_gaps (
  run_id uuid NOT NULL REFERENCES embedding_backfill_runs (id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES document_chunks (id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES embedding_profiles (id),
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, chunk_id, profile_id)
);

CREATE INDEX IF NOT EXISTS embedding_backfill_gaps_chunk_idx ON embedding_backfill_gaps (chunk_id);

ALTER TABLE chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_backfill_gaps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE chunk_embeddings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE embedding_backfill_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE embedding_backfill_gaps FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE chunk_embeddings TO service_role;
GRANT ALL ON TABLE embedding_backfill_runs TO service_role;
GRANT ALL ON TABLE embedding_backfill_gaps TO service_role;

COMMIT;
