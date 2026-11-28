-- 0811: BGE-M3 open-source fallback embedding profile (Phase 3.2.1, EMB-11; Phase 3.2 D-25, D-48).
-- Seeds one unscoped profile, bge-m3-1024 (provider bge-m3, model BAAI/bge-m3, 1024 dimensions, halfvec storage, dense output only and
-- no query instruction), with status 'available', and its partial HNSW index on chunk_embeddings (the 0308 form) and on
-- chunk_translation_embeddings (the 0810 form). It activates nothing: activation goes through rag_activate_embedding_profile (0309,
-- the EMB-05 gate), which this file does not touch. No function, trigger, grant or policy changes: the tables keep RLS on without
-- policies and nothing granted to anon or authenticated. One profile may hold rows from either serving mode (embedding_host is free text).
-- Applied after 0801 to 0810; keeps its number in the 0801 to 0839 block and is not folded into the setup files.
-- Idempotent: INSERT ... ON CONFLICT (id) DO NOTHING and CREATE INDEX IF NOT EXISTS.

BEGIN;

INSERT INTO public.embedding_profiles (id, provider, model, dims, storage, status, query_instruction, score_calibration, doc_types)
VALUES ('bge-m3-1024', 'bge-m3', 'BAAI/bge-m3', 1024, 'halfvec', 'available', NULL, '{}'::jsonb, NULL)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS chunk_embeddings_bge_m3_1024_hnsw ON public.chunk_embeddings
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'bge-m3-1024';

CREATE INDEX IF NOT EXISTS chunk_translation_embeddings_bge_m3_1024_hnsw ON public.chunk_translation_embeddings
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'bge-m3-1024';

NOTIFY pgrst, 'reload schema';

COMMIT;
