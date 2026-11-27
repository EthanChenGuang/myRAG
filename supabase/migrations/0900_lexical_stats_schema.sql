-- 0900: Phase 4.4 per-tenant lexical corpus statistics store (LEX-02, LEX-06, D-10, D-31).
-- rag_lexical_stats_state: one row per tenant that keeps statistics (status building | ready); no row means the tenant keeps none.
-- rag_lexical_stats_pending: signed deltas staged by the document_chunks triggers of 0901 (+1 or -1 per member chunk, its distinct
-- lexemes and its length); compaction (0902) folds them into the counters, nothing on the write path touches a counter.
-- rag_lexical_df: document frequency per (tenant, corpus, lexeme, chunking profile, language).
-- rag_lexical_corpus: chunk count and total lexical length per (tenant, corpus, chunking profile, language).
-- corpus is 'chunks' in this phase; 'translations' is reserved (D-21). A null chunk language is stored as 'und'.
-- rag_lexical_dl(tsvector): a vector's length, the sum of its stored positions (term frequency of a lexeme = its positions).
-- RLS on with no policy, every client role revoked, service_role only. Idempotent; not folded into the setup files.

BEGIN;

DO $lexical_stats_schema_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_tsvector(text)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.document_chunks') AND a.attname = 'lexical_tsv' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0900: apply migrations 0401 and 0403 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_stats_schema_precheck$;

CREATE TABLE IF NOT EXISTS public.rag_lexical_stats_state (
  tenant_key text PRIMARY KEY,
  status text NOT NULL DEFAULT 'building',
  enabled_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  rebuilt_at timestamptz,
  compacted_at timestamptz,
  CONSTRAINT rag_lexical_stats_state_status_check CHECK (status IN ('building', 'ready'))
);

CREATE TABLE IF NOT EXISTS public.rag_lexical_stats_pending (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_key text NOT NULL,
  corpus text NOT NULL DEFAULT 'chunks',
  chunking_profile_id text NOT NULL,
  language text NOT NULL,
  sign smallint NOT NULL,
  lexemes text[] NOT NULL,
  dl integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_lexical_stats_pending_corpus_check CHECK (corpus IN ('chunks', 'translations')),
  CONSTRAINT rag_lexical_stats_pending_sign_check CHECK (sign IN (-1, 1))
);

CREATE INDEX IF NOT EXISTS rag_lexical_stats_pending_tenant_id_idx ON public.rag_lexical_stats_pending (tenant_key, id);

CREATE TABLE IF NOT EXISTS public.rag_lexical_df (
  tenant_key text NOT NULL,
  corpus text NOT NULL DEFAULT 'chunks',
  lexeme text NOT NULL,
  chunking_profile_id text NOT NULL,
  language text NOT NULL,
  df bigint NOT NULL,
  CONSTRAINT rag_lexical_df_pkey PRIMARY KEY (tenant_key, corpus, lexeme, chunking_profile_id, language),
  CONSTRAINT rag_lexical_df_corpus_check CHECK (corpus IN ('chunks', 'translations'))
);

CREATE TABLE IF NOT EXISTS public.rag_lexical_corpus (
  tenant_key text NOT NULL,
  corpus text NOT NULL DEFAULT 'chunks',
  chunking_profile_id text NOT NULL,
  language text NOT NULL,
  chunk_count bigint NOT NULL,
  total_len bigint NOT NULL,
  CONSTRAINT rag_lexical_corpus_pkey PRIMARY KEY (tenant_key, corpus, chunking_profile_id, language),
  CONSTRAINT rag_lexical_corpus_corpus_check CHECK (corpus IN ('chunks', 'translations'))
);

ALTER TABLE public.rag_lexical_stats_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_lexical_stats_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_lexical_df ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_lexical_corpus ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_lexical_stats_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_lexical_stats_pending FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_lexical_df FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_lexical_corpus FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.rag_lexical_stats_pending_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.rag_lexical_stats_state TO service_role;
GRANT ALL ON TABLE public.rag_lexical_stats_pending TO service_role;
GRANT ALL ON TABLE public.rag_lexical_df TO service_role;
GRANT ALL ON TABLE public.rag_lexical_corpus TO service_role;
GRANT ALL ON SEQUENCE public.rag_lexical_stats_pending_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.rag_lexical_dl(p_tsv tsvector)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
  SELECT COALESCE(pg_catalog.sum(pg_catalog.cardinality(u.positions)), 0)::integer
  FROM pg_catalog.unnest(p_tsv) AS u(lexeme, positions, weights)
$fn$;

REVOKE ALL ON FUNCTION public.rag_lexical_dl(tsvector) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_lexical_dl(tsvector) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
