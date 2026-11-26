-- 0808: ingestion fingerprint impact and backfill (Phase 3.2, D-10, D-11, LANG-04).
-- rag_fingerprint_groups counts current, ready documents per (doc type, stored fingerprint, stored parts); documents without a
-- fingerprint come back as rows with a NULL fingerprint. Aggregates only: no document id, tenant key or text leaves the function.
-- rag_fingerprint_backfill_page lists the stored parts of the next current documents that have no fingerprint, in id order, and
-- rag_fingerprint_backfill_write stamps one of them only while it still has none, so a finished document is never rewritten.
-- The tenant comes only from p_tenant_key, checked by rag_assert_tenant_key; NULL means every tenant (deployment admin and CLI).
-- SECURITY INVOKER with an empty search_path and schema-qualified names; service_role only. No new store, so no purge hook.
-- Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_fingerprint_groups(p_tenant_key text DEFAULT NULL)
RETURNS TABLE (
  doc_type text,
  ingest_fingerprint text,
  parts jsonb,
  documents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;

  RETURN QUERY
  SELECT d.doc_type,
         d.ingest_fingerprint,
         CASE WHEN d.ingest_fingerprint IS NULL THEN NULL ELSE d.metadata -> 'ingest_fingerprint_parts' END AS parts,
         pg_catalog.count(*)::bigint AS documents
    FROM public.documents d
   WHERE d.is_current
     AND d.status = 'ready'
     AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
   GROUP BY 1, 2, 3
   ORDER BY 1, 2 NULLS FIRST;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_fingerprint_groups(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fingerprint_groups(text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_fingerprint_backfill_page(
  p_tenant_key text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_after uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  doc_type text,
  parser_used text,
  parser_version text,
  processing_profile_id text,
  processing_profile_version integer,
  chunking_profile_ids text[],
  lexical_version integer,
  embedding_text_version integer,
  embedding_profile_ids text[],
  has_legacy_vectors boolean,
  ocr_languages jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must be between 1 and 1000';
  END IF;

  RETURN QUERY
  SELECT d.id,
         d.tenant_key,
         d.doc_type,
         d.parser_used,
         d.parser_version,
         d.processing_profile_id,
         d.processing_profile_version,
         COALESCE((SELECT pg_catalog.array_agg(DISTINCT c.chunking_profile_id ORDER BY c.chunking_profile_id)
                     FROM public.document_chunks c WHERE c.document_id = d.id), ARRAY[]::text[]),
         (SELECT pg_catalog.min(COALESCE(c.lexical_version, 0))::integer FROM public.document_chunks c WHERE c.document_id = d.id),
         (SELECT pg_catalog.min(c.embedding_text_version)::integer FROM public.document_chunks c WHERE c.document_id = d.id),
         COALESCE((SELECT pg_catalog.array_agg(DISTINCT e.profile_id ORDER BY e.profile_id)
                     FROM public.chunk_embeddings e
                     JOIN public.document_chunks c ON c.id = e.chunk_id
                    WHERE c.document_id = d.id), ARRAY[]::text[]),
         EXISTS (SELECT 1 FROM public.document_chunks c WHERE c.document_id = d.id AND c.embedding IS NOT NULL),
         (SELECT j.settings -> 'ocr_languages'
            FROM public.ingestion_jobs j
           WHERE j.document_id = d.id AND j.tenant_key = d.tenant_key AND pg_catalog.jsonb_typeof(j.settings -> 'ocr_languages') = 'array'
           ORDER BY j.created_at DESC
           LIMIT 1)
    FROM public.documents d
   WHERE d.is_current
     AND d.status IN ('ready', 'quarantined')
     AND d.ingest_fingerprint IS NULL
     AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
     AND (p_after IS NULL OR d.id > p_after)
   ORDER BY d.id
   LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_fingerprint_backfill_page(text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fingerprint_backfill_page(text, integer, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_fingerprint_backfill_write(
  p_tenant_key text,
  p_document_id uuid,
  p_fingerprint text,
  p_parts jsonb
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  updated integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_field: ingest_fingerprint';
  END IF;
  IF p_parts IS NULL OR pg_catalog.jsonb_typeof(p_parts) <> 'object' THEN
    RAISE EXCEPTION 'invalid_field: ingest_fingerprint_parts';
  END IF;

  UPDATE public.documents d
     SET ingest_fingerprint = p_fingerprint,
         metadata = COALESCE(d.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('ingest_fingerprint_parts', p_parts)
   WHERE d.id = p_document_id
     AND d.tenant_key = p_tenant_key
     AND d.ingest_fingerprint IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_fingerprint_backfill_write(text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fingerprint_backfill_write(text, uuid, text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
