-- 0982: scope-gate storage (Phase 6.2, QRY-14, D-25, D-34, D-02).
-- rag_scope_centroids holds one mean embedding per (tenant, embedding profile, group kind, group key). The kinds are doc_type, scope_tag and
-- tenant; each group key is language-specific (D-34): <doc_type>/<language>, <dimension>:<value>/<language>, tenant/<language>. Rows are
-- derived only from the tenant's own current, ready chunks (no topic list anywhere) and are written by rag_scope_centroids_rebuild (0983).
-- rag_scope_negative_examples holds the tenant's out-of-scope example texts with their embedding in one profile, at most 100 per tenant and
-- profile and 500 characters each (enforced in 0983 and by the CHECK below). The centroid and embedding columns are untyped halfvec plus
-- dims, as in chunk_embeddings (0308), so profiles of different dimensions share a table. RLS is on with no policies; only service_role
-- reaches the tables, through the 0983 functions. pgvector stays in schema public (0425). Additive, idempotent; not folded into the setup
-- files.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_scope_centroids (
  tenant_key text NOT NULL,
  embedding_profile_id text NOT NULL,
  group_kind text NOT NULL,
  group_key text NOT NULL,
  centroid public.halfvec NOT NULL,
  dims integer NOT NULL,
  member_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (tenant_key, embedding_profile_id, group_kind, group_key)
);

ALTER TABLE public.rag_scope_centroids DROP CONSTRAINT IF EXISTS rag_scope_centroids_group_kind_check;
ALTER TABLE public.rag_scope_centroids ADD CONSTRAINT rag_scope_centroids_group_kind_check
  CHECK (group_kind IN ('doc_type', 'scope_tag', 'tenant'));
ALTER TABLE public.rag_scope_centroids DROP CONSTRAINT IF EXISTS rag_scope_centroids_group_key_check;
ALTER TABLE public.rag_scope_centroids ADD CONSTRAINT rag_scope_centroids_group_key_check
  CHECK (pg_catalog.length(group_key) BETWEEN 3 AND 200 AND pg_catalog.strpos(group_key, '/') > 1);
ALTER TABLE public.rag_scope_centroids DROP CONSTRAINT IF EXISTS rag_scope_centroids_counts_check;
ALTER TABLE public.rag_scope_centroids ADD CONSTRAINT rag_scope_centroids_counts_check CHECK (dims > 0 AND member_count > 0);

CREATE TABLE IF NOT EXISTS public.rag_scope_negative_examples (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  text text NOT NULL,
  text_key text NOT NULL,
  embedding_profile_id text NOT NULL,
  embedding public.halfvec NOT NULL,
  dims integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.rag_scope_negative_examples DROP CONSTRAINT IF EXISTS rag_scope_negative_examples_text_check;
ALTER TABLE public.rag_scope_negative_examples ADD CONSTRAINT rag_scope_negative_examples_text_check
  CHECK (pg_catalog.char_length(text) BETWEEN 1 AND 500 AND pg_catalog.char_length(text_key) BETWEEN 1 AND 500);
ALTER TABLE public.rag_scope_negative_examples DROP CONSTRAINT IF EXISTS rag_scope_negative_examples_dims_check;
ALTER TABLE public.rag_scope_negative_examples ADD CONSTRAINT rag_scope_negative_examples_dims_check CHECK (dims > 0);

CREATE UNIQUE INDEX IF NOT EXISTS rag_scope_negative_examples_unique_text
  ON public.rag_scope_negative_examples (tenant_key, embedding_profile_id, text_key);

ALTER TABLE public.rag_scope_centroids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_scope_negative_examples ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_scope_centroids FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_scope_negative_examples FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.rag_scope_centroids TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.rag_scope_negative_examples TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
