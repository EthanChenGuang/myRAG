-- 0704: Phase 7 re-validation, isolation layer 2 (D-10, A-5, A-12).
-- rag_servable_chunks is the one definition of a servable chunk: chunk and document current, document ready, chunk ready or variant,
-- chunk and document in the same tenant, and the chunk passes the active chunking profile of its doc type with the legacy-row
-- fallback of hybrid_search_chunks (0802): the active pointer only, never an eval override. The sync reads (0705) and
-- rag_validate_chunks both select from it, so pgvector and the external stores cannot drift on what may be served.
-- rag_validate_chunks returns the hit columns of hybrid_search_chunks (without scores) for exactly the ids that are servable, in the
-- caller's tenant and hold a vector in the profile: document_chunks.embedding for a legacy_column profile, a chunk_embeddings row
-- for a halfvec profile. The tenant comes only from p_tenant_key, checked by rag_assert_tenant_key; there is no parameter or
-- setting that skips any predicate. SECURITY INVOKER, service role only (the view too).
-- Idempotent: safe to run more than once.

BEGIN;

CREATE OR REPLACE VIEW public.rag_servable_chunks WITH (security_invoker = true) AS
SELECT c.id AS chunk_id, c.document_id, c.tenant_key
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = c.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
      'legacy'
    ) AS profile_id
  ) ep
 WHERE c.tenant_key IS NOT NULL
   AND d.tenant_key = c.tenant_key
   AND c.is_current
   AND c.status IN ('ready', 'variant')
   AND d.is_current
   AND d.status = 'ready'
   AND c.doc_type IN ('financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general')
   AND (
     c.chunking_profile_id = ep.profile_id
     OR (ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy' AND c.chunk_kind IN ('image', 'invoice_header'))
     OR (ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy'
         AND NOT EXISTS (
           SELECT 1 FROM public.document_chunks c2
            WHERE c2.document_id = c.document_id
              AND c2.tenant_key = c.tenant_key
              AND c2.is_current
              AND c2.chunking_profile_id = ep.profile_id
         ))
   );

REVOKE ALL ON TABLE public.rag_servable_chunks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.rag_servable_chunks TO service_role;

DROP FUNCTION IF EXISTS public.rag_validate_chunks(text, uuid[], text);

CREATE FUNCTION public.rag_validate_chunks(p_tenant_key text, p_ids uuid[], p_profile_id text)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_storage text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF COALESCE(pg_catalog.cardinality(p_ids), 0) > 500 THEN
    RAISE EXCEPTION 'rag_validate_chunks: too many ids' USING ERRCODE = '22023';
  END IF;

  SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(pg_catalog.cardinality(p_ids), 0) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.document_id, c.content, c.metadata, c.chunk_index, c.doc_type, c.language, c.parent_id, c.section_path, c.chunk_kind,
         d.filename, d.created_at, d.metadata, pg_catalog.left(d.content, 200)
    FROM public.rag_servable_chunks s
    JOIN public.document_chunks c ON c.id = s.chunk_id
    JOIN public.documents d ON d.id = c.document_id
   WHERE s.chunk_id = ANY(p_ids)
     AND s.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key
     AND d.tenant_key = p_tenant_key
     AND CASE
           WHEN v_storage = 'legacy_column' THEN c.embedding IS NOT NULL
           ELSE EXISTS (
             SELECT 1 FROM public.chunk_embeddings e
              WHERE e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
           )
         END
   ORDER BY c.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_validate_chunks(text, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_validate_chunks(text, uuid[], text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
