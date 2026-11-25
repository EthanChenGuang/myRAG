-- 0440: scoped embedding profiles and per-doc-type bindings (Phase 3.1.1, D-03, D-05, D-06, D-28).
-- embedding_profiles gains doc_types (NULL = unscoped, the Phase 3 meaning). A scoped profile holds vectors only for chunks whose
-- COALESCE(chunk.doc_type, document.doc_type) is in its scope, and it can never be 'backfilling' or 'active': the global pointer and the
-- Phase 3 dual-write stay on unscoped profiles, and the Phase 3 gate function is not edited. Its vectors are reached only through a row of
-- embedding_profile_bindings (one active and one backfilling row per doc type and tenant key, NULL = deployment-wide), which 0441 manages.
-- Three scoped candidates are seeded 'available', each with its own partial HNSW index; nothing is bound or activated here. A further
-- candidate is a further migration (profile row plus partial index, D-04). Everything here is for the server role only: RLS is on without
-- policies, nothing is granted to anon or authenticated, and every function uses SET search_path = '' with schema-qualified names.
--
-- Replaces public.rag_chunk_embeddings_guard(). The body starts from 0425_search_path_empty.sql (the newest definition; 0308 and 0410 are
-- older) and differs from it only by the doc type scope check: dims, the unknown-profile refusal and tenant_key copying are unchanged, as
-- are the signature, SECURITY DEFINER, the empty search_path and the grants (CREATE OR REPLACE keeps the ACL; no GRANT is issued for it).
-- Live upgrade: run this read-only dry run first. One row with live = expected means the live body is the 0425 one; any other result means
-- it was changed by hand or 0425 was not applied: compare pg_get_functiondef with the repository before applying.
--   SELECT 'f7aa72d3c0bcc173f7dd103cced69c03' AS expected, pg_catalog.md5(p.prosrc) AS live
--     FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.rag_chunk_embeddings_guard()');
-- Idempotent: ADD COLUMN IF NOT EXISTS, constraints added only when absent, ON CONFLICT DO NOTHING, IF NOT EXISTS, CREATE OR REPLACE.

BEGIN;

DO $bindings_precheck$
DECLARE
  v_vector_schema text;
BEGIN
  SELECT n.nspname INTO v_vector_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';
  IF v_vector_schema IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION '0440: pgvector must be in schema public, found %', COALESCE(v_vector_schema, 'no vector extension') USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_chunk_embeddings_guard()') IS NULL OR pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL THEN
    RAISE EXCEPTION '0440: apply the earlier migrations first (0308, 0403, 0425)' USING ERRCODE = '55000';
  END IF;
END
$bindings_precheck$;

-- Scope column.

ALTER TABLE public.embedding_profiles ADD COLUMN IF NOT EXISTS doc_types text[];

DO $doc_types_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = pg_catalog.to_regclass('public.embedding_profiles') AND conname = 'embedding_profiles_doc_types_check'
  ) THEN
    ALTER TABLE public.embedding_profiles ADD CONSTRAINT embedding_profiles_doc_types_check
      CHECK (doc_types IS NULL OR (cardinality(doc_types) > 0 AND doc_types <@ ARRAY['financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general']::text[]));
  END IF;
END
$doc_types_check$;

-- Scope trigger: a scoped profile is never backfilling or active, and its scope is fixed once it has vectors.

CREATE OR REPLACE FUNCTION public.rag_embedding_profiles_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.doc_types IS DISTINCT FROM OLD.doc_types THEN
    IF EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.profile_id = OLD.id) THEN
      RAISE EXCEPTION 'profile_status_refused: scope_locked' USING ERRCODE = '22000';
    END IF;
  END IF;

  IF NEW.doc_types IS NOT NULL THEN
    IF NEW.status = 'active' THEN
      RAISE EXCEPTION 'activation_refused: scoped_profile' USING ERRCODE = '22023';
    END IF;
    IF NEW.status = 'backfilling' THEN
      RAISE EXCEPTION 'profile_status_refused: scoped_profile' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.rag_embedding_profiles_scope_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_embedding_profiles_scope_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_embedding_profiles_scope_guard ON public.embedding_profiles;
CREATE TRIGGER rag_embedding_profiles_scope_guard
  BEFORE INSERT OR UPDATE OF status, doc_types ON public.embedding_profiles
  FOR EACH ROW EXECUTE FUNCTION public.rag_embedding_profiles_scope_guard();

-- Seeded scoped candidates (D-03). Vendor model ids and Phase 3 doc type ids only.

INSERT INTO public.embedding_profiles (id, provider, model, dims, storage, status, query_instruction, score_calibration, doc_types)
VALUES
  ('voyage-law-2-1024', 'voyage', 'voyage-law-2', 1024, 'halfvec', 'available', NULL, '{}'::jsonb, ARRAY['contract_legal']::text[]),
  ('voyage-finance-2-1024', 'voyage', 'voyage-finance-2', 1024, 'halfvec', 'available', NULL, '{}'::jsonb, ARRAY['financial_report', 'invoice_receipt']::text[]),
  (
    'voyage-4-large-1024-domain', 'voyage', 'voyage-4-large', 1024, 'halfvec', 'available', NULL, '{}'::jsonb,
    ARRAY['contract_legal', 'financial_report', 'invoice_receipt']::text[]
  )
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS chunk_embeddings_voyage_law_2_1024_hnsw ON public.chunk_embeddings
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-law-2-1024';
CREATE INDEX IF NOT EXISTS chunk_embeddings_voyage_finance_2_1024_hnsw ON public.chunk_embeddings
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-finance-2-1024';
CREATE INDEX IF NOT EXISTS chunk_embeddings_voyage_4_large_1024_domain_hnsw ON public.chunk_embeddings
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-4-large-1024-domain';

-- chunk_embeddings guard: the 0425 body plus the doc type scope check.

CREATE OR REPLACE FUNCTION public.rag_chunk_embeddings_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_dims integer;
  v_tenant text;
  v_scope text[];
  v_doc_type text;
BEGIN
  SELECT p.dims, p.doc_types INTO v_dims, v_scope FROM public.embedding_profiles p WHERE p.id = NEW.profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF public.vector_dims(NEW.embedding) <> v_dims THEN
    RAISE EXCEPTION 'expected % dimensions, not %', v_dims, public.vector_dims(NEW.embedding) USING ERRCODE = '22000';
  END IF;

  SELECT c.tenant_key INTO v_tenant FROM public.document_chunks c WHERE c.id = NEW.chunk_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'chunk_embeddings: chunk % has no tenant_key', NEW.chunk_id USING ERRCODE = '23502';
  END IF;

  IF v_scope IS NOT NULL THEN
    SELECT COALESCE(c.doc_type, d.doc_type) INTO v_doc_type
    FROM public.document_chunks c LEFT JOIN public.documents d ON d.id = c.document_id
    WHERE c.id = NEW.chunk_id;
    IF v_doc_type IS NULL OR NOT (v_doc_type = ANY (v_scope)) THEN
      RAISE EXCEPTION 'embedding_profile_mismatch: doc_type_scope' USING ERRCODE = '22023';
    END IF;
  END IF;

  NEW.tenant_key := v_tenant;
  NEW.dims := public.vector_dims(NEW.embedding);
  RETURN NEW;
END
$function$;

COMMIT;
